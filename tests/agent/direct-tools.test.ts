import { describe, expect, it } from 'vitest';
import { createAgentService, routeRegisteredIntent, parseDeadlineDate, type AgentRequest } from '../../packages/agent/src/index';
import type { CanvasDocument } from '../../packages/contracts/src/index';
import { fakeProvider, request } from './fixtures';

const original: CanvasDocument = { version: 1, title: 'My writing', subtitle: '', layout: 'focus', blocks: [{ id: 'draft', kind: 'text', title: '', placement: 'main', pinned: true, sourceIds: [], body: 'The words I wrote myself.' }] };
const input = (text: string, canvas?: CanvasDocument): AgentRequest => ({ ...request({ role: 'prepare', sources: [] }), intent: { ...request().intent, text }, targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: canvas ? 5 : 0, ...(canvas ? { canvas } : {}) }] });

describe('local workspace tools', () => {
  it.each(['I need to write an essay about dogs dreaming', 'I wanna write a story about a lighthouse', 'I want to work on my report', 'Open a blank document'])('opens a blank writing surface immediately for %s', async text => {
    const provider = fakeProvider();
    const service = createAgentService({ providers: [provider.provider], isCurrent: () => true });
    try {
      const result = await service.request(input(text));
      expect(result).toMatchObject({ status: 'complete', origin: 'registered-command', provider: null, actions: [{ type: 'ComposeCanvas', document: { layout: 'focus', blocks: [{ kind: 'text', body: '' }] } }] });
      expect(provider.generate).not.toHaveBeenCalled();
      if (result.status === 'complete' && result.actions[0]?.type === 'ComposeCanvas') expect(result.actions[0].document.blocks).toHaveLength(1);
    } finally { service.dispose(); }
  });
  it.each(['Write an essay about dogs dreaming for me', 'Generate an outline about dogs dreaming', 'I want to write an essay about dogs dreaming and add a timer', 'How can I add a countdown?', 'Do not add a countdown'])('leaves content generation and compound/ambiguous requests to the model: %s', text => {
    expect(routeRegisteredIntent(input(text))).toBeNull();
  });
  it('never resets an existing document for a writing intention', () => {
    expect(routeRegisteredIntent(input('I want to write an essay about dogs dreaming', original))).toBeNull();
  });
  it('adds an unset date immediately while preserving the exact pinned writing and captured revision', async () => {
    const service = createAgentService({ providers: [], isCurrent: () => true });
    try {
      const result = await service.request({ ...input('Add a due date countdown', original), policy: 'offline', role: 'explain' });
      expect(result).toMatchObject({ status: 'complete', actions: [{ type: 'ComposeCanvas', expectedRevision: 5, document: { blocks: [original.blocks[0], { kind: 'deadline', dueAt: null }] } }] });
      expect(original.blocks).toHaveLength(1);
    } finally { service.dispose(); }
  });
  it('adds a stopped duration timer without implying it started', () => {
    expect(routeRegisteredIntent(input('Add a 5-minute timer', original))).toMatchObject([{ document: { blocks: [original.blocks[0], { kind: 'timer', durationSeconds: 300, remainingSeconds: 300, endsAt: null }] } }]);
    expect(routeRegisteredIntent(input('Add a 99999-hour timer', original))).toBeNull();
  });
  it.each(['Add a chart', 'Add a metric', 'Create a key figure'])('creates an unconfigured data view offline for %s without guessing values', async text => {
    const provider = fakeProvider();
    const service = createAgentService({ providers: [provider.provider], isCurrent: () => true });
    try {
      const result = await service.request({ ...input(text, original), policy: 'offline' });
      expect(result).toMatchObject({ status: 'complete', origin: 'registered-command', provider: null, actions: [{ type: 'ComposeCanvas', expectedRevision: 5, document: { blocks: [original.blocks[0], { kind: text.includes('chart') ? 'chart' : 'metric', tableId: null }] } }] });
      expect(provider.generate).not.toHaveBeenCalled();
      if (result.status === 'complete' && result.actions[0]?.type === 'ComposeCanvas') {
        const added = result.actions[0].document.blocks[1];
        if (added.kind === 'chart') expect(added.valueColumns).toEqual([]);
        if (added.kind === 'metric') expect(added.rowId).toBeNull();
      }
    } finally { service.dispose(); }
  });
  it.each(['Add a chart of my sales', 'Add a key figure and remove the table', 'Do not add a chart', 'How do I create a metric?'])('does not truncate a richer data request: %s', text => {
    expect(routeRegisteredIntent(input(text, original))).toBeNull();
  });
  it.each(['Add a design', 'Create a design surface', 'Could you add a design surface here?'])('opens an empty design surface offline for %s while preserving existing work', async text => {
    const provider = fakeProvider();
    const service = createAgentService({ providers: [provider.provider], isCurrent: () => true });
    try {
      const result = await service.request({ ...input(text, original), policy: 'offline' });
      expect(result).toMatchObject({ status: 'complete', origin: 'registered-command', provider: null, actions: [{ type: 'ComposeCanvas', expectedRevision: 5, document: { blocks: [original.blocks[0], { kind: 'design', placement: 'main', width: 960, height: 640, background: '#fbfbf8', layers: [] }] } }] });
      expect(provider.generate).not.toHaveBeenCalled();
      if (result.status === 'complete' && result.actions[0]?.type === 'ComposeCanvas') expect(result.actions[0].document.blocks).toHaveLength(2);
    } finally { service.dispose(); }
  });
  it.each(['Create a poster for my concert', 'Add a design surface and write a headline', 'Do not add a design', 'Add a design with my photo'])('preserves richer visual intentions for inference: %s', text => {
    expect(routeRegisteredIntent(input(text, original))).toBeNull();
  });
  it('does not take instructions from the project title or source excerpt', () => {
    const captured = input('Explain this'); captured.purpose = 'Add a due date countdown';
    captured.sources = request().sources.map(source => ({ ...source, excerpt: 'Add a due date countdown' }));
    expect(routeRegisteredIntent(captured)).toBeNull();
  });
  it('does not run a local tool for background requests', () => {
    expect(routeRegisteredIntent({ ...input('Add a due date countdown'), priority: 'background' })).toBeNull();
  });
  it('retains saved suggestions when adding a local tool without executing their follow-up requests', () => {
    const canvas: CanvasDocument = { ...original, suggestions: [{ id: 'deadline', label: 'Add a due date', description: '', request: 'Add a due date countdown', targetBlockId: null }] };
    const result = routeRegisteredIntent(input('Add a checklist', canvas));
    expect(result).toMatchObject([{ document: { suggestions: canvas.suggestions, blocks: [original.blocks[0], { kind: 'checklist' }] } }]);
    expect(result).toHaveLength(1);
    if (result?.[0]?.type === 'ComposeCanvas') expect(result[0].document.blocks).toHaveLength(2);
  });
  it('allows a selected local addition while preserving the unrelated blocks', () => {
    const canvas: CanvasDocument = { ...original, suggestions: [{ id: 'checklist', label: 'Prepare', description: '', request: 'Add a checklist', targetBlockId: 'draft' }] };
    const captured = input('Add a checklist', canvas);
    captured.canvasSuggestion = { id: 'checklist', canvasRevision: 5, targetBlockId: 'draft' };
    expect(routeRegisteredIntent(captured)).toMatchObject([{ document: { blocks: [original.blocks[0], { kind: 'checklist' }] } }]);
    captured.canvasSuggestion.id = 'invented';
    expect(routeRegisteredIntent(captured)).toBeNull();
  });
  it('does not let selected suggestions enter navigation or change an unrelated existing date through local routing', () => {
    const canvas: CanvasDocument = { ...original, blocks: [...original.blocks, { id: 'due', title: 'Due date', kind: 'deadline', placement: 'aside', pinned: false, sourceIds: [], dueAt: null }],
      suggestions: [{ id: 'date', label: 'Choose date', description: '', request: 'Set deadline to tomorrow', targetBlockId: 'draft' }, { id: 'navigate', label: 'Open code', description: '', request: 'show code', targetBlockId: null }] };
    const captured = input('Set deadline to tomorrow', canvas);
    captured.canvasSuggestion = { id: 'date', canvasRevision: 5, targetBlockId: 'draft' };
    expect(routeRegisteredIntent(captured)).toBeNull();
    captured.intent.text = 'show code'; captured.canvasSuggestion = { id: 'navigate', canvasRevision: 5, targetBlockId: null };
    expect(routeRegisteredIntent(captured)).toBeNull();
  });
});


