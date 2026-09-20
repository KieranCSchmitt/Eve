import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { relocateProfileFiles, type RecoveryProjectBinding } from '../../apps/desktop/host/profile-files-relocation';
import type { RelocationContext } from '../../packages/backup/src/index';
import type { AssetRegistration } from '@eve/contracts';
import { DEFAULT_ORBIT_CONFIG } from '../../adapters/orbit/src/index';

const temporary: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-relocation-files-'))); temporary.push(root);
  const stagingProfile = path.join(root, 'stage'), originalProfileRoot = path.join(root, 'old'), destinationProfile = path.join(root, 'new');
  await mkdir(stagingProfile, { mode: 0o700 });
  const context: RelocationContext = { stagingProfile, originalProfileRoot, destinationProfile, manifest: {
    format: 'eve-profile-backup', formatVersion: 1, id: '94d41eb3-93b4-4d9b-b86c-cac6a06cab0a', createdAt: new Date().toISOString(),
    versions: { app: '0.1.0', schema: 3 }, originalProfileRoot, database: 'eve.db', requiresRelocation: true, credentialsIncluded: false,
    entries: [{ path: 'storage/assets', kind: 'managed-originals' }, { path: 'storage/projects', kind: 'project' }, { path: 'workbench/recovery', kind: 'recovery' }], files: [], directories: [], exclusions: [],
  } };
  async function put(name: string, value: unknown) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    await mkdir(path.dirname(path.join(stagingProfile, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(stagingProfile, name), text, { mode: 0o600 });
    const files = context.manifest.files.filter(file => file.path !== name);
    files.push({ path: name, bytes: Buffer.byteLength(text), sha256: hash(text) });
    context.manifest = { ...context.manifest, files };
    return text;
  }
  const asset: AssetRegistration = {
    id: 'asset-one', taskId: 'photo-walk', title: 'Field notes', mediaType: 'text/plain',
    originalPath: '/external/field-notes.txt', managedPath: path.join(originalProfileRoot, 'storage/assets/asset-one/original.txt'),
    sha256: hash('Field notes'), byteLength: 11,
    provenance: { kind: 'user-import', attribution: 'User original', rights: 'Private' },
  };
  await put('storage/assets/asset-one/original.txt', 'Field notes');
  await put('storage/assets/asset-one/manifest.json', { version: 1, kind: 'asset', registration: asset });
  const text = `Authored text containing ${originalProfileRoot} must stay exact.`;
  const document = { uri: pathToFileURL(path.join(originalProfileRoot, 'workspaces/orbit/src/app.mjs')).href, text, bytes: Buffer.byteLength(text), hash: hash(text), version: 9, languageId: 'javascript', dirty: true, untitled: false, diskHash: hash('old disk text') };
  const journal = { version: 1, capturedAt: 1234, projectRoot: path.join(originalProfileRoot, 'workspaces/orbit'), documents: [document] };
  const originalJournal = await put('workbench/recovery/orphan-abcd.json', journal);
  await put('workbench/recovery/acknowledged.json', { version: 1, projectRoot: journal.projectRoot, files: [{ name: 'orphan-abcd.json', sha256: hash(originalJournal) }, { name: 'pending-123-abcd.json', sha256: hash('an older no-longer-present journal') }] });
  return { root, context, put, asset, document, journal };
}

