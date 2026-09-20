/** Manually bundled native smoke: real Electron utility process, empty profile, no provider calls. */
import { app } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { IntelligenceController } from '../../apps/desktop/host/intelligence';

const profilePath = process.argv[2];
if (!profilePath || !path.isAbsolute(profilePath)) throw new Error('Supply an isolated absolute temporary profile.');
app.setPath('userData', path.join(profilePath, 'electron'));
const deadline = setTimeout(() => { process.stderr.write('Intelligence native smoke timed out.\n'); app.exit(1); }, 15_000);
void app.whenReady().then(async () => {
  const controller = new IntelligenceController({ profilePath, workerPath: path.join(__dirname, 'model.cjs'),
    credentialBackend: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unknown', encryptString: () => { throw new Error('No credentials used in this smoke.'); }, decryptString: () => { throw new Error('No credentials used in this smoke.'); } },
  });
  try {
    controller.syncCanonical({ snapshot: { version: 1, activeTaskId: 'smoke', recentActions: [], tasks: [{ id: 'smoke', title: 'Smoke', description: 'Utility process smoke', kind: 'note', projectPath: null, revision: 1, epoch: 1, createdAt: 0, updatedAt: 0, note: { id: 'smoke-note', body: '', revision: 1, updatedAt: 0 }, parameters: null, checkpoint: null, policy: { processing: 'local-only', assistancePaused: false, revision: 1 } }] }, files: [] });
    await controller.initialize();
    assert.equal(controller.publicSettings().state, 'ready');
    const result = await controller.request({ intent: { id: 'smoke-request', taskId: 'smoke', taskEpoch: 1, contextSnapshotId: 'smoke-context', inputModality: 'typed', text: 'show code', generation: 1 }, context: { id: 'smoke-context', taskId: 'smoke', taskEpoch: 1, createdAt: 0 }, purpose: 'Utility process smoke', policy: 'local-only', priority: 'foreground', role: 'route', sources: [], targets: [] });
    assert.equal(result.status, 'complete');
    if (result.status === 'complete') assert.equal(result.origin, 'registered-command');
    await controller.dispose(); assert.equal(controller.publicSettings().state, 'disposed');
    process.stdout.write('Native utility-process ready, registered request, and clean shutdown passed. No providers or credentials used.\n');
    clearTimeout(deadline); app.exit(0);
  } catch { await controller.dispose().catch(() => {}); process.stderr.write('Intelligence native smoke failed.\n'); clearTimeout(deadline); app.exit(1); }
});
