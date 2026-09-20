import { describe, expect, it } from 'vitest';
import { calculateCell, canvasDocumentSchema, numericCanvasCell, type CanvasBlock, type CanvasDocument } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal } from '../../packages/agent/src/index';
import { proposal, request } from './fixtures';

const base = (id: string) => ({ id, title: id, placement: 'main' as const, pinned: false, sourceIds: [] as string[] });
const table = (): Extract<CanvasBlock, { kind: 'table' }> => ({ ...base('budget'), kind: 'table', columns: ['Item', 'Amount', 'Other'], rows: [
  { id: 'available', cells: ['Available', '$200', '220'] },
  { id: 'cost', cells: ['Headphones', '$149', '169'] },
  { id: 'remaining', cells: ['Remaining', '=B1-B2', '=C1-C2'] },
] });
const chart = (changes: Partial<Extract<CanvasBlock, { kind: 'chart' }>> = {}): Extract<CanvasBlock, { kind: 'chart' }> => ({ ...base('comparison'), kind: 'chart', tableId: 'budget', chartType: 'bar', labelColumn: 0, valueColumns: [1, 2], ...changes });
const metric = (changes: Partial<Extract<CanvasBlock, { kind: 'metric' }>> = {}): Extract<CanvasBlock, { kind: 'metric' }> => ({ ...base('remaining-amount'), kind: 'metric', tableId: 'budget', rowId: 'remaining', column: 1, prefix: '$', suffix: ' left', decimals: 2, ...changes });
const document = (blocks: CanvasBlock[] = [table(), chart(), metric()]): CanvasDocument => ({ version: 1, title: 'Headphone budget', subtitle: '', layout: 'split', blocks });
const captured = () => request({ role: 'prepare', sources: [], targets: [{ kind: 'canvas', id: 'orbit:canvas', revision: 2, canvas: document() }] });
const output = (blocks: unknown[]) => ({ ...proposal({ basis: 'general', citations: [] }), actions: [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 2, document: { ...document(), blocks } }] });

describe('linked canvas visual contracts', () => {
  it('accepts live bindings regardless of block order, and one-column charts can label their measured values', () => {
    expect(canvasDocumentSchema.parse(document([chart(), metric(), table()])).blocks).toHaveLength(3);
    const oneColumn = { ...table(), columns: ['Measurement'], rows: [{ id: 'one', cells: ['12'] }] };
    expect(canvasDocumentSchema.safeParse(document([oneColumn, chart({ labelColumn: 0, valueColumns: [0] })])).success).toBe(true);
  });
  it('accepts useful unconfigured tools with no table or no selected row/series', () => {
    const blank = document([chart({ tableId: null, valueColumns: [] }), metric({ tableId: null, rowId: null })]);
    expect(canvasDocumentSchema.parse(blank)).toEqual(blank);
    expect(canvasDocumentSchema.safeParse(document([table(), chart({ valueColumns: [] }), metric({ rowId: null })])).success).toBe(true);
    expect(canvasDocumentSchema.safeParse(document([table()])).success).toBe(true);
  });
  it.each([
    chart({ tableId: 'other-space:budget' }),
    chart({ tableId: 'missing' }),
    chart({ tableId: 'remaining-amount' }),
    chart({ labelColumn: 3 }),
    chart({ valueColumns: [1, 3] }),
    chart({ valueColumns: [1, 1] }),
    chart({ valueColumns: [0, 1, 2, 3] }),
    metric({ tableId: 'missing' }),
    metric({ tableId: 'comparison' }),
    metric({ tableId: null, rowId: 'remaining' }),
    metric({ rowId: 'another-row' }),
    metric({ column: 3 }),
    metric({ decimals: 5 }),
    metric({ prefix: 'x'.repeat(13) }),
    metric({ suffix: 'x'.repeat(25) }),
  ])('rejects invalid visual binding/configuration %j', invalid => {
    const original = document();
    const value = { ...original, blocks: original.blocks.map(block => block.id === invalid.id ? invalid : block) };
    expect(canvasDocumentSchema.safeParse(value).success).toBe(false);
  });
  it('rejects copied numbers, callbacks or other executable fields instead of treating them as live bindings', () => {
    for (const field of [{ values: [200, 149] }, { value: 51 }, { onClick: 'fetch("https://example.org")' }]) {
      expect(canvasDocumentSchema.safeParse(document([table(), { ...chart(), ...field }])).success).toBe(false);
    }
  });
});

