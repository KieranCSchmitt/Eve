import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CoreStore, type CoreRelocationOptions } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, type AuthenticatedContext, type CoreCommandInput } from '../../packages/contracts/src/index';
import { backupCoreDatabase, type CoreMaintenanceClient } from '../../apps/desktop/host/core-client';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let directory: string, original: string, stage: string, destination: string, core: CoreStore;
const task = () => core.snapshot().tasks.find(task => task.id === 'orbit')!;
const databaseEntry = () => { const data = readFileSync(path.join(stage, 'eve.db')); return { path: 'eve.db', bytes: data.length, sha256: hash(data) }; };
const options = (): CoreRelocationOptions => ({ stagingProfile: stage, destinationProfile: destination, originalProfileRoot: original, expectedSchemaVersion: 6, includedFiles: [databaseEntry()], includedDirectories: ['projects', 'projects/orbit'] });
const must = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => { expect(value.ok, JSON.stringify(value)).toBe(true); return value as Extract<T, { ok: true }>; };
beforeEach(() => {
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'eve-core-backup-'));
  original = path.join(directory, 'original'); stage = path.join(directory, 'stage'); destination = path.join(directory, 'restored');
  mkdirSync(original, { mode: 0o700 }); mkdirSync(stage, { mode: 0o700 });
  core = new CoreStore({ dbPath: path.join(original, 'eve.db'), orbitProjectPath: path.join(original, 'projects/orbit') });
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });

