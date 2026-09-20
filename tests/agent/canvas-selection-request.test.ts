import { describe, expect, it } from 'vitest';
import { agentRequestSchema, canvasSelectionIsCurrent, chooseProvider, createAgentService, prepareContext, routeRegisteredIntent, selectionPromptContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { canvasDataEqual, type CanvasBlock, type CanvasDocument } from '../../packages/contracts/src/index';
import { fakeProvider, proposal, request } from './fixtures';
const repeated = 'A quiet thought 🌙.';
const body = `Before ${repeated} Between. ${repeated} After.`;
const text = (id: string, content = body): Extract<CanvasBlock, {kind:'text'}> => ({ kind: 'text', id, title: id, body: content, placement: 'main', pinned: false, sourceIds: [] });
function inputFor(): AgentRequest {
  const canvas: CanvasDocument = { version: 1, title: 'Writing', subtitle: 'Retain subtitle', layout: 'focus', blocks: [text('first'), text('draft'), { ...text('last', 'PRIVATE UNRELATED WRITING'), pinned: true }], suggestions: [] };
  const input = request({ role: 'prepare', policy: 'local-only', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas, assets: [] }], canvasSelection: { targetId: 'orbit:canvas', canvasRevision: 7, scope: { blockId: 'draft', selection: { field: 'body', start: body.lastIndexOf(repeated), end: body.lastIndexOf(repeated) + repeated.length, text: repeated } } } });
  delete input.context.selection; input.intent.text = 'Can you explain this idea and suggest a useful illustration?'; return input;
}
const wire = (replacementText: string | null = 'A thoughtful pause.', additions: unknown[] = [], beside = false) => ({ ...proposal({ basis: 'selection', citations: [], message: 'A change is ready for review.' }), actions: [{ type: 'EditCanvasSelection', targetId: 'orbit:canvas', expectedRevision: 7, replacementText, additions, beside }] });
function validate(value: unknown = wire(), input = inputFor()) { return validateProposal(value, input, prepareContext(input, 'local')); }
function composed(value: unknown = wire(), input = inputFor()) { const action = validate(value, input).actions[0]; if (action?.type !== 'ComposeCanvas') throw Error('Expected canvas'); return action.document; }
const graphic = (): CanvasBlock => ({ kind: 'design', id: 'graphic', title: 'Schematic', placement: 'aside', pinned: false, sourceIds: [], width: 600, height: 360, background: '#FFFFFF', layers: [{ id: 'idea', name: 'Idea', kind: 'text', x: 20, y: 30, width: 500, height: 100, text: 'A thought can invite another question.', fontFamily: 'sans', fontSize: 28, fontWeight: 'regular', color: '#172234', align: 'left' }] });

describe('free-form selected request binding and minimal authority', () => {
  it('captures arbitrary typed text, omits unrelated writing and retains the canonical original locally', () => {
    const input = inputFor(), original = structuredClone(input), prepared = prepareContext(input, 'local');
    expect(agentRequestSchema.safeParse(input).success).toBe(true); expect(canvasSelectionIsCurrent(input)).toBe(true);
    expect(JSON.parse(prepared.input.data)).toEqual(selectionPromptContext(input));
    expect(JSON.parse(prepared.input.data).request).toBe(input.intent.text);
    expect(prepared.input.data).not.toContain('PRIVATE UNRELATED'); expect(prepared.targets).toEqual(input.targets);
    const schema = JSON.stringify(prepared.input.schema);
    expect(schema).toContain('EditCanvasSelection'); expect(schema).toContain('SearchSources'); expect(schema).not.toContain('ComposeCanvas'); expect(schema).not.toContain('ChangeAttention');
    expect(input).toEqual(original);
  });

  it.each(['revision', 'target', 'quote', 'range', 'missing', 'role', 'priority', 'other target', 'surrogate'])('rejects invalid %s binding', issue => {
    const input = inputFor(), marker = input.canvasSelection!;
    if (issue === 'revision') marker.canvasRevision++;
    if (issue === 'target') marker.targetId = 'foreign';
    if (issue === 'quote') marker.scope.selection!.text = 'forged';
    if (issue === 'range') marker.scope.selection!.start++;
    if (issue === 'missing') delete marker.scope.selection;
    if (issue === 'role') input.role = 'explain';
    if (issue === 'priority') input.priority = 'background';
    if (issue === 'other target') input.targets.push({ id: 'note', kind: 'note', revision: 1 });
    if (issue === 'surrogate') { const start = body.lastIndexOf('🌙'); marker.scope.selection = { field: 'body', start, end: start + 1, text: '\ud83c' }; }
    expect(canvasSelectionIsCurrent(input)).toBe(false); expect(() => prepareContext(input, 'local')).toThrow(/captured passage/);
  });

  it.each(['canvasLearning', 'canvasSuggestionRefresh', 'canvasSuggestion'] as const)('rejects conflicting %s authority', marker => {
    const input = inputFor();
    if (marker === 'canvasLearning') input.canvasLearning = input.canvasSelection;
    if (marker === 'canvasSuggestionRefresh') input.canvasSuggestionRefresh = input.canvasSelection;
    if (marker === 'canvasSuggestion') input.canvasSuggestion = { id: 'old', canvasRevision: 7, targetBlockId: 'draft' };
    expect(agentRequestSchema.safeParse(input).success).toBe(false); expect(canvasSelectionIsCurrent(input)).toBe(false);
  });

  it('allows a read-only answer on pinned writing and does not route typed commands locally', async () => {
    const input = inputFor(); input.targets[0]!.canvas!.blocks[1]!.pinned = true; input.intent.text = 'undo';
    expect(routeRegisteredIntent(input)).toBeNull();
    const answer = proposal({ basis: 'general', message: 'A concise explanation of the underlying idea.', citations: [] });
    expect(validate(answer, input).actions).toEqual([]);
    const fake = fakeProvider('local', answer), service = createAgentService({ providers: [fake.provider], isCurrent: () => true });
    try { expect(await service.request(input)).toMatchObject({ status: 'complete', origin: 'model-proposal', actions: [], requiresUserAction: false }); } finally { service.dispose(); }
  });

  it('keeps the general selection request away from a narrowly qualified fast provider', () => {
    const general = fakeProvider('local').provider, fast = fakeProvider('local').provider;
    Object.assign(fast, { id: 'fast', requestScope: 'canvas-selection' });
    expect(chooseProvider(inputFor(), [fast, general])).toBe(general);
  });
});

