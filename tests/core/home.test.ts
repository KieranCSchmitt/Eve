import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, type AuthenticatedContext, type CoreCommandInput } from '../../packages/contracts/src/index';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
const must = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Extract<T, { ok: true }>;
};
let directory: string, profile: string, dbPath: string, core: CoreStore;
const task = (id = 'orbit') => core.snapshot().tasks.find(task => task.id === id)!;
const home = (requestId = 'go-home'): Extract<CoreCommandInput, { type: 'ShowHome' }> => ({ type: 'ShowHome', requestId, taskId: task().id, expectedEpoch: task().epoch });
beforeEach(() => {
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'eve-home-'));
  profile = path.join(directory, 'profile'); mkdirSync(profile, { mode: 0o700 });
  dbPath = path.join(profile, 'eve.db');
  core = new CoreStore({ dbPath, orbitProjectPath: path.join(profile, 'projects/orbit') });
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });

describe('Home navigation and startup', () => {
  it('starts fresh seeded and empty app profiles at Home while direct tooling retains its default', () => {
    expect(core.snapshot().activeTaskId).toBe('orbit');
    core.close();
    core = new CoreStore({ dbPath: path.join(directory, 'fresh/eve.db'), startAtHome: true });
    expect(core.snapshot().activeTaskId).toBeNull();
    expect(core.snapshot().tasks.map(task => task.id)).toEqual(['orbit', 'photo-walk']);
    expect(core.snapshot().recentActions).toEqual([]);
    expect(core.diagnostics().schemaVersion).toBe(6);
    core.close();
    core = new CoreStore({ dbPath: path.join(directory, 'empty/eve.db'), startAtHome: true, seed: false });
    expect(core.snapshot()).toMatchObject({ activeTaskId: null, tasks: [], recentActions: [] });
  });

  it('preserves authored work, checkpoints, project identity and undo while invalidating the outgoing context', () => {
    const initialBody = task().note.body;
    const edited = must(core.dispatch({ type: 'UpdateNote', requestId: 'note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().note.revision, body: 'Keep this work through Home.' }, auth));
    must(core.dispatch({ type: 'SaveCheckpoint', requestId: 'place', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, checkpoint: { layout: 'work', selectedActivity: 'notes', topLine: 7, returnAnchors: ['code'] } }, auth));
    const before = task(), other = task('photo-walk');
    must(core.beginJob({ id: 'outgoing-job', taskId: before.id, taskEpoch: before.epoch, generation: 1, provider: 'local' }, auth));
    must(core.beginJob({ id: 'other-job', taskId: other.id, taskEpoch: other.epoch, generation: 1, provider: 'local', background: true }, auth));
    const command = home();
    expect(core.preflight(command, auth).ok).toBe(true);
    expect(task()).toEqual(before);
    expect(core.snapshot().activeTaskId).toBe('orbit');
    expect(core.isJobCurrent('outgoing-job', 1)).toBe(true);
    const result = must(core.dispatch(command, auth));
    expect(result.snapshot.activeTaskId).toBeNull();
    expect(task()).toEqual({ ...before, epoch: before.epoch + 1 });
    expect(task('photo-walk')).toEqual(other);
    expect(core.isJobCurrent('outgoing-job', 1)).toBe(false);
    expect(core.isJobCurrent('other-job', 1)).toBe(true);
    expect(result.operation).toMatchObject({ type: 'ShowHome', taskId: 'orbit', undoable: false, undone: false });
    const stale = { type: 'UpdateNote' as const, requestId: 'old-proposal', taskId: 'orbit', expectedEpoch: before.epoch, expectedRevision: before.note.revision, body: 'Late result' };
    expect(core.dispatch(stale, auth)).toMatchObject({ ok: false, error: { code: 'STALE_EPOCH' } });
    must(core.dispatch({ type: 'RecallTask', requestId: 'return', taskId: 'orbit' }, auth));
    expect(core.dispatch(stale, auth)).toMatchObject({ ok: false, error: { code: 'STALE_EPOCH' } });
    expect(core.dispatch({ type: 'Undo', requestId: 'undo-navigation', taskId: 'orbit', expectedEpoch: task().epoch, operationId: result.operation.id }, auth)).toMatchObject({ ok: false, error: { code: 'NOT_UNDOABLE' } });
    must(core.dispatch({ type: 'Undo', requestId: 'undo-note', taskId: 'orbit', expectedEpoch: task().epoch, operationId: edited.operation.id }, auth));
    expect(task().note.body).toBe(initialBody);
    expect(task().checkpoint).toEqual(before.checkpoint);
    expect(task().project).toEqual(before.project);
  });

  it('requires trusted navigation authority, task scope, matching active task and current epoch', () => {
    const before = core.snapshot(), command = home();
    for (const denied of [
      { ...auth, origin: 'model' as const }, { ...auth, origin: 'workbench' as const, taskIds: ['orbit'] },
      { ...auth, capabilities: [] }, { ...auth, taskIds: ['photo-walk'] },
    ]) expect(core.dispatch(command, denied)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(core.dispatch({ ...command, taskId: 'photo-walk', expectedEpoch: task('photo-walk').epoch }, auth)).toMatchObject({ ok: false, error: { code: 'STALE_EPOCH' } });
    expect(core.dispatch({ ...command, expectedEpoch: task().epoch + 1 }, auth)).toMatchObject({ ok: false, error: { code: 'STALE_EPOCH' } });
    expect(core.snapshot()).toEqual(before);
    must(core.dispatch(command, { ...auth, capabilities: ['tasks:recall'], taskIds: ['orbit'] }));
    expect(core.dispatch(home('already-home'), auth)).toMatchObject({ ok: false, error: { code: 'STALE_EPOCH' } });
  });

  it('deduplicates Home across restart without repeating navigation or invalidating newly active work', () => {
    const command = home(), first = must(core.dispatch(command, auth));
    const after = task();
    expect(must(core.dispatch(command, auth))).toMatchObject({ idempotent: true, operation: first.operation });
    expect(task()).toEqual(after);
    core.close(); core = new CoreStore({ dbPath });
    expect(core.snapshot().activeTaskId).toBeNull();
    must(core.dispatch({ type: 'RecallTask', requestId: 'other-task', taskId: 'photo-walk' }, auth));
    const other = task('photo-walk');
    const retry = must(core.dispatch(command, auth));
    expect(retry.idempotent).toBe(true);
    expect(retry.snapshot.activeTaskId).toBe('photo-walk');
    expect(task('photo-walk')).toEqual(other);
    expect(core.snapshot().recentActions.filter(action => action.type === 'ShowHome')).toHaveLength(1);
    expect(core.dispatch(command, { ...auth, actorId: 'other-actor' })).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(core.dispatch({ ...command, expectedEpoch: task().epoch }, auth)).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('invalidates the previous active context on cold app startup without touching saved state or inventing navigation history', () => {
    must(core.dispatch({ type: 'UpdateNote', requestId: 'saved-before-restart', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: 'A saved note and retained project.' }, auth));
    const before = core.snapshot(), captured = task();
    must(core.beginJob({ id: 'before-restart', taskId: 'orbit', taskEpoch: captured.epoch, generation: 1, provider: 'local' }, auth));
    core.close(); core = new CoreStore({ dbPath, startAtHome: true });
    const atHome = core.snapshot();
    expect(atHome.activeTaskId).toBeNull();
    expect(atHome.tasks).toEqual(before.tasks.map(task => task.id === 'orbit' ? { ...task, epoch: task.epoch + 1 } : task));
    expect(atHome.recentActions).toEqual(before.recentActions);
    expect(core.isJobCurrent('before-restart', 1)).toBe(false);
    expect(core.dispatch({ type: 'UpdateNote', requestId: 'late-after-restart', taskId: 'orbit', expectedEpoch: captured.epoch, expectedRevision: captured.note.revision, body: 'Old reply' }, auth)).toMatchObject({ ok: false, error: { code: 'STALE_EPOCH' } });
    core.close(); core = new CoreStore({ dbPath, startAtHome: true });
    expect(core.snapshot()).toEqual(atHome);
  });

  it('rolls back navigation, epoch and job cancellation when operation persistence fails, then safely retries', () => {
    const database = (core as unknown as { db: Database.Database }).db;
    must(core.beginJob({ id: 'running', taskId: 'orbit', taskEpoch: task().epoch, generation: 1, provider: 'local' }, auth));
    const before = core.snapshot(), command = home();
    database.exec("CREATE TEMP TRIGGER fail_home BEFORE INSERT ON operations WHEN NEW.type='ShowHome' BEGIN SELECT RAISE(ABORT, 'injected history write failure'); END");
    expect(core.dispatch(command, auth)).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(core.snapshot()).toEqual(before);
    expect(core.isJobCurrent('running', 1)).toBe(true);
    expect(database.prepare('SELECT request_id FROM requests WHERE request_id=?').get(command.requestId)).toBeUndefined();
    database.exec('DROP TRIGGER fail_home');
    expect(must(core.dispatch(command, auth)).idempotent).toBe(false);
    expect(task().epoch).toBe(before.tasks.find(task => task.id === 'orbit')!.epoch + 1);
    expect(core.isJobCurrent('running', 1)).toBe(false);
  });

  it('refuses a failed cold Home transition without partially clearing the active task or cancelling its job', () => {
    must(core.beginJob({ id: 'running-at-crash', taskId: 'orbit', taskEpoch: task().epoch, generation: 1, provider: 'local' }, auth));
    const captured = task(); core.close();
    const inject = new Database(dbPath);
    inject.exec("CREATE TRIGGER fail_start_home BEFORE DELETE ON meta WHEN OLD.key='activeTaskId' BEGIN SELECT RAISE(ABORT, 'injected startup write failure'); END");
    inject.close();
    expect(() => new CoreStore({ dbPath, startAtHome: true })).toThrow('injected startup write failure');
    const inspect = new Database(dbPath);
    try {
      expect(inspect.prepare("SELECT value FROM meta WHERE key='activeTaskId'").get()).toEqual({ value: 'orbit' });
      expect(inspect.prepare("SELECT epoch FROM tasks WHERE id='orbit'").get()).toEqual({ epoch: captured.epoch });
      expect(inspect.prepare("SELECT status FROM jobs WHERE id='running-at-crash'").get()).toEqual({ status: 'running' });
      inspect.exec('DROP TRIGGER fail_start_home');
    } finally { inspect.close(); }
    core = new CoreStore({ dbPath, startAtHome: true });
    expect(core.snapshot().activeTaskId).toBeNull();
    expect(task()).toEqual({ ...captured, epoch: captured.epoch + 1 });
  });

  it('preserves Home, exact navigation receipts and working undo through real online backup and offline relocation', async () => {
    const edit = must(core.dispatch({ type: 'UpdateNote', requestId: 'saved-note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: 'Preserved through Home and restore.' }, auth));
    const command = home(), navigation = must(core.dispatch(command, auth));
    const stage = path.join(directory, 'staged'), destination = path.join(directory, 'restored');
    mkdirSync(stage, { mode: 0o700 });
    await core.backupDatabase(path.join(stage, 'eve.db'));
    const snapshot = new Database(path.join(stage, 'eve.db'), { readonly: true });
    expect(snapshot.prepare("SELECT value FROM meta WHERE key='activeTaskId'").get()).toBeUndefined();
    const history = snapshot.prepare('SELECT * FROM operations').all(), requests = snapshot.prepare('SELECT * FROM requests').all(); snapshot.close();
    const bytes = readFileSync(path.join(stage, 'eve.db'));
    const receipt = await CoreStore.relocateDatabase({ stagingProfile: stage, destinationProfile: destination, originalProfileRoot: profile, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], includedDirectories: ['projects', 'projects/orbit'] });
    expect(receipt.schemaVersion).toBe(6);
    const relocated = new Database(path.join(stage, 'eve.db'), { readonly: true });
    expect(relocated.prepare('SELECT * FROM operations').all()).toEqual(history);
    expect(relocated.prepare('SELECT * FROM requests').all()).toEqual(requests); relocated.close();
    core.close(); core = new CoreStore({ dbPath: path.join(stage, 'eve.db'), startAtHome: true });
    expect(core.snapshot().activeTaskId).toBeNull();
    expect(task().projectPath).toBe(path.join(destination, 'projects/orbit'));
    expect(must(core.dispatch(command, auth))).toMatchObject({ idempotent: true, operation: navigation.operation, snapshot: { activeTaskId: null } });
    expect(task().note.body).toBe('Preserved through Home and restore.');
    must(core.dispatch({ type: 'RecallTask', requestId: 'restore-return', taskId: 'orbit' }, auth));
    must(core.dispatch({ type: 'Undo', requestId: 'restore-undo', taskId: 'orbit', expectedEpoch: task().epoch, operationId: edit.operation.id }, auth));
    expect(task().note.revision).toBe(2);
  });
});
