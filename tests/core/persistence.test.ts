import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, sourceRegistrationSchema, type AuthenticatedContext, type CoreCommandInput } from '../../packages/contracts/src/index';
import { CHROME_ANIMATION_LESSON, ORBIT_LESSON_NOTES, registerAuthoredNote, resolveYouTubeSource } from '../../packages/media/src/index';
import { buildIntentRequest } from '../../apps/desktop/host/intent-context';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
let directory: string;
let dbPath: string;
let core: CoreStore;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eve-json-persistence-'));
  dbPath = join(directory, 'eve.db');
  core = new CoreStore({ dbPath, orbitProjectPath: join(directory, 'orbit') });
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });
const authored = () => {
  const source = resolveYouTubeSource(CHROME_ANIMATION_LESSON.url);
  if (!source.supported) throw new Error(source.reason);
  return registerAuthoredNote({ note: ORBIT_LESSON_NOTES[0]!, source: source.source, taskId: 'orbit', lessonTitle: CHROME_ANIMATION_LESSON.title });
};
const asset = () => ({
  id: 'original', taskId: 'orbit', title: 'Original notes', originalPath: '/chosen/notes.txt', managedPath: '/profile/assets/notes.txt',
  sha256: 'a'.repeat(64), byteLength: 12, mediaType: 'text/plain',
  provenance: { kind: 'user-import' as const, attribution: 'User attachment', rights: 'Original work', sourceUrl: undefined },
});

it('round-trips the real authored lesson registration into a valid intent context after restart', () => {
  const registration = authored();
  expect(Object.hasOwn(registration, 'timestampEnd')).toBe(true);
  expect(registration.timestampEnd).toBeUndefined();
  expect(core.registerSource(registration, auth).ok).toBe(true);
  core.close(); core = new CoreStore({ dbPath });
  const [source] = core.listSources('orbit');
  const { createdAt, ...persisted } = source!;
  expect(createdAt).toBeGreaterThan(0);
  expect(Object.hasOwn(persisted, 'timestampEnd')).toBe(false);
  expect(sourceRegistrationSchema.safeParse(persisted).success).toBe(true);
  expect(core.registerSource(registration, auth).ok).toBe(true);
  const built = buildIntentRequest({ taskId: 'orbit', text: 'Explain the motion in this lesson.', requestId: 'persisted-question', generation: 1, snapshot: core.snapshot(), sources: [source!] });
  expect(built.request.sources).toContainEqual(expect.objectContaining({ id: registration.id, excerpt: expect.stringContaining(registration.excerpt), provenance: 'authored-notes' }));
});

it('omits optional asset/source fields recursively while retaining idempotent registration', () => {
  expect(core.registerAsset(asset(), auth).ok).toBe(true);
  const source = { id: 'asset-source', taskId: 'orbit', title: 'Notes', assetId: 'original', url: undefined, excerpt: 'Useful notes', retrievedAt: 100, timestampStart: undefined, timestampEnd: undefined, provenance: asset().provenance };
  expect(core.registerSource(source, auth).ok).toBe(true);
  core.close(); core = new CoreStore({ dbPath });
  expect(core.listAssets('orbit')[0]!.provenance).not.toHaveProperty('sourceUrl');
  const persisted = core.listSources('orbit')[0]!;
  for (const field of ['url', 'timestampStart', 'timestampEnd']) expect(persisted).not.toHaveProperty(field);
  expect(persisted.provenance).not.toHaveProperty('sourceUrl');
  expect(core.registerAsset(asset(), auth).ok).toBe(true);
  expect(core.registerSource(source, auth).ok).toBe(true);
  expect(core.listAssets('orbit')).toHaveLength(1);
  expect(core.listSources('orbit')).toHaveLength(1);
});

