import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contextSnapshotSchema, type CoreSnapshot } from '../../../packages/contracts/src/index';
import {
  AgentFailure, agentRequestSchema, canvasSelectionIsCurrent, canvasLearningIsCurrent, canvasSuggestionIsCurrent, canvasSuggestionRefreshIsCurrent, createAgentService, createProvider, nemotronProviderConfigSchema, openAIProviderConfigSchema, registeredActionSchema,
  type AgentProgress, type AgentRequest, type AgentResult, type AgentService, type AgentServiceOptions, type PublicProviderSettings,
} from '../../../packages/agent/src/index';
import type { PrivateProvider } from './credentials';

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => ['.', '..', ''].includes(part)) && !/^[a-z]:/i.test(value));
export const canonicalFileSchema = z.object({ taskId: id, targetId: id, path: relative, revision, sha256: hash, documentVersion: revision.optional(), contentRange: z.object({ start: revision, end: revision, total: revision }).strict().optional() }).strict();
export type CanonicalFileRevision = z.infer<typeof canonicalFileSchema>;
export const canonicalArtifactSchema = z.object({ taskId: id, artifactId: id, revision }).strict();
export type CanonicalArtifactRevision = z.infer<typeof canonicalArtifactSchema>;
export interface CanonicalInput { snapshot: CoreSnapshot; files: CanonicalFileRevision[]; artifacts?: CanonicalArtifactRevision[] }
export const canonicalStateSchema = z.object({
  serial: revision, activeTaskId: id.nullable(),
  tasks: z.array(z.object({ id, epoch: revision, revision, noteId: id, noteRevision: revision, parametersRevision: revision.nullable(), parametersHash: hash.nullable(), canvasRevision: revision.default(0), canvasHash: hash.nullable().default(null), processing: z.enum(['local-only', 'hybrid']), assistancePaused: z.boolean() }).strict()).max(10_000),
  files: z.array(canonicalFileSchema).max(500), artifacts: z.array(canonicalArtifactSchema).max(500),
}).strict().superRefine((state, context) => {
  const taskIds = new Set<string>(); const files = new Set<string>(); const revisions = new Map<string, number>(); const artifacts = new Set<string>();
  for (const task of state.tasks) {
    if (taskIds.has(task.id)) context.addIssue({ code: 'custom', message: 'Duplicate canonical task identity' });
    taskIds.add(task.id);
  }
  for (const file of state.files) {
    const target = JSON.stringify([file.taskId, file.targetId]); const key = JSON.stringify([file.taskId, file.targetId, file.path]);
    if (!taskIds.has(file.taskId) || files.has(key) || (revisions.has(target) && revisions.get(target) !== file.revision)) context.addIssue({ code: 'custom', message: 'Ambiguous canonical file identity or target revision' });
    files.add(key); revisions.set(target, file.revision);
  }
  for (const artifact of state.artifacts) {
    const key = JSON.stringify([artifact.taskId, artifact.artifactId]);
    if (!taskIds.has(artifact.taskId) || artifacts.has(key)) context.addIssue({ code: 'custom', message: 'Ambiguous canonical artifact identity' });
    artifacts.add(key);
  }
});
export type CanonicalState = z.infer<typeof canonicalStateSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const parameterDigest = (value: { theme: string; durationMinutes: number; transitionMs: number; easing: readonly number[] }) => digest(JSON.stringify([value.theme, value.durationMinutes, value.transitionMs, value.easing]));
export function canonicalState(input: CanonicalInput, serial: number): CanonicalState {
  return canonicalStateSchema.parse({ serial, activeTaskId: input.snapshot.activeTaskId,
    tasks: input.snapshot.tasks.map(task => ({ id: task.id, epoch: task.epoch, revision: task.revision, noteId: task.note.id, noteRevision: task.note.revision, parametersRevision: task.parameters?.revision ?? null, parametersHash: task.parameters ? parameterDigest(task.parameters.values) : null, canvasRevision: task.canvas?.revision ?? 0, canvasHash: task.canvas?.document ? digest(JSON.stringify(task.canvas.document)) : null, processing: task.policy.processing, assistancePaused: task.policy.assistancePaused })),
    files: input.files, artifacts: input.artifacts ?? [],
  });
}

