import { z } from 'zod';
import {
  assertCanvasLearningScope, assertCanvasSuggestionRefreshScope, canvasDocumentSchema, canvasSuggestionSelectionSchema, canvasSuggestionRefreshScopeSchema, activitySchema, contextSnapshotSchema, intentRequestSchema, orbitParametersSchema,
} from '../../contracts/src/index.js';
import type { ContextSnapshot, IntentRequest, OrbitParameters } from '../../contracts/src/index.js';

export type AgentRole = 'route' | 'explain' | 'prepare' | 'code';
export type ProcessingPolicy = 'hybrid' | 'local-only' | 'offline';
export type JobPriority = 'foreground' | 'background';
export const agentRoleSchema = z.enum(['route', 'explain', 'prepare', 'code']);

export const sourceRecordSchema = z.object({
  id: z.string().min(1).max(128), title: z.string().min(1).max(300),
  uri: z.string().max(2048), excerpt: z.string().max(32_000),
  provenance: z.enum(['attached', 'retrieved', 'authored-notes']),
  retrievedAt: z.number().int().nonnegative(),
  exposure: z.enum(['local-only', 'cloud-allowed']).default('local-only'),
  mediaTime: z.number().nonnegative().optional(),
}).strict();
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

const relativePathSchema = z.string().min(1).max(500).refine(path =>
  !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some(part => part === '..' || part === '.' || part === '') && !/^[a-z]:/i.test(path),
  'Expected a project-relative path without traversal.');

export const editableTargetSchema = z.object({
  id: z.string().min(1).max(128), revision: z.number().int().nonnegative(),
  kind: z.enum(['parameters', 'note', 'workspace', 'canvas']),
  parameters: orbitParametersSchema.optional(),
  canvas: canvasDocumentSchema.optional(),
  assets: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().max(240), mediaType: z.string().max(128) }).strict()).max(100).optional(),
  files: z.array(z.object({ path: relativePathSchema, content: z.string().max(64_000),
    /** Original document offsets when the trusted host admits only a selected passage. */
    contentRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
  }).strict().refine(value => !value.contentRange || (value.contentRange.end - value.contentRange.start === value.content.length && value.contentRange.end <= value.contentRange.total), 'The admitted file range must match its content.')).max(20).optional(),
}).strict();
export type EditableTarget = z.infer<typeof editableTargetSchema>;

export const canvasSuggestionRefreshSchema = z.object({
  targetId: z.string().min(1).max(128), canvasRevision: z.number().int().nonnegative(),
  scope: canvasSuggestionRefreshScopeSchema.optional(),
}).strict();

export const canvasLearningSchema = z.object({
  targetId: z.string().min(1).max(128), canvasRevision: z.number().int().nonnegative(),
  scope: canvasSuggestionRefreshScopeSchema.refine(scope => !!scope.selection, 'Learning requires selected text.'),
}).strict();

export const canvasSelectionSchema = z.object({
  targetId: z.string().min(1).max(128), canvasRevision: z.number().int().nonnegative(),
  scope: canvasSuggestionRefreshScopeSchema.refine(scope => !!scope.selection, 'A selection request requires selected text.'),
}).strict();

export const agentRequestSchema = z.object({
  intent: intentRequestSchema, context: contextSnapshotSchema,
  purpose: z.string().max(1000), policy: z.enum(['hybrid', 'local-only', 'offline']),
  priority: z.enum(['foreground', 'background']), role: agentRoleSchema,
  sources: z.array(sourceRecordSchema).max(100), targets: z.array(editableTargetSchema).max(20),
  canvasSuggestion: canvasSuggestionSelectionSchema.extend({ targetBlockId: z.string().min(1).max(128).nullable() }).strict().optional(),
  canvasSuggestionRefresh: canvasSuggestionRefreshSchema.optional(),
  canvasLearning: canvasLearningSchema.optional(),
  canvasSelection: canvasSelectionSchema.optional(),
}).strict().refine(value => [value.canvasSuggestion, value.canvasSuggestionRefresh, value.canvasLearning, value.canvasSelection].filter(Boolean).length <= 1, 'Choose only one canvas assistance mode.');
export interface AgentRequest {
  intent: IntentRequest;
  context: ContextSnapshot;
  purpose: string;
  policy: ProcessingPolicy;
  priority: JobPriority;
  role: AgentRole;
  sources: SourceRecord[];
  targets: EditableTarget[];
  /** Host-resolved selection from the exact durable canvas revision. */
  canvasSuggestion?: { id: string; canvasRevision: number; targetBlockId: string | null };
  /** Explicit host-created request to change passive choices, never authored work. */
  canvasSuggestionRefresh?: z.infer<typeof canvasSuggestionRefreshSchema>;
  /** Read-only explanation bound to an exact captured canvas passage. */
  canvasLearning?: z.infer<typeof canvasLearningSchema>;
  /** Arbitrary user request bound to an exact selected passage; proposed edits still require approval. */
  canvasSelection?: z.infer<typeof canvasSelectionSchema>;
}

