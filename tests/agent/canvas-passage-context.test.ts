import { describe, expect, it } from 'vitest';
import { passagePromptContext, prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { compileCanvasSuggestion, type CanvasDocument } from '../../packages/contracts/src/index';
import { proposal, request } from './fixtures';
const passage = 'The change may help.';
const original = `First ${passage} Nearby text. ${passage} Last.`;
const block = (id: string, body: string) => ({ kind: 'text' as const, id, title: id, body, placement: 'main' as const, pinned: false, sourceIds: [] as string[] });
function captured(): AgentRequest {
  const canvas: CanvasDocument = { version: 1, title: 'Draft', subtitle: '', layout: 'focus', blocks: [block('draft', original), block('private', 'FOREIGN PRIVATE BODY')], suggestions: [{ id: 'foreign', targetBlockId: 'private', label: 'Old choice', description: 'FOREIGN PRIVATE DESCRIPTION', request: 'FOREIGN PRIVATE REQUEST', prepared: { edits: [{ type: 'replace', block: block('private', 'HISTORICAL PRIVATE') }], before: [block('private', 'OLD PRIVATE')] } }] };
  const input = request({ role: 'prepare', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 2, canvas, assets: [] }], canvasSuggestionRefresh: { targetId: 'orbit:canvas', canvasRevision: 2, scope: { blockId: 'draft', selection: { field: 'body', start: original.lastIndexOf(passage), end: original.lastIndexOf(passage) + passage.length, text: passage } } } });
  delete input.context.selection; return input;
}
const output = (text: string, id = 'fresh') => ({ ...proposal({ basis: 'selection', message: 'A wording option is ready.', citations: [] }), actions: [{ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 2, edits: [], suggestions: [{ id, targetBlockId: 'draft', label: 'Clarify', description: 'Clarify the wording while keeping its uncertainty.', request: 'Clarify only the selected passage.', prepared: { edits: [{ type: 'replace-selection', id: 'draft', text }], arrangement: null } }] }] });

describe('small passage model capability without weaker canonical authority', () => {
  it('does not expose foreign content or historical plans and still preserves them exactly', () => {
    const input = captured(), before = structuredClone(input), prepared = prepareContext(input, 'local');
    expect(prepared.input.data).not.toContain('PRIVATE');
    expect(JSON.parse(prepared.input.data).reservedSuggestionIds).toEqual(['foreign']);
    expect(JSON.parse(prepared.input.data)).toEqual(passagePromptContext(input));
    expect(prepared.input.instructions).not.toContain('Installed blocks');
    expect(JSON.stringify(prepared.input.schema)).not.toContain('ComposeCanvas');
    expect(prepared.input.maxOutputTokens).toBe(1024);
    const canonical = validateProposal(output('The change could be helpful.'), input, prepared).actions[0];
    if (canonical?.type !== 'ComposeCanvas') throw Error();
    expect(canonical.document.blocks).toEqual(input.targets[0]!.canvas!.blocks);
    expect(canonical.document.suggestions![0]).toEqual(input.targets[0]!.canvas!.suggestions![0]);
    const applied = compileCanvasSuggestion(canonical.document, 'fresh');
    expect(applied.blocks[0]).toEqual(block('draft', original.slice(0, original.lastIndexOf(passage)) + 'The change could be helpful. Last.'));
    expect(applied.blocks[1]).toEqual(input.targets[0]!.canvas!.blocks[1]);
    expect(input).toEqual(before);
  });

  it('budgets bounded nearby text independently of a large retained canvas', () => {
    const input = captured();
    for (let index = 0; index < 20; index++) input.targets[0]!.canvas!.blocks.push(block(`unrelated-${index}`, 'PRIVATE'.repeat(3000)));
    const prepared = prepareContext(input, 'local');
    expect(prepared.input.data.length).toBeLessThan(2000);
    expect(prepared.targets[0]!.canvas!.blocks).toHaveLength(22);
    expect(() => passagePromptContext(input, 'local', 100)).toThrow(/budget/);
  });

  it('retains original target revision, scope identity and source admission checks', () => {
    const input = captured(), prepared = prepareContext(input, 'local');
    expect(() => validateProposal(output('Clearer.', 'foreign'), input, prepared)).toThrow(/identity|another|foreign/i);
    const wrong = output('Clearer.'); wrong.actions[0]!.expectedRevision++;
    expect(() => validateProposal(wrong, input, prepared)).toThrow(/captured target/);
    const forged = output('Clearer.') as any; forged.actions[0].suggestions[0].prepared.edits[0].sourceIds = ['hidden'];
    expect(() => validateProposal(forged, input, prepared)).toThrow(/recognized|unknown|invalid|unexpected/i);
  });

  it('accepts no manufactured improvement while preserving current writing and foreign choices', () => {
    const input = captured(), wire = output('The change could help.');
    wire.actions[0]!.suggestions = [];
    const result = validateProposal(wire, input, prepareContext(input, 'local')).actions[0];
    if (result?.type !== 'ComposeCanvas') throw Error();
    expect(result.document).toEqual(input.targets[0]!.canvas);
  });

  it('leaves item-level capabilities broad and only narrows passage model output', () => {
    const input = captured(); delete input.canvasSuggestionRefresh!.scope!.selection;
    const prepared = prepareContext(input, 'local');
    expect(JSON.stringify(prepared.input.schema)).toContain('set-cell');
    expect(prepared.input.instructions).toContain('Installed blocks');
    expect(prepared.input.maxOutputTokens).toBe(3072);
  });
});
