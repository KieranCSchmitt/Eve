import { randomUUID, createHash } from 'node:crypto';
import { agentRequestSchema, type AgentRequest, type AgentResult, type AgentProgress, type PublicProviderSettings } from '../../../packages/agent/src/index';
import { CredentialError, CredentialVault, configureProviderSchema, type ConfigureProviderInput, type CredentialStatus, type PublicConfiguredProvider, type SafeStorageBackend } from './credentials';
import { canonicalBinding, canonicalState, workerHostMessageSchema, type CanonicalInput, type CanonicalState, type HostWorkerMessage, type WorkerHostMessage } from './model-worker';

export type { ConfigureProviderInput, ProviderSettingsInput } from './credentials';
export type { CanonicalInput, CanonicalFileRevision, CanonicalArtifactRevision } from './model-worker';
export interface IntelligenceSettings {
  state: 'uninitialized' | 'starting' | 'ready' | 'stopped' | 'failed' | 'disposed';
  storage: CredentialStatus;
  providers: PublicConfiguredProvider[];
  cloudRequestsRemaining: number;
  localRecoveryRequired: boolean;
  localRecoveryOrigins: string[];
  message?: string;
}
export type IntelligenceEvent = { type: 'progress'; progress: AgentProgress } | { type: 'result'; result: AgentResult } | { type: 'status'; settings: IntelligenceSettings };
export interface ModelWorkerProcess {
  on(event: 'message' | 'exit' | 'error', listener: (...args: any[]) => void): unknown;
  postMessage(message: HostWorkerMessage): void;
  kill(): boolean | void;
}
export interface IntelligenceOptions {
  profilePath: string;
  workerPath: string;
  onEvent?: (event: IntelligenceEvent) => void;
  spawnWorker?: (workerPath: string, options: { env: Record<string, string> }) => ModelWorkerProcess | Promise<ModelWorkerProcess>;
  credentialBackend?: SafeStorageBackend;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxCloudRequests?: number;
}
interface Pending {
  request: AgentRequest; binding: string; fingerprint: string; promise: Promise<AgentResult>;
  resolve(result: AgentResult): void; timer: ReturnType<typeof setTimeout>;
}
const failure = (requestId: string, code: 'STALE_CONTEXT' | 'CANCELLED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_REQUEST' | 'IDEMPOTENCY_CONFLICT' | 'TIMEOUT', message: string): AgentResult => ({ requestId, code, message, status: code === 'STALE_CONTEXT' ? 'stale' : code === 'CANCELLED' ? 'cancelled' : code === 'PROVIDER_UNAVAILABLE' ? 'unavailable' : 'failed' });

/** Trusted host only. This controller never applies a model action or writes core/project content. */
export class IntelligenceController {
  private readonly vault: CredentialVault;
  private worker?: ModelWorkerProcess;
  private session?: string;
  private canonical?: CanonicalState;
  private serial = 0;
  private state: IntelligenceSettings['state'] = 'uninitialized';
  private message?: string;
  private initialized = false;
  private disposed = false;
  private configuring = false;
  private mutation = Promise.resolve();
  private pending = new Map<string, Pending>();
  private known = new Map<string, { fingerprint: string; binding: string; promise: Promise<AgentResult> }>();
  private generations = new Map<string, number>();
  private quarantined = new Set<string>();
  private quarantinedOrigins = new Set<string>();
  private localSessionIds = new Set<string>();
  private localSessionOrigins = new Map<string, string>();
  private sessionKinds = new Map<string, 'local' | 'cloud'>();
  private workerSettings: PublicProviderSettings[] = [];
  private workerJobs = { foreground: 0, background: 0, local: 0, queued: 0 };
  private cloudAdmissions = new Set<string>();
  private cloudRemaining: number;
  private startup?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private stopping?: { resolve(clean: boolean): void; timer: ReturnType<typeof setTimeout>; session: string; acknowledged: boolean };

