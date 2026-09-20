import { mkdtemp, readFile, readdir, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, sourceRegistrationSchema } from '../../packages/contracts/src/index';
import { MATERIAL_EXCERPT_BYTES, TaskAssets } from '../../apps/desktop/host/assets';
import type { CoreClient } from '../../apps/desktop/host/project-edits';
import { ManagedImporter } from '../../packages/imports/src/index';
import { buildIntentRequest } from '../../apps/desktop/host/intent-context';

let root: string, store: CoreStore, assets: TaskAssets;
let sourceFailure: 'before' | 'after' | null;
let assetFailure: boolean;
let forgedExcerpt: boolean;
const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-asset-host-')));
  store = new CoreStore({ dbPath: path.join(root, 'eve.db') });
  sourceFailure = null; assetFailure = false; forgedExcerpt = false;
  const core: CoreClient = async (method, payload) => {
    if (method === 'register-asset') { if (assetFailure) throw new Error(`private storage failure ${root}`); return store.registerAsset(payload, auth) as never; }
    if (method === 'list-assets') return store.listAssets(String(payload)) as never;
    if (method === 'register-source') {
      if (sourceFailure === 'before') throw new Error(`private storage failure ${root}`);
      const result = store.registerSource(payload, auth);
      if (sourceFailure === 'after') throw new Error(`private lost receipt ${root}`);
      return result as never;
    }
    if (method === 'list-sources') return store.listSources(String(payload)).map(source => forgedExcerpt ? { ...source, excerpt: 'Unverified replacement text.' } : source) as never;
    throw new Error('Unexpected core method');
  };
  assets = await TaskAssets.open(path.join(root, 'managed'), core);
});
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

it('serves verified copied material by canonical task identity and preserves the original', async () => {
  const original = path.join(root, 'note.md');
  await writeFile(original, '# A useful reference\nA thought to keep.');
  const saved = await assets.import('photo-walk', original);
  await writeFile(original, 'Changed independently.');
  expect(await assets.text('photo-walk', saved.id)).toContain('A useful reference');
  const [publicAsset] = await assets.list('photo-walk');
  expect(publicAsset).not.toHaveProperty('managedPath');
  expect(publicAsset).not.toHaveProperty('originalPath');
  expect((await assets.serve(publicAsset!.url)).headers.get('x-content-type-options')).toBe('nosniff');
  expect((await assets.serve(publicAsset!.url)).headers.get('cache-control')).toBe('no-store');
  expect(await readFile(original, 'utf8')).toBe('Changed independently.');
  expect((await assets.serve(publicAsset!.url.replace('/photo-walk/', '/orbit/'))).status).toBe(404);
});

it('refuses changed bytes and symlinks escaping managed storage', async () => {
  const original = path.join(root, 'note.txt'); await writeFile(original, 'initial');
  const saved = await assets.import('photo-walk', original);
  const url = (await assets.list('photo-walk'))[0]!.url;
  await writeFile(saved.managedPath, 'altered');
  expect((await assets.serve(url)).status).toBe(409);
  await rm(saved.managedPath); await symlink(original, saved.managedPath);
  expect((await assets.serve(url)).status).toBe(404);
  await expect(assets.text('photo-walk', saved.id)).rejects.toThrow('could not be verified');
});

