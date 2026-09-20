import { describe, expect, it } from 'vitest';
import { agentRequestSchema, canvasSuggestionRefreshIsCurrent, prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion, type CanvasSuggestionRefreshScope } from '../../packages/contracts/src/index';
import { proposal, request } from './fixtures';

const text = (id: string, body = 'Start same middle same end'): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body, placement: 'main', pinned: false, sourceIds: [] });
const document = (): CanvasDocument => ({ version: 1, title: 'Current work', subtitle: 'Preserve me', layout: 'focus', blocks: [text('draft'), text('other')], suggestions: [] });
const selection = { field: 'body' as const, start: 18, end: 22, text: 'same' };
const scope = (): CanvasSuggestionRefreshScope => ({ blockId: 'draft', selection: { ...selection } });
const captured = (canvas = document(), selected: CanvasSuggestionRefreshScope = scope()): AgentRequest => {
  const input = request({ role: 'prepare', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas, assets: [] }], canvasSuggestionRefresh: { targetId: 'orbit:canvas', canvasRevision: 7, scope: selected } });
  delete input.context.selection;
  input.intent.text = 'Suggest useful next steps for this passage without changing my work.';
  return input;
};
const wireChoice = (id = 'clarify', body = 'Start same middle clearer end') => ({ id, targetBlockId: 'draft', label: 'Clarify this passage', description: 'Review a wording change.', request: 'Clarify this passage only.', prepared: { edits: [{ type: 'patch', id: 'draft', changes: [{ type: 'set', target: null, field: 'body', value: body }] }], arrangement: null } });
const wireOutput = (suggestions: unknown[], basis = 'general') => ({ ...proposal({ basis: 'general', citations: [], message: 'Here are choices for review.' }), basis, actions: [{ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions }] });
const validate = (choices: unknown[] = [wireChoice()], input = captured(), basis = 'general') => {
  const result = validateProposal(wireOutput(choices, basis), input, prepareContext(input, 'local'));
  const action = result.actions[0]; if (action?.type !== 'ComposeCanvas') throw new Error('Expected canonical canvas');
  return action.document;
};
const legacy = (id: string, targetBlockId: string | null = null): CanvasSuggestion => ({ id, targetBlockId, label: id, description: 'Retained', request: 'Retained' });
const saved = (): CanvasSuggestion => ({ ...wireChoice(), textSelection: { ...selection }, prepared: { edits: [{ type: 'replace', block: text('draft', 'Start same middle clearer end') }], before: [text('draft')] } });

describe('scoped refresh binding and wire capability', () => {
  it('binds an exact captured range and permits truthful selection basis without workbench selection', () => {
    const input = captured(); expect(input.context.selection).toBeUndefined();
    expect(agentRequestSchema.safeParse(input).success).toBe(true);
    expect(canvasSuggestionRefreshIsCurrent(input)).toBe(true);
    const canonical = validate([wireChoice()], input, 'selection');
    expect(canonical.suggestions![0]!.textSelection).toEqual(selection);
    expect({ ...canonical, suggestions: [] }).toEqual(document());
    expect(compileCanvasSuggestion(canonical, 'clarify').blocks[0]).toEqual(text('draft', 'Start same middle clearer end'));
  });

  it.each(['missing', 'pinned', 'range', 'text', 'collapsed', 'fraction', 'wrong field', 'non-text', 'surrogate'])('rejects invalid scope %s before inference', issue => {
    const input = captured(), selected = input.canvasSuggestionRefresh!.scope!;
    if (issue === 'missing') selected.blockId = 'absent';
    if (issue === 'pinned') input.targets[0]!.canvas!.blocks[0]!.pinned = true;
    if (issue === 'range') selected.selection!.end = 500;
    if (issue === 'text') selected.selection!.text = 'xxxx';
    if (issue === 'collapsed') selected.selection!.end = selected.selection!.start;
    if (issue === 'fraction') selected.selection!.start = 18.5;
    if (issue === 'wrong field') (selected.selection as any).field = 'title';
    if (issue === 'non-text') input.targets[0]!.canvas!.blocks[0] = { id: 'draft', kind: 'checklist', title: 'draft', placement: 'main', sourceIds: [], pinned: false, items: [] };
    if (issue === 'surrogate') { input.targets[0]!.canvas!.blocks[0] = text('draft', 'A😀B'); selected.selection = { field: 'body', start: 1, end: 2, text: '\ud83d' }; }
    expect(canvasSuggestionRefreshIsCurrent(input)).toBe(false);
    expect(() => prepareContext(input, 'local')).toThrow(/captured canvas revision/i);
  });

  it('scopes the generated schema to at most one prepared choice, without writable selection authority', () => {
    const prepared = prepareContext(captured(), 'local'), schema = prepared.input.schema as any;
    const choices = schema.properties.actions.items.anyOf[0].properties.suggestions;
    expect(choices.maxItems).toBe(1);
    expect(choices.items.properties.targetBlockId.const).toBe('draft');
    expect(choices.items.properties.prepared.type).toBe('object');
    expect(choices.items.properties.prepared.properties.arrangement).toEqual({ type: 'null' });
    expect(choices.items.properties.prepared.properties.edits.items.properties.type.const).toBe('replace-selection');
    expect(JSON.stringify(schema)).not.toContain('textSelection');
    expect(schema.properties.basis.enum).toContain('selection');
    expect(JSON.parse(prepared.input.data).canvasSuggestionRefresh.scope).toEqual(scope());
  });

  it('does not authorize selection basis for an item-only refresh', () => {
    const input = captured(document(), { blockId: 'draft' });
    expect(() => validate([wireChoice()], input, 'selection')).toThrow(/unavailable selection/i);
  });
});

