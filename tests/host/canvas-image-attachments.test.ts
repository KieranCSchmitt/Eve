import { mkdtemp, realpath, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, type CanvasDocument, type CoreCommandInput, type DispatchResult } from '@eve/contracts';
import { TaskAssets } from '../../apps/desktop/host/assets';
import { CanvasImageAttachments } from '../../apps/desktop/host/canvas-image-attachments';
import type { CanvasImageAttachmentInput } from '../../apps/desktop/shared/bridge';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const source = path.resolve('apps/desktop/renderer/public/assets/photo-walk.png');
const original = (): CanvasDocument => ({ version: 1, title: 'A place for a photograph', subtitle: '', layout: 'split', blocks: [
  { id: 'words', kind: 'text', title: 'My own thought', body: 'Keep this sentence exactly.', placement: 'main', sourceIds: [], pinned: false },
  { id: 'photo', kind: 'image', title: 'A photograph to add', assetId: null, caption: 'My own caption.', placement: 'aside', sourceIds: [], pinned: true },
] });
let root: string, core: CoreStore, assets: TaskAssets, service: CanvasImageAttachments;
let assetId: string, pick: () => Promise<string | null>, available: boolean;
let afterImport: () => void, dispatch: (input: CoreCommandInput) => Promise<DispatchResult>;
let calls: CoreCommandInput[], picks: number, imports: number;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
const document = () => task().canvas!.document!;
function save(next: CanvasDocument, requestId = crypto.randomUUID()) {
  const result = core.dispatch({ type: 'UpdateCanvas', requestId, taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().canvas?.revision ?? 0, document: next }, auth);
  expect(result.ok).toBe(true);
}
const input = (kind: 'existing' | 'import' = 'existing'): CanvasImageAttachmentInput => ({ requestId: crypto.randomUUID(), taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().canvas!.revision, blockId: 'photo', source: kind === 'existing' ? { kind, assetId } : { kind } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'eve-image-slot-')));
  core = new CoreStore({ dbPath: path.join(root, 'eve.db') });
  assets = await TaskAssets.open(path.join(root, 'managed'), async (method, value) => {
    if (method === 'register-asset') return core.registerAsset(value, auth) as never;
    if (method === 'list-assets') return core.listAssets(String(value)) as never;
    if (method === 'register-source') return core.registerSource(value, auth) as never;
    if (method === 'list-sources') return core.listSources(String(value)) as never;
    throw new Error(`Unexpected method ${method}`);
  });
  assetId = (await assets.import('orbit', source)).id;
  save(original());
  calls = []; picks = 0; imports = 0; available = true; afterImport = () => {};
  pick = async () => source;
  dispatch = async command => core.dispatch(command, auth);
  service = new CanvasImageAttachments({ snapshot: async () => core.snapshot(), records: id => assets.records(id),
    importImage: async (id, file) => { imports++; const result = await assets.import(id, file); afterImport(); return result; },
    chooseImage: () => { picks++; return pick(); }, available: () => available,
    mutate: operation => operation(), preflight: async command => core.preflight(command, auth),
    dispatch: async command => { calls.push(structuredClone(command)); return dispatch(command); },
  });
});
afterEach(async () => { core.close(); await rm(root, { recursive: true, force: true }); });

