import { describe, expect, it } from 'vitest';
import { compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { registeredActionSchema } from '../../packages/agent/src/contracts';
import { proposal, request } from './fixtures';

const base = { placement: 'main' as const, pinned: false, sourceIds: [] as string[] };
const photo = (): Extract<CanvasBlock, { kind: 'image' }> => ({
  ...base, kind: 'image', id: 'photo', title: 'My photograph', assetId: 'original', caption: 'My authored caption.',
  adjustments: { brightness: 1.08, contrast: 1.17, saturation: 0.82, straighten: -2.5, crop: { left: 0.12, top: 0.08, right: 0.88, bottom: 0.93 } },
});
const notes: CanvasBlock = { ...base, id: 'notes', kind: 'text', title: 'Pinned notes', body: 'Preserve every word.', placement: 'aside', pinned: true };
const writing: CanvasBlock = { ...base, id: 'writing', kind: 'text', title: 'My draft', body: 'An unfinished thought.' };
const canvas = (blocks: CanvasBlock[] = [photo(), notes, writing], suggestions: CanvasSuggestion[] = []): CanvasDocument => ({ version: 1, title: 'Authored workspace', subtitle: 'Keep this subtitle.', layout: 'gallery', blocks, suggestions });
const captured = (document = canvas()): AgentRequest => {
  const input = request({ role: 'prepare', sources: [] });
  input.intent.text = 'Change only the requested existing setting.';
  input.targets = [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas: document, assets: [{ id: 'original', title: 'An attached image', mediaType: 'image/png' }] }];
  return input;
};
const set = (field: string, value: unknown, target: unknown = null) => ({ type: 'set', target, field, value });
const edit = (id = 'writing', changes: unknown[] = [set('title', 'Revised title')]) => ({ type: 'patch', id, changes });
const action = (edits: unknown[] = [edit()], suggestions: unknown = null) => ({ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits, suggestions });
const output = (value: unknown = action()) => ({ ...proposal({ basis: 'general', citations: [] }), actions: [value] });
const validate = (value: unknown = action(), input = captured()): CanvasDocument => {
  const result = validateProposal(output(value), input, prepareContext(input, 'local'));
  expect(result.actions).toHaveLength(1);
  const resultAction = result.actions[0]!;
  if (resultAction.type !== 'ComposeCanvas') throw new Error('Only canonical canvas actions may leave normalization.');
  return resultAction.document;
};
const choice = () => ({ id: 'future-title', label: 'Preview a title', description: 'Change only this title.', request: 'Change the draft title to Next title.', targetBlockId: 'writing', prepared: { edits: [edit('writing', [set('title', 'Next title')])] } });