/** A fingerprint of canonical state relevant to this request, never a model-provided authority claim. */
export function canonicalBinding(request: AgentRequest, state: CanonicalState | undefined): string | null {
  if (!canvasSelectionIsCurrent(request) || !canvasLearningIsCurrent(request) || !canvasSuggestionIsCurrent(request) || !canvasSuggestionRefreshIsCurrent(request)) return null;
  if (!state || state.activeTaskId !== request.intent.taskId || request.context.taskId !== request.intent.taskId || request.context.id !== request.intent.contextSnapshotId || request.context.taskEpoch !== request.intent.taskEpoch) return null;
  const task = state.tasks.find(item => item.id === state.activeTaskId);
  if (!task || task.epoch !== request.intent.taskEpoch || (task.processing === 'local-only' && request.policy === 'hybrid') || (task.assistancePaused && request.priority === 'background')) return null;
  const files = state.files.filter(file => file.taskId === task.id);
  const artifactRevision = (artifactId: string): number | undefined => {
    if (artifactId === task.noteId) return task.noteRevision;
    if (artifactId === `${task.id}:parameters`) return task.parametersRevision ?? undefined;
    if (artifactId === `${task.id}:canvas`) return task.canvasRevision;
    const matches = files.filter(file => file.targetId === artifactId);
    if (matches.length && matches.every(file => file.revision === matches[0].revision)) return matches[0].revision;
    return state.artifacts.find(item => item.taskId === task.id && item.artifactId === artifactId)?.revision;
  };
  if (request.context.selection && artifactRevision(request.context.selection.artifactId) !== request.context.selection.revision) return null;
  const relevantFiles: CanonicalFileRevision[] = [];
  for (const target of request.targets) {
    if (target.kind === 'note') {
      if (target.id !== task.noteId || target.revision !== task.noteRevision) return null;
    } else if (target.kind === 'parameters') {
      if (target.id !== `${task.id}:parameters` || target.revision !== task.parametersRevision || !target.parameters || parameterDigest(target.parameters) !== task.parametersHash) return null;
    } else if (target.kind === 'canvas') {
      if (target.id !== `${task.id}:canvas` || target.revision !== task.canvasRevision || (target.canvas ? digest(JSON.stringify(target.canvas)) : null) !== task.canvasHash) return null;
    } else {
      if (!target.files?.length) return null;
      for (const file of target.files) {
        const canonical = files.find(item => item.targetId === target.id && item.path === file.path);
        if (!canonical || canonical.revision !== target.revision || canonical.sha256 !== digest(file.content) || JSON.stringify(canonical.contentRange) !== JSON.stringify(file.contentRange)) return null;
        relevantFiles.push(canonical);
      }
    }
  }
  return digest(JSON.stringify({ task, selection: request.context.selection ? [request.context.selection.artifactId, artifactRevision(request.context.selection.artifactId)] : null, files: relevantFiles, ...(request.canvasSuggestion ? { canvasSuggestion: request.canvasSuggestion } : {}), ...(request.canvasSuggestionRefresh ? { canvasSuggestionRefresh: request.canvasSuggestionRefresh } : {}), ...(request.canvasLearning ? { canvasLearning: request.canvasLearning } : {}), ...(request.canvasSelection ? { canvasSelection: request.canvasSelection } : {}) }));
}

