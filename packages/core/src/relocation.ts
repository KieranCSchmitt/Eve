import Database from 'better-sqlite3';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canvasDocumentSchema, canvasImageAssetIds, canvasReferencedBlocks, assetRegistrationSchema, checkpointSchema, coreCommandSchema, idSchema, orbitParametersSchema, projectEditPreparationSchema, projectEditReceiptSchema, projectRecordSchema, sourceRegistrationSchema, taskPolicySchema, prepareWorkspaceEditSchema, workspaceEditReceiptSchema, workspaceEditStatusSchema, type AssetRegistration, type ProjectRecord } from '../../contracts/src/index';
import { workspaceHash, workspaceJson, workspaceReceiptMatches } from './workspace-edits';
import { inspectPath, syncDirectory, verifyChain } from '../../imports/src/filesystem';
import { absent, checkMaintenanceSignal, CoreMaintenanceError, digestDatabase, syncFile, verifySqliteIntegrity } from './maintenance';

export interface CoreSchemaEntry { type: string; name: string; tbl_name: string; sql: string | null }
export interface CoreRelocationOptions {
  stagingProfile: string;
  destinationProfile: string;
  originalProfileRoot: string;
  expectedSchemaVersion: number;
  includedFiles: readonly { path: string; sha256: string; bytes: number }[];
  includedDirectories: readonly string[];
  signal?: AbortSignal;
}
export interface CorePathReference {
  field: string;
  kind: 'profile-owned' | 'external' | 'web' | 'untitled';
  before: string;
  after: string;
  included: boolean;
}
/** A database receipt only. The composing host must validate the other files. */
export interface CoreRelocationReceipt {
  databaseValidated: true;
  schemaVersion: number;
  changedFiles: string[];
  references: CorePathReference[];
  assets: { id: string; manifestPath: string; before: AssetRegistration; after: AssetRegistration }[];
  projects: { taskId: string; projectId?: string; referenceField: string; before: string; after: string; external: boolean }[];
  remainingMetadata: { path: string; kind: 'asset-manifest' | 'project-manifest' | 'workbench-recovery' }[];
  notes: string[];
}
const number = z.number().int().nonnegative();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (code: 'UNSAFE_REFERENCE' | 'UNSUPPORTED_SCHEMA' | 'INVALID_DATABASE', message: string): never => { throw new CoreMaintenanceError(code, message); };
const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return fail('INVALID_DATABASE', 'A stored JSON record cannot be validated.'); } };
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const result = schema.safeParse(input); if (!result.success) return fail('UNSUPPORTED_SCHEMA', 'A stored record uses an unsupported or invalid format.'); return result.data; };
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
const relativePath = (value: string) => !!value && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value) && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
function absolute(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value) || value.split('/').includes('..')) fail('UNSAFE_REFERENCE', 'A stored filesystem reference is not a supported canonical absolute path.');
  return value;
}
const taskSchema = z.object({ id: idSchema, title: z.string(), description: z.string(), kind: z.enum(['project', 'note']), project_path: z.string().nullable(), revision: number, epoch: number, created_at: number, updated_at: number }).strict();
const jsonRowSchema = z.object({ task_id: idSchema, value: z.string(), revision: number, updated_at: number }).strict();
const storedSchema = z.object({ id: idSchema, task_id: idSchema, data: z.string(), created_at: number }).strict();
const planSchema = z.object({ taskId: idSchema, projectPath: z.string(), before: orbitParametersSchema, after: orbitParametersSchema, undoOf: idSchema.optional() }).strict();
const journalSchema = z.object({ id: idSchema, request_id: idSchema, task_id: idSchema, status: z.enum(['prepared', 'receipt-recorded', 'finalized', 'conflict', 'aborted']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), actor_id: idSchema, origin: z.enum(['trusted-ui', 'workbench']), command_json: z.string(), plan_json: z.string(), preparation_json: z.string(), receipt_json: z.string().nullable(), created_at: number, updated_at: number }).strict();
const operationSchema = z.object({ id: idSchema, request_id: idSchema, task_id: idSchema, type: z.enum(['CreateTask', 'RenameTask', 'RecallTask', 'ShowHome', 'UpdateCanvas', 'UpdateNote', 'SaveCheckpoint', 'SetParameter', 'Undo', 'SetTaskPolicy', 'ApplyWorkspaceEdit', 'UndoWorkspaceEdit']), label: z.string(), created_at: number, undoable: z.union([z.literal(0), z.literal(1)]), undone: z.union([z.literal(0), z.literal(1)]), target: z.enum(['note', 'parameters', 'taskTitle', 'canvas']).nullable(), before_json: z.string().nullable(), after_json: z.string().nullable(), guard_revision: number.nullable() }).strict();
const workspaceRowSchema = z.object({ id: idSchema, request_id: idSchema, task_id: idSchema, project_id: idSchema, status: workspaceEditStatusSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), actor_id: idSchema, origin: z.literal('trusted-ui'), plan_hash: z.string().regex(/^[a-f0-9]{64}$/), input_json: z.string(), project_root: z.string(), restored: z.union([z.literal(0), z.literal(1)]), receipt_json: z.string().nullable(), operation_id: idSchema.nullable(), created_at: number, updated_at: number }).strict();

