import { describe, expect, it } from 'vitest';
import { prepareContext, validateProposal } from '../../packages/agent/src/context';
import type { AgentRequest } from '../../packages/agent/src/contracts';
import type { CanvasBlock } from '../../packages/contracts/src/index';

const text = (id: string, sourceIds: string[] = []): CanvasBlock => ({ id, kind: 'text', title: id, body: 'Authored observation.', placement: 'main', pinned: false, sourceIds });
const blank = { id: 'questions', kind: 'checklist', title: 'Questions to explore', placement: 'aside', pinned: false, sourceIds: [], items: [] };
function captured(): AgentRequest {
  const ids = Array.from({ length: 9 }, (_, i) => `reference-${i + 1}`);
  return {
    intent: { id: 'refresh', taskId: 'collection', taskEpoch: 1, contextSnapshotId: 'context', generation: 1, inputModality: 'typed', text: 'Suggest useful next steps without changing my work.' },
    context: { id: 'context', taskId: 'collection', taskEpoch: 1, createdAt: 1 },
    purpose: 'Synthetic reference collection', policy: 'hybrid', priority: 'foreground', role: 'prepare',
    sources: ids.map(id => ({ id, title: id, uri: `https://example.org/${id}`, excerpt: `Attached fixture ${id}`, provenance: 'attached', retrievedAt: 1, exposure: 'cloud-allowed' })),
    targets: [{ id: 'collection:canvas', kind: 'canvas', revision: 4, assets: [], canvas: { version: 1, title: 'Reference collection', subtitle: 'Exact user subtitle', layout: 'focus', blocks: ids.map(id => text(`note-${id}`, [id])), suggestions: [] } }],
    canvasSuggestionRefresh: { targetId: 'collection:canvas', canvasRevision: 4 },
  };
}
function output(edits: unknown[] = [{ type: 'add', block: blank }], targetBlockId: string | null = null) {
  return { version: 1, message: 'A useful choice to consider.', basis: 'general', citations: [], needsClarification: false, actions: [{
    type: 'PatchCanvas', targetId: 'collection:canvas', expectedRevision: 4, edits: [], suggestions: [{
      id: 'next', label: 'Prepare the next step', description: 'A future change for review.', request: 'Prepare a useful next change; keep unrelated work.', targetBlockId,
      prepared: { edits, arrangement: null },
    }],
  }] };
}
function validated(input: AgentRequest, kind: 'local' | 'cloud' = 'local', response = output()) {
  const prepared = prepareContext(input, kind);
  const result = validateProposal(response, input, prepared);
  const action = result.actions[0];
  if (action?.type !== 'ComposeCanvas') throw new Error('Expected passive canvas metadata');
  const { suggestions: _choices, ...work } = action.document;
  const { suggestions: _oldChoices, ...original } = input.targets[0]!.canvas!;
  expect(work).toEqual(original);
  return { prepared, document: action.document };
}