describe('application metadata relocation', () => {
  it.each(['workbench/user-data', 'workbench/extensions', 'Partitions', 'settings.json'])('rejects active runtime/settings collection %s relabeled as project data', async collection => {
    const { context, put } = await fixture();
    context.manifest = { ...context.manifest, entries: [...context.manifest.entries, { path: collection, kind: 'project' }] };
    await put(`${collection}/state.json`, { path: `${context.originalProfileRoot}/previous-profile`, automaticAction: 'untrusted' });
    const originalManifest = await readFile(path.join(context.stagingProfile, 'storage/assets/asset-one/manifest.json'), 'utf8');
    await expect(relocateProfileFiles(context)).rejects.toThrow('unrecognized project collection');
    expect(await readFile(path.join(context.stagingProfile, 'storage/assets/asset-one/manifest.json'), 'utf8')).toBe(originalManifest);
  });
  it('maps owned paths and matching recovery receipts while preserving authored text, external provenance and unknown drafts', async () => {
    const { context, asset, document } = await fixture();
    await writeFile(path.join(context.stagingProfile, 'workbench/recovery/unknown.tmp'), 'opaque original');
    const bytes = 'opaque original';
    context.manifest = { ...context.manifest, files: [...context.manifest.files, { path: 'workbench/recovery/unknown.tmp', bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }] };
    const relocatedAsset = { ...asset, managedPath: path.join(context.destinationProfile, 'storage/assets/asset-one/original.txt') };
    const result = await relocateProfileFiles(context, { assets: [relocatedAsset] });
    const read = async (name: string) => JSON.parse(await readFile(path.join(context.stagingProfile, name), 'utf8'));
    expect((await read('storage/assets/asset-one/manifest.json')).registration).toEqual(relocatedAsset);
    const journalText = await readFile(path.join(context.stagingProfile, 'workbench/recovery/orphan-abcd.json'), 'utf8');
    const journal = JSON.parse(journalText);
    expect(journal.documents[0]).toEqual({ ...document, uri: pathToFileURL(path.join(context.destinationProfile, 'workspaces/orbit/src/app.mjs')).href });
    expect(journal.projectRoot).toBe(path.join(context.destinationProfile, 'workspaces/orbit'));
    expect((await read('workbench/recovery/acknowledged.json')).files).toEqual([
      { name: 'orphan-abcd.json', sha256: hash(journalText) }, { name: 'pending-123-abcd.json', sha256: hash('an older no-longer-present journal') },
    ]);
    expect(result.notes.join(' ')).toMatch(/unrecognized recovery/);
    expect(await readFile(path.join(context.stagingProfile, 'workbench/recovery/unknown.tmp'), 'utf8')).toBe('opaque original');
    expect(result.changedFiles).not.toContain('workbench/recovery/unknown.tmp');
    expect((await readdir(path.join(context.stagingProfile, 'workbench/recovery'))).some(name => name.endsWith('.restore'))).toBe(false);
  });
  it('refuses corrupt draft text before rewriting any material metadata', async () => {
    const { context, put, journal } = await fixture();
    await put('workbench/recovery/orphan-abcd.json', { ...journal, documents: [{ ...journal.documents[0], text: 'corruption' }] });
    const file = path.join(context.stagingProfile, 'storage/assets/asset-one/manifest.json');
    const before = await readFile(file, 'utf8');
    await expect(relocateProfileFiles(context)).rejects.toMatchObject({ code: 'RELOCATION_REQUIRED' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('refuses material/core disagreement and recovery URIs with remote file authority', async () => {
    const { context, asset, put, journal } = await fixture();
    await expect(relocateProfileFiles(context, { assets: [{ ...asset, title: 'Different core title', managedPath: path.join(context.destinationProfile, 'storage/assets/asset-one/original.txt') }] })).rejects.toThrow('disagrees');
    await put('workbench/recovery/orphan-abcd.json', { ...journal, documents: [{ ...journal.documents[0], uri: 'file://remote.example/project/file.txt' }] });
    await expect(relocateProfileFiles(context)).rejects.toThrow('unsupported location');
  });
  it('refuses an unregistered manifest identity beside a registered original and missing registry coverage', async () => {
    const { context, asset, put } = await fixture();
    const relocated = { ...asset, managedPath: path.join(context.destinationProfile, 'storage/assets/asset-one/original.txt') };
    await put('storage/assets/asset-one/manifest.json', { version: 1, kind: 'asset', registration: { ...asset, id: 'different-id' } });
    const before = await readFile(path.join(context.stagingProfile, 'storage/assets/asset-one/manifest.json'), 'utf8');
    await expect(relocateProfileFiles(context, { assets: [relocated] })).rejects.toThrow('collection identity');
    expect(await readFile(path.join(context.stagingProfile, 'storage/assets/asset-one/manifest.json'), 'utf8')).toBe(before);
    await put('storage/assets/asset-one/manifest.json', { version: 1, kind: 'asset', registration: asset });
    await expect(relocateProfileFiles(context, { assets: [relocated, { ...relocated, id: 'missing-core-original' }] })).rejects.toThrow('no validated matching');
  });
  it('never lets an unmatched historical hash acknowledge a newly transformed journal', async () => {
    const { context, document, journal, put } = await fixture();
    // A historical receipt may already contain the destination serialization's
    // digest (for example a prior restore). It did not acknowledge this input.
    const futureDocument = { uri: pathToFileURL(path.join(context.destinationProfile, 'workspaces/orbit/src/app.mjs')).href,
      version: document.version, hash: document.hash, languageId: document.languageId, dirty: document.dirty,
      untitled: document.untitled, text: document.text, bytes: document.bytes, diskHash: document.diskHash };
    const futureText = `${JSON.stringify({ version: 1, capturedAt: journal.capturedAt, projectRoot: path.join(context.destinationProfile, 'workspaces/orbit'), documents: [futureDocument] }, null, 2)}\n`;
    const staleHash = hash(futureText);
    await put('workbench/recovery/acknowledged.json', { version: 1, projectRoot: journal.projectRoot, files: [{ name: 'orphan-abcd.json', sha256: staleHash }] });
    const result = await relocateProfileFiles(context);
    expect(hash(await readFile(path.join(context.stagingProfile, 'workbench/recovery/orphan-abcd.json'), 'utf8'))).toBe(staleHash);
    const acknowledgment = JSON.parse(await readFile(path.join(context.stagingProfile, 'workbench/recovery/acknowledged.json'), 'utf8'));
    expect(acknowledgment.files).toEqual([]);
    expect(result.notes.join(' ')).toContain('drafts remain pending');
  });
  it('refuses acknowledgment project mismatch and unregistered recovery projects before changing files', async () => {
    const { context, journal, put } = await fixture();
    await expect(relocateProfileFiles(context, { projectPaths: [path.join(context.destinationProfile, 'different-project')] })).rejects.toThrow('registered restored project');
    const originalJournal = await readFile(path.join(context.stagingProfile, 'workbench/recovery/orphan-abcd.json'), 'utf8');
    await put('workbench/recovery/acknowledged.json', { version: 1, projectRoot: path.join(context.originalProfileRoot, 'different-project'), files: [{ name: 'orphan-abcd.json', sha256: hash(originalJournal) }] });
    await expect(relocateProfileFiles(context)).rejects.toThrow('different project');
    expect(await readFile(path.join(context.stagingProfile, 'workbench/recovery/orphan-abcd.json'), 'utf8')).toBe(originalJournal);
    expect(JSON.parse(originalJournal).projectRoot).toBe(journal.projectRoot);
  });
  it('relocates copied-starter metadata without granting trust or changing historical import hashes', async () => {
    const { context, put } = await fixture();
    const originalProject = path.join(context.originalProfileRoot, 'storage/projects/project-one');
    const registration = { id: 'project-one', title: 'Orbit copy', projectPath: originalProject, originPath: '/external/reviewed-starter', mode: 'copied-starter', trusted: false,
      provenance: { kind: 'user-import', attribution: 'Starter', rights: 'Private' },
      adapter: { id: 'eve.orbit', version: 1, status: 'requires-review', config: DEFAULT_ORBIT_CONFIG, configSha256: hash('original configuration') },
      manifestPath: path.join(originalProject, '.eve-import.json') };
    const files = [{ relativePath: 'src/app.mjs', sha256: hash('original source, since edited'), byteLength: 29 }];
    await put('storage/projects/project-one/.eve-import.json', { version: 1, kind: 'project', starterId: 'eve.orbit', registration, files });
    await relocateProfileFiles(context);
    const result = JSON.parse(await readFile(path.join(context.stagingProfile, 'storage/projects/project-one/.eve-import.json'), 'utf8'));
    expect(result.registration).toMatchObject({ trusted: false, projectPath: path.join(context.destinationProfile, 'storage/projects/project-one'), originPath: '/external/reviewed-starter' });
    expect(result.files).toEqual(files);
    expect(result.registration.adapter).toEqual(registration.adapter);
  });
});

async function nestedFixture() {
  const value = await fixture();
  value.context.manifest = { ...value.context.manifest, versions: { app: '0.1.0', schema: 4 } };
  const bindings: RecoveryProjectBinding[] = [{ projectId: 'legacy-orbit', before: value.journal.projectRoot, after: path.join(value.context.destinationProfile, 'workspaces/orbit') }];
  const original = new Map<string, string>();
  for (const id of ['alpha', 'beta']) {
    const before = path.join(value.context.originalProfileRoot, 'workspaces', id), after = path.join(value.context.destinationProfile, 'workspaces', id);
    bindings.push({ projectId: id, before, after });
    const text = `${id}: preserve authored reference ${value.context.originalProfileRoot}`;
    const document = { ...value.document, uri: pathToFileURL(path.join(before, 'app.ts')).href, text, hash: hash(text), bytes: Buffer.byteLength(text) };
    const snapshot = { ...value.journal, projectRoot: before, documents: [document] };
    const bytes = await value.put(`workbench/recovery/${id}/orphan-abcd.json`, snapshot); original.set(id, bytes);
    await value.put(`workbench/recovery/${id}/acknowledged.json`, { version: 1, projectRoot: before, files: [{ name: 'orphan-abcd.json', sha256: hash(bytes) }] });
  }
  return { ...value, bindings, original };
}

describe('project-bound recovery namespaces', () => {
  it.each([4, 5])('relocates two exact V%s namespaces beside legacy flat journals with independent hashes and inert unknown bytes', async schema => {
    const value = await nestedFixture();
    value.context.manifest.versions.schema = schema;
    await value.put('workbench/recovery/unknown-project/future.journal', 'opaque future bytes');
    await value.put('workbench/recovery/alpha/history/future.json', 'opaque nested bytes');
    const result = await relocateProfileFiles(value.context, { projectBindings: value.bindings });
    for (const id of ['alpha', 'beta']) {
      const read = (name: string) => readFile(path.join(value.context.stagingProfile, `workbench/recovery/${id}/${name}`), 'utf8');
      const transformed = await read('orphan-abcd.json'), journal = JSON.parse(transformed), before = JSON.parse(value.original.get(id)!);
      expect(journal.projectRoot).toBe(path.join(value.context.destinationProfile, 'workspaces', id));
      expect(journal.documents[0].text).toBe(before.documents[0].text);
      expect(journal.documents[0].uri).toBe(pathToFileURL(path.join(value.context.destinationProfile, 'workspaces', id, 'app.ts')).href);
      expect(JSON.parse(await read('acknowledged.json')).files).toEqual([{ name: 'orphan-abcd.json', sha256: hash(transformed) }]);
    }
    expect(result.changedFiles).toContain('workbench/recovery/orphan-abcd.json');
    expect(result.changedFiles).not.toContain('workbench/recovery/unknown-project/future.journal');
    expect(await readFile(path.join(value.context.stagingProfile, 'workbench/recovery/unknown-project/future.journal'), 'utf8')).toBe('opaque future bytes');
    expect(result.notes.join(' ')).toContain('2 unrecognized recovery files');
  });
  it('does not translate an acknowledgment borrowed from another project with the same journal filename', async () => {
    const value = await nestedFixture();
    await value.put('workbench/recovery/beta/acknowledged.json', { version: 1, projectRoot: value.bindings.find(item => item.projectId === 'beta')!.before, files: [{ name: 'orphan-abcd.json', sha256: hash(value.original.get('alpha')!) }] });
    await relocateProfileFiles(value.context, { projectBindings: value.bindings });
    const alpha = JSON.parse(await readFile(path.join(value.context.stagingProfile, 'workbench/recovery/alpha/acknowledged.json'), 'utf8'));
    const beta = JSON.parse(await readFile(path.join(value.context.stagingProfile, 'workbench/recovery/beta/acknowledged.json'), 'utf8'));
    expect(alpha.files).toHaveLength(1); expect(beta.files).toEqual([]);
  });
  it.each(['wrong-root', 'wrong-ack-root', 'missing-id', 'schema3', 'inexact-mapping'])('refuses %s before changing any validated metadata', async mode => {
    const value = await nestedFixture();
    if (mode === 'wrong-root') await value.put('workbench/recovery/beta/orphan-abcd.json', JSON.parse(value.original.get('alpha')!));
    if (mode === 'wrong-ack-root') await value.put('workbench/recovery/beta/acknowledged.json', { version: 1, projectRoot: value.bindings.find(item => item.projectId === 'alpha')!.before, files: [] });
    if (mode === 'missing-id') value.bindings.splice(value.bindings.findIndex(item => item.projectId === 'beta'), 1);
    if (mode === 'schema3') value.context.manifest = { ...value.context.manifest, versions: { app: '0.1.0', schema: 3 } };
    if (mode === 'inexact-mapping') value.bindings.find(item => item.projectId === 'beta')!.after = value.bindings.find(item => item.projectId === 'alpha')!.after;
    const originalAsset = await readFile(path.join(value.context.stagingProfile, 'storage/assets/asset-one/manifest.json'), 'utf8');
    await expect(relocateProfileFiles(value.context, { projectBindings: value.bindings })).rejects.toMatchObject({ code: 'RELOCATION_REQUIRED' });
    expect(await readFile(path.join(value.context.stagingProfile, 'workbench/recovery/alpha/orphan-abcd.json'), 'utf8')).toBe(value.original.get('alpha'));
    expect(await readFile(path.join(value.context.stagingProfile, 'storage/assets/asset-one/manifest.json'), 'utf8')).toBe(originalAsset);
  });
  it('refuses runtime locks and cannot use the legacy root-only option to authorize a nested namespace', async () => {
    const value = await nestedFixture();
    await expect(relocateProfileFiles(value.context, { projectPaths: value.bindings.map(item => item.after) })).rejects.toThrow('exact registered project identity');
    await value.put('workbench/recovery/alpha/workbench.lock', 'eve-workbench-recovery-v1\n');
    await expect(relocateProfileFiles(value.context, { projectBindings: value.bindings })).rejects.toThrow('lock cannot be restored');
  });
  it('preserves both namespaces on cancellation before mutation', async () => {
    const value = await nestedFixture(), cancel = new AbortController(); cancel.abort();
    await expect(relocateProfileFiles({ ...value.context, signal: cancel.signal }, { projectBindings: value.bindings })).rejects.toMatchObject({ code: 'CANCELLED' });
    for (const id of ['alpha', 'beta']) expect(await readFile(path.join(value.context.stagingProfile, `workbench/recovery/${id}/orphan-abcd.json`), 'utf8')).toBe(value.original.get(id));
  });
});
