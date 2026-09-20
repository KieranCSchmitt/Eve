import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreStore } from '../../packages/core/src/index';
import { workspaceJson } from '../../packages/core/src/workspace-edits';
import { ALL_CAPABILITIES, prepareWorkspaceEditSchema, type AuthenticatedContext, type PrepareWorkspaceEditInput, type WorkspaceEditRecord, type WorkspaceEditReceipt } from '../../packages/contracts/src/index';
const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const must = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => { expect(result.ok, JSON.stringify(result)).toBe(true); return result as Extract<T, { ok: true }>; };
const rejects = (result: { ok: boolean; error?: { code: string } }, code: string) => { expect(result.ok).toBe(false); expect(result.error?.code).toBe(code); };
let directory: string, profile: string, dbPath: string, core: CoreStore;
const task = () => core.snapshot().tasks.find(task => task.id === 'orbit')!;
const document = (relativePath = 'app.ts', beforeText = 'const answer = 1;\n', afterText = 'const answer = 2;\n', version = 4) => ({ relativePath, beforeText, afterText, beforeHash: sha(beforeText), afterHash: sha(afterText), expectedDocumentVersion: version });
const input = (extra: Partial<PrepareWorkspaceEditInput> = {}): PrepareWorkspaceEditInput => ({ requestId: 'workspace-one', taskId: 'orbit', expectedEpoch: task().epoch, expectedTaskRevision: task().revision,
  projectId: task().project!.id, expectedProjectRevision: task().project!.revision, expectedRootIdentity: task().project!.rootIdentity!, expectedPolicyRevision: task().policy.revision,
  serviceInstanceId: 'editor-instance', serviceGeneration: 3, review: { intentRequestId: 'intent', proposalId: 'proposal', contextSnapshotId: 'snapshot', contextHash: sha('actual selection/source evidence'), selection: { artifactId: 'selected-code', revision: 4 } },
  label: 'Update selected code', documents: [document()], ...extra });
const binding = (edit: WorkspaceEditRecord) => ({ planHash: edit.planHash, serviceInstanceId: edit.input.serviceInstanceId, serviceGeneration: edit.input.serviceGeneration });
const receipt = (edit: WorkspaceEditRecord): WorkspaceEditReceipt => ({ ...binding(edit), operationId: edit.id, documents: edit.input.documents.map(document => ({ relativePath: document.relativePath, afterHash: document.afterHash, documentVersion: document.expectedDocumentVersion + 1 })), recovery: { kind: 'acknowledged-orphan-v1' } });
const observe = (edit: WorkspaceEditRecord, after = false) => ({ kind: 'live-editor' as const, serviceInstanceId: edit.input.serviceInstanceId, serviceGeneration: edit.input.serviceGeneration, documents: edit.input.documents.map(document => ({ relativePath: document.relativePath, hash: after ? document.afterHash : document.beforeHash, documentVersion: document.expectedDocumentVersion + (after ? 1 : 0) })) });
function complete(edit: WorkspaceEditRecord) { must(core.markWorkspaceEditDispatched(edit.id, binding(edit), auth)); must(core.recordWorkspaceEditReceipt(edit.id, receipt(edit), auth)); return must(core.finalizeWorkspaceEdit(edit.id, auth)).edit; }
beforeEach(() => {
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'eve-workspace-core-')); profile = path.join(directory, 'profile'); mkdirSync(profile, { mode: 0o700 }); dbPath = path.join(profile, 'eve.db');
  core = new CoreStore({ dbPath, orbitProjectPath: path.join(profile, 'workspaces/orbit') });
  const before = task(); must(core.verifyProject({ requestId: 'verify', taskId: before.id, expectedEpoch: before.epoch, expectedTaskRevision: before.revision, projectId: before.project!.id, expectedProjectRevision: before.project!.revision, rootIdentity: { device: '17', inode: '123' }, kind: 'managed', adapter: 'orbit', preview: { kind: 'none' } }, auth));
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });

