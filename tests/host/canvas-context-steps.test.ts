import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CAPABILITIES, compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion, type CanvasSuggestionRefreshScope, type CoreCommandInput, type DispatchResult } from '../../packages/contracts/src/index';
import { CoreStore } from '../../packages/core/src/index';
import type { AgentRequest, AgentResult } from '../../packages/agent/src/index';
import { IntentService, type CapturedIntentContext, type IntentResponse } from '../../apps/desktop/host/intents';
import { canonicalBinding, canonicalState } from '../../apps/desktop/host/model-worker';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const passage = 'The blue jar.';
const body = `${passage} First note.\n${passage} Last note.`;
const selection = { field: 'body' as const, start: body.lastIndexOf(passage), end: body.lastIndexOf(passage) + passage.length, text: passage };
const wholeItem: CanvasSuggestionRefreshScope = { blockId: 'writing' };
const selectedPassage: CanvasSuggestionRefreshScope = { blockId: 'writing', selection };
const requestText = 'Suggest useful next steps for this selected work.';
const item = (id: string) => ({ id, title: id, placement: 'main' as const, pinned: false, sourceIds: [] as string[] });
const writing = (): Extract<CanvasBlock, { kind: 'text' }> => ({ ...item('writing'), kind: 'text', body });
const companion = (): Extract<CanvasBlock, { kind: 'text' }> => ({ ...item('companion'), kind: 'text', placement: 'aside', body: 'My earlier observation.' });
const initial = (): CanvasDocument => ({ version: 1, title: 'Studio observations', subtitle: 'My own working notes', layout: 'split', blocks: [
  writing(), companion(),
  { ...item('protected'), kind: 'text', pinned: true, placement: 'full', body: 'An exact original quotation.' },
  { ...item('measurements'), kind: 'table', placement: 'aside', columns: ['Firing', 'Temperature'], rows: [{ id: 'first', cells: ['First', '1080'] }] },
], suggestions: [
  { id: 'old-writing', label: 'An earlier direction', description: 'A saved possibility.', request: 'Prepare an outline.', targetBlockId: 'writing' },
  { id: 'companion-choice', label: 'Shorten this observation', description: 'Review a shorter observation.', request: 'Shorten the observation.', targetBlockId: 'companion', prepared: { edits: [{ type: 'replace', block: { ...companion(), body: 'An earlier observation.' } }], before: [companion()] } },
  { id: 'whole-space', label: 'Another direction', description: '', request: 'Review the whole space.', targetBlockId: null },
] });

let core: CoreStore;
let service: IntentService;
let events: IntentResponse[];
let requests: AgentRequest[];
let commands: CoreCommandInput[];
let cancelled: string[];
let external: unknown[];
let capture: () => Promise<CapturedIntentContext>;
let dispatch: (command: CoreCommandInput) => Promise<DispatchResult>;
let answer: (request: AgentRequest) => Promise<AgentResult>;
const task = () => core.snapshot().tasks.find(value => value.id === 'orbit')!;
const document = () => structuredClone(task().canvas!.document!);
function save(next: CanvasDocument, requestId: string) {
  const result = core.dispatch({ type: 'UpdateCanvas', taskId: 'orbit', requestId, expectedEpoch: task().epoch, expectedRevision: task().canvas?.revision ?? 0, document: next }, auth);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}
