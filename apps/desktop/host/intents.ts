import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canvasSuggestionSelectionSchema, canvasSuggestionRefreshScopeSchema, assertCanvasSuggestionRefreshResult, assertCanvasSelectionResult, compileCanvasSuggestion, coreCommandSchema, idSchema, type CanvasDocument, type CanvasSuggestionSelection, type CanvasSuggestionRefreshScope, type ContextSnapshot, type CoreCommandInput, type CoreSnapshot, type DispatchResult, type SourceRecord } from '../../../packages/contracts/src/index';
import { requestsCanvasAddition, requestsCanvasToolAddition, routeRegisteredIntent, registeredActionSchema, validateParameter, type AgentRequest, type AgentResult, type RegisteredAction } from '../../../packages/agent/src/index';
import type { WorkbenchContext } from '../../../extensions/eve-workbench/src/protocol';
import { buildCanonicalInput, buildIntentRequest, intentModelContextBytes, IntentContextError, INTENT_CONTEXT_LIMITS } from './intent-context';
import { canonicalBinding, canonicalState } from './model-worker';
import type { IntelligenceController, IntelligenceEvent } from './intelligence';
import { planWorkspaceEdit, type WorkspaceCapture, type WorkspacePlan } from './workspace-plan';
import type { WorkspaceApplyResult, WorkspaceEditReview } from './workspace-edits';