it('bounds exact text, UTF-8 bytes, file identities and authority before reserving any journal', () => {
  for (const relativePath of ['../app.ts', '/app.ts', 'a\\b.ts', 'a/./b', 'https:foo', 'a\n.ts']) expect(prepareWorkspaceEditSchema.safeParse(input({ documents: [document(relativePath)] })).success).toBe(false);
  expect(prepareWorkspaceEditSchema.safeParse(input({ documents: [document(), document()] })).success).toBe(false);
  expect(prepareWorkspaceEditSchema.safeParse(input({ expectedRootIdentity: { device: 'not-a-device', inode: '1' } })).success).toBe(false);
  expect(sha('\ud800')).toBe(sha('\ud801'));
  for (const malformed of ['\ud800', '\udc00', 'x\ud83cy', 'x\udfa8']) {
    rejects(core.prepareWorkspaceEdit(input({ documents: [document('app.ts', malformed, 'valid')] }), auth), 'INVALID_COMMAND');
    rejects(core.prepareWorkspaceEdit(input({ documents: [document('app.ts', 'valid', malformed)] }), auth), 'INVALID_COMMAND');
  }
  expect(prepareWorkspaceEditSchema.safeParse(input({ documents: [document('app.ts', 'const paint = "🎨";', 'const paint = "🖌️";')] })).success).toBe(true);
  expect(prepareWorkspaceEditSchema.safeParse(input({ documents: [document('utf8.ts', 'é'.repeat(600_000), 'short')] })).success).toBe(false);
  expect(prepareWorkspaceEditSchema.safeParse(input({ documents: Array.from({ length: 5 }, (_, index) => document(`${index}.ts`, 'a'.repeat(1024 * 1024), 'b')) })).success).toBe(false);
  for (const context of [{ ...auth, origin: 'model' as const }, { ...auth, origin: 'workbench' as const }, { ...auth, capabilities: [] }, { ...auth, taskIds: ['photo-walk'] }]) rejects(core.prepareWorkspaceEdit(input(), context), 'UNAUTHORIZED');
  rejects(core.prepareWorkspaceEdit(input({ documents: [{ ...document(), afterHash: sha('wrong') }] }), auth), 'INVALID_COMMAND');
  rejects(core.prepareWorkspaceEdit(input({ documents: [document('eve.project.json')] }), auth), 'INVALID_COMMAND');
  expect(must(core.listPendingWorkspaceEdits(auth)).value).toEqual([]);
});

it('persists the entire preparation, binds exact retries to actor/input, and grants native dispatch only once', () => {
  const preparedInput = input({ documents: [document(), document('theme.css', 'a{}', 'a{color:red}')] });
  expect(must(core.lookupWorkspaceEdit(preparedInput, auth)).value).toBeNull();
  const prepared = must(core.prepareWorkspaceEdit(preparedInput, auth)); expect(prepared.resumed).toBe(false);
  core.close(); core = new CoreStore({ dbPath });
  expect(must(core.lookupWorkspaceEdit(preparedInput, auth)).value!.edit).toEqual(prepared.edit);
  expect(must(core.prepareWorkspaceEdit(preparedInput, auth)).resumed).toBe(true);
  rejects(core.lookupWorkspaceEdit({ ...preparedInput, label: 'Different review' }, auth), 'IDEMPOTENCY_CONFLICT');
  rejects(core.lookupWorkspaceEdit(preparedInput, { ...auth, actorId: 'other-user' }), 'IDEMPOTENCY_CONFLICT');
  expect(must(core.markWorkspaceEditDispatched(prepared.edit.id, binding(prepared.edit), auth)).dispatched).toBe(true);
  expect(must(core.markWorkspaceEditDispatched(prepared.edit.id, binding(prepared.edit), auth)).dispatched).toBe(false);
  rejects(core.finalizeWorkspaceEdit(prepared.edit.id, auth), 'EDIT_CONFLICT');
  rejects(core.recordWorkspaceEditReceipt(prepared.edit.id, { ...receipt(prepared.edit), documents: receipt(prepared.edit).documents.slice(0, 1) }, auth), 'INVALID_RECEIPT');
  rejects(core.recordWorkspaceEditReceipt(prepared.edit.id, { ...receipt(prepared.edit), serviceGeneration: 4 }, auth), 'INVALID_RECEIPT');
  must(core.recordWorkspaceEditReceipt(prepared.edit.id, receipt(prepared.edit), auth));
  must(core.dispatch({ type: 'RecallTask', requestId: 'navigate-away', taskId: 'photo-walk' }, auth));
  const finalized = must(core.finalizeWorkspaceEdit(prepared.edit.id, auth)).edit;
  expect(finalized.operation).toMatchObject({ type: 'ApplyWorkspaceEdit', undoable: false });
  expect(core.snapshot().activeTaskId).toBe('photo-walk');
  expect(must(core.finalizeWorkspaceEdit(prepared.edit.id, auth)).edit.operation).toEqual(finalized.operation);
  expect(core.snapshot().recentActions.filter(operation => operation.requestId === preparedInput.requestId)).toHaveLength(1);
});