describe('wire-only PatchCanvas preservation', () => {
  it('applies an exact image edit without requiring keep references for surrounding work', () => {
    const original = photo(), adjustments = { ...original.adjustments!, straighten: 3.5, crop: { left: 0.2, top: 0.125, right: 0.8, bottom: 0.875 } };
    const input = captured(), wire = action([edit('photo', [{ type: 'adjust-image', adjustments }])]);
    const beforeInput = structuredClone(input), beforeWire = structuredClone(wire);
    const result = validate(wire, input);
    expect(result).toEqual({ ...canvas(), blocks: [{ ...original, adjustments }, notes, writing] });
    expect(input).toEqual(beforeInput); expect(wire).toEqual(beforeWire);
    const adjusted = result.blocks[0];
    if (adjusted?.kind === 'image') adjusted.adjustments!.crop.left = 0.3;
    expect(input).toEqual(beforeInput); expect(wire).toEqual(beforeWire);
  });

  it('applies each explicit block patch once while preserving original order and metadata', () => {
    const result = validate(action([edit(), edit('photo', [set('caption', 'A revised caption.')])]));
    expect(result).toEqual({ ...canvas(), blocks: [{ ...photo(), caption: 'A revised caption.' }, notes, { ...writing, title: 'Revised title' }] });
  });

  it('can prepare choices without editing the composition', () => {
    const result = validate(action([], [choice()]));
    expect({ ...result, suggestions: [] }).toEqual(canvas());
    expect(result.suggestions![0]!.prepared!.before).toEqual([writing]);
    expect(compileCanvasSuggestion(result, 'future-title').blocks).toEqual([photo(), notes, { ...writing, title: 'Next title' }]);
  });

  it('captures new plans from the resulting composition, ignoring provider-supplied before snapshots', () => {
    const forged = { ...choice(), prepared: { ...choice().prepared, before: [{ ...writing, body: 'Forged original' }] } };
    const result = validate(action([edit('writing', [set('body', 'Authorized new body')])], [forged]));
    expect(result.suggestions![0]!.prepared!.before).toEqual([{ ...writing, body: 'Authorized new body' }]);
    expect(compileCanvasSuggestion(result, 'future-title').blocks[2]).toEqual({ ...writing, title: 'Next title', body: 'Authorized new body' });
  });

  it('preserves absent suggestions with null and explicitly clears saved choices with an empty list', () => {
    const legacy = canvas(); delete legacy.suggestions;
    expect(validate(action([], null), captured(legacy))).toEqual(legacy);
    expect(Object.hasOwn(validate(action([], null), captured(legacy)), 'suggestions')).toBe(false);
    const saved = validate(action([], [choice()]));
    expect(validate(action([], []), captured(saved))).toEqual(canvas());
  });

  it.each(['null', 'keep', 'patch'] as const)('retains old exact preconditions through %s suggestions when a current block has changed', mode => {
    const first = validate(action([], [choice()]));
    const changed = { ...writing, body: 'Later user typing' };
    const saved = { ...first, blocks: [photo(), notes, changed] };
    const suggestions = mode === 'null' ? null : mode === 'keep' ? [{ kind: 'keep', id: 'future-title' }] : [{ ...choice(), label: 'Review this title' }];
    const result = validate(action([], suggestions), captured(saved));
    expect(result.blocks[2]).toEqual(changed);
    expect(result.suggestions![0]!.prepared).toEqual(first.suggestions![0]!.prepared);
    expect(() => compileCanvasSuggestion(result, 'future-title')).toThrow(/changed/i);
  });

  it('retains saved choices as stale when the same action changes their underlying block', () => {
    const saved = validate(action([], [choice()]));
    const result = validate(action([edit('writing', [set('body', 'A new current draft')])], null), captured(saved));
    expect(result.suggestions).toEqual(saved.suggestions);
    expect(() => compileCanvasSuggestion(result, 'future-title')).toThrow(/changed/i);
  });

  it('converts patch clocks and future full-block clocks in the correct order', () => {
    const day: CanvasBlock = { ...base, id: 'day', kind: 'timeline', title: 'Friday', date: '2026-10-02', startHour: 9, endHour: 18, items: [{ id: 'focus', title: 'Write', startMinutes: 780, endMinutes: 840, status: 'suggested', detail: 'Preserve detail' }] };
    const due: CanvasBlock = { ...base, id: 'due', kind: 'deadline', title: 'Due', dueAt: null };
    const future = { ...choice(), id: 'future-day', targetBlockId: null, prepared: { edits: [{ type: 'add', block: { ...base, id: 'later', kind: 'deadline', title: 'Later', dueDate: '2026-10-03T15:30' } }] } };
    const result = validate(action([
      edit('day', [set('startTime', '13:15', { collection: 'items', id: 'focus' })]),
      edit('due', [set('dueDate', '2026-10-02T15:30')]),
    ], [future]), captured(canvas([day, notes, due])));
    expect(result.blocks).toEqual([{ ...day, items: [{ ...day.items[0], startMinutes: 795 }] }, notes, { ...due, dueAt: new Date('2026-10-02T15:30').getTime() }]);
    expect(compileCanvasSuggestion(result, 'future-day').blocks.at(-1)).toEqual({ ...base, id: 'later', kind: 'deadline', title: 'Later', dueAt: new Date('2026-10-03T15:30').getTime() });
  });
});

