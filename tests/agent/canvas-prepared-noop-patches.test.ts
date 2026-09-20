import { describe, expect, it } from 'vitest';
import { compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { proposal, request } from './fixtures';

const text = (id: string, body = `Authored ${id}`): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body, placement: 'main', pinned: false, sourceIds: [] });
const canvas = (blocks: CanvasBlock[] = [text('draft'), text('context')], suggestions: CanvasSuggestion[] = []): CanvasDocument => ({ version: 1, title: 'Preserve my work', subtitle: 'Preserve this too', layout: 'split', blocks, suggestions });
const captured = (document = canvas(), refresh = false): AgentRequest => {
  const input = request({ role: 'prepare', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas: document, assets: [] }] });
  input.intent.text = 'Prepare useful choices without changing the current work.';
  if (refresh) input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
  return input;
};
const set = (field: string, value: unknown, target: unknown = null) => ({ type: 'set', target, field, value });
const patch = (id: string, changes: unknown[]) => ({ type: 'patch', id, changes });
const unchanged = () => patch('context', [set('body', text('context').body)]);
const changed = () => patch('draft', [set('title', 'Proposed heading')]);
const add = () => ({ type: 'add', block: { ...text('next'), body: 'A concrete proposed question.' } });
const choice = (edits: unknown[], targetBlockId: string | null = 'draft', arrangement: unknown = null) => ({ id: 'next-choice', label: 'Review the next step', description: 'Preview the actual change.', request: 'Prepare this change while retaining other work.', targetBlockId, prepared: { edits, arrangement } });
const refreshAction = (suggestions: unknown[], edits: unknown[] = []) => ({ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits, suggestions });
const resultOf = (action: unknown, input = captured()): CanvasDocument => {
  const output = { ...proposal({ basis: 'general', citations: [] }), actions: [action] };
  const result = validateProposal(output, input, prepareContext(input, 'local'));
  expect(result.actions).toHaveLength(1);
  const canonical = result.actions[0];
  if (canonical?.type !== 'ComposeCanvas') throw new Error('Expected one canonical canvas action');
  return canonical.document;
};
const validate = (suggestions: unknown[], input = captured()) => resultOf(refreshAction(suggestions), input);

describe('prepared wire preservation patches', () => {
  it('normalizes multiple useful refresh alternatives without saving redundant replacement edits', () => {
    const input = captured(canvas(), true);
    const choices = [choice([changed(), unchanged()]), { ...choice([add(), unchanged()], null), id: 'add-question' }];
    const wire = refreshAction(choices), originalWire = structuredClone(wire), originalInput = structuredClone(input);
    const result = resultOf(wire, input);
    expect({ ...result, suggestions: [] }).toEqual(canvas());
    expect(result.suggestions![0]!.prepared).toEqual({ edits: [{ type: 'replace', block: { ...text('draft'), title: 'Proposed heading' } }], before: [text('draft')], arrangement: null });
    expect(result.suggestions![1]!.prepared).toEqual({ edits: [add()], before: [], arrangement: null });
    expect(compileCanvasSuggestion(result, 'next-choice').blocks).toEqual([{ ...text('draft'), title: 'Proposed heading' }, text('context')]);
    expect(compileCanvasSuggestion(result, 'add-question').blocks).toEqual([...canvas().blocks, add().block]);
    expect(wire).toEqual(originalWire);
    expect(input).toEqual(originalInput);
    result.suggestions![0]!.prepared!.before[0]!.title = 'Mutated returned copy';
    expect(input).toEqual(originalInput);
  });

  it('normalizes a no-op sibling in ComposeCanvas suggestions as well as PatchCanvas transport', () => {
    const result = resultOf({ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 7, document: { ...canvas(), blocks: canvas().blocks.map(block => ({ kind: 'keep', id: block.id })), suggestions: [choice([unchanged(), changed()])] } });
    expect(result.suggestions![0]!.prepared!.edits).toEqual([{ type: 'replace', block: { ...text('draft'), title: 'Proposed heading' } }]);
    expect(result.suggestions![0]!.prepared!.before).toEqual([text('draft')]);
  });

  it('compares against the resulting composition after an authorized current edit', () => {
    const currentBody = 'An authorized current revision';
    const result = resultOf(refreshAction([choice([changed(), patch('context', [set('body', currentBody)])])], [patch('context', [set('body', currentBody)])]));
    expect(result.blocks).toEqual([text('draft'), text('context', currentBody)]);
    expect(result.suggestions![0]!.prepared!.edits).toHaveLength(1);
    expect(result.suggestions![0]!.prepared!.before).toEqual([text('draft')]);
  });

  it('keeps an effectful removal while dropping only the unchanged sibling', () => {
    const result = validate([choice([{ type: 'remove', id: 'draft' }, unchanged()])]);
    expect(result.suggestions![0]!.prepared!.edits).toEqual([{ type: 'remove', id: 'draft' }]);
    expect(result.suggestions![0]!.prepared!.before).toEqual([text('draft')]);
    expect(compileCanvasSuggestion(result, 'next-choice').blocks).toEqual([text('context')]);
  });

  it('allows an effectful arrangement to remain after all preservation patches disappear', () => {
    const arrangement = { layout: 'gallery', order: ['context', 'draft'] };
    const result = validate([choice([unchanged()], null, arrangement)]);
    expect(result.suggestions![0]!.prepared).toEqual({ edits: [], before: [], arrangement, beforeArrangement: { layout: 'split', blocks: [{ id: 'draft', placement: 'main' }, { id: 'context', placement: 'main' }] } });
    expect(compileCanvasSuggestion(result, 'next-choice')).toMatchObject({ layout: 'gallery', blocks: [text('context'), text('draft')] });
  });

  it.each([null, { layout: 'split', order: ['draft', 'context'] }])('still rejects a wholly no-op plan with arrangement %j', arrangement => {
    expect(() => validate([choice([unchanged()], null, arrangement)])).toThrow();
  });

  it.each(['PatchCanvas', 'ComposeCanvas'])('does not relax the direct %s no-op policy', type => {
    const action = type === 'PatchCanvas' ? refreshAction([], [unchanged()]) : { type, targetId: 'orbit:canvas', expectedRevision: 7, document: { ...canvas(), blocks: [{ kind: 'keep', id: 'draft' }, { kind: 'patch', id: 'context', changes: unchanged().changes }] } };
    expect(() => resultOf(action)).toThrow(/does not change/i);
  });
});

