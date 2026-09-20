import { describe, expect, it } from 'vitest';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import type { CanvasBlock, CanvasDocument } from '../../packages/contracts/src/index';
import { proposal, request } from './fixtures';

type Timeline = Extract<CanvasBlock, { kind: 'timeline' }>;
const timeline = (changes: Partial<Timeline> = {}): Timeline => ({
  id: 'day', kind: 'timeline', title: 'Today', placement: 'full', pinned: false, sourceIds: [],
  date: 'Today', startHour: 0, endHour: 24,
  items: [{ id: 'focus', title: 'Finish essay', startMinutes: 780, endMinutes: 870, status: 'suggested', detail: 'Use the saved outline.' }],
  ...changes,
});
const document = (block = timeline()): CanvasDocument => ({ version: 1, title: 'A useful day', subtitle: '', layout: 'focus', blocks: [block] });
const canvasRequest = (block = timeline()): AgentRequest => ({
  ...request({ role: 'prepare' }), sources: [],
  targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 8, assets: [], canvas: document(block) }],
});
const clockItem = (startTime: unknown = '13:00', endTime: unknown = '14:30') => ({
  id: 'focus', title: 'Finish essay', startTime, endTime, status: 'suggested', detail: 'Use the saved outline.',
});
const clockDocument = (item: Record<string, unknown> = clockItem(), changes: Partial<Timeline> = {}) => ({
  ...document(), blocks: [{ ...timeline(changes), items: [item] }],
});
const output = (canvas: unknown) => ({
  ...proposal({ basis: 'general', citations: [] }),
  actions: [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 8, document: canvas }],
});
const validate = (canvas: unknown, input = canvasRequest()) => validateProposal(output(canvas), input, prepareContext(input, 'local'));
type WireNode = { properties?: Record<string, WireNode>; items?: WireNode; anyOf?: WireNode[]; const?: unknown; required?: string[] };

describe('canvas timeline clock format at the model boundary', () => {
  it.each([
    ['00:00', '00:01', 0, 1],
    ['09:05', '10:45', 545, 645],
    ['13:00', '14:30', 780, 870],
    ['23:59', '24:00', 1439, 1440],
    ['00:00', '24:00', 0, 1440],
  ])('converts %s–%s to canonical minutes without changing the model response', (start, end, startMinutes, endMinutes) => {
    const canvas = clockDocument(clockItem(start, end));
    const before = structuredClone(canvas);
    const result = validate(canvas);
    expect(result.actions).toEqual([{
      type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 8,
      document: document(timeline({ items: [{ ...timeline().items[0]!, startMinutes, endMinutes }] })),
    }]);
    expect(canvas).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('startTime');
    expect(JSON.stringify(result)).not.toContain('endTime');
  });

  it('allows 24:00 only as the end of a day', () => {
    expect(() => validate(clockDocument(clockItem('24:00', '24:00')))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    expect(() => validate(clockDocument(clockItem('23:00', '24:01')))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it.each(['9:05', '09:5', '09:00:00', '09:00 ', ' 09:00', '9 AM', '25:00', '12:60', '-1:00', '+09:00', '', 900, null])('rejects malformed clock value %j', value => {
    expect(() => validate(clockDocument(clockItem(value, '24:00')))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    expect(() => validate(clockDocument(clockItem('00:00', value)))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it.each([
    ['08:59', '09:30', 9, 17],
    ['16:30', '17:01', 9, 17],
    ['16:00', '15:00', 0, 24],
    ['13:00', '13:00', 0, 24],
  ])('keeps displayed bounds and positive duration authoritative for %s–%s', (start, end, startHour, endHour) => {
    expect(() => validate(clockDocument(clockItem(start, end), { startHour, endHour }))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it.each([
    { startMinutes: 780, endMinutes: 870 },
    { startMinutes: 780 },
    { endMinutes: 870 },
  ])('rejects an ambiguous mixture of clock and minute fields %j', minutes => {
    expect(() => validate(clockDocument({ ...clockItem(), ...minutes }))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it('rejects a missing clock endpoint instead of borrowing the old saved time', () => {
    const { endTime: _end, ...startOnly } = clockItem();
    const { startTime: _start, ...endOnly } = clockItem();
    expect(() => validate(clockDocument(startOnly))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    expect(() => validate(clockDocument(endOnly))).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it('advertises clock fields only in the generated timeline item schema', () => {
    const schema = prepareContext(canvasRequest(), 'local').input.schema as WireNode;
    const compose = schema.properties!.actions!.items!.anyOf!.find(branch => branch.properties!.type!.const === 'ComposeCanvas')!;
    const blocks = compose.properties!.document!.properties!.blocks!.items!.anyOf!;
    const item = blocks.find(block => block.properties!.kind!.const === 'timeline')!.properties!.items!.items!;
    expect(item.properties).toHaveProperty('startTime');
    expect(item.properties).toHaveProperty('endTime');
    expect(item.properties).not.toHaveProperty('startMinutes');
    expect(item.properties).not.toHaveProperty('endMinutes');
    expect(item.required).toContain('startTime');
    expect(item.required).toContain('endTime');
    expect(item.required).not.toContain('startMinutes');
    expect(item.required).not.toContain('endMinutes');
  });

  it('sends existing timelines as clocks while retaining canonical targets and preserving pinned round trips', () => {
    const pinned = timeline({ pinned: true, items: [
      { ...timeline().items[0]!, status: 'planned' },
      { id: 'late', title: 'Late work', startMinutes: 1380, endMinutes: 1440, status: 'suggested', detail: '' },
    ] });
    const input = canvasRequest(pinned), original = structuredClone(input);
    const prepared = prepareContext(input, 'local');
    const wire = JSON.parse(prepared.input.data);
    const saved = wire.targets[0].canvas;
    expect(saved.blocks[0].items).toEqual([
      { id: 'focus', title: 'Finish essay', startTime: '13:00', endTime: '14:30', status: 'planned', detail: 'Use the saved outline.' },
      { id: 'late', title: 'Late work', startTime: '23:00', endTime: '24:00', status: 'suggested', detail: '' },
    ]);
    expect(prepared.targets[0]!.canvas).toEqual(input.targets[0]!.canvas);
    saved.blocks.push({ id: 'next', kind: 'text', title: 'Next', placement: 'main', pinned: false, sourceIds: [], body: 'An additional idea.' });
    const result = validateProposal(output(saved), input, prepared);
    expect(result.actions[0]).toMatchObject({ document: { blocks: [pinned, saved.blocks[1]] } });
    expect(input).toEqual(original);
    saved.blocks[0].items[0].endTime = '14:45';
    expect(() => validateProposal(output(saved), input, prepared)).toThrow('Unpin');
  });

  it('continues accepting canonical minute input at the internal validation boundary', () => {
    const canvas = document();
    expect(validate(canvas).actions).toEqual([{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 8, document: canvas }]);
  });
});
