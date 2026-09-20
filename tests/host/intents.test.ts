import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreStore } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, type CanvasDocument, type CoreCommandInput, type DispatchResult, type SourceRecord } from '../../packages/contracts/src/index';
import type { AgentRequest, AgentResult, RegisteredAction } from '../../packages/agent/src/index';
import type { WorkbenchContext } from '../../extensions/eve-workbench/src/protocol';
import { IntentService, type CapturedIntentContext, type IntentEvent, type IntentResponse, type IntentServiceOptions } from '../../apps/desktop/host/intents';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
let store: CoreStore;
let service: IntentService;
let events: IntentEvent[];
let requests: AgentRequest[];
let commands: CoreCommandInput[];
let executed: RegisteredAction[];
let opened: { taskId: string; sourceId: string }[];
let captured: Partial<CapturedIntentContext>;
let now: number;
let answer: (request: AgentRequest) => Promise<AgentResult>;
let dispatch: (command: CoreCommandInput) => Promise<DispatchResult>;
let cancelled: string[];
let capture: () => Promise<CapturedIntentContext>;
let attached: Array<{ taskId: string; url: string; title: string }>;
let discovered: Array<{ taskId: string; query: string; kind: 'article' | 'video' }>;
let attach: NonNullable<IntentServiceOptions['attachSource']>;

const task = () => store.snapshot().tasks.find(item => item.id === 'orbit')!;
const source = (id = 'reference'): SourceRecord => ({ id, taskId: 'orbit', title: 'Attached explanation', url: 'https://example.com/lesson', excerpt: 'A verified user-supplied excerpt.', createdAt: 1, retrievedAt: 1, provenance: { kind: 'web-source', attribution: 'Supplied author', rights: 'Supplied rights' } });
function complete(request: AgentRequest, actions: RegisteredAction[] = []): Extract<AgentResult, { status: 'complete' }> {
  return { status: 'complete', requestId: request.intent.id, message: 'A prepared explanation.', basis: 'general', citations: [], actions, needsClarification: false, origin: 'model-proposal', requiresUserAction: actions.length > 0, focusPolicy: 'preserve', provider: { id: 'configured', kind: 'cloud', model: 'explicit-model' }, usage: {}, context: request.context };
}
function noteAction(request: AgentRequest, text = 'Reviewed new note.'): RegisteredAction {
  const target = request.targets.find(target => target.kind === 'note')!;
  return { type: 'ProposeNoteEdit', targetId: target.id, expectedRevision: target.revision, text };
}
function parameterAction(request: AgentRequest): RegisteredAction {
  const target = request.targets.find(target => target.kind === 'parameters')!;
  return { type: 'SetParameter', targetId: target.id, expectedRevision: target.revision, name: 'transitionMs', value: 420 };
}
function latest(requestId: string): IntentResponse | undefined { return events.filter(event => event.response.requestId === requestId).at(-1)?.response; }
async function settled(requestId: string): Promise<IntentResponse> {
  await vi.waitFor(() => expect(latest(requestId)?.status).toMatch(/^(complete|stale|error|unavailable|cancelled)$/));
  return latest(requestId)!;
}
async function ask(text = 'Rewrite my note more clearly.') { const { requestId } = service.ask({ taskId: 'orbit', text }); return settled(requestId); }
beforeEach(() => {
  store = new CoreStore({ dbPath: ':memory:' }); events = []; requests = []; commands = []; executed = []; opened = []; cancelled = []; captured = { sources: [], selectedSourceId: null }; now = 1000;
  attached = []; discovered = [];
  attach = async input => { attached.push(input); return { sourceId: 'attached-source' }; };
  answer = async request => complete(request, [noteAction(request)]);
  dispatch = async command => store.dispatch(command, auth);
  capture = async () => ({ snapshot: store.snapshot(), ...structuredClone(captured) });
  service = new IntentService({
    intelligence: { request: async request => { requests.push(request); return answer(request); }, cancel: id => { cancelled.push(id); }, syncCanonical: () => {} },
    captureContext: () => capture(), dispatch: async command => { commands.push(command); return dispatch(command); },
    attachSource: input => attach(input), discoverSources: async input => { discovered.push(input); },
    executeRegistered: async action => { executed.push(action); }, openSource: async context => { opened.push(context); },
    onEvent: event => events.push(event), now: () => now, proposalTtlMs: 1000,
  });
});
afterEach(() => { service.dispose(); store.close(); });

