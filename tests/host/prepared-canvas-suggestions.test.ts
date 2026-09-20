import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CAPABILITIES, type CanvasBlock, type CanvasDocument, type CoreCommandInput } from '../../packages/contracts/src/index';
import { CoreStore } from '../../packages/core/src/index';
import type { AgentRequest, AgentResult } from '../../packages/agent/src/index';
import { IntentService, type CapturedIntentContext, type IntentResponse } from '../../apps/desktop/host/intents';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const original: CanvasBlock = { id: 'writing', kind: 'text', title: 'An invitation', body: 'Meet at eleven.', placement: 'main', pinned: false, sourceIds: [] };
const revised: CanvasBlock = { ...original, body: 'Meet at ten.' };
const companion: CanvasBlock = { id: 'notes', kind: 'text', title: 'My notes', body: 'Keep this thought.', placement: 'aside', pinned: false, sourceIds: [] };
const document = (): CanvasDocument => ({ version: 1, title: 'Photo walk', subtitle: '', layout: 'split', blocks: [original, companion], suggestions: [
  { id: 'earlier', label: 'Use 10 AM', description: 'Move the invitation time to ten.', request: 'Change the invitation to ten.', targetBlockId: 'writing', prepared: { edits: [{ type: 'replace', block: revised }], before: [original] } },
] });
let core: CoreStore;
let service: IntentService;
let responses: IntentResponse[];
let commands: CoreCommandInput[];
let now: number;
let request: ReturnType<typeof vi.fn<(request: AgentRequest) => Promise<AgentResult>>>;
let capture: () => Promise<CapturedIntentContext>;
let dispatch: (command: CoreCommandInput) => Promise<ReturnType<CoreStore['dispatch']>>;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
function save(next: CanvasDocument, id = 'direct-edit') {
  const result = core.dispatch({ type: 'UpdateCanvas', requestId: id, taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().canvas?.revision ?? 0, document: next }, auth);
  expect(result.ok).toBe(true); return result;
}
async function preview(revision = task().canvas!.revision, text = document().suggestions![0]!.request) {
  const receipt = service.ask({ taskId: 'orbit', text, mode: 'canvas', suggestion: { id: 'earlier', canvasRevision: revision } });
  await vi.waitFor(() => expect(responses.filter(item => item.requestId === receipt.requestId).at(-1)?.status).toMatch(/complete|stale|error|cancelled/));
  return responses.filter(item => item.requestId === receipt.requestId).at(-1)!;
}
const identity = (response: IntentResponse) => ({ requestId: response.requestId, proposalId: response.proposals[0]!.id });
beforeEach(() => {
  core = new CoreStore({ dbPath: ':memory:' }); responses = []; commands = []; now = 1000;
  save(document(), 'seed');
  request = vi.fn(async () => { throw new Error('Prepared suggestions must not use inference.'); });
  capture = async () => ({ snapshot: core.snapshot(), sources: [], assets: [] });
  dispatch = async command => core.dispatch(command, auth);
  service = new IntentService({ intelligence: { request, cancel: () => {}, syncCanonical: () => {} },
    captureContext: () => capture(), dispatch: async command => { commands.push(command); return dispatch(command); },
    executeRegistered: async () => { throw new Error('No external actions.'); }, openSource: async () => {},
    onEvent: event => responses.push(event.response), now: () => now, proposalTtlMs: 1000 });
});
afterEach(() => { service.dispose(); core.close(); });

