import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, type CanvasDocument, type CoreCommandInput, type DispatchResult } from '../../packages/contracts/src/index';
import type { AgentRequest, AgentResult, RegisteredAction } from '../../packages/agent/src/index';
import { IntentService, type IntentResponse } from '../../apps/desktop/host/intents';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const original = (): CanvasDocument => ({ version: 1, title: 'Workshop notes', subtitle: 'My working material', layout: 'split', blocks: [
  { id: 'writing', kind: 'text', title: 'What I noticed', body: 'My own unfinished thought.', placement: 'main', pinned: false, sourceIds: [] },
  { id: 'protected', kind: 'text', title: 'Keep this', body: 'An exact quotation.', placement: 'aside', pinned: true, sourceIds: [] },
  { id: 'clock', kind: 'timer', title: 'Practice', durationSeconds: 600, remainingSeconds: 570, endsAt: 571000, placement: 'aside', pinned: false, sourceIds: [] },
], suggestions: [{ id: 'old', label: 'Earlier direction', description: 'An earlier possibility.', request: 'Prepare an empty checklist.', targetBlockId: null }] });
const choice = () => ({ id: 'blank-checklist', label: 'Collect the next observations', description: 'Add a blank checklist beside these notes.', request: 'Add a blank observation checklist beside the notes.', targetBlockId: null, prepared: {
  edits: [{ type: 'add' as const, block: { id: 'observations', kind: 'checklist' as const, title: 'Next observations', placement: 'aside' as const, pinned: false, sourceIds: [], items: [] } }], before: [],
} });
let core: CoreStore;
let service: IntentService;
let requests: AgentRequest[];
let commands: CoreCommandInput[];
let events: IntentResponse[];
let external: unknown[];
let answer: (request: AgentRequest) => Promise<AgentResult>;
let dispatch: (command: CoreCommandInput) => Promise<DispatchResult>;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
function save(document: CanvasDocument, requestId = 'seed') {
  const result = core.dispatch({ type: 'UpdateCanvas', taskId: 'orbit', requestId, expectedEpoch: task().epoch, expectedRevision: task().canvas?.revision ?? 0, document }, auth);
  expect(result.ok).toBe(true);
}
function complete(request: AgentRequest, actions?: RegisteredAction[], needsClarification = false): Extract<AgentResult, { status: 'complete' }> {
  const target = request.targets.find(target => target.kind === 'canvas')!;
  return { status: 'complete', requestId: request.intent.id, context: request.context, message: 'Options prepared.', basis: 'general', citations: [],
    actions: actions ?? [{ type: 'ComposeCanvas', targetId: target.id, expectedRevision: target.revision, document: { ...target.canvas!, suggestions: [choice()] } }],
    needsClarification, origin: 'model-proposal', requiresUserAction: true, focusPolicy: 'preserve', provider: null, usage: {} };
}
function latest(id: string) { return events.filter(event => event.requestId === id).at(-1); }
async function settled(id: string) {
  await vi.waitFor(() => {
    const response = latest(id);
    expect(response).toBeDefined();
    expect(['complete', 'error', 'stale', 'unavailable', 'cancelled']).toContain(response!.status);
    expect(response!.proposals.some(proposal => ['ready', 'applying'].includes(proposal.status))).toBe(false);
  });
  return latest(id)!;
}
function ask(text = 'Suggest useful next steps for this canvas.') {
  return service.ask({ taskId: 'orbit', mode: 'suggestions', text }).requestId;
}
beforeEach(() => {
  core = new CoreStore({ dbPath: ':memory:' }); requests = []; commands = []; events = []; external = [];
  save(original());
  answer = async request => complete(request);
  dispatch = async command => core.dispatch(command, auth);
  service = new IntentService({
    captureContext: async () => ({ snapshot: core.snapshot(), sources: [], assets: [] }),
    intelligence: { syncCanonical: () => {}, cancel: () => {}, request: async request => { requests.push(request); return answer(request); } },
    dispatch: async command => { commands.push(command); return dispatch(command); },
    executeRegistered: async action => { external.push(action); }, openSource: async action => { external.push(action); },
    attachSource: async action => { external.push(action); return { sourceId: 'never' }; },
    discoverSources: async action => { external.push(action); },
    onEvent: event => events.push(event.response), now: () => 1000,
  });
});
afterEach(() => { service.dispose(); core.close(); });