it('migrates v2 optional-null metadata narrowly without rewriting fingerprints, journal evidence, or malformed records', () => {
  const registration = authored();
  expect(core.registerSource(registration, auth).ok).toBe(true);
  expect(core.registerAsset(asset(), auth).ok).toBe(true);
  const task = core.snapshot().tasks.find(task => task.id === 'orbit')!;
  const checkpoint: CoreCommandInput = { type: 'SaveCheckpoint', requestId: 'legacy-checkpoint', taskId: task.id, expectedEpoch: task.epoch, expectedRevision: 0,
    checkpoint: { layout: 'work', selectedActivity: 'preview', selectedFile: undefined, returnAnchors: [] } };
  const saved = core.dispatch(checkpoint, auth);
  expect(saved.ok).toBe(true);
  const beforeText = JSON.stringify({ ...task.parameters!.values, metadata: { nullable: null, slots: [null, 'kept'] } });
  const afterText = JSON.stringify({ ...JSON.parse(beforeText), transitionMs: 430 });
  const prepared = core.prepareProjectEdit({ type: 'SetParameter', requestId: 'legacy-journal', taskId: task.id, expectedEpoch: task.epoch, expectedRevision: task.parameters!.revision, name: 'transitionMs', value: 430 }, auth,
    { location: 'file', relativePath: 'eve.project.json', beforeText, afterText, beforeHash: hash(beforeText), afterHash: hash(afterText) });
  expect(prepared.ok).toBe(true);
  core.close();

  const legacy = new Database(dbPath);
  const row = legacy.prepare('SELECT data FROM sources WHERE id=?').get(registration.id) as { data: string };
  const oldSource = { ...JSON.parse(row.data), assetId: null, timestampEnd: null, provenance: { ...registration.provenance, sourceUrl: null } };
  legacy.prepare('UPDATE sources SET data=? WHERE id=?').run(JSON.stringify(oldSource), registration.id);
  const oldAsset = { ...asset(), provenance: { ...asset().provenance, sourceUrl: null } };
  legacy.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(oldAsset), oldAsset.id);
  const malformed = JSON.stringify({ ...oldSource, id: 'malformed', title: null });
  legacy.prepare('INSERT INTO sources VALUES (?,?,?,?)').run('malformed', 'orbit', malformed, 123);
  // Exact v2 identity fixture: its explicitly omitted selectedFile was hashed as
  // null. A new serializer must not make retrying this old receipt write again.
  const oldFingerprint = hash('{"actorId":"desktop","command":{"checkpoint":{"layout":"work","returnAnchors":[],"selectedActivity":"preview","selectedFile":null},"expectedEpoch":1,"expectedRevision":0,"requestId":"legacy-checkpoint","taskId":"orbit","type":"SaveCheckpoint"},"origin":"trusted-ui"}');
  legacy.prepare('UPDATE requests SET fingerprint=? WHERE request_id=?').run(oldFingerprint, checkpoint.requestId);
  const fingerprint = legacy.prepare('SELECT * FROM requests WHERE request_id=?').get(checkpoint.requestId);
  const journal = legacy.prepare('SELECT * FROM project_edits WHERE request_id=?').get('legacy-journal');
  const history = legacy.prepare('SELECT * FROM operations').all();
  legacy.exec('DROP TABLE canvases; DROP TABLE workspace_edits; UPDATE tasks SET project_path=(SELECT p.canonical_root FROM projects p JOIN task_projects b ON b.project_id=p.id WHERE b.task_id=tasks.id); DROP TABLE project_requests; DROP TABLE task_projects; DROP TABLE projects; PRAGMA user_version=2;'); legacy.close();

  core = new CoreStore({ dbPath });
  expect(core.diagnostics().schemaVersion).toBe(6);
  expect(core.migrationRollback).toMatchObject({ fromVersion: 2, toVersion: 6 });
  const repaired = core.listSources('orbit').find(source => source.id === registration.id)!;
  expect(repaired).not.toHaveProperty('assetId');
  expect(repaired).not.toHaveProperty('timestampEnd');
  expect(repaired.provenance).not.toHaveProperty('sourceUrl');
  expect(repaired.excerpt).toBe(registration.excerpt);
  expect(repaired.provenance.rights).toBe(registration.provenance.rights);
  expect(core.listAssets('orbit')[0]!.provenance).not.toHaveProperty('sourceUrl');
  const duplicate = core.dispatch(checkpoint, auth);
  expect(duplicate.ok && duplicate.idempotent).toBe(true);
  expect(core.registerAsset(asset(), auth).ok).toBe(true);
  const { sourceUrl: _url, ...provenance } = registration.provenance;
  expect(core.registerSource({ ...registration, provenance }, auth).ok).toBe(true);
  expect(core.listPendingProjectEdits()[0]!.beforeText).toBe(beforeText);
  core.close();

  const inspect = new Database(dbPath, { readonly: true });
  expect(inspect.prepare('SELECT * FROM requests WHERE request_id=?').get(checkpoint.requestId)).toEqual(fingerprint);
  expect(inspect.prepare('SELECT * FROM project_edits WHERE request_id=?').get('legacy-journal')).toEqual(journal);
  expect(inspect.prepare('SELECT * FROM operations').all()).toEqual(history);
  expect(inspect.prepare('SELECT data FROM sources WHERE id=?').get('malformed')).toEqual({ data: malformed });
  inspect.close();
  core = new CoreStore({ dbPath });
});