describe('host intent and explicit proposal broker', () => {
  it('returns a host-issued ID immediately and executes exact navigation without asking a provider', async () => {
    const acknowledgement = service.ask({ taskId: 'orbit', text: 'show code' });
    expect(acknowledgement.requestId).toMatch(/^[a-f0-9-]{36}$/); expect(events).toEqual([]);
    expect((await settled(acknowledgement.requestId)).status).toBe('complete');
    expect(executed).toEqual([{ type: 'ChangeAttention', activity: 'code' }]); expect(requests).toEqual([]); expect(commands).toEqual([]);
  });
  it('previews exact unambiguous parameter commands before dispatching', async () => {
    const result = await ask('set transition to 500 ms'); expect(result.status).toBe('complete'); expect(requests).toEqual([]);
    expect(commands).toEqual([]); expect(result.proposals[0]).toMatchObject({ kind: 'parameter', status: 'ready', after: '500' });
    await service.applyProposal({ requestId: result.requestId, proposalId: result.proposals[0].id });
    expect(commands[0]).toMatchObject({ type: 'SetParameter', taskId: 'orbit', name: 'transitionMs', value: 500, expectedRevision: 0 });
    expect(task().parameters!.values.transitionMs).toBe(500);
  });
  it('shows a complete note preview without mutating until Apply, then applies only once', async () => {
    const before = task().note.body; const response = await ask();
    expect(response).toMatchObject({ status: 'complete', basis: 'general', provider: { id: 'configured' } });
    expect(response.proposals[0]).toMatchObject({ kind: 'note', before, after: 'Reviewed new note.', status: 'ready', expiresAt: 2000 });
    expect(task().note.body).toBe(before); expect(commands).toEqual([]);
    const input = { requestId: response.requestId, proposalId: response.proposals[0].id };
    const [one, two] = await Promise.all([service.applyProposal(input), service.applyProposal(input)]);
    expect(one.proposals[0].status).toBe('applied'); expect(two.proposals[0].status).toBe('applied'); expect(commands).toHaveLength(1);
    expect(task().note.body).toBe('Reviewed new note.'); expect(task().note.revision).toBe(1);
    expect((await service.applyProposal(input)).proposals[0].status).toBe('applied'); expect(commands).toHaveLength(1);
  });
  it('previews canonical parameter values and rejects unsupported workspace/navigation actions', async () => {
    answer = async request => complete(request, [parameterAction(request), { type: 'ProposeWorkspaceEdit', targetId: 'unregistered', expectedRevision: 0, edits: [{ path: 'src/private.ts', before: 'old', after: 'new' }] }, { type: 'ChangeAttention', activity: 'video' }]);
    const response = await ask('How can this transition feel better?');
    expect(response.proposals.map(proposal => proposal.status)).toEqual(['ready','unsupported','unsupported']);
    expect(response.proposals[0]).toMatchObject({ kind: 'parameter', before: String(task().parameters!.values.transitionMs), after: '420' });
    expect(JSON.stringify(response)).not.toContain('src/private.ts'); expect(executed).toEqual([]);
    await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[1].id }); expect(commands).toEqual([]);
    await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id }); expect(task().parameters!.values.transitionMs).toBe(420);
  });
  it('never creates an actionable proposal for an invented target or invalid parameter value', async () => {
    answer = async request => complete(request, [ { type: 'ProposeNoteEdit', targetId: 'other-note', expectedRevision: 0, text: 'overwrite' }, { ...parameterAction(request), value: -100 } as RegisteredAction ]);
    const response = await ask(); expect(response.proposals.every(proposal => proposal.status === 'unsupported')).toBe(true);
    for (const proposal of response.proposals) await service.applyProposal({ requestId: response.requestId, proposalId: proposal.id });
    expect(commands).toEqual([]);
  });
  it('rejects forged or cross-request proposal IDs without dispatching', async () => {
    const first = await ask(); const second = await ask();
    expect(() => service.applyProposal({ requestId: second.requestId, proposalId: first.proposals[0].id })).toThrow('not available');
    expect(commands).toEqual([]);
  });
  it('rechecks original note revisions on Apply and preserves an intervening user edit', async () => {
    const response = await ask(); const original = task();
    store.dispatch({ type: 'UpdateNote', requestId: 'external-edit', taskId: 'orbit', expectedEpoch: original.epoch, expectedRevision: original.note.revision, body: 'Newer user text' }, auth);
    const result = await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id });
    expect(result.proposals[0].status).toBe('stale'); expect(task().note.body).toBe('Newer user text'); expect(commands).toEqual([]);
  });
  it('leaves a final race to the authoritative dispatcher revision precondition', async () => {
    const response = await ask();
    dispatch = async command => { const original = task(); store.dispatch({ type: 'UpdateNote', requestId: 'racing-edit', taskId: 'orbit', expectedEpoch: original.epoch, expectedRevision: original.note.revision, body: 'Typing during Apply' }, auth); return store.dispatch(command, auth); };
    const result = await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id });
    expect(result.proposals[0].status).toBe('stale'); expect(task().note.body).toBe('Typing during Apply');
  });
  it('expires or discards a proposal without a mutation', async () => {
    const response = await ask(); now = 2001;
    expect((await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id })).proposals[0].status).toBe('expired');
    const second = await ask(); const input = { requestId: second.requestId, proposalId: second.proposals[0].id };
    expect(service.discardProposal(input).proposals[0].status).toBe('discarded'); await service.applyProposal(input); expect(commands).toEqual([]);
  });
  it('cancels before capture or during inference and suppresses late model completion', async () => {
    const first = service.ask({ taskId: 'orbit', text: 'Explain my note' }); service.cancel(first.requestId); await settled(first.requestId); expect(requests).toEqual([]);
    let resolve!: (result: AgentResult) => void; answer = () => new Promise(accept => { resolve = accept; });
    const second = service.ask({ taskId: 'orbit', text: 'Explain my note' }); await vi.waitFor(() => expect(requests).toHaveLength(1)); service.cancel(second.requestId);
    expect(latest(second.requestId)?.status).toBe('cancelled'); resolve(complete(requests[0], [noteAction(requests[0])])); await new Promise(resolve => setImmediate(resolve));
    expect(latest(second.requestId)?.status).toBe('cancelled'); expect(commands).toEqual([]); expect(cancelled).toContain(second.requestId);
  });
  it('invalidates pending and finished proposals when selected source changes without a core revision', async () => {
    captured.sources = [source('one'), source('two')]; captured.selectedSourceId = 'one';
    const response = await ask(); captured.selectedSourceId = 'two';
    expect((await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id })).proposals[0].status).toBe('stale');
    let resolve!: (result: AgentResult) => void; answer = () => new Promise(accept => { resolve = accept; });
    const pending = service.ask({ taskId: 'orbit', text: 'Explain this reference' }); await vi.waitFor(() => expect(requests).toHaveLength(2)); service.invalidateTask('orbit');
    resolve(complete(requests[1])); await settled(pending.requestId); expect(latest(pending.requestId)?.status).toBe('stale'); expect(commands).toEqual([]);
  });
  it('retires pending capture and ready private proposals synchronously at a lock boundary', async () => {
    const ready = await ask();
    service.cancelAll();
    expect(latest(ready.requestId)?.status).toBe('cancelled');
    await service.applyProposal({ requestId: ready.requestId, proposalId: ready.proposals[0].id });
    expect(commands).toEqual([]);
    let resolve!: (value: CapturedIntentContext) => void;
    capture = () => new Promise(accept => { resolve = accept; });
    const pending = service.ask({ taskId: 'orbit', text: 'Explain this private note.' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    service.cancelAll();
    expect(latest(pending.requestId)?.status).toBe('cancelled');
    resolve({ snapshot: store.snapshot(), sources: [] });
    await new Promise(accept => setImmediate(accept));
    expect(requests).toHaveLength(1);
    expect(latest(pending.requestId)?.status).toBe('cancelled');
    expect(commands).toEqual([]);
  });
  it('invalidates a same-version editor selection move before presenting a result', async () => {
    const uri = 'file:///projects/orbit/src/app.ts'; const document = { uri, version: 2, hash: createHash('sha256').update('timer').digest('hex'), languageId: 'typescript', dirty: true, untitled: false, bytes: 5 };
    const editor: WorkbenchContext = { workspace: [{ uri: 'file:///projects/orbit', name: 'Orbit' }], active: { ...document, selectedText: 'timer', selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 5 } }], visibleRanges: [], selectionTruncated: false }, documents: [document], diagnostics: [] };
    captured.workbenchContext = editor;
    capture = async () => { const snapshot = store.snapshot(); snapshot.tasks.find(item => item.id === 'orbit')!.projectPath = '/projects/orbit'; return { snapshot, ...structuredClone(captured) }; };
    let resolve!: (result: AgentResult) => void; answer = () => new Promise(accept => { resolve = accept; });
    const pending = service.ask({ taskId: 'orbit', text: 'Explain this selection' }); await vi.waitFor(() => expect(requests).toHaveLength(1));
    editor.active!.selections[0].active.character = 4; editor.active!.selectedText = 'time'; service.syncCanonical(await capture());
    resolve(complete(requests[0])); expect((await settled(pending.requestId)).status).toBe('stale');
  });
  it('resolves citations using canonical IDs and never exposes or opens a model-provided URL', async () => {
    captured.sources = [source()];
    answer = async request => ({ ...complete(request), basis: 'sources', citations: [{ sourceId: 'reference', title: 'Invented title', uri: 'file:///private/secret', quote: 'A verified user-supplied excerpt.', provenance: 'retrieved' }] });
    const response = await ask('Explain this reference');
    expect(response.citations).toEqual([{ sourceId: 'reference', title: 'Attached explanation', quote: 'A verified user-supplied excerpt.', provenance: 'attached', canOpen: true }]);
    expect(JSON.stringify(response)).not.toMatch(/file:|private\/secret|https:/);
    await service.openSource({ requestId: response.requestId, sourceId: 'reference' }); expect(opened).toEqual([{ taskId: 'orbit', sourceId: 'reference' }]);
    await expect(service.openSource({ requestId: response.requestId, sourceId: 'invented' })).rejects.toThrow();
    captured.sources = [{ ...source(), url: 'https://different.example' }];
    await expect(service.openSource({ requestId: response.requestId, sourceId: 'reference' })).rejects.toThrow('no longer current'); expect(opened).toHaveLength(1);
  });
  it('opens an actual synthetic note citation through registered navigation', async () => {
    answer = async request => { const source = request.sources.find(item => item.id.startsWith('note:'))!; return { ...complete(request), basis: 'sources', citations: [{ sourceId: source.id, title: source.title, uri: source.uri, quote: source.excerpt.slice(0,20), provenance: source.provenance }] }; };
    const response = await ask('Explain my note'); expect(response.citations[0].canOpen).toBe(true);
    await service.openSource({ requestId: response.requestId, sourceId: response.citations[0].sourceId }); expect(executed).toEqual([{ type: 'ChangeAttention', activity: 'notes' }]);
  });
  it('preserves an uncertain committed apply and reconciles its durable receipt without repeating a write', async () => {
    const response = await ask(); dispatch = async command => { const result = store.dispatch(command, auth); expect(result.ok).toBe(true); throw new Error('Lost IPC reply with private details /secret'); };
    const input = { requestId: response.requestId, proposalId: response.proposals[0].id };
    const uncertain = await service.applyProposal(input); expect(uncertain.proposals[0].status).toBe('error'); expect(uncertain.proposals[0].message).toContain('could not confirm'); expect(JSON.stringify(uncertain)).not.toContain('/secret');
    service.syncCanonical(await capture()); const reconciled = await service.applyProposal(input);
    expect(reconciled.proposals[0].status).toBe('applied'); expect(commands).toHaveLength(1); expect(task().note.revision).toBe(1);
  });
  it('does not claim an already-dispatched apply was cancelled while awaiting its receipt', async () => {
    const response = await ask(); let finish!: () => void;
    dispatch = command => new Promise(accept => { finish = () => accept(store.dispatch(command, auth)); });
    const pending = service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id }); await vi.waitFor(() => expect(commands).toHaveLength(1));
    service.cancel(response.requestId); expect(latest(response.requestId)?.message).toContain('already applying'); finish();
    expect((await pending).proposals[0].status).toBe('applied'); expect(task().note.revision).toBe(1);
  });
  it('allows cancellation while Apply is still checking context, before broker dispatch', async () => {
    const response = await ask(); let release!: (context: CapturedIntentContext) => void;
    capture = () => new Promise(resolve => { release = resolve; });
    const pending = service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id });
    service.cancel(response.requestId); release({ snapshot: store.snapshot(), ...captured });
    expect((await pending).proposals[0].status).toBe('discarded'); expect(commands).toEqual([]);
  });
  it('suppresses a response if an admitted attached source disappears before completion', async () => {
    captured.sources = [source()]; let resolve!: (result: AgentResult) => void; answer = () => new Promise(accept => { resolve = accept; });
    const pending = service.ask({ taskId: 'orbit', text: 'Explain this reference' }); await vi.waitFor(() => expect(requests).toHaveLength(1));
    captured.sources = []; resolve(complete(requests[0]));
    expect((await settled(pending.requestId)).status).toBe('stale');
  });
  it('rejects a response citing evidence that was not in its captured request', async () => {
    answer = async request => ({ ...complete(request), basis: 'sources', citations: [{ sourceId: 'invented', title: 'Invented evidence', uri: 'https://not-captured.example', quote: 'Invented', provenance: 'retrieved' }] });
    const response = await ask(); expect(response.status).toBe('error'); expect(response.citations).toEqual([]); expect(commands).toEqual([]);
  });
});

