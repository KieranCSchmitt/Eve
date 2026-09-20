import { describe, expect, it } from 'vitest';
import { canvasArrangementSnapshot, canvasDocumentSchema, canvasReferencedBlocks, canvasSuggestionUnavailableReason, compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/canvas';

const text = (id: string): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body: `Authored ${id}`, placement: 'main', pinned: false, sourceIds: [] });
const document = (): CanvasDocument => ({ version: 1, title: 'Workspace', subtitle: 'Preserve metadata', layout: 'split', blocks: [text('a'), { ...text('b'), pinned: true, placement: 'aside' }, text('c')], suggestions: [] });
type Plan = NonNullable<CanvasSuggestion['prepared']>;
const prepare = (current: CanvasDocument, edits: Plan['edits'] = [], arrangement?: Plan['arrangement'], targetBlockId: string | null = null): CanvasSuggestion => ({
  id: 'choice', label: 'Review change', description: 'A proposed change.', request: 'Make the described change.', targetBlockId,
  prepared: { edits, before: edits.flatMap(edit => edit.type === 'add' ? [] : current.blocks.filter(block => block.id === (edit.type === 'remove' ? edit.id : edit.block.id))), ...(arrangement ? { arrangement, beforeArrangement: canvasArrangementSnapshot(current) } : {}) },
});
const withPlan = (current: CanvasDocument, selected: CanvasSuggestion): CanvasDocument => ({ ...current, suggestions: [selected] });

