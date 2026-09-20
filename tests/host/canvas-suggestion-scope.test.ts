import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CAPABILITIES, type CanvasDocument, type CoreCommandInput } from '../../packages/contracts/src/index';
import { CoreStore } from '../../packages/core/src/index';
import { prepareContext, validateProposal, type AgentRequest, type AgentResult, type RegisteredAction } from '../../packages/agent/src/index';
import { IntentService, type IntentResponse } from '../../apps/desktop/host/intents';
import { canonicalBinding, canonicalState } from '../../apps/desktop/host/model-worker';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const text = 'Make this more concise.';
const document = (): CanvasDocument => ({
  version: 1, title: 'My research', subtitle: '', layout: 'split',
  blocks: [
    { id: 'left', kind: 'text', title: 'First idea', placement: 'main', pinned: false, sourceIds: [], body: 'A rather lengthy first idea.' },
    { id: 'right', kind: 'text', title: 'Second idea', placement: 'aside', pinned: false, sourceIds: [], body: 'A rather lengthy second idea.' },
    { id: 'original', kind: 'text', title: 'Original', placement: 'full', pinned: true, sourceIds: [], body: 'The original source remains unchanged.' },
  ],
  suggestions: [
    { id: 'shorten-left', label: 'Make it concise', description: '', request: text, targetBlockId: 'left' },
    { id: 'shorten-right', label: 'Make it concise', description: '', request: text, targetBlockId: 'right' },
    { id: 'whole', label: 'Review everything', description: '', request: text, targetBlockId: null },
  ],
});
let core: CoreStore;
let service: IntentService;
let responses: IntentResponse[];
let requests: AgentRequest[];
let commands: CoreCommandInput[];
let answer: (request: AgentRequest) => Promise<AgentResult>;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
const complete = (request: AgentRequest, actions: RegisteredAction[] = []): AgentResult => ({ status: 'complete', requestId: request.intent.id,
  message: 'Prepared.', basis: 'general', citations: [], actions, needsClarification: false, origin: 'model-proposal', requiresUserAction: true,
  focusPolicy: 'preserve', provider: { id: 'fixture', kind: 'local', model: 'fixture' }, usage: {}, context: request.context });
const compose = (request: AgentRequest, next: CanvasDocument): RegisteredAction => ({ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: request.targets.find(item => item.kind === 'canvas')!.revision, document: next });
const changed = (id: string): CanvasDocument => ({ ...document(), blocks: document().blocks.map(block => block.id === id && block.kind === 'text' ? { ...block, body: `Concise ${id}.` } : block) });
async function ask(id = 'shorten-right', canvasRevision = 1, requestText = text) {
  const receipt = service.ask({ taskId: 'orbit', text: requestText, mode: 'canvas', suggestion: { id, canvasRevision } });
  await vi.waitFor(() => {
    const last = responses.filter(item => item.requestId === receipt.requestId).at(-1);
    expect(last?.status).toMatch(/^(complete|error|stale)$/);
  });
  return responses.filter(item => item.requestId === receipt.requestId).at(-1)!;
}
beforeEach(() => {
  core = new CoreStore({ dbPath: ':memory:' }); responses = []; requests = []; commands = [];
  const saved = core.dispatch({ type: 'UpdateCanvas', requestId: 'seed', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, document: document() }, auth);
  expect(saved.ok).toBe(true);
  answer = async request => complete(request);
  service = new IntentService({
    intelligence: { request: async request => { requests.push(request); return answer(request); }, cancel: () => {}, syncCanonical: () => {} },
    captureContext: async () => ({ snapshot: core.snapshot(), sources: [] }),
    dispatch: async command => { commands.push(command); return core.dispatch(command, auth); },
    executeRegistered: async () => { throw new Error('A suggestion must not enter the navigation path.'); }, openSource: async () => {},
    onEvent: event => responses.push(event.response),
  });
});
afterEach(() => { service.dispose(); core.close(); });