describe('exact edits and supporting registered content', () => {
  it.each(['A thoughtful pause.', '', '  A pause.\r\n'])('splices only the second repeated UTF-16 passage without trimming %j', replacement => {
    const input = inputFor(), snapshot = structuredClone(input), selected = input.canvasSelection!.scope.selection!;
    const result = composed(wire(replacement), input);
    expect(result.blocks[1]).toEqual(text('draft', body.slice(0, selected.start) + replacement + body.slice(selected.end)));
    expect(result.blocks[0]).toEqual(snapshot.targets[0]!.canvas!.blocks[0]); expect(result.blocks[2]).toEqual(snapshot.targets[0]!.canvas!.blocks[2]); expect(input).toEqual(snapshot);
  });

  it('inserts an editable schematic immediately after the selection and makes reviewed space beside it', () => {
    const input = inputFor(), result = composed(wire(null, [graphic()], true), input);
    expect(result.layout).toBe('split'); expect(result.blocks.map(block => block.id)).toEqual(['first', 'draft', 'graphic', 'last']);
    expect(result.blocks.filter(block => block.id !== 'graphic')).toEqual(input.targets[0]!.canvas!.blocks);
  });

  it('keeps every saved choice exactly, including more than six and stale hidden-resource plans', () => {
    const input = inputFor(), canvas = input.targets[0]!.canvas!;
    canvas.suggestions = Array.from({ length: 23 }, (_, i) => ({ id: `saved-${i}`, targetBlockId: 'first', label: 'Saved', description: 'Keep', request: 'Keep' }));
    canvas.suggestions.push({ id: 'stale', targetBlockId: 'draft', label: 'Old', description: 'Retain original', request: 'Old request', prepared: { edits: [{ type: 'replace', block: { ...text('draft', 'Old future'), sourceIds: ['hidden'] } }], before: [{ ...text('draft', 'Old original'), sourceIds: ['hidden'] }] } });
    const result = composed(wire(), input); expect(result.suggestions).toEqual(canvas.suggestions);
  });

  it('retains original hidden source references for a trusted body splice without granting them to additions', () => {
    const input = inputFor(); input.targets[0]!.canvas!.blocks[1]!.sourceIds = ['hidden'];
    expect(composed(wire(), input).blocks[1]!.sourceIds).toEqual(['hidden']);
    expect(() => composed(wire(null, [{ ...text('new'), sourceIds: ['hidden'] }]), input)).toThrow(/source.*not attached/i);
  });

  it('admits real attached images and source tools, without granting omitted private source IDs', () => {
    const input = inputFor(); input.targets[0]!.assets = [{ id: 'photo', title: 'Attached photograph metadata', mediaType: 'image/png' }];
    input.sources = [{ id: 'reference', title: 'Reference', uri: 'eve-artifact://source/reference', excerpt: 'Supplied context.', exposure: 'local-only', provenance: 'attached', retrievedAt: 0 }];
    const image = { kind: 'image', id: 'photo-block', title: 'Photo', placement: 'aside', pinned: false, sourceIds: [], assetId: 'photo', caption: 'Attached reference', adjustments: null };
    expect(composed(wire(null, [image, { kind: 'sources', id: 'source-tool', title: 'Sources', description: 'Attached reference', placement: 'aside', pinned: false, sourceIds: ['reference'] }]), input).blocks).toHaveLength(5);
    expect(selectionPromptContext(input, 'cloud').sources).toEqual([]);
    expect(() => validateProposal(wire(null, [{ ...text('new'), sourceIds: ['reference'] }]), input, prepareContext(input, 'cloud'))).toThrow(/source.*not attached/i);
  });

  it('allows additions beside pinned writing while rejecting even a same-text replacement', () => {
    const input = inputFor(); input.targets[0]!.canvas!.blocks[1]!.pinned = true;
    expect(composed(wire(null, [graphic()], true), input).blocks[1]!.pinned).toBe(true);
    expect(() => composed(wire(repeated), input)).toThrow(/Pinned/);
    const schema = prepareContext(input, 'local').input.schema as any;
    expect(schema.properties.actions.items.anyOf[0].properties.replacementText).toEqual({ type: 'null' });
  });

  it('rejects no-op actions, invalid placement and oversized/colliding additions', () => {
    expect(() => composed(wire(null))).toThrow(/no effect/);
    expect(() => composed(wire(repeated))).toThrow(/no effect/);
    expect(() => composed(wire(null, [], true))).toThrow(/Beside/);
    expect(() => composed(wire(null, [{ ...graphic(), placement: 'main' }], true))).toThrow(/placement=aside/);
    expect(() => composed(wire(null, [text('draft')]))).toThrow(/identity/i);
    expect(() => composed(wire(null, Array.from({ length: 5 }, (_, i) => text(`new-${i}`))))).toThrow(/4|Too big/);
    const input = inputFor(); input.targets[0]!.canvas!.blocks[1]!.placement = 'full';
    expect(() => composed(wire(null, [graphic()], true), input)).toThrow(/main or aside/);
  });

  it.each(['before', 'start', 'end', 'scope', 'document', 'suggestions'])('rejects extra forged authority %s', key => {
    const value = wire() as any; value.actions[0][key] = 'forged'; expect(() => validate(value)).toThrow(/EditCanvasSelection/);
  });

  it('rejects substituted canonical/patch actions before they can touch a whole document', () => {
    const input = inputFor();
    for (const action of [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 7, document: input.targets[0]!.canvas }, { type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions: [] }, { type: 'Undo' }]) expect(() => validate({ ...wire(), actions: [action] }, input)).toThrow(/EditCanvasSelection/);
    const value = wire(); value.actions[0]!.expectedRevision++;
    expect(() => validate(value)).toThrow(/captured canvas revision/);
  });

  it('normalizes added clocks and rejects running timers, malformed graphics and invented images', () => {
    const added = { kind: 'deadline', id: 'deadline', title: 'Date', placement: 'aside', pinned: false, sourceIds: [], dueDate: '2026-10-03T10:00' };
    expect(composed(wire(null, [added])).blocks[2]).toMatchObject({ kind: 'deadline', dueAt: new Date('2026-10-03T10:00').getTime() });
    expect(() => composed(wire(null, [{ kind: 'timer', id: 'timer', title: 'Timer', placement: 'aside', pinned: false, sourceIds: [], durationSeconds: 60, remainingSeconds: 60, endsAt: 999999 }]))).toThrow(/timer|paused|start/i);
    expect(() => composed(wire(null, [{ ...graphic(), width: 10 }]))).toThrow(/small|240|width/i);
    expect(() => composed(wire(null, [{ kind: 'image', id: 'image', title: 'Photo', placement: 'aside', pinned: false, sourceIds: [], assetId: 'invented', caption: '', adjustments: null }]))).toThrow(/image.*not attached/i);
  });
});