describe('explicit next-step refresh authority', () => {
  it('binds the current canvas, saves only suggestions once and retains exact work with core Undo', async () => {
    const before = structuredClone(task().canvas!);
    const response = await settled(ask());
    expect(response.status).toBe('complete'); expect(response.message).toBe('1 next step is ready to consider.');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: 'prepare', priority: 'foreground', canvasSuggestionRefresh: { targetId: 'orbit:canvas', canvasRevision: before.revision } });
    expect(requests[0]!.targets.map(target => target.kind)).toEqual(['canvas']);
    expect(task().canvas!.document).toEqual({ ...before.document, suggestions: [choice()] });
    expect(commands).toHaveLength(1); expect(external).toEqual([]);
    const ref = { requestId: response.requestId, proposalId: response.proposals[0]!.id };
    await Promise.all([service.applyProposal(ref), service.applyProposal(ref)]);
    expect(commands).toHaveLength(1);
    const operation = core.snapshot().recentActions.find(item => item.requestId === `proposal:${ref.proposalId}`)!;
    expect(core.dispatch({ type: 'Undo', taskId: 'orbit', requestId: 'undo-refresh', expectedEpoch: task().epoch, operationId: operation.id }, auth).ok).toBe(true);
    expect(task().canvas!.document).toEqual(before.document);
  });

  it('lets the refreshed prepared card preview and Keep without another inference', async () => {
    await settled(ask());
    const selected = choice();
    const receipt = service.ask({ taskId: 'orbit', mode: 'canvas', text: selected.request, suggestion: { id: selected.id, canvasRevision: task().canvas!.revision } });
    await vi.waitFor(() => expect(latest(receipt.requestId)?.proposals[0]?.status).toBe('ready'));
    expect(requests).toHaveLength(1); expect(commands).toHaveLength(1);
    const proposal = latest(receipt.requestId)!.proposals[0]!;
    await service.applyProposal({ requestId: receipt.requestId, proposalId: proposal.id });
    expect(task().canvas!.document!.blocks).toEqual([...original().blocks, selected.prepared.edits[0]!.block]);
    expect(requests).toHaveLength(1); expect(commands).toHaveLength(2);
  });

  it('records an honest empty answer and clears obsolete choices without inventing content', async () => {
    answer = async request => { const result = complete(request); if (result.actions[0]!.type === 'ComposeCanvas') result.actions[0]!.document.suggestions = []; return result; };
    const response = await settled(ask());
    expect(response.message).toBe('No useful next step to suggest right now.');
    expect(task().canvas!.document).toEqual({ ...original(), suggestions: [] });
  });

  it.each(['title', 'subtitle', 'layout', 'order', 'text', 'pin', 'placement', 'remove', 'add'] as const)('rejects a worker that changes %s during refresh', async field => {
    answer = async request => {
      const result = complete(request); const action = result.actions[0]!;
      if (action.type !== 'ComposeCanvas') throw new Error('fixture');
      action.document = structuredClone(action.document);
      const document = action.document;
      if (field === 'title') document.title = 'Rewritten';
      if (field === 'subtitle') document.subtitle = 'Rewritten';
      if (field === 'layout') document.layout = 'gallery';
      if (field === 'order') document.blocks.reverse();
      if (field === 'text' && document.blocks[0]!.kind === 'text') document.blocks[0]!.body = 'Rewritten';
      if (field === 'pin') document.blocks[1]!.pinned = false;
      if (field === 'placement') document.blocks[0]!.placement = 'full';
      if (field === 'remove') document.blocks.pop();
      if (field === 'add') document.blocks.push(choice().prepared.edits[0]!.block);
      return result;
    };
    expect((await settled(ask())).status).toBe('error');
    expect(task().canvas!.document).toEqual(original()); expect(commands).toEqual([]); expect(external).toEqual([]);
  });

  it.each(['no-action', 'extra-action', 'foreign-target', 'old-revision', 'missing-choices', 'clarification'] as const)('rejects an incomplete or expanded refresh: %s', async fault => {
    answer = async request => {
      const result = complete(request); const action = result.actions[0]!;
      if (action.type !== 'ComposeCanvas') throw new Error('fixture');
      if (fault === 'no-action') result.actions = [];
      if (fault === 'extra-action') result.actions.push({ type: 'SetParameter', targetId: 'orbit:parameters', expectedRevision: 0, name: 'transitionMs', value: 420 });
      if (fault === 'foreign-target') action.targetId = 'other:canvas';
      if (fault === 'old-revision') action.expectedRevision--;
      if (fault === 'missing-choices') delete action.document.suggestions;
      if (fault === 'clarification') result.needsClarification = true;
      return result;
    };
    expect((await settled(ask())).status).toBe('error');
    expect(commands).toEqual([]); expect(external).toEqual([]); expect(task().canvas!.document).toEqual(original());
  });

  it.each(['show code', 'set transition to 500 ms', 'find articles about rivers', 'open https://example.com/lesson', 'add a timer'])('never runs a direct command through refresh mode: %s', async text => {
    await settled(ask(text));
    expect(requests).toHaveLength(1); expect(external).toEqual([]);
    expect(commands.map(command => command.type)).toEqual(['UpdateCanvas']);
    expect(task().canvas!.document!.blocks).toEqual(original().blocks);
  });

  it.each(['saved-edit', 'unsaved-edit', 'cancel'] as const)('retires a late refresh after %s', async boundary => {
    let release!: () => void;
    answer = async request => { await new Promise<void>(resolve => { release = resolve; }); return complete(request); };
    const id = ask(); await vi.waitFor(() => expect(requests).toHaveLength(1));
    let expected = original();
    if (boundary === 'saved-edit') { expected = original(); const writer = expected.blocks[0]!; if (writer.kind === 'text') writer.body += ' New local thought.'; save(expected, 'typing'); }
    if (boundary === 'unsaved-edit') service.invalidateForUserEdit();
    if (boundary === 'cancel') service.cancel(id);
    release();
    const response = await settled(id);
    expect(response.status).toBe(boundary === 'cancel' ? 'cancelled' : 'stale');
    expect(commands).toEqual([]); expect(task().canvas!.document).toEqual(expected);
  });

  it('leaves a last-second write race to core revision protection', async () => {
    const newer = original(); newer.subtitle = 'My newer subtitle';
    dispatch = async command => { save(newer, 'racing-user-edit'); return core.dispatch(command, auth); };
    const response = await settled(ask());
    expect(response.proposals[0]?.status).toBe('stale');
    expect(task().canvas!.document).toEqual(newer);
  });

  it('retains earlier choices when no provider can answer', async () => {
    answer = async request => ({ status: 'unavailable', requestId: request.intent.id, message: 'No provider configured.', code: 'PROVIDER_UNAVAILABLE' });
    expect((await settled(ask())).status).toBe('unavailable');
    expect(commands).toEqual([]); expect(task().canvas!.document).toEqual(original());
  });

  it('refuses a refresh combined with saved-suggestion execution before inference', async () => {
    const receipt = service.ask({ taskId: 'orbit', text: original().suggestions![0]!.request, mode: 'suggestions', suggestion: { id: 'old', canvasRevision: task().canvas!.revision } });
    expect((await settled(receipt.requestId)).status).toBe('error'); expect(requests).toEqual([]); expect(commands).toEqual([]);
  });
});