it('turns a real Markdown import into a canonical grounded source and renderer-safe viewer target', async () => {
  const original = path.join(root, 'ideas.md');
  const body = '# Looking closely\nNotice the reflected blue light beside the window.';
  await writeFile(original, body);
  const saved = await assets.import('photo-walk', original, 'My original field notes', 'Light studies');
  const sources = await assets.ensureSources('photo-walk');
  expect(sources).toHaveLength(1);
  const source = sources[0]!;
  expect(source.id.length).toBeLessThanOrEqual(128);
  expect(source).toMatchObject({ taskId: 'photo-walk', assetId: saved.id, title: 'Light studies', excerpt: body, retrievedAt: saved.createdAt, provenance: saved.provenance });
  const { createdAt, ...registration } = source;
  expect(createdAt).toBeGreaterThan(0);
  expect(sourceRegistrationSchema.safeParse(registration).success).toBe(true);
  expect(JSON.stringify(source)).not.toContain(root);
  expect(source).not.toHaveProperty('url');
  expect(await assets.resolveSource('photo-walk', source.id)).toEqual({ taskId: 'photo-walk', assetId: saved.id });
  await expect(assets.resolveSource('orbit', source.id)).rejects.toThrow('source attached to this space');
  await expect(assets.resolveSource('photo-walk', saved.managedPath)).rejects.toThrow();
  store.dispatch({ type: 'RecallTask', requestId: 'select-photo', taskId: 'photo-walk' }, auth);
  const built = buildIntentRequest({ taskId: 'photo-walk', text: 'Explain my light study reference.', requestId: 'material-question', generation: 1, snapshot: store.snapshot(), sources, selectedSourceId: source.id });
  const admitted = built.request.sources.find(item => item.id === source.id)!;
  expect(admitted.excerpt).toContain(body);
  expect(admitted.provenance).toBe('attached');
  expect(admitted.uri).toBe(`eve-artifact://photo-walk/${saved.id}`);
  expect(JSON.stringify(built.request)).not.toContain(saved.managedPath);
});

it('backfills pre-existing copies without duplicating sources or changing their original files', async () => {
  const original = path.join(root, 'old.txt'); await writeFile(original, 'A previously imported thought.');
  const importer = await ManagedImporter.open({ managedRoot: path.join(root, 'managed') });
  const registration = await importer.importAsset({ taskId: 'orbit', sourcePath: original });
  expect(store.registerAsset(registration, auth).ok).toBe(true);
  expect(store.listSources('orbit')).toEqual([]);
  await writeFile(original, 'The external original can change independently.');
  const [first, second] = await Promise.all([assets.ensureSources('orbit'), assets.ensureSources('orbit')]);
  expect(first).toEqual(second);
  expect(first[0]!.excerpt).toBe('A previously imported thought.');
  expect(store.listSources('orbit')).toHaveLength(1);
  const originalCreatedAt = first[0]!.createdAt;
  store.close(); store = new CoreStore({ dbPath: path.join(root, 'eve.db') });
  expect((await assets.ensureSources('orbit'))[0]!.createdAt).toBe(originalCreatedAt);
  expect(await readFile(original, 'utf8')).toBe('The external original can change independently.');
});