const canvasDocument: CanvasDocument = { version: 1, title: 'A useful day', subtitle: 'A draft around your work', layout: 'focus', blocks: [{ id: 'plan', kind: 'text', title: 'Today', placement: 'main', pinned: false, sourceIds: [], body: 'Finish the essay.' }] };
function canvasAction(request: AgentRequest, document = canvasDocument): RegisteredAction {
  const target = request.targets.find(target => target.kind === 'canvas')!;
  return { type: 'ComposeCanvas', targetId: target.id, expectedRevision: target.revision, document };
}
describe('canvas authority at the host boundary', () => {
  it('applies an explicit canvas request once without stealing attention', async () => {
    answer = async request => complete(request, [canvasAction(request)]);
    const response = await settled(service.ask({taskId:'orbit', text:'Plan my day around my work', mode:'canvas'}).requestId);
    expect(response.status).toBe('complete');
    expect(response.proposals[0].status).toBe('applied');
    expect(task().canvas?.document).toEqual(canvasDocument);
    expect(commands).toHaveLength(1); expect(executed).toEqual([]);
    await service.applyProposal({requestId:response.requestId,proposalId:response.proposals[0].id});
    expect(commands).toHaveLength(1);
  });
  it('keeps an ordinary Ask composition for explicit review', async () => {
    answer = async request => complete(request, [canvasAction(request)]);
    const response = await ask('What might a useful day look like?');
    expect(response.proposals[0]).toMatchObject({kind:'canvas',status:'ready',canvas:canvasDocument});
    expect(commands).toEqual([]);
    await service.applyProposal({requestId:response.requestId,proposalId:response.proposals[0].id});
    expect(task().canvas?.document).toEqual(canvasDocument);
  });
  it('rejects model-worker output that changes a pinned block', async () => {
    const original = structuredClone(canvasDocument); original.blocks[0].pinned=true;
    store.dispatch({type:'UpdateCanvas',requestId:'seed-canvas',taskId:'orbit',expectedEpoch:task().epoch,expectedRevision:0,document:original},auth);
    answer=async request=>complete(request,[canvasAction(request)]);
    const response=await settled(service.ask({taskId:'orbit',text:'Organize this canvas',mode:'canvas'}).requestId);
    expect(commands).toEqual([]); expect(task().canvas?.document).toEqual(original);
    expect(response.proposals.every(item=>item.status!=='applied')).toBe(true);
  });
  it('rejects model-worker output that starts a timer', async () => {
    const document = structuredClone(canvasDocument);
    document.blocks=[{id:'timer',kind:'timer',title:'Focus',placement:'main',pinned:false,sourceIds:[],durationSeconds:600,remainingSeconds:600,endsAt:Date.now()+600000}];
    answer=async request=>complete(request,[canvasAction(request,document)]);
    const response=await settled(service.ask({taskId:'orbit',text:'Add a focus timer',mode:'canvas'}).requestId);
    expect(commands).toEqual([]); expect(response.proposals.every(item=>item.status!=='applied')).toBe(true);
  });
});


