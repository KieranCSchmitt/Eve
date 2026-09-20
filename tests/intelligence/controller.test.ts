import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntelligenceController, type IntelligenceEvent, type ModelWorkerProcess } from '../../apps/desktop/host/intelligence';
import { createModelWorkerRuntime, type HostWorkerMessage, type WorkerHostMessage, type CanonicalInput } from '../../apps/desktop/host/model-worker';
import { AgentFailure, createProvider, type AgentRequest, type ProviderOutput } from '../../packages/agent/src/index';
import type { CoreSnapshot } from '../../packages/contracts/src/index';
import type { ConfigureProviderInput, SafeStorageBackend } from '../../apps/desktop/host/credentials';

const backend: SafeStorageBackend = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 73)), decryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 73)).toString() };
const cloud: ConfigureProviderInput = { provider: { id: 'cloud', kind: 'openai', protocol: 'openai-responses', model: 'explicit-test-model', enabled: true, roles: ['explain'] }, storage: 'runtime-only', credential: 'test-secret' };
const local: ConfigureProviderInput = { provider: { id: 'local', kind: 'nemotron', endpoint: 'http://127.0.0.1:45678/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', model: 'observed-test-checkpoint', enabled: true, roles: ['explain'], authentication: 'none', cancellationMode: 'unverified' }, storage: 'secure' };
const output: ProviderOutput = { text: JSON.stringify({ version: 1, message: 'Prepared explanation.', basis: 'general', citations: [], actions: [], needsClarification: false }), usage: { inputTokens: 2, outputTokens: 3 } };
function snapshot(): CoreSnapshot {
  return { version: 1, activeTaskId: 'task', recentActions: [], tasks: [{ id: 'task', title: 'Task', description: 'Purpose', kind: 'project', projectPath: '/canonical/project', revision: 1, epoch: 1, createdAt: 0, updatedAt: 0, note: { id: 'task-note', body: 'Note', revision: 1, updatedAt: 0 }, parameters: { values: { theme: '#5677FF', durationMinutes: 25, transitionMs: 260, easing: [.22,1,.36,1] }, revision: 1, updatedAt: 0 }, checkpoint: null, policy: { processing: 'hybrid', assistancePaused: false, revision: 1 } }] };
}
function request(id = 'request', generation = 1): AgentRequest {
  return { intent: { id, text: 'Why is this useful?', inputModality: 'typed', taskId: 'task', taskEpoch: 1, contextSnapshotId: `context-${id}`, generation }, context: { id: `context-${id}`, taskId: 'task', taskEpoch: 1, createdAt: 0 }, purpose: 'Purpose', policy: 'hybrid', priority: 'foreground', role: 'explain', sources: [], targets: [] };
}
class FakeWorker extends EventEmitter implements ModelWorkerProcess {
  received: HostWorkerMessage[] = [];
  killed = false;
  runtime: ReturnType<typeof createModelWorkerRuntime>;
  constructor(generate: (options: { signal: AbortSignal; onTextDelta(delta: string): void }) => Promise<ProviderOutput>) {
    super();
    this.runtime = createModelWorkerRuntime({ send: message => {
      const clone = structuredClone(message);
      if (clone.type === 'hello') setImmediate(() => this.emit('message', clone));
      else queueMicrotask(() => this.emit('message', clone));
    }, providerFactory: (config, dependencies) => ({ ...createProvider(config, dependencies), generate: async (_input, options) => generate(options) }) });
  }
  postMessage(message: HostWorkerMessage) { const copy = structuredClone(message); this.received.push(copy); queueMicrotask(() => { if (!this.killed) this.runtime.handle(copy); }); }
  kill() { if (this.killed) return false; this.killed = true; this.runtime.dispose(); this.emit('exit', 0); return true; }
  crash() { this.killed = true; this.runtime.dispose(); this.emit('exit', 1); }
}
let profile: string;
let controllers: IntelligenceController[];
beforeEach(async () => { profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-intelligence-'))); controllers = []; });
afterEach(async () => { for (const controller of controllers) await controller.dispose(); await rm(profile, { recursive: true, force: true }); });
async function create(generate: ConstructorParameters<typeof FakeWorker>[0] = async () => output) {
  const workers: FakeWorker[] = []; const events: IntelligenceEvent[] = []; const environments: Record<string,string>[] = [];
  const controller = new IntelligenceController({ profilePath: profile, workerPath: '/reviewed/model.cjs', credentialBackend: backend, platform: 'linux', startupTimeoutMs: 1000, shutdownTimeoutMs: 20,
    onEvent: event => events.push(event), spawnWorker: (_entry, options) => { environments.push(options.env); const worker = new FakeWorker(generate); workers.push(worker); return worker; } });
  controllers.push(controller); controller.syncCanonical({ snapshot: snapshot(), files: [] }); await controller.initialize();
  return { controller, workers, events, environments };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

describe('intelligence host boundary', () => {
  it('starts a separate worker with an allowlisted environment and no automatic model/endpoint guesses', async () => {
    const { controller, workers, environments } = await create();
    expect(controller.publicSettings()).toMatchObject({ state: 'ready', providers: [] });
    expect(Object.keys(environments[0]).every(key => ['LANG','LC_ALL','TZ','TMPDIR','TEMP','TMP','SYSTEMROOT','WINDIR'].includes(key))).toBe(true);
    expect(workers[0].received[0]).toMatchObject({ type: 'boot', providers: [] });
    expect(await controller.request(request())).toMatchObject({ status: 'unavailable', code: 'PROVIDER_UNAVAILABLE' });
    const direct = request('direct', 2); direct.intent.text = 'show code';
    expect(await controller.request(direct)).toMatchObject({ status: 'complete', origin: 'registered-command' });
  });
  it('isolates secrets to boot IPC, returns progress/results, and does not apply actions', async () => {
    const { controller, workers, events, environments } = await create(); await controller.configure(cloud);
    const result = await controller.request(request()); expect(result).toMatchObject({ status: 'complete', origin: 'model-proposal', focusPolicy: 'preserve' });
    expect(events.some(event => event.type === 'progress')).toBe(true);
    expect(JSON.stringify([events, controller.publicSettings(), environments])).not.toContain('test-secret');
    const boot = workers.at(-1)!.received.find(message => message.type === 'boot'); expect(boot).toMatchObject({ providers: [{ credential: 'test-secret' }] });
    expect(workers.at(-1)!.received.every(message => ['boot','request','canonical','cancel','shutdown'].includes(message.type))).toBe(true);
  });
  it('rejects stale epochs, note/parameter revisions, and local-only policy before any provider request', async () => {
    let runs = 0; const { controller } = await create(async () => { runs++; return output; }); await controller.configure(cloud);
    const stale = request('stale'); stale.intent.taskEpoch = 0;
    expect(await controller.request(stale)).toMatchObject({ code: 'STALE_CONTEXT' });
    const note = request('note'); note.targets = [{ id: 'task-note', revision: 0, kind: 'note' }];
    expect(await controller.request(note)).toMatchObject({ code: 'STALE_CONTEXT' });
    const parameters = request('parameters'); parameters.targets = [{ id: 'task:parameters', revision: 1, kind: 'parameters', parameters: { ...snapshot().tasks[0].parameters!.values, durationMinutes: 99 } }];
    expect(await controller.request(parameters)).toMatchObject({ code: 'STALE_CONTEXT' });
    const current = snapshot(); current.tasks[0].policy.processing = 'local-only'; controller.syncCanonical({ snapshot: current, files: [] });
    expect(await controller.request(request('policy'))).toMatchObject({ code: 'STALE_CONTEXT' }); expect(runs).toBe(0);
  });
  it('cancels and suppresses late results when canonical note revisions change', async () => {
    let resolve!: (value: ProviderOutput) => void; let signal!: AbortSignal;
    const { controller, events } = await create(options => { signal = options.signal; return new Promise(accept => { resolve = accept; }); }); await controller.configure(cloud);
    const promise = controller.request(request()); await tick(); const current = snapshot(); current.tasks[0].note.revision++; controller.syncCanonical({ snapshot: current, files: [] });
    expect(await promise).toMatchObject({ status: 'stale' }); await tick(); expect(signal.aborted).toBe(true);
    resolve(output); await tick(); expect(events.filter(event => event.type === 'result' && event.result.status === 'complete')).toEqual([]);
  });
  it('checks exact workspace bytes and invalidates a request on buffer-version changes even at equal content', async () => {
    let resolve!: (value: ProviderOutput) => void; const { controller } = await create(() => new Promise(accept => { resolve = accept; })); await controller.configure(cloud);
    const content = 'const value = 1;';
    const canonical: CanonicalInput = { snapshot: snapshot(), files: [{ taskId: 'task', targetId: 'workspace', path: 'src/app.ts', revision: 9, sha256: createHash('sha256').update(content).digest('hex'), documentVersion: 4 }] };
    controller.syncCanonical(canonical); const current = request(); current.targets = [{ kind: 'workspace', id: 'workspace', revision: 9, files: [{ path: 'src/app.ts', content }] }];
    const wrong = structuredClone(current); wrong.intent.id = 'wrong'; wrong.targets[0].files![0].content = 'invented';
    expect(await controller.request(wrong)).toMatchObject({ code: 'STALE_CONTEXT' });
    const pending = controller.request(current); await tick(); canonical.files[0].documentVersion = 5; controller.syncCanonical(canonical);
    expect(await pending).toMatchObject({ status: 'stale' }); resolve(output);
  });
  it('settles cancellation immediately, ignores late progress, and does not replay cancelled IDs', async () => {
    let resolve!: (value: ProviderOutput) => void; let progress!: (text: string) => void;
    const { controller, events, workers } = await create(options => { progress = options.onTextDelta; return new Promise(accept => { resolve = accept; }); }); await controller.configure(cloud);
    const pending = controller.request(request()); await tick(); controller.cancel('request'); expect(await pending).toMatchObject({ status: 'cancelled' });
    const count = events.length; progress('late'); resolve(output); await tick();
    expect(events.slice(count).filter(event => event.type === 'progress' || event.type === 'result')).toEqual([]);
    expect(await controller.request(request())).toMatchObject({ status: 'cancelled' }); expect(workers.at(-1)!.received.filter(message => message.type === 'request')).toHaveLength(1);
  });
  it('does not reuse completed results against a later canonical state', async () => {
    const { controller } = await create(); await controller.configure(cloud); expect(await controller.request(request())).toMatchObject({ status: 'complete' });
    const changed = snapshot(); changed.tasks[0].note.revision++; controller.syncCanonical({ snapshot: changed, files: [] });
    expect(await controller.request(request())).toMatchObject({ code: 'STALE_CONTEXT' });
  });
  it('rejects old generations and changed request identities', async () => {
    const { controller } = await create(); await controller.configure(cloud); await controller.request(request('new', 2));
    expect(await controller.request(request('old', 1))).toMatchObject({ code: 'STALE_CONTEXT' });
    const changed = request('new', 2); changed.intent.text = 'different question'; expect(await controller.request(changed)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects pending work on crash, ignores old-process completions, and restarts without replay', async () => {
    let resolve!: (value: ProviderOutput) => void;
    const { controller, workers, events } = await create(() => new Promise(accept => { resolve = accept; })); await controller.configure(cloud);
    const pending = controller.request(request()); await tick(); const old = workers.at(-1)!; old.crash();
    expect(await pending).toMatchObject({ status: 'unavailable' }); await controller.initialize();
    expect(workers.at(-1)!.received.some(message => message.type === 'request')).toBe(false);
    resolve(output); old.emit('message', { type: 'ready', session: 'old-session' }); await tick();
    expect(events.filter(event => event.type === 'result' && event.result.status === 'complete')).toEqual([]);
    expect(controller.publicSettings().state).toBe('ready');
  });
  it('persists local uncertainty after a non-drained shutdown and requires explicit idle confirmation', async () => {
    let resolve!: (value: ProviderOutput) => void;
    const first = await create(() => new Promise(accept => { resolve = accept; })); await first.controller.configure(local);
    const pending = first.controller.request(request()); await tick(); first.controller.cancel('request'); expect(await pending).toMatchObject({ status: 'cancelled' });
    await first.controller.dispose(); expect(JSON.parse(await readFile(path.join(profile, 'intelligence/local-safety.json'), 'utf8')).uncertain).toEqual(['local']);
    resolve(output); const second = await create(); expect(second.controller.publicSettings().providers[0]).toMatchObject({ quarantined: true });
    expect(second.controller.publicSettings().localRecoveryOrigins).toEqual(['http://127.0.0.1:45678']);
    expect(await second.controller.request(request('blocked'))).toMatchObject({ status: 'unavailable' });
    await second.controller.configure({ ...local, provider: { ...local.provider, id: 'alias' } });
    expect(second.controller.publicSettings().providers.every(provider => provider.quarantined)).toBe(true);
    expect(await second.controller.request(request('alias-blocked'))).toMatchObject({ status: 'unavailable' });
    if (local.provider.kind !== 'nemotron') throw new Error('Invalid test fixture');
    await second.controller.configure({ ...local, provider: { ...local.provider, endpoint: 'http://127.0.0.1:45679/v1/chat/completions' } });
    expect(second.controller.publicSettings().localRecoveryOrigins).toContain('http://127.0.0.1:45678');
    expect(await second.controller.request(request('changed-endpoint-blocked'))).toMatchObject({ status: 'unavailable' });
    await second.controller.configure({ ...local, confirmedLocalIdle: true }); expect(second.controller.publicSettings().providers[0]).toMatchObject({ quarantined: false });
  });
  it('accepts a confirmed idle shutdown when the worker exits in the same event turn as its acknowledgement', async () => {
    const { controller, workers } = await create();
    await controller.configure({ ...local, confirmedLocalIdle: true });
    const worker = workers.at(-1)!;
    worker.on('message', (message: WorkerHostMessage) => {
      if (message.type === 'stopped') {
        worker.killed = true;
        worker.runtime.dispose();
        worker.emit('exit', 0);
      }
    });
    await controller.dispose();
    const marker = JSON.parse(await readFile(path.join(profile, 'intelligence/local-safety.json'), 'utf8'));
    expect(marker).toEqual({ version: 2, uncertain: [], origins: [] });
    expect(controller.publicSettings()).toMatchObject({ state: 'disposed', localRecoveryRequired: false });
  });
  it('preserves its cloud request cap across worker replacement', async () => {
    const { controller } = await create(); await controller.configure(cloud); await controller.request(request());
    expect(controller.publicSettings().cloudRequestsRemaining).toBe(99);
    await controller.configure(cloud); expect(controller.publicSettings().cloudRequestsRemaining).toBe(99);
  });
  it('does not evade an uncertain live runtime through a second configured local provider ID', async () => {
    let calls = 0;
    const { controller } = await create(async () => { calls++; throw new AgentFailure('LOCAL_STATE_UNKNOWN', 'Test runtime did not confirm completion.'); });
    await controller.configure(local); await controller.configure({ ...local, provider: { ...local.provider, id: 'same-runtime-alias' } });
    expect(await controller.request(request('first'))).toMatchObject({ status: 'unavailable', code: 'LOCAL_STATE_UNKNOWN' });
    await tick();
    expect(await controller.request(request('alias', 2))).toMatchObject({ status: 'unavailable' });
    expect(calls).toBe(1); expect(controller.publicSettings().providers.every(provider => provider.quarantined)).toBe(true);
  });
});
