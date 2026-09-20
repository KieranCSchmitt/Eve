import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CoreStore } from '../../packages/core/src/index.js';
import { ALL_CAPABILITIES, type AuthenticatedContext, type CoreCommandInput, type ProjectEditRecord, type ProjectEditReceipt } from '../../packages/contracts/src/index.js';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let directory: string, projectPath: string, configPath: string, dbPath: string, core: CoreStore;
let sequence = 0;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
const command = (value = 450): CoreCommandInput => ({ type: 'SetParameter', requestId: `request-${++sequence}`, taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().parameters!.revision, name: 'transitionMs', value });
function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Extract<T, { ok: true }>;
}
function prepared(input: CoreCommandInput): ProjectEditRecord {
  const flight = must(core.preflight(input, auth));
  expect(flight.projectEdit).toBeDefined();
  const beforeText = readFileSync(configPath, 'utf8');
  const afterText = JSON.stringify({ ...JSON.parse(beforeText), ...flight.projectEdit!.after }, null, 2) + '\n';
  const prepared = must(core.prepareProjectEdit(input, auth, { relativePath: 'eve.project.json', location: 'file', beforeText, afterText, beforeHash: hash(beforeText), afterHash: hash(afterText) }));
  expect(prepared.resumed).toBe(false);
  return prepared.edit!;
}
function writeExternal(edit: ProjectEditRecord): ProjectEditReceipt {
  expect(hash(readFileSync(configPath, 'utf8'))).toBe(edit.beforeHash);
  writeFileSync(configPath, edit.afterText);
  return { operationId: edit.id, location: 'file', file: configPath, beforeHash: edit.beforeHash, afterHash: edit.afterHash, beforeText: edit.beforeText, afterText: edit.afterText };
}
function finish(edit: ProjectEditRecord) {
  must(core.recordProjectEditReceipt(edit.id, writeExternal(edit), auth));
  return must(core.finalizeProjectEdit(edit.id, auth));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eve-journal-'));
  projectPath = join(directory, 'orbit');
  mkdirSync(projectPath);
  configPath = join(projectPath, 'eve.project.json');
  dbPath = join(directory, 'core.sqlite');
  core = new CoreStore({ dbPath, orbitProjectPath: projectPath });
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, adapter: 'eve.orbit', name: 'Orbit', ...task().parameters!.values }, null, 2) + '\n');
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });

