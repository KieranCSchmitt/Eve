import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkbenchService, type WorkbenchOptions } from '../../apps/desktop/host/workbench';
import type { RecoveryDocument, WorkbenchMethod } from '../../extensions/eve-workbench/src/protocol';

const filesystemReads = vi.hoisted(() => [] as string[]);
const filesystemFaults = vi.hoisted(() => ({ unownedPath: '' }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const observe = (method: 'open' | 'readFile' | 'readdir') => (...args: unknown[]) => { filesystemReads.push(String(args[0])); return Reflect.apply(actual[method], actual, args); };
  return { ...actual, open: observe('open'), readFile: observe('readFile'), readdir: observe('readdir'), lstat: async (...args: unknown[]) => {
    const result = await Reflect.apply(actual.lstat, actual, args);
    if (String(args[0]) === filesystemFaults.unownedPath) result.uid = typeof result.uid === 'bigint' ? result.uid + 1n : result.uid + 1;
    return result;
  } };
});

let root: string;
const services: WorkbenchService[] = [];
beforeEach(async () => { filesystemReads.length = 0; filesystemFaults.unownedPath = ''; root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-scoped-recovery-'))); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); await rm(root, { recursive: true, force: true }); });
function document(text: string): RecoveryDocument { return { uri: 'untitled:shared-uri', version: 1, text, hash: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), languageId: 'plaintext', dirty: true, untitled: true, diskHash: null }; }
class CapturedWorkbench extends WorkbenchService {
  documents: RecoveryDocument[] = [];
  override async call<T>(method: WorkbenchMethod): Promise<T> { if (method !== 'recovery.capture') throw new Error('Unexpected request'); return this.documents as T; }
}
async function fixture(id: string, explicit = true) {
  const profileDirectory = path.join(root, 'instances', id), projectRoot = path.join(root, 'projects', id);
  const recoveryDirectory = explicit ? path.join(root, 'recovery', id) : path.join(profileDirectory, 'recovery');
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 }); await mkdir(projectRoot, { recursive: true }); await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
  const options: WorkbenchOptions = { profileDirectory, projectRoot, ...(explicit ? { recoveryDirectory } : {}), codeServerExecutable: '/unused', extensionDirectory: '/unused' };
  const service = new CapturedWorkbench(options); services.push(service);
  return { service, options, profileDirectory, projectRoot, recoveryDirectory };
}
async function pending(value: Awaited<ReturnType<typeof fixture>>, text: string) {
  await writeFile(path.join(value.recoveryDirectory, 'pending-123-abcd.json'), JSON.stringify({ version: 1, projectRoot: value.projectRoot, capturedAt: 1, documents: [document(text)] }), { mode: 0o600 });
}

