import { describe, expect, it } from 'vitest';
import { compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { proposal, request } from './fixtures';

const base = { placement: 'main' as const, pinned: false, sourceIds: [] as string[] };
const design = (): Extract<CanvasBlock, {kind: 'design'}> => ({
  ...base, kind: 'design', id: 'art', title: 'A personal invitation', width: 720, height: 960, background: '#f3f1e9', layers: [
    { kind: 'image', id: 'photo', name: 'Original image', x: 40, y: 40, width: 640, height: 500, assetId: 'original', fit: 'contain' },
    { kind: 'text', id: 'title', name: 'Title', x: 40, y: 620, width: 640, height: 110, text: 'Notes from Elsewhere', fontFamily: 'serif', fontSize: 48, fontWeight: 'regular', color: '#172036', align: 'left' },
  ],
});
const notes: CanvasBlock = {...base, kind: 'text', id: 'notes', title: 'Notes', body: 'Keep my original wording.', pinned: true};
const document = (blocks: CanvasBlock[] = [notes, design()], suggestions: CanvasSuggestion[] = []): CanvasDocument => ({version: 1, title: 'Work in progress', subtitle: '', layout: 'split', blocks, suggestions});
const captured = (canvas = document()): AgentRequest => {
  const input = request({role: 'prepare', sources: []});
  input.intent.text = 'Center the invitation title';
  input.targets = [{id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas, assets: [{id: 'original', title: 'Original image', mediaType: 'image/jpeg'}]}];
  return input;
};
const validate = (wire: unknown, input = captured()): CanvasDocument => {
  const action = validateProposal({...proposal({basis: 'general', citations: []}), actions: [{type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 7, document: wire}]}, input, prepareContext(input, 'local')).actions[0]!;
  if (action.type !== 'ComposeCanvas') throw new Error('Expected composition');
  return action.document;
};
const centered = { type: 'set', target: {collection: 'layers', id: 'title'}, field: 'align', value: 'center' };
const patch = (changes: unknown[] = [centered], id = 'art') => ({type: 'patch', id, changes});
const choice = (edits: unknown[] = [patch()]) => ({id: 'center', label: 'Center title', description: 'Keep the rest of the artwork.', request: 'Center the existing title and preserve everything else.', targetBlockId: 'art', prepared: {edits}});
const unchanged = [{kind: 'keep', id: 'notes'}, {kind: 'keep', id: 'art'}];

describe('trusted patches at the model boundary', () => {
  it('directly changes one existing layer field and preserves all other original content', () => {
    const wire = {...document(), blocks: [unchanged[0], {kind: 'patch', id: 'art', changes: [centered]}]};
    const untouched = structuredClone(wire), input = captured(), original = structuredClone(input);
    const result = validate(wire, input), expected = design();
    (expected.layers[1] as Extract<typeof expected.layers[number], {kind: 'text'}>).align = 'center';
    expect(result.blocks).toEqual([notes, expected]);
    expect(wire).toEqual(untouched);
    expect(input).toEqual(original);
  });

  it('prepares independent choices using complete resulting content and exact originals', () => {
    const accent = {kind: 'shape', id: 'accent', name: 'Accent', x: 320, y: 760, width: 80, height: 16, shape: 'rectangle', fill: '#5077ed'};
    const wire = {...document(), blocks: [unchanged[0], {kind: 'patch', id: 'art', changes: [{type: 'set', target: null, field: 'title', value: 'Revised invitation'}]}], suggestions: [choice(), {...choice([patch([{type: 'insert', collection: 'layers', afterId: 'title', item: accent}])]), id: 'accent', label: 'Add accent'}]};
    const result = validate(wire);
    expect(result.blocks[1]).toEqual({...design(), title: 'Revised invitation'});
    expect(result.suggestions![0]!.prepared!.before).toEqual([result.blocks[1]]);
    const center = compileCanvasSuggestion(result, 'center').blocks[1] as ReturnType<typeof design>;
    expect(center.layers[0]).toEqual(design().layers[0]);
    expect(center.layers[1]).toEqual({...design().layers[1], align: 'center'});
    const added = compileCanvasSuggestion(result, 'accent').blocks[1] as ReturnType<typeof design>;
    expect(added.layers).toEqual([...design().layers, accent]);
  });

  it.each(['patch', 'keep'] as const)('retains stale originals when an unchanged saved plan is returned as %s', mode => {
    const first = validate({...document(), blocks: unchanged, suggestions: [choice()]});
    const current = design(); current.layers[1]!.x = 30;
    const saved = document([notes, current], first.suggestions);
    const result = validate({...saved, blocks: unchanged, suggestions: [mode === 'keep' ? {kind: 'keep', id: 'center'} : {...choice(), label: 'Review centered title'}]}, captured(saved));
    expect(result.blocks[1]).toEqual(current);
    expect(result.suggestions![0]!.prepared).toEqual(first.suggestions![0]!.prepared);
    expect(() => compileCanvasSuggestion(result, 'center')).toThrow(/changed/i);
  });

  it('retains a stale snapshot when one prepared plan mixes a patch and a full clock-based addition', () => {
    const added = {type: 'add', block: {...base, kind: 'deadline', id: 'due', title: 'Reply by', dueDate: '2026-10-02T15:30'}};
    const mixed = {...choice([patch(), added]), request: 'Center the title and add the reply deadline.'};
    const first = validate({...document(), blocks: unchanged, suggestions: [mixed]});
    expect(compileCanvasSuggestion(first, 'center').blocks.at(-1)).toEqual({...base, kind: 'deadline', id: 'due', title: 'Reply by', dueAt: new Date('2026-10-02T15:30').getTime()});
    const current = design(); current.layers[1]!.x = 30;
    const saved = document([notes, current], first.suggestions);
    const result = validate({...saved, blocks: unchanged, suggestions: [{...mixed, label: 'Review title and deadline'}]}, captured(saved));
    expect(result.blocks).toEqual([notes, current]);
    expect(result.suggestions![0]!.prepared).toEqual(first.suggestions![0]!.prepared);
    expect(result.suggestions![0]!.prepared!.before).toEqual([design()]);
    expect(() => compileCanvasSuggestion(result, 'center')).toThrow(/changed/i);
  });

  it.each([
    ['another target', 'another:canvas', 7],
    ['another revision', 'orbit:canvas', 8],
  ] as const)('does not expand a direct patch against %s', (_name, targetId, expectedRevision) => {
    const input = captured(), snapshot = structuredClone(input);
    const output = {...proposal({basis: 'general', citations: []}), actions: [{type: 'ComposeCanvas', targetId, expectedRevision, document: {...document(), blocks: [notes, {kind: 'patch', id: 'art', changes: [centered]}]}}]};
    expect(() => validateProposal(output, input, prepareContext(input, 'local'))).toThrow(/exactly one existing canvas block/i);
    expect(input).toEqual(snapshot);
  });

  it('captures current originals for a different saved patch intention', () => {
    const first = validate({...document(), blocks: unchanged, suggestions: [choice()]});
    const current = design(); current.layers[1]!.x = 30;
    const saved = document([notes, current], first.suggestions);
    const next = {...choice([patch([{...centered, value: 'right'}])]), label: 'Align right', request: 'Align the title right.'};
    const result = validate({...saved, blocks: unchanged, suggestions: [next]}, captured(saved));
    expect(result.suggestions![0]!.prepared!.before).toEqual([current]);
    expect((compileCanvasSuggestion(result, 'center').blocks[1] as ReturnType<typeof design>).layers[1]).toEqual({...current.layers[1], align: 'right'});
  });

  it('does not accept a historical before snapshot supplied alongside a patch', () => {
    const forged = {...choice(), prepared: {edits: [patch()], before: [{...design(), title: 'Forged'}]}};
    const result = validate({...document(), blocks: unchanged, suggestions: [forged]});
    expect(result.suggestions![0]!.prepared!.before).toEqual([design()]);
  });

  it('keeps linked visuals live after a precise table cell edit', () => {
    const table: CanvasBlock = {...base, kind: 'table', id: 'table', title: 'Counts', columns: ['Name', 'Value'], rows: [{id: 'first', cells: ['Observed', '3']}, {id: 'unknown', cells: ['Unknown', '']}]};
    const chart: CanvasBlock = {...base, kind: 'chart', id: 'chart', title: 'Counts', tableId: 'table', chartType: 'bar', labelColumn: 0, valueColumns: [1]};
    const canvas = document([table, chart]);
    const result = validate({...canvas, blocks: [{kind: 'patch', id: 'table', changes: [{type: 'set-cell', rowId: 'first', column: 1, value: '8'}]}, {kind: 'keep', id: 'chart'}]}, captured(canvas));
    expect(result.blocks).toEqual([{...table, rows: [{id: 'first', cells: ['Observed', '8']}, table.rows[1]]}, chart]);
    expect(() => validate({...canvas, blocks: [{kind: 'patch', id: 'table', changes: [{type: 'set-cell', rowId: 'first', column: 1, value: '=Z8'}]}, {kind: 'keep', id: 'chart'}]}, captured(canvas))).toThrow(/formula/i);
  });

  it('normalizes patch clocks in direct and prepared edits while preserving their other fields', () => {
    const day: CanvasBlock = {...base, kind: 'timeline', id: 'day', title: 'Friday', date: '2026-10-02', startHour: 9, endHour: 18, items: [{id: 'focus', title: 'Focus', startMinutes: 780, endMinutes: 840, status: 'suggested', detail: 'Keep this detail'}]};
    const due: CanvasBlock = {...base, kind: 'deadline', id: 'due', title: 'Due', dueAt: null};
    const canvas = document([day, due]);
    const result = validate({...canvas, blocks: [{kind: 'patch', id: 'day', changes: [{type: 'set', target: {collection: 'items', id: 'focus'}, field: 'startTime', value: '13:15'}]}, {kind: 'keep', id: 'due'}], suggestions: [{...choice([patch([{type: 'set', target: null, field: 'dueDate', value: '2026-10-02T15:30'}], 'due')]), targetBlockId: 'due'}]}, captured(canvas));
    expect(result.blocks[0]).toEqual({...day, items: [{...day.items[0], startMinutes: 795}]});
    expect(compileCanvasSuggestion(result, 'center').blocks[1]).toEqual({...due, dueAt: new Date('2026-10-02T15:30').getTime()});
  });

  it('still enforces pins, selected suggestion scope and admitted images', () => {
    const pinned = {...design(), pinned: true};
    expect(() => validate({...document([notes, pinned]), blocks: [unchanged[0], {kind: 'patch', id: 'art', changes: [centered]}]}, captured(document([notes, pinned])))).toThrow(/unpin/i);
    expect(() => validate({...document(), blocks: unchanged, suggestions: [choice([patch([{type: 'set', target: {collection: 'layers', id: 'photo'}, field: 'assetId', value: 'not-admitted'}])])]})).toThrow(/image.*not attached/i);
    const other: CanvasBlock = {...base, id: 'other', kind: 'text', title: 'Other', body: 'Keep this.'};
    const saved: CanvasSuggestion = {...choice(), prepared: null};
    const canvas = document([notes, design(), other], [saved]), input = captured(canvas);
    input.canvasSuggestion = {id: saved.id, canvasRevision: 7, targetBlockId: 'art'};
    input.intent.text = saved.request;
    expect(() => validate({...canvas, blocks: [...unchanged, {kind: 'patch', id: 'other', changes: [{type: 'set', target: null, field: 'body', value: 'Changed'}]}]}, input)).toThrow(/outside its target/i);
  });

  it('rejects unknown and forged references instead of silently dropping them', () => {
    expect(() => validate({...document(), blocks: [unchanged[0], {kind: 'patch', id: 'missing', changes: [centered]}]})).toThrow(/exactly one existing/i);
    expect(() => validate({...document(), suggestions: [{kind: 'keep', id: 'missing'}]})).toThrow(/captured revision/i);
    const saved = validate({...document(), suggestions: [choice()]});
    expect(() => validate({...saved, suggestions: [{kind: 'keep', id: 'center', prepared: null}]}, captured(saved))).toThrow(/only its existing/i);
    expect(() => validate({...document(), blocks: [null, {kind: 'keep', id: 'art'}], suggestions: [choice()]})).toThrow(expect.objectContaining({code: 'INVALID_OUTPUT'}));
  });

  it('exposes bounded patch branches and scoped keep suggestions without weakening canonical data', () => {
    const saved = validate({...document(), suggestions: [choice()]});
    const schema = prepareContext(captured(saved), 'local').input.schema as any;
    const doc = schema.properties.actions.items.anyOf.find((item: any) => item.properties.type.const === 'ComposeCanvas').properties.document;
    expect(doc.properties.blocks.items.anyOf.some((branch: any) => branch.properties.kind.const === 'patch')).toBe(true);
    const options = doc.properties.suggestions.items.anyOf;
    expect(options.find((branch: any) => branch.properties.kind?.const === 'keep').properties.id.enum).toEqual(['center']);
    const plan = options.find((branch: any) => branch.properties.prepared).properties.prepared.anyOf.find((branch: any) => branch.properties?.edits);
    const precise = plan.properties.edits.items.anyOf.find((branch: any) => branch.properties.type.const === 'patch');
    expect(precise.additionalProperties).toBe(false);
    expect(precise.properties.changes.items.anyOf.find((branch: any) => branch.properties.type.const === 'set').properties.field.enum).not.toContain('layers');
    expect(JSON.stringify(saved)).not.toContain('"type":"patch"');
  });
});