export const coreSchemaEntries = (database: Database.Database): CoreSchemaEntry[] => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as CoreSchemaEntry[];
const schemaIdentity = (entries: CoreSchemaEntry[]) => JSON.stringify(entries.map(entry => ({ ...entry, sql: entry.sql?.replace(/\s+/g, ' ').trim() ?? null })));

/** Called with a schema template from this exact CoreStore version, never a live-profile handle. */
export async function relocateOfflineDatabase(options: CoreRelocationOptions, template: { version: number; entries: CoreSchemaEntry[] }): Promise<CoreRelocationReceipt> {
  checkMaintenanceSignal(options.signal);
  const original = absolute(options.originalProfileRoot), destination = absolute(options.destinationProfile), staging = absolute(options.stagingProfile);
  if (original === destination || original === staging || destination === staging || inside(original, staging) || inside(original, destination) || inside(staging, destination) || inside(destination, staging)) fail('UNSAFE_REFERENCE', 'Relocation requires a separate offline staging profile and a new independent destination.');
  if (![3, 4, 5, 6].includes(options.expectedSchemaVersion) || options.expectedSchemaVersion !== template.version) throw new CoreMaintenanceError('VERSION_REFUSED', 'This core can relocate only the explicitly supported exact v3, v4, v5 and v6 schemas.');
  const root = await inspectPath(staging);
  if (!root.stat.isDirectory() || (root.stat.mode & 0o077) !== 0 || (process.getuid && root.stat.uid !== process.getuid())) throw new CoreMaintenanceError('UNSAFE_DESTINATION', 'Restore staging must be private and owned by this user.');
  await absent(destination);
  if (options.includedFiles.length > 100_000 || options.includedDirectories.length > 100_000) fail('UNSAFE_REFERENCE', 'The restore namespace exceeds the supported bounds.');
  const files = new Map<string, { path: string; sha256: string; bytes: number }>();
  for (const entry of options.includedFiles) {
    if (!relativePath(entry.path) || entry.path.length > 4096 || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 1024 ** 3 || files.has(entry.path)) fail('UNSAFE_REFERENCE', 'The admitted restore namespace is invalid.');
    files.set(entry.path, entry);
  }
  const directories = new Set(options.includedDirectories);
  if (directories.size !== options.includedDirectories.length || [...directories].some(entry => !relativePath(entry))) fail('UNSAFE_REFERENCE', 'The admitted restore directories are invalid.');
  if (!files.has('eve.db')) fail('INVALID_DATABASE', 'The admitted restore namespace has no Eve database.');
  const databasePath = path.join(staging, 'eve.db');
  const file = await inspectPath(databasePath);
  if (!file.stat.isFile()) fail('INVALID_DATABASE', 'Restore needs a regular offline Eve database.');
  await absent(databasePath + '-wal'); await absent(databasePath + '-shm');
  const digest = await digestDatabase(databasePath, options.signal), admittedDatabase = files.get('eve.db')!;
  if (digest.bytes !== admittedDatabase.bytes || digest.sha256 !== admittedDatabase.sha256) fail('INVALID_DATABASE', 'The staged database bytes do not match the verified backup manifest.');
  const references: CorePathReference[] = [];
  const assets: CoreRelocationReceipt['assets'] = [];
  const projectReferences: CoreRelocationReceipt['projects'] = [];
  const notes: string[] = [];
  const remainingMetadata = new Map<string, CoreRelocationReceipt['remainingMetadata'][number]>();
  const mapPath = (value: string, field: string, requireIncluded = false) => {
    absolute(value);
    if (inside(staging, value) || inside(destination, value)) fail('UNSAFE_REFERENCE', 'A stored reference unexpectedly targets staging or the new destination before relocation.');
    if (!inside(original, value)) {
      if (requireIncluded) fail('UNSAFE_REFERENCE', 'A managed original is outside the backed-up profile and cannot be claimed as restored.');
      references.push({ field, kind: 'external', before: value, after: value, included: false }); return value;
    }
    const relative = path.relative(original, value).split(path.sep).join('/');
    const included = !relative || files.has(relative) || directories.has(relative);
    if (requireIncluded && !included) fail('UNSAFE_REFERENCE', 'A required profile-owned artifact was not included in this backup.');
    const mapped = path.join(destination, relative);
    references.push({ field, kind: 'profile-owned', before: value, after: mapped, included }); return mapped;
  };
  const mapDocument = (value: string, field: string) => {
    if (value.startsWith('file:')) {
      let url: URL; let filePath: string;
      try { url = new URL(value); filePath = fileURLToPath(url); } catch { return fail('UNSAFE_REFERENCE', 'An editor file URI is invalid.'); }
      if (url.username || url.password || url.search || url.hash || (url.hostname && url.hostname !== 'localhost')) fail('UNSAFE_REFERENCE', 'An editor file URI uses unsupported authority or decorations.');
      return pathToFileURL(mapPath(filePath, field)).href;
    }
    if (value.startsWith('untitled:') && !/[\u0000-\u001f\u007f]/.test(value)) {
      references.push({ field, kind: 'untitled', before: value, after: value, included: false }); return value;
    }
    return mapPath(value, field);
  };
  const classifyWeb = (value: string | undefined, field: string) => {
    if (value === undefined) return;
    let url: URL; try { url = new URL(value); } catch { return fail('UNSAFE_REFERENCE', 'A source URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('UNSAFE_REFERENCE', 'A source URL is not an admitted public HTTP(S) reference.');
    references.push({ field, kind: 'web', before: value, after: value, included: false });
  };
  const database = new Database(databasePath, { fileMustExist: true, timeout: 100 });
  try {
    database.pragma('trusted_schema = OFF'); database.pragma('foreign_keys = ON'); database.pragma('locking_mode = EXCLUSIVE');
    if (database.pragma('user_version', { simple: true }) !== options.expectedSchemaVersion) throw new CoreMaintenanceError('VERSION_REFUSED', 'The actual SQLite schema version does not match the backup manifest.');
    if (schemaIdentity(coreSchemaEntries(database)) !== schemaIdentity(template.entries)) fail('UNSUPPORTED_SCHEMA', 'The database tables, indexes, or triggers do not match the supported Eve schema.');
    verifySqliteIntegrity(database);
    const setJson = (table: 'assets' | 'sources' | 'checkpoints' | 'project_edits', column: string, key: string, id: string, previous: unknown, next: unknown) => {
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      database.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(JSON.stringify(next), id);
    };
    database.transaction(() => {
      const tasks = (database.prepare('SELECT * FROM tasks').all()).map(row => parse(taskSchema, row));
      const taskIds = new Set(tasks.map(task => task.id));
      const projects = new Map(tasks.map(task => [task.id, task.project_path]));
      const originalProjects = new Map<string, ProjectRecord>();
      if (template.version >= 4) {
        if (tasks.some(task => task.project_path !== null)) fail('INVALID_DATABASE', 'A v4 task has a legacy path outside its project registry.');
        const records = new Map<string, ProjectRecord>();
        for (const raw of database.prepare('SELECT * FROM projects').all()) {
          const row = parse(z.object({ id: idSchema, canonical_root: z.string(), device: z.string().nullable(), inode: z.string().nullable(), data: z.string() }).strict(), raw);
          const record = parse(projectRecordSchema, json(row.data));
          if (record.id !== row.id || record.canonicalRoot !== row.canonical_root || (record.rootIdentity?.device ?? null) !== row.device || (record.rootIdentity?.inode ?? null) !== row.inode) fail('INVALID_DATABASE', 'A project registry row disagrees with its recorded identity.');
          absolute(record.canonicalRoot); records.set(record.id, record);
          originalProjects.set(record.id, record);
        }
        const bound = new Set<string>();
        for (const raw of database.prepare('SELECT * FROM task_projects').all()) {
          const binding = parse(z.object({ task_id: idSchema, project_id: idSchema }).strict(), raw);
          const before = records.get(binding.project_id) ?? fail('INVALID_DATABASE', 'A project binding has no registered identity.');
          if (!taskIds.has(binding.task_id) || bound.has(before.id)) fail('INVALID_DATABASE', 'A project has an invalid or duplicate task binding.');
          bound.add(before.id); projects.set(binding.task_id, before.canonicalRoot);
          const referenceField = `projects.${before.id}.canonicalRoot`;
          const canonicalRoot = mapPath(before.canonicalRoot, referenceField);
          projectReferences.push({ taskId: binding.task_id, projectId: before.id, referenceField, before: before.canonicalRoot, after: canonicalRoot, external: !inside(original, before.canonicalRoot) });
          // A copied tree or an external reference has not been inspected on
          // this machine. Retain configuration, never reusable execution identity.
          const after: ProjectRecord = { ...before, canonicalRoot, rootIdentity: null, verification: 'legacy-unverified', revision: before.revision + 1 };
          parse(projectRecordSchema, after);
          database.prepare('UPDATE projects SET canonical_root=?,device=NULL,inode=NULL,data=? WHERE id=?').run(canonicalRoot, JSON.stringify(after), before.id);
        }
        if (bound.size !== records.size) fail('INVALID_DATABASE', 'A registered project is missing its task binding.');
        for (const raw of database.prepare('SELECT * FROM project_requests').all()) {
          const row = parse(z.object({ request_id: idSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), project_id: idSchema, kind: z.enum(['register', 'verify']) }).strict(), raw);
          if (!records.has(row.project_id) || database.prepare('SELECT request_id FROM requests WHERE request_id=? UNION ALL SELECT request_id FROM project_edits WHERE request_id=?').get(row.request_id, row.request_id)) fail('INVALID_DATABASE', 'A project request has inconsistent identity or conflicts with another action.');
          // Fingerprints remain exact; retries return the current project and
          // canonical snapshot, never a historical path or old verification.
        }
        if (records.size) notes.push('Restored project identities require fresh host inspection; saved directory device/inode values were cleared.');
      }
      for (const row of database.prepare('SELECT key,value FROM meta').all() as { key: string; value: string }[]) {
        if (!['initialized', 'activeTaskId'].includes(row.key) || (row.key === 'initialized' && row.value !== '1') || (row.key === 'activeTaskId' && !taskIds.has(row.value))) fail('UNSUPPORTED_SCHEMA', 'The profile has unsupported core metadata.');
      }
      for (const task of tasks) {
        checkMaintenanceSignal(options.signal);
        if (task.project_path !== null) {
          const mapped = mapPath(task.project_path, `tasks.${task.id}.project_path`);
          projectReferences.push({ taskId: task.id, referenceField: `tasks.${task.id}.project_path`, before: task.project_path, after: mapped, external: !inside(original, task.project_path) });
          if (mapped !== task.project_path) database.prepare('UPDATE tasks SET project_path=? WHERE id=?').run(mapped, task.id);
        }
      }
      for (const raw of database.prepare('SELECT * FROM notes').all()) parse(z.object({ id: idSchema, task_id: idSchema, body: z.string().max(1_000_000), revision: number, updated_at: number }).strict(), raw);
      const canvasDocuments: { taskId: string; document: z.infer<typeof canvasDocumentSchema> | null }[] = [];
      if (template.version >= 6) for (const raw of database.prepare('SELECT * FROM canvases').all()) {
        const row = parse(jsonRowSchema, raw);
        canvasDocuments.push({ taskId: row.task_id, document: parse(canvasDocumentSchema.nullable(), json(row.value)) });
      }
      for (const raw of database.prepare('SELECT * FROM parameters').all()) { const row = parse(jsonRowSchema, raw); parse(orbitParametersSchema, json(row.value)); }
      for (const raw of database.prepare('SELECT * FROM task_policies').all()) { const row = parse(z.object({ task_id: idSchema, value: z.string(), revision: number }).strict(), raw); parse(taskPolicySchema, json(row.value)); }
      if ((database.prepare('SELECT id FROM tasks WHERE id NOT IN (SELECT task_id FROM notes) OR id NOT IN (SELECT task_id FROM task_policies)').all()).length) fail('INVALID_DATABASE', 'A task is missing its required note or assistance policy.');
      const operations = new Map<string, z.infer<typeof operationSchema>>();
      for (const raw of database.prepare('SELECT * FROM operations').all()) {
        const row = parse(operationSchema, raw); operations.set(row.id, row);
        if (template.version < 5 && ['ApplyWorkspaceEdit', 'UndoWorkspaceEdit'].includes(row.type)) fail('UNSUPPORTED_SCHEMA', 'A historical schema cannot contain workspace transaction history.');
        if (template.version < 6 && (row.type === 'UpdateCanvas' || row.target === 'canvas')) fail('UNSUPPORTED_SCHEMA', 'A historical schema cannot contain canvas history.');
        if (row.target === null) {
          if (row.before_json !== null || row.after_json !== null || row.guard_revision !== null || row.undoable !== 0) fail('UNSUPPORTED_SCHEMA', 'An operation has unsupported captured state.');
        } else {
          const expectedType = { note: 'UpdateNote', taskTitle: 'RenameTask', parameters: 'SetParameter', canvas: 'UpdateCanvas' }[row.target];
          if (row.type !== expectedType || row.before_json === null || row.after_json === null || row.guard_revision === null || row.undoable !== 1) fail('INVALID_DATABASE', 'An undo operation has inconsistent captured state.');
          // These are authored strings or path-free parameter values, never an
          // executable snapshot or a path template. Preserve their exact bytes.
          if (row.target === 'canvas') {
            // Undo can bring the earlier document back. Validate its references
            // against this same task after the saved materials have been read.
            canvasDocuments.push({ taskId: row.task_id, document: parse(canvasDocumentSchema.nullable(), json(row.before_json!)) });
            canvasDocuments.push({ taskId: row.task_id, document: parse(canvasDocumentSchema, json(row.after_json!)) });
          } else {
            const schema: z.ZodType<unknown> = row.target === 'parameters' ? orbitParametersSchema : z.string().max(row.target === 'note' ? 1_000_000 : 120);
            parse(schema, json(row.before_json!)); parse(schema, json(row.after_json!));
          }
        }
      }
      for (const raw of database.prepare('SELECT * FROM requests').all()) {
        const row = parse(z.object({ request_id: idSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), operation_id: idSchema }).strict(), raw);
        if (operations.get(row.operation_id)?.request_id !== row.request_id) fail('INVALID_DATABASE', 'An idempotency receipt refers to a different operation.');
      }
      for (const raw of database.prepare('SELECT * FROM checkpoints').all()) {
        const row = parse(jsonRowSchema, raw); const before = parse(checkpointSchema, json(row.value)); const after = structuredClone(before);
        if (before.selectedFile !== undefined) after.selectedFile = mapDocument(before.selectedFile, `checkpoints.${row.task_id}.selectedFile`);
        setJson('checkpoints', 'value', 'task_id', row.task_id, before, after);
      }
      const assetTasks = new Map<string, string>(), assetMediaTypes = new Map<string, string>();
      for (const raw of database.prepare('SELECT * FROM assets').all()) {
        checkMaintenanceSignal(options.signal);
        const row = parse(storedSchema, raw); const before = parse(assetRegistrationSchema, json(row.data)); const after = structuredClone(before);
        if (row.id !== before.id || row.task_id !== before.taskId) fail('INVALID_DATABASE', 'An asset identity disagrees with its stored record.');
        after.managedPath = mapPath(before.managedPath, `assets.${row.id}.managedPath`, true);
        const relative = path.relative(original, before.managedPath).split(path.sep).join('/'); const admitted = files.get(relative);
        if (!admitted || admitted.sha256 !== before.sha256 || admitted.bytes !== before.byteLength) fail('INVALID_DATABASE', 'A managed original does not match its admitted backup bytes.');
        if (before.originalPath) after.originalPath = mapPath(before.originalPath, `assets.${row.id}.originalPath`);
        classifyWeb(before.provenance.sourceUrl, `assets.${row.id}.provenance.sourceUrl`);
        const manifestPath = path.posix.join(path.posix.dirname(relative), 'manifest.json');
        if (!files.has(manifestPath)) fail('UNSAFE_REFERENCE', 'A managed original is missing its import manifest.');
        remainingMetadata.set(manifestPath, { path: manifestPath, kind: 'asset-manifest' });
        assets.push({ id: row.id, manifestPath, before, after });
        setJson('assets', 'data', 'id', row.id, before, after); assetTasks.set(row.id, row.task_id); assetMediaTypes.set(row.id, before.mediaType);
      }
      const sourceTasks = new Map<string, string>();
      for (const raw of database.prepare('SELECT * FROM sources').all()) {
        const row = parse(storedSchema, raw); const source = parse(sourceRegistrationSchema, json(row.data));
        if (source.id !== row.id || source.taskId !== row.task_id || (source.assetId && assetTasks.get(source.assetId) !== source.taskId)) fail('INVALID_DATABASE', 'A source does not belong to its recorded task and material.');
        classifyWeb(source.url, `sources.${row.id}.url`); classifyWeb(source.provenance.sourceUrl, `sources.${row.id}.provenance.sourceUrl`);
        sourceTasks.set(row.id, row.task_id);
        // Source excerpts and attribution are authored evidence, never path templates.
      }
      for (const { taskId, document } of canvasDocuments) {
        checkMaintenanceSignal(options.signal);
        for (const block of document ? canvasReferencedBlocks(document) : []) {
          if (canvasImageAssetIds(block).some(id => assetTasks.get(id) !== taskId || !assetMediaTypes.get(id)?.startsWith('image/'))) fail('INVALID_DATABASE', 'A canvas image is not attached to its space.');
          for (const id of block.sourceIds) if (sourceTasks.get(id) !== taskId) fail('INVALID_DATABASE', 'A canvas source is not attached to its space.');
        }
      }
      for (const raw of database.prepare('SELECT * FROM project_edits').all()) {
        checkMaintenanceSignal(options.signal);
        const row = parse(journalSchema, raw); const command = parse(coreCommandSchema, json(row.command_json)); const plan = parse(planSchema, json(row.plan_json)); const preparation = parse(projectEditPreparationSchema, json(row.preparation_json));
        if (!['SetParameter', 'Undo'].includes(command.type) || !('taskId' in command) || command.taskId !== row.task_id || command.requestId !== row.request_id || plan.taskId !== row.task_id || projects.get(row.task_id) !== plan.projectPath || hash(preparation.beforeText) !== preparation.beforeHash || hash(preparation.afterText) !== preparation.afterHash) fail('INVALID_DATABASE', 'A project edit journal has inconsistent identity or captured content.');
        const nextPlan = { ...plan, projectPath: mapPath(plan.projectPath, `project_edits.${row.id}.plan.projectPath`) };
        setJson('project_edits', 'plan_json', 'id', row.id, plan, nextPlan);
        if (row.receipt_json !== null) {
          const receipt = parse(projectEditReceiptSchema, json(row.receipt_json));
          if (receipt.operationId !== row.id || receipt.file !== path.join(plan.projectPath, preparation.relativePath) || receipt.beforeHash !== preparation.beforeHash || receipt.afterHash !== preparation.afterHash || receipt.beforeText !== preparation.beforeText || receipt.afterText !== preparation.afterText || (receipt.location === 'buffer' && receipt.documentVersion === undefined)) fail('INVALID_DATABASE', 'A project receipt does not match its captured edit.');
          setJson('project_edits', 'receipt_json', 'id', row.id, receipt, { ...receipt, file: mapPath(receipt.file, `project_edits.${row.id}.receipt.file`) });
        }
        if (['prepared', 'receipt-recorded', 'conflict'].includes(row.status)) notes.push(`Project edit ${row.id} remains pending and requires reconciliation before further project changes.`);
        // Exact before/after document strings, command JSON, fingerprint and
        // operation receipts stay intact; no old command is replayed here.
      }
      if (template.version >= 5) {
        const rows = (database.prepare('SELECT * FROM workspace_edits').all()).map(raw => parse(workspaceRowSchema, raw));
        const indexed = new Map(rows.map(row => [row.id, row]));
        const leased = new Set<string>(), workspaceOperations = new Set<string>();
        const inverses = new Map<string, string>(), finalizedInverses = new Map<string, string>();
        for (const row of rows) {
          const input = parse(prepareWorkspaceEditSchema, json(row.input_json));
          const project = originalProjects.get(row.project_id) ?? fail('INVALID_DATABASE', 'A workspace journal has no registered project.');
          if (input.requestId !== row.request_id || input.taskId !== row.task_id || input.projectId !== row.project_id || !project || projects.get(row.task_id) !== project.canonicalRoot || row.project_root !== project.canonicalRoot
            || input.documents.some(document => workspaceHash(document.beforeText) !== document.beforeHash || workspaceHash(document.afterText) !== document.afterHash)
            || row.plan_hash !== workspaceHash(workspaceJson(input)) || row.fingerprint !== workspaceHash(workspaceJson({ kind: 'workspace-edit', input, actorId: row.actor_id, origin: row.origin }))) fail('INVALID_DATABASE', 'A workspace preparation has inconsistent identity, fingerprint, binding or text.');
          if (!row.restored && (project.verification !== 'verified' || project.revision !== input.expectedProjectRevision || workspaceJson(project.rootIdentity) !== workspaceJson(input.expectedRootIdentity))) fail('INVALID_DATABASE', 'An original workspace preparation lacks its captured verified project identity.');
          if (project.adapter === 'orbit' && input.documents.some(document => document.relativePath === 'eve.project.json')) fail('INVALID_DATABASE', 'A workspace journal bypasses the Orbit configuration coordinator.');
          if (database.prepare('SELECT request_id FROM project_edits WHERE request_id=? UNION ALL SELECT request_id FROM project_requests WHERE request_id=?').get(row.request_id, row.request_id)) fail('INVALID_DATABASE', 'A workspace request conflicts with another action namespace.');
          const receipt = row.receipt_json === null ? null : parse(workspaceEditReceiptSchema, json(row.receipt_json));
          if (receipt && !workspaceReceiptMatches(row.id, row.plan_hash, input, receipt)) fail('INVALID_DATABASE', 'A workspace receipt does not match its exact preparation.');
          if ((['receipt-recorded', 'finalized'].includes(row.status) && !receipt) || (['prepared', 'dispatched', 'aborted'].includes(row.status) && receipt)) fail('INVALID_DATABASE', 'A workspace journal status disagrees with its receipt.');
          const request = database.prepare('SELECT fingerprint,operation_id FROM requests WHERE request_id=?').get(row.request_id) as { fingerprint: string; operation_id: string } | undefined;
          if (row.status === 'finalized') {
            const operation = (row.operation_id ? operations.get(row.operation_id) : undefined) ?? fail('INVALID_DATABASE', 'A finalized workspace journal has no history entry.');
            if (!operation || operation.request_id !== row.request_id || operation.task_id !== row.task_id || operation.type !== (input.undoOf ? 'UndoWorkspaceEdit' : 'ApplyWorkspaceEdit') || operation.label !== input.label || operation.undoable || operation.target !== null || request?.operation_id !== operation.id || request.fingerprint !== row.fingerprint) fail('INVALID_DATABASE', 'A finalized workspace journal has no matching history and idempotency receipt.');
            workspaceOperations.add(operation.id);
          } else if (row.operation_id !== null || request) fail('INVALID_DATABASE', 'An unfinished workspace journal has an unexpected completion receipt.');
          if (!['finalized', 'aborted'].includes(row.status)) {
            if (leased.has(row.project_id) || database.prepare("SELECT id FROM project_edits WHERE task_id=? AND status IN ('prepared','receipt-recorded','conflict')").get(row.task_id)) fail('INVALID_DATABASE', 'More than one pending journal claims the same project writer lease.');
            leased.add(row.project_id);
            notes.push(`Workspace edit ${row.id} remains pending and requires explicit editor recovery review; no mutation is resumed.`);
          }
          if (input.undoOf) {
            const previous = indexed.get(input.undoOf) ?? fail('INVALID_DATABASE', 'A workspace inverse has no original preparation.'), original = parse(prepareWorkspaceEditSchema, json(previous.input_json));
            if (!previous || previous.status !== 'finalized' || previous.task_id !== row.task_id || previous.project_id !== row.project_id || !original || original.documents.length !== input.documents.length || !input.documents.every(document => original.documents.some(before => before.relativePath === document.relativePath && before.afterText === document.beforeText && before.beforeText === document.afterText))) fail('INVALID_DATABASE', 'A workspace inverse does not exactly reverse its original journal.');
            if (row.status === 'finalized' && !operations.get(previous.operation_id!)?.undone) fail('INVALID_DATABASE', 'The finalized inverse is missing its original history marker.');
            inverses.set(row.id, previous.id);
            if (row.status === 'finalized') {
              if (finalizedInverses.has(previous.id)) fail('INVALID_DATABASE', 'More than one completed inverse claims the same workspace edit.');
              finalizedInverses.set(previous.id, row.id);
            }
          }
          const mapped = mapPath(row.project_root, `workspace_edits.${row.id}.projectRoot`);
          database.prepare('UPDATE workspace_edits SET project_root=?,restored=1 WHERE id=?').run(mapped, row.id);
        }
        // Native inverse history forms a chain of earlier completed edits.
        // Matching text alone cannot authorize a forged cycle or an invented
        // undone marker. Validate the graph without recursion on stored data.
        const visited = new Set<string>();
        for (const row of rows) {
          if (row.status === 'finalized' && !!operations.get(row.operation_id!)?.undone !== finalizedInverses.has(row.id)) fail('INVALID_DATABASE', 'A workspace history marker has no matching completed inverse.');
          const chain = new Set<string>();
          let next: string | undefined = row.id;
          while (next && !visited.has(next)) {
            if (chain.has(next)) fail('INVALID_DATABASE', 'Workspace inverse history contains a cycle.');
            chain.add(next); next = inverses.get(next);
          }
          for (const id of chain) visited.add(id);
        }
        for (const operation of operations.values()) if (['ApplyWorkspaceEdit', 'UndoWorkspaceEdit'].includes(operation.type) && !workspaceOperations.has(operation.id)) fail('INVALID_DATABASE', 'A workspace history entry lacks its finalized journal.');
      }
      for (const row of database.prepare('SELECT * FROM jobs').all()) parse(z.object({ id: idSchema, task_id: idSchema, task_epoch: number, generation: number, status: z.enum(['running', 'cancelled', 'completed']), created_at: number, updated_at: number }).strict(), row);
      const cancelled = database.prepare("UPDATE jobs SET status='cancelled' WHERE status='running'").run().changes;
      if (cancelled) notes.push(`${cancelled} previously running job(s) were cancelled; no provider work is resumed.`);
      verifySqliteIntegrity(database); checkMaintenanceSignal(options.signal);
    }).immediate();
    database.pragma('wal_checkpoint(TRUNCATE)');
    if (String(database.pragma('journal_mode = DELETE', { simple: true })).toLowerCase() !== 'delete') fail('INVALID_DATABASE', 'The relocated database could not become a standalone file.');
  } finally { database.close(); }
  await absent(databasePath + '-wal'); await absent(databasePath + '-shm');
  await verifyChain(root.chain); await verifyChain(file.chain); await chmod(databasePath, 0o600); await syncFile(databasePath); await syncDirectory(staging);
  for (const entry of files.keys()) {
    if (entry.endsWith('/.eve-import.json')) remainingMetadata.set(entry, { path: entry, kind: 'project-manifest' });
    if (entry.startsWith('workbench/recovery/')) remainingMetadata.set(entry, { path: entry, kind: 'workbench-recovery' });
  }
  const external = references.filter(reference => reference.kind === 'external').length;
  const omitted = references.filter(reference => reference.kind === 'profile-owned' && !reference.included).length;
  if (external) notes.push(`${external} external filesystem reference(s) were retained but their files were not copied or granted trust.`);
  if (omitted) notes.push(`${omitted} profile-owned reference(s) point to excluded or missing files at the new location and require review.`);
  notes.push('Core DB validation does not validate import manifests, editor recovery journals, acknowledgments, project trust, or arbitrary non-secret settings. The host must compose those validations before publishing a restored profile.');
  // Even a no-row-change checkpoint/journal-mode transition can change bytes.
  return { databaseValidated: true, schemaVersion: template.version, changedFiles: ['eve.db'], references, assets, projects: projectReferences, remainingMetadata: [...remainingMetadata.values()], notes };
}
