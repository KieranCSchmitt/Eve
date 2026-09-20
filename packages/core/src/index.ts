import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceEditJournal, workspaceStatuses } from './workspace-edits';
import { CoreMaintenanceError, writeCoreSnapshot, type CoreBackupReceipt } from './maintenance';
export { CoreMaintenanceError, type CoreBackupReceipt } from './maintenance';
import { writeMigrationRollback, type MigrationRollbackReceipt } from './migration-backup';
export type { MigrationRollbackReceipt } from './migration-backup';
import { coreSchemaEntries, relocateOfflineDatabase, type CoreRelocationOptions, type CoreRelocationReceipt } from './relocation';
export type { CoreRelocationOptions, CoreRelocationReceipt, CorePathReference } from './relocation';
import {
  canvasDocumentSchema, canvasImageAssetIds, canvasReferencedBlocks, canvasDataEqual, compileCanvasSuggestion, CONTRACT_VERSION, authenticatedContextSchema, coreCommandSchema, orbitParametersSchema,
  projectEditPreparationSchema, projectEditReceiptSchema, projectEditObservationSchema,
  assetRegistrationSchema, sourceRegistrationSchema, jobRegistrationSchema,
  projectRecordSchema, registerProjectSchema, verifyProjectSchema,
  type AuthenticatedContext, type Capability, type Checkpoint, type CoreCommand,
  type CoreErrorCode, type CoreSnapshot, type DispatchResult, type OperationRecord,
  type OrbitParameters, type SearchResult, type TaskRecord, type CoreFailure,
  type PreflightResult, type ProjectEditPlan, type ProjectEditRecord, type ProjectEditPreparation,
  type ProjectEditReceipt, type PrepareProjectEditResult, type ProjectEditResult,
  type ReconcileProjectEditResult, type ProjectEditObservation, type TaskPolicy,
  type AssetRecord, type SourceRecord, type CoreValueResult, type JobRecord, type JobRegistration,
  type ProjectRecord, type ProjectRegistrationResult, type RegisterProjectInput, type VerifyProjectInput,
  type PrepareWorkspaceEditResult, type LookupWorkspaceEditResult, type WorkspaceEditResult, type DispatchWorkspaceEditResult,
  type WorkspaceEditDispatch, type WorkspaceEditReceipt, type WorkspaceEditObservation, type WorkspaceEditRecord, type ReconcileWorkspaceEditResult,
} from '../../contracts/src/index.js';

export interface CoreStoreOptions {
  dbPath: string;
  seed?: boolean;
  /** App startup may deliberately return Home without losing the previous task's saved state. */
  startAtHome?: boolean;
  orbitProjectPath?: string;
  busyTimeoutMs?: number;
  now?: () => number;
}

type Target = 'note' | 'parameters' | 'taskTitle' | 'canvas';
interface TaskRow {
  id: string; title: string; description: string; kind: 'project' | 'note'; project_path: string | null;
  revision: number; epoch: number; created_at: number; updated_at: number;
}
interface NoteRow { id: string; body: string; revision: number; updated_at: number }
interface JsonRow { value: string; revision: number; updated_at: number }
interface OperationRow {
  id: string; request_id: string; task_id: string; type: OperationRecord['type']; label: string;
  created_at: number; undoable: number; undone: number; target: Target | null;
  before_json: string | null; after_json: string | null; guard_revision: number | null;
}
interface AppliedChange { taskId: string; label: string; target?: Target; before?: unknown; after?: unknown; revision?: number }
interface JournalRow { id: string; request_id: string; task_id: string; status: ProjectEditRecord['status']; fingerprint: string; actor_id: string; origin: AuthenticatedContext['origin']; command_json: string; plan_json: string; preparation_json: string; receipt_json: string | null; created_at: number; updated_at: number }

const capabilityFor: Record<CoreCommand['type'], Capability> = {
  CreateTask: 'tasks:create', RenameTask: 'tasks:rename', RecallTask: 'tasks:recall', ShowHome: 'tasks:recall',
  UpdateCanvas: 'canvas:write', UpdateNote: 'notes:write', SaveCheckpoint: 'checkpoints:write', SetParameter: 'parameters:write', Undo: 'history:undo',
  SetTaskPolicy: 'policy:write',
};

class CoreFault extends Error {
  constructor(public readonly code: CoreErrorCode, message: string, public readonly details?: Record<string, unknown>) { super(message); }
}