describe('action-first installed tools and source intentions', () => {
  it('creates blank writing without a provider or unsolicited outline', async () => {
    const response = await settled(service.ask({ taskId: 'orbit', text: 'I need to write an essay about dogs dreaming', mode: 'canvas' }).requestId);
    expect(response.proposals[0]).toMatchObject({ kind: 'canvas', status: 'applied' });
    expect(requests).toEqual([]);
    expect(task().canvas?.document).toMatchObject({ title: 'Dogs dreaming', blocks: [{ kind: 'text', body: '' }] });
    expect(task().canvas?.document?.blocks).toHaveLength(1);
  });
  it('adds an unset countdown directly from the ordinary intent entry, then accepts a date without inference', async () => {
    const first = await ask('Could you add a due-date countdown?');
    expect(first.proposals[0]).toMatchObject({ kind: 'canvas', status: 'applied' });
    expect(task().canvas?.document?.blocks).toMatchObject([{ kind: 'deadline', dueAt: null }]);
    const second = await ask('2026-09-22T17:30');
    expect(second.proposals[0]).toMatchObject({ kind: 'canvas', status: 'ready' });
    expect(task().canvas?.document?.blocks).toMatchObject([{ kind: 'deadline', dueAt: null }]);
    await service.applyProposal({ requestId: second.requestId, proposalId: second.proposals[0].id });
    expect(task().canvas?.document?.blocks).toMatchObject([{ kind: 'deadline', dueAt: new Date(2026, 8, 22, 17, 30).getTime() }]);
    expect(requests).toEqual([]);
    expect(commands).toHaveLength(2);
  });
  it('allows immediate installed tools on a canvas larger than the model prompt budget', async () => {
    const document: CanvasDocument = { ...canvasDocument, blocks: [0, 1].map(index => ({ id: `long-${index}`, kind: 'text', title: '', body: 'x'.repeat(13_000), placement: 'main', pinned: false, sourceIds: [] })) };
    store.dispatch({ type: 'UpdateCanvas', requestId: 'large-canvas', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, document }, auth);
    const response = await ask('Add a countdown');
    expect(response.proposals[0]).toMatchObject({ status: 'applied' });
    expect(task().canvas?.document?.blocks.slice(0, 2)).toEqual(document.blocks);
    expect(task().canvas?.document?.blocks[2]).toMatchObject({ kind: 'deadline', dueAt: null });
    expect(requests).toEqual([]);
    const modelResponse = await ask('Explain every paragraph');
    expect(modelResponse.status).toBe('error'); expect(requests).toEqual([]);
  });
  it('applies explicit model composition commands while keeping informational questions reviewable', async () => {
    answer = async request => complete(request, [canvasAction(request)]);
    const response = await ask('Create a plan around my essay deadline');
    expect(response.proposals[0]).toMatchObject({ status: 'applied' });
  });
  it('rejects an additive model result that drops existing writing', async () => {
    store.dispatch({ type: 'UpdateCanvas', requestId: 'seed-additive', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, document: canvasDocument }, auth);
    answer = async request => complete(request, [canvasAction(request, { ...canvasDocument, blocks: [{ id: 'due', kind: 'deadline', title: 'Due', placement: 'aside', pinned: false, sourceIds: [], dueAt: null }] })]);
    const response = await ask('Add a countdown beside my essay and a sources area');
    expect(response.proposals[0]?.status).toBe('unsupported');
    expect(task().canvas?.document).toEqual(canvasDocument); expect(commands).toEqual([]);
  });
  it.each([
    ['Read this article https://example.com/article', 'https://example.com/article'],
    ['Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ])('opens a canonical source for the literal user request %s', async (text, url) => {
    const response = await ask(text);
    expect(response.message).toBe('Opened your source.');
    expect(attached).toMatchObject([{ taskId: 'orbit', url }]);
    expect(opened).toEqual([{ taskId: 'orbit', sourceId: 'attached-source' }]);
    expect(requests).toEqual([]);
  });
  it.each([
    ['Find articles about dogs dreaming', 'dogs dreaming', 'article'],
    ['Find me articles on dogs dreaming', 'dogs dreaming', 'article'],
    ['Pull up some articles about dogs dreaming', 'dogs dreaming', 'article'],
    ['Search for videos about sleeping dogs', 'sleeping dogs', 'video'],
  ])('opens real source search instead of recalling a task: %s', async (text, query, kind) => {
    const response = await ask(text);
    expect(response.status).toBe('complete');
    expect(discovered).toEqual([{ taskId: 'orbit', query, kind }]);
    expect(requests).toEqual([]); expect(executed).toEqual([]);
  });
  it('cannot open a late attached source after its task epoch changed', async () => {
    let release!: (value: { sourceId: string }) => void;
    attach = () => new Promise(resolve => { release = resolve; });
    const pending = service.ask({ taskId: 'orbit', text: 'Read https://example.com/article' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const snapshot = store.snapshot(); snapshot.tasks.find(item => item.id === 'orbit')!.epoch++;
    capture = async () => ({ snapshot, ...captured });
    release({ sourceId: 'attached-source' });
    expect((await settled(pending.requestId)).status).toBe('stale');
    expect(opened).toEqual([]);
  });
  it('cannot open a late attached source after a newer request invalidates it', async () => {
    let release!: (value: { sourceId: string }) => void;
    attach = () => new Promise(resolve => { release = resolve; });
    const pending = service.ask({ taskId: 'orbit', text: 'Read https://example.com/article' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await ask('show notes');
    release({ sourceId: 'attached-source' });
    await new Promise(resolve => setImmediate(resolve));
    expect(latest(pending.requestId)?.status).toBe('stale'); expect(opened).toEqual([]);
  });
});


it('preserves existing prose exactly when a model adds a tool, even if IDs were kept', async () => {
  store.dispatch({ type: 'UpdateCanvas', requestId: 'seed-body', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, document: canvasDocument }, auth);
  const rewritten: CanvasDocument = { ...canvasDocument, blocks: [{ ...canvasDocument.blocks[0]!, kind: 'text', body: 'Unrequested generated replacement.' }, { id: 'due', kind: 'deadline', title: 'Due date', placement: 'aside', pinned: false, sourceIds: [], dueAt: null }] };
  answer = async request => complete(request, [canvasAction(request, rewritten)]);
  const response = await ask('Add a countdown beside my essay');
  expect(response.proposals[0]?.status).toBe('unsupported');
  expect(task().canvas?.document).toEqual(canvasDocument); expect(commands).toEqual([]);
});


it('fills an existing date locally from the original natural command and a plain follow-up', async () => {
  now = new Date(2026, 8, 20, 14, 0).getTime();
  await ask('Add a countdown');
  const response = await ask('Add a due date countdown for October 1st at midnight');
  expect(response.proposals[0]).toMatchObject({ status: 'ready' });
  await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id });
  expect(task().canvas?.document?.blocks).toMatchObject([{ kind: 'deadline', dueAt: new Date(2026, 9, 1, 0, 0).getTime() }]);
  expect(task().canvas?.document?.blocks).toHaveLength(1); expect(requests).toEqual([]);
  await ask('Add a countdown');
  const next = await ask("It's due tomorrow at 3pm");
  expect(next.proposals[0]).toMatchObject({ status: 'ready' });
  await service.applyProposal({ requestId: next.requestId, proposalId: next.proposals[0].id });
  expect(task().canvas?.document?.blocks[1]).toMatchObject({ kind: 'deadline', dueAt: new Date(2026, 8, 21, 15, 0).getTime() });
  expect(requests).toEqual([]);
});


describe('selection learning and approval at the current work', () => {
  function seed(pinned = false) {
    const document: CanvasDocument = { ...canvasDocument, blocks: [{ id: 'essay', kind: 'text', title: 'Dreams', body: 'Dogs show REM sleep. Their dreams remain hard to verify.', placement: 'main', pinned, sourceIds: [] }] };
    store.dispatch({ type: 'UpdateCanvas', requestId: 'seed-learning', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, document }, auth);
    return { canvasRevision: task().canvas!.revision, scope: { blockId: 'essay', selection: { field: 'body' as const, start: 0, end: 'Dogs show REM sleep.'.length, text: 'Dogs show REM sleep.' } } };
  }
  it('keeps a typed model edit blue and pending until exact approval, then saves once', async () => {
    seed(); const before = structuredClone(task().canvas!.document!);
    const after = structuredClone(before); (after.blocks[0] as Extract<CanvasDocument['blocks'][number], {kind:'text'}>).body = 'Dogs experience REM sleep. Their dreams remain hard to verify.';
    answer = async request => complete(request, [canvasAction(request, after)]);
    const response = await settled(service.ask({ taskId: 'orbit', text: 'Make the first sentence clearer', mode: 'canvas' }).requestId);
    expect(response.proposals[0]).toMatchObject({ status: 'ready', beforeCanvas: before, canvas: after });
    expect(task().canvas!.document).toEqual(before); expect(commands).toEqual([]);
    await service.applyProposal({ requestId: response.requestId, proposalId: response.proposals[0].id });
    expect(task().canvas!.document).toEqual(after); expect(commands).toHaveLength(1);
  });
  it('learns about exact pinned text with no write or mutation authority', async () => {
    const refresh = seed(true); const before = structuredClone(task());
    answer = async request => complete(request);
    const response = await settled(service.ask({ taskId: 'orbit', text: 'Explain this passage', mode: 'learn', refresh }).requestId);
    expect(response.status).toBe('complete'); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: 'explain', canvasLearning: { targetId: 'orbit:canvas', ...refresh } });
    expect(requests[0].canvasSuggestionRefresh).toBeUndefined();
    expect(response.proposals).toEqual([]); expect(commands).toEqual([]); expect(task()).toEqual(before);
  });
  it('rejects invented learning ranges and never interprets learning as an installed command', async () => {
    const refresh = seed(); refresh.scope.selection.start = 1; refresh.scope.selection.end += 1;
    answer = async request => complete(request);
    const response = await settled(service.ask({ taskId: 'orbit', text: 'show code', mode: 'learn', refresh }).requestId);
    expect(response.status).toBe('stale'); expect(requests).toEqual([]); expect(executed).toEqual([]); expect(commands).toEqual([]);
  });
  it('rejects actions in a learning response even if a worker incorrectly returns them', async () => {
    const refresh = seed(); const before = structuredClone(task().canvas!.document!);
    answer = async request => complete(request, [canvasAction(request)]);
    const response = await settled(service.ask({ taskId: 'orbit', text: 'Explain this passage', mode: 'learn', refresh }).requestId);
    expect(response.status).toBe('error'); expect(response.proposals).toEqual([]); expect(commands).toEqual([]); expect(task().canvas!.document).toEqual(before);
  });
});