describe('independent workbench recovery storage', () => {
  it('uses the legacy flat default and copies caller options instead of sharing mutable configuration', async () => {
    const value = await fixture('legacy', false); value.options.projectRoot = '/changed-caller-object';
    expect(value.service.options.projectRoot).toBe(value.projectRoot); expect(value.service.recoveryDirectory).toBe(path.join(value.profileDirectory, 'recovery'));
    value.service.documents = [document('Legacy named buffer')]; await value.service.captureDurableRecovery();
    expect(JSON.parse(await readFile(path.join(value.recoveryDirectory, 'current.json'), 'utf8')).projectRoot).toBe(value.projectRoot);
  });
  it('isolates identical journal names, untitled URIs and durable captures in separate explicit directories', async () => {
    const a = await fixture('alpha'), b = await fixture('beta'); await pending(a, 'Alpha pending'); await pending(b, 'Beta pending');
    a.service.documents = [document('Alpha current')]; b.service.documents = [document('Beta current')];
    await Promise.all([a.service.captureDurableRecovery(), b.service.captureDurableRecovery()]);
    expect((await a.service.loadRecovery()).map(item => item.text).sort()).toEqual(['Alpha current', 'Alpha pending']);
    expect((await b.service.loadRecovery()).map(item => item.text).sort()).toEqual(['Beta current', 'Beta pending']);
    await expect(readFile(path.join(a.profileDirectory, 'recovery/current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('binds acknowledgments to the capturing service and leaves the other project pending', async () => {
    const a = await fixture('alpha'), b = await fixture('beta'); await pending(a, 'Alpha pending'); await pending(b, 'Beta pending');
    const batchA = await a.service.loadRecoveryBatch(), batchB = await b.service.loadRecoveryBatch();
    await expect(b.service.acknowledgeRecovery(batchA)).rejects.toThrow(/not captured/);
    await a.service.acknowledgeRecovery(batchA);
    expect((await a.service.loadRecoveryBatch()).documents).toHaveLength(0); expect((await b.service.loadRecoveryBatch()).documents).toEqual(batchB.documents);
    expect(await readFile(path.join(b.recoveryDirectory, 'pending-123-abcd.json'), 'utf8')).toContain('Beta pending');
  });
  it('refuses snapshots or acknowledgments belonging to a different project', async () => {
    const a = await fixture('alpha'), b = await fixture('beta'); await pending(a, 'Alpha pending');
    const wrong = new WorkbenchService({ ...b.options, recoveryDirectory: a.recoveryDirectory }); services.push(wrong);
    await expect(wrong.loadRecoveryBatch()).rejects.toThrow(/does not belong/);
    await writeFile(path.join(a.recoveryDirectory, 'acknowledged.json'), JSON.stringify({ version: 1, projectRoot: b.projectRoot, files: [] }), { mode: 0o600 });
    await expect(a.service.loadRecoveryBatch()).rejects.toThrow(/history needs review/);
  });
  it('does not follow linked journals or replace unsafe linked/public current files', async () => {
    const value = await fixture('alpha'); const original = path.join(root, 'outside.txt'); await writeFile(original, 'Outside original', { mode: 0o600 });
    const current = path.join(value.recoveryDirectory, 'current.json'); await symlink(original, current);
    await expect(value.service.loadRecovery()).rejects.toThrow(/private regular file/);
    value.service.documents = [document('unsaved')]; await expect(value.service.captureDurableRecovery()).rejects.toThrow(/preserved rather than replaced/);
    expect(await readFile(original, 'utf8')).toBe('Outside original'); await rm(current); await link(original, current);
    await expect(value.service.captureDurableRecovery()).rejects.toThrow(/preserved rather than replaced/); await rm(current);
    await writeFile(current, '{}', { mode: 0o644 }); await expect(value.service.captureDurableRecovery()).rejects.toThrow(/preserved rather than replaced/);
  });
  it('rejects a recovery directory that stops being private and excludes its known runtime lock from draft review', async () => {
    const value = await fixture('alpha'); await pending(value, 'Pending'); await writeFile(path.join(value.recoveryDirectory, 'workbench.lock'), 'eve-workbench-recovery-v1\n', { mode: 0o600 });
    expect((await value.service.loadRecoveryBatch()).unrecognizedFiles).toEqual([]);
    await chmod(value.recoveryDirectory, 0o755); await expect(value.service.loadRecoveryBatch()).rejects.toThrow(/private directory/);
  });
});

describe('trusted recovery namespace classification in the legacy flat reader', () => {
  it('omits only a safe explicitly known child and never reads or acknowledges its drafts', async () => {
    const value = await fixture('legacy', false), child = path.join(value.recoveryDirectory, 'registered-project'), unknown = path.join(value.recoveryDirectory, 'unknown-project');
    await mkdir(child, { mode: 0o700 }); await mkdir(unknown, { mode: 0o700 });
    await writeFile(path.join(child, 'current.json'), 'Malformed private child snapshot', { mode: 0o600 });
    await writeFile(path.join(child, 'acknowledged.json'), 'Unrelated child decision', { mode: 0o600 });
    await pending(value, 'The legacy parent draft');
    value.service.setKnownRecoveryNamespaces(['registered-project']);
    filesystemReads.length = 0;
    const batch = await value.service.loadRecoveryBatch();
    expect(batch.documents.map(item => item.text)).toEqual(['The legacy parent draft']); expect(batch.unrecognizedFiles).toEqual(['unknown-project']);
    await value.service.acknowledgeRecovery(batch);
    expect(filesystemReads.filter(file => file === child || file.startsWith(child + path.sep))).toEqual([]);
    expect(await readFile(path.join(child, 'current.json'), 'utf8')).toBe('Malformed private child snapshot');
    expect(await readFile(path.join(child, 'acknowledged.json'), 'utf8')).toBe('Unrelated child decision');
    const parentAcknowledgment = JSON.parse(await readFile(path.join(value.recoveryDirectory, 'acknowledged.json'), 'utf8'));
    expect(parentAcknowledgment.files.map((file: { name: string }) => file.name)).toEqual(['pending-123-abcd.json']);
  });

  it('keeps a known name visible when it is a file, symlink or public directory', async () => {
    const value = await fixture('legacy', false), elsewhere = path.join(root, 'external-private'); await mkdir(elsewhere, { mode: 0o700 });
    await writeFile(path.join(value.recoveryDirectory, 'known-file'), 'Preserve this file', { mode: 0o600 });
    await symlink(elsewhere, path.join(value.recoveryDirectory, 'known-link')); await mkdir(path.join(value.recoveryDirectory, 'known-public'), { mode: 0o755 });
    await mkdir(path.join(value.recoveryDirectory, 'known-private'), { mode: 0o700 });
    await mkdir(path.join(value.recoveryDirectory, 'known-foreign'), { mode: 0o700 }); filesystemFaults.unownedPath = path.join(value.recoveryDirectory, 'known-foreign');
    value.service.setKnownRecoveryNamespaces(['known-file', 'known-link', 'known-public', 'known-private', 'known-foreign']);
    expect([...(await value.service.loadRecoveryBatch()).unrecognizedFiles].sort()).toEqual(['known-file', 'known-foreign', 'known-link', 'known-public']);
    await chmod(path.join(value.recoveryDirectory, 'known-private'), 0o755);
    expect((await value.service.loadRecoveryBatch()).unrecognizedFiles).toContain('known-private');
    expect(await readFile(path.join(value.recoveryDirectory, 'known-file'), 'utf8')).toBe('Preserve this file');
  });

  it('updates classification without restarting and defensively copies both options and setter arrays', async () => {
    const value = await fixture('legacy', false);
    for (const id of ['first-project', 'second-project']) await mkdir(path.join(value.recoveryDirectory, id), { mode: 0o700 });
    const initial = ['first-project']; const service = new WorkbenchService({ ...value.options, knownRecoveryNamespaces: initial }); services.push(service);
    initial[0] = 'second-project';
    expect(Object.isFrozen(service.options.knownRecoveryNamespaces)).toBe(true);
    expect(() => (service.options.knownRecoveryNamespaces as string[]).push('second-project')).toThrow();
    expect((await service.loadRecoveryBatch()).unrecognizedFiles).toEqual(['second-project']);
    const next = ['first-project', 'second-project']; service.setKnownRecoveryNamespaces(next); next.length = 0;
    expect((await service.loadRecoveryBatch()).unrecognizedFiles).toEqual([]);
    service.setKnownRecoveryNamespaces([]);
    expect([...(await service.loadRecoveryBatch()).unrecognizedFiles].sort()).toEqual(['first-project', 'second-project']);
  });

  it('refuses journal, temporary, lock, traversal, control and malformed IDs atomically', async () => {
    const value = await fixture('legacy', false); await mkdir(path.join(value.recoveryDirectory, 'valid-project'), { mode: 0o700 }); value.service.setKnownRecoveryNamespaces(['valid-project']);
    const hostile = ['.', '..', '../escape', 'nested/child', 'nested\\child', 'line\nbreak', 'nul\0byte', 'space name', '.hidden', 'current.json', 'Current.json', 'current.json.123.tmp', 'acknowledged.json', 'acknowledged.json.abcd.tmp', 'workbench.lock', 'workbench.lock.old', 'pending-123-abcd.json', 'orphan-abcd.json', 'pending-future-format', 'orphan-future-format', 'x'.repeat(129)];
    for (const id of hostile) expect(() => value.service.setKnownRecoveryNamespaces([id]), id).toThrow(/portable project IDs/);
    expect(() => value.service.setKnownRecoveryNamespaces(['duplicate', 'duplicate'])).toThrow(/portable project IDs/);
    expect(() => value.service.setKnownRecoveryNamespaces(new Array(1) as string[])).toThrow(/portable project IDs/);
    expect(() => new WorkbenchService({ ...value.options, knownRecoveryNamespaces: ['current.json'] })).toThrow(/portable project IDs/);
    expect((await value.service.loadRecoveryBatch()).unrecognizedFiles).toEqual([]);
    await pending(value, 'Still recognized'); expect((await value.service.loadRecoveryBatch()).documents[0]!.text).toBe('Still recognized');
  });

  it('pins the recovery root and refuses a replacement tree instead of hiding its known child', async () => {
    const value = await fixture('legacy', false); value.service.setKnownRecoveryNamespaces(['registered-project']);
    await mkdir(path.join(value.recoveryDirectory, 'registered-project'), { mode: 0o700 }); expect((await value.service.loadRecoveryBatch()).unrecognizedFiles).toEqual([]);
    await rename(value.recoveryDirectory, value.recoveryDirectory + '-original'); await mkdir(value.recoveryDirectory, { mode: 0o700 }); await mkdir(path.join(value.recoveryDirectory, 'registered-project'), { mode: 0o700 });
    await expect(value.service.loadRecoveryBatch()).rejects.toThrow(/identity changed|private directory/);
  });
});