describe('PatchCanvas authority remains canonical', () => {
  it.each([
    ['wrong target', { targetId: 'another:canvas' }],
    ['wrong revision', { expectedRevision: 8 }],
  ])('rejects %s before applying any patch', (_name, changes) => {
    const input = captured(), before = structuredClone(input);
    expect(() => validate({ ...action(), ...changes }, input)).toThrow(/captured target revision/i);
    expect(input).toEqual(before);
  });

  it('cannot create a document or resolve against another target kind or omitted context', () => {
    const input = captured(); delete input.targets[0]!.canvas;
    expect(() => validate(action(), input)).toThrow(/existing canvas/i);
    input.targets[0]!.kind = 'note';
    expect(() => validate(action(), input)).toThrow(/existing canvas/i);
    const full = captured(), prepared = prepareContext(full, 'local'); prepared.targets = [];
    expect(() => validateProposal(output(), full, prepared)).toThrow(/existing canvas/i);
  });

  it('rejects duplicate, missing and foreign block identities atomically', () => {
    const input = captured(), before = structuredClone(input);
    expect(() => validate(action([edit(), edit('writing', [set('body', 'Another')])]), input)).toThrow(/only once/i);
    expect(() => validate(action([edit('missing')]), input)).toThrow(/exactly one existing/i);
    expect(() => validate(action([edit(), edit('missing')]), input)).toThrow(/exactly one existing/i);
    expect(input).toEqual(before);
  });

  it('keeps pins and selected-suggestion scope authoritative', () => {
    expect(() => validate(action([edit('notes')]))).toThrow(/unpin/i);
    const selected: CanvasSuggestion = { ...choice(), prepared: null };
    const input = captured(canvas(undefined, [selected]));
    input.canvasSuggestion = { id: selected.id, canvasRevision: 7, targetBlockId: 'writing' };
    input.intent.text = selected.request;
    expect(validate(action(), input).blocks[0]).toEqual(photo());
    expect(() => validate(action([edit('photo', [set('caption', 'Out of scope')])]), input)).toThrow(/outside its target/i);
  });

  it.each([
    ['unknown envelope field', { document: canvas() }],
    ['metadata override', { title: 'Unrequested title' }],
    ['forged originals', { before: canvas() }],
    ['missing suggestions', { suggestions: undefined }],
    ['invalid suggestions', { suggestions: {} }],
    ['too many edits', { edits: Array.from({ length: 25 }, () => edit()) }],
    ['too many suggestions', { suggestions: Array.from({ length: 7 }, () => choice()) }],
    ['block addition', { edits: [{ type: 'add', block: writing }] }],
    ['nonpatch edit', { edits: [{ ...edit(), type: 'replace' }] }],
  ])('rejects %s', (_name, changes) => {
    expect(() => validate({ ...action(), ...changes })).toThrow(/patch action needs correction/i);
  });

  it('rejects malformed, duplicate and unknown suggestion references through existing normalization', () => {
    expect(() => validate(action([], [null]))).toThrow();
    expect(() => validate(action([], [choice(), choice()]))).toThrow(/own identity/i);
    expect(() => validate(action([], [{ kind: 'keep', id: 'missing' }]))).toThrow(/captured revision/i);
    const saved = validate(action([], [choice()]));
    expect(() => validate(action([], [{ kind: 'keep', id: 'future-title', prepared: null }]), captured(saved))).toThrow(/only its existing/i);
  });

  it('does not bypass resource admission or formula, binding and timer validation', () => {
    expect(() => validate(action([edit('photo', [set('assetId', 'invented')])]))).toThrow(/image.*not attached/i);
    expect(() => validate(action([edit('writing', [set('sourceIds', ['invented'])])]))).toThrow(/source.*not attached/i);
    const table: CanvasBlock = { ...base, id: 'table', kind: 'table', title: 'Counts', columns: ['Count'], rows: [{ id: 'row', cells: ['3'] }] };
    const chart: CanvasBlock = { ...base, id: 'chart', kind: 'chart', title: 'Counts', tableId: 'table', chartType: 'bar', labelColumn: 0, valueColumns: [0] };
    const timer: CanvasBlock = { ...base, id: 'timer', kind: 'timer', title: 'Focus', durationSeconds: 600, remainingSeconds: 600, endsAt: null };
    const input = captured(canvas([table, notes, chart, timer]));
    expect(() => validate(action([edit('table', [{ type: 'set-cell', rowId: 'row', column: 0, value: '=Z9' }])]), input)).toThrow(/formula/i);
    expect(() => validate(action([edit('chart', [set('tableId', 'missing')])]), input)).toThrow(/table in this canvas/i);
    expect(() => validate(action([edit('timer', [set('remainingSeconds', 450)])]), input)).toThrow(/Start button/i);
    const result = validate(action([edit('table', [{ type: 'set-cell', rowId: 'row', column: 0, value: '8' }])]), input);
    expect(result.blocks).toEqual([{ ...table, rows: [{ id: 'row', cells: ['8'] }] }, notes, chart, timer]);
  });

  it('accepts no additional action alongside a normalized canvas patch and never registers PatchCanvas itself', () => {
    const input = captured(), prepared = prepareContext(input, 'local');
    expect(() => validateProposal({ ...output(), actions: [action(), { type: 'Undo' }] }, input, prepared)).toThrow(/one complete operation/i);
    expect(() => validateProposal({ ...output(), actions: [action(), action()] }, input, prepared)).toThrow(/one complete operation/i);
    expect(registeredActionSchema.safeParse(action()).success).toBe(false);
  });
});