describe('real source search command, never invented results', () => {
  it.each(['video', 'article'] as const)('admits one bounded %s query only under exact selected authority', kind => {
    const value = { ...proposal({ basis: 'selection', citations: [], message: 'Open a search for this topic.' }), actions: [{ type: 'SearchSources', query: 'quiet thoughts', kind }] };
    expect(validate(value).actions).toEqual(value.actions);
    const ordinary = inputFor(); delete ordinary.canvasSelection;
    expect(() => validateProposal(value, ordinary, prepareContext(ordinary, 'local'))).toThrow(/only.*selected request/);
    expect(JSON.stringify(prepareContext(ordinary, 'local').input.schema)).not.toContain('SearchSources');
  });

  it('rejects blank/overlong queries, fabricated links and combined search/edit actions', () => {
    const base = { ...proposal({ basis: 'general', citations: [] }), actions: [{ type: 'SearchSources', query: '', kind: 'video' }] };
    expect(() => validate(base)).toThrow(/small|query/);
    base.actions[0]!.query = 'x'.repeat(301); expect(() => validate(base)).toThrow(/big|query/);
    base.actions[0]!.query = 'topic';
    expect(() => validate({ ...base, message: 'Found https://invented.example/video' })).toThrow(/Links must refer/);
    expect(() => validate({ ...wire(), actions: [...wire().actions, { type: 'SearchSources', query: 'topic', kind: 'video' }] })).toThrow(/one source search/);
  });
});