function stableJson(value: unknown, legacyFingerprint = false): string {
  // JSON omits undefined object members but retains null (and uses null for an
  // undefined array element). Optional schema fields must survive a DB round trip.
  if (Array.isArray(value)) return `[${Array.from(value, entry => stableJson(entry, legacyFingerprint)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => legacyFingerprint || entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry, legacyFingerprint)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function operationRecord(row: OperationRow): OperationRecord {
  return { id: row.id, requestId: row.request_id, taskId: row.task_id, type: row.type,
    label: row.label, createdAt: row.created_at, undoable: row.undoable === 1, undone: row.undone === 1 };
}

/** Synchronous by design: host this store in the core utility process, never the renderer. */
export class CoreStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private closed = false;
  private backupInFlight = false;
  readonly migrationRollback: MigrationRollbackReceipt | null;
  private lastSnapshot: CoreSnapshot = { version: CONTRACT_VERSION, activeTaskId: null, tasks: [], recentActions: [] };

  /** Validates only an offline staging DB; the host must also relocate managed metadata and recovery files. */
  static async relocateDatabase(options: CoreRelocationOptions): Promise<CoreRelocationReceipt> {
    const reference = new CoreStore({ dbPath: ':memory:', seed: false });
    if ([3, 4, 5].includes(options.expectedSchemaVersion)) reference.db.exec('DROP TABLE canvases; PRAGMA user_version = 5;');
    if ([3, 4].includes(options.expectedSchemaVersion)) reference.db.exec('DROP TABLE workspace_edits; PRAGMA user_version = 4;');
    if (options.expectedSchemaVersion === 3) {
      // An explicit historical template, never a migration of the staged DB.
      reference.db.exec('DROP TABLE project_requests; DROP TABLE task_projects; DROP TABLE projects; PRAGMA user_version = 3;');
    }
    const template = { version: reference.diagnostics().schemaVersion, entries: coreSchemaEntries(reference.db) };
    reference.close();
    return relocateOfflineDatabase(options, template);
  }

  constructor(options: CoreStoreOptions) {
    if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    this.now = options.now ?? Date.now;
    this.db = new Database(options.dbPath, { timeout: options.busyTimeoutMs ?? 100 });
    try {
      // The exclusive owner retains its SQLite lock until close/crash. No stale lockfile recovery is needed.
      this.db.pragma('locking_mode = EXCLUSIVE');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      if (process.platform === 'darwin') this.db.pragma('fullfsync = ON');
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > 6 || version < 0) throw new Error(`Eve profile schema ${version} is newer than this app supports; open it with the matching app version.`);
      if (version === 0 && coreSchemaEntries(this.db).length) throw new Error('An unversioned nonempty database cannot be migrated as a new Eve profile.');
      // Acquire the write reservation without changing rows. EXCLUSIVE mode
      // retains it after COMMIT, including throughout VACUUM INTO and migration.
      this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
      if (this.db.pragma('user_version', { simple: true }) !== version) throw new CoreMaintenanceError('BUSY', 'The profile schema changed while Eve was acquiring its writer lock. Retry opening it.');
      this.migrationRollback = options.dbPath !== ':memory:' && version > 0 && version < 6
        ? writeMigrationRollback(this.db, options.dbPath, version, 6) : null;
      if (options.dbPath !== ':memory:') chmodSync(options.dbPath, 0o600);
      this.db.pragma('journal_mode = WAL');
      this.migrate();
      this.db.transaction(() => {
        const initialized = this.db.prepare("SELECT value FROM meta WHERE key = 'initialized'").get();
        if (!initialized) {
          if (options.seed !== false) this.seed(options.orbitProjectPath ?? null);
          this.db.prepare("INSERT INTO meta(key, value) VALUES ('initialized', '1')").run();
        }
        if (options.startAtHome === true) this.deactivate();
        // Work from a dead process can never regain authority merely because its output arrives later.
        this.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE status='running'").run(this.now());
      }).immediate();
      this.snapshot();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 6) throw new Error(`Eve profile schema ${version} is newer than this app supports; open it with the matching app version.`);
    if (version === 6) return;
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('project','note')), project_path TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 0), epoch INTEGER NOT NULL CHECK(epoch >= 0),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE notes (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          body TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), updated_at INTEGER NOT NULL
        );
        CREATE TABLE parameters (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          value TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), updated_at INTEGER NOT NULL
        );
        CREATE TABLE checkpoints (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          value TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), updated_at INTEGER NOT NULL
        );
        CREATE TABLE operations (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id),
          type TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL,
          undoable INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
          target TEXT, before_json TEXT, after_json TEXT, guard_revision INTEGER
        );
        CREATE INDEX operation_task ON operations(task_id, created_at);
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          operation_id TEXT NOT NULL REFERENCES operations(id)
        );
        CREATE VIRTUAL TABLE task_search USING fts5(task_id UNINDEXED, title, description, body, tokenize='unicode61');
        PRAGMA user_version = 1;
      `);
    }).immediate();
    if (version < 2) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE task_policies (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
        INSERT INTO task_policies SELECT id, '{"processing":"hybrid","assistancePaused":false}', 0 FROM tasks;
        CREATE TABLE project_edits (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id),
          status TEXT NOT NULL, fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, origin TEXT NOT NULL,
          command_json TEXT NOT NULL, plan_json TEXT NOT NULL, preparation_json TEXT NOT NULL,
          receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX project_edit_pending ON project_edits(task_id,status);
        CREATE TABLE assets (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE sources (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_epoch INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        PRAGMA user_version = 2;
      `);
    }).immediate();
    if (version < 3) this.db.transaction(() => {
      // v3 repairs only the optional metadata members the old serializer could
      // turn from undefined into null. Required/unknown fields, IDs, provenance
      // text, timestamps, and malformed records are not invented or discarded.
      // Journal/history JSON and request fingerprints remain byte-for-byte intact:
      // they are evidence of past operations, not a general JSON cleanup target.
      for (const table of ['sources', 'assets'] as const) {
        const schema = table === 'sources' ? sourceRegistrationSchema : assetRegistrationSchema;
        for (const row of this.db.prepare(`SELECT id,data FROM ${table}`).all() as { id: string; data: string }[]) {
          let data: Record<string, unknown>;
          try { data = JSON.parse(row.data); } catch { continue; }
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          let repaired = false;
          if (table === 'sources') for (const field of ['url', 'assetId', 'timestampStart', 'timestampEnd']) {
            if (data[field] === null) { delete data[field]; repaired = true; }
          }
          const provenance = data.provenance;
          if (provenance && typeof provenance === 'object' && !Array.isArray(provenance) && (provenance as Record<string, unknown>).sourceUrl === null) {
            delete (provenance as Record<string, unknown>).sourceUrl; repaired = true;
          }
          if (repaired && schema.safeParse(data).success) this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(stableJson(data), row.id);
        }
      }
      this.db.pragma('user_version = 3');
    }).immediate();
    if (version < 4) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE,
          device TEXT, inode TEXT, data TEXT NOT NULL
        );
        CREATE UNIQUE INDEX project_root_identity ON projects(device,inode) WHERE device IS NOT NULL AND inode IS NOT NULL;
        CREATE TABLE task_projects (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL UNIQUE REFERENCES projects(id)
        );
        CREATE TABLE project_requests (
          request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL
        );
      `);
      for (const row of this.db.prepare('SELECT * FROM tasks WHERE project_path IS NOT NULL').all() as TaskRow[]) {
        this.insertLegacyProject(row.id, row.project_path!, row.created_at, row.updated_at);
      }
      this.db.exec('UPDATE tasks SET project_path=NULL; PRAGMA user_version = 4;');
    }).immediate();
    if (version < 5) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE workspace_edits (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
          status TEXT NOT NULL, fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, origin TEXT NOT NULL,
          plan_hash TEXT NOT NULL, input_json TEXT NOT NULL, project_root TEXT NOT NULL, restored INTEGER NOT NULL DEFAULT 0,
          receipt_json TEXT, operation_id TEXT REFERENCES operations(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX workspace_edit_pending ON workspace_edits(project_id,status);
        PRAGMA user_version = 5;
      `);
    }).immediate();
    if (version < 6) this.db.transaction(() => {
      this.db.exec(`CREATE TABLE canvases (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, value TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), updated_at INTEGER NOT NULL); PRAGMA user_version = 6;`);
    }).immediate();
  }

  private seed(projectPath: string | null): void {
    const now = this.now();
    this.insertTask({ id: 'orbit', title: 'Orbit', description: 'A study timer with a little more breathing room.', kind: 'project', projectPath, now,
      parameters: { theme: '#708069', durationMinutes: 25, transitionMs: 280, easing: [0.22, 1, 0.36, 1] },
      body: '# A timer that helps me settle in\n\nBuild a small, useful study timer. Keep it calm, readable, and honest about time.\n\n## Try next\n- Make the card transition feel softer.\n- Compare a linear transition with an easing curve.\n- Keep a visible way to pause and reset.\n\n## Notes\nThe animation decorates the interface. The timer itself should use elapsed time, so dropped frames never make a session longer.\n' });
    this.insertTask({ id: 'photo-walk', title: 'Photo walk', description: 'Small details, good light, and a slower afternoon.', kind: 'note', projectPath: null, now: now - 1,
      body: '# A slower afternoon\n\nTake a short walk with a camera and pay attention to the things I usually pass.\n\n## Look for\n- Window light falling across a wall\n- One unexpected color\n- A quiet corner with interesting shadows\n\n## Bring\nA camera or phone, a charged battery, and comfortable shoes.\n\n## After the walk\nChoose three photographs. Write a sentence about what made each one worth stopping for.\n' });
    this.db.prepare('UPDATE tasks SET epoch = 1 WHERE id = ?').run('orbit');
    this.setMeta('activeTaskId', 'orbit');
  }

  private insertTask(input: { id: string; title: string; description: string; kind: 'project' | 'note'; projectPath: string | null; body: string; now: number; parameters?: OrbitParameters }): void {
    this.db.prepare('INSERT INTO tasks VALUES (@id,@title,@description,@kind,NULL,0,0,@now,@now)').run(input);
    if (input.projectPath) this.insertLegacyProject(input.id, input.projectPath, input.now, input.now);
    this.db.prepare('INSERT INTO notes VALUES (?,?,?,?,?)').run(`note-${input.id}`, input.id, input.body, 0, input.now);
    this.db.prepare('INSERT INTO task_policies VALUES (?,?,0)').run(input.id, stableJson({ processing: 'hybrid', assistancePaused: false }));
    if (input.parameters) {
      this.db.prepare('INSERT INTO parameters VALUES (?,?,?,?)').run(input.id, stableJson(input.parameters), 0, input.now);
    }
    this.refreshSearch(input.id);
  }

  private canonicalProjectRoot(root: string): string {
    if (!isAbsolute(root) || normalize(root) !== root || root.includes('\\') || /[\u0000-\u001f\u007f]/.test(root)) throw new CoreFault('INVALID_COMMAND', 'A project needs its host-inspected canonical absolute root.');
    return root;
  }

  private insertLegacyProject(taskId: string, root: string, createdAt: number, updatedAt: number): void {
    const project: ProjectRecord = { id: `legacy-${createHash('sha256').update(taskId).digest('hex')}`, canonicalRoot: this.canonicalProjectRoot(root), rootIdentity: null, kind: null, adapter: 'generic', preview: { kind: 'none' }, verification: 'legacy-unverified', revision: 0, createdAt, updatedAt };
    this.writeProject(project, true);
    this.db.prepare('INSERT INTO task_projects VALUES (?,?)').run(taskId, project.id);
  }

  private writeProject(project: ProjectRecord, insert: boolean): void {
    const fields = [project.canonicalRoot, project.rootIdentity?.device ?? null, project.rootIdentity?.inode ?? null, stableJson(project), project.id];
    if (insert) this.db.prepare('INSERT INTO projects(canonical_root,device,inode,data,id) VALUES (?,?,?,?,?)').run(...fields);
    else this.db.prepare('UPDATE projects SET canonical_root=?,device=?,inode=?,data=? WHERE id=?').run(...fields);
  }

  private projectForTask(taskId: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT p.* FROM projects p JOIN task_projects t ON t.project_id=p.id WHERE t.task_id=?').get(taskId) as { id: string; canonical_root: string; device: string | null; inode: string | null; data: string } | undefined;
    if (!row) return null;
    const project = projectRecordSchema.parse(JSON.parse(row.data));
    if (project.id !== row.id || project.canonicalRoot !== row.canonical_root || (project.rootIdentity?.device ?? null) !== row.device || (project.rootIdentity?.inode ?? null) !== row.inode) throw new CoreFault('STORAGE_ERROR', 'Project registration metadata is inconsistent.');
    return project;
  }

  /** Only the trusted host can register a folder already inspected through a picker. No filesystem work or script execution occurs here. */
  registerProject(input: unknown, auth: AuthenticatedContext): ProjectRegistrationResult {
    try {
      const parsed = registerProjectSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The project registration is malformed or lacks its validated adapter configuration.');
      return this.admitProject('register', parsed.data, auth);
    } catch (error) { return this.failure(error); }
  }

  /** Read-only reconciliation of an exact acknowledged registration. The folder
   * may have disappeared after the commit; no filesystem check or new admission
   * occurs. A missing receipt never authorizes skipping host inspection. */
  lookupProjectRegistration(input: unknown, auth: AuthenticatedContext): CoreValueResult<{ project: ProjectRecord; snapshot: CoreSnapshot } | null> {
    try {
      const parsed = registerProjectSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The project registration lookup is malformed.');
      this.authorizeProjectAdmission(parsed.data.taskId, auth);
      const fingerprint = this.projectFingerprint('register', parsed.data, auth);
      const prior = this.db.prepare('SELECT fingerprint,project_id,kind FROM project_requests WHERE request_id=?').get(parsed.data.requestId) as { fingerprint: string; project_id: string; kind: string } | undefined;
      if (!prior) {
        this.assertProjectRequestAvailable(parsed.data.requestId);
        return { ok: true, value: null };
      }
      if (prior.fingerprint !== fingerprint || prior.kind !== 'register') throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a different project action.');
      const project = this.projectForTask(parsed.data.taskId);
      if (!project || project.id !== prior.project_id || project.id !== parsed.data.project.id) throw new CoreFault('STORAGE_ERROR', 'The project request no longer matches its binding.');
      return { ok: true, value: { project, snapshot: this.snapshot() } };
    } catch (error) { return this.failure(error); }
  }

  /** Promotes only a legacy/unverified identity at its existing root. Replacing or moving a verified project is not supported. */
  verifyProject(input: unknown, auth: AuthenticatedContext): ProjectRegistrationResult {
    try {
      const parsed = verifyProjectSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The project inspection is malformed.');
      return this.admitProject('verify', parsed.data, auth);
    } catch (error) { return this.failure(error); }
  }

  private authorizeProjectAdmission(taskId: string, auth: AuthenticatedContext): void {
    this.requireCapability(auth, 'projects:register', taskId);
    if (auth.origin !== 'trusted-ui') throw new CoreFault('UNAUTHORIZED', 'Project registration requires the trusted host.');
  }

  private projectFingerprint(kind: 'register' | 'verify', input: RegisterProjectInput | VerifyProjectInput, auth: AuthenticatedContext): string {
    return createHash('sha256').update(stableJson({ kind, input, actorId: auth.actorId, origin: auth.origin })).digest('hex');
  }

  private assertProjectRequestAvailable(requestId: string): void {
    if (this.db.prepare('SELECT request_id FROM requests WHERE request_id=? UNION ALL SELECT request_id FROM project_edits WHERE request_id=? UNION ALL SELECT request_id FROM workspace_edits WHERE request_id=?').get(requestId, requestId, requestId)) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to another action.');
  }

  private admitProject(kind: 'register' | 'verify', input: RegisterProjectInput | VerifyProjectInput, auth: AuthenticatedContext): ProjectRegistrationResult {
    this.authorizeProjectAdmission(input.taskId, auth);
    const fingerprint = this.projectFingerprint(kind, input, auth);
    const result = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT fingerprint,project_id,kind FROM project_requests WHERE request_id=?').get(input.requestId) as { fingerprint: string; project_id: string; kind: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.kind !== kind) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a different project action.');
        const project = this.projectForTask(input.taskId);
        if (!project || project.id !== prior.project_id) throw new CoreFault('STORAGE_ERROR', 'The project request no longer matches its binding.');
        return { project, idempotent: true };
      }
      this.assertProjectRequestAvailable(input.requestId);
      const task = this.taskRow(input.taskId);
      this.checkEpoch(input); this.checkRevision(task.revision, input.expectedTaskRevision);
      const current = this.projectForTask(input.taskId), now = this.now();
      let project: ProjectRecord;
      if ('project' in input) {
        if (current) throw new CoreFault('PROJECT_ALREADY_ATTACHED', 'This task already has a project. It cannot be silently replaced.');
        if (this.db.prepare('SELECT id FROM projects WHERE id=?').get(input.project.id)) throw new CoreFault('PROJECT_IDENTITY_CONFLICT', 'This project identity is already registered.');
        project = { ...input.project, canonicalRoot: this.canonicalProjectRoot(input.project.canonicalRoot), verification: 'verified', revision: 0, createdAt: now, updatedAt: now };
      } else {
        if (!current || current.id !== input.projectId) throw new CoreFault('NOT_FOUND', 'The project is no longer attached to this task.');
        this.checkRevision(current.revision, input.expectedProjectRevision);
        if (current.verification !== 'legacy-unverified') throw new CoreFault('PROJECT_IDENTITY_CONFLICT', 'A verified project identity is immutable.');
        project = { ...current, rootIdentity: input.rootIdentity, kind: input.kind, adapter: input.adapter, preview: input.preview, verification: 'verified', revision: current.revision + 1, updatedAt: now };
      }
      if (this.db.prepare('SELECT id FROM projects WHERE canonical_root=? AND id!=?').get(project.canonicalRoot, project.id)) throw new CoreFault('PROJECT_ROOT_CONFLICT', 'This folder is already attached to another task.');
      if (this.db.prepare('SELECT id FROM projects WHERE device=? AND inode=? AND id!=?').get(project.rootIdentity.device, project.rootIdentity.inode, project.id)) throw new CoreFault('PROJECT_IDENTITY_CONFLICT', 'This directory identity is already attached to another task.');
      const parameters = this.db.prepare('SELECT task_id FROM parameters WHERE task_id=?').get(task.id);
      if (project.adapter === 'orbit' && !parameters && !input.parameters) throw new CoreFault('INVALID_COMMAND', 'Orbit requires a host-validated project configuration.');
      if (project.adapter === 'generic' && this.db.prepare("SELECT id FROM project_edits WHERE task_id=? AND status IN ('prepared','receipt-recorded','conflict')").get(task.id)) throw new CoreFault('EDIT_PENDING', 'Reconcile the existing Orbit edit before removing its controls.');
      this.writeProject(project, !current);
      if (!current) this.db.prepare('INSERT INTO task_projects VALUES (?,?)').run(task.id, project.id);
      if (!parameters && input.parameters) this.db.prepare('INSERT INTO parameters VALUES (?,?,0,?)').run(task.id, stableJson(input.parameters), now);
      // Binding/inspection changes captured context. Old model work loses its epoch.
      this.db.prepare("UPDATE tasks SET kind='project',project_path=NULL,revision=revision+1,epoch=epoch+1,updated_at=? WHERE id=?").run(now, task.id);
      this.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE task_id=? AND status='running'").run(now, task.id);
      this.db.prepare('INSERT INTO project_requests VALUES (?,?,?,?)').run(input.requestId, fingerprint, project.id, kind);
      return { project, idempotent: false };
    }).immediate();
    return { ok: true, ...result, snapshot: this.snapshot() };
  }

  private requireParameterAdapter(taskId: string): void {
    const project = this.projectForTask(taskId);
    if (project?.verification === 'verified' && project.adapter !== 'orbit') throw new CoreFault('INVALID_COMMAND', 'This project has no registered Orbit controls.');
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  private activeTaskId(): string | null {
    return (this.db.prepare("SELECT value FROM meta WHERE key='activeTaskId'").get() as { value: string } | undefined)?.value ?? null;
  }
  private taskRow(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!row) throw new CoreFault('NOT_FOUND', 'This task is no longer available.', { taskId });
    return { ...row, project_path: this.projectForTask(taskId)?.canonicalRoot ?? null };
  }
  private checkRevision(actual: number, expected: number): void {
    if (actual !== expected) throw new CoreFault('REVISION_CONFLICT', 'This content changed after the request was prepared. Keep the current content and refresh the proposal.', { expectedRevision: expected, actualRevision: actual });
  }
  private checkEpoch(command: { taskId: string; expectedEpoch: number }): void {
    const task = this.taskRow(command.taskId);
    if (task.epoch !== command.expectedEpoch) throw new CoreFault('STALE_EPOCH', 'The task context changed. Refresh the request before applying it.', { expectedEpoch: command.expectedEpoch, actualEpoch: task.epoch });
  }
  private activate(taskId: string): void {
    const previous = this.activeTaskId();
    if (previous === taskId) return;
    if (previous) {
      this.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(previous);
      this.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE task_id=? AND status='running'").run(this.now(), previous);
    }
    this.db.prepare('UPDATE tasks SET epoch=epoch+1,updated_at=? WHERE id=?').run(this.now(), taskId);
    this.setMeta('activeTaskId', taskId);
  }
  /** Caller owns the transaction: epoch, running jobs and active identity change together. */
  private deactivate(): void {
    const previous = this.activeTaskId();
    if (previous !== null) {
      this.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(previous);
      this.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE task_id=? AND status='running'").run(this.now(), previous);
    }
    this.db.prepare("DELETE FROM meta WHERE key='activeTaskId'").run();
  }

  snapshot(): CoreSnapshot {
    const tasks = (this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id').all() as TaskRow[]).map(row => {
      const project = this.projectForTask(row.id);
      const note = this.db.prepare('SELECT id,body,revision,updated_at FROM notes WHERE task_id=?').get(row.id) as NoteRow;
      const canvas = this.db.prepare('SELECT value,revision,updated_at FROM canvases WHERE task_id=?').get(row.id) as JsonRow | undefined;
      const parameters = this.db.prepare('SELECT value,revision,updated_at FROM parameters WHERE task_id=?').get(row.id) as JsonRow | undefined;
      const checkpoint = this.db.prepare('SELECT value,revision,updated_at FROM checkpoints WHERE task_id=?').get(row.id) as JsonRow | undefined;
      const policy = this.db.prepare('SELECT value,revision FROM task_policies WHERE task_id=?').get(row.id) as JsonRow;
      return {
        id: row.id, title: row.title, description: row.description, kind: row.kind, projectPath: project?.canonicalRoot ?? null, project,
        revision: row.revision, epoch: row.epoch, createdAt: row.created_at, updatedAt: row.updated_at,
        canvas: canvas ? { document: canvas.value === 'null' ? null : canvasDocumentSchema.parse(JSON.parse(canvas.value)), revision: canvas.revision, updatedAt: canvas.updated_at } : null,
        note: { id: note.id, body: note.body, revision: note.revision, updatedAt: note.updated_at },
        parameters: parameters && !(project?.verification === 'verified' && project.adapter === 'generic') ? { values: JSON.parse(parameters.value) as OrbitParameters, revision: parameters.revision, updatedAt: parameters.updated_at } : null,
        checkpoint: checkpoint ? { ...JSON.parse(checkpoint.value) as Checkpoint, revision: checkpoint.revision, updatedAt: checkpoint.updated_at } : null,
        policy: { ...JSON.parse(policy.value) as TaskPolicy, revision: policy.revision },
      } satisfies TaskRecord;
    });
    const recentActions = (this.db.prepare('SELECT * FROM operations ORDER BY rowid DESC LIMIT 50').all() as OperationRow[]).map(operationRecord);
    const snapshot: CoreSnapshot = { version: CONTRACT_VERSION, activeTaskId: this.activeTaskId(), tasks, recentActions };
    this.lastSnapshot = structuredClone(snapshot);
    return snapshot;
  }

  private authorize(input: unknown, authenticatedContext: AuthenticatedContext): CoreCommand {
      const parsed = coreCommandSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The requested action is malformed or outside supported limits.', { fields: parsed.error.issues.map(issue => issue.path.join('.')) });
      const auth = authenticatedContextSchema.safeParse(authenticatedContext);
      if (!auth.success || auth.data.origin === 'model' || !auth.data.capabilities.includes(capabilityFor[parsed.data.type])) {
        throw new CoreFault('UNAUTHORIZED', 'This caller is not authorized to perform that action.');
      }
      // A workbench may save its context and content; it cannot acquire task/navigation authority through payloads.
      if (auth.data.origin === 'workbench' && !['UpdateNote', 'SaveCheckpoint', 'SetParameter'].includes(parsed.data.type)) {
        throw new CoreFault('UNAUTHORIZED', 'This action requires the trusted Eve interface.');
      }
      if ('taskId' in parsed.data && (auth.data.taskIds || auth.data.origin === 'workbench') && !auth.data.taskIds?.includes(parsed.data.taskId)) {
        throw new CoreFault('UNAUTHORIZED', 'This caller does not have access to the requested task.');
      }
      return parsed.data;
  }

  private fingerprint(command: CoreCommand, auth: AuthenticatedContext): string {
    // Keep the v1/v2 identity algorithm so retrying a historical request cannot
    // become a second operation after the storage serializer changes in v3.
    return createHash('sha256').update(stableJson({ command, actorId: auth.actorId, origin: auth.origin }, true)).digest('hex');
  }

  private duplicate(command: CoreCommand, fingerprint: string): Extract<DispatchResult, { ok: true }> | undefined {
    if (this.db.prepare('SELECT request_id FROM workspace_edits WHERE request_id=?').get(command.requestId)) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a workspace preparation.');
    if (this.db.prepare('SELECT request_id FROM project_requests WHERE request_id=?').get(command.requestId)) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a project registration.');
    const prepared = this.db.prepare('SELECT fingerprint FROM project_edits WHERE request_id=?').get(command.requestId) as { fingerprint: string } | undefined;
    if (prepared && prepared.fingerprint !== fingerprint) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a different prepared edit.');
    const prior = this.db.prepare('SELECT fingerprint,operation_id FROM requests WHERE request_id=?').get(command.requestId) as { fingerprint: string; operation_id: string } | undefined;
    if (!prior) return;
    if (prior.fingerprint !== fingerprint) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID has already been used for a different action or caller.');
    return { ok: true, snapshot: this.snapshot(), operation: operationRecord(this.db.prepare('SELECT * FROM operations WHERE id=?').get(prior.operation_id) as OperationRow), idempotent: true };
  }

  private failure(error: unknown): CoreFailure {
    const fault = error instanceof CoreFault ? error : new CoreFault('STORAGE_ERROR', 'Eve could not confirm this change was saved. Refresh before retrying; reuse this request ID to prevent a duplicate edit.');
    let snapshot: CoreSnapshot;
    try { snapshot = this.snapshot(); } catch { snapshot = structuredClone(this.lastSnapshot); }
    return { ok: false, snapshot, error: { code: fault.code, message: fault.message, ...(fault.details ? { details: fault.details } : {}) } };
  }

  private completedOperation(command: CoreCommand, change: AppliedChange, fingerprint: string): OperationRecord {
    const operation: OperationRecord = { id: randomUUID(), requestId: command.requestId, taskId: change.taskId, type: command.type, label: change.label, createdAt: this.now(), undoable: Boolean(change.target), undone: false };
    this.db.prepare('INSERT INTO operations(id,request_id,task_id,type,label,created_at,undoable,undone,target,before_json,after_json,guard_revision) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)').run(
      operation.id, operation.requestId, operation.taskId, operation.type, operation.label, operation.createdAt,
      operation.undoable ? 1 : 0, change.target ?? null, change.target ? stableJson(change.before) : null,
      change.target ? stableJson(change.after) : null, change.revision ?? null,
    );
    this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(command.requestId, fingerprint, operation.id);
    return operation;
  }

  private undoRow(command: Extract<CoreCommand, { type: 'Undo' }>): OperationRow {
    const row = (command.operationId
      ? this.db.prepare('SELECT * FROM operations WHERE id=? AND task_id=?').get(command.operationId, command.taskId)
      : this.db.prepare('SELECT * FROM operations WHERE task_id=? AND undoable=1 AND undone=0 ORDER BY rowid DESC LIMIT 1').get(command.taskId)) as OperationRow | undefined;
    if (!row || !row.undoable || row.undone || !row.target || row.before_json === null) throw new CoreFault('NOT_UNDOABLE', 'There is no available edit to undo.');
    return row;
  }

  /** Pure validation: no SQL writes, files, or operation IDs are produced here. */
  private validateChange(command: CoreCommand, skipEpoch = false, permittedEditId?: string): ProjectEditPlan | undefined {
    if ('expectedEpoch' in command && !skipEpoch) this.checkEpoch(command);
    if ('taskId' in command) this.taskRow(command.taskId);
    if (command.type === 'ShowHome' && this.activeTaskId() !== command.taskId) {
      throw new CoreFault('STALE_EPOCH', 'The active task changed before returning Home. Refresh the current task.', { expectedTaskId: command.taskId, actualTaskId: this.activeTaskId() });
    }
    if (command.jobToken && !skipEpoch) {
      const job = this.jobRecord(command.jobToken.id);
      if (!job || !('taskId' in command) || command.taskId !== job.taskId || !this.isJobCurrent(job.id, command.jobToken.generation)) throw new CoreFault('JOB_CANCELLED', 'This job is no longer current and cannot apply its result.');
    }
    let plan: ProjectEditPlan | undefined;
    if (command.type === 'RenameTask') this.checkRevision(this.taskRow(command.taskId).revision, command.expectedRevision);
    if (command.type === 'UpdateCanvas') {
      const current = this.targetState(command.taskId, 'canvas');
      this.checkRevision(current.revision, command.expectedRevision);
      const assets = new Set((this.db.prepare('SELECT id,data FROM assets WHERE task_id=?').all(command.taskId) as { id: string; data: string }[]).filter(item => (JSON.parse(item.data) as AssetRecord).mediaType.startsWith('image/')).map(item => item.id));
      const sources = new Set((this.db.prepare('SELECT id FROM sources WHERE task_id=?').all(command.taskId) as { id: string }[]).map(item => item.id));
      for (const block of canvasReferencedBlocks(command.document)) {
        if (canvasImageAssetIds(block).some(id => !assets.has(id))) throw new CoreFault('INVALID_COMMAND', 'This image is not attached to this space.');
        if (block.sourceIds.some(id => !sources.has(id))) throw new CoreFault('INVALID_COMMAND', 'This source is not attached to this space.');
      }
      const previous = current.value === null ? null : canvasDocumentSchema.parse(current.value);
      for (const suggestion of command.document.suggestions ?? []) {
        const saved = previous?.suggestions?.find(item => item.id === suggestion.id);
        if (!suggestion.prepared || (saved?.targetBlockId === suggestion.targetBlockId && canvasDataEqual(suggestion.prepared, saved.prepared) && canvasDataEqual(suggestion.textSelection, saved.textSelection))) continue;
        try { compileCanvasSuggestion(command.document, suggestion.id, { assetIds: [...assets], sourceIds: [...sources] }); }
        catch (error) { throw new CoreFault('INVALID_COMMAND', error instanceof Error ? error.message : 'This prepared suggestion is not available.'); }
      }
    }
    if (command.type === 'UpdateNote') this.checkRevision((this.db.prepare('SELECT revision FROM notes WHERE task_id=?').get(command.taskId) as JsonRow).revision, command.expectedRevision);
    if (command.type === 'SaveCheckpoint') this.checkRevision((this.db.prepare('SELECT revision FROM checkpoints WHERE task_id=?').get(command.taskId) as JsonRow | undefined)?.revision ?? 0, command.expectedRevision);
    if (command.type === 'SetTaskPolicy') this.checkRevision((this.db.prepare('SELECT revision FROM task_policies WHERE task_id=?').get(command.taskId) as JsonRow).revision, command.expectedRevision);
    if (command.type === 'SetParameter') {
      this.requireParameterAdapter(command.taskId);
      const current = this.db.prepare('SELECT value,revision FROM parameters WHERE task_id=?').get(command.taskId) as JsonRow | undefined;
      if (!current) throw new CoreFault('INVALID_COMMAND', 'This task does not have registered project controls.');
      this.checkRevision(current.revision, command.expectedRevision);
      const before = JSON.parse(current.value) as OrbitParameters;
      const parsed = orbitParametersSchema.safeParse({ ...before, [command.name]: command.value });
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The parameter value is outside its supported range.', { parameter: command.name });
      const task = this.taskRow(command.taskId);
      if (task.project_path) plan = { taskId: task.id, projectPath: task.project_path, before, after: parsed.data };
    }
    if (command.type === 'Undo') {
      const row = this.undoRow(command);
      if (row.target === 'parameters') this.requireParameterAdapter(command.taskId);
      const state = this.targetState(command.taskId, row.target!);
      this.checkRevision(state.revision, row.guard_revision as number);
      if (stableJson(state.value) !== row.after_json) throw new CoreFault('REVISION_CONFLICT', 'Current content no longer matches this edit.');
      const task = this.taskRow(command.taskId);
      if (row.target === 'parameters' && task.project_path) plan = { taskId: task.id, projectPath: task.project_path, before: state.value as OrbitParameters, after: JSON.parse(row.before_json!) as OrbitParameters, undoOf: row.id };
    }
    if (plan) {
      if (this.db.prepare(`SELECT id FROM workspace_edits WHERE task_id=? AND status IN ${workspaceStatuses}`).get(plan.taskId)) throw new CoreFault('EDIT_PENDING', 'A workspace edit must be reconciled before another project edit can begin.');
      const pending = this.db.prepare("SELECT id FROM project_edits WHERE task_id=? AND status IN ('prepared','receipt-recorded','conflict') AND id != ? LIMIT 1").get(plan.taskId, permittedEditId ?? '') as { id: string } | undefined;
      if (pending) throw new CoreFault('EDIT_PENDING', 'A project edit must be reconciled before another edit can begin.', { editId: pending.id });
    }
    return plan;
  }

  private targetState(taskId: string, target: Target): { value: unknown; revision: number } {
    if (target === 'canvas') { const row = this.db.prepare('SELECT value,revision FROM canvases WHERE task_id=?').get(taskId) as JsonRow | undefined; return { value: row ? JSON.parse(row.value) : null, revision: row?.revision ?? 0 }; }
    if (target === 'taskTitle') { const task = this.taskRow(taskId); return { value: task.title, revision: task.revision }; }
    if (target === 'note') { const note = this.db.prepare('SELECT body,revision FROM notes WHERE task_id=?').get(taskId) as NoteRow; return { value: note.body, revision: note.revision }; }
    const parameters = this.db.prepare('SELECT value,revision FROM parameters WHERE task_id=?').get(taskId) as JsonRow;
    return { value: JSON.parse(parameters.value), revision: parameters.revision };
  }

  preflight(input: unknown, auth: AuthenticatedContext): PreflightResult {
    try {
      const command = this.authorize(input, auth);
      const fingerprint = this.fingerprint(command, auth);
      const duplicate = this.duplicate(command, fingerprint);
      if (duplicate) return { ok: true, command, duplicate };
      const pending = this.db.prepare('SELECT * FROM project_edits WHERE request_id=?').get(command.requestId) as JournalRow | undefined;
      if (pending) {
        if (pending.fingerprint !== fingerprint) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a different prepared edit.');
        return { ok: true, command, projectEdit: JSON.parse(pending.plan_json) as ProjectEditPlan, pendingEdit: this.editRecord(pending) };
      }
      const projectEdit = this.validateChange(command);
      return { ok: true, command, ...(projectEdit ? { projectEdit } : {}) };
    } catch (error) { return this.failure(error); }
  }

  dispatch(input: unknown, authenticatedContext: AuthenticatedContext): DispatchResult {
    try {
      const command = this.authorize(input, authenticatedContext);
      const fingerprint = this.fingerprint(command, authenticatedContext);
      const result = this.db.transaction(() => {
        const duplicate = this.duplicate(command, fingerprint);
        if (duplicate) return duplicate;
        if (this.validateChange(command)) throw new CoreFault('EXTERNAL_EDIT_REQUIRED', 'This action changes a project file and must use the durable project edit coordinator.');
        const change = this.apply(command);
        return { operation: this.completedOperation(command, change, fingerprint), idempotent: false };
      }).immediate();
      // Returning after the transaction commits is the only successful acknowledgement.
      return { ok: true, snapshot: this.snapshot(), ...result };
    } catch (error) {
      return this.failure(error);
    }
  }

  private apply(command: CoreCommand): AppliedChange {
    const now = this.now();
    switch (command.type) {
      case 'CreateTask': {
        const id = randomUUID();
        this.insertTask({ id, title: command.title, description: command.description, kind: command.kind, projectPath: null, body: '', now });
        this.activate(id);
        return { taskId: id, label: `Created ${command.title}` };
      }
      case 'RecallTask': {
        const task = this.taskRow(command.taskId);
        this.activate(task.id);
        return { taskId: task.id, label: `Returned to ${task.title}` };
      }
      case 'ShowHome': {
        this.deactivate();
        return { taskId: command.taskId, label: 'Returned Home' };
      }
      case 'RenameTask': {
        const task = this.taskRow(command.taskId);
        this.checkRevision(task.revision, command.expectedRevision);
        this.db.prepare('UPDATE tasks SET title=?,revision=revision+1,updated_at=? WHERE id=?').run(command.title, now, task.id);
        this.refreshSearch(task.id);
        return { taskId: task.id, label: `Renamed to ${command.title}`, target: 'taskTitle', before: task.title, after: command.title, revision: task.revision + 1 };
      }
      case 'UpdateCanvas': {
        const before = this.targetState(command.taskId, 'canvas');
        this.checkRevision(before.revision, command.expectedRevision);
        this.db.prepare('INSERT INTO canvases VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at').run(command.taskId, stableJson(command.document), before.revision + 1, now);
        this.touch(command.taskId);
        this.refreshSearch(command.taskId);
        return { taskId: command.taskId, label: 'Updated canvas', target: 'canvas', before: before.value, after: command.document, revision: before.revision + 1 };
      }
      case 'UpdateNote': {
        const note = this.db.prepare('SELECT * FROM notes WHERE task_id=?').get(command.taskId) as NoteRow;
        this.checkRevision(note.revision, command.expectedRevision);
        this.db.prepare('UPDATE notes SET body=?,revision=revision+1,updated_at=? WHERE task_id=?').run(command.body, now, command.taskId);
        this.touch(command.taskId);
        this.refreshSearch(command.taskId);
        return { taskId: command.taskId, label: 'Edited note', target: 'note', before: note.body, after: command.body, revision: note.revision + 1 };
      }
      case 'SaveCheckpoint': {
        const current = this.db.prepare('SELECT revision FROM checkpoints WHERE task_id=?').get(command.taskId) as { revision: number } | undefined;
        this.checkRevision(current?.revision ?? 0, command.expectedRevision);
        this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at').run(command.taskId, stableJson(command.checkpoint), (current?.revision ?? 0) + 1, now);
        return { taskId: command.taskId, label: 'Saved place in task' };
      }
      case 'SetParameter': {
        const current = this.db.prepare('SELECT value,revision,updated_at FROM parameters WHERE task_id=?').get(command.taskId) as JsonRow | undefined;
        if (!current) throw new CoreFault('INVALID_COMMAND', 'This task does not have registered project controls.');
        this.checkRevision(current.revision, command.expectedRevision);
        const before = JSON.parse(current.value) as OrbitParameters;
        const candidate = orbitParametersSchema.safeParse({ ...before, [command.name]: command.value });
        if (!candidate.success) throw new CoreFault('INVALID_COMMAND', 'The parameter value is outside its supported range.', { parameter: command.name });
        this.db.prepare('UPDATE parameters SET value=?,revision=revision+1,updated_at=? WHERE task_id=?').run(stableJson(candidate.data), now, command.taskId);
        this.touch(command.taskId);
        const labels = { theme: 'Changed theme color', durationMinutes: 'Changed next-session duration', transitionMs: 'Changed transition duration', easing: 'Changed easing curve' };
        return { taskId: command.taskId, label: labels[command.name], target: 'parameters', before, after: candidate.data, revision: current.revision + 1 };
      }
      case 'SetTaskPolicy': {
        const current = this.db.prepare('SELECT revision FROM task_policies WHERE task_id=?').get(command.taskId) as JsonRow;
        this.checkRevision(current.revision, command.expectedRevision);
        this.db.prepare('UPDATE task_policies SET value=?,revision=revision+1 WHERE task_id=?').run(stableJson(command.policy), command.taskId);
        // Any in-flight job must be resubmitted under the newly selected policy.
        this.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE task_id=? AND status='running'").run(now, command.taskId);
        return { taskId: command.taskId, label: 'Updated assistance settings' };
      }
      case 'Undo': return this.undo(command);
    }
  }

  private undo(command: Extract<CoreCommand, { type: 'Undo' }>): AppliedChange {
    const row = this.undoRow(command);
    const current = this.targetState(command.taskId, row.target!);
    this.checkRevision(current.revision, row.guard_revision as number);
    if (stableJson(current.value) !== row.after_json) throw new CoreFault('REVISION_CONFLICT', 'Current content no longer matches this edit.');
    const before = JSON.parse(row.before_json!) as unknown;
    const nextRevision = current.revision + 1;
    if (row.target === 'taskTitle') {
      this.db.prepare('UPDATE tasks SET title=?,revision=?,updated_at=? WHERE id=?').run(before, nextRevision, this.now(), command.taskId);
    } else if (row.target === 'canvas') {
      this.db.prepare('UPDATE canvases SET value=?,revision=?,updated_at=? WHERE task_id=?').run(row.before_json, nextRevision, this.now(), command.taskId);
    } else if (row.target === 'note') {
      this.db.prepare('UPDATE notes SET body=?,revision=?,updated_at=? WHERE task_id=?').run(before, nextRevision, this.now(), command.taskId);
    } else {
      this.db.prepare('UPDATE parameters SET value=?,revision=?,updated_at=? WHERE task_id=?').run(row.before_json, nextRevision, this.now(), command.taskId);
    }
    this.db.prepare('UPDATE operations SET undone=1 WHERE id=?').run(row.id);
    // Undo itself advances revisions. Re-arm only the preceding edit whose exact after-state was restored.
    const preceding = this.db.prepare('SELECT * FROM operations WHERE task_id=? AND target=? AND undoable=1 AND undone=0 ORDER BY rowid DESC LIMIT 1').get(command.taskId, row.target) as OperationRow | undefined;
    if (preceding?.after_json === row.before_json) this.db.prepare('UPDATE operations SET guard_revision=? WHERE id=?').run(nextRevision, preceding.id);
    this.touch(command.taskId);
    this.refreshSearch(command.taskId);
    return { taskId: command.taskId, label: `Undid: ${row.label}` };
  }

  private editRecord(row: JournalRow): ProjectEditRecord {
    return { id: row.id, requestId: row.request_id, taskId: row.task_id,
      projectPath: (JSON.parse(row.plan_json) as ProjectEditPlan).projectPath,
      command: JSON.parse(row.command_json) as CoreCommand, plan: JSON.parse(row.plan_json) as ProjectEditPlan,
      // Older journal JSON has no origin field. Default on read without rewriting its captured evidence.
      ...projectEditPreparationSchema.parse(JSON.parse(row.preparation_json)), status: row.status,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) as ProjectEditReceipt : null,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private ownedEdit(id: string, auth: AuthenticatedContext): JournalRow {
    const row = this.db.prepare('SELECT * FROM project_edits WHERE id=?').get(id) as JournalRow | undefined;
    if (!row) throw new CoreFault('NOT_FOUND', 'The project edit journal entry was not found.');
    this.authorize(JSON.parse(row.command_json), auth);
    if (row.actor_id !== auth.actorId || row.origin !== auth.origin) throw new CoreFault('UNAUTHORIZED', 'Only the authenticated initiating coordinator may complete this edit.');
    return row;
  }

  private configParameters(text: string): { values: OrbitParameters; metadata: Record<string, unknown> } {
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid configuration');
      const { theme, durationMinutes, transitionMs, easing, ...metadata } = raw;
      const values = orbitParametersSchema.parse({ theme, durationMinutes, transitionMs, easing });
      return { values, metadata };
    } catch { throw new CoreFault('INVALID_COMMAND', 'The project configuration does not match the registered parameter schema.'); }
  }

  prepareProjectEdit(input: unknown, auth: AuthenticatedContext, preparation: ProjectEditPreparation): PrepareProjectEditResult {
    try {
      const command = this.authorize(input, auth);
      const fingerprint = this.fingerprint(command, auth);
      return this.db.transaction((): PrepareProjectEditResult => {
        const duplicate = this.duplicate(command, fingerprint);
        if (duplicate) return { ok: true, edit: null, resumed: true, duplicate };
        const prior = this.db.prepare('SELECT * FROM project_edits WHERE request_id=?').get(command.requestId) as JournalRow | undefined;
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This request ID belongs to a different prepared edit.');
          if (prior.status === 'aborted') throw new CoreFault('EDIT_CONFLICT', 'This edit was aborted. Prepare a new request from the current content.');
          return { ok: true, edit: this.editRecord(prior), resumed: true };
        }
        const plan = this.validateChange(command);
        if (!plan) throw new CoreFault('INVALID_COMMAND', 'This action has no file-backed parameter change.');
        const parsed = projectEditPreparationSchema.safeParse(preparation);
        if (!parsed.success || !isAbsolute(plan.projectPath)) throw new CoreFault('INVALID_COMMAND', 'The project edit preparation is invalid.');
        const spec = parsed.data;
        const hash = (text: string) => createHash('sha256').update(text).digest('hex');
        if (hash(spec.beforeText) !== spec.beforeHash || hash(spec.afterText) !== spec.afterHash) throw new CoreFault('INVALID_COMMAND', 'The project edit hashes do not match its exact text.');
        const before = this.configParameters(spec.beforeText);
        const after = this.configParameters(spec.afterText);
        if (stableJson(before.values) !== stableJson(plan.before)) throw new CoreFault('EDIT_CONFLICT', 'The project file and parameter state differ. Observe the latest file before preparing a new request.');
        if (stableJson(after.values) !== stableJson(plan.after) || stableJson(before.metadata) !== stableJson(after.metadata)) throw new CoreFault('INVALID_COMMAND', 'The proposed file text changes more than the validated parameter action.');
        const editId = randomUUID();
        const now = this.now();
        this.db.prepare('INSERT INTO project_edits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(editId, command.requestId, plan.taskId, 'prepared', fingerprint, auth.actorId, auth.origin, stableJson(command), stableJson(plan), stableJson(spec), null, now, now);
        return { ok: true, edit: this.editRecord(this.db.prepare('SELECT * FROM project_edits WHERE id=?').get(editId) as JournalRow), resumed: false };
      }).immediate();
    } catch (error) { return this.failure(error); }
  }

  recordProjectEditReceipt(editId: string, receipt: ProjectEditReceipt, auth: AuthenticatedContext): ProjectEditResult {
    try {
      return this.db.transaction((): ProjectEditResult => {
        const row = this.ownedEdit(editId, auth);
        const edit = this.editRecord(row);
        const parsed = projectEditReceiptSchema.safeParse(receipt);
        if (!parsed.success) throw new CoreFault('INVALID_RECEIPT', 'The project writer returned an invalid receipt.');
        const value = parsed.data;
        if (value.operationId !== editId || value.beforeHash !== edit.beforeHash || value.afterHash !== edit.afterHash || value.beforeText !== edit.beforeText || value.afterText !== edit.afterText || resolve(value.file) !== resolve(edit.projectPath, edit.relativePath) || (value.location === 'buffer' && value.documentVersion === undefined)) {
          throw new CoreFault('INVALID_RECEIPT', 'The receipt does not match the exact prepared file or editor edit.');
        }
        if (row.status === 'aborted' || row.status === 'conflict') throw new CoreFault('EDIT_CONFLICT', 'Reconcile the current project content before continuing this edit.');
        if (row.status === 'finalized') return { ok: true, edit };
        this.db.prepare("UPDATE project_edits SET receipt_json=?,status='receipt-recorded',updated_at=? WHERE id=?").run(stableJson(value), this.now(), editId);
        return { ok: true, edit: this.editRecord(this.db.prepare('SELECT * FROM project_edits WHERE id=?').get(editId) as JournalRow) };
      }).immediate();
    } catch (error) { return this.failure(error); }
  }

  finalizeProjectEdit(editId: string, auth: AuthenticatedContext): DispatchResult {
    try {
      const result = this.db.transaction(() => {
        const row = this.ownedEdit(editId, auth);
        const edit = this.editRecord(row);
        const duplicate = this.duplicate(edit.command, row.fingerprint);
        if (duplicate) return { operation: duplicate.operation, idempotent: true };
        if (row.status !== 'receipt-recorded' || !edit.receipt) throw new CoreFault('EDIT_CONFLICT', 'A verified file/editor receipt is required before finalizing this edit.');
        const captured = edit.command.type === 'Undo' ? { ...edit.command, operationId: edit.plan.undoOf } : edit.command;
        // Authorization was captured before the external effect. An unrelated task switch must not orphan that effect.
        // Relevant parameter revision/content and the exclusive journal reservation are still checked here.
        const currentPlan = this.validateChange(captured, true, editId);
        if (!currentPlan || stableJson(currentPlan.before) !== stableJson(edit.plan.before) || stableJson(currentPlan.after) !== stableJson(edit.plan.after)) throw new CoreFault('EDIT_CONFLICT', 'The captured project edit no longer matches the current parameter state.');
        const operation = this.completedOperation(edit.command, this.apply(captured), row.fingerprint);
        this.db.prepare("UPDATE project_edits SET status='finalized',updated_at=? WHERE id=?").run(this.now(), editId);
        return { operation, idempotent: false };
      }).immediate();
      return { ok: true, snapshot: this.snapshot(), ...result };
    } catch (error) { return this.failure(error); }
  }

  listPendingProjectEdits(): ProjectEditRecord[] {
    return (this.db.prepare("SELECT * FROM project_edits WHERE status IN ('prepared','receipt-recorded','conflict') ORDER BY created_at,id").all() as JournalRow[]).map(row => this.editRecord(row));
  }

  reconcileProjectEdit(editId: string, observation: ProjectEditObservation, auth: AuthenticatedContext): ReconcileProjectEditResult {
    try {
      return this.db.transaction((): ReconcileProjectEditResult => {
        const row = this.ownedEdit(editId, auth);
        const edit = this.editRecord(row);
        const observed = projectEditObservationSchema.safeParse(observation);
        if (!observed.success || (observed.data.location === 'buffer' && observed.data.documentVersion === undefined)) throw new CoreFault('INVALID_RECEIPT', 'A current file or editor observation is required.');
        if (row.status === 'finalized') return { ok: true, edit, action: 'complete' };
        if (row.status === 'aborted') return { ok: true, edit, action: 'aborted' };
        if (observed.data.observedHash === edit.afterHash) {
          const receipt: ProjectEditReceipt = { operationId: edit.id, location: observed.data.location, file: resolve(edit.projectPath, edit.relativePath), beforeHash: edit.beforeHash, afterHash: edit.afterHash, beforeText: edit.beforeText, afterText: edit.afterText, ...(observed.data.documentVersion === undefined ? {} : { documentVersion: observed.data.documentVersion }) };
          this.db.prepare("UPDATE project_edits SET status='receipt-recorded',receipt_json=?,updated_at=? WHERE id=?").run(stableJson(receipt), this.now(), editId);
          return { ok: true, edit: this.editRecord(this.db.prepare('SELECT * FROM project_edits WHERE id=?').get(editId) as JournalRow), action: 'finalize' };
        }
        if (observed.data.observedHash === edit.beforeHash && row.status === 'prepared') {
          if (observed.data.location === 'file' && edit.location !== 'file') throw new CoreFault('EDITOR_RECOVERY_REQUIRED', 'Restore and inspect the original editor buffer before deciding that this edit was never applied. The disk before-state alone is insufficient.');
          return { ok: true, edit, action: 'retry' };
        }
        this.db.prepare("UPDATE project_edits SET status='conflict',updated_at=? WHERE id=?").run(this.now(), editId);
        return { ok: true, edit: { ...edit, status: 'conflict', updatedAt: this.now() }, action: 'conflict' };
      }).immediate();
    } catch (error) { return this.failure(error); }
  }

  abortProjectEdit(editId: string, observation: ProjectEditObservation, auth: AuthenticatedContext): ProjectEditResult {
    try {
      const row = this.ownedEdit(editId, auth);
      const edit = this.editRecord(row);
      const observed = projectEditObservationSchema.safeParse(observation);
      if (!observed.success || observed.data.observedHash !== edit.beforeHash || row.status === 'finalized') throw new CoreFault('EDIT_CONFLICT', 'Abort is safe only after verifying the original content is still present.');
      if (observed.data.location === 'buffer' && observed.data.documentVersion === undefined) throw new CoreFault('INVALID_RECEIPT', 'An editor observation needs its current document version.');
      if (observed.data.location === 'file' && edit.location !== 'file') throw new CoreFault('EDITOR_RECOVERY_REQUIRED', 'The disk before-state cannot authorize aborting a buffer or unknown-origin edit. Restore and inspect the editor first.');
      this.db.prepare("UPDATE project_edits SET status='aborted',updated_at=? WHERE id=?").run(this.now(), editId);
      return { ok: true, edit: this.editRecord(this.db.prepare('SELECT * FROM project_edits WHERE id=?').get(editId) as JournalRow) };
    } catch (error) { return this.failure(error); }
  }

  private requireCapability(auth: AuthenticatedContext, capability: Capability, taskId: string): void {
    const parsed = authenticatedContextSchema.safeParse(auth);
    if (!parsed.success || parsed.data.origin === 'model' || !parsed.data.capabilities.includes(capability) || ((parsed.data.taskIds || parsed.data.origin === 'workbench') && !parsed.data.taskIds?.includes(taskId))) throw new CoreFault('UNAUTHORIZED', 'This caller does not have the required task capability.');
    this.taskRow(taskId);
  }

  private get workspaceJournal() {
    return new WorkspaceEditJournal({ db: this.db, now: this.now, snapshot: () => this.snapshot(), fail: (code, message) => { throw new CoreFault(code, message); } });
  }
  prepareWorkspaceEdit(input: unknown, auth: AuthenticatedContext): PrepareWorkspaceEditResult {
    try { return { ok: true, ...this.workspaceJournal.prepare(input, auth) }; } catch (error) { return this.failure(error); }
  }
  lookupWorkspaceEdit(input: unknown, auth: AuthenticatedContext): LookupWorkspaceEditResult {
    try { const edit = this.workspaceJournal.lookup(input, auth); return { ok: true, value: edit ? { edit, snapshot: this.snapshot() } : null }; } catch (error) { return this.failure(error); }
  }
  markWorkspaceEditDispatched(id: string, input: WorkspaceEditDispatch, auth: AuthenticatedContext): DispatchWorkspaceEditResult {
    try { return { ok: true, ...this.workspaceJournal.markDispatched(id, input, auth) }; } catch (error) { return this.failure(error); }
  }
  readWorkspaceEdit(id: string, auth: AuthenticatedContext): WorkspaceEditResult {
    try { return { ok: true, edit: this.workspaceJournal.read(id, auth) }; } catch (error) { return this.failure(error); }
  }
  readWorkspaceEditRequest(requestId: string, auth: AuthenticatedContext): CoreValueResult<WorkspaceEditRecord | null> {
    try { return { ok: true, value: this.workspaceJournal.readRequest(requestId, auth) }; } catch (error) { return this.failure(error); }
  }
  cancelPreparedWorkspaceEdit(id: string, input: WorkspaceEditDispatch, auth: AuthenticatedContext): WorkspaceEditResult {
    try { return { ok: true, edit: this.workspaceJournal.cancelPrepared(id, input, auth) }; } catch (error) { return this.failure(error); }
  }
  recordWorkspaceEditReceipt(id: string, input: WorkspaceEditReceipt, auth: AuthenticatedContext): WorkspaceEditResult {
    try { return { ok: true, edit: this.workspaceJournal.receipt(id, input, auth) }; } catch (error) { return this.failure(error); }
  }
  finalizeWorkspaceEdit(id: string, auth: AuthenticatedContext): WorkspaceEditResult {
    try { const journal = this.workspaceJournal; journal.finalize(id, auth); return { ok: true, edit: journal.read(id, auth) }; } catch (error) { return this.failure(error); }
  }
  listPendingWorkspaceEdits(auth: AuthenticatedContext): CoreValueResult<WorkspaceEditRecord[]> {
    try { return { ok: true, value: this.workspaceJournal.pending(auth) }; } catch (error) { return this.failure(error); }
  }
  reconcileWorkspaceEdit(id: string, input: WorkspaceEditObservation, auth: AuthenticatedContext): ReconcileWorkspaceEditResult {
    try { return { ok: true, ...this.workspaceJournal.reconcile(id, input, auth) }; } catch (error) { return this.failure(error); }
  }
  abortWorkspaceEdit(id: string, input: WorkspaceEditObservation, auth: AuthenticatedContext): WorkspaceEditResult {
    try { return { ok: true, edit: this.workspaceJournal.abort(id, input, auth) }; } catch (error) { return this.failure(error); }
  }

  /** Host-only observation of an already-read file/buffer. This never writes the project. */
  observeProjectParameters(taskId: string, values: OrbitParameters, auth: AuthenticatedContext): CoreValueResult<CoreSnapshot> {
    try {
      this.requireCapability(auth, 'parameters:observe', taskId);
      this.requireParameterAdapter(taskId);
      const parsed = orbitParametersSchema.safeParse(values);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The observed project configuration is invalid.');
      this.db.transaction(() => {
        if (this.db.prepare("SELECT id FROM project_edits WHERE task_id=? AND status IN ('prepared','receipt-recorded','conflict')").get(taskId)) throw new CoreFault('EDIT_PENDING', 'Reconcile the pending project edit before observing another state.');
        const current = this.db.prepare('SELECT value FROM parameters WHERE task_id=?').get(taskId) as JsonRow | undefined;
        if (!current || !this.taskRow(taskId).project_path) throw new CoreFault('INVALID_COMMAND', 'This task has no registered project configuration.');
        const value = stableJson(parsed.data);
        if (current.value !== value) this.db.prepare('UPDATE parameters SET value=?,revision=revision+1,updated_at=? WHERE task_id=?').run(value, this.now(), taskId);
      }).immediate();
      return { ok: true, value: this.snapshot() };
    } catch (error) { return this.failure(error); }
  }

  private validateSourceUrl(value: string | undefined): void {
    if (value === undefined) return;
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new CoreFault('INVALID_COMMAND', 'Sources require a public HTTP(S) reference without embedded credentials.');
  }

  /** The trusted importer has already copied and hashed the original; this stores immutable metadata only. */
  registerAsset(input: unknown, auth: AuthenticatedContext): CoreValueResult<AssetRecord> {
    try {
      const parsed = assetRegistrationSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The asset metadata is invalid.');
      const asset = parsed.data;
      this.requireCapability(auth, 'assets:attach', asset.taskId);
      if (!isAbsolute(asset.managedPath) || (asset.originalPath && !isAbsolute(asset.originalPath))) throw new CoreFault('INVALID_COMMAND', 'Imported asset paths must be absolute.');
      this.validateSourceUrl(asset.provenance.sourceUrl);
      const prior = this.db.prepare('SELECT data,created_at FROM assets WHERE id=?').get(asset.id) as { data: string; created_at: number } | undefined;
      const data = stableJson(asset);
      if (prior) {
        if (prior.data !== data) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'An imported original cannot be replaced under the same asset ID.');
        return { ok: true, value: { ...asset, createdAt: prior.created_at } };
      }
      const createdAt = this.now();
      this.db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run(asset.id, asset.taskId, data, createdAt);
      return { ok: true, value: { ...asset, createdAt } };
    } catch (error) { return this.failure(error); }
  }

  listAssets(taskId: string): AssetRecord[] {
    this.taskRow(taskId);
    return (this.db.prepare('SELECT data,created_at FROM assets WHERE task_id=? ORDER BY created_at,id').all(taskId) as { data: string; created_at: number }[]).map(row => ({ ...JSON.parse(row.data) as AssetRecord, createdAt: row.created_at }));
  }

  registerSource(input: unknown, auth: AuthenticatedContext): CoreValueResult<SourceRecord> {
    try {
      const parsed = sourceRegistrationSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The source metadata or timestamp range is invalid.');
      const source = parsed.data;
      this.requireCapability(auth, 'sources:attach', source.taskId);
      this.validateSourceUrl(source.url);
      this.validateSourceUrl(source.provenance.sourceUrl);
      if (source.assetId && !this.db.prepare('SELECT id FROM assets WHERE id=? AND task_id=?').get(source.assetId, source.taskId)) throw new CoreFault('NOT_FOUND', 'The source must reference an imported asset belonging to this task.');
      const prior = this.db.prepare('SELECT data,created_at FROM sources WHERE id=?').get(source.id) as { data: string; created_at: number } | undefined;
      const data = stableJson(source);
      if (prior) {
        if (prior.data !== data) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'This source ID already identifies different provenance.');
        return { ok: true, value: { ...source, createdAt: prior.created_at } };
      }
      const createdAt = this.now();
      this.db.prepare('INSERT INTO sources VALUES (?,?,?,?)').run(source.id, source.taskId, data, createdAt);
      return { ok: true, value: { ...source, createdAt } };
    } catch (error) { return this.failure(error); }
  }

  listSources(taskId: string): SourceRecord[] {
    this.taskRow(taskId);
    return (this.db.prepare('SELECT data,created_at FROM sources WHERE task_id=? ORDER BY created_at,id').all(taskId) as { data: string; created_at: number }[]).map(row => ({ ...JSON.parse(row.data) as SourceRecord, createdAt: row.created_at }));
  }

  private jobRecord(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT id,task_id AS taskId,task_epoch AS taskEpoch,generation,status,created_at AS createdAt,updated_at AS updatedAt FROM jobs WHERE id=?').get(id) as JobRecord | undefined;
    return row;
  }

  beginJob(input: JobRegistration, auth: AuthenticatedContext): CoreValueResult<JobRecord> {
    try {
      const parsed = jobRegistrationSchema.safeParse(input);
      if (!parsed.success) throw new CoreFault('INVALID_COMMAND', 'The job registration is invalid.');
      const job = parsed.data;
      this.requireCapability(auth, 'jobs:manage', job.taskId);
      if (this.taskRow(job.taskId).epoch !== job.taskEpoch) throw new CoreFault('STALE_EPOCH', 'The task changed before this job began.');
      const policy = JSON.parse((this.db.prepare('SELECT value FROM task_policies WHERE task_id=?').get(job.taskId) as JsonRow).value) as TaskPolicy;
      if ((job.background && policy.assistancePaused) || (job.provider === 'cloud' && policy.processing === 'local-only')) throw new CoreFault('JOB_CANCELLED', 'The task policy does not permit this job.');
      const prior = this.jobRecord(job.id);
      if (prior && (prior.taskId !== job.taskId || job.generation < prior.generation)) throw new CoreFault('IDEMPOTENCY_CONFLICT', 'The job ID or generation is not current.');
      if (prior && job.generation === prior.generation) {
        if (prior.status !== 'running' || prior.taskEpoch !== job.taskEpoch) throw new CoreFault('JOB_CANCELLED', 'This job generation has already ended.');
        return { ok: true, value: prior };
      }
      const now = this.now();
      this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_epoch=excluded.task_epoch,generation=excluded.generation,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at').run(job.id, job.taskId, job.taskEpoch, job.generation, 'running', now, now);
      return { ok: true, value: this.jobRecord(job.id)! };
    } catch (error) { return this.failure(error); }
  }

  isJobCurrent(id: string, generation: number): boolean {
    const job = this.jobRecord(id);
    return Boolean(job && job.status === 'running' && job.generation === generation && this.taskRow(job.taskId).epoch === job.taskEpoch);
  }

  endJob(id: string, generation: number, status: 'cancelled' | 'completed', auth: AuthenticatedContext): CoreValueResult<JobRecord> {
    try {
      const job = this.jobRecord(id);
      if (!job) throw new CoreFault('NOT_FOUND', 'This job was not found.');
      this.requireCapability(auth, 'jobs:manage', job.taskId);
      if (!['cancelled', 'completed'].includes(status)) throw new CoreFault('INVALID_COMMAND', 'Invalid terminal job state.');
      if (job.generation !== generation) throw new CoreFault('JOB_CANCELLED', 'A later generation owns this job.');
      if (job.status === 'running') this.db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=?').run(status, this.now(), id);
      return { ok: true, value: this.jobRecord(id)! };
    } catch (error) { return this.failure(error); }
  }

  private touch(taskId: string): void { this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(this.now(), taskId); }
  private refreshSearch(taskId: string): void {
    this.db.prepare('DELETE FROM task_search WHERE task_id=?').run(taskId);
    const task = this.taskRow(taskId);
    const note = this.db.prepare('SELECT body FROM notes WHERE task_id=?').get(taskId) as { body: string };
    const canvas = this.targetState(taskId, 'canvas').value;
    this.db.prepare('INSERT INTO task_search(task_id,title,description,body) VALUES (?,?,?,?)').run(taskId, task.title, task.description, note.body + (canvas ? '\n' + JSON.stringify(canvas) : ''));
  }

  search(query: string): SearchResult[] {
    if (typeof query !== 'string' || query.length > 1000) return [];
    if (!query.trim()) return this.snapshot().tasks.slice(0, 30).map(task => ({ taskId: task.id, title: task.title, excerpt: task.description, score: 0 }));
    const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
    if (!tokens.length) return [];
    const match = tokens.map(token => `"${token}"*`).join(' AND ');
    return this.db.prepare("SELECT task_id AS taskId,title,snippet(task_search,-1,'','',' … ',30) AS excerpt,bm25(task_search,0,10,3,1) AS score FROM task_search WHERE task_search MATCH ? ORDER BY score LIMIT 30").all(match) as SearchResult[];
  }

  /** Operational metadata only; no note text, credentials, or database contents. */
  diagnostics(): { schemaVersion: number; journalMode: string; synchronous: number; foreignKeys: boolean; lockingMode: string } {
    return { schemaVersion: this.db.pragma('user_version', { simple: true }) as number,
      journalMode: this.db.pragma('journal_mode', { simple: true }) as string,
      synchronous: this.db.pragma('synchronous', { simple: true }) as number,
      foreignKeys: this.db.pragma('foreign_keys', { simple: true }) === 1,
      lockingMode: this.db.pragma('locking_mode', { simple: true }) as string };
  }

  /** The host holds its full writer barrier; no second connection reads live SQLite. */
  async backupDatabase(destination: string, options: { signal?: AbortSignal } = {}): Promise<CoreBackupReceipt> {
    if (this.closed || this.backupInFlight) throw new CoreMaintenanceError('BUSY', 'The core must be open and finish its current snapshot before starting another.');
    this.backupInFlight = true;
    try { return await writeCoreSnapshot(this.db, destination, options); }
    finally { this.backupInFlight = false; }
  }

  close(): void {
    if (this.closed) return;
    if (this.backupInFlight) throw new CoreMaintenanceError('BUSY', 'Wait for the database snapshot to finish or cancel before closing core.');
    this.db.close();
    this.closed = true;
  }
}
