import { describe, expect, it } from 'vitest';
import { canvasArrangementSnapshot, compileCanvasSuggestion, type CanvasBlock, type CanvasDocument } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { proposal, request } from './fixtures';

const text = (id: string): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body: `Original ${id}`, pinned: false, placement: 'main', sourceIds: [] });
const document = (): CanvasDocument => ({ version: 1, title: 'Workspace', subtitle: 'Keep this', layout: 'split', blocks: [text('a'), { ...text('b'), pinned: true, placement: 'aside' }, text('c')], suggestions: [] });
const captured = (canvas = document()): AgentRequest => {
  const input = request({ role: 'prepare', sources: [] }); input.intent.text = 'Prepare the described changes without applying them.';
  input.targets = [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas, assets: [] }]; return input;
};
const choice = (edits: unknown[] = [{ type: 'remove', id: 'a' }], arrangement: unknown = null, targetBlockId: string | null = null) => ({
  id: 'choice', label: 'Review change', description: 'Preview the requested change.', request: 'Make this specific change.', targetBlockId, prepared: { edits, arrangement },
});
const replacement = (id = 'a', title = 'Revised') => ({ type: 'patch', id, changes: [{ type: 'set', target: null, field: 'title', value: title }] });
const validate = (suggestions: unknown, input = captured()): CanvasDocument => {
  const result = validateProposal({ ...proposal({ basis: 'general', citations: [] }), actions: [{ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions }] }, input, prepareContext(input, 'local'));
  const action = result.actions[0]; if (action?.type !== 'ComposeCanvas') throw new Error('Expected a canonical composition'); return action.document;
};

describe('model prepared removal and arrangement', () => {
  it('captures full removal originals and arrangement prerequisites locally, ignoring forged snapshots', () => {
    const selected = choice([{ type: 'remove', id: 'a' }], { layout: 'gallery', order: ['c', 'b'] });
    Object.assign(selected.prepared, { before: [text('forged')], beforeArrangement: { layout: 'focus', blocks: [{ id: 'forged', placement: 'full' }] } });
    const result = validate([selected]);
    expect(result.blocks).toEqual(document().blocks);
    expect(result.suggestions![0]!.prepared).toEqual({ edits: [{ type: 'remove', id: 'a' }], before: [text('a')], arrangement: { layout: 'gallery', order: ['c', 'b'] }, beforeArrangement: canvasArrangementSnapshot(document()) });
    const projected = compileCanvasSuggestion(result, 'choice');
    expect(projected.layout).toBe('gallery'); expect(projected.blocks).toEqual([text('c'), document().blocks[1]]);
  });

  it('supports arrangement-only plans and includes explicit placement patches in atomic plans', () => {
    const pure = validate([choice([], { layout: 'gallery', order: ['c', 'a', 'b'] })]);
    expect(pure.suggestions![0]!.prepared!.before).toEqual([]);
    expect(compileCanvasSuggestion(pure, 'choice').blocks.map(block => block.id)).toEqual(['c', 'a', 'b']);
    const result = validate([choice([{ type: 'patch', id: 'a', changes: [{ type: 'set', target: null, field: 'placement', value: 'full' }] }], { layout: 'focus', order: ['a', 'c', 'b'] }, 'a')]);
    expect(compileCanvasSuggestion(result, 'choice').blocks[0]).toEqual({ ...text('a'), placement: 'full' });
    expect(result.suggestions![0]!.prepared!.beforeArrangement).toEqual(canvasArrangementSnapshot(document()));
  });

  it.each(['null', 'keep', 'full'] as const)('preserves stale arrangement snapshots through %s retention and label edits', mode => {
    const selected = choice([], { layout: 'gallery', order: ['c', 'a', 'b'] });
    const first = validate([selected]), current = structuredClone(first); current.blocks[0]!.placement = 'aside';
    const suggestions = mode === 'null' ? null : mode === 'keep' ? [{ kind: 'keep', id: 'choice' }] : [{ ...selected, label: 'A new label only' }];
    const result = validate(suggestions, captured(current));
    expect(result.suggestions![0]!.prepared).toEqual(first.suggestions![0]!.prepared);
    expect(() => compileCanvasSuggestion(result, 'choice')).toThrow('arrangement changed');
  });

  it.each(['null', 'keep', 'full'] as const)('preserves stale removal originals through %s retention', mode => {
    const selected = choice(), first = validate([selected]), current = structuredClone(first); current.blocks[0] = { ...text('a'), body: 'Later typing' };
    const suggestions = mode === 'null' ? null : mode === 'keep' ? [{ kind: 'keep', id: 'choice' }] : [{ ...selected, label: 'Review removal' }];
    const result = validate(suggestions, captured(current));
    expect(result.suggestions![0]!.prepared!.before).toEqual([text('a')]);
    expect(() => compileCanvasSuggestion(result, 'choice')).toThrow('changed');
  });

  it('does not rebase an unchanged old replacement or removal when the arrangement changes', () => {
    for (const edits of [[replacement()], [{ type: 'remove', id: 'a' }]]) {
      const first = validate([choice(edits)]), current = structuredClone(first); current.blocks[0] = { ...text('a'), body: 'Later typing' };
      const order = edits[0]!.type === 'remove' ? ['c', 'b'] : ['c', 'b', 'a'];
      expect(() => validate([choice(edits, { layout: 'gallery', order })], captured(current))).toThrow('changed');
    }
  });

  it('does not rebase an unchanged edit when a sibling edit changes or is added', () => {
    const first = validate([choice([replacement()])]), current = structuredClone(first); current.blocks[0] = { ...text('a'), body: 'Later typing' };
    expect(() => validate([choice([replacement(), replacement('c')])], captured(current))).toThrow('changed');
    const originalRemove = validate([choice()]), changedRemove = structuredClone(originalRemove); changedRemove.blocks[0] = { ...text('a'), body: 'Later typing' };
    expect(() => validate([choice([{ type: 'remove', id: 'a' }, replacement('c')])], captured(changedRemove))).toThrow('changed');
  });

  it('does not rebase an unchanged arrangement when the block edits change', () => {
    const arrangement = { layout: 'gallery', order: ['c', 'b', 'a'] };
    const first = validate([choice([], arrangement)]), current = structuredClone(first); current.layout = 'focus';
    expect(() => validate([choice([replacement('c')], arrangement)], captured(current))).toThrow('arrangement changed');
  });

  it('captures current prerequisites for genuinely changed individual intentions', () => {
    const first = validate([choice([replacement()])]), current = structuredClone(first); current.blocks[0] = { ...text('a'), body: 'Later typing' };
    const result = validate([choice([replacement('a', 'Another title')], { layout: 'gallery', order: ['c', 'b', 'a'] })], captured(current));
    expect(result.suggestions![0]!.prepared!.before).toEqual([current.blocks[0]]);
    expect(result.suggestions![0]!.prepared!.beforeArrangement).toEqual(canvasArrangementSnapshot(current));
    expect(compileCanvasSuggestion(result, 'choice').blocks.at(-1)).toEqual({ ...current.blocks[0], title: 'Another title' });
  });

  it('preserves legacy absent arrangement keys and original snapshot ordering on unchanged plans', () => {
    const first = validate([choice([replacement(), replacement('c')])]);
    const plan = first.suggestions![0]!.prepared!; delete plan.arrangement; plan.before.reverse();
    const result = validate([choice([replacement(), replacement('c')])], captured(first));
    expect(result.suggestions![0]!.prepared).toEqual(plan);
    expect(Object.hasOwn(result.suggestions![0]!.prepared!, 'arrangement')).toBe(false);
  });

  it.each([
    ['pinned removal', () => choice([{ type: 'remove', id: 'b' }]), /Unpin/i],
    ['foreign target', () => choice([{ type: 'remove', id: 'c' }], null, 'a'), /outside/i],
    ['missing removal', () => choice([{ type: 'remove', id: 'missing' }]), /original/i],
    ['duplicate identities', () => choice([{ type: 'remove', id: 'a' }, replacement()]), /only once/i],
    ['arrangement no-op', () => choice([], { layout: 'split', order: ['a', 'b', 'c'] }), /unchanged/i],
    ['empty plan', () => choice([], null), /edit or an arrangement/i],
    ['invalid final order', () => choice([{ type: 'remove', id: 'a' }], { layout: 'gallery', order: ['a', 'b', 'c'] }), /every resulting/i],
  ] as const)('retains authoritative rejection for %s', (_name, selected, error) => {
    expect(() => validate([selected()])).toThrow(error);
  });

  it('keeps arrangement-only plans valid after ordinary current writing changes', () => {
    const selected = choice([], { layout: 'gallery', order: ['c', 'b', 'a'] }), first = validate([selected]), current = structuredClone(first);
    current.blocks[0] = { ...text('a'), body: 'Later writing' };
    expect(compileCanvasSuggestion(validate([selected], captured(current)), 'choice').blocks.at(-1)).toEqual(current.blocks[0]);
  });
});

