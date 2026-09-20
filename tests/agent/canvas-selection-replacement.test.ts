import { describe, expect, it } from 'vitest';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { applyCanvasSelectionReplacement, canvasPreparedSelectionReplacementSchema } from '../../packages/agent/src/canvas-patches';
import { compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestionRefreshScope } from '../../packages/contracts/src/index';
import { proposal, request } from './fixtures';

const body = 'α e\u0301 😀 same\r\nmiddle same尾';
const start = body.lastIndexOf('same');
const scope = (): CanvasSuggestionRefreshScope => ({ blockId: 'draft', selection: { field: 'body', start, end: start + 4, text: 'same' } });
const block = (id = 'draft', content = body): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body: content, placement: 'main', pinned: false, sourceIds: [] });
const canvas = (): CanvasDocument => ({ version: 1, title: 'Draft', subtitle: 'Preserve this', layout: 'split', blocks: [block(), { ...block('pinned', 'Protected writing'), pinned: true, placement: 'aside' }], suggestions: [] });
const captured = (document = canvas()): AgentRequest => {
  const input = request({ role: 'prepare', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas: document, assets: [] }], canvasSuggestionRefresh: { targetId: 'orbit:canvas', canvasRevision: 7, scope: scope() } });
  delete input.context.selection;
  input.intent.text = 'Suggest useful choices for this selected passage.';
  return input;
};
const edit = (text = 'clearer') => ({ type: 'replace-selection', id: 'draft', text });
const choice = (edits: unknown[] = [edit()], id = 'wording') => ({ id, targetBlockId: 'draft', label: 'Clarify this passage', description: 'Review new wording for this passage.', request: 'Clarify this passage only.', prepared: { edits, arrangement: null } });
const output = (choices: unknown[] = [choice()]) => ({ ...proposal({ basis: 'general', citations: [], message: 'Here are choices for review.' }), actions: [{ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions: choices }] });
const validate = (choices: unknown[] = [choice()], input = captured()) => {
  const result = validateProposal(output(choices), input, prepareContext(input, 'local'));
  const action = result.actions[0]; if (action?.type !== 'ComposeCanvas') throw new Error('Expected canvas'); return action.document;
};
const replaced = (text: string) => body.slice(0, start) + text + body.slice(start + 4);