describe('prepared next steps retain saved references without widening model authority', () => {
  it('allows an unrelated blank tool when nine saved references exceed the eight-source prompt', () => {
    const input = captured(), snapshot = structuredClone(input);
    const { prepared, document } = validated(input);
    expect(prepared.sources).toHaveLength(8);
    expect(prepared.input.data).not.toContain('Attached fixture reference-9');
    expect(document.blocks.at(-1)!.sourceIds).toEqual(['reference-9']);
    expect(document.suggestions![0]!.prepared!.edits).toEqual([{ type: 'add', block: blank }]);
    expect(input).toEqual(snapshot);
  });

  it('retains a saved block while withholding local-only excerpts and source enum authority from cloud', () => {
    const input = captured();
    input.sources = [{ ...input.sources[8]!, title: 'PRIVATE_TITLE', excerpt: 'PRIVATE_EXCERPT', exposure: 'local-only' }, input.sources[0]!];
    const { prepared } = validated(input, 'cloud');
    expect(prepared.sources.map(source => source.id)).toEqual(['reference-1']);
    expect(prepared.input.data).not.toContain('PRIVATE_TITLE');
    expect(prepared.input.data).not.toContain('PRIVATE_EXCERPT');
    const schema = JSON.stringify(prepared.input.schema);
    expect(schema).toContain('"reference-1"');
    expect(schema).not.toContain('"reference-9"');
  });

  it.each(['add', 'replace'] as const)('does not grant omitted saved source IDs to a future %s', type => {
    const input = captured();
    const block = type === 'add' ? { ...blank, sourceIds: ['reference-9'] } : { ...input.targets[0]!.canvas!.blocks[8]!, title: 'A new heading' };
    const prepared = prepareContext(input, 'local');
    expect(() => validateProposal(output([{ type, block }]), input, prepared)).toThrow(/source in the proposed edit.*not attached/i);
  });

  it('does not grant a private source to a new block even when the full host request contains it', () => {
    const input = captured(); input.sources[8]!.exposure = 'local-only';
    expect(() => validateProposal(output([{ type: 'add', block: { ...blank, sourceIds: ['reference-9'] } }]), input, prepareContext(input, 'cloud'))).toThrow(/source in the proposed edit.*not attached/i);
  });

  it('permits a reviewed removal with a trusted local original whose source was omitted', () => {
    const input = captured(), original = input.targets[0]!.canvas!.blocks[8]!;
    const { document } = validated(input, 'local', output([{ type: 'remove', id: original.id }], original.id));
    expect(document.suggestions![0]!.prepared!.before).toEqual([original]);
  });

  it('permits a replacement using admitted resources while its local before snapshot retains an omitted reference', () => {
    const input = captured(), original = input.targets[0]!.canvas!.blocks[8]!;
    const replacement = { ...original, title: 'A new heading', sourceIds: ['reference-1'] };
    const { document } = validated(input, 'local', output([{ type: 'replace', block: replacement }], original.id));
    expect(document.suggestions![0]!.prepared!.before).toEqual([original]);
  });

  it('rejects invented references and cannot smuggle resource authority through model-written originals', () => {
    const input = captured(), response = output([{ type: 'add', block: { ...blank, sourceIds: ['invented'] } }]);
    Object.assign(response.actions[0]!.suggestions[0]!.prepared, { before: [text('forged', ['invented'])] });
    expect(() => validateProposal(response, input, prepareContext(input, 'local'))).toThrow(/source in the proposed edit.*not attached/i);
  });

  it('preserves an unadmitted saved image without allowing that image in new nested layers', () => {
    const input = captured();
    input.targets[0]!.canvas!.blocks.push({ id: 'saved-photo', kind: 'image', title: 'Saved photo', assetId: 'omitted-photo', caption: '', placement: 'main', pinned: false, sourceIds: [] });
    const { prepared } = validated(input);
    expect(JSON.stringify(prepared.input.schema)).not.toContain('omitted-photo');
    const design = { id: 'new-design', kind: 'design', title: 'A design', width: 400, height: 400, background: '#ffffff', placement: 'main', pinned: false, sourceIds: [], layers: [{ id: 'layer', kind: 'image', name: 'Image', x: 0, y: 0, width: 400, height: 400, assetId: 'omitted-photo', fit: 'cover' }] };
    expect(() => validateProposal(output([{ type: 'add', block: design }]), input, prepared)).toThrow(/image in the proposed edit.*not attached/i);
  });

  it('does not make stale historical edits current by retaining their source references', () => {
    const input = captured(), current = input.targets[0]!.canvas!;
    const before = current.blocks[0]!;
    current.suggestions = [{ id: 'stale', label: 'Earlier heading', description: 'Change the heading.', request: 'Change the heading only.', targetBlockId: before.id, prepared: { edits: [{ type: 'replace', block: { ...before, title: 'Earlier proposal' } }], before: [before] } }];
    current.blocks[0] = { ...before, kind: 'text', body: 'New authored writing.' } as CanvasBlock;
    const response = output();
    response.actions[0]!.suggestions = [{ kind: 'keep', id: 'stale' }] as unknown as typeof response.actions[0]['suggestions'];
    expect(() => validateProposal(response, input, prepareContext(input, 'local'))).toThrow(/changed/i);
  });
});