describe('removal and arrangement wire transport', () => {
  it('transmits desired operations only, without local removal or arrangement snapshots', () => {
    const saved = validate([choice([{ type: 'remove', id: 'a' }], { layout: 'gallery', order: ['c', 'b'] })]);
    const { input } = prepareContext(captured(saved), 'local');
    const plan = JSON.parse(input.data).targets[0].canvas.suggestions[0].prepared;
    expect(plan).toEqual({ edits: [{ type: 'remove', id: 'a' }], arrangement: { layout: 'gallery', order: ['c', 'b'] } });
    expect(plan).not.toHaveProperty('before'); expect(plan).not.toHaveProperty('beforeArrangement');
    const schema = input.schema as any;
    const compose = schema.properties.actions.items.anyOf.find((branch: any) => branch.properties.type.const === 'ComposeCanvas');
    const suggestion = compose.properties.document.properties.suggestions.items.anyOf.find((branch: any) => branch.properties.prepared);
    const wirePlan = suggestion.properties.prepared.anyOf.find((branch: any) => branch.properties?.edits);
    expect(wirePlan.required).toEqual(['edits', 'arrangement']);
    expect(wirePlan.properties).not.toHaveProperty('beforeArrangement');
    const removal = wirePlan.properties.edits.items.anyOf.find((branch: any) => branch.properties.type.const === 'remove');
    expect(removal.required).toEqual(['type', 'id']); expect(removal.additionalProperties).toBe(false);
    expect(wirePlan.properties.arrangement.anyOf.some((branch: any) => branch.type === 'null')).toBe(true);
    expect(input.instructions).toContain('every remaining and added block exactly once');
    expect(input.instructions).not.toContain('null is for add-only plans');
  });
});