it('keeps dispatched/lost-reply outcomes pending across restart even when disk or live bytes match', () => {
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  must(core.markWorkspaceEditDispatched(edit.id, binding(edit), auth)); core.close(); core = new CoreStore({ dbPath });
  expect(must(core.reconcileWorkspaceEdit(edit.id, observe(edit, true), auth)).action).toBe('review');
  expect(must(core.reconcileWorkspaceEdit(edit.id, observe(edit), auth)).action).toBe('review');
  rejects(core.abortWorkspaceEdit(edit.id, observe(edit), auth), 'EDITOR_RECOVERY_REQUIRED');
  rejects(core.reconcileWorkspaceEdit(edit.id, { kind: 'disk', hash: edit.input.documents[0]!.beforeHash } as never, auth), 'INVALID_RECEIPT');
  expect(must(core.markWorkspaceEditDispatched(edit.id, binding(edit), auth)).dispatched).toBe(false);
  rejects(core.prepareWorkspaceEdit(input({ requestId: 'another' }), auth), 'EDIT_PENDING');
});

it('aborts only undispatched preparations with exact original live version and editor generation', () => {
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  rejects(core.abortWorkspaceEdit(edit.id, { ...observe(edit), serviceGeneration: 4 }, auth), 'EDITOR_RECOVERY_REQUIRED');
  rejects(core.abortWorkspaceEdit(edit.id, { ...observe(edit), documents: observe(edit).documents.map(document => ({ ...document, documentVersion: document.documentVersion + 1 })) }, auth), 'EDITOR_RECOVERY_REQUIRED');
  expect(must(core.abortWorkspaceEdit(edit.id, observe(edit), auth)).edit.status).toBe('aborted');
  expect(must(core.prepareWorkspaceEdit(input(), auth)).edit.status).toBe('aborted');
  rejects(core.markWorkspaceEditDispatched(edit.id, binding(edit), auth), 'EDIT_CONFLICT');
});