describe('prepared removal and arrangement compilation', () => {
  it('removes exactly a captured block, preserving order, metadata, pins and originals', () => {
    const current = document(), selected = prepare(current, [{ type: 'remove', id: 'a' }], undefined, 'a');
    const saved = withPlan(current, selected), snapshot = structuredClone(saved), result = compileCanvasSuggestion(saved, selected.id);
    expect(result).toEqual({ ...current, blocks: current.blocks.slice(1), suggestions: [] });
    expect(saved).toEqual(snapshot);
    result.blocks[0]!.title = 'Only the isolated result';
    expect(saved).toEqual(snapshot);
  });

  it('applies removals, replacements, additions and arrangement as one atomic result', () => {
    const current = document(), changed = { ...text('c'), placement: 'full' as const };
    const selected = prepare(current, [{ type: 'remove', id: 'a' }, { type: 'replace', block: changed }, { type: 'add', block: text('new') }], { layout: 'gallery', order: ['new', 'b', 'c'] });
    expect(compileCanvasSuggestion(withPlan(current, selected), selected.id)).toEqual({ ...current, layout: 'gallery', blocks: [text('new'), current.blocks[1], changed], suggestions: [] });
  });

  it('supports arrangement-only and targeted arrangements while keeping pinned block contents exact', () => {
    const current = document(), selected = prepare(current, [], { layout: 'gallery', order: ['c', 'b', 'a'] }, 'a');
    const result = compileCanvasSuggestion(withPlan(current, selected), selected.id);
    expect(result).toEqual({ ...current, layout: 'gallery', blocks: [current.blocks[2], current.blocks[1], current.blocks[0]], suggestions: [] });
    expect(selected.prepared!.before).toEqual([]);
  });

  it('permits unrelated typing while protecting the captured layout, order and placements', () => {
    const current = document(), selected = prepare(current, [], { layout: 'gallery', order: ['c', 'b', 'a'] });
    current.blocks[0] = { ...text('a'), body: 'New user writing' };
    expect(canvasSuggestionUnavailableReason(current, selected)).toBeUndefined();
    expect(compileCanvasSuggestion(withPlan(current, selected), selected.id).blocks.at(-1)).toEqual(current.blocks[0]);
    expect(canvasArrangementSnapshot(current)).toEqual({ layout: 'split', blocks: [{ id: 'a', placement: 'main' }, { id: 'b', placement: 'aside' }, { id: 'c', placement: 'main' }] });
  });

  it.each(['layout', 'order', 'placement', 'added item'] as const)('rejects stale %s while allowing the stale plan to remain saved', change => {
    const current = document(), selected = prepare(current, [], { layout: 'gallery', order: ['c', 'b', 'a'] });
    if (change === 'layout') current.layout = 'focus';
    if (change === 'order') current.blocks.reverse();
    if (change === 'placement') current.blocks[0]!.placement = 'aside';
    if (change === 'added item') current.blocks.push(text('later'));
    const saved = withPlan(current, selected);
    expect(canvasDocumentSchema.safeParse(saved).success).toBe(true);
    expect(canvasSuggestionUnavailableReason(current, selected)).toContain('arrangement changed');
    expect(() => compileCanvasSuggestion(saved, selected.id)).toThrow('arrangement changed');
  });

  it('rejects pure arrangement no-ops but permits a redundant arrangement beside a real edit', () => {
    const current = document(), arrangement = { layout: current.layout, order: current.blocks.map(block => block.id) };
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [], arrangement)), 'choice')).toThrow('unchanged');
    const edited = { ...text('a'), title: 'New title' };
    expect(compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'replace', block: edited }], arrangement)), 'choice').blocks[0]).toEqual(edited);
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'replace', block: text('a') }], { ...arrangement, layout: 'gallery' })), 'choice')).toThrow('item unchanged');
  });

  it.each([
    ['duplicate', ['a', 'a', 'c']], ['missing', ['a', 'b']], ['foreign', ['a', 'b', 'other']], ['empty', []],
  ])('rejects %s desired arrangement identities', (_name, order) => {
    const current = document(), saved = withPlan(current, prepare(current, [], { layout: 'gallery', order }));
    expect(() => compileCanvasSuggestion(saved, 'choice')).toThrow();
  });

  it('requires the order to describe resulting IDs rather than removed or omitted added IDs', () => {
    const current = document();
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'a' }], { layout: 'gallery', order: ['a', 'b', 'c'] })), 'choice')).toThrow('every resulting');
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'add', block: text('new') }], { layout: 'gallery', order: ['a', 'b', 'c'] })), 'choice')).toThrow('every resulting');
  });

  it('removes choices targeting a removed block before validating the remaining document, and prunes other stale plans', () => {
    const current = document(), selected = prepare(current, [{ type: 'remove', id: 'a' }]);
    const legacy: CanvasSuggestion = { id: 'legacy', label: 'Explore', description: '', request: 'Explore a.', targetBlockId: 'a' };
    const dependent = { ...prepare(current, [{ type: 'replace', block: { ...text('a'), title: 'New' } }]), id: 'dependent' };
    const arranged = { ...prepare(current, [], { layout: 'gallery', order: ['c', 'b', 'a'] }), id: 'arranged' };
    const independent = { ...prepare(current, [{ type: 'add', block: text('new') }]), id: 'independent' };
    current.suggestions = [selected, legacy, dependent, arranged, independent];
    expect(compileCanvasSuggestion(current, selected.id).suggestions).toEqual([independent]);
  });

  it('rejects pinned, out-of-scope, missing and changed removal originals', () => {
    const current = document();
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'b' }])), 'choice')).toThrow('Unpin');
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'c' }], undefined, 'a')), 'choice')).toThrow('outside');
    const selected = prepare(current, [{ type: 'remove', id: 'a' }]);
    current.blocks[0] = { ...text('a'), title: 'New title' };
    expect(() => compileCanvasSuggestion(withPlan(current, selected), 'choice')).toThrow('changed');
    current.blocks.shift();
    expect(() => compileCanvasSuggestion(withPlan(current, selected), 'choice')).toThrow('changed');
  });

  it('refuses the last-block removal unless another block is added atomically', () => {
    const current = { ...document(), blocks: [text('a')] };
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'a' }])), 'choice')).toThrow('every item');
    expect(compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'a' }, { type: 'add', block: text('new') }])), 'choice').blocks).toEqual([text('new')]);
  });

  it('requires explicit dependent visual changes when removing a linked table', () => {
    const table: CanvasBlock = { id: 'data', kind: 'table', title: 'Data', pinned: false, placement: 'main', sourceIds: [], columns: ['Value'], rows: [{ id: 'row', cells: ['3'] }] };
    const chart: CanvasBlock = { id: 'chart', kind: 'chart', title: 'Values', pinned: false, sourceIds: [], placement: 'main', tableId: 'data', chartType: 'bar', labelColumn: 0, valueColumns: [0] };
    const current = { ...document(), blocks: [table, chart, text('a')] };
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'data' }])), 'choice')).toThrow('table');
    const detached = { ...chart, tableId: null, valueColumns: [] };
    expect(compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'data' }, { type: 'replace', block: detached }])), 'choice').blocks).toEqual([detached, text('a')]);
    current.blocks[1] = { ...chart, pinned: true };
    expect(() => compileCanvasSuggestion(withPlan(current, prepare(current, [{ type: 'remove', id: 'data' }, { type: 'replace', block: detached }])), 'choice')).toThrow('Unpin');
  });

  it('keeps removal originals in resource traversal and requires their preview resources', () => {
    const image: CanvasBlock = { id: 'photo', kind: 'image', title: 'Original', pinned: false, placement: 'main', sourceIds: ['source'], assetId: 'image', caption: 'Authored caption' };
    const current = { ...document(), blocks: [image, text('a')] }, selected = prepare(current, [{ type: 'remove', id: image.id }]);
    const saved = withPlan(current, selected);
    expect(canvasReferencedBlocks(saved)).toEqual([...current.blocks, image]);
    expect(() => compileCanvasSuggestion(saved, 'choice', { assetIds: [], sourceIds: ['source'] })).toThrow('image');
    expect(() => compileCanvasSuggestion(saved, 'choice', { assetIds: ['image'], sourceIds: [] })).toThrow('source');
    expect(compileCanvasSuggestion(saved, 'choice', { assetIds: ['image'], sourceIds: ['source'] }).blocks).toEqual([text('a')]);
  });
});

