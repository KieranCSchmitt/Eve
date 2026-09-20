import { afterEach, beforeEach, expect, it } from 'vitest';
import { CoreStore } from '../../packages/core/src/index.js';
import { ALL_CAPABILITIES, type AuthenticatedContext } from '../../packages/contracts/src/index.js';

const auth: AuthenticatedContext = { actorId: 'host', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
let core: CoreStore;
const task = () => core.snapshot().tasks.find(task => task.id === 'orbit')!;
beforeEach(() => { core = new CoreStore({ dbPath: ':memory:' }); });
afterEach(() => core.close());

it('stores immutable imported-asset provenance and rejects cross-task source references', () => {
  const asset = { id: 'image-1', taskId: 'orbit', originalPath: '/chosen/sunset.png', managedPath: '/profile/assets/abc.png', sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'image/png', title: 'Sunset', provenance: { kind: 'user-import', attribution: 'My photograph', rights: 'Original work' } };
  expect(core.registerAsset(asset, auth).ok).toBe(true);
  expect(core.registerAsset(asset, auth).ok).toBe(true);
  expect(core.registerAsset({ ...asset, sha256: 'b'.repeat(64) }, auth).ok).toBe(false);
  const source = { id: 'source-1', taskId: 'orbit', assetId: 'image-1', title: 'My reference', excerpt: 'The light is softer near the window.', retrievedAt: 100, provenance: asset.provenance };
  expect(core.registerSource(source, auth).ok).toBe(true);
  expect(core.listAssets('orbit')[0]!.sha256).toBe(asset.sha256);
  expect(core.listSources('orbit')[0]!.provenance.rights).toBe('Original work');
  expect(core.registerSource({ ...source, id: 'wrong-task', taskId: 'photo-walk' }, auth).ok).toBe(false);
  expect(core.registerSource({ ...source, id: 'secret-url', url: 'https://user:password@example.com' }, auth).ok).toBe(false);
});

it('keeps task privacy/assistance policies revisioned and invalidates in-flight work on policy change', () => {
  const before = task();
  expect(core.beginJob({ id: 'job', taskId: before.id, taskEpoch: before.epoch, generation: 0, provider: 'cloud' }, auth).ok).toBe(true);
  expect(core.isJobCurrent('job', 0)).toBe(true);
  expect(core.dispatch({ type: 'SetTaskPolicy', requestId: 'policy', taskId: before.id, expectedEpoch: before.epoch, expectedRevision: 0, policy: { processing: 'local-only', assistancePaused: true } }, auth).ok).toBe(true);
  expect(task().policy).toEqual({ processing: 'local-only', assistancePaused: true, revision: 1 });
  expect(core.isJobCurrent('job', 0)).toBe(false);
  expect(core.beginJob({ id: 'cloud-job', taskId: before.id, taskEpoch: before.epoch, generation: 0, provider: 'cloud' }, auth).ok).toBe(false);
  expect(core.beginJob({ id: 'quiet-job', taskId: before.id, taskEpoch: before.epoch, generation: 0, provider: 'local', background: true }, auth).ok).toBe(false);
  expect(core.beginJob({ id: 'direct-local', taskId: before.id, taskEpoch: before.epoch, generation: 0, provider: 'local' }, auth).ok).toBe(true);
});

it('rejects late job-token mutations, old generation cancellation, and switched-task results', () => {
  const before = task();
  const registration = { id: 'job', taskId: before.id, taskEpoch: before.epoch, generation: 0, provider: 'local' as const };
  expect(core.beginJob(registration, auth).ok).toBe(true);
  expect(core.endJob('job', 0, 'cancelled', auth).ok).toBe(true);
  const result = core.dispatch({ type: 'UpdateNote', requestId: 'late-job', taskId: before.id, expectedEpoch: before.epoch, expectedRevision: 0, body: 'A cancelled answer.', jobToken: { id: 'job', generation: 0 } }, auth);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('JOB_CANCELLED');
  expect(core.beginJob({ ...registration, generation: 1 }, auth).ok).toBe(true);
  expect(core.endJob('job', 0, 'cancelled', auth).ok).toBe(false);
  expect(core.isJobCurrent('job', 1)).toBe(true);
  core.dispatch({ type: 'RecallTask', requestId: 'switch', taskId: 'photo-walk' }, auth);
  expect(core.isJobCurrent('job', 1)).toBe(false);
});