const privateProviderSchema = z.object({ config: z.union([openAIProviderConfigSchema, nemotronProviderConfigSchema]), credential: z.string().min(1).max(4096).optional(), storage: z.enum(['secure', 'runtime-only']) }).strict();
export const hostWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boot'), session: id, providers: z.array(privateProviderSchema).max(8), canonical: canonicalStateSchema.optional(), maxCloudRequests: revision.max(10_000) }).strict(),
  z.object({ type: z.literal('canonical'), session: id, canonical: canonicalStateSchema }).strict(),
  z.object({ type: z.literal('request'), session: id, request: agentRequestSchema }).strict(),
  z.object({ type: z.literal('cancel'), session: id, requestId: id }).strict(),
  z.object({ type: z.literal('shutdown'), session: id }).strict(),
]);
export type HostWorkerMessage = z.input<typeof hostWorkerMessageSchema>;
export const progressSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queued'), requestId: id }).strict(),
  z.object({ type: z.literal('running'), requestId: id, providerId: id }).strict(),
  z.object({ type: z.literal('generating'), requestId: id, receivedCharacters: revision.max(64_000) }).strict(),
  z.object({ type: z.literal('completed'), requestId: id, status: z.enum(['complete','failed','unavailable','cancelled','stale']) }).strict(),
]);
export const agentResultSchema = z.union([
  z.object({ status: z.literal('complete'), requestId: id, message: z.string().max(12_000), basis: z.enum(['sources','selection','general']), citations: z.array(z.object({ sourceId: id, title: z.string().max(300), uri: z.string().max(2048), quote: z.string().max(2000), provenance: z.enum(['attached','retrieved','authored-notes']), mediaTime: z.number().nonnegative().optional() }).strict()).max(12), actions: z.array(registeredActionSchema).max(6), needsClarification: z.boolean(), origin: z.enum(['registered-command','model-proposal']), requiresUserAction: z.boolean(), focusPolicy: z.enum(['preserve','user-requested']), provider: z.object({ id, kind: z.enum(['local','cloud']), model: z.string().max(200) }).strict().nullable(), usage: z.object({ inputTokens: revision.optional(), outputTokens: revision.optional() }).strict(), context: contextSnapshotSchema }).strict(),
  z.object({ status: z.enum(['failed','unavailable','cancelled','stale']), requestId: id, code: z.enum(['INVALID_REQUEST','INVALID_OUTPUT','UNKNOWN_SOURCE','UNSUPPORTED_ACTION','STALE_CONTEXT','PROVIDER_UNAVAILABLE','CREDENTIALS_UNAVAILABLE','PROVIDER_ERROR','PROVIDER_REFUSAL','INCOMPLETE_OUTPUT','CONTEXT_LIMIT','QUEUE_FULL','TIMEOUT','CANCELLED','PREEMPTED','IDEMPOTENCY_CONFLICT','CLOUD_LIMIT','LOCAL_STATE_UNKNOWN']), message: z.string().max(2000) }).strict(),
]);
export const publicProviderSchema = z.object({ id, kind: z.enum(['local','cloud']), model: z.string().max(200), enabled: z.boolean(), protocol: z.enum(['openai-responses','openai-chat-completions']), endpoint: z.string().url().max(4096), roles: z.array(z.enum(['route','explain','prepare','code'])).max(4), authentication: z.enum(['none','credential-store']), cancellationMode: z.enum(['verified-disconnect','unverified']).optional(), quarantined: z.boolean().optional() }).strict();
export const workerHostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.literal(1) }).strict(),
  z.object({ type: z.literal('ready'), session: id }).strict(),
  z.object({ type: z.literal('progress'), session: id, progress: progressSchema }).strict(),
  z.object({ type: z.literal('result'), session: id, result: agentResultSchema }).strict(),
  z.object({ type: z.literal('state'), session: id, providers: z.array(publicProviderSchema).max(8), jobs: z.object({ foreground: revision, background: revision, local: revision, queued: revision }).strict() }).strict(),
  z.object({ type: z.literal('stopped'), session: id }).strict(),
  z.object({ type: z.literal('fatal'), session: id.optional(), message: z.literal('The model worker could not initialize safely.') }).strict(),
]);
export type WorkerHostMessage = z.infer<typeof workerHostMessageSchema>;

