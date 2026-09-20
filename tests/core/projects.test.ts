import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, projectPreviewSchema, projectRootIdentitySchema, type AuthenticatedContext, type RegisterProjectInput, type VerifyProjectInput } from '../../packages/contracts/src/index';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
const hash = (input: Buffer | string) => createHash('sha256').update(input).digest('hex');
const must = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => { expect(value.ok, JSON.stringify(value)).toBe(true); return value as Extract<T, { ok: true }>; };
const rejected = (value: { ok: boolean; error?: { code: string } }, code: string) => { expect(value.ok).toBe(false); expect(value.error?.code).toBe(code); };
let directory: string, dbPath: string, core: CoreStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'eve-project-core-')); dbPath = path.join(directory, 'eve.db');
  core = new CoreStore({ dbPath, orbitProjectPath: path.join(directory, 'workspaces/orbit') });
});
afterEach(() => { core.close(); rmSync(directory, { force: true, recursive: true }); });
const task = (id = 'photo-walk') => core.snapshot().tasks.find(task => task.id === id)!;
const registration = (extra: Partial<RegisterProjectInput> = {}): RegisterProjectInput => ({
  requestId: 'register-folder', taskId: task().id, expectedEpoch: task().epoch, expectedTaskRevision: task().revision,
  project: { id: 'user-project', canonicalRoot: path.join(directory, 'chosen-project'), rootIdentity: { device: '16777234', inode: '9007199254740995' }, kind: 'external', adapter: 'generic', preview: { kind: 'none' } }, ...extra,
});
const verification = (project = task('orbit').project!, extra: Partial<VerifyProjectInput> = {}): VerifyProjectInput => ({
  requestId: 'inspect-legacy', taskId: 'orbit', expectedEpoch: task('orbit').epoch, expectedTaskRevision: task('orbit').revision,
  projectId: project.id, expectedProjectRevision: project.revision, rootIdentity: { device: '17', inode: '92' }, kind: 'managed', adapter: 'orbit', preview: { kind: 'static', entry: 'index.html' }, ...extra,
});
function downgradeToV3(file: string) {
  const database = new Database(file);
  database.exec('DROP TABLE canvases; DROP TABLE workspace_edits; UPDATE tasks SET project_path=(SELECT p.canonical_root FROM projects p JOIN task_projects b ON b.project_id=p.id WHERE b.task_id=tasks.id); DROP TABLE project_requests; DROP TABLE task_projects; DROP TABLE projects; PRAGMA user_version=3;');
  database.pragma('wal_checkpoint(TRUNCATE)'); database.pragma('journal_mode=DELETE'); database.close();
}

it('seeds an explicitly unverified project without inventing filesystem identity or adapter authority', () => {
  expect(task('orbit').project).toMatchObject({ canonicalRoot: path.join(directory, 'workspaces/orbit'), verification: 'legacy-unverified', rootIdentity: null, kind: null, adapter: 'generic', preview: { kind: 'none' }, revision: 0 });
  expect(core.migrationRollback).toBeNull(); expect(existsSync(path.join(directory, 'migration-backups'))).toBe(false);
});

it('atomically binds a inspected folder, preserves notes, cancels old work and survives restart/idempotent retries', () => {
  const before = task(), input = registration();
  must(core.beginJob({ id: 'old-job', taskId: before.id, taskEpoch: before.epoch, generation: 1, provider: 'local' }, auth));
  const saved = must(core.registerProject(input, auth));
  expect(saved.project).toMatchObject({ ...input.project, revision: 0, verification: 'verified' });
  expect(task()).toMatchObject({ projectPath: input.project.canonicalRoot, project: saved.project, kind: 'project', epoch: before.epoch + 1, revision: before.revision + 1, note: before.note, parameters: null });
  expect(core.isJobCurrent('old-job', 1)).toBe(false);
  core.close(); core = new CoreStore({ dbPath });
  const retry = must(core.registerProject(input, auth)); expect(retry.idempotent).toBe(true); expect(retry.project).toEqual(saved.project);
  rejected(core.registerProject({ ...input, project: { ...input.project, canonicalRoot: path.join(directory, 'other') } }, auth), 'IDEMPOTENCY_CONFLICT');
  rejected(core.registerProject(input, { ...auth, actorId: 'different-host' }), 'IDEMPOTENCY_CONFLICT');
  core.close(); const inspect = new Database(dbPath); expect(inspect.prepare('SELECT project_path FROM tasks').all()).toEqual([{ project_path: null }, { project_path: null }]); inspect.close(); core = new CoreStore({ dbPath });
});

