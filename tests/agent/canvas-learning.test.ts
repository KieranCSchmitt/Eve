import { describe, expect, it, vi } from 'vitest';
import { agentRequestSchema, assertRequestIdentity, canvasLearningIsCurrent, createAgentService, createNemotronProvider, createOpenAIProvider, learningPromptContext, prepareContext, routeRegisteredIntent, validateProposal, type AgentRequest } from '../../packages/agent/src/index.js';
import type { CanvasDocument } from '../../packages/contracts/src/index.js';
import { fakeProvider, proposal, request, responseEvents, sseResponse } from './fixtures.js';

const body = 'Opening. A prism separates light. Ending.';
function captured(): AgentRequest {
  const canvas: CanvasDocument = { version: 1, title: 'Optics draft', subtitle: '', layout: 'focus', blocks: [{ kind: 'text', id: 'draft', title: 'My writing', body, pinned: true, placement: 'main', sourceIds: ['source-1'] }], suggestions: [] };
  const input = request({ role: 'explain', targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas }], canvasLearning: { targetId: 'orbit:canvas', canvasRevision: 7, scope: { blockId: 'draft', selection: { field: 'body', start: 9, end: 33, text: 'A prism separates light.' + ' ' } } } });
  input.canvasLearning!.scope.selection!.end = 32;
  input.canvasLearning!.scope.selection!.text = body.slice(9, 32);
  delete input.context.selection;
  input.intent.text = 'Explain this passage briefly.';
  return input;
}
const answer = () => proposal({ basis: 'selection', message: 'This passage describes how a prism separates visible light.', citations: [] });