export type RegisteredIntentAction = RegisteredAction;
export interface RegisteredExecutionContext { requestId: string; taskId: string; taskEpoch: number }
export interface CapturedIntentContext {
  snapshot: CoreSnapshot;
  workbenchContext?: WorkbenchContext | null;
  workspace?: WorkspaceCapture | null;
  media?: ContextSnapshot['media'];
  sources?: readonly SourceRecord[];
  assets?: readonly { id: string; title: string; mediaType: string }[];
  selectedSourceId?: string | null;
}
export interface IntentCitation {
  sourceId: string; title: string; quote: string;
  provenance: 'attached' | 'retrieved' | 'authored-notes'; mediaTime?: number; canOpen: boolean;
}
export interface IntentProposal {
  id: string; kind: 'note' | 'parameter' | 'workspace' | 'canvas' | 'unsupported'; label: string; summary: string;
  canvas?: import('../../../packages/contracts/src/canvas').CanvasDocument;
  /** Immutable host-resolved baseline for any canvas proposal. */
  beforeCanvas?: CanvasDocument;
  preparedSuggestionId?: string;
  textSelection?: import('../../../packages/contracts/src/canvas').CanvasSuggestionRefreshScope['selection'];
  before?: string; after?: string; expiresAt: number;
  files?: Array<{ path: string; changes: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; before: string; after: string }> }>;
  status: 'ready' | 'applying' | 'applied' | 'discarded' | 'stale' | 'expired' | 'error' | 'uncertain' | 'unsupported';
  message?: string;
}
export interface IntentResponse {
  requestId: string; taskId: string;
  status: 'pending' | 'running' | 'complete' | 'unavailable' | 'cancelled' | 'stale' | 'error';
  message: string;
  basis?: 'sources' | 'selection' | 'general';
  provider?: { id: string; kind: 'local' | 'cloud'; model: string };
  citations: IntentCitation[]; proposals: IntentProposal[];
}
export type IntentEvent = { type: 'intent'; response: IntentResponse };
export interface IntentServiceOptions {
  intelligence: Pick<IntelligenceController, 'request' | 'cancel' | 'syncCanonical'>;
  captureContext(taskId: string): Promise<CapturedIntentContext>;
  /** Must use the host dispatcher, including its real-file edit coordinator. */
  dispatch(command: CoreCommandInput): Promise<DispatchResult>;
  /** Private immutable host plan only; renderer Apply supplies proposal identity, never paths/text. */
  applyWorkspace?(plan: WorkspacePlan, review: WorkspaceEditReview): Promise<WorkspaceApplyResult>;
  /** Finish bookkeeping for an already approved operation; never dispatch another native edit. */
  settleWorkspace?(requestId: string): Promise<WorkspaceApplyResult | null>;
  executeRegistered(action: RegisteredIntentAction, context: RegisteredExecutionContext): Promise<void | { message?: string }>;
  /** Receives a canonical attached-source ID, never a model-authored URL. */
  openSource(context: { taskId: string; sourceId: string }): Promise<void>;
  /** Optional trusted attachment adapter. The URL must be supplied literally by the user. */
  attachSource?(input: { taskId: string; url: string; title: string }): Promise<{ sourceId: string }>;
  /** Opens the installed source search surface; never treats a query as a found source. */
  discoverSources?(input: { taskId: string; query: string; kind: 'article' | 'video' }): Promise<void>;
  onEvent?(event: IntentEvent): void;
  now?: () => number;
  proposalTtlMs?: number;
}
interface StoredProposal { view: IntentProposal; command?: CoreCommandInput; workspace?: WorkspacePlan; dispatched: boolean; promise?: Promise<IntentResponse> }
interface IntentRecord {
  response: IntentResponse; mode: 'canvas' | 'ask' | 'suggestions' | 'learn' | 'selection'; generation: number; text: string; pending: boolean; valid: boolean; cancelled: boolean;
  request?: AgentRequest; capture?: CapturedIntentContext; binding?: string; sourceSelection?: string | null;
  suggestion?: CanvasSuggestionSelection;
  refresh?: { canvasRevision: number; scope: CanvasSuggestionRefreshScope };
  proposals: Map<string, StoredProposal>; timer?: ReturnType<typeof setTimeout>;
}
const askSchema = z.object({ taskId: idSchema, text: z.string().trim().min(1).max(16_000), mode: z.enum(['canvas', 'ask', 'suggestions', 'learn', 'selection']).default('ask'), suggestion: canvasSuggestionSelectionSchema.optional(), refresh: z.object({ canvasRevision: z.number().int().nonnegative(), scope: canvasSuggestionRefreshScopeSchema }).strict().optional() }).strict().refine(value => !value.refresh || ((value.mode === 'suggestions' || value.mode === 'learn' || value.mode === 'selection') && !value.suggestion), 'A contextual request needs its captured scope without a saved suggestion.').refine(value => (value.mode !== 'learn' && value.mode !== 'selection') || (!!value.refresh?.scope.selection && !value.suggestion), 'Learning needs an exact selected passage.');
const generationMessage = (mode: IntentRecord['mode']) => mode === 'selection' ? 'Working with your selection…' : mode === 'learn' ? 'Reading this passage…' : mode === 'suggestions' ? 'Preparing a writing option…' : mode === 'canvas' ? 'Preparing your change…' : 'Working on your request…';
function sameCanvasWork(before: CanvasDocument, after: CanvasDocument): boolean {
  const { suggestions: _oldChoices, ...original } = before;
  const { suggestions: _newChoices, ...candidate } = after;
  return isDeepStrictEqual(original, candidate);
}
const referenceSchema = z.object({ requestId: idSchema, proposalId: idSchema }).strict();
const sourceReferenceSchema = z.object({ requestId: idSchema, sourceId: idSchema }).strict();
const parameterNames = { theme: 'Theme', durationMinutes: 'Timer duration', transitionMs: 'Transition duration', easing: 'Easing curve' } as const;
const format = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value);
const errorMessage = 'Eve could not prepare this response. Your work is unchanged.';
const explicitCanvasCommand = (text: string) => /^(?:(?:can|could|would) you |please )?(?:add|insert|create|make|build|organize|arrange|reshape|update|change|remove|replace|set|put)\b/i.test(text.trim());
function discoveryCommand(text: string): { query: string; kind: 'article' | 'video' } | null {
  const match = /^(?:(?:can|could|would) you |please )?(?:find(?: me)?|search(?: for)?|show(?: me)?|look for|pull up|bring up) (?:some |an? )?(articles?|videos?|sources?)(?: (?:about|on|for))? (.{1,300}?)\s*[.!?]?$/i.exec(text.trim());
  if (!match || /https?:\/\//i.test(match[2]!)) return null;
  return { query: match[2]!.trim(), kind: /^video/i.test(match[1]!) ? 'video' : 'article' };
}
function explicitlyRequestsSourceSearch(text: string): boolean {
  return /^(?:(?:please|can you|could you|would you|will you)\s+)?(?:find(?: me)?|search(?: for)?|show(?: me)?|look for|look up|recommend(?: me)?|suggest(?: me)?|fetch|locate|give me|get(?: me)?)\s+(?:(?:some|an?|the|short|useful|relevant|good|educational|related|helpful)\s+)*(?:videos?|articles?|sources?|links?|tutorials?|lectures?)\b/i.test(text.trim()) &&
    !/\b(?:do not|don't|never|avoid|no need to|rather than|without)\b/i.test(text);
}
/** Literal HTTPS only; article text and generated responses never enter this path. */
function sourceCommand(text: string): { url: string; title: string } | null {
  const match = /^(?:(?:can|could|would) you |please )?(?:open|watch|play|read|add|attach|show)(?: (?:me|this|the|a))?(?: (?:video|article|source|link))? (https:\/\/[^\s<>"']+?)(?: please)?[.!]?$/i.exec(text.trim());
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { url: url.href, title: url.hostname.replace(/^www\./, '') };
  } catch { return null; }
}

/** Keeps captured intent and model proposals private; every mutation still crosses the host broker. */
export class IntentService {
  private records = new Map<string, IntentRecord>();
  private generation = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(private readonly options: IntentServiceOptions) {
    this.now = options.now ?? Date.now; this.ttl = options.proposalTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 60 * 60_000) throw new Error('Invalid proposal lifetime.');
  }

  ask(input: { taskId: string; text: string; mode?: 'canvas' | 'ask' | 'suggestions' | 'learn' | 'selection'; suggestion?: CanvasSuggestionSelection; refresh?: { canvasRevision: number; scope: CanvasSuggestionRefreshScope } }): { requestId: string } {
    const value = askSchema.parse(input);
    if (this.disposed) throw new Error('Intent service has stopped.');
    if (Buffer.byteLength(value.text) > 16_000) throw new Error('Shorten this request before asking Eve.');
    for (const record of this.records.values()) if (record.response.taskId === value.taskId) this.invalidateRecord(record, 'A newer request replaced this context.');
    if ([...this.records.values()].filter(record => record.pending).length >= 8) throw new Error('Too many intent captures are pending. Cancel one before starting another.');
    const requestId = randomUUID();
    const record: IntentRecord = { mode: value.mode, ...(value.suggestion ? { suggestion: value.suggestion } : {}), ...(value.refresh ? { refresh: value.refresh } : {}), response: { requestId, taskId: value.taskId, status: 'pending', message: 'Looking at your work…', citations: [], proposals: [] }, generation: ++this.generation, text: value.text, pending: true, valid: true, cancelled: false, proposals: new Map() };
    this.records.set(requestId, record); this.trim();
    // The caller gets the host-issued identity before asynchronous capture begins.
    setImmediate(() => { if (!this.disposed) { this.publish(record); void this.run(record); } });
    return { requestId };
  }

  /** Forward controller progress here; the awaited result is validated against fresh context below. */
  handleIntelligenceEvent(event: IntelligenceEvent): void {
    if (event.type !== 'progress') return;
    const record = this.records.get(event.progress.requestId);
    if (!record?.pending || !record.valid || record.cancelled) return;
    if (event.progress.type === 'completed') return;
    record.response.status = event.progress.type === 'queued' ? 'pending' : 'running';
    record.response.message = event.progress.type === 'queued' ? 'Waiting for the current request to finish…' : generationMessage(record.mode); this.publish(record);
  }

  syncCanonical(capture: CapturedIntentContext): void {
    const canonical = buildCanonicalInput(capture);
    this.options.intelligence.syncCanonical(canonical);
    const state = canonicalState(canonical, 0);
    for (const record of this.records.values()) {
      if (this.reconcileReceipts(record, capture.snapshot)) this.publish(record);
      if (!record.request || !record.binding || !record.valid) continue;
      const sourceChanged = Object.hasOwn(capture, 'selectedSourceId') && (capture.selectedSourceId ?? null) !== record.sourceSelection;
      if (canonicalBinding(record.request, state) !== record.binding || sourceChanged) this.invalidateRecord(record, 'The task, selection, or source changed. Ask again from its current state.');
    }
  }

  invalidateTask(taskId: string): void {
    for (const record of this.records.values()) if (record.response.taskId === taskId) this.invalidateRecord(record, 'The selected source or activity changed. Ask again from its current state.');
  }
  /** Typing retires captured authority immediately, but a review remains visible
   * as stale so the user can understand why Keep is unavailable. Privacy uses cancelAll. */
  invalidateForUserEdit(): void {
    for (const record of this.records.values()) if (record.valid) this.invalidateRecord(record, 'Your work changed. Open the suggestion again to review a current preview.');
  }
  /** A lock/suspend boundary retires private context before asynchronous cleanup. */
  cancelAll(): void {
    for (const record of this.records.values()) if (record.valid) this.cancel(record.response.requestId);
  }
  cancel(requestId: string): void {
    const record = this.records.get(requestId); if (!record) return;
    record.cancelled = true; record.valid = false; this.options.intelligence.cancel(requestId);
    const inFlight = [...record.proposals.values()].some(proposal => proposal.dispatched && proposal.view.status === 'applying');
    if (record.pending || !inFlight) { record.pending = false; record.response.status = 'cancelled'; record.response.message = 'Request cancelled.'; }
    else record.response.message = 'The approved change is already applying. Waiting for its receipt.';
    for (const proposal of record.proposals.values()) if (proposal.view.status === 'ready') { proposal.view.status = 'discarded'; delete proposal.workspace; }
    if (record.capture) delete record.capture.workspace;
    this.publish(record);
  }
  discardProposal(input: { requestId: string; proposalId: string }): IntentResponse {
    const { record, proposal } = this.lookupProposal(input);
    if (proposal.view.status === 'ready' || (proposal.view.status === 'error' && !proposal.dispatched)) { proposal.view.status = 'discarded'; proposal.view.message = 'Discarded. No new change was requested.'; delete proposal.workspace; this.publish(record); }
    return this.publicResponse(record);
  }
  applyProposal(input: { requestId: string; proposalId: string }): Promise<IntentResponse> {
    const { record, proposal } = this.lookupProposal(input);
    if (proposal.promise && proposal.view.status === 'applying') return proposal.promise;
    if (proposal.view.kind === 'workspace' && proposal.view.status === 'uncertain' && proposal.dispatched && this.options.settleWorkspace && !this.disposed) {
      proposal.view.status = 'applying'; this.publish(record);
      proposal.promise = this.settleWorkspace(record, proposal); return proposal.promise;
    }
    this.expire(record);
    if (proposal.view.status !== 'ready' || (!proposal.command && !proposal.workspace) || !record.valid || record.cancelled || this.disposed) return Promise.resolve(this.publicResponse(record));
    proposal.view.status = 'applying'; this.publish(record);
    proposal.promise = this.apply(record, proposal);
    return proposal.promise;
  }

  /** Called only by the host coordinator, immediately before its durable preparation/dispatch.
   * A visible review does not confer authority after its original selection or sources change. */
  async assertWorkspaceReview(plan: WorkspacePlan, review: WorkspaceEditReview): Promise<void> {
    const { record, proposal } = this.lookupProposal({ requestId: review.intentRequestId, proposalId: review.proposalId });
    const expected = proposal.workspace;
    const identity = (value: WorkspacePlan) => JSON.stringify([value.owner, value.targetId, value.targetRevision, value.documents.map(document => [document.uri, document.relativePath, document.beforeVersion, document.beforeHash, document.afterHash, document.fileIdentity])]);
    if (!expected || !record.valid || record.cancelled || proposal.view.status !== 'applying' || !proposal.dispatched || review.requestId !== `proposal:${proposal.view.id}` || review.label !== proposal.view.label || review.contextHash !== record.binding || review.contextSnapshotId !== record.request?.context.id || identity(plan) !== identity(expected) || this.now() >= proposal.view.expiresAt) throw new IntentContextError('STALE_CONTEXT', 'This code review is no longer authorised by the captured request.');
    if (!(await this.fresh(record)) || proposal.view.status !== 'applying') throw new IntentContextError('STALE_CONTEXT', 'The selected code or source changed before this edit could start.');
  }

  async openSource(input: { requestId: string; sourceId: string }): Promise<void> {
    const value = sourceReferenceSchema.parse(input);
    const record = this.records.get(value.requestId);
    const citation = record?.response.citations.find(item => item.sourceId === value.sourceId && item.canOpen);
    if (!record || !citation || !record.request || !record.capture || !record.valid || record.cancelled || this.disposed) throw new Error('This source reference is no longer current.');
    const current = await this.fresh(record);
    if (!current) throw new Error('This source reference is no longer current.');
    const admitted = record.request.sources.find(source => source.id === value.sourceId);
    if (!admitted) throw new Error('This source was not part of the captured request.');
    const original = record.capture.sources?.find(source => source.id === value.sourceId);
    if (original) {
      const present = current.sources?.find(source => source.id === original.id && source.taskId === record.response.taskId);
      if (!present || JSON.stringify(present) !== JSON.stringify(original)) throw new Error('The attached source changed. Reopen it from the task.');
      await this.options.openSource({ taskId: record.response.taskId, sourceId: original.id }); return;
    }
    const sourceKind = this.syntheticSourceKind(record, value.sourceId);
    if (!sourceKind) throw new Error('This source is unavailable.');
    await this.options.executeRegistered({ type: 'ChangeAttention', activity: sourceKind === 'note' ? 'notes' : 'code' }, this.executionContext(record));
  }
  dispose(): void {
    this.disposed = true;
    for (const record of this.records.values()) { if (record.timer) clearTimeout(record.timer); this.cancel(record.response.requestId); }
  }

  private async run(record: IntentRecord): Promise<void> {
    if (!record.pending || !record.valid || record.cancelled) return;
    try {
      const capture = await this.options.captureContext(record.response.taskId);
      if (!record.valid || record.cancelled || this.disposed) return;
      if (capture.workspace && this.workspaceBytes() + capture.workspace.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0) > 16 * 1024 * 1024) throw new IntentContextError('CONTEXT_LIMIT', 'Finish or discard an existing code review before preparing another.');
      const built = buildIntentRequest({ ...capture, taskId: record.response.taskId, text: record.text, mode: record.mode, ...(record.suggestion ? { suggestion: record.suggestion } : {}), ...(record.refresh ? { refresh: record.refresh } : {}), deferModelBudgetForLocalRouting: true, requestId: record.response.requestId, generation: record.generation, now: this.now() });
      record.capture = structuredClone(capture); record.request = built.request; record.sourceSelection = capture.selectedSourceId ?? null;
      record.binding = canonicalBinding(built.request, canonicalState(built.canonical, 0)) ?? undefined;
      if (!record.binding) throw new IntentContextError('STALE_CONTEXT', 'The captured activity changed.');
      this.options.intelligence.syncCanonical(built.canonical);
      const task = capture.snapshot.tasks.find(item => item.id === record.response.taskId)!;
      const savedSuggestion = record.suggestion && task.canvas?.document?.suggestions?.find(item => item.id === record.suggestion!.id);
      if (savedSuggestion?.prepared && task.canvas?.document) {
        // The selected saved identity is already bound by buildIntentRequest.
        // Preparing this exact registered edit requires neither a provider nor a write.
        const document = this.compilePrepared(capture, savedSuggestion.id);
        if (!(await this.fresh(record))) return;
        const proposalId = randomUUID();
        const expiresAt = this.now() + this.ttl;
        const command = coreCommandSchema.parse({ type: 'UpdateCanvas', requestId: `proposal:${proposalId}`, taskId: task.id,
          expectedEpoch: task.epoch, expectedRevision: task.canvas.revision, document });
        const view: IntentProposal = { id: proposalId, kind: 'canvas', label: savedSuggestion.label, summary: savedSuggestion.description,
          canvas: document, beforeCanvas: structuredClone(task.canvas.document), preparedSuggestionId: savedSuggestion.id, status: 'ready', expiresAt };
        record.proposals.set(proposalId, { view, command, dispatched: false });
        record.pending = false; record.response.status = 'complete'; record.response.message = 'Preview ready. Keep it when it feels right.';
        if (record.capture) delete record.capture.workspace;
        record.timer = setTimeout(() => { this.expire(record); this.publish(record); }, this.ttl + 1); record.timer.unref?.();
        this.publish(record); return;
      }
      const discovery = record.suggestion || record.mode === 'suggestions' || record.mode === 'learn' || record.mode === 'selection' ? null : discoveryCommand(record.text);
      if (discovery && this.options.discoverSources) {
        if (!(await this.fresh(record))) return;
        await this.options.discoverSources({ taskId: record.response.taskId, ...discovery });
        record.pending = false; record.response.status = 'complete'; record.response.message = discovery.kind === 'video' ? 'Opened video search.' : 'Opened article search.'; this.publish(record); return;
      }
      const source = record.suggestion || record.mode === 'suggestions' || record.mode === 'learn' || record.mode === 'selection' ? null : sourceCommand(record.text);
      if (source && this.options.attachSource) {
        if (!(await this.fresh(record))) return;
        const attached = await this.options.attachSource({ taskId: record.response.taskId, ...source });
        const current = await this.options.captureContext(record.response.taskId);
        // A completed attachment is durable, but a navigation/lock boundary must not
        // open a late remote surface or reclaim the user's attention.
        if (!record.valid || record.cancelled || this.disposed || current.snapshot.activeTaskId !== record.response.taskId || current.snapshot.tasks.find(task => task.id === record.response.taskId)?.epoch !== built.request.context.taskEpoch) { this.invalidateRecord(record, 'The space changed before this source could open.'); return; }
        await this.options.openSource({ taskId: record.response.taskId, sourceId: attached.sourceId });
        record.pending = false; record.response.status = 'complete'; record.response.message = 'Opened your source.'; this.publish(record); return;
      }
      const registered = record.mode === 'suggestions' || record.mode === 'learn' || record.mode === 'selection' ? null : routeRegisteredIntent(built.request);
      if (registered) {
        if (!(await this.fresh(record))) return;
        for (const action of registered) {
          if (!record.valid || record.cancelled) return;
          if (action.type === 'ComposeCanvas') {
            const direct: Extract<AgentResult, { status: 'complete' }> = { status: 'complete', requestId: record.response.requestId, message: 'Ready.', basis: 'general', citations: [], actions: [action], needsClarification: false, origin: 'registered-command', requiresUserAction: false, focusPolicy: 'preserve', provider: null, usage: {}, context: built.request.context };
            this.acceptResult(record, direct); record.pending = false;
            const proposal = [...record.proposals.values()][0];
            if (!proposal || proposal.view.status !== 'ready') throw new Error('The requested tool is not ready.');
            const previous = task.canvas?.document;
            const changesExistingWork = previous && (previous.blocks.some(block => !isDeepStrictEqual(block, action.document.blocks.find(next => next.id === block.id))));
            if (changesExistingWork) { record.response.message = 'Review the blue change.'; this.publish(record); return; }
            await this.applyProposal({ requestId: record.response.requestId, proposalId: proposal.view.id });
            return;
          } else if (action.type === 'SetParameter') {
            const direct: Extract<AgentResult, { status: 'complete' }> = { status: 'complete', requestId: record.response.requestId, message: 'Review the blue change.', basis: 'general', citations: [], actions: [action], needsClarification: false, origin: 'registered-command', requiresUserAction: true, focusPolicy: 'preserve', provider: null, usage: {}, context: built.request.context };
            this.acceptResult(record, direct); record.pending = false; this.publish(record); return;
          } else await this.options.executeRegistered(action, this.executionContext(record));
        }
        record.pending = false; record.response.status = 'complete'; record.response.message = 'Done.'; this.publish(record); return;
      }
      if (intentModelContextBytes(built.request) > INTENT_CONTEXT_LIMITS.requestBytes) throw new IntentContextError('CONTEXT_LIMIT', 'There is too much to read at once. Shorten your request or select a smaller passage.');
      record.response.status = 'running'; record.response.message = generationMessage(record.mode); this.publish(record);
      const result = await this.options.intelligence.request(built.request);
      if (!record.valid || record.cancelled || this.disposed) return;
      if (result.requestId !== record.response.requestId) throw new Error('Mismatched worker request identity');
      if (result.status !== 'complete') {
        if (record.capture) delete record.capture.workspace;
        record.pending = false;
        record.response.status = result.status === 'failed' ? 'error' : result.status;
        record.response.message = this.safeFailure(result); this.publish(record); return;
      }
      // The only registered execution path is the exact host parser above, never a worker flag.
      if (result.origin !== 'model-proposal' || JSON.stringify(result.context) !== JSON.stringify(built.request.context)) throw new Error('Invalid response origin or context');
      const fresh = await this.fresh(record); if (!fresh) return;
      if (built.request.canvasLearning && result.actions.length) throw new Error('An informational selection request cannot change the work or start a search.');
      if (record.mode === 'selection' && result.actions.some(action => action.type === 'SearchSources')) {
        const parsed = result.actions.length === 1 ? registeredActionSchema.safeParse(result.actions[0]) : null;
        const action = parsed?.success ? parsed.data : undefined;
        if (!record.request?.canvasSelection || !action || action.type !== 'SearchSources') throw new Error('A source search cannot also change the work.');
        if (!explicitlyRequestsSourceSearch(record.text)) throw new Error('A source search needs an explicit request to find a video, article or source.');
        if (!this.options.discoverSources) throw new Error('Source search is unavailable.');
        await this.options.discoverSources({ taskId: record.response.taskId, query: action.query, kind: action.kind });
        if (!record.valid || record.cancelled || this.disposed) return;
        record.pending = false; record.response.status = 'complete';
        record.response.message = action.kind === 'video' ? 'Opened video search for your selection. Choose a result to view or attach it.' : 'Opened article search for your selection. Choose a result to view or attach it.';
        record.response.provider = result.provider ? { ...result.provider } : undefined;
        this.publish(record); return;
      }
      this.acceptResult(record, result); record.pending = false; this.publish(record);
      // Initial composition can open a new space. Changes to existing work stay
      // as exact previews until the user approves them beside that work.
      const composed = [...record.proposals.values()];
      const initialComposition = !task.canvas?.document && (record.mode === 'canvas' || explicitCanvasCommand(record.text));
      if ((initialComposition || record.mode === 'suggestions') && !result.needsClarification && composed.length === 1 && composed[0]?.view.kind === 'canvas' && composed[0].view.status === 'ready') {
        await this.applyProposal({ requestId: record.response.requestId, proposalId: composed[0].view.id });
      }
    } catch (error) {
      if (record.capture) delete record.capture.workspace;
      if (!record.valid || record.cancelled || this.disposed) return;
      record.pending = false; record.response.status = error instanceof IntentContextError && error.code === 'STALE_CONTEXT' ? 'stale' : 'error';
      record.response.message = error instanceof IntentContextError ? error.message : sourceCommand(record.text) ? 'Eve could not open this source. Check the sources attached to your space and try again.' : errorMessage; this.publish(record);
    }
  }

  private acceptResult(record: IntentRecord, result: Extract<AgentResult, { status: 'complete' }>) {
    if (record.request?.canvasLearning && result.actions.length)
      throw new Error('Learning about a selection cannot change the work.');
    // Repeat the worker boundary before preparing any durable command. Asking
    // for options grants authority only to replace passive suggestion metadata.
    if (record.mode === 'suggestions') {
      const action = result.actions.length === 1 ? registeredActionSchema.safeParse(result.actions[0]) : null;
      const original = record.capture?.snapshot.tasks.find(task => task.id === record.response.taskId)?.canvas;
      const binding = record.request?.canvasSuggestionRefresh;
      if (result.needsClarification || !action?.success || action.data.type !== 'ComposeCanvas' || !original?.document || !binding ||
          action.data.targetId !== binding.targetId || action.data.expectedRevision !== binding.canvasRevision || binding.canvasRevision !== original.revision ||
          !Array.isArray(action.data.document.suggestions) || !sameCanvasWork(original.document, action.data.document))
        throw new Error('A next-step request can only refresh suggestions for its captured canvas.');
      assertCanvasSuggestionRefreshResult(original.document, action.data.document, binding.scope);
    }
    if (record.mode === 'selection' && record.request?.canvasSelection) {
      const original = record.capture?.snapshot.tasks.find(task => task.id === record.response.taskId)?.canvas;
      const binding = record.request?.canvasSelection;
      if (!original?.document || !binding || result.actions.length > 1) throw new Error('The selected passage is no longer available.');
      for (const action of result.actions) {
        if (action.type !== 'ComposeCanvas' || action.targetId !== binding.targetId || action.expectedRevision !== binding.canvasRevision || binding.canvasRevision !== original.revision)
          throw new Error('A selection request cannot authorize a different action.');
        assertCanvasSelectionResult(original.document, action.document, binding.scope);
      }
    }
    record.response.status = 'complete'; record.response.message = result.message; record.response.basis = result.basis;
    if (result.provider) record.response.provider = { ...result.provider };
    record.response.citations = result.citations.flatMap(citation => {
      const source = record.request!.sources.find(item => item.id === citation.sourceId);
      if (!source || !source.excerpt.includes(citation.quote)) return [];
      return [{ sourceId: source.id, title: source.title, quote: citation.quote, provenance: source.provenance, ...(source.mediaTime === undefined ? {} : { mediaTime: source.mediaTime }), canOpen: !!record.capture!.sources?.some(item => item.id === source.id) || !!this.syntheticSourceKind(record, source.id) }];
    });
    if (record.response.citations.length !== result.citations.length) throw new Error('The response cited unavailable evidence');
    const expiresAt = this.now() + this.ttl;
    for (const input of result.actions) {
      const parsed = registeredActionSchema.safeParse(input); if (!parsed.success) continue;
      const action = parsed.data; const proposalId = randomUUID();
      if (record.request?.canvasSuggestion && action.type !== 'ComposeCanvas') throw new Error('A canvas suggestion cannot authorize a different action.');
      let command: CoreCommandInput | undefined;
      let workspace: WorkspacePlan | undefined;
      let view: IntentProposal = { id: proposalId, kind: 'unsupported', label: action.type === 'ProposeWorkspaceEdit' ? 'Suggested code change' : 'Suggested action', summary: action.type === 'ProposeWorkspaceEdit' ? 'Review the code changes before applying them. This response cannot apply them.' : 'Eve cannot apply this suggested action yet.', status: 'unsupported', expiresAt };
      const task = record.capture!.snapshot.tasks.find(item => item.id === record.response.taskId)!;
      if (action.type === 'ComposeCanvas') {
        const target = record.request!.targets.find(item => item.kind === 'canvas' && item.id === action.targetId && item.revision === action.expectedRevision);
        const additionSafe = !requestsCanvasAddition(record.text) || (task.canvas?.document?.blocks ?? []).every(block => action.document.blocks.some(next => next.id === block.id));
        const toolAdditionSafe = result.origin === 'registered-command' || !requestsCanvasToolAddition(record.text) || (task.canvas?.document?.blocks ?? []).every(block => isDeepStrictEqual(action.document.blocks.find(next => next.id === block.id), block));
        const pinnedSafe = (task.canvas?.document?.blocks.filter(block => block.pinned) ?? []).every(block => isDeepStrictEqual(action.document.blocks.find(item => item.id === block.id), block));
        const scope = record.request?.canvasSuggestion?.targetBlockId;
        const scopeSafe = scope === undefined || scope === null || (task.canvas?.document?.blocks ?? []).every(block => block.id === scope || isDeepStrictEqual(action.document.blocks.find(item => item.id === block.id), block));
        const timersSafe = action.document.blocks.every(block => block.kind !== 'timer' || (block.endsAt === null && block.remainingSeconds === block.durationSeconds) || isDeepStrictEqual(task.canvas?.document?.blocks.find(item => item.id === block.id), block));
        if (target && additionSafe && toolAdditionSafe && pinnedSafe && timersSafe && scopeSafe && action.targetId === `${task.id}:canvas` && action.expectedRevision === (task.canvas?.revision ?? 0)) {
          command = coreCommandSchema.parse({ type: 'UpdateCanvas', requestId: `proposal:${proposalId}`, taskId: task.id, expectedEpoch: task.epoch, expectedRevision: action.expectedRevision, document: action.document });
          view = { id: proposalId, kind: 'canvas', label: record.mode === 'suggestions' ? 'Writing option' : 'Proposed change', summary: record.mode === 'suggestions' ? 'An option for your current work.' : action.document.subtitle || action.document.title, canvas: action.document, ...(record.request?.canvasSelection?.scope.selection ? { textSelection: structuredClone(record.request.canvasSelection.scope.selection) } : {}), ...(task.canvas?.document ? { beforeCanvas: structuredClone(task.canvas.document) } : {}), status: 'ready', expiresAt };
        }
      } else if (action.type === 'SetParameter') {
        try {
          command = this.parameterCommand(record, action, `proposal:${proposalId}`);
          view = { id: proposalId, kind: 'parameter', label: `Change ${parameterNames[action.name].toLowerCase()}`, summary: `Update ${parameterNames[action.name].toLowerCase()} in this space.`, before: format(task.parameters!.values[action.name]), after: format(action.value), status: 'ready', expiresAt };
        } catch { /* An unregistered target stays visibly unsupported. */ }
      } else if (action.type === 'ProposeNoteEdit') {
        const target = record.request!.targets.find(item => item.kind === 'note' && item.id === action.targetId && item.revision === action.expectedRevision);
        if (target && action.targetId === task.note.id && action.expectedRevision === task.note.revision) {
          command = coreCommandSchema.parse({ type: 'UpdateNote', requestId: `proposal:${proposalId}`, taskId: task.id, expectedEpoch: task.epoch, expectedRevision: task.note.revision, body: action.text });
          view = { id: proposalId, kind: 'note', label: 'Replace note', summary: 'Review the complete note before applying this replacement.', before: task.note.body, after: action.text, status: 'ready', expiresAt };
        }
      } else if (action.type === 'ProposeWorkspaceEdit' && this.options.applyWorkspace && record.capture?.workspace) {
        try {
          const planned = planWorkspaceEdit(record.capture.workspace, action);
          const size = planned.documents.reduce((sum, document) => sum + Buffer.byteLength(document.beforeText, 'utf8') + Buffer.byteLength(document.afterText, 'utf8'), 0);
          if (this.workspaceBytes() + size > 16 * 1024 * 1024) throw new Error('Code review capacity is full.');
          workspace = planned;
          const point = (text: string, offset: number) => {
            const prefix = text.slice(0, offset), newline = prefix.lastIndexOf('\n');
            return { line: (prefix.match(/\n/g)?.length ?? 0) + 1, column: offset - newline };
          };
          view = { id: proposalId, kind: 'workspace', label: planned.documents.length === 1 ? 'Change selected code' : `Change ${planned.documents.length} selected files`,
            summary: 'Review every changed passage. Other text stays in place; the editor keeps its Undo.', status: 'ready', expiresAt,
            files: planned.documents.map(document => ({ path: document.relativePath, changes: document.changes.map(change => {
              const start = point(document.beforeText, change.start), end = point(document.beforeText, change.end);
              return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column, before: change.before, after: change.after };
            }) })),
          };
        } catch {
          view.summary = 'This code change could not be matched safely to the complete captured file. Select a distinctive passage and ask again.';
        }
      }
      record.proposals.set(proposalId, { view, command, workspace, dispatched: false });
    }
    if (record.capture) delete record.capture.workspace;
    if (record.proposals.size) { record.timer = setTimeout(() => { this.expire(record); this.publish(record); }, this.ttl + 1); record.timer.unref?.(); }
  }

  private parameterCommand(record: IntentRecord, action: Extract<RegisteredAction, { type: 'SetParameter' }>, requestId: string): CoreCommandInput {
    const task = record.capture!.snapshot.tasks.find(item => item.id === record.response.taskId)!;
    const target = record.request!.targets.find(item => item.kind === 'parameters' && item.id === action.targetId && item.revision === action.expectedRevision);
    if (!target || !task.parameters || action.targetId !== `${task.id}:parameters` || action.expectedRevision !== task.parameters.revision || !validateParameter(action.name, action.value)) throw new Error('Invalid parameter target');
    return coreCommandSchema.parse({ type: 'SetParameter', requestId, taskId: task.id, expectedEpoch: task.epoch, expectedRevision: task.parameters.revision, name: action.name, value: action.value });
  }
  private async fresh(record: IntentRecord): Promise<CapturedIntentContext | null> {
    const current = await this.options.captureContext(record.response.taskId);
    if (this.reconcileReceipts(record, current.snapshot)) this.publish(record);
    if (!record.valid || record.cancelled || this.disposed || !record.request || !record.binding) return null;
    const canonical = buildCanonicalInput(current);
    this.options.intelligence.syncCanonical(canonical);
    const sourcesChanged = record.request.sources.some(source => {
      const original = record.capture?.sources?.find(item => item.id === source.id);
      return !!original && JSON.stringify(current.sources?.find(item => item.id === source.id && item.taskId === record.response.taskId)) !== JSON.stringify(original);
    });
    if (canonicalBinding(record.request, canonicalState(canonical, 0)) !== record.binding || (current.selectedSourceId ?? null) !== record.sourceSelection || sourcesChanged) { this.invalidateRecord(record, 'The task, selection, or source changed. Ask again from its current state.'); return null; }
    return current;
  }
  private async apply(record: IntentRecord, proposal: StoredProposal): Promise<IntentResponse> {
    try {
      const fresh = await this.fresh(record);
      if (!fresh || !record.valid || record.cancelled || this.now() >= proposal.view.expiresAt) {
        delete proposal.workspace;
        if (proposal.view.status !== 'applied') { proposal.view.status = this.now() >= proposal.view.expiresAt ? 'expired' : record.cancelled ? 'discarded' : 'stale'; proposal.view.message = 'The original context is no longer current. No new change was requested.'; }
        this.publish(record); return this.publicResponse(record);
      }
      if (proposal.view.preparedSuggestionId) {
        const candidate = this.compilePrepared(fresh, proposal.view.preparedSuggestionId);
        if (proposal.command?.type !== 'UpdateCanvas' || !isDeepStrictEqual(candidate, proposal.command.document))
          throw new IntentContextError('STALE_CONTEXT', 'This suggestion changed. Preview it again from the current canvas.');
      }
      if (record.mode === 'suggestions') {
        const current = fresh.snapshot.tasks.find(task => task.id === record.response.taskId)?.canvas;
        if (!current?.document || proposal.command?.type !== 'UpdateCanvas' || current.revision !== proposal.command.expectedRevision ||
            !Array.isArray(proposal.command.document.suggestions) || !sameCanvasWork(current.document, proposal.command.document))
          throw new IntentContextError('STALE_CONTEXT', 'Your work changed. Ask for fresh next steps from the current canvas.');
        assertCanvasSuggestionRefreshResult(current.document, proposal.command.document, record.request?.canvasSuggestionRefresh?.scope);
      }
      if (record.mode === 'selection') {
        const current = fresh.snapshot.tasks.find(task => task.id === record.response.taskId)?.canvas;
        if (!current?.document || proposal.command?.type !== 'UpdateCanvas' || current.revision !== proposal.command.expectedRevision || !record.request?.canvasSelection)
          throw new IntentContextError('STALE_CONTEXT', 'Your selection changed. Highlight it again to prepare a current change.');
        assertCanvasSelectionResult(current.document, proposal.command.document, record.request.canvasSelection.scope);
      }
      proposal.dispatched = true;
      if (proposal.workspace && this.options.applyWorkspace) {
        const reviewed = proposal.workspace;
        const result = await this.options.applyWorkspace(reviewed, {
          requestId: `proposal:${proposal.view.id}`, intentRequestId: record.response.requestId, proposalId: proposal.view.id,
          contextSnapshotId: record.request!.context.id, contextHash: record.binding!,
          ...(record.request!.context.selection ? { selection: { artifactId: record.request!.context.selection.artifactId, revision: record.request!.context.selection.revision } } : {}),
          label: proposal.view.label,
        });
        if (proposal.view.status !== 'applied' || result.status === 'applied') {
          proposal.view.status = result.status === 'applied' ? 'applied' : result.status === 'uncertain' ? 'uncertain' : 'error';
          proposal.view.message = result.message;
        }
        if (result.status === 'applied') record.response.message = 'Applied your reviewed code change.';
        for (const other of record.proposals.values()) if (other !== proposal && other.view.status === 'ready') { other.view.status = 'stale'; other.view.message = 'Your work changed. Ask again before applying another suggestion.'; delete other.workspace; }
        delete proposal.workspace;
        this.publish(record); return this.publicResponse(record);
      }
      const result = await this.options.dispatch(proposal.command!);
      if (result.ok) {
        proposal.view.status = 'applied'; proposal.view.message = 'Applied. The change is available in history.';
        const scope = record.request?.canvasSuggestionRefresh?.scope;
        const choiceCount = proposal.command?.type === 'UpdateCanvas' ? (proposal.command.document.suggestions ?? []).filter(choice => !scope || choice.targetBlockId === scope.blockId).length : 0;
        record.response.message = record.mode === 'suggestions' ? (choiceCount ? `${choiceCount} ${choiceCount === 1 ? 'next step is' : 'next steps are'} ready to consider.` : 'No useful next step to suggest right now.') : proposal.view.kind === 'canvas' ? 'Your space is ready.' : 'Applied your reviewed change.';
        this.reconcileReceipts(record, result.snapshot);
        for (const other of record.proposals.values()) if (other !== proposal && other.view.status === 'ready') { other.view.status = 'stale'; other.view.message = 'Your work changed. Ask again before applying another suggestion.'; }
      } else {
        proposal.view.status = ['STALE_EPOCH','REVISION_CONFLICT','JOB_CANCELLED'].includes(result.error.code) ? 'stale' : 'error';
        proposal.view.message = 'The change was not confirmed. Review your work and its history before asking again.';
      }
    } catch (error) {
      if (proposal.view.status !== 'applied') { proposal.view.status = error instanceof IntentContextError && error.code === 'STALE_CONTEXT' ? 'stale' : proposal.view.kind === 'workspace' && proposal.dispatched ? 'uncertain' : 'error'; proposal.view.message = proposal.dispatched ? 'Eve could not confirm this change. Check your work and its history before trying another change.' : 'Eve could not check your current work. Nothing was changed.'; }
      delete proposal.workspace;
    }
    this.publish(record); return this.publicResponse(record);
  }
  private compilePrepared(capture: CapturedIntentContext, suggestionId: string): CanvasDocument {
    const task = capture.snapshot.tasks.find(item => item.id === capture.snapshot.activeTaskId);
    if (!task?.canvas?.document) throw new IntentContextError('STALE_CONTEXT', 'Open this canvas to preview its suggestion.');
    try {
      return compileCanvasSuggestion(task.canvas.document, suggestionId, {
        assetIds: (capture.assets ?? []).filter(asset => asset.mediaType.startsWith('image/')).map(asset => asset.id),
        sourceIds: (capture.sources ?? []).filter(source => source.taskId === task.id).map(source => source.id),
      });
    } catch (error) {
      throw new IntentContextError('STALE_CONTEXT', error instanceof Error ? error.message : 'This suggestion is no longer available.');
    }
  }
  private reconcileReceipts(record: IntentRecord, snapshot: CoreSnapshot): boolean {
    let changed = false;
    for (const proposal of record.proposals.values()) if (proposal.dispatched && proposal.view.kind === 'workspace') {
      const operation = snapshot.recentActions.find(item => item.requestId === `proposal:${proposal.view.id}` && item.taskId === record.response.taskId && item.type === 'ApplyWorkspaceEdit');
      if (operation) {
        const message = operation.undone ? 'This code change was applied and later undone.' : 'Applied to the editor. Use its Undo while that edit remains in its history.';
        changed ||= proposal.view.status !== 'applied' || proposal.view.message !== message;
        proposal.view.status = 'applied'; proposal.view.message = message; delete proposal.workspace;
      }
    }
    for (const proposal of record.proposals.values()) if (proposal.dispatched && proposal.command) {
      const operation = snapshot.recentActions.find(item => item.requestId === proposal.command!.requestId && item.taskId === record.response.taskId && item.type === proposal.command!.type);
      if (operation) {
        const message = operation.undone ? 'This change was applied and later undone.' : 'Applied. The change is available in history.';
        changed ||= proposal.view.status !== 'applied' || proposal.view.message !== message;
        proposal.view.status = 'applied'; proposal.view.message = message;
      }
    }
    return changed;
  }
  private async settleWorkspace(record: IntentRecord, proposal: StoredProposal): Promise<IntentResponse> {
    try {
      const result = await this.options.settleWorkspace!(`proposal:${proposal.view.id}`);
      if (proposal.view.status !== 'applied' || result?.status === 'applied') {
        proposal.view.status = result?.status === 'applied' ? 'applied' : result?.status === 'uncertain' ? 'uncertain' : 'error';
        proposal.view.message = result?.message ?? 'This request did not reach the editor. Your code was not changed by it.';
      }
    } catch {
      if (proposal.view.status !== 'applied') { proposal.view.status = 'uncertain'; proposal.view.message = 'The saved outcome could not be checked yet. No additional editor change was requested.'; }
    }
    this.publish(record); return this.publicResponse(record);
  }
  private syntheticSourceKind(record: IntentRecord, sourceId: string): 'note' | 'selection' | null {
    const source = record.request?.sources.find(item => item.id === sourceId); if (!source || !record.capture) return null;
    if (record.capture.sources?.some(item => item.id === sourceId)) return null;
    if (sourceId.startsWith('note:')) return 'note';
    if (sourceId.startsWith('selection:') && record.request?.context.selection) return 'selection';
    return null;
  }
  private executionContext(record: IntentRecord): RegisteredExecutionContext { return { requestId: record.response.requestId, taskId: record.response.taskId, taskEpoch: record.request!.context.taskEpoch }; }
  private invalidateRecord(record: IntentRecord, message: string): void {
    if (!record.valid) return;
    record.valid = false; this.options.intelligence.cancel(record.response.requestId);
    if (record.pending) { record.pending = false; record.response.status = 'stale'; record.response.message = message; }
    for (const proposal of record.proposals.values()) if (proposal.view.status === 'ready') { proposal.view.status = 'stale'; proposal.view.message = message; delete proposal.workspace; }
    if (record.capture) delete record.capture.workspace;
    this.publish(record);
  }
  private expire(record: IntentRecord): void { for (const proposal of record.proposals.values()) if (proposal.view.status === 'ready' && this.now() >= proposal.view.expiresAt) { proposal.view.status = 'expired'; proposal.view.message = 'This suggestion expired. Ask again from your current work.'; delete proposal.workspace; } }
  private lookupProposal(input: { requestId: string; proposalId: string }) {
    const value = referenceSchema.parse(input); const record = this.records.get(value.requestId); const proposal = record?.proposals.get(value.proposalId);
    if (!record || !proposal) throw new Error('This proposal is not available.');
    return { record, proposal };
  }
  private publicResponse(record: IntentRecord): IntentResponse { return structuredClone({ ...record.response, proposals: [...record.proposals.values()].map(proposal => proposal.view) }); }
  private workspaceBytes(): number {
    let total = 0;
    for (const record of this.records.values()) {
      for (const document of record.capture?.workspace?.documents ?? []) total += Buffer.byteLength(document.text, 'utf8');
      for (const proposal of record.proposals.values()) for (const document of proposal.workspace?.documents ?? []) total += Buffer.byteLength(document.beforeText, 'utf8') + Buffer.byteLength(document.afterText, 'utf8');
    }
    return total;
  }
  private publish(record: IntentRecord): void { try { this.options.onEvent?.({ type: 'intent', response: this.publicResponse(record) }); } catch { /* UI failure cannot authorize an action. */ } }
  private trim(): void {
    for (const [id, record] of this.records) {
      if (this.records.size <= 64) break;
      if (record.pending || [...record.proposals.values()].some(item => item.view.status === 'applying' || (item.view.kind === 'workspace' && item.view.status === 'uncertain'))) continue;
      if (record.timer) clearTimeout(record.timer); this.records.delete(id);
    }
  }
  private safeFailure(result: Exclude<AgentResult, { status: 'complete' }>): string {
    if (result.code === 'CREDENTIALS_UNAVAILABLE') return 'Eve needs an AI connection. Add one in setup, then try again.';
    if (result.code === 'PROVIDER_UNAVAILABLE' || result.code === 'LOCAL_STATE_UNKNOWN') return 'AI is unavailable for this space right now. You can keep editing.';
    if (result.status === 'stale') return 'The captured activity changed. Ask again from its current state.';
    if (result.status === 'cancelled') return 'Request cancelled.';
    if (result.code === 'CLOUD_LIMIT') return 'The online AI limit was reached. You can keep editing.';
    return errorMessage;
  }
}