describe('scoped bucket merging and retained authority', () => {
  it('copies foreign legacy and stale prepared choices exactly without requiring their old resources', () => {
    const canvas = document(), foreign: CanvasSuggestion = { ...saved(), id: 'foreign-stale', targetBlockId: 'other', prepared: { edits: [{ type: 'replace', block: { ...text('other', 'Prepared old writing'), sourceIds: ['local-only'] } }], before: [text('other', 'Historical original')] } };
    delete foreign.textSelection;
    canvas.suggestions = [legacy('whole'), foreign, legacy('local-old', 'draft')];
    const input = captured(canvas), snapshot = structuredClone(input), output = validate([wireChoice()], input);
    expect(output.suggestions!.slice(0, 2)).toEqual(canvas.suggestions.slice(0, 2));
    expect(output.suggestions!.map(choice => choice.id)).toEqual(['whole', 'foreign-stale', 'clarify']);
    expect(input).toEqual(snapshot);
  });

  it('allows an empty scoped bucket without clearing unrelated choices', () => {
    const canvas = document(); canvas.suggestions = [legacy('whole'), legacy('old', 'draft')];
    expect(validate([], captured(canvas)).suggestions).toEqual([legacy('whole')]);
  });

  it.each(['foreign target', 'whole target', 'foreign keep', 'foreign identity', 'prose only', 'duplicate identity', 'four choices'])('rejects scoped output %s', issue => {
    const canvas = document(); canvas.suggestions = [legacy('foreign', 'other')];
    let choices: unknown[] = [wireChoice()];
    if (issue === 'foreign target') choices = [{ ...wireChoice(), targetBlockId: 'other' }];
    if (issue === 'whole target') choices = [{ ...wireChoice(), targetBlockId: null }];
    if (issue === 'foreign keep') choices = [{ kind: 'keep', id: 'foreign' }];
    if (issue === 'foreign identity') choices = [wireChoice('foreign')];
    if (issue === 'prose only') choices = [{ ...wireChoice(), prepared: null }];
    if (issue === 'duplicate identity') choices = [wireChoice(), wireChoice()];
    if (issue === 'four choices') choices = Array.from({ length: 4 }, (_, index) => wireChoice(`choice-${index}`));
    expect(() => validate(choices, captured(canvas))).toThrow();
  });

  it('honors reduced and zero capacity without discarding foreign choices', () => {
    const canvas = document(); canvas.suggestions = Array.from({ length: 23 }, (_, index) => legacy(`foreign-${index}`));
    const input = captured(canvas), schema = prepareContext(input, 'local').input.schema as any;
    expect(schema.properties.actions.items.anyOf[0].properties.suggestions.maxItems).toBe(1);
    expect(validate([wireChoice()], input).suggestions).toHaveLength(24);
    expect(() => validate([wireChoice(), wireChoice('second')], input)).toThrow(/at most one/i);
    canvas.suggestions.push(legacy('last'));
    expect(validate([], captured(canvas)).suggestions).toEqual(canvas.suggestions);
    expect(() => validate([wireChoice()], captured(canvas))).toThrow(/no room/i);
  });

  it('can preserve a full saved collection on ordinary PatchCanvas but still limits model-written lists', () => {
    const canvas = document(); canvas.suggestions = Array.from({ length: 24 }, (_, index) => legacy(`old-${index}`));
    const input = captured(canvas); delete input.canvasSuggestionRefresh;
    const output = wireOutput([]); (output.actions[0] as any).suggestions = null;
    expect(validateProposal(output, input, prepareContext(input, 'local')).actions[0]).toMatchObject({ document: { suggestions: canvas.suggestions } });
    const compose = { ...output, actions: [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 7, document: canvas }] };
    expect(() => validateProposal(compose, input, prepareContext(input, 'local'))).toThrow(/at most six/i);
  });

  it('preserves exact historical scope and originals across keep references and same-plan patches', () => {
    const canvas = document(); canvas.suggestions = [saved()];
    expect(validate([{ kind: 'keep', id: 'clarify' }], captured(canvas)).suggestions).toEqual(canvas.suggestions);
    expect(validate([wireChoice()], captured(canvas)).suggestions).toEqual(canvas.suggestions);
    canvas.blocks[0] = text('draft', 'Start same middle same end with later typing');
    expect(() => validate([wireChoice()], captured(canvas))).toThrow(/changed/i);
    const itemInput = captured(canvas, { blockId: 'draft' });
    expect(() => validate([{ kind: 'keep', id: 'clarify' }], itemInput)).toThrow(/changed/i);
  });

  it('requires a new identity for another occurrence of the same quote', () => {
    const canvas = document(); canvas.suggestions = [saved()];
    const different = { blockId: 'draft', selection: { field: 'body' as const, start: 6, end: 10, text: 'same' } };
    expect(() => validate([wireChoice('clarify', 'Start clearer middle same end')], captured(canvas, different))).toThrow(/different text selection/i);
    expect(validate([wireChoice('fresh', 'Start clearer middle same end')], captured(canvas, different)).suggestions![0]!.textSelection).toEqual(different.selection);
  });

  it('hides historical selected quotes and snapshots while exposing only the current range', () => {
    const canvas = document(), stale = saved(); stale.textSelection = { field: 'body', start: 0, end: 16, text: 'SECRET_OLD_QUOTE' };
    stale.prepared!.before = [text('draft', 'SECRET_OLD_QUOTE')]; canvas.suggestions = [stale];
    const prepared = prepareContext(captured(canvas), 'local');
    expect(prepared.input.data).not.toContain('SECRET_OLD_QUOTE');
    expect(prepared.input.data).not.toContain('textSelection');
    expect(JSON.parse(prepared.input.data).canvasSuggestionRefresh.scope.selection).toEqual(selection);
  });
});

