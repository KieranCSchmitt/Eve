import { describe, expect, it } from 'vitest';
import { assertCanvasSuggestionRefreshResult, assertCanvasSuggestionRefreshScope, canvasDocumentSchema, canvasSuggestionRefreshCapacity, canvasSuggestionRefreshScopeSchema, canvasSuggestionUnavailableReason, compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion, type CanvasSuggestionRefreshScope } from '../../packages/contracts/src/index';

const text = (id: string, body = 'Before same after same end'): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body, placement: 'main', pinned: false, sourceIds: [] });
const document = (): CanvasDocument => ({ version: 1, title: 'Authored work', subtitle: '', layout: 'focus', blocks: [text('draft'), text('other')], suggestions: [] });
const scope = (): CanvasSuggestionRefreshScope => ({ blockId: 'draft', selection: { field: 'body', start: 18, end: 22, text: 'same' } });
const choice = (body = 'Before same after clearer end'): CanvasSuggestion => ({ id: 'rewrite', label: 'Clarify this passage', description: 'Review a wording change.', request: 'Clarify this passage only.', targetBlockId: 'draft', textSelection: scope().selection, prepared: { edits: [{ type: 'replace', block: text('draft', body) }], before: [text('draft')] } });
const withChoice = (suggestion = choice()): CanvasDocument => ({ ...document(), suggestions: [suggestion] });
const legacy = (id: string, targetBlockId: string | null = null): CanvasSuggestion => ({ id, targetBlockId, label: id, description: 'Retained', request: 'Retained' });

describe('captured canvas text ranges', () => {
  it('uses the exact repeated occurrence and never relocates a range', () => {
    expect(() => assertCanvasSuggestionRefreshScope(document(), scope())).not.toThrow();
    const bad = scope(); bad.selection!.start = 17; bad.selection!.end = 21;
    expect(() => assertCanvasSuggestionRefreshScope(document(), bad)).toThrow(/selected text changed/i);
    expect(compileCanvasSuggestion(withChoice(), 'rewrite').blocks[0]).toEqual(text('draft', 'Before same after clearer end'));
  });

  it.each([
    { start: -1, end: 3, text: 'same' }, { start: 18.5, end: 22.5, text: 'same' },
    { start: 18, end: 18, text: '' }, { start: 18, end: 22, text: 'different' },
    { start: 20000, end: 20004, text: 'same' }, { start: 18, end: 22, text: 'same', field: 'title' },
  ])('rejects malformed selection %#', selection => {
    expect(canvasSuggestionRefreshScopeSchema.safeParse({ blockId: 'draft', selection: { field: 'body', ...selection } }).success).toBe(false);
  });

  it('accepts whole emoji ranges but refuses splitting UTF-16 surrogate pairs', () => {
    const canvas = document(); canvas.blocks[0] = text('draft', 'A😀B');
    expect(() => assertCanvasSuggestionRefreshScope(canvas, { blockId: 'draft', selection: { field: 'body', start: 1, end: 3, text: '😀' } })).not.toThrow();
    for (const [start, end, selected] of [[1, 2, '\ud83d'], [2, 3, '\ude00']] as const) expect(() => assertCanvasSuggestionRefreshScope(canvas, { blockId: 'draft', selection: { field: 'body', start, end, text: selected } })).toThrow(/selected text changed/i);
  });

  it('requires an actual unpinned text block for a selected range', () => {
    const canvas = document(); canvas.blocks[0]!.pinned = true;
    expect(() => assertCanvasSuggestionRefreshScope(canvas, scope())).toThrow(/unpin/i);
    expect(() => assertCanvasSuggestionRefreshScope(document(), { blockId: 'missing' })).toThrow(/no longer available/i);
    canvas.blocks[0] = { id: 'draft', kind: 'checklist', title: '', pinned: false, placement: 'main', sourceIds: [], items: [] };
    expect(() => assertCanvasSuggestionRefreshScope(canvas, scope())).toThrow(/selected text changed/i);
  });
});