describe('numeric canvas values', () => {
  it.each([
    ['0', 0], ['-0', -0], ['42', 42], ['  3.5  ', 3.5], ['.75', .75], ['-12.25', -12.25], ['+2', 2],
    ['1,234.56', 1234.56], ['$2,500', 2500], ['£ 0.50', .5], ['€-1,200.25', -1200.25], ['-$1,200', -1200], ['¥900', 900],
  ])('reads ordinary number %s without losing its sign or turning it into text', (value, expected) => {
    expect(numericCanvasCell([{ cells: [String(value)] }], 0, 0)).toBe(expected);
  });
  it.each(['', ' ', '\n\t', 'Unknown', '$', '1,23', '1,,000', '1234,567', '1,234,', '1e3', '0x10', 'Infinity', '-Infinity', 'NaN', '12 kg', '50%', '1 234', '1.2.3', '+-1', '--1', '9'.repeat(400)])('keeps missing or invalid data %j absent', value => {
    expect(numericCanvasCell([{ cells: [value] }], 0, 0)).toBeNull();
  });
  it('rejects missing coordinates and derives formulas live after table edits and row movements', () => {
    const rows = table().rows;
    expect(numericCanvasCell(rows, 2, 1)).toBe(51);
    rows[1]!.cells[1] = '$175';
    expect(numericCanvasCell(rows, 2, 1)).toBe(25);
    for (const [row, column] of [[-1, 0], [0, -1], [1.5, 0], [0, .5], [20, 0], [0, 20], [Infinity, 0]]) expect(numericCanvasCell(rows, row, column)).toBeNull();
    const stableRows = [{ id: 'one', cells: ['1'] }, { id: 'two', cells: ['2'] }].reverse();
    expect(numericCanvasCell(stableRows, stableRows.findIndex(row => row.id === 'one'), 0)).toBe(1);
  });
  it('does not allow formula references to turn blanks, malformed commas or unit text into invented numbers', () => {
    for (const cell of ['', ' ', '1,23', '12 kg', '0x10']) {
      const rows = [{ cells: [cell, '=A1+2'] }];
      expect(calculateCell(rows, 0, 1)).toBe('#FORMULA');
      expect(numericCanvasCell(rows, 0, 1)).toBeNull();
    }
    expect(numericCanvasCell([{ cells: ['0', '=A1+2'] }], 0, 1)).toBe(2);
  });
  it('keeps cycles, division by zero and executable expressions absent, and large finite values finite', () => {
    for (const rows of [[{ cells: ['=A1'] }], [{ cells: ['=1/0'] }], [{ cells: ['=globalThis.process.exit()'] }]]) expect(numericCanvasCell(rows, 0, 0)).toBeNull();
    const large = '9'.repeat(300);
    expect(numericCanvasCell([{ cells: [large, '=A1*1'] }], 0, 1)).toBe(Number(large));
  });
});

describe('model-authored linked visuals', () => {
  it('expands kept table/visual references before validating bindings and preserves pinned configuration while values change', () => {
    const input = captured();
    const pinned = chart({ pinned: true }); input.targets[0]!.canvas = document([table(), pinned, metric()]);
    input.intent.text = 'Change the headphone cost to $175.';
    input.targets[0]!.canvas.suggestions = [{ id: 'edit-cost', label: 'Adjust the cost', description: '', request: input.intent.text, targetBlockId: 'budget' }];
    input.canvasSuggestion = { id: 'edit-cost', canvasRevision: 2, targetBlockId: 'budget' };
    const changed = table(); changed.rows[1]!.cells[1] = '$175';
    const result = validateProposal(output([changed, { kind: 'keep', id: pinned.id }, { kind: 'keep', id: metric().id }]), input, prepareContext(input, 'local'));
    expect(result.actions[0]).toMatchObject({ document: { blocks: [changed, pinned, metric()] } });
    expect(numericCanvasCell(changed.rows, 2, 1)).toBe(25);
    const fresh = captured();
    const newVisual = validateProposal(output([{ kind: 'keep', id: 'budget' }, chart(), metric()]), fresh, prepareContext(fresh, 'local'));
    expect(newVisual.actions[0]).toMatchObject({ document: { blocks: [table(), chart(), metric()] } });
  });
  it('rejects stale linked references when a composition removes a table or referenced row', () => {
    const input = captured();
    const missingRow = table(); missingRow.rows = missingRow.rows.filter(row => row.id !== 'remaining');
    for (const blocks of [[{ kind: 'keep', id: chart().id }, { kind: 'keep', id: metric().id }], [missingRow, { kind: 'keep', id: metric().id }]]) {
      expect(() => validateProposal(output(blocks), input, prepareContext(input, 'local'))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    }
  });
  it.each(['local', 'cloud'] as const)('offers strict live-binding shapes and truthful configuration instructions to %s models', provider => {
    const prepared = prepareContext(captured(), provider);
    const schema = prepared.input.schema as any;
    const blocks = schema.properties.actions.items.anyOf[0].properties.document.properties.blocks.items.anyOf;
    for (const kind of ['chart', 'metric']) {
      const block = blocks.find((item: any) => item.properties.kind.const === kind);
      expect(block.additionalProperties).toBe(false);
      expect([...block.required].sort()).toEqual(Object.keys(block.properties).sort());
      expect(block.properties).toHaveProperty('tableId');
      expect(block.properties).not.toHaveProperty('values');
    }
    expect(prepared.input.instructions).toContain('Values derive live from table cells and formulas');
    expect(prepared.input.instructions).toContain('Empty, invalid and nonnumeric cells are missing data, never zero.');
    expect(prepared.input.instructions).toContain('Pinning a chart or metric preserves its configuration');
    expect(prepared.input.instructions).toContain('the inline controls collect these settings');
  });
});