it('fills the exact pinned empty slot, preserving all authored data, with durable Undo, restart and backup', async () => {
  const before = structuredClone(document()), request = input();
  const result = await service.attach(request);
  expect(result.status).toBe('attached'); expect(picks).toBe(0); expect(imports).toBe(0); expect(calls).toHaveLength(1);
  const expected = structuredClone(before); (expected.blocks[1] as Extract<CanvasDocument['blocks'][number], { kind: 'image' }>).assetId = assetId;
  expect(document()).toEqual(expected);
  expect((await service.attach(request)).status).toBe('attached'); expect(calls).toHaveLength(1);
  expect(core.dispatch({ type: 'Undo', requestId: 'undo-attachment', taskId: 'orbit', expectedEpoch: task().epoch }, auth).ok).toBe(true);
  expect(document()).toEqual(before); expect(core.listAssets('orbit')).toHaveLength(1);
  const snapshot = core.snapshot();
  await mkdir(path.join(root, 'backup'), { mode: 0o700 });
  await core.backupDatabase(path.join(root, 'backup/eve.db'));
  const backup = new CoreStore({ dbPath: path.join(root, 'backup/eve.db') });
  expect(backup.snapshot()).toEqual(snapshot); backup.close();
  core.close(); core = new CoreStore({ dbPath: path.join(root, 'eve.db') }); expect(core.snapshot()).toEqual(snapshot);
});
it('imports one verified original and attaches its returned identity without selecting a different existing image', async () => {
  const before = await readFile(source), request = input('import');
  const result = await service.attach(request);
  expect(result.status).toBe('attached'); expect(result.assetId).not.toBe(assetId); expect(picks).toBe(1); expect(imports).toBe(1);
  const saved = core.listAssets('orbit').find(item => item.id === result.assetId)!;
  expect((await readFile(source)).equals(before)).toBe(true); expect((await readFile(saved.managedPath)).equals(before)).toBe(true);
  expect(saved.sha256).toBe(createHash('sha256').update(before).digest('hex'));
  expect(document().blocks[1]).toEqual({ ...original().blocks[1], assetId: result.assetId });
});
it('deduplicates an in-flight picker and refuses request substitution or a second task attachment', async () => {
  const selection = deferred<string | null>(); pick = () => selection.promise; const request = input('import');
  const first = service.attach(request), second = service.attach(structuredClone(request));
  expect(first).toBe(second); await vi.waitFor(() => expect(picks).toBe(1));
  await expect(service.attach({ ...request, blockId: 'words' })).rejects.toThrow(/changed/);
  await expect(service.attach(input())).rejects.toThrow(/current image/);
  selection.resolve(source); expect((await first).status).toBe('attached'); expect(imports).toBe(1); expect(calls).toHaveLength(1);
});
it('native picker cancellation makes no import or canvas write', async () => {
  pick = async () => null; const before = core.snapshot();
  expect((await service.attach(input('import'))).status).toBe('cancelled');
  expect(core.snapshot()).toEqual(before); expect(imports).toBe(0); expect(calls).toHaveLength(0);
});
it.each(['caption', 'removed', 'filled', 'navigation', 'privacy'] as const)('rejects %s changes while the picker is open before copying', async mode => {
  const selection = deferred<string | null>(); pick = () => selection.promise; const request = input('import');
  const pending = service.attach(request); await vi.waitFor(() => expect(picks).toBe(1));
  if (mode === 'navigation') expect(core.dispatch({ type: 'ShowHome', requestId: 'go-home', taskId: 'orbit', expectedEpoch: task().epoch }, auth).ok).toBe(true);
  else if (mode === 'privacy') { available = false; service.cancelAll(); }
  else save({ ...document(), blocks: mode === 'removed' ? [document().blocks[0]] : document().blocks.map(block => block.id !== 'photo' || block.kind !== 'image' ? block : mode === 'caption' ? { ...block, caption: 'A later caption.' } : { ...block, assetId }) });
  const before = core.snapshot(); selection.resolve(source);
  expect((await pending).status).toMatch(/failed|cancelled/); expect(core.snapshot()).toEqual(before); expect(imports).toBe(0); expect(calls).toHaveLength(0);
});
it.each(['cancel', 'edit'] as const)('retains imported material without attaching when %s occurs after copying', async mode => {
  const request = input('import');
  afterImport = () => mode === 'cancel' ? service.cancel({ taskId: 'orbit', requestId: request.requestId }) : save({ ...document(), subtitle: 'Authored while the copy finished.' });
  expect((await service.attach(request)).status).toBe('not-attached');
  expect(core.listAssets('orbit')).toHaveLength(2); expect(calls).toHaveLength(0);
  expect(document().blocks).toEqual(original().blocks);
  if (mode === 'edit') expect(document().subtitle).toBe('Authored while the copy finished.');
});
it.each(['foreign', 'text', 'missing'] as const)('refuses a %s existing asset without changing the canvas', async mode => {
  let badId = 'not-saved';
  if (mode === 'foreign') badId = (await assets.import('photo-walk', source)).id;
  if (mode === 'text') { const file = path.join(root, 'note.txt'); await writeFile(file, 'Keep my note.'); badId = (await assets.import('orbit', file)).id; }
  const request = input(); request.source = { kind: 'existing', assetId: badId }; const before = core.snapshot();
  expect((await service.attach(request)).status).toBe('failed'); expect(core.snapshot()).toEqual(before); expect(calls).toHaveLength(0);
});
it('rejects renderer filesystem paths and URLs before invoking a picker', () => {
  expect(() => service.attach({ ...input('import'), source: { kind: 'import', path: '/private/file.jpg' } })).toThrow();
  expect(() => service.attach({ ...input(), source: { kind: 'url', url: 'https://invalid/image.jpg' } })).toThrow();
  expect(picks).toBe(0); expect(imports).toBe(0);
});
it.each(['before', 'after'] as const)('checks a lost %s-commit receipt using the exact command without importing twice', async phase => {
  let once = true; dispatch = async command => {
    if (once) { once = false; if (phase === 'after') expect(core.dispatch(command, auth).ok).toBe(true); throw new Error('Lost core acknowledgement'); }
    return core.dispatch(command, auth);
  };
  const request = input('import');
  expect((await service.attach(request)).status).toBe('uncertain');
  await expect(service.attach(input())).rejects.toThrow(/current image/);
  expect((await service.attach(request)).status).toBe('attached');
  expect(picks).toBe(1); expect(imports).toBe(1); expect(task().canvas!.revision).toBe(2);
  expect(calls).toHaveLength(phase === 'after' ? 1 : 2);
  if (phase === 'before') expect(calls[1]).toEqual(calls[0]);
});
it.each(['before', 'after'] as const)('cancelled %s-commit uncertainty can be settled without making a new attachment', async phase => {
  dispatch = async command => { if (phase === 'after') expect(core.dispatch(command, auth).ok).toBe(true); throw new Error('Lost core acknowledgement'); };
  const request = input('import'); expect((await service.attach(request)).status).toBe('uncertain');
  service.cancel({ taskId: 'orbit', requestId: request.requestId });
  expect((await service.attach(request)).status).toBe(phase === 'after' ? 'attached' : 'not-attached');
  expect(calls).toHaveLength(1); expect(imports).toBe(1); expect(task().canvas!.revision).toBe(phase === 'after' ? 2 : 1);
});
it('never rebases an uncertain uncommitted attachment onto a later caption', async () => {
  dispatch = async () => { throw new Error('Unacknowledged'); };
  const request = input(); expect((await service.attach(request)).status).toBe('uncertain');
  save({ ...document(), blocks: document().blocks.map(block => block.kind === 'image' ? { ...block, caption: 'My newer caption.' } : block) });
  const before = core.snapshot(); expect((await service.attach(request)).status).toBe('failed'); expect(core.snapshot()).toEqual(before); expect(calls).toHaveLength(1);
});