function choice(request: AgentRequest): CanvasSuggestion {
  const scope = request.canvasSuggestionRefresh!.scope!;
  const current = request.targets.find(value => value.kind === 'canvas')!.canvas!;
  const selected = current.blocks.find(block => block.id === scope.blockId)!;
  if (scope.selection) {
    if (selected.kind !== 'text') throw new Error('Text fixture expected.');
    const { start, end } = scope.selection;
    return { id: 'new-writing', label: 'Use a more precise colour', description: 'Change only the selected description.', request: 'Use cobalt in this selected description.', targetBlockId: scope.blockId, textSelection: structuredClone(scope.selection), prepared: {
      edits: [{ type: 'replace', block: { ...selected, body: selected.body.slice(0, start) + 'The cobalt jar.' + selected.body.slice(end) } }], before: [structuredClone(selected)],
    } };
  }
  return { id: 'new-writing', label: 'Collect a question', description: 'Add a question about the selected work.', request: 'Add a question about this observation.', targetBlockId: scope.blockId, prepared: {
    edits: [{ type: 'add', block: { ...item('question'), kind: 'text', placement: 'aside', title: 'A question to explore', body: 'What would I look for in the next firing?' } }], before: [],
  } };
}
function result(request: AgentRequest, choices: CanvasSuggestion[] = [choice(request)]): Extract<AgentResult, { status: 'complete' }> {
  const target = request.targets.find(value => value.kind === 'canvas')!;
  const scope = request.canvasSuggestionRefresh!.scope!;
  const foreign = target.canvas!.suggestions!.filter(value => value.targetBlockId !== scope.blockId);
  return { status: 'complete', requestId: request.intent.id, context: request.context, message: 'Options prepared.', basis: scope.selection ? 'selection' : 'general', citations: [],
    actions: [{ type: 'ComposeCanvas', targetId: target.id, expectedRevision: target.revision, document: { ...structuredClone(target.canvas!), suggestions: [...structuredClone(foreign), ...choices] } }],
    needsClarification: false, origin: 'model-proposal', requiresUserAction: true, focusPolicy: 'preserve', provider: null, usage: {} };
}
function output(value: Extract<AgentResult, { status: 'complete' }>): CanvasDocument {
  const action = value.actions[0]!;
  if (action.type !== 'ComposeCanvas') throw new Error('Canvas result expected.');
  return action.document;
}
const latest = (id: string) => events.filter(event => event.requestId === id).at(-1);
async function settled(id: string) {
  await vi.waitFor(() => {
    const response = latest(id);
    expect(response?.status).toMatch(/^(complete|error|stale|unavailable|cancelled)$/);
    expect(response!.proposals.some(proposal => ['ready', 'applying'].includes(proposal.status))).toBe(false);
  });
  return latest(id)!;
}
function ask(scope = wholeItem, canvasRevision = task().canvas!.revision) {
  return service.ask({ taskId: 'orbit', mode: 'suggestions', text: requestText, refresh: { canvasRevision, scope } }).requestId;
}
function assertUntouched(before: CanvasDocument) {
  expect(document()).toEqual(before);
  expect(external).toEqual([]);
}

beforeEach(() => {
  core = new CoreStore({ dbPath: ':memory:' }); events = []; requests = []; commands = []; cancelled = []; external = [];
  save(initial(), 'seed');
  // A real later local edit makes this unrelated prepared choice stale. Refresh
  // must retain its historical original rather than rebasing or dropping it.
  const newer = initial(); newer.blocks[1] = { ...companion(), body: 'My newer authored observation.' };
  save(newer, 'authored-companion-edit');
  capture = async () => ({ snapshot: core.snapshot(), sources: [], assets: [] });
  dispatch = async command => core.dispatch(command, auth);
  answer = async request => result(request);
  service = new IntentService({
    captureContext: () => capture(),
    intelligence: { syncCanonical: () => {}, cancel: id => { cancelled.push(id); }, request: async request => { requests.push(request); return answer(request); } },
    dispatch: async command => { commands.push(command); return dispatch(command); },
    executeRegistered: async action => { external.push(action); }, openSource: async action => { external.push(action); },
    onEvent: event => events.push(event.response), now: () => 1000,
  });
});
afterEach(() => { service.dispose(); core.close(); });

