import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { authenticatedContextSchema, idSchema, prepareWorkspaceEditSchema, workspaceEditDispatchSchema, workspaceEditReceiptSchema, workspaceEditObservationSchema,
  type AuthenticatedContext, type CoreErrorCode, type CoreSnapshot, type OperationRecord, type TaskRecord, type PrepareWorkspaceEditInput,
  type WorkspaceEditRecord, type WorkspaceEditReceipt, type WorkspaceEditObservation, type WorkspaceEditDispatch } from '../../contracts/src/index';

export const workspaceStatuses = "('prepared','dispatched','receipt-recorded','conflict')";
export interface WorkspaceJournalRow {
  id: string; request_id: string; task_id: string; project_id: string; status: WorkspaceEditRecord['status'];
  fingerprint: string; actor_id: string; origin: string; plan_hash: string; input_json: string; project_root: string;
  restored: number; receipt_json: string | null; operation_id: string | null; created_at: number; updated_at: number;
}
export const workspaceHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function workspaceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(workspaceJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${workspaceJson(value)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function workspaceReceiptMatches(id: string, planHash: string, input: PrepareWorkspaceEditInput, receipt: WorkspaceEditReceipt): boolean {
  return receipt.operationId === id && receipt.planHash === planHash && receipt.serviceInstanceId === input.serviceInstanceId && receipt.serviceGeneration === input.serviceGeneration
    && receipt.documents.length === input.documents.length && new Set(receipt.documents.map(document => document.relativePath)).size === receipt.documents.length
    && input.documents.every(before => receipt.documents.some(after => after.relativePath === before.relativePath && after.afterHash === before.afterHash && after.documentVersion > before.expectedDocumentVersion));
}
interface Dependencies {
  db: Database.Database; now(): number; snapshot(): CoreSnapshot;
  fail(code: CoreErrorCode, message: string): never;
}

/** Sole-writer DB bookkeeping only. Native editing and filesystem trust remain host responsibilities. */
export class WorkspaceEditJournal {
  constructor(private readonly deps: Dependencies) {}
  private get db() { return this.deps.db; }
  private fail(code: CoreErrorCode, message: string): never { return this.deps.fail(code, message); }
  private authorize(taskId: string, auth: AuthenticatedContext) {
    const parsed = authenticatedContextSchema.safeParse(auth);
    if (!parsed.success || auth.origin !== 'trusted-ui' || !auth.capabilities.includes('workspace:apply') || (auth.taskIds && !auth.taskIds.includes(taskId))) this.fail('UNAUTHORIZED', 'Workspace changes require trusted host Apply authority for this task.');
  }
  private task(taskId: string): TaskRecord { return this.deps.snapshot().tasks.find(task => task.id === taskId) ?? this.fail('NOT_FOUND', 'The workspace task does not exist.'); }
  private fingerprint(input: PrepareWorkspaceEditInput, auth: AuthenticatedContext) { return workspaceHash(workspaceJson({ kind: 'workspace-edit', input, actorId: auth.actorId, origin: auth.origin })); }
  private parse(input: unknown): PrepareWorkspaceEditInput {
    const parsed = prepareWorkspaceEditSchema.safeParse(input);
    if (!parsed.success || parsed.data.documents.some(document => workspaceHash(document.beforeText) !== document.beforeHash || workspaceHash(document.afterText) !== document.afterHash)) this.fail('INVALID_COMMAND', 'The workspace preparation has invalid paths, limits, changes or exact text hashes.');
    return parsed.data;
  }
  private row(id: string): WorkspaceJournalRow { return this.db.prepare('SELECT * FROM workspace_edits WHERE id=?').get(id) as WorkspaceJournalRow | undefined ?? this.fail('NOT_FOUND', 'The workspace preparation does not exist.'); }
  private owned(id: string, auth: AuthenticatedContext) {
    const row = this.row(id); this.authorize(row.task_id, auth);
    if (row.actor_id !== auth.actorId || row.origin !== auth.origin) this.fail('UNAUTHORIZED', 'The workspace preparation belongs to another authenticated caller.');
    return row;
  }
  read(id: string, auth: AuthenticatedContext): WorkspaceEditRecord { return this.record(this.owned(id, auth)); }
  readRequest(requestId: string, auth: AuthenticatedContext): WorkspaceEditRecord | null {
    const parsed = authenticatedContextSchema.safeParse(auth);
    if (!parsed.success || auth.origin !== 'trusted-ui' || !auth.capabilities.includes('workspace:apply')) this.fail('UNAUTHORIZED', 'Workspace journal lookup requires trusted host authority.');
    if (!idSchema.safeParse(requestId).success) this.fail('INVALID_COMMAND', 'A valid workspace request identity is required.');
    const row = this.db.prepare('SELECT id FROM workspace_edits WHERE request_id=?').get(requestId) as { id: string } | undefined;
    return row ? this.read(row.id, auth) : null;
  }
  private record(row: WorkspaceJournalRow): WorkspaceEditRecord {
    let operation: OperationRecord | null = null;
    if (row.operation_id) {
      const value = this.db.prepare('SELECT * FROM operations WHERE id=?').get(row.operation_id) as { id: string; request_id: string; task_id: string; type: OperationRecord['type']; label: string; created_at: number; undoable: number; undone: number } | undefined;
      if (!value || value.request_id !== row.request_id || value.task_id !== row.task_id) this.fail('STORAGE_ERROR', 'The workspace history receipt is inconsistent.');
      operation = { id: value.id, requestId: value.request_id, taskId: value.task_id, type: value.type, label: value.label, createdAt: value.created_at, undoable: value.undoable === 1, undone: value.undone === 1 };
    }
    return { id: row.id, requestId: row.request_id, taskId: row.task_id, projectId: row.project_id, projectRoot: row.project_root, status: row.status, planHash: row.plan_hash,
      input: this.parse(JSON.parse(row.input_json)), restored: row.restored === 1, receipt: row.receipt_json ? workspaceEditReceiptSchema.parse(JSON.parse(row.receipt_json)) : null, operation, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private otherRequest(requestId: string) {
    if (this.db.prepare('SELECT request_id FROM requests WHERE request_id=? UNION ALL SELECT request_id FROM project_edits WHERE request_id=? UNION ALL SELECT request_id FROM project_requests WHERE request_id=?').get(requestId, requestId, requestId)) this.fail('IDEMPOTENCY_CONFLICT', 'This request ID already belongs to another action.');
  }
  lookup(value: unknown, auth: AuthenticatedContext): WorkspaceEditRecord | null {
    const input = this.parse(value); this.authorize(input.taskId, auth);
    const prior = this.db.prepare('SELECT * FROM workspace_edits WHERE request_id=?').get(input.requestId) as WorkspaceJournalRow | undefined;
    if (!prior) { this.otherRequest(input.requestId); return null; }
    if (prior.fingerprint !== this.fingerprint(input, auth)) this.fail('IDEMPOTENCY_CONFLICT', 'This request ID belongs to different workspace input or authority.');
    const project = this.task(prior.task_id).project;
    if (!project || project.id !== prior.project_id || project.canonicalRoot !== prior.project_root) this.fail('STORAGE_ERROR', 'The workspace preparation has lost its project binding.');
    return this.record(prior);
  }
  private current(input: PrepareWorkspaceEditInput, permittedId = '') {
    const snapshot = this.deps.snapshot(), task = snapshot.tasks.find(task => task.id === input.taskId) ?? this.fail('NOT_FOUND', 'The workspace task does not exist.');
    if (snapshot.activeTaskId !== task.id || task.epoch !== input.expectedEpoch) this.fail('STALE_EPOCH', 'The workspace task is no longer the captured active task.');
    const project = task.project;
    if (task.revision !== input.expectedTaskRevision || task.policy.revision !== input.expectedPolicyRevision || !project || project.id !== input.projectId || project.revision !== input.expectedProjectRevision) this.fail('REVISION_CONFLICT', 'The task, project or processing policy changed after review.');
    if (project.verification !== 'verified' || workspaceJson(project.rootIdentity) !== workspaceJson(input.expectedRootIdentity)) this.fail('PROJECT_IDENTITY_CONFLICT', 'The host-inspected project identity does not match this preparation.');
    if (project.adapter === 'orbit' && input.documents.some(document => document.relativePath === 'eve.project.json')) this.fail('INVALID_COMMAND', 'Orbit configuration changes must use the registered parameter coordinator.');
    if (this.db.prepare(`SELECT id FROM workspace_edits WHERE project_id=? AND status IN ${workspaceStatuses} AND id!=?`).get(project.id, permittedId)
      || this.db.prepare("SELECT id FROM project_edits WHERE task_id=? AND status IN ('prepared','receipt-recorded','conflict')").get(task.id)) this.fail('EDIT_PENDING', 'Another project edit requires reconciliation before this edit can begin.');
    return project;
  }
  prepare(value: unknown, auth: AuthenticatedContext): { edit: WorkspaceEditRecord; resumed: boolean } {
    const input = this.parse(value); this.authorize(input.taskId, auth);
    return this.db.transaction(() => {
      const prior = this.lookup(input, auth);
      if (prior) return { edit: prior, resumed: true };
      const project = this.current(input);
      if (input.undoOf) {
        const original = this.record(this.owned(input.undoOf, auth));
        if (original.status !== 'finalized' || original.taskId !== input.taskId || original.projectId !== project.id || original.operation?.undone || original.input.documents.length !== input.documents.length
          || !input.documents.every(document => original.input.documents.some(before => before.relativePath === document.relativePath && before.afterText === document.beforeText && before.beforeText === document.afterText))) this.fail('NOT_UNDOABLE', 'The inverse preparation does not exactly reverse an available finalized workspace edit.');
      }
      const id = randomUUID(), now = this.deps.now();
      this.db.prepare('INSERT INTO workspace_edits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.requestId, input.taskId, project.id, 'prepared', this.fingerprint(input, auth), auth.actorId, auth.origin, workspaceHash(workspaceJson(input)), workspaceJson(input), project.canonicalRoot, 0, null, null, now, now);
      return { edit: this.record(this.row(id)), resumed: false };
    }).immediate();
  }
  markDispatched(id: string, value: WorkspaceEditDispatch, auth: AuthenticatedContext): { edit: WorkspaceEditRecord; dispatched: boolean } {
    return this.db.transaction(() => {
      const row = this.owned(id, auth), edit = this.record(row), parsed = workspaceEditDispatchSchema.safeParse(value);
      if (!parsed.success || value.planHash !== edit.planHash || value.serviceInstanceId !== edit.input.serviceInstanceId || value.serviceGeneration !== edit.input.serviceGeneration) this.fail('INVALID_RECEIPT', 'The editor dispatch binding does not match this preparation.');
      if (edit.restored) this.fail('EDITOR_RECOVERY_REQUIRED', 'A restored workspace preparation needs explicit recovery review.');
      if (['dispatched', 'receipt-recorded', 'finalized'].includes(row.status)) return { edit, dispatched: false };
      if (row.status !== 'prepared') this.fail('EDIT_CONFLICT', 'This preparation cannot dispatch an editor change.');
      this.current(edit.input, id);
      this.db.prepare("UPDATE workspace_edits SET status='dispatched',updated_at=? WHERE id=?").run(this.deps.now(), id);
      return { edit: this.record(this.row(id)), dispatched: true };
    }).immediate();
  }
  /** Cancelling an undispatched reservation races dispatch in the same sole-writer
   * transaction boundary. Buffer state is irrelevant: only dispatch:true grants
   * the host permission to attempt a native mutation. */
  cancelPrepared(id: string, value: WorkspaceEditDispatch, auth: AuthenticatedContext): WorkspaceEditRecord {
    return this.db.transaction(() => {
      const row = this.owned(id, auth), edit = this.record(row), parsed = workspaceEditDispatchSchema.safeParse(value);
      if (!parsed.success || value.planHash !== edit.planHash || value.serviceInstanceId !== edit.input.serviceInstanceId || value.serviceGeneration !== edit.input.serviceGeneration) this.fail('INVALID_RECEIPT', 'The cancellation binding does not match this workspace preparation.');
      if (edit.restored) this.fail('EDITOR_RECOVERY_REQUIRED', 'A restored workspace preparation needs explicit recovery review.');
      if (row.status === 'aborted') return edit;
      if (row.status !== 'prepared') this.fail('EDIT_CONFLICT', 'Only an undispatched workspace preparation can be cancelled.');
      this.db.prepare("UPDATE workspace_edits SET status='aborted',updated_at=? WHERE id=?").run(this.deps.now(), id);
      return this.record(this.row(id));
    }).immediate();
  }
  receipt(id: string, value: WorkspaceEditReceipt, auth: AuthenticatedContext): WorkspaceEditRecord {
    return this.db.transaction(() => {
      const row = this.owned(id, auth), edit = this.record(row), parsed = workspaceEditReceiptSchema.safeParse(value);
      if (!parsed.success || !workspaceReceiptMatches(id, row.plan_hash, edit.input, parsed.data)) this.fail('INVALID_RECEIPT', 'The durable editor acknowledgement does not match every prepared document and generation.');
      if (edit.receipt) {
        if (workspaceJson(value) !== workspaceJson(edit.receipt)) this.fail('INVALID_RECEIPT', 'A different receipt cannot replace the first editor acknowledgement.');
        return edit;
      }
      if (edit.restored) this.fail('EDITOR_RECOVERY_REQUIRED', 'A restored preparation cannot acquire new live-editor authority.');
      if (row.status !== 'dispatched') this.fail('EDIT_CONFLICT', 'Only a dispatched preparation can accept an editor acknowledgement.');
      this.db.prepare("UPDATE workspace_edits SET status='receipt-recorded',receipt_json=?,updated_at=? WHERE id=?").run(workspaceJson(parsed.data), this.deps.now(), id);
      return this.record(this.row(id));
    }).immediate();
  }
  finalize(id: string, auth: AuthenticatedContext): { operation: OperationRecord; idempotent: boolean } {
    return this.db.transaction(() => {
      const row = this.owned(id, auth), edit = this.record(row);
      if (edit.status === 'finalized' && edit.operation) return { operation: edit.operation, idempotent: true };
      if (edit.restored) this.fail('EDITOR_RECOVERY_REQUIRED', 'A restored pending preparation requires review rather than automatic finalization.');
      if (edit.status !== 'receipt-recorded' || !edit.receipt) this.fail('EDIT_CONFLICT', 'An exact durable editor acknowledgement is required before finalization.');
      const project = this.task(edit.taskId).project;
      if (!project || project.id !== edit.projectId || project.canonicalRoot !== edit.projectRoot) this.fail('PROJECT_IDENTITY_CONFLICT', 'The preparation no longer belongs to its registered project.');
      this.otherRequest(edit.requestId);
      const operation: OperationRecord = { id: randomUUID(), requestId: edit.requestId, taskId: edit.taskId, type: edit.input.undoOf ? 'UndoWorkspaceEdit' : 'ApplyWorkspaceEdit', label: edit.input.label, createdAt: this.deps.now(), undoable: false, undone: false };
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,0,0,NULL,NULL,NULL,NULL)').run(operation.id, operation.requestId, operation.taskId, operation.type, operation.label, operation.createdAt);
      this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(edit.requestId, row.fingerprint, operation.id);
      if (edit.input.undoOf) {
        const original = this.record(this.owned(edit.input.undoOf, auth));
        if (!original.operation || original.operation.undone) this.fail('NOT_UNDOABLE', 'The original workspace history result was already reversed.');
        this.db.prepare('UPDATE operations SET undone=1 WHERE id=?').run(original.operation.id);
      }
      this.db.prepare("UPDATE workspace_edits SET status='finalized',operation_id=?,updated_at=? WHERE id=?").run(operation.id, this.deps.now(), id);
      return { operation, idempotent: false };
    }).immediate();
  }
  private matches(edit: WorkspaceEditRecord, observation: WorkspaceEditObservation, after: boolean) {
    if (observation.kind !== 'live-editor' || observation.serviceInstanceId !== edit.input.serviceInstanceId || observation.serviceGeneration !== edit.input.serviceGeneration || observation.documents.length !== edit.input.documents.length || new Set(observation.documents.map(document => document.relativePath)).size !== observation.documents.length) return false;
    return edit.input.documents.every(document => observation.documents.some(observed => observed.relativePath === document.relativePath && observed.hash === (after ? document.afterHash : document.beforeHash) && observed.documentVersion === (after ? edit.receipt?.documents.find(value => value.relativePath === document.relativePath)?.documentVersion : document.expectedDocumentVersion)));
  }
  reconcile(id: string, value: WorkspaceEditObservation, auth: AuthenticatedContext): { edit: WorkspaceEditRecord; action: 'retry' | 'finalize' | 'review' | 'complete' | 'aborted' } {
    const edit = this.record(this.owned(id, auth)), parsed = workspaceEditObservationSchema.safeParse(value);
    if (!parsed.success) this.fail('INVALID_RECEIPT', 'A valid live-editor observation or unavailable state is required.');
    const action = edit.status === 'finalized' ? 'complete' : edit.status === 'aborted' ? 'aborted' : edit.restored ? 'review'
      : edit.status === 'prepared' && this.matches(edit, parsed.data, false) ? 'retry'
      : edit.status === 'receipt-recorded' && this.matches(edit, parsed.data, true) ? 'finalize' : 'review';
    return { edit, action };
  }
  abort(id: string, value: WorkspaceEditObservation, auth: AuthenticatedContext): WorkspaceEditRecord {
    return this.db.transaction(() => {
      const { edit, action } = this.reconcile(id, value, auth);
      if (action === 'aborted') return edit;
      if (action !== 'retry') this.fail('EDITOR_RECOVERY_REQUIRED', 'Only an undispatched preparation with its exact original live buffer versions can be aborted.');
      this.db.prepare("UPDATE workspace_edits SET status='aborted',updated_at=? WHERE id=?").run(this.deps.now(), id);
      return this.record(this.row(id));
    }).immediate();
  }
  pending(auth: AuthenticatedContext): WorkspaceEditRecord[] {
    const parsed = authenticatedContextSchema.safeParse(auth);
    if (!parsed.success || auth.origin !== 'trusted-ui' || !auth.capabilities.includes('workspace:apply')) this.fail('UNAUTHORIZED', 'Pending workspace recovery requires trusted host authority.');
    return (this.db.prepare(`SELECT * FROM workspace_edits WHERE actor_id=? AND origin=? AND status IN ${workspaceStatuses} ORDER BY created_at,id`).all(auth.actorId, auth.origin) as WorkspaceJournalRow[])
      .filter(row => !auth.taskIds || auth.taskIds.includes(row.task_id)).map(row => this.record(row));
  }
}