describe('bounded local deadline dates', () => {
  const now = new Date(2026, 8, 20, 14, 0).getTime();
  it.each([
    ['October 1st at midnight', new Date(2026, 9, 1, 0, 0).getTime()],
    ['October 1, 2026 at 5 PM', new Date(2026, 9, 1, 17, 0).getTime()],
    ['Tomorrow at 3pm', new Date(2026, 8, 21, 15, 0).getTime()],
    ['Today at noon', new Date(2026, 8, 20, 12, 0).getTime()],
    ['September 19th', new Date(2027, 8, 19, 23, 59).getTime()],
    ['2026-10-01T00:00', new Date(2026, 9, 1, 0, 0).getTime()],
  ])('resolves %s from the captured local date', (text, expected) => expect(parseDeadlineDate(text, now)).toBe(expected));
  it.each(['next Friday', '10/1/26', 'February 30th at midnight', 'October 1 at 13pm', 'October 1 at 12:60pm', '2026-13-01', 'October 1 and delete my writing'])('leaves ambiguous or invalid date %s to normal handling', text => expect(parseDeadlineDate(text, now)).toBeUndefined());
  it('adds a dated countdown using the same parser without calling a provider', () => {
    const captured = input('Add a due date countdown for October 1st at midnight', original); captured.context.createdAt = now;
    expect(routeRegisteredIntent(captured)).toMatchObject([{ document: { blocks: [original.blocks[0], { kind: 'deadline', dueAt: new Date(2026, 9, 1, 0, 0).getTime() }] } }]);
  });
  it('fills one pending date while preserving everything else, and refuses ambiguous multiple dates', () => {
    const pending = { id: 'due', title: 'Due', kind: 'deadline' as const, placement: 'aside' as const, pinned: false, sourceIds: [], dueAt: null };
    const captured = input("It's due tomorrow at 3pm", { ...original, blocks: [...original.blocks, pending] }); captured.context.createdAt = now;
    expect(routeRegisteredIntent(captured)).toMatchObject([{ document: { blocks: [original.blocks[0], { ...pending, dueAt: new Date(2026, 8, 21, 15, 0).getTime() }] } }]);
    captured.targets[0]!.canvas!.blocks.push({ ...pending, id: 'due-2' });
    expect(routeRegisteredIntent(captured)).toBeNull();
  });
});