describe('prepared effects remain restricted to the selected text', () => {
  it.each(['prefix', 'title', 'remove', 'arrangement', 'foreign patch', 'unadmitted source', 'unadmitted image'])('rejects %s despite a scoped envelope', issue => {
    const choice: any = wireChoice();
    if (issue === 'prefix') choice.prepared.edits[0].changes[0].value = 'Changed same middle clearer end';
    if (issue === 'title') choice.prepared.edits[0].changes = [{ type: 'set', target: null, field: 'title', value: 'New title' }];
    if (issue === 'remove') choice.prepared.edits = [{ type: 'remove', id: 'draft' }];
    if (issue === 'arrangement') choice.prepared.arrangement = { layout: 'split', order: ['draft', 'other'] };
    if (issue === 'foreign patch') choice.prepared.edits[0].id = 'other';
    if (issue === 'unadmitted source') choice.prepared.edits = [{ type: 'add', block: { ...text('new'), sourceIds: ['forged'] } }];
    if (issue === 'unadmitted image') choice.prepared.edits = [{ type: 'add', block: { id: 'new', kind: 'image', title: 'Image', assetId: 'forged', caption: '', placement: 'aside', pinned: false, sourceIds: [] } }];
    expect(() => validate([choice])).toThrow();
  });

  it('discards forged provider selection data and tests effects against the trusted range', () => {
    const forged = { ...wireChoice(), textSelection: { field: 'body', start: 0, end: 26, text: 'Start same middle same end' } };
    expect(validate([forged]).suggestions![0]!.textSelection).toEqual(selection);
    forged.prepared.edits[0]!.changes[0]!.value = 'Replaced everything';
    expect(() => validate([forged])).toThrow(/outside the selection/i);
  });

  it('permits prepared supporting content while item-only choices retain ordinary prepared scope', () => {
    const addition = { ...wireChoice(), prepared: { edits: [{ type: 'add', block: text('questions', 'What does this passage need to establish?') }], arrangement: null } };
    expect(compileCanvasSuggestion(validate([addition]), 'clarify').blocks).toHaveLength(3);
    const title = wireChoice(); title.prepared.edits[0]!.changes = [{ type: 'set', target: null, field: 'title', value: 'A clearer title' }];
    const result = validate([title], captured(document(), { blockId: 'draft' }));
    expect(result.suggestions![0]).not.toHaveProperty('textSelection');
    expect(compileCanvasSuggestion(result, 'clarify').blocks[0]!.title).toBe('A clearer title');
  });
});
