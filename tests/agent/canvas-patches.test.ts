import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canvasDocumentSchema, compileCanvasSuggestion, type CanvasBlock, type CanvasDocument } from '../../packages/contracts/src/canvas';
import { applyCanvasPatch, canvasBlockPatchSchema, canvasPatchSchema, canvasPreparedPatchSchema, type CanvasPatch } from '../../packages/agent/src/canvas-patches';

const base = (id: string) => ({ id, title: id, placement: 'main' as const, pinned: false, sourceIds: [] as string[] });
const design = (): Extract<CanvasBlock, { kind: 'design' }> => ({ ...base('design'), kind: 'design', width: 720, height: 960, background: '#f3f1e9', layers: [
  { id: 'photo', kind: 'image', name: 'Attached image', x: 40, y: 40, width: 640, height: 500, assetId: 'river-original', fit: 'contain' },
  { id: 'title', kind: 'text', name: 'Title', x: 40, y: 620, width: 640, height: 110, text: 'Notes from Elsewhere', fontFamily: 'serif', fontSize: 52, fontWeight: 'regular', color: '#172333', align: 'left' },
] });
const checklist = (): Extract<CanvasBlock, { kind: 'checklist' }> => ({ ...base('list'), kind: 'checklist', items: [{ id: 'first', label: 'First thought', checked: false }, { id: 'second', label: 'Second thought', checked: true }] });
const table = (): Extract<CanvasBlock, { kind: 'table' }> => ({ ...base('table'), kind: 'table', columns: ['Item', 'Amount'], rows: [{ id: 'a', cells: ['Budget', '50'] }, { id: 'b', cells: ['Cost', '12'] }, { id: 'total', cells: ['Remaining', '=B1-B2'] }] });
const timeline = (): Extract<CanvasBlock, { kind: 'timeline' }> => ({ ...base('schedule'), kind: 'timeline', date: 'Tomorrow', startHour: 9, endHour: 24, items: [{ id: 'work', title: 'Write', startMinutes: 600, endMinutes: 660, status: 'suggested', detail: 'Keep unknown facts unknown.' }] });
const set = (field: Extract<CanvasPatch['changes'][number], { type: 'set' }>['field'], value: Extract<CanvasPatch['changes'][number], { type: 'set' }>['value'], target: Extract<CanvasPatch['changes'][number], { type: 'set' }>['target'] = null): CanvasPatch['changes'][number] => ({ type: 'set', target, field, value });
const patch = (block: CanvasBlock, changes: CanvasPatch['changes']) => ({ id: block.id, changes });

