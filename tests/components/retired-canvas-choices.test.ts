import { describe, expect, it } from 'vitest';
import { retiredCanvasChoices } from '../../apps/desktop/renderer/src/components/retiredCanvasChoices';
import { compileCanvasSuggestion, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/index';

const text = (id: string, body = 'Before same after same end'): Extract<CanvasBlock, { kind: 'text' }> => ({ id, kind: 'text', title: id, body, placement: 'main', pinned: false, sourceIds: [] });
const document = (): CanvasDocument => ({ version: 1, title: 'Authored work', subtitle: '', layout: 'focus', blocks: [text('draft'), text('other')], suggestions: [] });
const selection = { field: 'body' as const, start: 18, end: 22, text: 'same' };
const choice = (id = 'chosen', word = 'clearer'): CanvasSuggestion => ({ id, label: id, description: 'Review wording', request: 'Change only the chosen passage.', targetBlockId: 'draft', textSelection: selection, prepared: { edits: [{ type: 'replace', block: text('draft', `Before same after ${word} end`) }], before: [text('draft')] } });
const legacy = (id: string): CanvasSuggestion => ({ id, label: id, description: 'Saved choice', request: 'A future request', targetBlockId: null });
const before = (extra: CanvasSuggestion[] = []): CanvasDocument => ({ ...document(), suggestions: [choice(), ...extra] });
const after = (initial = before()): CanvasDocument => compileCanvasSuggestion(initial, 'chosen');
const foreignStale = (): CanvasSuggestion => ({ id: 'foreign-stale', label: 'Another heading', description: 'Rename the earlier draft', request: 'Use the earlier heading.', targetBlockId: 'other', prepared: { edits: [{ type: 'replace', block: { ...text('other', 'Earlier body'), title: 'Earlier heading' } }], before: [text('other', 'Earlier body')] } });
const foreignValid = (): CanvasSuggestion => ({ id: 'foreign-valid', label: 'Useful next detail', description: 'Change the other heading', request: 'Change the other heading.', targetBlockId: 'other', prepared: { edits: [{ type: 'replace', block: { ...text('other'), title: 'A new heading' } }], before: [text('other')] } });

describe('explained automatic choice retirement', () => {
  it('returns no extra removals for exact chosen-only consumption with unchanged survivors', () => {
    const initial = before([legacy('whole'), foreignValid()]), result = after(initial);
    expect(retiredCanvasChoices(initial, result, 'chosen')).toEqual([]);
    expect(result.suggestions).toEqual(initial.suggestions!.slice(1));
  });

  it('identifies actual same-range alternatives retired by the shared compiler', () => {
    const initial = before([choice('second', 'shorter'), choice('third', 'different'), legacy('whole')]), result = after(initial);
    const classified = retiredCanvasChoices(initial, result, 'chosen');
    expect(classified).toEqual([
      { suggestion: initial.suggestions![1], reason: expect.stringMatching(/selected text changed/i), target: { id: 'draft', title: 'draft', kind: 'text' } },
      { suggestion: initial.suggestions![2], reason: expect.stringMatching(/selected text changed/i), target: { id: 'draft', title: 'draft', kind: 'text' } },
    ]);
    expect(classified!.some(entry => entry.suggestion.id === 'chosen')).toBe(false);
  });

  it('includes previously stale foreign choices without claiming they only became stale now', () => {
    const stale = foreignStale(), initial = before([stale, foreignValid()]), result = after(initial);
    expect(retiredCanvasChoices(initial, result, 'chosen')).toEqual([{ suggestion: stale, reason: expect.stringMatching(/item.*changed/i), target: { id: 'other', title: 'other', kind: 'text' } }]);
  });

  it('retains original removal order and can identify a whole-canvas retired plan', () => {
    const global: CanvasSuggestion = { ...choice('global', 'new'), targetBlockId: null }; delete global.textSelection;
    const initial = before([global, foreignStale(), choice('sibling')]), result = after(initial);
    const classified = retiredCanvasChoices(initial, result, 'chosen')!;
    expect(classified.map(entry => entry.suggestion.id)).toEqual(['global', 'foreign-stale', 'sibling']);
    expect(classified[0]!.target).toBeNull();
  });

  it('resolves a removed target from the original document for full disclosure', () => {
    const removedTarget = foreignValid(), initial = before([removedTarget]);
    const candidate = { ...after(initial), blocks: [text('draft', 'Before same after clearer end')], suggestions: [] };
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toEqual([{ suggestion: removedTarget, reason: expect.stringMatching(/changed/i), target: { id: 'other', title: 'other', kind: 'text' } }]);
    // This helper classifies metadata only. The caller still rejects compact
    // authored-block removal via its existing block/order/layout guards.
  });

  it('does not mutate either document or saved choices', () => {
    const initial = before([choice('sibling'), foreignStale()]), candidate = after(initial), snapshots = structuredClone([initial, candidate]);
    const result = retiredCanvasChoices(initial, candidate, 'chosen');
    expect([initial, candidate]).toEqual(snapshots);
    expect(result).toHaveLength(2);
  });
});

describe('unexplained metadata changes require full review', () => {
  it('rejects deletion of a still-valid prepared choice', () => {
    const initial = before([foreignValid()]), candidate = { ...after(initial), suggestions: [] };
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toBeNull();
  });

  it('rejects deleted prose choices even if they target changed writing', () => {
    const initial = before([{ ...legacy('prose'), targetBlockId: 'draft' }]), candidate = { ...after(initial), suggestions: [] };
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toBeNull();
  });

  it('falls back for formula-only compiler retirement without evaluating the formula', () => {
    const formula: CanvasSuggestion = { ...legacy('opaque-formula'), prepared: { before: [], edits: [{ type: 'add', block: { id: 'cycle', kind: 'table', title: 'Formula', placement: 'main', pinned: false, sourceIds: [], columns: ['Value'], rows: [{ id: 'row', cells: ['=A1'] }] } }] } };
    const initial = before([formula]), candidate = after(initial);
    expect(candidate.suggestions).toEqual([]); // Compiler can detect this; cheap prerequisite checks cannot.
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toBeNull();
  });

  it.each(['addition', 'reorder', 'label', 'description', 'request', 'target', 'selection', 'before', 'edits'])('rejects %s alongside otherwise explained retirements', mutation => {
    const initial = before([choice('retired'), legacy('whole'), foreignValid()]), candidate = after(initial);
    if (mutation === 'addition') candidate.suggestions!.push(legacy('new'));
    if (mutation === 'reorder') candidate.suggestions!.reverse();
    const retained = candidate.suggestions!.find(choice => choice.id === 'foreign-valid')!;
    if (mutation === 'label') retained.label = 'Changed';
    if (mutation === 'description') retained.description = 'Changed';
    if (mutation === 'request') retained.request = 'Changed';
    if (mutation === 'target') retained.targetBlockId = null;
    if (mutation === 'selection') retained.textSelection = selection;
    if (mutation === 'before') retained.prepared!.before = [text('other', 'New historical original')];
    if (mutation === 'edits') retained.prepared!.edits = [{ type: 'replace', block: text('other', 'Different intent') }];
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toBeNull();
  });

  it.each(['remove and add', 'id substitution'])('rejects same-count %s', mutation => {
    const initial = before([choice('retired'), legacy('whole'), foreignValid()]), candidate = after(initial);
    if (mutation === 'remove and add') candidate.suggestions = [legacy('replacement'), candidate.suggestions![1]!];
    else candidate.suggestions![0]!.id = 'substituted';
    expect(candidate.suggestions).toHaveLength(2);
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toBeNull();
  });

  it('falls back when only full resource validation explains retirement', () => {
    const resource: CanvasSuggestion = { ...legacy('missing-image'), prepared: { before: [], edits: [{ type: 'add', block: { id: 'image', kind: 'image', title: 'Image', placement: 'main', pinned: false, sourceIds: [], assetId: 'unavailable', caption: '' } }] } };
    const initial = before([resource]);
    const candidate = compileCanvasSuggestion(initial, 'chosen', { assetIds: [], sourceIds: [] });
    expect(candidate.suggestions).toEqual([]);
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toBeNull();
  });

  it('treats property order as immaterial while preserving all actual data', () => {
    const initial = before([legacy('whole')]), candidate = after(initial), existing = candidate.suggestions![0]!;
    candidate.suggestions = [{ request: existing.request, description: existing.description, targetBlockId: existing.targetBlockId, label: existing.label, id: existing.id }];
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toEqual([]);
  });

  it('rejects a stale-looking removal with no resolvable target identity', () => {
    const initial = before([{ ...foreignStale(), targetBlockId: 'missing' }]);
    expect(retiredCanvasChoices(initial, { ...document(), suggestions: [] }, 'chosen')).toBeNull();
  });
});

describe('identity and unchanged-effect guards', () => {
  it.each(['missing chosen', 'chosen retained', 'chosen prose', 'duplicate before', 'duplicate after', 'empty before id', 'empty after id', 'missing id', 'long id', 'non-string id', 'duplicate block', 'null entries', 'null list'])('rejects malformed or ambiguous identity: %s', problem => {
    const initial = before([legacy('whole')]), candidate = after(initial);
    let id = 'chosen';
    if (problem === 'missing chosen') id = 'absent';
    if (problem === 'chosen retained') candidate.suggestions!.push(choice());
    if (problem === 'chosen prose') initial.suggestions![0]!.prepared = null;
    if (problem === 'duplicate before') initial.suggestions!.push(choice());
    if (problem === 'duplicate after') candidate.suggestions!.push(legacy('whole'));
    if (problem === 'empty before id') initial.suggestions![1]!.id = '';
    if (problem === 'empty after id') candidate.suggestions![0]!.id = '';
    if (problem === 'missing id') delete (initial.suggestions![1] as any).id;
    if (problem === 'long id') initial.suggestions![1]!.id = 'x'.repeat(129);
    if (problem === 'non-string id') (candidate.suggestions![0] as any).id = 7;
    if (problem === 'duplicate block') candidate.blocks.push(text('draft'));
    if (problem === 'null entries') (initial.suggestions as any[]).push(null);
    if (problem === 'null list') (candidate as any).suggestions = null;
    expect(retiredCanvasChoices(initial, candidate, id)).toBeNull();
  });

  it('returns null when nothing changed and the chosen identity remains', () => {
    const initial = before([foreignStale()]);
    expect(retiredCanvasChoices(initial, structuredClone(initial), 'chosen')).toBeNull();
  });

  it('does not certify an authored effect merely because chosen-only metadata removal is exact', () => {
    const initial = before(), candidate = { ...initial, suggestions: [] };
    expect(retiredCanvasChoices(initial, candidate, 'chosen')).toEqual([]);
    expect(candidate.blocks).toEqual(initial.blocks); // Caller hasChanges remains false.
  });
});
