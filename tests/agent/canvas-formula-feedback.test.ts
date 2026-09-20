import { describe, expect, it } from 'vitest';
import { calculateCell, compileCanvasSuggestion, type CanvasDocument } from '../../packages/contracts/src/index';
import { createAgentService, type AgentRequest } from '../../packages/agent/src/index';
import { fakeProvider, proposal, request } from './fixtures';

const original = (): CanvasDocument => ({
  version: 1, title: 'Workshop supply estimates', subtitle: '', layout: 'split',
  blocks: [{ id: 'supplies', kind: 'table', title: 'Supply estimates', placement: 'main', pinned: false, sourceIds: [],
    columns: ['Supply', 'Packs', 'Price per pack', 'Delivery'], rows: [
      { id: 'needles', cells: ['Needles', '3', '8', 'unknown'] },
      { id: 'thread', cells: ['Thread', '4', '12', 'unknown'] },
      { id: 'patches', cells: ['Patches', 'unknown', '6', ''] },
    ],
  }, { id: 'original-note', kind: 'text', title: 'Planning constraint', placement: 'aside', pinned: true, sourceIds: [], body: 'Patch quantity and delivery charges are not confirmed.' }],
  suggestions: [],
});
function input(): AgentRequest {
  const value = request({ role: 'prepare', policy: 'local-only', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas: original(), assets: [] }],
    canvasSuggestionRefresh: { targetId: 'orbit:canvas', canvasRevision: 7, scope: { blockId: 'supplies' } },
  });
  delete value.context.selection;
  value.intent.text = 'Suggest useful next steps for this table while preserving my work and unknown values.';
  return value;
}
const output = (formula: string) => ({ ...proposal({ basis: 'general', citations: [], message: 'Review a subtotal of the known costs.' }), actions: [{
  type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions: [{
    id: 'known-subtotal', label: 'Calculate known supply costs', description: 'Add the known needle and thread costs; delivery and patch quantity stay unknown.',
    request: 'Prepare a subtotal of the known needle and thread costs without filling unknown values.', targetBlockId: 'supplies', prepared: {
      edits: [{ type: 'patch', id: 'supplies', changes: [{ type: 'insert', collection: 'rows', afterId: 'patches', item: { id: 'known-subtotal-row', cells: ['Known cost subtotal', '', formula, ''] } }] }],
      arrangement: null,
    },
  }],
}] });

describe('prepared table formula correction feedback', () => {
  it('supplies table, cell, row identity and A1 convention to the actual service correction without changing captured work', async () => {
    const badFormula = '=B2*C2+B3*C3';
    const correctedFormula = '=B1*C1+B2*C2';
    const local = fakeProvider('local', output(correctedFormula));
    local.generate.mockResolvedValueOnce({ text: JSON.stringify(output(badFormula)), usage: {} });
    const captured = input(), immutableCapture = structuredClone(captured);
    const service = createAgentService({ providers: [local.provider], isCurrent: () => true });
    try {
      const result = await service.request(captured);
      expect(result.status).toBe('complete');
      expect(local.generate).toHaveBeenCalledTimes(2);
      const [first, correction] = local.generate.mock.calls;
      const { validationFeedback, ...sameContext } = JSON.parse(correction![0].data);
      expect(sameContext).toEqual(JSON.parse(first![0].data));
      expect(correction![0].schema).toBe(first![0].schema);
      expect(validationFeedback).toMatchObject({ previousResponse: JSON.stringify(output(badFormula)), previousResponseTruncated: false });
      expect(validationFeedback.error).toContain('Prepared table "supplies", cell C4 (row "known-subtotal-row")');
      expect(validationFeedback.error).toContain(`invalid formula "${badFormula}"`);
      expect(validationFeedback.error).toContain('Column A is the first column; row 1 is the first data row, excluding headings.');
      expect(validationFeedback.error).toContain('Blank, unknown and other nonnumeric cells are not zero.');
      expect(captured).toEqual(immutableCapture);
      if (result.status !== 'complete' || result.actions[0]?.type !== 'ComposeCanvas') throw new Error('Expected a corrected passive canvas result.');
      const canonical = result.actions[0].document;
      expect(canonical.blocks).toEqual(original().blocks);
      const projected = compileCanvasSuggestion(canonical, 'known-subtotal');
      const table = projected.blocks[0]!;
      if (table.kind !== 'table') throw new Error('Expected the projected table.');
      expect(table.rows.slice(0, 3)).toEqual((original().blocks[0] as typeof table).rows);
      expect(table.rows[3]!.cells).toEqual(['Known cost subtotal', '', correctedFormula, '']);
      expect(calculateCell(table.rows, 3, 2)).toBe(72);
      expect(projected.blocks[1]).toEqual(original().blocks[1]);
    } finally { service.dispose(); }
  });

  it('still rejects repeated unknown-dependent formulas after one correction rather than coercing or repairing their values', async () => {
    const bad = output('=B2*C2+B3*C3'), local = fakeProvider('local', bad);
    const captured = input(), immutableCapture = structuredClone(captured);
    const service = createAgentService({ providers: [local.provider], isCurrent: () => true });
    try {
      const result = await service.request(captured);
      expect(result).toMatchObject({ status: 'failed', code: 'INVALID_OUTPUT' });
      expect(result).not.toHaveProperty('actions');
      expect(local.generate).toHaveBeenCalledTimes(2);
      expect(JSON.parse(local.generate.mock.calls[1]![0].data).validationFeedback.previousResponse).toBe(JSON.stringify(bad));
      expect(captured).toEqual(immutableCapture);
    } finally { service.dispose(); }
  });
});