it('reads only owned journal evidence and cancels an exact undispatched reservation without treating newer user text as authority', () => {
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  expect(must(core.readWorkspaceEdit(edit.id, auth)).edit).toEqual(edit);
  rejects(core.readWorkspaceEdit(edit.id, { ...auth, actorId: 'other-user' }), 'UNAUTHORIZED');
  rejects(core.cancelPreparedWorkspaceEdit(edit.id, binding(edit), { ...auth, actorId: 'other-user' }), 'UNAUTHORIZED');
  for (const changed of [{ planHash: sha('another plan') }, { serviceInstanceId: 'other-editor' }, { serviceGeneration: 99 }]) rejects(core.cancelPreparedWorkspaceEdit(edit.id, { ...binding(edit), ...changed }, auth), 'INVALID_RECEIPT');
  // User typing can invalidate observation-based reconciliation; it does not
  // change the authoritative fact that no native dispatch was ever granted.
  const newer = { ...observe(edit), documents: observe(edit).documents.map(document => ({ ...document, documentVersion: document.documentVersion + 1, hash: sha('new user text') })) };
  rejects(core.abortWorkspaceEdit(edit.id, newer, auth), 'EDITOR_RECOVERY_REQUIRED');
  must(core.dispatch({ type: 'RecallTask', requestId: 'leave-before-dispatch', taskId: 'photo-walk' }, auth));
  const cancelled = must(core.cancelPreparedWorkspaceEdit(edit.id, binding(edit), auth)).edit;
  expect(cancelled.status).toBe('aborted'); expect(cancelled.receipt).toBeNull(); expect(cancelled.operation).toBeNull();
  expect(must(core.cancelPreparedWorkspaceEdit(edit.id, binding(edit), auth)).edit).toEqual(cancelled);
  expect(must(core.listPendingWorkspaceEdits(auth)).value).toEqual([]);
  expect(core.snapshot().activeTaskId).toBe('photo-walk');
});

it('recovers a lost preparation receipt through an owned read-only request identity without granting dispatch', () => {
  expect(must(core.readWorkspaceEditRequest('unknown-request', auth)).value).toBeNull();
  rejects(core.readWorkspaceEditRequest('unknown-request', { ...auth, capabilities: [] }), 'UNAUTHORIZED');
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  core.close(); core = new CoreStore({ dbPath });
  expect(must(core.readWorkspaceEditRequest(edit.requestId, auth)).value).toEqual(edit);
  rejects(core.readWorkspaceEditRequest(edit.requestId, { ...auth, actorId: 'other-user' }), 'UNAUTHORIZED');
  rejects(core.readWorkspaceEditRequest(edit.requestId, { ...auth, taskIds: ['photo-walk'] }), 'UNAUTHORIZED');
  expect(must(core.readWorkspaceEdit(edit.id, auth)).edit.status).toBe('prepared');
  expect(core.snapshot().recentActions.some(action => action.requestId === edit.requestId)).toBe(false);
});

it.each(['cancel-first', 'dispatch-first'] as const)('admits exactly one side of the prepared cancellation/native dispatch race: %s', async order => {
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  const cancel = () => core.cancelPreparedWorkspaceEdit(edit.id, binding(edit), auth);
  const dispatch = () => core.markWorkspaceEditDispatched(edit.id, binding(edit), auth);
  const attempts = order === 'cancel-first' ? [cancel, dispatch] : [dispatch, cancel];
  const results = await Promise.all(attempts.map(attempt => Promise.resolve().then(attempt)));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  rejects(results[1]!, 'EDIT_CONFLICT');
  expect(must(core.readWorkspaceEdit(edit.id, auth)).edit.status).toBe(order === 'cancel-first' ? 'aborted' : 'dispatched');
  if (order === 'dispatch-first') {
    expect(must(results[0]!) as { dispatched?: boolean }).toMatchObject({ dispatched: true });
    must(core.recordWorkspaceEditReceipt(edit.id, receipt(edit), auth));
    rejects(cancel(), 'EDIT_CONFLICT');
    must(core.finalizeWorkspaceEdit(edit.id, auth)); rejects(cancel(), 'EDIT_CONFLICT');
  }
});