/** Exported for boundary tests; the real entrypoint attaches this to Electron's private parentPort. */
export function createModelWorkerRuntime(options: {
  send(message: WorkerHostMessage): void;
  serviceFactory?: (options: AgentServiceOptions) => AgentService;
  providerFactory?: typeof createProvider;
}) {
  let session: string | undefined;
  let service: AgentService | undefined;
  let state: CanonicalState | undefined;
  let stopping = false;
  let localUncertain = false;
  const credentials = new Map<string, string>();
  const active = new Map<string, { request: AgentRequest; binding: string }>();
  let previousStatus = '';
  const status = () => {
    if (!service || !session) return;
    const message = { type: 'state' as const, session, providers: service.getPublicSettings().map(provider => ({ ...provider, roles: [...provider.roles], quarantined: !!provider.quarantined || (provider.kind === 'local' && localUncertain) })), jobs: service.getJobCounts() };
    const serialized = JSON.stringify(message);
    if (serialized !== previousStatus) { previousStatus = serialized; options.send(message); }
    if (stopping && !Object.values(message.jobs).some(Boolean)) { credentials.clear(); clearInterval(timer); options.send({ type: 'stopped', session }); service = undefined; }
  };
  const timer = setInterval(status, 100); timer.unref?.();
  const handle = (raw: unknown) => {
    let parsed: ReturnType<typeof hostWorkerMessageSchema.safeParse>;
    try { if (Buffer.byteLength(JSON.stringify(raw)) > 1_000_000) return; parsed = hostWorkerMessageSchema.safeParse(raw); } catch { return; }
    if (!parsed.success) return;
    const data = parsed.data;
    if (data.type === 'boot') {
      if (session) return;
      session = data.session; state = data.canonical;
      try {
        const providers = data.providers.map(entry => {
          const config = entry.config;
          const reference = config.kind === 'openai' ? config.credentialRef : config.authentication.type === 'bearer' ? config.authentication.credentialRef : undefined;
          if (reference && entry.credential) credentials.set(reference, entry.credential);
          const provider = (options.providerFactory ?? createProvider)(config, { resolveCredential: async ref => credentials.get(ref) });
          if (provider.kind !== 'local') return provider;
          return { ...provider, async generate(input: Parameters<typeof provider.generate>[0], callbacks: Parameters<typeof provider.generate>[1]) {
            if (localUncertain) throw new AgentFailure('LOCAL_STATE_UNKNOWN', 'Verify all outstanding local runtimes are idle before another local request.');
            try { return await provider.generate(input, callbacks); }
            catch (error) { if (error instanceof AgentFailure && error.code === 'LOCAL_STATE_UNKNOWN') localUncertain = true; throw error; }
          } };
        });
        service = (options.serviceFactory ?? createAgentService)({ providers, maxCloudRequests: data.maxCloudRequests, localRequestTimeoutMs: 120_000, isCurrent: request => {
          const expected = active.get(request.intent.id)?.binding;
          const current = canonicalBinding(request, state);
          return !!current && (!expected || expected === current);
        } });
        options.send({ type: 'ready', session }); status();
      } catch { credentials.clear(); options.send({ type: 'fatal', session, message: 'The model worker could not initialize safely.' }); }
      return;
    }
    if (data.session !== session || !service) return;
    if (data.type === 'canonical') {
      if (!state || data.canonical.serial > state.serial) state = data.canonical;
      for (const [requestId, job] of active) if (canonicalBinding(job.request, state) !== job.binding) service.cancel(requestId);
    } else if (data.type === 'cancel') service.cancel(data.requestId);
    else if (data.type === 'shutdown') { stopping = true; service.dispose(); status(); }
    else if (data.type === 'request' && !stopping) {
      const request = data.request;
      const binding = canonicalBinding(request, state);
      if (!binding) { options.send({ type: 'result', session, result: { status: 'stale', requestId: request.intent.id, code: 'STALE_CONTEXT', message: 'The selected activity changed. Ask again from its current state.' } }); return; }
      if (active.has(request.intent.id)) return;
      active.set(request.intent.id, { request, binding });
      void service.request(request, { onProgress: progress => { if (!stopping) options.send({ type: 'progress', session: session!, progress }); status(); } }).then(result => {
        if (!stopping) options.send({ type: 'result', session: session!, result: canonicalBinding(request, state) === binding ? result : { status: 'stale', requestId: request.intent.id, code: 'STALE_CONTEXT', message: 'The selected activity changed while Eve was working.' } });
      }, () => { if (!stopping) options.send({ type: 'result', session: session!, result: { status: 'failed', requestId: request.intent.id, code: 'PROVIDER_ERROR', message: 'The model request failed. Your work is unchanged.' } }); })
        .finally(() => { active.delete(request.intent.id); status(); });
    }
  };
  options.send({ type: 'hello', version: 1 });
  return { handle, dispose() { stopping = true; service?.dispose(); credentials.clear(); clearInterval(timer); } };
}

const parentPort = (process as unknown as { parentPort?: { on(event: 'message', callback: (event: { data: unknown }) => void): void; postMessage(message: unknown): void } }).parentPort;
if (parentPort) {
  // The host terminates this process after receiving stopped. Exiting here can
  // overtake delivery of the acknowledgement and falsely quarantine an idle model.
  const runtime = createModelWorkerRuntime({ send: message => parentPort.postMessage(message) });
  parentPort.on('message', event => runtime.handle(event.data));
}