describe('arrangement and removal canonical admission', () => {
  it('preserves legacy plan identities without inserting arrangement fields', () => {
    const current = document(), selected = prepare(current, [{ type: 'remove', id: 'a' }]), saved = withPlan(current, selected);
    expect(canvasDocumentSchema.parse(saved)).toEqual(saved);
    expect(Object.hasOwn(canvasDocumentSchema.parse(saved).suggestions![0]!.prepared!, 'arrangement')).toBe(false);
  });

  it.each(['missing removal original', 'extra original', 'duplicate edit', 'extra removal field', 'missing arrangement snapshot', 'orphan arrangement snapshot', 'duplicate snapshot ID', 'invalid snapshot placement'] as const)('rejects %s', problem => {
    const current = document(), selected = prepare(current, [{ type: 'remove', id: 'a' }], { layout: 'gallery', order: ['b', 'c'] });
    const plan = selected.prepared!;
    if (problem === 'missing removal original') plan.before = [];
    if (problem === 'extra original') plan.before.push(text('c'));
    if (problem === 'duplicate edit') plan.edits.push({ type: 'replace', block: { ...text('a'), title: 'Changed' } });
    if (problem === 'extra removal field') Object.assign(plan.edits[0]!, { block: text('a') });
    if (problem === 'missing arrangement snapshot') delete plan.beforeArrangement;
    if (problem === 'orphan arrangement snapshot') delete plan.arrangement;
    if (problem === 'duplicate snapshot ID') plan.beforeArrangement!.blocks.push(plan.beforeArrangement!.blocks[0]!);
    if (problem === 'invalid snapshot placement') Object.assign(plan.beforeArrangement!.blocks[0]!, { placement: 'arbitrary' });
    expect(canvasDocumentSchema.safeParse(withPlan(current, selected)).success).toBe(false);
  });
});