describe('durable project coordination', () => {
  it('preflights without mutation and blocks database-only changes of file-backed parameters', () => {
    const before = core.snapshot();
    const input = command();
    expect(must(core.preflight(input, auth)).projectEdit!.after.transitionMs).toBe(450);
    expect(core.snapshot()).toEqual(before);
    expect(core.listPendingProjectEdits()).toEqual([]);
    const denied = core.dispatch(input, auth);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('EXTERNAL_EDIT_REQUIRED');
    expect(core.snapshot()).toEqual(before);
    expect(core.preflight({ ...input, value: 'bad-color' }, auth).ok).toBe(false);
    expect(core.preflight(input, { ...auth, origin: 'model' }).ok).toBe(false);
  });

  it('requires exact prepared hashes/text, a matching receipt, and one durable reservation', () => {
    const input = command();
    const edit = prepared(input);
    expect(task().parameters!.values.transitionMs).not.toBe(450);
    expect(core.finalizeProjectEdit(edit.id, auth).ok).toBe(false);
    const other = core.preflight(command(600), auth);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe('EDIT_PENDING');
    const resumed = must(core.prepareProjectEdit(input, auth, edit));
    expect(resumed.resumed).toBe(true);
    expect(resumed.edit!.id).toBe(edit.id);
    const receipt = writeExternal(edit);
    expect(core.recordProjectEditReceipt(edit.id, { ...receipt, afterHash: '0'.repeat(64) }, auth).ok).toBe(false);
    must(core.recordProjectEditReceipt(edit.id, receipt, auth));
    must(core.finalizeProjectEdit(edit.id, auth));
    expect(task().parameters!.values.transitionMs).toBe(450);
    expect(core.listPendingProjectEdits()).toEqual([]);
    expect(must(core.preflight(input, auth)).duplicate!.idempotent).toBe(true);
    expect(must(core.prepareProjectEdit(input, auth, edit)).edit).toBeNull();
    expect(must(core.finalizeProjectEdit(edit.id, auth)).idempotent).toBe(true);
    expect(task().parameters!.revision).toBe(1);
  });

  it('recovers a file write that happened before its receipt or database commit, even after task epochs change', () => {
    const input = command();
    const edit = prepared(input);
    writeExternal(edit);
    must(core.dispatch({ type: 'RecallTask', requestId: 'go-elsewhere', taskId: 'photo-walk' }, auth));
    core.close();
    core = new CoreStore({ dbPath });
    expect(task().parameters!.values.transitionMs).not.toBe(450);
    expect(core.listPendingProjectEdits()[0]!.id).toBe(edit.id);
    const observation = { location: 'file' as const, observedHash: hash(readFileSync(configPath, 'utf8')) };
    expect(must(core.reconcileProjectEdit(edit.id, observation, auth)).action).toBe('finalize');
    must(core.finalizeProjectEdit(edit.id, auth));
    expect(task().parameters!.values.transitionMs).toBe(450);
    expect(core.snapshot().activeTaskId).toBe('photo-walk');
    expect(must(core.preflight(input, auth)).duplicate).toBeDefined();
  });

  it('does not overwrite or finalize when an unrelated external edit is observed during recovery', () => {
    const edit = prepared(command());
    writeFileSync(configPath, edit.beforeText.replace('"Orbit"', '"A newer title"'));
    const current = readFileSync(configPath, 'utf8');
    const result = must(core.reconcileProjectEdit(edit.id, { location: 'file', observedHash: hash(current) }, auth));
    expect(result.action).toBe('conflict');
    expect(core.finalizeProjectEdit(edit.id, auth).ok).toBe(false);
    expect(core.abortProjectEdit(edit.id, { location: 'file', observedHash: hash(current) }, auth).ok).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(current);
    expect(task().parameters!.revision).toBe(0);
  });

  it('can abort only after verifying the original content and rejects reusing the aborted request', () => {
    const input = command();
    const edit = prepared(input);
    expect(must(core.reconcileProjectEdit(edit.id, { location: 'file', observedHash: edit.beforeHash }, auth)).action).toBe('retry');
    must(core.abortProjectEdit(edit.id, { location: 'file', observedHash: edit.beforeHash }, auth));
    expect(core.listPendingProjectEdits()).toEqual([]);
    expect(core.prepareProjectEdit(input, auth, edit).ok).toBe(false);
    expect(core.snapshot().recentActions).toEqual([]);
  });

  it('routes undo through another journal entry and restores both the file and core with one operation', () => {
    const initial = readFileSync(configPath, 'utf8');
    const edit = prepared(command());
    const original = finish(edit);
    const undo: CoreCommandInput = { type: 'Undo', requestId: 'undo-file', taskId: 'orbit', expectedEpoch: task().epoch, operationId: original.operation.id };
    expect(core.dispatch(undo, auth).ok).toBe(false);
    const reverse = prepared(undo);
    expect(reverse.plan.undoOf).toBe(original.operation.id);
    finish(reverse);
    expect(readFileSync(configPath, 'utf8')).toBe(initial);
    expect(task().parameters!.values.transitionMs).toBe(280);
    expect(task().parameters!.revision).toBe(2);
    expect(core.snapshot().recentActions.find(op => op.id === original.operation.id)!.undone).toBe(true);
  });

  it('requires explicit observation of external parameter changes and refuses it while an edit is pending', () => {
    const initial = task().parameters!;
    must(core.observeProjectParameters('orbit', { ...initial.values, theme: '#123456' }, auth));
    expect(task().parameters!.revision).toBe(1);
    const next = { ...JSON.parse(readFileSync(configPath, 'utf8')), ...task().parameters!.values };
    writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
    prepared(command());
    expect(core.observeProjectParameters('orbit', { ...initial.values }, auth).ok).toBe(false);
  });

  it('rejects prepared text that smuggles in an unrelated file change', () => {
    const input = command();
    const beforeText = readFileSync(configPath, 'utf8');
    const afterText = JSON.stringify({ ...JSON.parse(beforeText), transitionMs: 450, name: 'Silently renamed' });
    const result = core.prepareProjectEdit(input, auth, { relativePath: 'eve.project.json', beforeHash: hash(beforeText), afterHash: hash(afterText), beforeText, afterText });
    expect(result.ok).toBe(false);
    expect(core.listPendingProjectEdits()).toEqual([]);
  });

  it('persists policies and provenance while cancelling old-process jobs on restart', () => {
    const before = task();
    must(core.dispatch({ type: 'SetTaskPolicy', requestId: 'private-policy', taskId: 'orbit', expectedEpoch: before.epoch, expectedRevision: 0, policy: { processing: 'local-only', assistancePaused: false } }, auth));
    must(core.registerAsset({ id: 'original', taskId: 'orbit', originalPath: '/chosen/image.png', managedPath: '/profile/assets/image.png', sha256: 'a'.repeat(64), byteLength: 400, mediaType: 'image/png', title: 'Original photo', provenance: { kind: 'user-import', attribution: 'Me', rights: 'Original work' } }, auth));
    must(core.registerSource({ id: 'reference', taskId: 'orbit', assetId: 'original', title: 'Photo notes', excerpt: 'A quiet afternoon.', retrievedAt: 100, provenance: { kind: 'timestamped-notes', attribution: 'Me', rights: 'Original work' } }, auth));
    must(core.beginJob({ id: 'job-before-crash', taskId: 'orbit', taskEpoch: before.epoch, generation: 0, provider: 'local' }, auth));
    core.close();
    core = new CoreStore({ dbPath });
    expect(task().policy.processing).toBe('local-only');
    expect(core.listAssets('orbit')[0]!.sha256).toBe('a'.repeat(64));
    expect(core.listSources('orbit')[0]!.provenance.kind).toBe('timestamped-notes');
    expect(core.isJobCurrent('job-before-crash', 0)).toBe(false);
  });

  it('persists the observed buffer version and refuses a disk before-state as evidence for abort', () => {
    const input = command();
    const flight = must(core.preflight(input, auth));
    const beforeText = readFileSync(configPath, 'utf8');
    const afterText = JSON.stringify({ ...JSON.parse(beforeText), ...flight.projectEdit!.after }, null, 2) + '\n';
    const spec = { relativePath: 'eve.project.json' as const, location: 'buffer' as const, beforeText, afterText, beforeHash: hash(beforeText), afterHash: hash(afterText) };
    expect(core.prepareProjectEdit(input, auth, spec).ok).toBe(false);
    const edit = must(core.prepareProjectEdit(input, auth, { ...spec, documentVersion: 12 })).edit!;
    core.close();
    core = new CoreStore({ dbPath });
    expect(core.listPendingProjectEdits()[0]).toMatchObject({ id: edit.id, location: 'buffer', documentVersion: 12 });
    const disk = { location: 'file' as const, observedHash: edit.beforeHash };
    const reconcile = core.reconcileProjectEdit(edit.id, disk, auth);
    expect(reconcile.ok).toBe(false);
    if (!reconcile.ok) expect(reconcile.error.code).toBe('EDITOR_RECOVERY_REQUIRED');
    const abort = core.abortProjectEdit(edit.id, disk, auth);
    expect(abort.ok).toBe(false);
    if (!abort.ok) expect(abort.error.code).toBe('EDITOR_RECOVERY_REQUIRED');
    expect(core.listPendingProjectEdits()[0]!.status).toBe('prepared');
    const restored = { location: 'buffer' as const, observedHash: edit.beforeHash, documentVersion: 12 };
    expect(must(core.reconcileProjectEdit(edit.id, restored, auth)).action).toBe('retry');
    must(core.abortProjectEdit(edit.id, restored, auth));
  });

  it('normalizes legacy preparation origin to unknown without rewriting or discarding its evidence', () => {
    const edit = prepared(command());
    core.close();
    const db = new Database(dbPath);
    const row = db.prepare('SELECT preparation_json FROM project_edits WHERE id=?').get(edit.id) as { preparation_json: string };
    const legacy = JSON.parse(row.preparation_json) as Record<string, unknown>;
    delete legacy.location;
    const legacyText = JSON.stringify(legacy);
    db.prepare('UPDATE project_edits SET preparation_json=? WHERE id=?').run(legacyText, edit.id);
    db.close();
    core = new CoreStore({ dbPath });
    expect(core.listPendingProjectEdits()[0]).toMatchObject({ id: edit.id, location: 'unknown', beforeHash: edit.beforeHash, afterHash: edit.afterHash, beforeText: edit.beforeText, afterText: edit.afterText });
    const result = core.reconcileProjectEdit(edit.id, { location: 'file', observedHash: edit.beforeHash }, auth);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EDITOR_RECOVERY_REQUIRED');
    core.close();
    const verify = new Database(dbPath);
    expect((verify.prepare('SELECT preparation_json FROM project_edits WHERE id=?').get(edit.id) as { preparation_json: string }).preparation_json).toBe(legacyText);
    verify.close();
    core = new CoreStore({ dbPath });
  });
});