describe('prepared canvas suggestion review', () => {
  const rearrangedDocument = (): CanvasDocument => ({ ...document(), suggestions: [{
    id: 'earlier', label: 'Give the invitation more room', description: 'Remove the notes card and use a page layout.',
    request: 'Remove the notes card and show the invitation on a page.', targetBlockId: 'notes', prepared: {
      edits: [{ type: 'remove', id: 'notes' }], before: [companion],
      arrangement: { layout: 'focus', order: ['writing'] },
      beforeArrangement: { layout: 'split', blocks: [{ id: 'writing', placement: 'main' }, { id: 'notes', placement: 'aside' }] },
    },
  }] });
  it('reviews removal and arrangement without inference, keeps the private plan once and restores it with core Undo', async () => {
    const seed = rearrangedDocument(); save(seed, 'arrangement-seed');
    const response = await preview(task().canvas!.revision, seed.suggestions![0]!.request);
    expect(response.proposals[0]).toMatchObject({ status: 'ready', beforeCanvas: seed, canvas: { layout: 'focus', blocks: [original], suggestions: [] } });
    expect(task().canvas!.document).toEqual(seed); expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
    response.proposals[0]!.canvas!.blocks = [companion];
    response.proposals[0]!.canvas!.layout = 'gallery';
    const input = identity(response);
    const replies = await Promise.all([service.applyProposal(input), service.applyProposal(input)]);
    expect(replies.every(reply => reply.proposals[0]!.status === 'applied')).toBe(true);
    expect(commands).toHaveLength(1);
    expect(task().canvas!.document).toEqual({ ...seed, layout: 'focus', blocks: [original], suggestions: [] });
    const operation = core.snapshot().recentActions.find(item => item.requestId === `proposal:${input.proposalId}`)!;
    expect(core.dispatch({ type: 'Undo', requestId: 'undo-arrangement', taskId: 'orbit', expectedEpoch: task().epoch, operationId: operation.id }, auth).ok).toBe(true);
    expect(task().canvas!.document).toEqual(seed); expect(request).not.toHaveBeenCalled();
  });
  it('allows newer survivor writing before arrangement preview but refuses changed placement, order or layout', async () => {
    const seed = rearrangedDocument(); save(seed, 'arrangement-seed');
    const typed = { ...seed, blocks: [{ ...original, body: 'My newer invitation text.' }, companion] };
    save(typed, 'survivor-typing');
    const response = await preview(task().canvas!.revision, seed.suggestions![0]!.request);
    expect(response.proposals[0]).toMatchObject({ status: 'ready', canvas: { blocks: [typed.blocks[0]] } });
    service.discardProposal(identity(response));
    for (const [index, next] of [
      { ...typed, layout: 'gallery' as const },
      { ...typed, blocks: [companion, typed.blocks[0]!] },
      { ...typed, blocks: [{ ...typed.blocks[0]!, placement: 'full' as const }, companion] },
    ].entries()) {
      save(next, `user-arranged-${index}`);
      const stale = await preview(task().canvas!.revision, seed.suggestions![0]!.request);
      expect(stale.status).toBe('stale'); expect(stale.proposals).toEqual([]);
      expect(task().canvas!.document).toEqual(next);
    }
    expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
  });
  it('retires an arrangement review when the user moves an item before Keep', async () => {
    const seed = rearrangedDocument(); save(seed, 'arrangement-seed');
    const response = await preview(task().canvas!.revision, seed.suggestions![0]!.request);
    const moved = { ...seed, blocks: [companion, original] }; save(moved, 'moved-after-preview');
    expect((await service.applyProposal(identity(response))).proposals[0]!.status).toBe('stale');
    expect(task().canvas!.document).toEqual(moved); expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
  });
  it('previews exact saved changes without inference or writes, then keeps once with Undo', async () => {
    const response = await preview();
    expect(response.proposals[0]).toMatchObject({ status: 'ready', kind: 'canvas', label: 'Use 10 AM', preparedSuggestionId: 'earlier', beforeCanvas: document() });
    expect(response.proposals[0]!.canvas!.blocks).toEqual([revised, companion]);
    expect(response.proposals[0]!.canvas!.suggestions).toEqual([]);
    expect(task().canvas!.document).toEqual(document()); expect(commands).toHaveLength(0); expect(request).not.toHaveBeenCalled();
    // Mutating the public preview cannot change the host's private operation.
    response.proposals[0]!.canvas!.blocks[0] = { ...revised, body: 'Injected change.' };
    const input = identity(response);
    const kept = await Promise.all([service.applyProposal(input), service.applyProposal(input)]);
    expect(kept.every(item => item.proposals[0]!.status === 'applied')).toBe(true);
    expect(commands).toHaveLength(1); expect(task().canvas!.document!.blocks).toEqual([revised, companion]);
    expect((await service.applyProposal(input)).proposals[0]!.status).toBe('applied'); expect(commands).toHaveLength(1);
    const operation = core.snapshot().recentActions.find(item => item.requestId === `proposal:${input.proposalId}`)!;
    expect(core.dispatch({ type: 'Undo', requestId: 'undo-keep', taskId: 'orbit', expectedEpoch: task().epoch, operationId: operation.id }, auth).ok).toBe(true);
    expect(task().canvas!.document).toEqual(document()); expect(request).not.toHaveBeenCalled();
  });
  it('keeps unrelated edits made before preview while refusing a changed target', async () => {
    const next = document(); next.blocks[1] = { ...companion, body: 'My newer thought.' }; save(next);
    const response = await preview(); expect(response.proposals[0]!.canvas!.blocks[1]).toEqual(next.blocks[1]);
    const changed = structuredClone(next); changed.blocks[0] = { ...original, body: 'Meet at noon.' }; save(changed, 'changed-target');
    const stale = await preview(); expect(stale.status).toBe('stale'); expect(stale.proposals).toEqual([]);
    expect(task().canvas!.document).toEqual(changed); expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
  });
  it('rechecks revision when keeping and preserves edits made after preview', async () => {
    const response = await preview(); const next = document(); next.blocks[1] = { ...companion, body: 'An intervening edit.' }; save(next);
    expect((await service.applyProposal(identity(response))).proposals[0]!.status).toBe('stale');
    expect(task().canvas!.document).toEqual(next); expect(commands).toEqual([]);
  });
  it('immediately retires authority on unsaved typing while keeping the stale review visible', async () => {
    const response = await preview(); service.invalidateForUserEdit();
    expect(responses.at(-1)).toMatchObject({ status: 'complete', proposals: [{ status: 'stale', beforeCanvas: document() }] });
    expect((await service.applyProposal(identity(response))).proposals[0]!.status).toBe('stale');
    expect(task().canvas!.document).toEqual(document()); expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
  });
  it('leaves a final mutation race to core revision checks', async () => {
    const response = await preview();
    dispatch = async command => { const next = document(); next.blocks[0] = { ...original, body: 'My last-second edit.' }; save(next, 'racing-edit'); return core.dispatch(command, auth); };
    expect((await service.applyProposal(identity(response))).proposals[0]!.status).toBe('stale');
    expect(task().canvas!.document!.blocks[0]).toMatchObject({ body: 'My last-second edit.' });
  });
  it.each(['discard', 'cancel', 'expire'] as const)('%s never writes or calls inference', async action => {
    const response = await preview(); const input = identity(response);
    if (action === 'discard') service.discardProposal(input);
    if (action === 'cancel') service.cancel(response.requestId);
    if (action === 'expire') now = 2001;
    const result = await service.applyProposal(input);
    expect(result.proposals[0]!.status).toBe(action === 'expire' ? 'expired' : 'discarded');
    expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled(); expect(task().canvas!.document).toEqual(document());
  });
  it('rejects stale identities and substituted prose before preparation', async () => {
    expect((await preview(0)).status).toBe('stale');
    expect((await preview(1, 'Send this invitation to everyone.')).status).toBe('stale');
    expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
  });
  it('repeats pin checks at preview after a direct user pin', async () => {
    const next = document(); next.blocks[0] = { ...original, pinned: true }; save(next);
    expect((await preview()).status).toBe('stale'); expect(commands).toEqual([]); expect(request).not.toHaveBeenCalled();
  });
  it('retires private reviews at navigation and lock boundaries', async () => {
    const response = await preview(); service.cancelAll();
    expect((await service.applyProposal(identity(response))).proposals[0]!.status).toBe('discarded');
    expect(commands).toEqual([]);
  });
});