describe('explicit durable canvas suggestion selection', () => {
  it.each([
    ['invented-id', 1, text],
    ['shorten-right', 0, text],
    ['shorten-right', 2, text],
    ['shorten-right', 1, 'Replace everything.'],
  ])('rejects absent/stale/substituted selection %s revision %s before inference', async (id, revision, requestText) => {
    expect((await ask(id, revision, requestText)).status).toBe('stale');
    expect(requests).toEqual([]); expect(commands).toEqual([]);
    expect(task().canvas?.document).toEqual(document());
  });

  it('resolves same-label and same-request collisions by identity and supplies the selected block scope', async () => {
    await ask('shorten-right');
    expect(requests[0]!.canvasSuggestion).toEqual({ id: 'shorten-right', canvasRevision: 1, targetBlockId: 'right' });
    expect(requests[0]!.targets.map(item => item.kind)).toEqual(['canvas']);
    expect(JSON.parse(prepareContext(requests[0]!, 'local').input.data).canvasSuggestion).toEqual(requests[0]!.canvasSuggestion);
    const rightBinding = canonicalBinding(requests[0]!, canonicalState({ snapshot: core.snapshot(), files: [] }, 1));
    const left = structuredClone(requests[0]!); left.canvasSuggestion = { id: 'shorten-left', canvasRevision: 1, targetBlockId: 'left' };
    expect(canonicalBinding(left, canonicalState({ snapshot: core.snapshot(), files: [] }, 1))).not.toBe(rightBinding);
    left.canvasSuggestion.targetBlockId = 'right';
    expect(canonicalBinding(left, canonicalState({ snapshot: core.snapshot(), files: [] }, 1))).toBeNull();
  });

  it('allows the selected block to change with new supporting blocks and a new layout while preserving originals', async () => {
    const next: CanvasDocument = { ...changed('right'), layout: 'gallery', blocks: [...changed('right').blocks, { id: 'next', kind: 'checklist', title: 'Next steps', placement: 'aside', pinned: false, sourceIds: [], items: [] }] };
    answer = async request => complete(request, [compose(request, next)]);
    const response = await ask();
    expect(response.proposals[0]).toMatchObject({ kind: 'canvas', status: 'ready', beforeCanvas: document() });
    expect(commands).toEqual([]); expect(task().canvas?.document).toEqual(document());
    await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0]!.id });
    expect(commands).toHaveLength(1); expect(task().canvas?.document).toEqual(next);
  });

  it.each(['rewrite', 'remove'] as const)('rejects a worker proposal that would %s an unrelated unpinned block', async action => {
    const next = changed('right');
    if (action === 'rewrite') next.blocks[0] = changed('left').blocks[0]!;
    else next.blocks = next.blocks.filter(block => block.id !== 'left');
    next.suggestions = next.suggestions?.filter(item => item.targetBlockId !== 'left');
    answer = async request => complete(request, [compose(request, next)]);
    const response = await ask();
    expect(response.proposals[0]?.status).toBe('unsupported');
    expect(commands).toEqual([]); expect(task().canvas?.document).toEqual(document());
    const request = requests[0]!;
    expect(() => validateProposal({ version: 1, message: 'Prepared.', basis: 'general', citations: [], actions: [compose(request, next)], needsClarification: false }, request, prepareContext(request, 'local'))).toThrow('outside its target');
  });

  it('allows whole-canvas suggestions to change multiple unpinned items while keeping pinned originals', async () => {
    const next = changed('left'); next.blocks[1] = changed('right').blocks[1]!;
    answer = async request => complete(request, [compose(request, next)]);
    const response = await ask('whole');
    expect(response.proposals[0]?.status).toBe('ready');
    expect(task().canvas?.document).toEqual(document());
    await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0]!.id });
    expect(task().canvas?.document).toEqual(next);
  });

  it('does not allow a chosen canvas suggestion to authorize notebook edits', async () => {
    answer = async request => complete(request, [{ type: 'ProposeNoteEdit', targetId: task().note.id, expectedRevision: task().note.revision, text: 'Unauthorized replacement.' }]);
    const before = task().note;
    expect((await ask()).status).toBe('error');
    expect(commands).toEqual([]); expect(task().note).toEqual(before);
  });

  it('rejects the selected result if the saved suggestion or canvas changes while inference is running', async () => {
    let finish!: (result: AgentResult) => void;
    answer = () => new Promise(resolve => { finish = resolve; });
    const pending = ask();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const next = document(); next.suggestions = [];
    expect(core.dispatch({ type: 'UpdateCanvas', requestId: 'new-user-version', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 1, document: next }, auth).ok).toBe(true);
    finish(complete(requests[0]!, [compose(requests[0]!, changed('right'))]));
    expect((await pending).status).toBe('stale');
    expect(commands).toEqual([]); expect(task().canvas?.document).toEqual(next);
  });
});