describe('contextual PatchCanvas wire schema', () => {
  const branches = (input: AgentRequest) => (prepareContext(input, 'local').input.schema as any).properties.actions.items.anyOf;

  it('offers a strict scoped patch envelope only for an existing admitted canvas', () => {
    const input = captured(), schema = branches(input), patch = schema.find((branch: any) => branch.properties.type.const === 'PatchCanvas');
    expect(schema.map((branch: any) => branch.properties.type.const)).toEqual(['ComposeCanvas', 'PatchCanvas']);
    expect(Object.keys(patch.properties)[0]).toBe('type');
    expect(patch.additionalProperties).toBe(false);
    expect(patch.required).toEqual(['type', 'targetId', 'expectedRevision', 'edits', 'suggestions']);
    expect(patch.properties.targetId.const).toBe('orbit:canvas');
    expect(patch.properties.expectedRevision.const).toBe(7);
    expect(patch.properties.edits.maxItems).toBe(24);
    expect(patch.properties.edits.items.properties.id.enum).toEqual(['photo', 'notes', 'writing']);
    expect(patch.properties.edits.items.properties.type.const).toBe('patch');
    expect(patch.properties.document).toBeUndefined();
    delete input.targets[0]!.canvas;
    expect(branches(input).map((branch: any) => branch.properties.type.const)).toEqual(['ComposeCanvas']);
  });

  it('reuses admitted resource constraints and saved suggestion references in both patch locations', () => {
    const saved = validate(action([], [choice()])), input = captured(saved);
    input.targets[0]!.assets = [];
    const patch = branches(input).find((branch: any) => branch.properties.type.const === 'PatchCanvas');
    const suggestions = patch.properties.suggestions.anyOf.find((branch: any) => branch.type === 'array');
    expect(patch.properties.suggestions.anyOf.some((branch: any) => branch.type === 'null')).toBe(true);
    expect(suggestions.items.anyOf.find((branch: any) => branch.properties.kind?.const === 'keep').properties.id.enum).toEqual(['future-title']);
    // Empty whole-image slots remain available, but inserted design image layers do not.
    const imageBranches: any[] = [];
    const visit = (node: any) => { if (!node || typeof node !== 'object') return; if (node.properties?.kind?.const === 'image') imageBranches.push(node); Object.values(node).forEach(visit); };
    visit(patch);
    expect(imageBranches.length).toBeGreaterThan(0);
    for (const image of imageBranches) { expect(image.properties).toHaveProperty('caption'); expect(image.properties.assetId).toEqual({ type: 'null' }); }
    expect(suggestions.maxItems).toBe(6);
  });

  it('instructs precise proposals, safe composition preservation and truthful missing-image attachment guidance', () => {
    const instructions = prepareContext(captured(), 'local').input.instructions;
    expect(instructions).toContain('prefer {type:"PatchCanvas"');
    expect(instructions).toContain('suggestions=null preserves all saved suggestions and their original preconditions');
    expect(instructions).toContain('Use ComposeCanvas for a new composition');
    expect(instructions).toContain('Choose image or Import image controls, or Add material, can attach the photo first');
    expect(instructions).toContain('say the requested changes are ready for review, not saved or applied');
  });
});