describe('no-op classification cannot launder invalid authority', () => {
  it.each([
    ['unknown path', patch('context', [{ ...set('body', text('context').body), path: 'body' }])],
    ['unsupported field', patch('context', [set('id', 'context')])],
    ['wrong kind field', patch('context', [set('caption', '')])],
    ['missing block', patch('missing', [set('title', 'missing')])],
    ['missing collection entry', patch('context', [set('text', '', { collection: 'layers', id: 'missing' })])],
    ['duplicate field write', patch('context', [set('body', text('context').body), set('body', text('context').body)])],
    ['unknown patch field', { ...unchanged(), pinned: false }],
    ['invalid final field value', patch('context', [set('body', null)])],
  ])('rejects %s alongside an effectful alternative', (_name, invalid) => {
    const input = captured(), before = structuredClone(input);
    expect(() => validate([choice([add(), invalid], null)], input)).toThrow();
    expect(input).toEqual(before);
  });

  it('checks pins even when the proposed field value is unchanged', () => {
    const input = captured(canvas([text('draft'), { ...text('context'), pinned: true }]));
    expect(() => validate([choice([add(), unchanged()], null)], input)).toThrow(/unpin|pinned/i);
  });

  it.each([
    [unchanged(), unchanged()],
    [unchanged(), patch('context', [set('title', 'Changed context')])],
    [unchanged(), { type: 'remove', id: 'context' }],
  ])('rejects duplicate block identities before redundant edits are removed', (first, second) => {
    expect(() => validate([choice([add(), first, second], null)])).toThrow(/once|duplicate/i);
  });

  it('does not use normalization to hide an oversized wire plan', () => {
    const extraBlocks = [text('extra-1'), text('extra-2'), text('extra-3')], document = canvas([...canvas().blocks, ...extraBlocks]);
    const edits = [add(), unchanged(), ...extraBlocks.map(block => patch(block.id, [set('body', block.body)]))];
    const input = captured(document);
    expect(() => validate([choice(edits, null)], input)).toThrow();
    expect(() => resultOf({ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 7, document: { ...document, suggestions: [choice(edits, null)] } }, input)).toThrow();
  });

  it('still rejects an effectful sibling outside a selected plan target', () => {
    expect(() => validate([choice([patch('context', [set('body', 'Outside target')]), patch('draft', [set('body', text('draft').body)])], 'draft')])).toThrow(/target/i);
  });

  it.each(['invented', 'existing-hidden'])('does not skip an unadmitted source write: %s', sourceId => {
    const current = { ...text('context'), sourceIds: sourceId === 'existing-hidden' ? [sourceId] : [] };
    expect(() => validate([choice([add(), patch('context', [set('sourceIds', [sourceId])])], null)], captured(canvas([text('draft'), current])))).toThrow(/source.*not attached|source.*not admitted/i);
  });

  it.each(['invented', 'existing-hidden'])('does not skip an unadmitted image identity write: %s', assetId => {
    const current: CanvasBlock = { id: 'photo', kind: 'image', title: 'Photo', placement: 'aside', pinned: false, sourceIds: [], assetId: assetId === 'existing-hidden' ? assetId : null, caption: '' };
    expect(() => validate([choice([add(), patch('photo', [set('assetId', assetId)])], null)], captured(canvas([text('draft'), current])))).toThrow(/image.*not attached|image.*not admitted/i);
  });

  it('permits preserving an omitted existing source when the no-op does not write resource identities', () => {
    const context = { ...text('context'), sourceIds: ['existing-hidden'] };
    const result = validate([choice([add(), unchanged()], null)], captured(canvas([text('draft'), context])));
    expect(result.blocks[1]).toEqual(context);
    expect(result.suggestions![0]!.prepared!.edits).toEqual([add()]);
  });

  it('does not skip an invalid source write inside an otherwise effectful block patch', () => {
    expect(() => validate([choice([patch('draft', [set('title', 'Proposed heading'), set('sourceIds', ['invented'])]), unchanged()])])).toThrow(/source.*not attached|source.*not admitted/i);
  });

  it('checks an explicit unadmitted nested-image write even when its value is unchanged', () => {
    const design: CanvasBlock = { id: 'design', kind: 'design', title: 'Authored artwork', placement: 'aside', pinned: false, sourceIds: [], width: 400, height: 300, background: '#ffffff', layers: [{ id: 'photo-layer', kind: 'image', name: 'Original', x: 0, y: 0, width: 400, height: 300, assetId: 'existing-hidden', fit: 'contain' }] };
    const input = captured(canvas([text('draft'), design]));
    expect(() => validate([choice([add(), patch('design', [set('assetId', 'existing-hidden', { collection: 'layers', id: 'photo-layer' })])], null)], input)).toThrow(/image.*not attached|image.*not admitted/i);
  });

  it('does not broaden normalization to unchanged complete canonical replacement edits', () => {
    expect(() => validate([choice([add(), { type: 'replace', block: text('context') }], null)])).toThrow(/unchanged|does not change/i);
  });
});