describe('compact registered canvas patches', () => {
  it('centers exactly one existing title without asking the model to reproduce its original layers', () => {
    const original = design(), input = patch(original, [set('align', 'center', { collection: 'layers', id: 'title' })]);
    const result = applyCanvasPatch(original, { type: 'patch', ...input });
    expect(result).toEqual({ ...original, layers: original.layers.map(layer => layer.id === 'title' && layer.kind === 'text' ? { ...layer, align: 'center' } : layer) });
    expect(original).toEqual(design());
    if (result.kind === 'design') { result.layers[0]!.name = 'Changed only in result'; }
    expect(original).toEqual(design());
  });

  it('inserts a supplied accent at its stable anchor while preserving all original authored layers', () => {
    const original = design();
    const accent = { id: 'accent', kind: 'shape' as const, name: 'Accent', x: 320, y: 760, width: 80, height: 16, shape: 'rectangle' as const, fill: '#446677' };
    const input = patch(original, [{ type: 'insert', collection: 'layers', afterId: 'title', item: accent }]);
    const snapshot = structuredClone(input);
    expect(applyCanvasPatch(original, { kind: 'patch', ...input })).toEqual({ ...original, layers: [...original.layers, accent] });
    expect(original).toEqual(design()); expect(input).toEqual(snapshot);
  });

  it.each([
    [{ ...base('writing'), kind: 'text', body: 'Original' }, set('body', 'New authored words'), { body: 'New authored words' }],
    [checklist(), set('title', 'Ready to begin'), { title: 'Ready to begin' }],
    [table(), set('columns', ['Item', 'Cost']), { columns: ['Item', 'Cost'] }],
    [{ ...base('chart'), kind: 'chart', tableId: 'table', chartType: 'bar', labelColumn: 0, valueColumns: [1] }, set('chartType', 'line'), { chartType: 'line' }],
    [{ ...base('metric'), kind: 'metric', tableId: 'table', rowId: 'total', column: 1, prefix: '', suffix: '', decimals: 0 }, set('prefix', '$'), { prefix: '$' }],
    [timeline(), set('date', 'Saturday'), { date: 'Saturday' }],
    [{ ...base('image'), kind: 'image', assetId: 'original', caption: 'Original preserved' }, set('caption', 'My photograph'), { caption: 'My photograph' }],
    [design(), set('background', '#ffffff'), { background: '#ffffff' }],
    [{ ...base('timer'), kind: 'timer', durationSeconds: 600, remainingSeconds: 600, endsAt: null }, set('remainingSeconds', 480), { remainingSeconds: 480 }],
    [{ ...base('due'), kind: 'deadline', dueAt: null }, set('dueDate', '2030-06-01T15:30'), { dueAt: Date.parse('2030-06-01T15:30') }],
    [{ ...base('sources'), kind: 'sources', description: '' }, set('description', 'Saved references'), { description: 'Saved references' }],
    [{ ...base('note'), kind: 'note', description: '' }, set('description', 'Keep my thoughts'), { description: 'Keep my thoughts' }],
  ] as Array<[CanvasBlock, CanvasPatch['changes'][number], Record<string, unknown>]>)('supports registered settings on $0.kind without replacing sibling data', (original, change, changed) => {
    expect(applyCanvasPatch(original, patch(original, [change]))).toEqual({ ...original, ...changed });
  });

  it('keeps authored strings literal rather than interpreting them as executable content', () => {
    const original: CanvasBlock = { ...base('text'), kind: 'text', body: '' };
    const literal = '<script>alert("hello")</script> ${process.env.SECRET}';
    expect(applyCanvasPatch(original, patch(original, [set('body', literal)]))).toMatchObject({ body: literal });
  });

  it('updates primitive arrays while retaining stable linked identities', () => {
    const original: CanvasBlock = { ...base('chart'), kind: 'chart', tableId: 'a-table-in-the-document', chartType: 'bar', labelColumn: 0, valueColumns: [1] };
    const input = patch(original, [set('valueColumns', [1, 2]), set('sourceIds', ['source'])]);
    const snapshot = structuredClone(input), result = applyCanvasPatch(original, input);
    expect(result).toEqual({ ...original, valueColumns: [1, 2], sourceIds: ['source'] });
    result.sourceIds.push('only-in-result');
    if (result.kind === 'chart') result.valueColumns.push(3);
    expect(input).toEqual(snapshot); expect(original.sourceIds).toEqual([]); expect(original.valueColumns).toEqual([1]);
  });

  it('selects checklist items by identity and can separately edit content and move the same item', () => {
    const original = checklist();
    const result = applyCanvasPatch(original, patch(original, [set('label', 'My revised thought', { collection: 'items', id: 'second' }), { type: 'move', collection: 'items', id: 'second', afterId: null }]));
    expect(result).toEqual({ ...original, items: [{ ...original.items[1]!, label: 'My revised thought' }, original.items[0]] });
  });

  it('inserts and removes distinct checklist entries with explicit order', () => {
    const original = checklist(), added = { id: 'new', label: 'A new thought', checked: false };
    expect(applyCanvasPatch(original, patch(original, [{ type: 'insert', collection: 'items', afterId: 'second', item: added }, { type: 'remove', collection: 'items', id: 'first' }]))).toEqual({ ...original, items: [original.items[1], added] });
  });

  it('changes only a selected table cell by row identity and column index', () => {
    const original = table();
    expect(applyCanvasPatch(original, patch(original, [{ type: 'set-cell', rowId: 'b', column: 1, value: '20' }]))).toEqual({ ...original, rows: [original.rows[0], { id: 'b', cells: ['Cost', '20'] }, original.rows[2]] });
  });

  it('inserts registered table rows and moves existing rows without copying their values', () => {
    const original = table(), added = { id: 'c', cells: ['Case', '4'] };
    expect(applyCanvasPatch(original, patch(original, [{ type: 'insert', collection: 'rows', afterId: 'b', item: added }, { type: 'move', collection: 'rows', id: 'total', afterId: null }]))).toEqual({ ...original, rows: [original.rows[2], original.rows[0], original.rows[1], added] });
  });

  it('converts wire clock fields and validates only the final coordinated time change', () => {
    const original = timeline();
    const result = applyCanvasPatch(original, patch(original, [set('startTime', '11:00', { collection: 'items', id: 'work' }), set('endTime', '12:00', { collection: 'items', id: 'work' })]));
    expect(result).toEqual({ ...original, items: [{ ...original.items[0]!, startMinutes: 660, endMinutes: 720 }] });
  });

  it('inserts wire timeline entries with a valid end-of-day boundary', () => {
    const original = timeline();
    expect(applyCanvasPatch(original, patch(original, [{ type: 'insert', collection: 'items', afterId: 'work', item: { id: 'late', title: 'Last thought', startTime: '23:00', endTime: '24:00', status: 'suggested', detail: '' } }]))).toEqual({ ...original, items: [...original.items, { id: 'late', title: 'Last thought', startMinutes: 1380, endMinutes: 1440, status: 'suggested', detail: '' }] });
  });

  it('accepts explicit null for clearing a due date', () => {
    const original: CanvasBlock = { ...base('due'), kind: 'deadline', dueAt: 2_000_000_000_000 };
    expect(applyCanvasPatch(original, patch(original, [set('dueDate', null)]))).toEqual({ ...original, dueAt: null });
  });
});