describe('captured selected-passage replacement transport', () => {
  it('replaces the second repeated occurrence using local offsets, preserving emoji, combining marks, CRLF and whitespace', () => {
    const input = captured(), snapshot = structuredClone(input), wire = [choice([edit(' \n新🙂\t ')])], originalWire = structuredClone(wire);
    const next = validate(wire, input), saved = next.suggestions![0]!;
    expect({ ...next, suggestions: [] }).toEqual(canvas());
    expect(saved.textSelection).toEqual(scope().selection);
    expect(saved.prepared!.before).toEqual([block()]);
    expect(saved.prepared!.edits).toEqual([{ type: 'replace', block: block('draft', replaced(' \n新🙂\t ')) }]);
    expect(compileCanvasSuggestion(next, 'wording').blocks[0]).toEqual(block('draft', replaced(' \n新🙂\t ')));
    expect(input).toEqual(snapshot); expect(wire).toEqual(originalWire);
  });

  it('returns an independent clone without mutating any original fields', () => {
    const original = block(), updated = applyCanvasSelectionReplacement(original, edit(), scope());
    expect(updated).toEqual(block('draft', replaced('clearer'))); expect(original).toEqual(block());
    expect(updated).not.toBe(original); expect(updated.sourceIds).not.toBe(original.sourceIds);
  });

  it('allows exact empty deletion, including selecting the whole body', () => {
    const partial = validate([choice([edit('')])]);
    expect(compileCanvasSuggestion(partial, 'wording').blocks[0]).toEqual(block('draft', replaced('')));
    const input = captured(); input.canvasSuggestionRefresh!.scope!.selection = { field: 'body', start: 0, end: body.length, text: body };
    expect(compileCanvasSuggestion(validate([choice([edit('')])], input), 'wording').blocks[0]).toEqual(block('draft', ''));
  });

  it('rejects a wholly unchanged plan while allowing a validated no-op preservation sibling', () => {
    expect(() => validate([choice([edit('same')])])).toThrow(/edit or an arrangement/i);
    const addition = { type: 'add', block: block('questions', 'What should this passage establish?') };
    const next = validate([choice([edit('same'), addition])]);
    expect(next.suggestions![0]!.prepared!.edits).toEqual([addition]);
    expect(next.suggestions![0]!.prepared!.before).toEqual([]);
    expect(compileCanvasSuggestion(next, 'wording').blocks[0]).toEqual(block());
  });

  it('does not change direct all-no-op patch policy', () => {
    const input = captured(); delete input.canvasSuggestionRefresh;
    const wire: any = output([]); wire.actions[0].edits = [{ type: 'patch', id: 'draft', changes: [{ type: 'set', target: null, field: 'body', value: body }] }];
    expect(() => validateProposal(wire, input, prepareContext(input, 'local'))).toThrow(/does not change/i);
  });

  it('publishes the primitive only for the exact selected passage and keeps full edits supported', () => {
    const input = captured(), schema = prepareContext(input, 'local').input.schema as any;
    const replacement = schema.properties.actions.items.anyOf[0].properties.suggestions.items.properties.prepared.properties.edits.items;
    expect(replacement.properties.type.const).toBe('replace-selection');
    expect(replacement.properties.id).toEqual({ type: 'string', const: 'draft' });
    expect(replacement.required).toEqual(['type', 'id', 'text']); expect(replacement.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('set-cell');
    delete input.canvasSuggestionRefresh!.scope!.selection;
    expect(JSON.stringify(prepareContext(input, 'local').input.schema)).not.toContain('replace-selection');
    delete input.canvasSuggestionRefresh;
    expect(JSON.stringify(prepareContext(input, 'local').input.schema)).not.toContain('replace-selection');
    expect(validate([choice([{ type: 'replace', block: block('draft', replaced('clearer')) }])]).suggestions![0]!.prepared!.edits).toEqual([{ type: 'replace', block: block('draft', replaced('clearer')) }]);
  });
});

describe('selection replacement trust boundaries', () => {
  it.each(['start', 'end', 'range', 'block', 'sourceIds', 'path', 'kind'])('rejects forged extra key %s before normalization can discard it', key => {
    const forged = { ...edit('same'), [key]: 'forged' };
    expect(canvasPreparedSelectionReplacementSchema.safeParse(forged).success).toBe(false);
    expect(() => validate([choice([forged, { type: 'add', block: block('new') }])])).toThrow(/selected.text replacement needs correction/i);
  });

  it.each([null, 5, {}, 'x'.repeat(20001)])('rejects malformed or oversized replacement %#', text => {
    expect(() => validate([choice([{ ...edit(), text }])])).toThrow(/replacement needs correction/i);
  });

  it('checks final body size as well as replacement length', () => {
    expect(() => validate([choice([edit('x'.repeat(20000))])])).toThrow(/too big|20000|too_big/i);
  });

  it.each(['missing scope', 'whole canvas', 'item only', 'wrong edit target', 'wrong suggestion target', 'wrong revision', 'pinned', 'stale quote', 'split emoji'])('rejects %s', issue => {
    const input = captured(), selected = input.canvasSuggestionRefresh!.scope!, wireChoice = choice();
    if (issue === 'missing scope') delete input.canvasSuggestionRefresh;
    if (issue === 'whole canvas') delete input.canvasSuggestionRefresh!.scope;
    if (issue === 'item only') delete selected.selection;
    if (issue === 'wrong edit target') wireChoice.prepared.edits = [{ ...edit(), id: 'pinned' }];
    if (issue === 'wrong suggestion target') wireChoice.targetBlockId = 'pinned';
    if (issue === 'wrong revision') input.canvasSuggestionRefresh!.canvasRevision = 8;
    if (issue === 'pinned') input.targets[0]!.canvas!.blocks[0]!.pinned = true;
    if (issue === 'stale quote') input.targets[0]!.canvas!.blocks[0] = block('draft', body.replaceAll('same', 'else'));
    if (issue === 'split emoji') { const emoji = body.indexOf('😀'); selected.selection = { field: 'body', start: emoji, end: emoji + 1, text: '\ud83d' }; }
    expect(() => validate([wireChoice], input)).toThrow();
  });

  it('does not accept the primitive as a direct canvas mutation', () => {
    const input = captured(); delete input.canvasSuggestionRefresh;
    const wire: any = output([]); wire.actions[0].edits = [edit()];
    expect(() => validateProposal(wire, input, prepareContext(input, 'local'))).toThrow(/canvas patch action needs correction/i);
  });

  it.each(['primitive', 'patch', 'replace', 'remove'])('rejects duplicate identity with %s even when the first replacement is unchanged', type => {
    const second = type === 'primitive' ? edit() : type === 'patch' ? { type, id: 'draft', changes: [{ type: 'set', target: null, field: 'body', value: replaced('other') }] } : type === 'replace' ? { type, block: block('draft', replaced('other')) } : { type, id: 'draft' };
    expect(() => validate([choice([edit('same'), second])])).toThrow(/identity only once/i);
  });

  it('cannot launder a raw five-edit plan by dropping the unchanged primitive', () => {
    const edits = [edit('same'), ...Array.from({ length: 4 }, (_, index) => ({ type: 'add', block: block(`new-${index}`) }))];
    expect(() => validate([choice(edits)])).toThrow(/at most four/i);
  });

  it('keeps resource admission on supporting effects and copied selected-block references', () => {
    expect(() => validate([choice([edit(), { type: 'add', block: { ...block('new'), sourceIds: ['invented'] } }])])).toThrow(/source.*not attached/i);
    const input = captured(); input.targets[0]!.canvas!.blocks[0]!.sourceIds = ['not-admitted'];
    expect(() => validate([choice()], input)).toThrow(/source.*not attached/i);
  });
});

describe('historical selected-passage plans never rebase silently', () => {
  it('retains an existing exact prepared plan through the new primitive', () => {
    const saved = validate(), input = captured(saved);
    expect(validate([choice()], input).suggestions).toEqual(saved.suggestions);
  });

  it.each(['alone', 'added sibling', 'removed sibling', 'metadata'])('retains stale before when an unchanged replacement is returned with %s', mutation => {
    const initialEdits = mutation === 'removed sibling' ? [edit(), { type: 'add', block: block('support', 'A question') }] : [edit()];
    const saved = validate([choice(initialEdits)]);
    saved.blocks[0] = block('draft', body + '\nLater authored text');
    const next = choice(mutation === 'added sibling' ? [edit(), { type: 'add', block: block('support', 'A question') }] : [edit()]);
    if (mutation === 'metadata') next.label = 'Another label for the same wording';
    expect(() => validate([next], captured(saved))).toThrow(/changed/i);
  });

  it('does not adopt another occurrence or scope under the saved identity', () => {
    const saved = validate(), input = captured(saved), first = body.indexOf('same');
    input.canvasSuggestionRefresh!.scope!.selection = { field: 'body', start: first, end: first + 4, text: 'same' };
    expect(() => validate([choice()], input)).toThrow(/different text selection/i);
    expect(validate([choice([edit()], 'fresh')], input).suggestions![0]!.textSelection!.start).toBe(first);
  });

  it('permits a genuinely different replacement against the new capture while preserving outside writing', () => {
    const saved = validate(); saved.blocks[0] = block('draft', body + '\nLater authored text');
    const next = validate([choice([edit('different wording')], 'fresh')], captured(saved));
    expect(next.suggestions![0]!.prepared!.before).toEqual([saved.blocks[0]]);
    const compiled = compileCanvasSuggestion(next, 'fresh');
    expect(compiled.blocks[0]).toEqual(block('draft', replaced('different wording') + '\nLater authored text'));
  });
});