describe('saved intentions retain their original authority after no-op normalization', () => {
  const saved = (): CanvasSuggestion => ({ ...choice([], 'draft'), prepared: { edits: [{ type: 'replace', block: { ...text('draft'), title: 'Proposed heading' } }], before: [text('draft')], arrangement: null } });

  it.each([false, true])('adding/removing no-op siblings cannot rebase an unchanged saved edit (sibling: %s)', withSibling => {
    const previous = saved(), current = text('draft', 'Later authored writing');
    const input = captured(canvas([current, text('context')], [previous]));
    const wire = { ...choice([changed(), ...(withSibling ? [unchanged()] : [])]), label: 'A new label for the same old plan' };
    const result = validate([wire], input);
    expect(result.blocks[0]).toEqual(current);
    expect(result.suggestions![0]!.prepared).toEqual(previous.prepared);
    expect(() => compileCanvasSuggestion(result, previous.id)).toThrow(/changed/i);
    input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
    expect(() => validate([wire], input)).toThrow(/changed/i);
  });

  it('does not erase an old effect merely because later authored work now equals its proposed result', () => {
    const previous = saved(), current = { ...text('draft'), title: 'Proposed heading' };
    const input = captured(canvas([current, text('context')], [previous]));
    const result = validate([choice([changed(), unchanged()])], input);
    expect(result.suggestions![0]!.prepared).toEqual(previous.prepared);
    expect(() => compileCanvasSuggestion(result, previous.id)).toThrow(/changed/i);
    input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
    expect(() => validate([choice([changed(), unchanged()])], input)).toThrow(/changed/i);
  });

  it('cannot make a stale existing intention fresh by combining it with a new actual effect', () => {
    const previous = { ...saved(), targetBlockId: null };
    const input = captured(canvas([text('draft', 'Later authored writing'), text('context')], [previous]));
    expect(() => validate([choice([changed(), add(), unchanged()], null)], input)).toThrow(/changed/i);
  });

  it('retains a stale arrangement prerequisite after a redundant patch disappears', () => {
    const arrangement = { layout: 'gallery' as const, order: ['context', 'draft'] };
    const previous: CanvasSuggestion = { ...choice([], null), prepared: { edits: [], before: [], arrangement, beforeArrangement: { layout: 'split', blocks: [{ id: 'draft', placement: 'main' }, { id: 'context', placement: 'main' }] } } };
    const document = { ...canvas(undefined, [previous]), layout: 'focus' as const };
    const input = captured(document);
    const result = validate([choice([unchanged()], null, arrangement)], input);
    expect(result.suggestions![0]!.prepared).toEqual(previous.prepared);
    expect(() => compileCanvasSuggestion(result, previous.id)).toThrow(/arrangement changed/i);
    input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
    expect(() => validate([choice([unchanged()], null, arrangement)], input)).toThrow(/arrangement changed/i);
  });
});