describe('patch authority and canonical limits', () => {
  it.each(['id', 'kind', 'pinned', 'endsAt', '__proto__', 'constructor', 'layers', 'rows', 'items', 'dueAt', 'startMinutes'] as const)('rejects nonwritable field %s without changing the original', field => {
    const original = design();
    expect(() => applyCanvasPatch(original, { id: original.id, changes: [{ type: 'set', target: null, field, value: 'ignored' }] })).toThrow('Invalid canvas patch');
    expect(original).toEqual(design());
  });

  it('rejects another item identity and pinned originals', () => {
    expect(() => applyCanvasPatch(design(), { id: 'another', changes: [set('title', 'New')] })).toThrow('identity');
    expect(() => applyCanvasPatch({ ...design(), pinned: true }, patch(design(), [set('title', 'New')]))).toThrow('unpin');
  });

  it.each([
    ['wrong collection', [{ type: 'remove', collection: 'rows', id: 'title' }]],
    ['missing entry', [set('align', 'center', { collection: 'layers', id: 'absent' })]],
    ['wrong owner field', [set('body', 'Wrong target')]],
    ['wrong layer field', [set('fill', '#ffffff', { collection: 'layers', id: 'title' })]],
    ['wrong scalar type', [set('width', '720')]],
    ['bad geometry', [set('x', 719, { collection: 'layers', id: 'title' })]],
    ['duplicate field', [set('background', '#ffffff'), set('background', '#000000')]],
    ['duplicate item field', [set('align', 'center', { collection: 'layers', id: 'title' }), set('align', 'right', { collection: 'layers', id: 'title' })]],
    ['duplicate remove', [{ type: 'remove', collection: 'layers', id: 'photo' }, { type: 'remove', collection: 'layers', id: 'photo' }]],
    ['set then remove', [set('align', 'center', { collection: 'layers', id: 'title' }), { type: 'remove', collection: 'layers', id: 'title' }]],
    ['remove then set', [{ type: 'remove', collection: 'layers', id: 'title' }, set('align', 'center', { collection: 'layers', id: 'title' })]],
    ['move after self', [{ type: 'move', collection: 'layers', id: 'title', afterId: 'title' }]],
    ['missing anchor', [{ type: 'move', collection: 'layers', id: 'title', afterId: 'absent' }]],
    ['removed anchor', [{ type: 'move', collection: 'layers', id: 'title', afterId: 'photo' }, { type: 'remove', collection: 'layers', id: 'photo' }]],
    ['duplicate move', [{ type: 'move', collection: 'layers', id: 'title', afterId: null }, { type: 'move', collection: 'layers', id: 'title', afterId: 'photo' }]],
    ['no-op', [set('title', 'design')]],
  ] as Array<[string, CanvasPatch['changes']]>)('rejects %s atomically', (_name, changes) => {
    const original = design(), input = patch(original, changes), snapshot = structuredClone(input);
    expect(() => applyCanvasPatch(original, input)).toThrow('Invalid canvas patch');
    expect(original).toEqual(design()); expect(input).toEqual(snapshot);
  });

  it('rejects unknown properties, arbitrary value objects and unsupported patch shapes', () => {
    expect(() => applyCanvasPatch(design(), { ...patch(design(), [set('title', 'New')]), script: 'run()' })).toThrow();
    expect(() => applyCanvasPatch(design(), { id: 'design', changes: [{ type: 'set', target: null, field: 'title', value: { run: 'code' } }] })).toThrow();
    expect(() => applyCanvasPatch(design(), { type: 'execute', id: 'design', changes: [set('title', 'New')] })).toThrow();
    expect(() => applyCanvasPatch(design(), { id: 'design', changes: [] })).toThrow();
  });

  it('rejects inserted data with the wrong registered collection shape, reused IDs or invalid anchors', () => {
    for (const [item, afterId] of [[{ id: 'invalid', label: 'Checklist data', checked: false }, 'title'], [{ ...design().layers[0] }, 'title'], [{ ...design().layers[0], id: 'new' }, 'absent']] as const) {
      expect(() => applyCanvasPatch(design(), patch(design(), [{ type: 'insert', collection: 'layers', afterId, item }]))).toThrow();
    }
  });

  it('rejects insert-then-edit and delete-then-reinsert ambiguity for the same identity', () => {
    const added = { id: 'new', label: 'A thought', checked: false };
    expect(() => applyCanvasPatch(checklist(), patch(checklist(), [{ type: 'insert', collection: 'items', afterId: null, item: added }, set('checked', true, { collection: 'items', id: 'new' })]))).toThrow();
    expect(() => applyCanvasPatch(checklist(), patch(checklist(), [{ type: 'remove', collection: 'items', id: 'first' }, { type: 'insert', collection: 'items', afterId: null, item: { ...added, id: 'first' } }]))).toThrow();
  });

  it('checks layer/item/row limits and table row widths against the canonical schema', () => {
    const full = design(); full.layers = Array.from({ length: 24 }, (_, i) => ({ ...full.layers[0]!, id: `layer-${i}` }));
    expect(() => applyCanvasPatch(full, patch(full, [{ type: 'insert', collection: 'layers', afterId: null, item: { ...full.layers[0]!, id: 'extra' } }]))).toThrow();
    const list = checklist(); list.items = Array.from({ length: 60 }, (_, i) => ({ id: `item-${i}`, label: '', checked: false }));
    expect(() => applyCanvasPatch(list, patch(list, [{ type: 'insert', collection: 'items', afterId: null, item: { id: 'extra', label: '', checked: false } }]))).toThrow();
    expect(() => applyCanvasPatch(table(), patch(table(), [{ type: 'insert', collection: 'rows', afterId: null, item: { id: 'wrong-width', cells: ['Only one'] } }]))).toThrow();
  });

  it.each(['25:00', '9:30', '10:60', '24:00', '2027-01-01T10:00'])('rejects invalid start clock %s', clock => {
    expect(() => applyCanvasPatch(timeline(), patch(timeline(), [set('startTime', clock, { collection: 'items', id: 'work' })]))).toThrow();
  });

  it.each(['2030-02-30T12:00', '2030-06-01', '2030-06-01T15:30Z', '2030-06-01T15:30:00', 'tomorrow'])('rejects invalid local due date %s', date => {
    const original: CanvasBlock = { ...base('due'), kind: 'deadline', dueAt: null };
    expect(() => applyCanvasPatch(original, patch(original, [set('dueDate', date)]))).toThrow();
  });

  it('rejects event geometry outside its visible schedule and non-increasing times', () => {
    expect(() => applyCanvasPatch(timeline(), patch(timeline(), [set('startTime', '08:00', { collection: 'items', id: 'work' })]))).toThrow();
    expect(() => applyCanvasPatch(timeline(), patch(timeline(), [set('endTime', '09:00', { collection: 'items', id: 'work' })]))).toThrow();
  });

  it('rejects missing and duplicate table cell writes without rewriting sibling values', () => {
    for (const changes of [[{ type: 'set-cell', rowId: 'absent', column: 0, value: '' }], [{ type: 'set-cell', rowId: 'a', column: 2, value: '' }], [{ type: 'set-cell', rowId: 'a', column: 1, value: '20' }, { type: 'set-cell', rowId: 'a', column: 1, value: '30' }]] as const) {
      expect(() => applyCanvasPatch(table(), { id: 'table', changes })).toThrow();
    }
  });

  it('still delegates whole-document links, resources, formulas and timer actions to existing authority checks', () => {
    const changed = applyCanvasPatch(design(), patch(design(), [set('assetId', 'not-admitted', { collection: 'layers', id: 'photo' })]));
    const document: CanvasDocument = { version: 1, title: 'Review', subtitle: '', layout: 'focus', blocks: [design()], suggestions: [{ id: 'choice', label: 'Image', description: '', request: 'Change the image.', targetBlockId: 'design', prepared: { edits: [{ type: 'replace', block: changed }], before: [design()] } }] };
    expect(() => compileCanvasSuggestion(document, 'choice', { assetIds: ['river-original'], sourceIds: [] })).toThrow('image');
    const changedTable = applyCanvasPatch(table(), patch(table(), [{ type: 'set-cell', rowId: 'a', column: 1, value: '=B1' }]));
    const invalidFormula: CanvasDocument = { ...document, blocks: [table()], suggestions: [{ ...document.suggestions![0]!, targetBlockId: 'table', prepared: { edits: [{ type: 'replace', block: changedTable }], before: [table()] } }] };
    expect(() => compileCanvasSuggestion(invalidFormula, 'choice')).toThrow('formula');
    expect(canvasDocumentSchema.safeParse({ ...document, blocks: [{ ...base('metric'), kind: 'metric', tableId: 'missing', rowId: null, column: 0, prefix: '', suffix: '', decimals: 0 }], suggestions: [] }).success).toBe(false);
  });

  it('uses strict discriminators first in generated wire schemas and keeps transport shapes distinct', () => {
    expect(Object.keys(z.toJSONSchema(canvasBlockPatchSchema).properties ?? {})[0]).toBe('kind');
    expect(Object.keys(z.toJSONSchema(canvasPreparedPatchSchema).properties ?? {})[0]).toBe('type');
    const value = patch(design(), [set('title', 'New')]);
    expect(canvasPatchSchema.safeParse(value).success).toBe(true);
    expect(canvasBlockPatchSchema.safeParse({ kind: 'patch', ...value }).success).toBe(true);
    expect(canvasPreparedPatchSchema.safeParse({ type: 'patch', ...value }).success).toBe(true);
    expect(canvasBlockPatchSchema.safeParse({ kind: 'patch', type: 'patch', ...value }).success).toBe(false);
  });
});