describe('selected-text prepared authority', () => {
  it.each(['Before same after  end', 'Before same after a much longer passage end'])('permits replacement length changes: %s', body => {
    const result = compileCanvasSuggestion(withChoice(choice(body)), 'rewrite');
    expect(result.blocks[0]).toEqual(text('draft', body));
  });

  it.each(['prefix', 'suffix', 'title', 'placement', 'sources', 'kind', 'remove', 'arrangement'])('rejects changes outside the range: %s', effect => {
    const suggestion = choice(), plan = suggestion.prepared!;
    const edit = plan.edits[0]; if (edit?.type !== 'replace' || edit.block.kind !== 'text') throw new Error('fixture');
    if (effect === 'prefix') edit.block.body = 'Changed same after clearer end';
    if (effect === 'suffix') edit.block.body = 'Before same after clearer changed';
    if (effect === 'title') edit.block.title = 'Changed';
    if (effect === 'placement') edit.block.placement = 'aside';
    if (effect === 'sources') edit.block.sourceIds = ['different'];
    if (effect === 'kind') plan.edits = [{ type: 'replace', block: { id: 'draft', kind: 'checklist', title: 'draft', placement: 'main', sourceIds: [], pinned: false, items: [] } }];
    if (effect === 'remove') plan.edits = [{ type: 'remove', id: 'draft' }];
    if (effect === 'arrangement') { plan.arrangement = { layout: 'split', order: ['draft', 'other'] }; plan.beforeArrangement = { layout: 'focus', blocks: [{ id: 'draft', placement: 'main' }, { id: 'other', placement: 'main' }] }; }
    expect(() => compileCanvasSuggestion(withChoice(suggestion), 'rewrite')).toThrow(/selected.text|outside the selection/i);
  });

  it('allows supporting additions but keeps range, resources and pins authoritative', () => {
    const suggestion = choice(); suggestion.prepared = { edits: [{ type: 'add', block: text('questions', 'What should this passage establish?') }], before: [] };
    const canvas = withChoice(suggestion);
    expect(compileCanvasSuggestion(canvas, 'rewrite').blocks).toHaveLength(3);
    const changed = structuredClone(canvas); changed.blocks[0] = text('draft', 'Before same after replaced end');
    expect(canvasDocumentSchema.safeParse(changed).success).toBe(true);
    expect(() => compileCanvasSuggestion(changed, 'rewrite')).toThrow(/selected text changed/i);
    canvas.blocks[0]!.pinned = true;
    expect(() => compileCanvasSuggestion(canvas, 'rewrite')).toThrow(/unpin/i);
    canvas.blocks[0]!.pinned = false;
    const edit = suggestion.prepared.edits[0]; if (edit?.type !== 'add') throw new Error('fixture'); edit.block.sourceIds = ['unavailable'];
    expect(() => compileCanvasSuggestion(canvas, 'rewrite', { sourceIds: [], assetIds: [] })).toThrow(/source.*not attached/i);
  });

  it('can save stale choices but cannot compile them or present them as current', () => {
    const canvas = withChoice(); canvas.blocks[0] = text('draft', 'Later authored writing');
    expect(canvasDocumentSchema.safeParse(canvas).success).toBe(true);
    expect(canvasSuggestionUnavailableReason(canvas, canvas.suggestions![0]!)).toMatch(/selected text changed/i);
    expect(() => compileCanvasSuggestion(canvas, 'rewrite')).toThrow(/selected text changed/i);
  });

  it('does not accept a selection descriptor on a prose-only or whole-canvas choice', () => {
    expect(canvasDocumentSchema.safeParse(withChoice({ ...choice(), prepared: null })).success).toBe(false);
    expect(canvasDocumentSchema.safeParse(withChoice({ ...choice(), targetBlockId: null })).success).toBe(false);
  });
});

describe('trusted scoped metadata refresh result', () => {
  it('retains unrelated stale plans exactly while validating the refreshed bucket', () => {
    const before = document(), stale = { ...choice(), id: 'other-stale', targetBlockId: 'other', textSelection: undefined, prepared: { edits: [{ type: 'replace' as const, block: text('other', 'Prepared old edit') }], before: [text('other', 'Historical original')] } };
    delete stale.textSelection;
    before.suggestions = [legacy('whole'), stale, legacy('old-local', 'draft')];
    const after = { ...before, suggestions: [before.suggestions[0]!, stale, choice()] };
    expect(() => assertCanvasSuggestionRefreshResult(before, after, scope())).not.toThrow();
    const changedForeign = structuredClone(after); changedForeign.suggestions[0]!.label = 'Changed';
    expect(() => assertCanvasSuggestionRefreshResult(before, changedForeign, scope())).toThrow(/unrelated suggestion/i);
    expect(() => assertCanvasSuggestionRefreshResult(before, { ...after, title: 'Rewritten' }, scope())).toThrow(/preserve every existing block/i);
  });

  it('limits saved choices to 24 while scoped capacity preserves foreign buckets', () => {
    const before = document(); before.suggestions = Array.from({ length: 23 }, (_, index) => legacy(`foreign-${index}`));
    expect(canvasSuggestionRefreshCapacity(before, scope())).toBe(1);
    const after = { ...before, suggestions: [...before.suggestions, choice()] };
    expect(canvasDocumentSchema.safeParse(after).success).toBe(true);
    expect(() => assertCanvasSuggestionRefreshResult(before, after, scope())).not.toThrow();
    expect(canvasSuggestionRefreshCapacity(after, { blockId: 'other' })).toBe(0);
    expect(canvasSuggestionRefreshCapacity(after)).toBe(6);
    expect(canvasDocumentSchema.safeParse({ ...after, suggestions: [...after.suggestions, legacy('overflow')] }).success).toBe(false);
  });

  it('independently rejects rebased historical originals and selected scopes', () => {
    const before = withChoice(), changed = structuredClone(before); changed.blocks[0] = text('draft', 'Before same after same end!');
    const rebased = structuredClone(changed); rebased.suggestions![0]!.prepared!.before = [changed.blocks[0]!];
    expect(() => assertCanvasSuggestionRefreshResult(changed, rebased, scope())).toThrow(/captured original/i);
    const rescope = structuredClone(before); rescope.suggestions![0]!.textSelection = { field: 'body', start: 7, end: 11, text: 'same' };
    expect(() => assertCanvasSuggestionRefreshResult(before, rescope, { blockId: 'draft', selection: rescope.suggestions![0]!.textSelection })).toThrow(/captured scope/i);
  });
});