export function canvasSuggestionIsCurrent(request: AgentRequest): boolean {
  if (!request.canvasSuggestion) return true;
  if (request.canvasSuggestionRefresh || request.canvasLearning || request.canvasSelection) return false;
  const selected = request.canvasSuggestion;
  const targets = request.targets.filter(target => target.kind === 'canvas');
  if (targets.length !== 1 || targets[0]!.revision !== selected.canvasRevision || request.priority !== 'foreground' || request.role !== 'prepare') return false;
  const suggestion = targets[0]!.canvas?.suggestions?.find(item => item.id === selected.id);
  return !!suggestion && suggestion.targetBlockId === selected.targetBlockId && suggestion.request.trim() === request.intent.text.trim();
}

export function canvasSuggestionRefreshIsCurrent(request: AgentRequest): boolean {
  if (!request.canvasSuggestionRefresh) return true;
  if (request.canvasSuggestion || request.canvasLearning || request.canvasSelection || request.priority !== 'foreground' || request.role !== 'prepare') return false;
  const refresh = request.canvasSuggestionRefresh;
  const canvases = request.targets.filter(target => target.kind === 'canvas');
  if (canvases.length !== 1 || canvases[0]!.id !== refresh.targetId || canvases[0]!.revision !== refresh.canvasRevision || !canvases[0]!.canvas) return false;
  try { if (refresh.scope) assertCanvasSuggestionRefreshScope(canvases[0]!.canvas, refresh.scope); }
  catch { return false; }
  return true;
}

export function canvasLearningIsCurrent(request: AgentRequest): boolean {
  if (!request.canvasLearning) return true;
  if (request.canvasSuggestion || request.canvasSuggestionRefresh || request.canvasSelection || request.priority !== 'foreground' || request.role !== 'explain' || request.targets.length !== 1) return false;
  const learning = request.canvasLearning, target = request.targets[0]!;
  if (target.kind !== 'canvas' || target.id !== learning.targetId || target.revision !== learning.canvasRevision || !target.canvas) return false;
  try { assertCanvasLearningScope(target.canvas, learning.scope); }
  catch { return false; }
  return true;
}

export function canvasSelectionIsCurrent(request: AgentRequest): boolean {
  if (!request.canvasSelection) return true;
  if (request.canvasSuggestion || request.canvasSuggestionRefresh || request.canvasLearning || request.priority !== 'foreground' || request.role !== 'prepare' || request.targets.length !== 1) return false;
  const selected = request.canvasSelection, target = request.targets[0]!;
  if (target.kind !== 'canvas' || target.id !== selected.targetId || target.revision !== selected.canvasRevision || !target.canvas) return false;
  try { assertCanvasLearningScope(target.canvas, selected.scope); }
  catch { return false; }
  return true;
}

export const registeredActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SearchSources'), query: z.string().trim().min(1).max(300), kind: z.enum(['video', 'article']) }).strict(),
  z.object({ type: z.literal('ComposeCanvas'), targetId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(), document: canvasDocumentSchema }).strict(),
  z.object({ type: z.literal('ChangeAttention'), activity: activitySchema }).strict(),
  z.object({ type: z.literal('RestoreCheckpoint') }).strict(),
  z.object({ type: z.literal('RecallTask'), query: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal('Undo') }).strict(),
  z.object({ type: z.literal('PauseAssistance') }).strict(),
  z.object({
    type: z.literal('SetParameter'), targetId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(),
    name: z.enum(['theme', 'durationMinutes', 'transitionMs', 'easing']),
    value: z.union([z.string(), z.number(), z.array(z.number()).length(4)]),
  }).strict(),
  z.object({
    type: z.literal('ProposeNoteEdit'), targetId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(),
    text: z.string().max(24_000),
  }).strict(),
  z.object({
    type: z.literal('ProposeWorkspaceEdit'), targetId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(),
    edits: z.array(z.object({ path: relativePathSchema, before: z.string().min(1).max(8000), after: z.string().max(8000) }).strict()).min(1).max(8),
  }).strict(),
]);
export type RegisteredAction = z.infer<typeof registeredActionSchema>;

export const modelProposalSchema = z.object({
  version: z.literal(1), message: z.string().min(1).max(12_000),
  basis: z.enum(['sources', 'selection', 'general']),
  citations: z.array(z.object({ sourceId: z.string().min(1).max(128), quote: z.string().max(2000) }).strict()).max(12),
  actions: z.array(registeredActionSchema).max(6),
  needsClarification: z.boolean(),
}).strict();
export type ModelProposal = z.infer<typeof modelProposalSchema>;

