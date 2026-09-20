import { describe, expect, it } from 'vitest';
import { canvasDataEqual, canvasDocumentSchema, canvasReferencedBlocks, canvasSuggestionUnavailableReason, compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/canvas';

const base = (id: string) => ({ id, title: id, placement: 'main' as const, pinned: false, sourceIds: [] as string[] });
const text = (id: string, body = 'Original writing'): CanvasBlock => ({ ...base(id), kind: 'text', body });
const table = (): CanvasBlock => ({ ...base('table'), kind: 'table', columns: ['Item', 'Cost'], rows: [{ id: 'first', cells: ['Paper', '12'] }, { id: 'total', cells: ['Total', '=B1*2'] }] });
const design = (assetId = 'image'): Extract<CanvasBlock, { kind: 'design' }> => ({ ...base('design'), kind: 'design', width: 480, height: 640, background: '#ffffff', layers: [{ id: 'image', name: 'Original', kind: 'image', x: 0, y: 0, width: 480, height: 640, assetId, fit: 'cover' }] });
const document = (): CanvasDocument => ({ version: 1, title: 'Working draft', subtitle: '', layout: 'split', blocks: [text('draft'), { ...text('original'), pinned: true }, table()], suggestions: [] });
const suggestion = (id: string, edits: NonNullable<CanvasSuggestion['prepared']>['edits'], before: CanvasBlock[] = [], targetBlockId: string | null = null): CanvasSuggestion => ({ id, label: 'Review this change', description: 'A concrete next step.', request: 'Make the described change.', targetBlockId, prepared: { edits: structuredClone(edits), before: structuredClone(before) } });
const replace = (id = 'shorter'): CanvasSuggestion => suggestion(id, [{ type: 'replace', block: text('draft', 'Concise writing') }], [text('draft')], 'draft');
const withSuggestion = (value: CanvasSuggestion): CanvasDocument => ({ ...document(), suggestions: [value] });
const editedBlock = (edit: NonNullable<CanvasSuggestion['prepared']>['edits'][number]): CanvasBlock => { if (edit.type === 'remove') throw new Error('Expected a block edit'); return edit.block; };

describe('prepared canvas suggestion compiler', () => {
  it('returns an isolated complete preview while retaining unrelated work and removing the selected choice', () => {
    const selected = replace(); selected.prepared!.edits.push({ type: 'add', block: { ...base('next'), kind: 'checklist', placement: 'aside', items: [] } });
    const current = withSuggestion(selected), original = structuredClone(current);
    const result = compileCanvasSuggestion(current, selected.id, { assetIds: [], sourceIds: [] });
    expect(result.blocks).toEqual([text('draft', 'Concise writing'), document().blocks[1], table(), editedBlock(selected.prepared!.edits[1]!)]);
    expect(result.suggestions).toEqual([]);
    expect(current).toEqual(original);
    (result.blocks[1] as Extract<CanvasBlock, { kind: 'text' }>).body = 'Mutated preview';
    expect(current).toEqual(original);
  });

  it('compiles linked additions atomically even when their table appears later in the edit list', () => {
    const chart: CanvasBlock = { ...base('chart'), kind: 'chart', tableId: 'new-table', chartType: 'line', labelColumn: 0, valueColumns: [1] };
    const selected = suggestion('linked', [{ type: 'add', block: chart }, { type: 'add', block: { ...table(), id: 'new-table' } }]);
    const result = compileCanvasSuggestion(withSuggestion(selected), selected.id);
    expect(result.blocks.slice(-2)).toEqual(selected.prepared!.edits.map(editedBlock));
  });

  it('drops dependent choices while keeping usable independent and legacy suggestions', () => {
    const selected = replace();
    const dependent = replace('alternative'); dependent.prepared!.edits[0] = { type: 'replace', block: text('draft', 'A different revision') };
    const independent = suggestion('add', [{ type: 'add', block: text('fresh', '') }]);
    const legacy: CanvasSuggestion = { id: 'legacy', label: 'Explore', description: '', request: 'Explore the subject.', targetBlockId: 'draft' };
    const nullPlan: CanvasSuggestion = { ...legacy, id: 'nullable', prepared: null };
    const current = { ...document(), suggestions: [selected, dependent, independent, legacy, nullPlan] };
    expect(compileCanvasSuggestion(current, selected.id).suggestions).toEqual([independent, legacy, nullPlan]);
  });

  it('stores stale preconditions without allowing their execution or overwriting newer local writing', () => {
    const current = withSuggestion(replace()); current.blocks[0] = text('draft', 'Newer local writing');
    expect(canvasDocumentSchema.safeParse(current).success).toBe(true);
    expect(() => compileCanvasSuggestion(current, 'shorter')).toThrow('changed');
    expect(current.blocks[0]).toEqual(text('draft', 'Newer local writing'));
  });

  it('keeps an unchanged running timer outside the edited target', () => {
    const current = withSuggestion(replace());
    current.blocks.push({ ...base('running'), kind: 'timer', durationSeconds: 600, remainingSeconds: 480, endsAt: 2_000_000_000_000 });
    expect(compileCanvasSuggestion(current, 'shorter').blocks.at(-1)).toEqual(current.blocks.at(-1));
  });

  it.each([
    ['no plan', { id: 'shorter', label: 'Legacy', description: '', request: 'A request', targetBlockId: 'draft' } as CanvasSuggestion, 'no prepared'],
    ['no-op', suggestion('shorter', [{ type: 'replace', block: text('draft') }], [text('draft')]), 'unchanged'],
    ['add collision', suggestion('shorter', [{ type: 'add', block: text('draft', 'Replacement') }]), 'already'],
    ['missing replacement', suggestion('shorter', [{ type: 'replace', block: text('absent', 'Replacement') }], [text('absent')]), 'changed'],
    ['outside target', suggestion('shorter', [{ type: 'replace', block: { ...table(), title: 'Costs' } }], [table()], 'draft'), 'outside'],
    ['pin', suggestion('shorter', [{ type: 'replace', block: text('original', 'Replacement') }], [{ ...text('original'), pinned: true }]), 'Unpin'],
    ['timer start', suggestion('shorter', [{ type: 'add', block: { ...base('timer'), kind: 'timer', durationSeconds: 600, remainingSeconds: 600, endsAt: 2_000_000_000_000 } }]), 'Start'],
    ['timer resume', suggestion('shorter', [{ type: 'add', block: { ...base('timer'), kind: 'timer', durationSeconds: 600, remainingSeconds: 480, endsAt: null } }]), 'Start'],
    ['invalid formula', suggestion('shorter', [{ type: 'add', block: { ...base('invalid-table'), kind: 'table', columns: ['Value'], rows: [{ id: 'row', cells: ['=A1'] }] } }]), 'formula'],
    ['dangling chart', suggestion('shorter', [{ type: 'add', block: { ...base('chart'), kind: 'chart', tableId: 'absent', chartType: 'bar', labelColumn: 0, valueColumns: [1] } }]), 'table'],
  ])('rejects %s without modifying its source', (_label, selected, message) => {
    const current = withSuggestion(selected), original = structuredClone(current);
    expect(() => compileCanvasSuggestion(current, 'shorter')).toThrow(message);
    expect(current).toEqual(original);
  });

  it('checks the entire resulting document when a replacement would break a retained linked figure', () => {
    const selected = suggestion('remove-row', [{ type: 'replace', block: { ...table(), kind: 'table', columns: ['Item', 'Cost'], rows: [{ id: 'first', cells: ['Paper', '12'] }] } }], [table()], 'table');
    const current = withSuggestion(selected);
    current.blocks.push({ ...base('figure'), kind: 'metric', pinned: true, tableId: 'table', rowId: 'total', column: 1, prefix: '$', suffix: '', decimals: 0 });
    expect(() => compileCanvasSuggestion(current, selected.id)).toThrow('row');
  });

  it('checks actual image and source admission, including nested layers, before preview', () => {
    const selected = suggestion('photo', [{ type: 'add', block: { ...design(), sourceIds: ['source'] } }]);
    const current = withSuggestion(selected);
    expect(() => compileCanvasSuggestion(current, selected.id, { assetIds: [], sourceIds: ['source'] })).toThrow('image');
    expect(() => compileCanvasSuggestion(current, selected.id, { assetIds: ['image'], sourceIds: [] })).toThrow('source');
    expect(compileCanvasSuggestion(current, selected.id, { assetIds: ['image'], sourceIds: ['source'] }).blocks.at(-1)).toEqual(editedBlock(selected.prepared!.edits[0]!));
  });

  it('enforces maximum canvas capacity before producing an addition preview', () => {
    const current = withSuggestion(suggestion('add', [{ type: 'add', block: text('another') }]));
    current.blocks = Array.from({ length: 24 }, (_, index) => text(`item-${index}`));
    expect(() => compileCanvasSuggestion(current, 'add')).toThrow('valid canvas');
  });
});

describe('prepared suggestion data admission', () => {
  it.each([
    ['missing original', (selected: CanvasSuggestion) => { selected.prepared!.before = []; }],
    ['extra original', (selected: CanvasSuggestion) => { selected.prepared!.before.push(text('other')); }],
    ['duplicate original', (selected: CanvasSuggestion) => { selected.prepared!.before.push(text('draft')); }],
    ['duplicate edit', (selected: CanvasSuggestion) => { selected.prepared!.edits.push(selected.prepared!.edits[0]!); }],
    ['empty changes', (selected: CanvasSuggestion) => { selected.prepared!.edits = []; selected.prepared!.before = []; }],
  ] as const)('rejects %s even before trying to compile', (_name, mutate) => {
    const selected = replace(); mutate(selected);
    expect(canvasDocumentSchema.safeParse(withSuggestion(selected)).success).toBe(false);
  });

  it.each(['edits', 'before'] as const)('validates nested design geometry in prepared %s', location => {
    const original = design(), after = { ...design(), title: 'New title' };
    const current = { ...document(), blocks: [...document().blocks, original], suggestions: [suggestion('design', [{ type: 'replace', block: after }], [original])] };
    const invalid = structuredClone(current);
    const target = location === 'edits' ? editedBlock(invalid.suggestions[0]!.prepared!.edits[0]!) : invalid.suggestions[0]!.prepared!.before[0]!;
    if (target.kind === 'design') target.layers[0]!.width = 481;
    expect(canvasDocumentSchema.safeParse(invalid).success).toBe(false);
  });

  it('does not require future links to exist until all edits are applied together', () => {
    const selected = suggestion('future', [{ type: 'add', block: { ...base('chart'), kind: 'chart', tableId: 'not-yet-here', chartType: 'bar', labelColumn: 0, valueColumns: [1] } }]);
    expect(canvasDocumentSchema.safeParse(withSuggestion(selected)).success).toBe(true);
    expect(() => compileCanvasSuggestion(withSuggestion(selected), selected.id)).toThrow('table');
  });

  it('traverses dormant replacements and before snapshots for resource admission', () => {
    const original = design(), after = { ...design('second-image'), title: 'Alternative' };
    const current = { ...document(), blocks: [...document().blocks, original], suggestions: [suggestion('photo', [{ type: 'replace', block: after }], [original])] };
    expect(canvasReferencedBlocks(current)).toEqual([...current.blocks, after, original]);
  });

  it('compares nested JSON independent of object key order but preserves array order and absent values', () => {
    expect(canvasDataEqual({ first: [1, { a: 'x', b: true }], second: null }, { second: null, first: [1, { b: true, a: 'x' }] })).toBe(true);
    expect(canvasDataEqual([1, 2], [2, 1])).toBe(false);
    expect(canvasDataEqual({}, { value: undefined })).toBe(false);
    expect(canvasDataEqual({ value: null }, { value: false })).toBe(false);
  });
});

describe('presentation-only saved suggestion prerequisites', () => {
  it('allows an unchanged target after unrelated writing changes without cloning its document', () => {
    const selected = replace(), current = withSuggestion(selected);
    current.blocks[1] = { ...text('original', 'New unrelated writing'), pinned: true };
    const frozen = structuredClone(current); Object.freeze(current.blocks); Object.freeze(current);
    expect(canvasSuggestionUnavailableReason(current, selected)).toBeUndefined();
    expect(current).toEqual(frozen);
  });

  it.each([
    ['changed target', (current: CanvasDocument, _selected: CanvasSuggestion) => { current.blocks[0] = text('draft', 'New local writing'); }, 'changed'],
    ['missing target', (current: CanvasDocument, _selected: CanvasSuggestion) => { current.blocks.shift(); }, 'changed'],
    ['pin', (current: CanvasDocument, selected: CanvasSuggestion) => { current.blocks[0]!.pinned = true; selected.prepared!.before[0]!.pinned = true; }, 'Unpin'],
    ['scope', (_current: CanvasDocument, selected: CanvasSuggestion) => { selected.targetBlockId = 'table'; }, 'outside'],
    ['no-op', (_current: CanvasDocument, selected: CanvasSuggestion) => { selected.prepared!.edits[0] = { type: 'replace', block: text('draft') }; }, 'unchanged'],
    ['add collision', (_current: CanvasDocument, selected: CanvasSuggestion) => { selected.prepared!.edits = [{ type: 'add', block: text('table') }]; selected.prepared!.before = []; }, 'already'],
  ] as const)('marks a %s unavailable without full compilation', (_name, change, reason) => {
    const selected = replace(), current = withSuggestion(selected); change(current, selected);
    expect(canvasSuggestionUnavailableReason(current, selected)).toContain(reason);
  });

  it('keeps legacy and nullable choices available for their separate inference route', () => {
    const legacy: CanvasSuggestion = { id: 'legacy', label: 'Explore', description: '', request: 'Explore this subject.', targetBlockId: null };
    expect(canvasSuggestionUnavailableReason(document(), legacy)).toBeUndefined();
    expect(canvasSuggestionUnavailableReason(document(), { ...legacy, prepared: null })).toBeUndefined();
  });

  it('does not mistake a passing prerequisite for executable validation or evaluate future formulas', () => {
    const selected = suggestion('formula', [{ type: 'add', block: { ...base('new-table'), kind: 'table', columns: ['Number'], rows: [{ id: 'cycle', cells: ['=A1'] }] } }]);
    const current = withSuggestion(selected);
    expect(canvasSuggestionUnavailableReason(current, selected)).toBeUndefined();
    expect(() => compileCanvasSuggestion(current, selected.id)).toThrow('formula');
  });
});