describe('explicit contextual canvas next steps', () => {
  it('captures exact item authority and replaces only its bucket while retaining unrelated stale plans', async () => {
    const before = document(), revision = task().canvas!.revision;
    expect(() => compileCanvasSuggestion(before, 'companion-choice')).toThrow(/changed/i);
    const response = await settled(ask());
    expect(response.status).toBe('complete'); expect(response.message).toBe('1 next step is ready to consider.');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: 'prepare', priority: 'foreground', canvasSuggestionRefresh: { targetId: 'orbit:canvas', canvasRevision: revision, scope: wholeItem } });
    expect(requests[0]!.targets.map(value => value.kind)).toEqual(['canvas']);
    expect(document()).toEqual({ ...before, suggestions: [...before.suggestions!.filter(value => value.targetBlockId !== 'writing'), choice(requests[0]!)] });
    expect(task().canvas!.revision).toBe(revision + 1); expect(commands).toHaveLength(1); expect(external).toEqual([]);
    expect(() => compileCanvasSuggestion(document(), 'companion-choice')).toThrow(/changed/i);
    const operation = core.snapshot().recentActions.find(value => value.requestId === commands[0]!.requestId)!;
    expect(core.dispatch({ type: 'Undo', taskId: 'orbit', requestId: 'undo-contextual-refresh', expectedEpoch: task().epoch, operationId: operation.id }, auth).ok).toBe(true);
    expect(document()).toEqual(before);
  });

  it('keeps repeated selected text bound to its offsets through local preview, duplicate Keep and Undo without more inference', async () => {
    const before = document();
    await settled(ask(selectedPassage));
    const refreshed = document(), selected = refreshed.suggestions!.find(value => value.id === 'new-writing')!;
    expect(selected.textSelection).toEqual(selection);
    const receipt = service.ask({ taskId: 'orbit', text: selected.request, mode: 'canvas', suggestion: { id: selected.id, canvasRevision: task().canvas!.revision } });
    await vi.waitFor(() => expect(latest(receipt.requestId)?.proposals[0]?.status).toBe('ready'));
    const preview = latest(receipt.requestId)!.proposals[0]!;
    expect(preview.beforeCanvas).toEqual(refreshed);
    expect(preview.canvas!.blocks[0]).toEqual({ ...writing(), body: `${passage} First note.\nThe cobalt jar. Last note.` });
    expect(preview.canvas!.blocks.slice(1)).toEqual(before.blocks.slice(1));
    expect(document()).toEqual(refreshed); expect(requests).toHaveLength(1); expect(commands).toHaveLength(1);
    const revision = task().canvas!.revision;
    const ref = { requestId: receipt.requestId, proposalId: preview.id };
    await Promise.all([service.applyProposal(ref), service.applyProposal(ref)]);
    expect(task().canvas!.revision).toBe(revision + 1); expect(commands).toHaveLength(2); expect(requests).toHaveLength(1);
    expect(document().blocks).toEqual(preview.canvas!.blocks);
    // Keep follows the disclosed compiled preview, which also retires already
    // stale prepared choices. The metadata refresh above preserves them exactly.
    expect(document().suggestions).toEqual(preview.canvas!.suggestions);
    const operation = core.snapshot().recentActions.find(value => value.requestId === `proposal:${preview.id}`)!;
    expect(core.dispatch({ type: 'Undo', taskId: 'orbit', requestId: 'undo-selected-change', expectedEpoch: task().epoch, operationId: operation.id }, auth).ok).toBe(true);
    expect(document()).toEqual(refreshed);
  });

  it('binds canonical worker identity to the chosen item and exact text range', async () => {
    await settled(ask(selectedPassage));
    const request = requests[0]!;
    // The captured snapshot is the pre-refresh revision, not the later save.
    const snapshot = core.snapshot(), saved = snapshot.tasks.find(value => value.id === 'orbit')!;
    saved.canvas = { ...saved.canvas!, revision: request.canvasSuggestionRefresh!.canvasRevision, document: request.targets[0]!.canvas! };
    const state = canonicalState({ snapshot, files: [] }, 1);
    const binding = canonicalBinding(request, state);
    expect(binding).not.toBeNull();
    const firstOccurrence = structuredClone(request);
    firstOccurrence.canvasSuggestionRefresh!.scope!.selection = { ...selection, start: 0, end: passage.length };
    expect(canonicalBinding(firstOccurrence, state)).not.toBe(binding);
    const forged = structuredClone(request);
    forged.canvasSuggestionRefresh!.scope!.selection!.text = 'An invented quote';
    expect(canonicalBinding(forged, state)).toBeNull();
  });

  it('an empty result clears only the selected item’s choices', async () => {
    const before = document(); answer = async request => result(request, []);
    expect((await settled(ask())).message).toBe('No useful next step to suggest right now.');
    expect(document()).toEqual({ ...before, suggestions: before.suggestions!.filter(value => value.targetBlockId !== 'writing') });
  });

  it.each(['unknown', 'pin', 'old-revision', 'future-revision', 'wrong-quote', 'outside-range', 'wrong-kind'] as const)('rejects %s before invoking the worker', async fault => {
    const before = document(); let scope = structuredClone(selectedPassage), revision = task().canvas!.revision;
    if (fault === 'unknown') scope = { blockId: 'absent' };
    if (fault === 'pin') scope = { blockId: 'protected' };
    if (fault === 'old-revision') revision--;
    if (fault === 'future-revision') revision++;
    if (fault === 'wrong-quote') scope.selection!.text = 'The red  jar.';
    if (fault === 'outside-range') { scope.selection!.start = 200; scope.selection!.end = 200 + passage.length; }
    if (fault === 'wrong-kind') scope.blockId = 'measurements';
    expect((await settled(ask(scope, revision))).status).toBe('stale');
    expect(requests).toEqual([]); expect(commands).toEqual([]); assertUntouched(before);
  });

  it.each([
    { blockId: 'writing', selection: { ...selection, end: selection.start } },
    { blockId: 'writing', selection: { ...selection, field: 'title' } },
    { blockId: 'writing', selection: { ...selection, start: 0.5 } },
    { blockId: 'writing', selection: { ...selection, text: '' } },
    { blockId: 'writing', selection: { ...selection, unknown: 'not authority' } },
    { blockId: 'writing', targetBlockId: 'protected' },
  ])('rejects malformed or expanded scope synchronously: %j', scope => {
    const before = document();
    expect(() => ask(scope as CanvasSuggestionRefreshScope)).toThrow();
    expect(requests).toEqual([]); expect(commands).toEqual([]); assertUntouched(before);
  });

  it('accepts whole UTF-16 characters and rejects a range that splits a surrogate pair', async () => {
    const next = document(); next.blocks[0] = { ...writing(), body: 'A 🌿 leaf.' }; save(next, 'unicode-writing');
    const bad = { blockId: 'writing', selection: { field: 'body' as const, start: 3, end: 4, text: '\uDF3F' } };
    expect((await settled(ask(bad))).status).toBe('stale'); expect(requests).toEqual([]);
    await settled(ask({ blockId: 'writing', selection: { field: 'body', start: 2, end: 4, text: '🌿' } }));
    expect(requests).toHaveLength(1); expect(document().blocks).toEqual(next.blocks);
  });

  it.each(['drop', 'rewrite', 'reorder', 'rebase', 'invent-foreign', 'steal-id'] as const)('rejects a worker that would %s unrelated choices', async fault => {
    const before = document();
    answer = async request => {
      const completed = result(request), next = output(completed);
      if (fault === 'drop') next.suggestions!.shift();
      if (fault === 'rewrite') next.suggestions![0]!.label = 'Rewritten foreign choice';
      if (fault === 'reorder') [next.suggestions![0], next.suggestions![1]] = [next.suggestions![1]!, next.suggestions![0]!];
      if (fault === 'rebase') next.suggestions![0]!.prepared!.before = [structuredClone(next.blocks[1]!)];
      if (fault === 'invent-foreign') next.suggestions!.push({ ...choice(request), id: 'foreign-new', targetBlockId: 'companion' });
      if (fault === 'steal-id') next.suggestions!.at(-1)!.id = 'companion-choice';
      return completed;
    };
    expect((await settled(ask())).status).toBe('error');
    expect(commands).toEqual([]); assertUntouched(before);
  });

  it.each(['body', 'title', 'layout', 'order', 'pin'] as const)('rejects a worker that changes current %s instead of only passive choices', async field => {
    const before = document();
    answer = async request => {
      const completed = result(request), next = output(completed);
      if (field === 'body' && next.blocks[0]!.kind === 'text') next.blocks[0]!.body = 'Already applied.';
      if (field === 'title') next.title = 'Already renamed';
      if (field === 'layout') next.layout = 'gallery';
      if (field === 'order') next.blocks.reverse();
      if (field === 'pin') next.blocks[2]!.pinned = false;
      return completed;
    };
    expect((await settled(ask())).status).toBe('error'); expect(commands).toEqual([]); assertUntouched(before);
  });

  it.each(['prefix', 'suffix', 'metadata', 'foreign-replacement', 'remove', 'arrangement', 'missing-stamp', 'wrong-stamp', 'unprepared'] as const)('rejects expanded selected-text authority: %s', async fault => {
    const before = document();
    answer = async request => {
      const selected = choice(request), plan = selected.prepared!, edit = plan.edits[0]!;
      if (edit.type !== 'replace' || edit.block.kind !== 'text') throw new Error('Fixture text replacement required.');
      if (fault === 'prefix') edit.block.body = 'Wrong first sentence.\nThe cobalt jar. Last note.';
      if (fault === 'suffix') edit.block.body = edit.block.body.slice(0, -1);
      if (fault === 'metadata') edit.block.title = 'A different title';
      if (fault === 'foreign-replacement') { const other = request.targets[0]!.canvas!.blocks[1]!; plan.edits.push({ type: 'replace', block: { ...other, title: 'Also changed' } }); plan.before.push(other); }
      if (fault === 'remove') { plan.edits = [{ type: 'remove', id: 'writing' }]; }
      if (fault === 'arrangement') { const current = request.targets[0]!.canvas!; plan.arrangement = { layout: 'gallery', order: current.blocks.map(block => block.id) }; plan.beforeArrangement = { layout: current.layout, blocks: current.blocks.map(({ id, placement }) => ({ id, placement })) }; }
      if (fault === 'missing-stamp') delete selected.textSelection;
      if (fault === 'wrong-stamp') selected.textSelection = { ...selection, start: 0, end: passage.length };
      if (fault === 'unprepared') { delete selected.textSelection; selected.prepared = null; }
      return result(request, [selected]);
    };
    expect((await settled(ask(selectedPassage))).status).toBe('error'); expect(commands).toEqual([]); assertUntouched(before);
  });

  it('allows a prepared supporting addition for selected text without modifying the original', async () => {
    const before = document();
    answer = async request => { const selected = choice(request); selected.prepared = { edits: [{ type: 'add', block: { ...item('question'), kind: 'text', body: 'How did the blue glaze change during firing?' } }], before: [] }; return result(request, [selected]); };
    await settled(ask(selectedPassage));
    const projected = compileCanvasSuggestion(document(), 'new-writing');
    expect(projected.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
    expect(projected.blocks.at(-1)).toMatchObject({ id: 'question', body: 'How did the blue glaze change during firing?' });
  });

  it('enforces remaining canonical capacity without discarding other saved choices', async () => {
    const full = document(); full.suggestions = Array.from({ length: 24 }, (_, index) => ({ id: `saved-${index}`, label: `Saved ${index}`, description: '', request: 'Review this direction.', targetBlockId: null })); save(full, 'full-suggestion-capacity');
    expect((await settled(ask())).status).toBe('error'); expect(requests).toEqual([]); assertUntouched(full);
    const almost = structuredClone(full); almost.suggestions!.pop(); save(almost, 'one-choice-capacity');
    answer = async request => result(request, [choice(request), { ...choice(request), id: 'another-choice' }]);
    expect((await settled(ask())).status).toBe('error'); expect(commands).toEqual([]); assertUntouched(almost);
    answer = async request => result(request);
    await settled(ask()); expect(document().suggestions).toHaveLength(24);
    expect(document().suggestions!.slice(0, 23)).toEqual(almost.suggestions);
  });

  it('rejects a fourth item choice even when global capacity remains', async () => {
    const before = document(); answer = async request => result(request, Array.from({ length: 4 }, (_, index) => ({ ...choice(request), id: `choice-${index}` })));
    expect((await settled(ask())).status).toBe('error'); expect(commands).toEqual([]); assertUntouched(before);
  });

  it.each(['cancel', 'unsaved-edit', 'saved-edit', 'pin', 'navigation'] as const)('retires a pending contextual request after %s', async boundary => {
    const before = document(); let release!: () => void;
    answer = async request => { await new Promise<void>(resolve => { release = resolve; }); return result(request); };
    const id = ask(selectedPassage); await vi.waitFor(() => expect(requests).toHaveLength(1));
    if (boundary === 'cancel') { service.cancel(id); service.cancel(id); }
    if (boundary === 'unsaved-edit') service.invalidateForUserEdit();
    if (boundary === 'navigation') service.invalidateTask('orbit');
    let expected = before;
    if (boundary === 'saved-edit' || boundary === 'pin') { expected = structuredClone(before); expected.blocks[0] = boundary === 'pin' ? { ...writing(), pinned: true } : { ...writing(), body: body + ' My newer thought.' }; save(expected, `during-${boundary}`); }
    release();
    expect((await settled(id)).status).toBe(boundary === 'cancel' ? 'cancelled' : 'stale');
    expect(commands).toEqual([]); assertUntouched(expected);
  });

  it('only the newer request can save when two contextual captures overlap', async () => {
    const releases = new Map<string, () => void>();
    answer = async request => { await new Promise<void>(resolve => releases.set(request.intent.id, resolve)); return result(request); };
    const first = ask(); await vi.waitFor(() => expect(requests).toHaveLength(1));
    const second = ask(selectedPassage); await vi.waitFor(() => expect(requests).toHaveLength(2));
    releases.get(first)!(); await settled(first); expect(commands).toEqual([]);
    releases.get(second)!(); await settled(second);
    expect(cancelled).toContain(first); expect(commands).toHaveLength(1);
    expect(document().suggestions!.at(-1)!.textSelection).toEqual(selection);
  });

  it('revalidates the exact canonical revision after asynchronous capture', async () => {
    const revision = task().canvas!.revision, before = document(); let release!: () => void;
    capture = async () => { await new Promise<void>(resolve => { release = resolve; }); return { snapshot: core.snapshot(), sources: [], assets: [] }; };
    const id = ask(selectedPassage, revision); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const edited = structuredClone(before); edited.blocks[0] = { ...writing(), body: body + ' A later sentence.' }; save(edited, 'capture-race'); release();
    expect((await settled(id)).status).toBe('stale'); expect(requests).toEqual([]); expect(commands).toEqual([]); assertUntouched(edited);
  });

  it('leaves a last-second save race to core revision protection', async () => {
    const edited = document(); edited.subtitle = 'My newer subtitle';
    dispatch = async command => { save(edited, 'last-second-local-edit'); return core.dispatch(command, auth); };
    expect((await settled(ask())).proposals[0]?.status).toBe('stale');
    assertUntouched(edited);
  });

  it.each(['image', 'nested-image', 'source'] as const)('core refuses unadmitted dormant %s references without creating history', async reference => {
    const before = document(), revision = task().canvas!.revision, operations = core.snapshot().recentActions;
    answer = async request => {
      const selected = choice(request);
      const block: CanvasBlock = reference === 'image' ? { ...item('support'), kind: 'image', assetId: 'unadmitted-image', caption: '' }
        : reference === 'nested-image' ? { ...item('support'), kind: 'design', width: 400, height: 300, background: '#ffffff', layers: [{ id: 'photo', name: 'A photograph', kind: 'image', x: 0, y: 0, width: 400, height: 300, assetId: 'unadmitted-image', fit: 'cover' }] }
        : { ...item('support'), kind: 'text', body: 'An unsupported citation.', sourceIds: ['unadmitted-source'] };
      selected.prepared = { edits: [{ type: 'add', block }], before: [] };
      return result(request, [selected]);
    };
    const response = await settled(ask());
    expect(response.status === 'error' || response.proposals[0]?.status === 'error').toBe(true);
    expect(task().canvas!.revision).toBe(revision); expect(core.snapshot().recentActions).toEqual(operations); assertUntouched(before);
  });
});