describe('exact read-only canvas learning', () => {
  it('permits a pinned passage, keeps the canonical capture local and advertises no actions', () => {
    const input = captured(), original = structuredClone(input), prepared = prepareContext(input, 'local');
    expect(agentRequestSchema.safeParse(input).success).toBe(true);
    expect(canvasLearningIsCurrent(input)).toBe(true);
    expect(() => assertRequestIdentity(input)).not.toThrow();
    expect(prepared.targets).toEqual(input.targets);
    expect(JSON.parse(prepared.input.data)).toEqual(learningPromptContext(input));
    expect(prepared.input.data).not.toContain('suggestions');
    expect(prepared.input.data).not.toContain('pinned');
    expect(prepared.input.schema).toMatchObject({ properties: { actions: { maxItems: 0 } } });
    expect(JSON.stringify(prepared.input.schema)).not.toContain('ComposeCanvas');
    expect(prepared.input.maxOutputTokens).toBe(768);
    expect(validateProposal(answer(), input, prepared).actions).toEqual([]);
    expect(input).toEqual(original);
  });

  it.each(['revision', 'target', 'quote', 'range', 'missing selection', 'role', 'background', 'extra target', 'missing block', 'emoji'])('rejects a forged or stale %s capture before inference', issue => {
    const input = captured(), marker = input.canvasLearning!;
    if (issue === 'revision') marker.canvasRevision++;
    if (issue === 'target') marker.targetId = 'foreign';
    if (issue === 'quote') marker.scope.selection!.text = 'forged';
    if (issue === 'range') marker.scope.selection!.start++;
    if (issue === 'missing selection') delete marker.scope.selection;
    if (issue === 'role') input.role = 'prepare';
    if (issue === 'background') input.priority = 'background';
    if (issue === 'extra target') input.targets.push({ id: 'other', kind: 'note', revision: 1 });
    if (issue === 'missing block') marker.scope.blockId = 'absent';
    if (issue === 'emoji') {
      const block = input.targets[0]!.canvas!.blocks[0]!; if (block.kind !== 'text') throw Error(); block.body = 'A😀B';
      marker.scope.selection = { field: 'body', start: 1, end: 2, text: '\ud83d' };
    }
    expect(canvasLearningIsCurrent(input)).toBe(false);
    expect(() => prepareContext(input, 'local')).toThrow(/captured passage/);
    expect(() => validateProposal(answer(), input, { input: {} as any, targets: [], sources: [] })).toThrow(/no longer current/);
  });

  it.each(['canvasSuggestion', 'canvasSuggestionRefresh'] as const)('rejects conflicting %s authority', field => {
    const input = captured();
    if (field === 'canvasSuggestion') input.canvasSuggestion = { id: 'saved', canvasRevision: 7, targetBlockId: 'draft' };
    else input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
    expect(agentRequestSchema.safeParse(input).success).toBe(false);
    expect(canvasLearningIsCurrent(input)).toBe(false);
  });

  it.each([{ type: 'Undo' }, { type: 'PauseAssistance' }, { type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions: [] }])('rejects every mutation before wire expansion: $type', action => {
    const input = captured(); expect(() => validateProposal({ ...answer(), actions: [action] }, input, prepareContext(input, 'local'))).toThrow(/read-only/);
  });

  it('does not route selected command-like words as registered actions', async () => {
    const input = captured(); input.intent.text = 'undo';
    expect(routeRegisteredIntent(input)).toBeNull();
    const fake = fakeProvider('local', answer());
    const service = createAgentService({ providers: [fake.provider], isCurrent: () => true });
    expect(await service.request(input)).toMatchObject({ status: 'complete', origin: 'model-proposal', actions: [], requiresUserAction: false, focusPolicy: 'preserve' });
    expect(fake.generate).toHaveBeenCalledOnce(); service.dispose();
  });

  it('budgets only selected context, omits unrelated work and old choices, and honors source exposure', () => {
    const input = captured(), canvas = input.targets[0]!.canvas!;
    const block = canvas.blocks[0]!; if (block.kind !== 'text') throw Error();
    block.body += 'x'.repeat(19000);
    for (let i = 0; i < 10; i++) canvas.blocks.push({ ...block, id: `foreign-${i}`, body: 'FOREIGN SECRET '.repeat(1000) });
    input.sources.push({ ...input.sources[0]!, id: 'foreign-source', excerpt: 'FOREIGN SOURCE' });
    input.sources[0]!.exposure = 'local-only';
    const local = prepareContext(input, 'local'), cloud = prepareContext(input, 'cloud');
    expect(local.input.data).not.toContain('FOREIGN'); expect(local.input.data.length).toBeLessThan(4000);
    expect(local.sources).toHaveLength(1); expect(cloud.sources).toEqual([]);
    expect(local.targets[0]!.canvas!.blocks).toHaveLength(11);
    expect(() => prepareContext(input, 'local', 200)).toThrow(/budget/);
  });

  it('allows explicitly general background teaching without pretending the draft is a source', () => {
    const input = captured(); input.sources = [];
    const prepared = prepareContext(input, 'local');
    expect(prepared.input.schema).toMatchObject({ properties: { basis: { enum: ['general', 'selection'] }, citations: { maxItems: 0 } } });
    const background = { ...answer(), basis: 'general', message: 'Refraction is the change in direction when light crosses between materials where it travels at different speeds. A prism makes the effect visible because its faces meet at an angle. Different visible wavelengths bend by different amounts, which can separate white light into a spectrum.' };
    expect(validateProposal(background, input, prepared)).toMatchObject({ basis: 'general', actions: [], citations: [] });
    expect(() => validateProposal({ ...background, basis: 'sources', citations: [{ sourceId: 'draft', quote: input.canvasLearning!.scope.selection!.text }] }, input, prepared)).toThrow(/citation/);
    expect(input.targets[0]!.canvas!.blocks[0]).toMatchObject({ body });
  });

  it('rejects invented citation authority and overly long explanations', () => {
    const input = captured(), prepared = prepareContext(input, 'local');
    expect(() => validateProposal({ ...answer(), basis: 'sources', citations: [{ sourceId: 'foreign', quote: '' }] }, input, prepared)).toThrow(/citation/);
    expect(() => validateProposal({ ...answer(), message: 'x'.repeat(1801) }, input, prepared)).toThrow(/concise/);
  });
});

describe('trusted per-request provider output budgets', () => {
  it.each(['local', 'cloud'] as const)('caps %s output without changing configured policy', async kind => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(responseEvents(answer())));
    const adapter = kind === 'cloud' ? createOpenAIProvider({ id: 'cloud', model: 'observed', enabled: true, roles: ['explain'], credentialRef: 'credential', maxOutputTokens: 4096 }, { fetch: fetcher, resolveCredential: async () => 'test-only' }) : createNemotronProvider({ id: 'local', model: 'observed', enabled: true, roles: ['explain'], endpoint: 'http://127.0.0.1:8000/v1/responses', protocol: 'openai-responses', outputMode: 'json-schema', maxOutputTokens: 4096, authentication: { type: 'none' } }, { fetch: fetcher });
    await adapter.generate(prepareContext(captured(), kind).input, { signal: new AbortController().signal, onTextDelta() {} });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).max_output_tokens).toBe(768);
  });

  it('never raises the configured cap and rejects invalid request caps before transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(responseEvents(answer())));
    const adapter = createOpenAIProvider({ id: 'cloud', model: 'observed', enabled: true, roles: ['explain'], credentialRef: 'credential', maxOutputTokens: 256 }, { fetch: fetcher, resolveCredential: async () => 'test-only' });
    const input = prepareContext(captured(), 'cloud').input, options = { signal: new AbortController().signal, onTextDelta() {} };
    await adapter.generate(input, options);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).max_output_tokens).toBe(256);
    await expect(adapter.generate({ ...input, maxOutputTokens: NaN }, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