it('snapshots the live sole WAL writer into a standalone private, integrity-checked database', async () => {
  const command: CoreCommandInput = { type: 'UpdateNote', requestId: 'saved-note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().note.revision, body: 'Committed in WAL; included in the snapshot.' };
  must(core.dispatch(command, auth));
  const before = core.snapshot(), receipt = await core.backupDatabase(path.join(stage, 'eve.db'));
  expect(receipt.schemaVersion).toBe(6); expect(receipt.pageCount).toBeGreaterThan(0);
  expect({ bytes: receipt.bytes, sha256: receipt.sha256 }).toEqual({ bytes: databaseEntry().bytes, sha256: databaseEntry().sha256 });
  expect(statSync(path.join(stage, 'eve.db')).mode & 0o777).toBe(0o600);
  expect(readdirSync(stage)).toEqual(['eve.db']);
  const snapshot = new Database(path.join(stage, 'eve.db'), { readonly: true });
  expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete');
  expect(snapshot.prepare('SELECT body FROM notes WHERE task_id=?').get('orbit')).toEqual({ body: command.body });
  snapshot.close();
  expect(core.snapshot()).toEqual(before); expect(core.diagnostics().journalMode).toBe('wal');
  // This is a snapshot, not a hard link to the live database.
  must(core.dispatch({ ...command, requestId: 'later-note', expectedRevision: 1, body: 'Later live edit' }, auth));
  expect(databaseEntry().sha256).toBe(receipt.sha256);
});

it('refuses overwrite, symlink traversal, public destinations and simultaneous backup/close', async () => {
  const snapshot = core.backupDatabase(path.join(stage, 'eve.db'));
  expect(() => core.close()).toThrow(/snapshot|backup/i);
  await expect(core.backupDatabase(path.join(stage, 'other.db'))).rejects.toMatchObject({ code: 'BUSY' });
  await snapshot;
  const bytes = readFileSync(path.join(stage, 'eve.db'));
  await expect(core.backupDatabase(path.join(stage, 'eve.db'))).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION' });
  expect(readFileSync(path.join(stage, 'eve.db'))).toEqual(bytes);
  symlinkSync(stage, path.join(directory, 'alias'));
  await expect(core.backupDatabase(path.join(directory, 'alias/second.db'))).rejects.toThrow();
  mkdirSync(path.join(directory, 'public'), { mode: 0o755 });
  await expect(core.backupDatabase(path.join(directory, 'public/eve.db'))).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION' });
});

it('cancels an in-flight snapshot without publishing or invalidating the live writer', async () => {
  const controller = new AbortController();
  const pending = core.backupDatabase(path.join(stage, 'eve.db'), { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(readdirSync(stage)).toEqual([]);
  expect(core.snapshot().tasks).toHaveLength(2);
  await core.backupDatabase(path.join(stage, 'eve.db'));
});

it('maps only known DB paths and retains exact authored/history/journal text and request identity', async () => {
  const authoredText = `Keep this example path literally: ${original}/projects/orbit`;
  const noteCommand: CoreCommandInput = { type: 'UpdateNote', requestId: 'old-request', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: authoredText };
  must(core.dispatch(noteCommand, auth));
  must(core.dispatch({ type: 'SaveCheckpoint', requestId: 'place', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, checkpoint: { layout: 'work', selectedActivity: 'code', selectedFile: pathToFileURL(path.join(original, 'projects/orbit/eve.project.json')).href, returnAnchors: ['notes'] } }, auth));
  const content = 'Imported research original\n';
  const managedPath = path.join(original, 'managed/assets/original/source.txt');
  must(core.registerAsset({ id: 'original', taskId: 'orbit', title: 'Research', originalPath: path.join(directory, 'external-research.txt'), managedPath, sha256: hash(content), byteLength: Buffer.byteLength(content), mediaType: 'text/plain', provenance: { kind: 'user-import', attribution: authoredText, rights: 'Owned by author' } }, auth));
  must(core.registerSource({ id: 'source', taskId: 'orbit', title: 'Research', assetId: 'original', excerpt: authoredText, retrievedAt: 100, provenance: { kind: 'user-import', attribution: 'From imported original', rights: 'Owned by author' } }, auth));
  const beforeText = JSON.stringify({ ...task().parameters!.values, comment: authoredText });
  const afterText = JSON.stringify({ ...JSON.parse(beforeText), transitionMs: 500 });
  const edit = must(core.prepareProjectEdit({ type: 'SetParameter', requestId: 'pending', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, name: 'transitionMs', value: 500 }, auth, { relativePath: 'eve.project.json', beforeText, afterText, beforeHash: hash(beforeText), afterHash: hash(afterText), location: 'buffer', documentVersion: 7 })).edit!;
  must(core.recordProjectEditReceipt(edit.id, { operationId: edit.id, location: 'buffer', documentVersion: 8, file: path.join(original, 'projects/orbit/eve.project.json'), beforeText, afterText, beforeHash: hash(beforeText), afterHash: hash(afterText) }, auth));
  must(core.beginJob({ id: 'in-flight', taskId: 'orbit', taskEpoch: task().epoch, generation: 1, provider: 'local' }, auth));
  await core.backupDatabase(path.join(stage, 'eve.db'));
  const database = new Database(path.join(stage, 'eve.db'));
  const prior = { journal: database.prepare('SELECT fingerprint,command_json,preparation_json FROM project_edits').all(), requests: database.prepare('SELECT * FROM requests').all(), operations: database.prepare('SELECT * FROM operations').all() }; database.close();
  const manifest = options();
  manifest.includedFiles = [...manifest.includedFiles, { path: 'managed/assets/original/source.txt', bytes: Buffer.byteLength(content), sha256: hash(content) }, { path: 'managed/assets/original/manifest.json', bytes: 2, sha256: hash('{}') }];
  const receipt = await CoreStore.relocateDatabase(manifest);
  expect(receipt).toMatchObject({ databaseValidated: true, schemaVersion: 6, changedFiles: ['eve.db'], projects: [{ taskId: 'orbit', before: path.join(original, 'projects/orbit'), after: path.join(destination, 'projects/orbit'), external: false }] });
  expect(receipt.assets[0]!.after.managedPath).toBe(path.join(destination, 'managed/assets/original/source.txt'));
  expect(receipt.references).toContainEqual(expect.objectContaining({ kind: 'external', before: path.join(directory, 'external-research.txt'), included: false }));
  expect(receipt.remainingMetadata).toEqual([{ path: 'managed/assets/original/manifest.json', kind: 'asset-manifest' }]);
  expect(receipt).not.toHaveProperty('validated');
  const relocated = new CoreStore({ dbPath: path.join(stage, 'eve.db') });
  try {
    const restoredTask = relocated.snapshot().tasks.find(task => task.id === 'orbit')!;
    expect(restoredTask.note.body).toBe(authoredText); expect(restoredTask.projectPath).toBe(path.join(destination, 'projects/orbit'));
    expect(restoredTask.checkpoint!.selectedFile).toBe(pathToFileURL(path.join(destination, 'projects/orbit/eve.project.json')).href);
    expect(relocated.listSources('orbit')[0]!.excerpt).toBe(authoredText);
    const pending = relocated.listPendingProjectEdits()[0]!;
    expect(pending.projectPath).toBe(restoredTask.projectPath); expect(pending.beforeText).toBe(beforeText); expect(pending.afterText).toBe(afterText);
    expect(pending.receipt!.file).toBe(path.join(destination, 'projects/orbit/eve.project.json'));
    const retry = must(relocated.dispatch(noteCommand, auth));
    expect(retry.idempotent).toBe(true); expect(retry.snapshot.tasks.find(task => task.id === 'orbit')!.projectPath).toBe(restoredTask.projectPath);
  } finally { relocated.close(); }
  const inspect = new Database(path.join(stage, 'eve.db'), { readonly: true });
  expect(inspect.prepare('SELECT fingerprint,command_json,preparation_json FROM project_edits').all()).toEqual(prior.journal);
  expect(inspect.prepare('SELECT * FROM requests').all()).toEqual(prior.requests); expect(inspect.prepare('SELECT * FROM operations').all()).toEqual(prior.operations);
  expect(inspect.prepare('SELECT status FROM jobs').get()).toEqual({ status: 'cancelled' }); inspect.close();
  expect(task().projectPath).toBe(path.join(original, 'projects/orbit')); expect(core.isJobCurrent('in-flight', 1)).toBe(true);
});

it.each([
  ['manifest schema', '', 'VERSION_REFUSED'],
  ['actual schema', 'PRAGMA user_version=7', 'VERSION_REFUSED'],
  ['unknown table', 'CREATE TABLE mystery(path TEXT)', 'UNSUPPORTED_SCHEMA'],
  ['unknown trigger', 'CREATE TRIGGER mystery AFTER UPDATE ON tasks BEGIN SELECT 1; END', 'UNSUPPORTED_SCHEMA'],
  ['broken relationship', "PRAGMA foreign_keys=OFF; INSERT INTO notes VALUES ('bad','missing','text',0,0)", 'INVALID_DATABASE'],
  ['unknown history target', "UPDATE operations SET target='workspace'", 'UNSUPPORTED_SCHEMA'],
])('refuses %s without publishing a destination', async (kind, sql, code) => {
  must(core.dispatch({ type: 'UpdateNote', requestId: 'history', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: 'Preserved' }, auth));
  await core.backupDatabase(path.join(stage, 'eve.db'));
  if (sql) { const modify = new Database(path.join(stage, 'eve.db')); modify.exec(sql); modify.close(); }
  const input = options(); if (kind === 'manifest schema') input.expectedSchemaVersion = 2;
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code });
  expect(readdirSync(directory)).not.toContain('restored');
});

it('rejects a mismatched database checksum and unsupported editor URI; path changes roll back', async () => {
  must(core.dispatch({ type: 'SaveCheckpoint', requestId: 'remote-checkpoint', taskId: 'orbit', expectedEpoch: 1, expectedRevision: 0, checkpoint: { layout: 'work', selectedActivity: 'code', selectedFile: 'vscode-remote://unknown/home/file', returnAnchors: [] } }, auth));
  await core.backupDatabase(path.join(stage, 'eve.db'));
  const mismatched = options(); mismatched.includedFiles = [{ ...databaseEntry(), sha256: '0'.repeat(64) }];
  await expect(CoreStore.relocateDatabase(mismatched)).rejects.toMatchObject({ code: 'INVALID_DATABASE' });
  await expect(CoreStore.relocateDatabase(options())).rejects.toMatchObject({ code: 'UNSAFE_REFERENCE' });
  const database = new Database(path.join(stage, 'eve.db'), { readonly: true });
  expect(database.prepare('SELECT p.canonical_root AS project_path FROM projects p JOIN task_projects b ON b.project_id=p.id WHERE b.task_id=?').get('orbit')).toEqual({ project_path: path.join(original, 'projects/orbit') }); database.close();
});

it('does not acknowledge cancellation until the writer reports terminal completion', async () => {
  let rejectBackup!: (error: Error) => void;
  const completion = new Promise<never>((_, reject) => { rejectBackup = reject; });
  const messages: { method: string; payload: unknown }[] = [];
  const client: CoreMaintenanceClient = <T>(method: string, payload?: unknown) => { messages.push({ method, payload }); return (method === 'backup-database' ? completion : Promise.resolve({ acknowledged: true })) as Promise<T>; };
  const controller = new AbortController(), finished = vi.fn();
  const result = backupCoreDatabase(client, '/private/destination/eve.db', controller.signal).catch(error => { finished(); throw error; });
  controller.abort(); await Promise.resolve(); await Promise.resolve();
  expect(messages.map(message => message.method)).toEqual(['backup-database', 'cancel-backup']);
  expect(messages[0]!.payload).toMatchObject(messages[1]!.payload as object); expect(finished).not.toHaveBeenCalled();
  rejectBackup(new Error('SQLite backup cancelled and closed'));
  await expect(result).rejects.toThrow('cancelled and closed'); expect(finished).toHaveBeenCalledOnce();
});