it('labels and bounds UTF-8 excerpts without claiming that the complete file was read into context', async () => {
  const original = path.join(root, 'long.md');
  const body = '雪と光。'.repeat(1800) + 'A final sentence beyond the excerpt.';
  await writeFile(original, body);
  const saved = await assets.import('orbit', original);
  const [source] = await assets.ensureSources('orbit');
  expect(source!.excerpt).toMatch(/^\[Truncated excerpt of imported text \(\d+ original UTF-8 bytes\)/);
  expect(Buffer.byteLength(source!.excerpt)).toBeLessThanOrEqual(MATERIAL_EXCERPT_BYTES);
  expect(source!.excerpt).not.toContain('\ufffd');
  expect(source!.excerpt).not.toContain('A final sentence');
  expect(await assets.text('orbit', saved.id)).toBe(body);
});

it('re-verifies the entire copy before admitting an old excerpt, including bytes beyond the excerpt', async () => {
  const original = path.join(root, 'long.txt');
  const body = 'A'.repeat(MATERIAL_EXCERPT_BYTES + 400) + 'ending';
  await writeFile(original, body);
  const saved = await assets.import('orbit', original);
  const [source] = await assets.ensureSources('orbit');
  await writeFile(saved.managedPath, body.slice(0, -1) + '!');
  await expect(assets.ensureSources('orbit')).rejects.toThrow('could not be verified');
  await expect(assets.resolveSource('orbit', source!.id)).rejects.toThrow('could not be verified');
  expect(store.listSources('orbit')[0]!.excerpt).toBe(source!.excerpt);
  expect(await readFile(original, 'utf8')).toBe(body);
});

it('refuses source excerpt drift and same-hash symlink replacement inside managed storage', async () => {
  const original = path.join(root, 'note.txt'); await writeFile(original, 'Verified text.');
  const first = await assets.import('orbit', original);
  const second = await assets.import('orbit', original);
  const [source] = await assets.ensureSources('orbit');
  forgedExcerpt = true;
  await expect(assets.ensureSources('orbit')).rejects.toThrow('no longer matches');
  await expect(assets.resolveSource('orbit', source!.id)).rejects.toThrow('no longer matches');
  forgedExcerpt = false;
  await rm(first.managedPath); await symlink(second.managedPath, first.managedPath);
  await expect(assets.ensureSources('orbit')).rejects.toThrow();
  expect((await assets.serve((await assets.list('orbit')).find(asset => asset.id === first.id)!.url)).status).toBe(404);
});

it.each(['before', 'after'] as const)('preserves copied material when source registration fails %s commit and recovers without a second copy', async failure => {
  const original = path.join(root, 'note.txt'); await writeFile(original, 'Keep this original and its copy.');
  sourceFailure = failure;
  await expect(assets.import('orbit', original)).rejects.toThrow('The material was saved, but Eve could not make it available for questions');
  const [saved] = store.listAssets('orbit');
  expect(saved).toBeDefined();
  expect(await readFile(saved!.managedPath, 'utf8')).toBe('Keep this original and its copy.');
  const manifest = JSON.parse(await readFile(path.join(path.dirname(saved!.managedPath), 'manifest.json'), 'utf8'));
  expect(manifest.registration.id).toBe(saved!.id);
  expect(store.listSources('orbit')).toHaveLength(failure === 'after' ? 1 : 0);
  sourceFailure = null;
  expect(await assets.ensureSources('orbit')).toHaveLength(1);
  expect(store.listAssets('orbit')).toHaveLength(1);
  expect(store.listSources('orbit')).toHaveLength(1);
  expect(await readdir(path.join(root, 'managed/assets'))).toHaveLength(1);
});

it('retains a durable manifest and gives a path-free partial failure when asset registration cannot be confirmed', async () => {
  const original = path.join(root, 'note.txt'); await writeFile(original, 'Keep the unregistered copy.');
  assetFailure = true;
  const error = await assets.import('orbit', original).then(() => 'unexpected success', error => error.message as string);
  expect(error).toContain('recovery copy is saved');
  expect(error).not.toContain(root);
  expect(store.listAssets('orbit')).toEqual([]);
  const [id] = await readdir(path.join(root, 'managed/assets'));
  const manifest = JSON.parse(await readFile(path.join(root, 'managed/assets', id!, 'manifest.json'), 'utf8'));
  expect(await readFile(manifest.registration.managedPath, 'utf8')).toBe('Keep the unregistered copy.');
});

it('keeps image imports as viewer metadata without inventing an AI description', async () => {
  const original = path.join(root, 'image.png');
  await writeFile(original, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const saved = await assets.import('orbit', original);
  expect(await assets.ensureSources('orbit')).toEqual([]);
  expect(store.listSources('orbit')).toEqual([]);
  expect((await assets.list('orbit'))[0]).toMatchObject({ id: saved.id, mediaType: 'image/png' });
  expect((await assets.serve((await assets.list('orbit'))[0]!.url)).ok).toBe(true);
  await expect(assets.text('orbit', saved.id)).rejects.toThrow('text or Markdown');
});

it('does not serve an executable MIME type supplied through incompatible stored metadata', async () => {
  const original = path.join(root, 'reference.txt'); await writeFile(original, '<script>not executable material</script>');
  const importer = await ManagedImporter.open({ managedRoot: path.join(root, 'managed') });
  const registration = await importer.importAsset({ taskId: 'orbit', sourcePath: original });
  expect(store.registerAsset({ ...registration, mediaType: 'text/html' }, auth).ok).toBe(true);
  expect((await assets.serve(`eve-asset://workspace/orbit/${registration.id}`)).status).toBe(409);
  await expect(assets.ensureSources('orbit')).rejects.toThrow('could not verify the saved details');
});