  constructor(private readonly options: IntelligenceOptions) {
    this.vault = new CredentialVault({ profilePath: options.profilePath, backend: options.credentialBackend, platform: options.platform });
    this.cloudRemaining = options.maxCloudRequests ?? 100;
    if (!Number.isInteger(this.cloudRemaining) || this.cloudRemaining < 0 || this.cloudRemaining > 10_000) throw new Error('Invalid cloud request cap.');
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work); this.mutation = result.then(() => undefined, () => undefined); return result;
  }
  initialize(): Promise<void> {
    return this.serialized(async () => {
      if (this.disposed) throw new Error('Intelligence is disposed.');
      if (!this.initialized) {
        await this.vault.initialize(); this.quarantined = new Set(this.vault.uncertainLocalProviders()); this.quarantinedOrigins = new Set(this.vault.uncertainLocalOrigins()); this.initialized = true;
      }
      if (!this.worker) await this.startWorker();
    });
  }
  publicSettings(): IntelligenceSettings {
    const localRecoveryRequired = this.quarantined.size > 0 || this.quarantinedOrigins.size > 0;
    return structuredClone({ state: this.state, storage: this.vault.storageStatus(), providers: this.vault.publicSettings().map(provider => ({ ...provider, quarantined: (provider.kind === 'local' && localRecoveryRequired) || !!this.workerSettings.find(item => item.id === provider.id)?.quarantined })), cloudRequestsRemaining: this.cloudRemaining, localRecoveryRequired, localRecoveryOrigins: [...this.quarantinedOrigins], ...(this.message ? { message: this.message } : {}) });
  }
  configure(input: ConfigureProviderInput): Promise<IntelligenceSettings> {
    return this.serialized(async () => {
      if (!this.initialized || this.disposed) throw new CredentialError('INVALID_CONFIGURATION', 'Initialize intelligence before configuring it.');
      const parsed = configureProviderSchema.safeParse(input);
      if (!parsed.success) throw new CredentialError('INVALID_CONFIGURATION', 'The provider configuration is incomplete or invalid.');
      if (parsed.data.confirmedLocalIdle && (this.workerJobs.local > 0 || (this.localSessionIds.size > 0 && this.pending.size > 0))) throw new CredentialError('INVALID_CONFIGURATION', 'Let the current local request drain before confirming that its runtime is idle.');
      this.configuring = true;
      try {
        // Validate and durably save before stopping an otherwise working controller.
        await this.vault.configure(parsed.data);
        const clean = await this.stopWorker();
        // This explicit host confirmation covers every outstanding origin, not just a new alias ID.
        if (parsed.data.confirmedLocalIdle && parsed.data.provider.kind === 'nemotron' && clean) { this.quarantined.clear(); this.quarantinedOrigins.clear(); }
        await this.vault.markLocalUncertain([...this.quarantined], [...this.quarantinedOrigins]);
        await this.startWorker();
        return this.publicSettings();
      } finally { this.configuring = false; }
    });
  }
  syncCanonical(input: CanonicalInput): void {
    const next = canonicalState(input, this.serial + 1);
    this.serial = next.serial; this.canonical = next;
    for (const [id, job] of this.pending) if (canonicalBinding(job.request, next) !== job.binding) {
      this.send({ type: 'cancel', session: this.session!, requestId: id });
      this.finish(id, failure(id, 'STALE_CONTEXT', 'The selected activity changed. Ask again from its current state.'));
    }
    this.send({ type: 'canonical', session: this.session!, canonical: next });
  }
  request(input: AgentRequest): Promise<AgentResult> {
    const parsed = agentRequestSchema.safeParse(input);
    const id = parsed.success ? parsed.data.intent.id : typeof input?.intent?.id === 'string' ? input.intent.id.slice(0,128) : 'invalid-request';
    const reject = (result: AgentResult) => { this.emit({ type: 'result', result }); return Promise.resolve(result); };
    if (!parsed.success) return reject(failure(id, 'INVALID_REQUEST', 'The request or captured context is invalid.'));
    if (this.disposed) return reject(failure(id, 'CANCELLED', 'Intelligence has stopped.'));
    const request = structuredClone(parsed.data);
    if (Buffer.byteLength(JSON.stringify(request)) > 1_000_000) return reject(failure(id, 'INVALID_REQUEST', 'The request exceeds the worker message limit.'));
    const binding = canonicalBinding(request, this.canonical);
    if (!binding) return reject(failure(id, 'STALE_CONTEXT', 'The selected activity changed. Ask again from its current state.'));
    const generation = this.generations.get(request.intent.taskId) ?? -1;
    if (request.intent.generation < generation) return reject(failure(id, 'STALE_CONTEXT', 'A newer request superseded this one.'));
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const known = this.known.get(id);
    if (known) return known.fingerprint !== fingerprint ? reject(failure(id, 'IDEMPOTENCY_CONFLICT', 'This request identity was already used for different work.')) : known.binding !== binding ? reject(failure(id, 'STALE_CONTEXT', 'This saved response belongs to an earlier state.')) : known.promise;
    if (this.state !== 'ready' || !this.worker || this.configuring) return reject(failure(id, 'PROVIDER_UNAVAILABLE', 'The model worker is not available. Direct controls still work.'));
    if (this.pending.size >= 32) return reject(failure(id, 'INVALID_REQUEST', 'Too many requests are waiting for the model worker.'));
    if (request.intent.generation > generation) {
      for (const [otherId, other] of this.pending) if (other.request.intent.taskId === request.intent.taskId && other.request.intent.generation < request.intent.generation) this.cancel(otherId);
      this.generations.set(request.intent.taskId, request.intent.generation);
    }
    let resolve!: (result: AgentResult) => void;
    const promise = new Promise<AgentResult>(accept => { resolve = accept; });
    const timer = setTimeout(() => {
      this.send({ type: 'cancel', session: this.session!, requestId: id });
      this.finish(id, failure(id, 'TIMEOUT', 'The model worker did not settle this request in time. Your work is unchanged.'));
    // Two bounded attempts (cloud then local), including each admission queue.
    }, 225_000);
    this.pending.set(id, { request, binding, fingerprint, promise, resolve, timer });
    this.known.set(id, { fingerprint, binding, promise });
    this.send({ type: 'request', session: this.session!, request });
    return promise;
  }
  cancel(id: string): void {
    if (!this.pending.has(id)) return;
    this.send({ type: 'cancel', session: this.session!, requestId: id });
    this.finish(id, failure(id, 'CANCELLED', 'The request was cancelled.'));
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return this.serialized(async () => {
      try { await this.stopWorker(); }
      finally { this.vault.clearMemory(); this.state = 'disposed'; this.message = undefined; this.status(); }
    });
  }

  private async startWorker(): Promise<void> {
    this.state = 'starting'; this.message = undefined; this.workerSettings = []; this.workerJobs = { foreground: 0, background: 0, local: 0, queued: 0 }; this.status();
    const blockLocal = this.quarantined.size > 0 || this.quarantinedOrigins.size > 0;
    const providers = this.vault.workerProviders().map(entry => ({ ...entry, config: { ...entry.config, enabled: !!entry.config.enabled && !(entry.config.kind === 'nemotron' && blockLocal) } }));
    this.sessionKinds = new Map(providers.map(entry => [entry.config.id, entry.config.kind === 'openai' ? 'cloud' : 'local']));
    this.localSessionIds = new Set(providers.filter(entry => entry.config.kind === 'nemotron' && entry.config.enabled).map(entry => entry.config.id));
    this.localSessionOrigins = new Map(providers.filter(entry => entry.config.kind === 'nemotron' && entry.config.enabled).map(entry => [entry.config.id, new URL((entry.config as { endpoint: string }).endpoint).origin]));
    try { await this.vault.markLocalUncertain([...this.quarantined, ...this.localSessionIds], [...this.quarantinedOrigins, ...this.localSessionOrigins.values()]); }
    catch (error) { this.state = 'failed'; this.message = 'The model recovery marker could not be saved. No worker was started.'; this.status(); throw error; }
    const session = randomUUID(); this.session = session;
    // Electron otherwise inherits process.env. Allow only locale/temp settings, never keys or NODE_OPTIONS.
    const env: Record<string, string> = {};
    for (const key of ['LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]!;
    const spawn = this.options.spawnWorker ?? (async (workerPath: string, options: { env: Record<string,string> }) => {
      const { utilityProcess } = await import('electron');
      return utilityProcess.fork(workerPath, [], { env: options.env, execArgv: [], stdio: 'ignore', serviceName: 'Eve Intelligence' });
    });
    let worker: ModelWorkerProcess;
    try { worker = await spawn(this.options.workerPath, { env }); }
    catch { this.crashed(); throw new Error('The model worker could not start.'); }
    this.worker = worker;
    let booted = false;
    const ready = new Promise<void>((resolve, reject) => {
      this.startup = { resolve, reject, timer: setTimeout(() => { this.startup = undefined; this.crashed(); worker.kill(); reject(new Error('The model worker did not become ready.')); }, this.options.startupTimeoutMs ?? 10_000) };
    });
    worker.on('message', raw => {
      if (this.worker !== worker || this.session !== session) return;
      let parsed: ReturnType<typeof workerHostMessageSchema.safeParse>;
      try { if (Buffer.byteLength(JSON.stringify(raw)) > 256_000) return; parsed = workerHostMessageSchema.safeParse(raw); } catch { return; }
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'hello') {
        if (booted) return; booted = true;
        worker.postMessage({ type: 'boot', session, providers, canonical: this.canonical, maxCloudRequests: this.cloudRemaining });
        // Worker closure no longer needs its own copy of plaintext credentials after boot.
        for (const entry of providers) delete entry.credential;
      } else if (message.session === session) this.receive(message);
    });
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      // The stopped acknowledgement is terminal even if the process exits in
      // this event turn before the awaiting shutdown continuation can resume.
      if (this.stopping?.session === session && this.stopping.acknowledged) return;
      this.crashed();
    });
    worker.on('error', () => { if (this.worker === worker) { this.crashed(); worker.kill(); } });
    await ready;
  }
  private receive(message: Exclude<WorkerHostMessage, { type: 'hello' }>): void {
    if (message.type === 'ready') {
      if (this.startup) { clearTimeout(this.startup.timer); this.startup.resolve(); this.startup = undefined; }
      this.state = 'ready'; this.status();
    } else if (message.type === 'fatal') { const worker = this.worker; this.crashed(); worker?.kill(); }
    else if (message.type === 'stopped') {
      if (this.stopping?.session === message.session) { clearTimeout(this.stopping.timer); this.stopping.acknowledged = true; this.stopping.resolve(true); }
    } else if (message.type === 'state') {
      this.workerSettings = message.providers; this.workerJobs = message.jobs;
      for (const provider of message.providers) if (provider.quarantined && provider.kind === 'local') {
        this.quarantined.add(provider.id); this.quarantinedOrigins.add(new URL(provider.endpoint).origin);
      }
      this.status();
    } else if (message.type === 'progress') {
      const progress = message.progress;
      if (progress.type === 'running' && this.sessionKinds.get(progress.providerId) === 'cloud' && !this.cloudAdmissions.has(progress.requestId)) {
        this.cloudAdmissions.add(progress.requestId); this.cloudRemaining = Math.max(0, this.cloudRemaining - 1);
      }
      const job = this.pending.get(progress.requestId);
      if (!job || canonicalBinding(job.request, this.canonical) !== job.binding) return;
      this.emit({ type: 'progress', progress: message.progress });
    } else if (message.type === 'result') {
      const job = this.pending.get(message.result.requestId);
      if (!job) return;
      const result = canonicalBinding(job.request, this.canonical) !== job.binding ? failure(message.result.requestId, 'STALE_CONTEXT', 'The selected activity changed while Eve was working.') : message.result;
      // Worker results remain proposals; malicious/invalid authority flags cannot survive this boundary.
      if (result.status === 'complete' && result.origin === 'model-proposal') { result.requiresUserAction = result.actions.length > 0; result.focusPolicy = 'preserve'; }
      if (result.status === 'complete' && JSON.stringify(result.context) !== JSON.stringify(job.request.context)) {
        this.finish(result.requestId, failure(result.requestId, 'STALE_CONTEXT', 'The response does not match the captured context.')); return;
      }
      this.finish(message.result.requestId, result);
    }
  }
  private async stopWorker(): Promise<boolean> {
    for (const id of [...this.pending.keys()]) this.cancel(id);
    const worker = this.worker;
    if (!worker) return true;
    const clean = await new Promise<boolean>(resolve => {
      this.stopping = { resolve, session: this.session!, acknowledged: false, timer: setTimeout(() => { this.stopping = undefined; resolve(false); }, this.options.shutdownTimeoutMs ?? 1000) };
      this.send({ type: 'shutdown', session: this.session! });
    });
    this.stopping = undefined;
    if (!clean) this.quarantineSession();
    this.worker = undefined; this.session = undefined; worker.kill();
    this.localSessionIds.clear(); this.localSessionOrigins.clear(); this.workerJobs = { foreground: 0, background: 0, local: 0, queued: 0 };
    this.state = 'stopped';
    try { await this.vault.markLocalUncertain([...this.quarantined], [...this.quarantinedOrigins]); }
    catch (error) { this.state = 'failed'; this.message = 'The model worker stopped, but its recovery marker could not be updated.'; this.status(); throw error; }
    this.status(); return clean;
  }
  private crashed(): void {
    this.quarantineSession();
    this.worker = undefined; this.session = undefined;
    if (this.startup) { clearTimeout(this.startup.timer); this.startup.reject(new Error('The model worker stopped before initialization.')); this.startup = undefined; }
    if (this.stopping) { clearTimeout(this.stopping.timer); this.stopping.resolve(false); this.stopping = undefined; }
    for (const id of [...this.pending.keys()]) this.finish(id, failure(id, 'PROVIDER_UNAVAILABLE', 'The model worker stopped. Your work is unchanged.'));
    this.state = 'failed'; this.message = 'The model worker stopped. Local providers require an idle-runtime check before reuse.'; this.status();
  }
  private quarantineSession(): void {
    for (const id of this.localSessionIds) this.quarantined.add(id);
    for (const origin of this.localSessionOrigins.values()) this.quarantinedOrigins.add(origin);
  }
  private send(message: HostWorkerMessage): void {
    if (!this.worker || !this.session) return;
    try { this.worker.postMessage(message); } catch { const worker = this.worker; this.crashed(); worker?.kill(); }
  }
  private finish(id: string, result: AgentResult): void {
    const job = this.pending.get(id); if (!job) return;
    clearTimeout(job.timer); this.pending.delete(id); job.resolve(structuredClone(result)); this.emit({ type: 'result', result });
    for (const known of this.known.keys()) { if (this.known.size <= 128) break; if (!this.pending.has(known)) this.known.delete(known); }
  }
  private status(): void { this.emit({ type: 'status', settings: this.publicSettings() }); }
  private emit(event: IntelligenceEvent): void { try { this.options.onEvent?.(structuredClone(event)); } catch { /* Presentation cannot change worker authority. */ } }
}