export interface ResolvedCitation {
  sourceId: string; title: string; uri: string; quote: string;
  provenance: SourceRecord['provenance']; mediaTime?: number;
}
export interface Usage { inputTokens?: number; outputTokens?: number; }
export type AgentErrorCode =
  | 'INVALID_REQUEST' | 'INVALID_OUTPUT' | 'UNKNOWN_SOURCE' | 'UNSUPPORTED_ACTION' | 'STALE_CONTEXT'
  | 'PROVIDER_UNAVAILABLE' | 'CREDENTIALS_UNAVAILABLE' | 'PROVIDER_ERROR' | 'PROVIDER_REFUSAL'
  | 'INCOMPLETE_OUTPUT' | 'CONTEXT_LIMIT' | 'QUEUE_FULL' | 'TIMEOUT' | 'CANCELLED'
  | 'PREEMPTED' | 'IDEMPOTENCY_CONFLICT' | 'CLOUD_LIMIT' | 'LOCAL_STATE_UNKNOWN';

export type AgentResult = {
  status: 'complete'; requestId: string; message: string; basis: ModelProposal['basis'];
  citations: ResolvedCitation[]; actions: RegisteredAction[]; needsClarification: boolean;
  origin: 'registered-command' | 'model-proposal';
  /** The host revalidates/authorizes proposals through the broker; the model never grants authority. */
  requiresUserAction: boolean; focusPolicy: 'preserve' | 'user-requested';
  provider: { id: string; kind: 'local' | 'cloud'; model: string } | null;
  usage: Usage; context: ContextSnapshot;
} | {
  status: 'failed' | 'unavailable' | 'cancelled' | 'stale'; requestId: string;
  code: AgentErrorCode; message: string;
};

export type AgentProgress =
  | { type: 'queued'; requestId: string }
  | { type: 'running'; requestId: string; providerId: string }
  | { type: 'generating'; requestId: string; receivedCharacters: number }
  | { type: 'completed'; requestId: string; status: AgentResult['status'] };

export interface ProviderInput { instructions: string; data: string; schema: Record<string, unknown>; /** Trusted per-request cap, never larger than configured provider limits. */ maxOutputTokens?: number; }
export interface ProviderOutput { text: string; usage: Usage; }
export interface AgentProvider {
  readonly id: string; readonly kind: 'local' | 'cloud'; readonly model: string;
  readonly roles: readonly AgentRole[]; readonly enabled: boolean;
  /** Optional qualification boundary for a model dedicated to selected canvas text. */
  readonly requestScope?: 'canvas-selection';
  generate(input: ProviderInput, options: {
    signal: AbortSignal; onTextDelta: (delta: string) => void;
  }): Promise<ProviderOutput>;
  publicSettings(): PublicProviderSettings;
}

export interface PublicProviderSettings {
  id: string; kind: 'local' | 'cloud'; model: string; enabled: boolean;
  protocol: 'openai-responses' | 'openai-chat-completions'; endpoint: string;
  roles: readonly AgentRole[]; authentication: 'none' | 'credential-store';
  requestScope?: 'canvas-selection';
  cancellationMode?: 'verified-disconnect' | 'unverified';
  quarantined?: boolean;
}

export interface AgentServiceOptions {
  providers: readonly AgentProvider[];
  /** Trusted host checks task epoch, selection revisions, and target/file revisions. */
  isCurrent(request: AgentRequest): boolean;
  maxQueuedJobs?: number;
  queueTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional longer local generation budget; cloud waits retain requestTimeoutMs. */
  localRequestTimeoutMs?: number;
  maxContextBytes?: number;
  maxOutputCharacters?: number;
  /** Hard request admission cap, not a claim about provider dollars or credit balance. */
  maxCloudRequests?: number;
  onTelemetry?: (event: {
    requestId: string; providerId: string; role: AgentRole; status: AgentResult['status'];
    durationMs: number; inputTokens?: number; outputTokens?: number;
  }) => void;
}

export interface AgentService {
  request(input: AgentRequest, options?: { signal?: AbortSignal; onProgress?: (event: AgentProgress) => void }): Promise<AgentResult>;
  cancel(requestId: string): void;
  dispose(): void;
  getPublicSettings(): PublicProviderSettings[];
  getJobCounts(): { foreground: number; background: number; local: number; queued: number };
}

export class AgentFailure extends Error {
  constructor(readonly code: AgentErrorCode, message: string) { super(message); this.name = 'AgentFailure'; }
}

export function validateParameter(name: keyof OrbitParameters, value: unknown): boolean {
  return orbitParametersSchema.shape[name].safeParse(value).success;
}