it('requires host authority, current epoch/revision and explicit Orbit configuration before any write', () => {
  const input = registration(), before = core.snapshot();
  for (const context of [{ ...auth, origin: 'model' as const }, { ...auth, origin: 'workbench' as const, taskIds: [input.taskId] }, { ...auth, capabilities: [] }, { ...auth, taskIds: ['orbit'] }]) rejected(core.registerProject(input, context), 'UNAUTHORIZED');
  rejected(core.registerProject({ ...input, expectedEpoch: input.expectedEpoch + 1 }, auth), 'STALE_EPOCH');
  rejected(core.registerProject({ ...input, expectedTaskRevision: input.expectedTaskRevision + 1 }, auth), 'REVISION_CONFLICT');
  rejected(core.registerProject({ ...input, project: { ...input.project, canonicalRoot: directory + '/../escape' } }, auth), 'INVALID_COMMAND');
  rejected(core.registerProject({ ...input, project: { ...input.project, adapter: 'orbit' } }, auth), 'INVALID_COMMAND');
  rejected(core.registerProject({ ...input, parameters: task('orbit').parameters!.values }, auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('rejects root aliases, duplicate identity/bindings and cross-operation request ID reuse', () => {
  const input = registration(); must(core.registerProject(input, auth));
  rejected(core.registerProject(registration({ requestId: 'replace' }), auth), 'PROJECT_ALREADY_ATTACHED');
  const created = must(core.dispatch({ type: 'CreateTask', requestId: 'new-task', title: 'Second project', kind: 'project' }, auth));
  const target = created.snapshot.tasks.find(task => task.id === created.snapshot.activeTaskId)!;
  const second = { ...input, requestId: 'second', taskId: target.id, expectedEpoch: target.epoch, expectedTaskRevision: target.revision, project: { ...input.project, id: 'second-project' } };
  rejected(core.registerProject(second, auth), 'PROJECT_ROOT_CONFLICT');
  rejected(core.registerProject({ ...second, project: { ...second.project, canonicalRoot: path.join(directory, 'alias') } }, auth), 'PROJECT_IDENTITY_CONFLICT');
  rejected(core.registerProject({ ...second, requestId: 'new-task' }, auth), 'IDEMPOTENCY_CONFLICT');
  rejected(core.dispatch({ type: 'UpdateNote', requestId: input.requestId, taskId: 'photo-walk', expectedEpoch: task().epoch, expectedRevision: task().note.revision, body: 'Conflict' }, auth), 'IDEMPOTENCY_CONFLICT');
});

it('promotes only a host-inspected legacy root and preserves existing parameters/history for reconciliation', () => {
  const input = verification(), before = task('orbit'), saved = must(core.verifyProject(input, auth));
  expect(saved.project).toMatchObject({ id: before.project!.id, canonicalRoot: before.projectPath, verification: 'verified', revision: 1, rootIdentity: input.rootIdentity, adapter: 'orbit' });
  expect(task('orbit').parameters).toEqual(before.parameters);
  expect(must(core.verifyProject(input, auth)).idempotent).toBe(true);
  rejected(core.verifyProject(verification(saved.project, { requestId: 'replace-identity', rootIdentity: { device: '17', inode: '93' } }), auth), 'PROJECT_IDENTITY_CONFLICT');
  const now = task('orbit');
  const preflight = must(core.preflight({ type: 'SetParameter', requestId: 'file-edit', taskId: now.id, expectedEpoch: now.epoch, expectedRevision: now.parameters!.revision, name: 'transitionMs', value: 450 }, auth));
  expect(preflight.projectEdit?.projectPath).toBe(saved.project.canonicalRoot);
});

it('never uses a legacy tasks.project_path as v4 authority and hides archival controls for verified generic projects', () => {
  const input = verification(undefined, { adapter: 'generic', preview: { kind: 'none' } }); must(core.verifyProject(input, auth));
  expect(task('orbit').parameters).toBeNull();
  rejected(core.observeProjectParameters('orbit', { theme: '#123456', durationMinutes: 20, transitionMs: 300, easing: [0, 0, 1, 1] }, auth), 'INVALID_COMMAND');
  core.close(); const modify = new Database(dbPath); modify.prepare('UPDATE tasks SET project_path=? WHERE id=?').run('/untrusted/redirect', 'orbit'); modify.close(); core = new CoreStore({ dbPath });
  expect(task('orbit').projectPath).toBe(path.join(directory, 'workspaces/orbit'));
});

it('bounds directory identities and preview URLs without DNS aliases, credentials, path escapes or executable entry values', () => {
  for (const identity of [{ device: '-1', inode: '1' }, { device: '1', inode: '18446744073709551616' }, { device: '01', inode: '2' }, { device: 'x', inode: '2' }]) expect(projectRootIdentitySchema.safeParse(identity).success).toBe(false);
  expect(projectRootIdentitySchema.safeParse({ device: '1', inode: '18446744073709551615' }).success).toBe(true);
  for (const url of ['http://localhost:1234/', 'http://127.1/', 'http://2130706433/', 'https://127.0.0.1/', 'http://user@127.0.0.1/', 'http://127.0.0.1/#secret', 'http://127.0.0.1\\@evil/']) expect(projectPreviewSchema.safeParse({ kind: 'loopback', url }).success).toBe(false);
  for (const url of ['http://127.0.0.1:3000/', 'http://[::1]:9000/demo']) expect(projectPreviewSchema.safeParse({ kind: 'loopback', url }).success).toBe(true);
  for (const entry of ['../index.html', '/index.html', 'javascript:alert(1)', 'a/../index.html', 'a\\index.html']) {
    expect(projectPreviewSchema.safeParse({ kind: 'static', entry }).success).toBe(false);
  }
});

it('creates a durable private standalone v3 rollback before migration and preserves journal/history request bytes', () => {
  const before = task('orbit');
  must(core.dispatch({ type: 'UpdateNote', requestId: 'preserve-history', taskId: before.id, expectedEpoch: before.epoch, expectedRevision: before.note.revision, body: 'Keep the literal path /old/profile/unchanged.' }, auth));
  const beforeText = JSON.stringify(before.parameters!.values), afterText = JSON.stringify({ ...before.parameters!.values, transitionMs: 510 });
  must(core.prepareProjectEdit({ type: 'SetParameter', requestId: 'preserve-journal', taskId: before.id, expectedEpoch: before.epoch, expectedRevision: before.parameters!.revision, name: 'transitionMs', value: 510 }, auth, { relativePath: 'eve.project.json', beforeHash: hash(beforeText), afterHash: hash(afterText), beforeText, afterText, location: 'buffer', documentVersion: 4 }));
  core.close(); downgradeToV3(dbPath);
  const old = new Database(dbPath, { readonly: true }); const evidence = Object.fromEntries(['requests', 'operations', 'project_edits'].map(table => [table, old.prepare(`SELECT * FROM ${table}`).all()])); old.close();
  core = new CoreStore({ dbPath }); const receipt = core.migrationRollback!;
  expect(receipt).toMatchObject({ fromVersion: 3, toVersion: 6, sha256: hash(readFileSync(receipt.path)) });
  expect(JSON.parse(readFileSync(path.join(path.dirname(receipt.path), 'receipt.json'), 'utf8'))).toEqual({ version: 1, ...receipt });
  expect(statSync(receipt.path).mode & 0o777).toBe(0o600); expect(statSync(path.dirname(receipt.path)).mode & 0o777).toBe(0o700);
  expect(readdirSync(path.dirname(receipt.path))).toEqual(['eve.db', 'receipt.json']);
  const rollback = new Database(receipt.path, { readonly: true });
  expect(rollback.pragma('user_version', { simple: true })).toBe(3); expect(rollback.pragma('integrity_check', { simple: true })).toBe('ok'); expect(rollback.pragma('journal_mode', { simple: true })).toBe('delete');
  expect(rollback.prepare('SELECT project_path FROM tasks WHERE id=?').get('orbit')).toEqual({ project_path: before.projectPath });
  for (const table of ['requests', 'operations', 'project_edits']) expect(rollback.prepare(`SELECT * FROM ${table}`).all()).toEqual(evidence[table]); rollback.close();
  expect(task('orbit').project).toMatchObject({ verification: 'legacy-unverified', rootIdentity: null, kind: null, adapter: 'generic' });
  core.close(); const migrated = new Database(dbPath, { readonly: true }); for (const table of ['requests', 'operations', 'project_edits']) expect(migrated.prepare(`SELECT * FROM ${table}`).all()).toEqual(evidence[table]); migrated.close(); core = new CoreStore({ dbPath });
  expect(core.migrationRollback).toBeNull();
});

it.each(['symlink', 'public'] as const)('refuses migration if rollback storage is %s, without changing old database contents or schema', (kind) => {
  core.close(); downgradeToV3(dbPath); const bytes = readFileSync(dbPath), collection = path.join(directory, 'migration-backups');
  if (kind === 'symlink') { const elsewhere = path.join(directory, 'elsewhere'); mkdirSync(elsewhere, { mode: 0o700 }); symlinkSync(elsewhere, collection); }
  else { mkdirSync(collection); chmodSync(collection, 0o755); }
  expect(() => new CoreStore({ dbPath })).toThrow(/rollback snapshot.*refused/i);
  expect(readFileSync(dbPath)).toEqual(bytes);
  const unchanged = new Database(dbPath, { readonly: true }); expect(unchanged.pragma('user_version', { simple: true })).toBe(3); unchanged.close();
});

it('relocates an exact v3 database without migrating staging, then snapshots and migrates it on cold open', async () => {
  const original = directory, stagingProfile = path.join(path.dirname(directory), path.basename(directory) + '-stage'), destinationProfile = path.join(path.dirname(directory), path.basename(directory) + '-restored');
  mkdirSync(stagingProfile, { mode: 0o700 });
  try {
    await core.backupDatabase(path.join(stagingProfile, 'eve.db')); downgradeToV3(path.join(stagingProfile, 'eve.db'));
    const bytes = readFileSync(path.join(stagingProfile, 'eve.db'));
    const result = await CoreStore.relocateDatabase({ stagingProfile, destinationProfile, originalProfileRoot: original, expectedSchemaVersion: 3, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: hash(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit'] });
    expect(result.schemaVersion).toBe(3); expect(result.projects[0]!.referenceField).toBe('tasks.orbit.project_path');
    const staged = new Database(path.join(stagingProfile, 'eve.db'), { readonly: true }); expect(staged.pragma('user_version', { simple: true })).toBe(3); staged.close();
    const opened = new CoreStore({ dbPath: path.join(stagingProfile, 'eve.db') });
    try { expect(opened.diagnostics().schemaVersion).toBe(6); expect(opened.migrationRollback?.fromVersion).toBe(3); expect(opened.snapshot().tasks.find(task => task.id === 'orbit')!.projectPath).toBe(path.join(destinationProfile, 'workspaces/orbit')); } finally { opened.close(); }
  } finally { rmSync(stagingProfile, { recursive: true, force: true }); }
});

it('relocates v5 project identity and idempotent receipt to fresh unverified canonical state', async () => {
  const input = verification(); const admitted = must(core.verifyProject(input, auth));
  const stagingProfile = path.join(path.dirname(directory), path.basename(directory) + '-stage'), destinationProfile = path.join(path.dirname(directory), path.basename(directory) + '-restored'); mkdirSync(stagingProfile, { mode: 0o700 });
  try {
    await core.backupDatabase(path.join(stagingProfile, 'eve.db')); const bytes = readFileSync(path.join(stagingProfile, 'eve.db'));
    const result = await CoreStore.relocateDatabase({ stagingProfile, destinationProfile, originalProfileRoot: directory, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: hash(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit'] });
    expect(result.projects[0]).toMatchObject({ projectId: admitted.project.id, referenceField: `projects.${admitted.project.id}.canonicalRoot`, after: path.join(destinationProfile, 'workspaces/orbit') });
    const opened = new CoreStore({ dbPath: path.join(stagingProfile, 'eve.db') });
    try {
      const retry = must(opened.verifyProject(input, auth)); expect(retry.idempotent).toBe(true);
      expect(retry.project).toMatchObject({ id: admitted.project.id, revision: admitted.project.revision + 1, verification: 'legacy-unverified', rootIdentity: null, kind: 'managed', adapter: 'orbit', canonicalRoot: path.join(destinationProfile, 'workspaces/orbit') });
      expect(retry.snapshot.tasks.find(task => task.id === 'orbit')!.project).toEqual(retry.project);
      expect(opened.migrationRollback).toBeNull();
    } finally { opened.close(); }
  } finally { rmSync(stagingProfile, { recursive: true, force: true }); }
});

it('reserves prepared edit request IDs against registration and ordinary content commands', () => {
  const current = task('orbit'), beforeText = JSON.stringify(current.parameters!.values), afterText = JSON.stringify({ ...current.parameters!.values, transitionMs: 480 });
  must(core.prepareProjectEdit({ type: 'SetParameter', requestId: 'reserved-edit', taskId: 'orbit', expectedEpoch: current.epoch, expectedRevision: current.parameters!.revision, name: 'transitionMs', value: 480 }, auth, { location: 'file', relativePath: 'eve.project.json', beforeHash: hash(beforeText), afterHash: hash(afterText), beforeText, afterText }));
  rejected(core.registerProject(registration({ requestId: 'reserved-edit' }), auth), 'IDEMPOTENCY_CONFLICT');
  rejected(core.dispatch({ type: 'UpdateNote', requestId: 'reserved-edit', taskId: 'orbit', expectedEpoch: current.epoch, expectedRevision: current.note.revision, body: 'Do not reuse a pending request identity' }, auth), 'IDEMPOTENCY_CONFLICT');
  expect(task('orbit').note).toEqual(current.note); expect(task().project).toBeNull();
});

it.each([
  ['legacy path authority', "UPDATE tasks SET project_path='/unsafe/path' WHERE id='orbit'"],
  ['registry identity mismatch', "UPDATE projects SET inode='999'"],
  ['unsupported registry fields', "UPDATE projects SET data=json_set(data,'$.executableScript','run-me')"],
  ['missing project binding', 'DELETE FROM task_projects'],
])('refuses v5 relocation with %s', async (_kind, mutation) => {
  const stagingProfile = path.join(path.dirname(directory), path.basename(directory) + '-stage'), destinationProfile = path.join(path.dirname(directory), path.basename(directory) + '-restored'); mkdirSync(stagingProfile, { mode: 0o700 });
  try {
    await core.backupDatabase(path.join(stagingProfile, 'eve.db'));
    const database = new Database(path.join(stagingProfile, 'eve.db')); database.exec(mutation); database.close();
    const before = readFileSync(path.join(stagingProfile, 'eve.db'));
    await expect(CoreStore.relocateDatabase({ stagingProfile, destinationProfile, originalProfileRoot: directory, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: before.length, sha256: hash(before) }], includedDirectories: ['workspaces', 'workspaces/orbit'] })).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_DATABASE|UNSUPPORTED_SCHEMA/) });
    expect(existsSync(destinationProfile)).toBe(false); expect(readFileSync(path.join(stagingProfile, 'eve.db'))).toEqual(before);
  } finally { rmSync(stagingProfile, { recursive: true, force: true }); }
});

it('looks up only a durable exact registration after a lost reply, even if its folder disappeared', () => {
  const selected = path.join(directory, 'selected'); mkdirSync(selected); const identity = statSync(selected, { bigint: true });
  const input = registration({ project: { ...registration().project, canonicalRoot: selected, rootIdentity: { device: identity.dev.toString(), inode: identity.ino.toString() } } });
  const before = core.snapshot(); expect(must(core.lookupProjectRegistration(input, auth)).value).toBeNull(); expect(core.snapshot()).toEqual(before);
  const committed = must(core.registerProject(input, auth)); core.close(); rmSync(selected, { recursive: true }); core = new CoreStore({ dbPath });
  const snapshot = core.snapshot(), found = must(core.lookupProjectRegistration(input, auth)).value;
  expect(found).toEqual({ project: committed.project, snapshot }); expect(core.snapshot()).toEqual(snapshot);
  // A newer task epoch cannot erase proof of the old exact acknowledged commit.
  must(core.dispatch({ type: 'RecallTask', requestId: 'switch-context', taskId: 'photo-walk' }, auth));
  expect(must(core.lookupProjectRegistration(input, auth)).value!.snapshot).toEqual(core.snapshot());
});

it('refuses lookup claims with different payload, actor, kind, capability or task binding', () => {
  const input = registration(); must(core.registerProject(input, auth));
  rejected(core.lookupProjectRegistration({ ...input, project: { ...input.project, canonicalRoot: path.join(directory, 'another') } }, auth), 'IDEMPOTENCY_CONFLICT');
  rejected(core.lookupProjectRegistration({ ...input, taskId: 'orbit' }, auth), 'IDEMPOTENCY_CONFLICT');
  rejected(core.lookupProjectRegistration(input, { ...auth, actorId: 'another-user' }), 'IDEMPOTENCY_CONFLICT');
  rejected(core.lookupProjectRegistration(input, { ...auth, origin: 'workbench', taskIds: ['photo-walk'] }), 'UNAUTHORIZED');
  rejected(core.lookupProjectRegistration(input, { ...auth, origin: 'model' }), 'UNAUTHORIZED');
  rejected(core.lookupProjectRegistration(input, { ...auth, capabilities: [] }), 'UNAUTHORIZED');
  rejected(core.lookupProjectRegistration(input, { ...auth, taskIds: ['orbit'] }), 'UNAUTHORIZED');
  rejected(core.lookupProjectRegistration({ ...input, unexpectedAuthority: true }, auth), 'INVALID_COMMAND');
  const inspected = verification(); must(core.verifyProject(inspected, auth));
  rejected(core.lookupProjectRegistration({ ...input, requestId: inspected.requestId }, auth), 'IDEMPOTENCY_CONFLICT');
  must(core.dispatch({ type: 'RecallTask', requestId: 'ordinary-request', taskId: 'orbit' }, auth));
  rejected(core.lookupProjectRegistration({ ...input, requestId: 'ordinary-request' }, auth), 'IDEMPOTENCY_CONFLICT');
  core.close();
  const changed = new Database(dbPath); changed.prepare('DELETE FROM task_projects WHERE task_id=?').run('photo-walk'); changed.close(); core = new CoreStore({ dbPath });
  rejected(core.lookupProjectRegistration(input, auth), 'STORAGE_ERROR');
});

it('returns relocated current project metadata when looking up an original registration receipt', async () => {
  const input = registration(); must(core.registerProject(input, auth));
  const stagingProfile = path.join(path.dirname(directory), path.basename(directory) + '-stage'), destinationProfile = path.join(path.dirname(directory), path.basename(directory) + '-restored'); mkdirSync(stagingProfile, { mode: 0o700 });
  try {
    await core.backupDatabase(path.join(stagingProfile, 'eve.db')); const bytes = readFileSync(path.join(stagingProfile, 'eve.db'));
    await CoreStore.relocateDatabase({ stagingProfile, destinationProfile, originalProfileRoot: directory, expectedSchemaVersion: 6, includedFiles: [{ path: 'eve.db', bytes: bytes.length, sha256: hash(bytes) }], includedDirectories: ['workspaces', 'workspaces/orbit', 'chosen-project'] });
    const restored = new CoreStore({ dbPath: path.join(stagingProfile, 'eve.db') });
    try {
      const result = must(restored.lookupProjectRegistration(input, auth)).value!;
      expect(result.project).toMatchObject({ id: input.project.id, verification: 'legacy-unverified', rootIdentity: null, canonicalRoot: path.join(destinationProfile, 'chosen-project') });
      expect(result.snapshot.tasks.find(task => task.id === input.taskId)!.project).toEqual(result.project);
    } finally { restored.close(); }
  } finally { rmSync(stagingProfile, { recursive: true, force: true }); }
});