it('arbitrates Orbit/workspace writes in both directions without blocking notes and reserves global request IDs', () => {
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  const parameter = { type: 'SetParameter' as const, requestId: 'orbit-parameter', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().parameters!.revision, name: 'transitionMs' as const, value: 500 };
  rejects(core.preflight(parameter, auth), 'EDIT_PENDING');
  const note = { type: 'UpdateNote' as const, requestId: 'independent-note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().note.revision, body: 'Independent note' };
  must(core.dispatch(note, auth)); rejects(core.dispatch({ ...note, requestId: edit.requestId }, auth), 'IDEMPOTENCY_CONFLICT');
  rejects(core.prepareWorkspaceEdit(input({ requestId: note.requestId }), auth), 'IDEMPOTENCY_CONFLICT');
  rejects(core.prepareWorkspaceEdit(input({ requestId: 'verify' }), auth), 'IDEMPOTENCY_CONFLICT');
  must(core.abortWorkspaceEdit(edit.id, observe(edit), auth));
  const beforeText = JSON.stringify(task().parameters!.values), afterText = JSON.stringify({ ...task().parameters!.values, transitionMs: 500 });
  must(core.prepareProjectEdit(parameter, auth, { relativePath: 'eve.project.json', beforeText, afterText, beforeHash: sha(beforeText), afterHash: sha(afterText), location: 'buffer', documentVersion: 1 }));
  rejects(core.prepareWorkspaceEdit(input({ requestId: 'workspace-two' }), auth), 'EDIT_PENDING');
  rejects(core.prepareWorkspaceEdit(input({ requestId: parameter.requestId }), auth), 'IDEMPOTENCY_CONFLICT');
});

it('rechecks task and policy revisions before dispatch, and journals explicit inverse evidence without exposing legacy Undo', () => {
  const stale = must(core.prepareWorkspaceEdit(input(), auth)).edit;
  must(core.dispatch({ type: 'SetTaskPolicy', requestId: 'policy', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().policy.revision, policy: { processing: 'local-only', assistancePaused: false } }, auth));
  rejects(core.markWorkspaceEditDispatched(stale.id, binding(stale), auth), 'REVISION_CONFLICT');
  must(core.abortWorkspaceEdit(stale.id, observe(stale), auth));
  const first = complete(must(core.prepareWorkspaceEdit(input({ requestId: 'current' }), auth)).edit);
  rejects(core.dispatch({ type: 'Undo', requestId: 'unsafe-legacy-undo', taskId: 'orbit', expectedEpoch: task().epoch, operationId: first.operation!.id }, auth), 'NOT_UNDOABLE');
  const source = first.input.documents[0]!;
  const inverse = complete(must(core.prepareWorkspaceEdit(input({ requestId: 'inverse', undoOf: first.id, documents: [document(source.relativePath, source.afterText, source.beforeText, 6)] }), auth)).edit);
  expect(inverse.operation).toMatchObject({ type: 'UndoWorkspaceEdit', undoable: false });
  expect(core.snapshot().recentActions.find(operation => operation.id === first.operation!.id)?.undone).toBe(true);
});

it('takes a verified standalone v4 rollback before the v5 migration and preserves exact older history', () => {
  const before = core.snapshot(); core.close();
  const old = new Database(dbPath); old.exec('DROP TABLE canvases; DROP TABLE workspace_edits; PRAGMA user_version=4;'); old.pragma('wal_checkpoint(TRUNCATE)'); old.pragma('journal_mode=DELETE');
  const history = old.prepare('SELECT * FROM project_requests').all(); old.close();
  core = new CoreStore({ dbPath }); expect(core.diagnostics().schemaVersion).toBe(6); expect(core.snapshot()).toEqual(before);
  const rollback = core.migrationRollback!; expect(rollback).toMatchObject({ fromVersion: 4, toVersion: 6, sha256: sha(readFileSync(rollback.path)) });
  const snapshot = new Database(rollback.path, { readonly: true }); expect(snapshot.pragma('user_version', { simple: true })).toBe(4); expect(snapshot.prepare('SELECT * FROM project_requests').all()).toEqual(history); snapshot.close();
});

it.each(['prepared', 'dispatched', 'receipt-recorded', 'finalized'] as const)('relocates exact v5 %s evidence without rewriting authored text, fingerprints or acquiring fresh execution authority', async phase => {
  const authored = `const example = ${JSON.stringify(profile)};\n`;
  const preparedInput = input({ documents: [document('app.ts', authored, authored + '// reviewed change\n')] });
  const edit = must(core.prepareWorkspaceEdit(preparedInput, auth)).edit;
  if (phase !== 'prepared') must(core.markWorkspaceEditDispatched(edit.id, binding(edit), auth));
  if (phase === 'receipt-recorded' || phase === 'finalized') must(core.recordWorkspaceEditReceipt(edit.id, receipt(edit), auth));
  if (phase === 'finalized') must(core.finalizeWorkspaceEdit(edit.id, auth));
  const stage = path.join(directory, 'stage'), destination = path.join(directory, 'restored'); mkdirSync(stage, { mode: 0o700 }); await core.backupDatabase(path.join(stage, 'eve.db'));
  const before = new Database(path.join(stage, 'eve.db')); const exact = before.prepare('SELECT input_json,fingerprint,plan_hash,receipt_json FROM workspace_edits').get(); before.close();
  const bytes = readFileSync(path.join(stage, 'eve.db'));
  const relocated = await CoreStore.relocateDatabase({ stagingProfile: stage, destinationProfile: destination, originalProfileRoot: profile, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: sha(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit'] });
  expect(relocated.schemaVersion).toBe(6);
  const inspected = new Database(path.join(stage, 'eve.db')); expect(inspected.prepare('SELECT input_json,fingerprint,plan_hash,receipt_json FROM workspace_edits').get()).toEqual(exact); inspected.close();
  const restored = new CoreStore({ dbPath: path.join(stage, 'eve.db') });
  try {
    const found = must(restored.lookupWorkspaceEdit(preparedInput, auth)).value!;
    expect(found.edit).toMatchObject({ restored: true, projectRoot: path.join(destination, 'workspaces/orbit'), input: preparedInput });
    expect(found.snapshot.tasks.find(task => task.id === 'orbit')!.project?.verification).toBe('legacy-unverified');
    if (phase === 'finalized') expect(must(restored.finalizeWorkspaceEdit(edit.id, auth)).edit.operation?.requestId).toBe(preparedInput.requestId);
    else { expect(must(restored.reconcileWorkspaceEdit(edit.id, observe(edit), auth)).action).toBe('review'); rejects(restored.finalizeWorkspaceEdit(edit.id, auth), 'EDITOR_RECOVERY_REQUIRED'); rejects(restored.cancelPreparedWorkspaceEdit(edit.id, binding(edit), auth), 'EDITOR_RECOVERY_REQUIRED'); }
  } finally { restored.close(); }
});

it('validates exact v4 staging without upgrading it, then makes its rollback on the normal v5 cold open', async () => {
  const stage = path.join(directory, 'stage'), destination = path.join(directory, 'restored'); mkdirSync(stage, { mode: 0o700 });
  await core.backupDatabase(path.join(stage, 'eve.db'));
  const historical = new Database(path.join(stage, 'eve.db')); historical.exec('DROP TABLE canvases; DROP TABLE workspace_edits; PRAGMA user_version=4;'); historical.close();
  const bytes = readFileSync(path.join(stage, 'eve.db'));
  expect((await CoreStore.relocateDatabase({ stagingProfile: stage, destinationProfile: destination, originalProfileRoot: profile, expectedSchemaVersion: 4, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: sha(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit'] })).schemaVersion).toBe(4);
  const stillOld = new Database(path.join(stage, 'eve.db'), { readonly: true }); expect(stillOld.pragma('user_version', { simple: true })).toBe(4); stillOld.close();
  const restored = new CoreStore({ dbPath: path.join(stage, 'eve.db') });
  try { expect(restored.diagnostics().schemaVersion).toBe(6); expect(restored.migrationRollback).toMatchObject({ fromVersion: 4, toVersion: 6 }); } finally { restored.close(); }
});

it.each([
  ['changed captured text', "UPDATE workspace_edits SET input_json=json_set(input_json,'$.documents[0].afterText','tampered')"],
  ['changed native generation', "UPDATE workspace_edits SET receipt_json=json_set(receipt_json,'$.serviceGeneration',99)"],
  ['unregistered root', "UPDATE workspace_edits SET project_root='/outside/project'"],
  ['invented completion', "UPDATE workspace_edits SET status='finalized'"],
  ['foreign schema object', 'CREATE TABLE unexpected_workspace_authority (value TEXT)'],
])('refuses offline v5 restore with %s and preserves staged source bytes', async (_name, mutation) => {
  const edit = must(core.prepareWorkspaceEdit(input(), auth)).edit; must(core.markWorkspaceEditDispatched(edit.id, binding(edit), auth)); must(core.recordWorkspaceEditReceipt(edit.id, receipt(edit), auth));
  const stage = path.join(directory, 'stage'); mkdirSync(stage, { mode: 0o700 }); await core.backupDatabase(path.join(stage, 'eve.db'));
  const changed = new Database(path.join(stage, 'eve.db')); changed.exec(mutation); changed.close();
  const bytes = readFileSync(path.join(stage, 'eve.db'));
  await expect(CoreStore.relocateDatabase({ stagingProfile: stage, destinationProfile: path.join(directory, 'restored'), originalProfileRoot: profile, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: sha(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit'] })).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_DATABASE|UNSUPPORTED_SCHEMA/) });
  expect(readFileSync(path.join(stage, 'eve.db'))).toEqual(bytes);
});

it.each(['valid inverse', 'invented undone marker', 'cyclic inverse history'] as const)('validates complete inverse evidence during restore: %s', async scenario => {
  const first = complete(must(core.prepareWorkspaceEdit(input(), auth)).edit);
  let inverse: WorkspaceEditRecord | undefined;
  if (scenario !== 'invented undone marker') {
    const before = first.input.documents[0]!;
    inverse = complete(must(core.prepareWorkspaceEdit(input({ requestId: 'inverse', undoOf: first.id, documents: [document(before.relativePath, before.afterText, before.beforeText, 6)] }), auth)).edit);
  }
  const stage = path.join(directory, 'stage'); mkdirSync(stage, { mode: 0o700 }); await core.backupDatabase(path.join(stage, 'eve.db'));
  const changed = new Database(path.join(stage, 'eve.db'));
  if (scenario === 'invented undone marker') changed.prepare('UPDATE operations SET undone=1 WHERE id=?').run(first.operation!.id);
  if (scenario === 'cyclic inverse history') {
    const forged = { ...first.input, undoOf: inverse!.id }, planHash = sha(workspaceJson(forged));
    const fingerprint = sha(workspaceJson({ kind: 'workspace-edit', input: forged, actorId: auth.actorId, origin: auth.origin }));
    changed.prepare('UPDATE workspace_edits SET input_json=?,plan_hash=?,fingerprint=?,receipt_json=? WHERE id=?').run(workspaceJson(forged), planHash, fingerprint, workspaceJson({ ...first.receipt!, planHash }), first.id);
    changed.prepare('UPDATE requests SET fingerprint=? WHERE request_id=?').run(fingerprint, first.requestId);
    changed.prepare("UPDATE operations SET type='UndoWorkspaceEdit' WHERE id=?").run(first.operation!.id);
    changed.prepare('UPDATE operations SET undone=1 WHERE id=?').run(inverse!.operation!.id);
  }
  changed.close();
  const bytes = readFileSync(path.join(stage, 'eve.db'));
  const relocation = CoreStore.relocateDatabase({ stagingProfile: stage, destinationProfile: path.join(directory, 'restored'), originalProfileRoot: profile, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: sha(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit'] });
  if (scenario === 'valid inverse') expect((await relocation).databaseValidated).toBe(true);
  else { await expect(relocation).rejects.toMatchObject({ code: 'INVALID_DATABASE' }); expect(readFileSync(path.join(stage, 'eve.db'))).toEqual(bytes); }
});
