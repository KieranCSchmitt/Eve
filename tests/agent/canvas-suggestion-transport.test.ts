import { expect, it, vi } from 'vitest';
import { createAgentService, createNemotronProvider, createOpenAIProvider, prepareContext, type AgentProvider } from '../../packages/agent/src/index';
import type { CanvasDocument } from '../../packages/contracts/src/index';
import { proposal, request, responseEvents, sseResponse } from './fixtures';

const canvas: CanvasDocument = {
  version: 1, title: 'Coast weekend', subtitle: '', layout: 'focus',
  blocks: [{ id: 'plan', title: 'Plan', kind: 'text', body: 'Take a walk by the coast.', placement: 'main', pinned: false, sourceIds: [] }],
  suggestions: [{ id: 'packing', label: 'Make a packing list', description: 'Bring what you need for the coast.', request: 'Add a packing checklist for this coastal walk.', targetBlockId: 'plan' }],
};
const value = proposal({ basis: 'general', citations: [], actions: [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 0, document: canvas }] });
const captured = () => {
  const input = request({ role: 'prepare', sources: [], targets: [{ kind: 'canvas', id: 'orbit:canvas', revision: 0 }] });
  input.intent.text = 'Plan a coastal walk';
  return input;
};
function provider(kind: 'cloud' | 'local', fetcher: typeof fetch): AgentProvider {
  return kind === 'cloud'
    ? createOpenAIProvider({ id: 'cloud', model: 'configured', enabled: true, roles: ['prepare'], credentialRef: 'credential' }, { fetch: fetcher, resolveCredential: async () => 'fixture-key' })
    : createNemotronProvider({ id: 'local', model: 'configured', enabled: true, roles: ['prepare'], endpoint: 'http://127.0.0.1:11434/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', authentication: { type: 'none' } }, { fetch: fetcher });
}

it.each(['cloud', 'local'] as const)('transports the strict suggestion schema and accepts a complete %s composition without increasing its output budget', async kind => {
  const events = kind === 'cloud' ? responseEvents(value) : [{ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }];
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(events, { done: kind === 'local' }));
  const service = createAgentService({ providers: [provider(kind, fetcher)], isCurrent: () => true });
  try {
    const input = captured();
    const result = await service.request(input);
    expect(result).toMatchObject({ status: 'complete', actions: value.actions });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(kind === 'cloud' ? body.max_output_tokens : body.max_tokens).toBe(4096);
    const schema = kind === 'cloud' ? body.text.format.schema : body.response_format.json_schema.schema;
    expect(schema).toEqual(prepareContext(input, kind).input.schema);
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const object = node as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
      if (object.properties) {
        expect(object.required ? [...object.required].sort() : undefined).toEqual(Object.keys(object.properties).sort());
        expect(object.additionalProperties).toBe(false);
      }
      Object.values(node).forEach(visit);
    };
    visit(schema);
  } finally { service.dispose(); }
});

it.each(['cloud', 'local'] as const)('rejects a %s output-budget stop even when the partial stream contains parseable suggestions', async kind => {
  const text = JSON.stringify(value);
  const events = kind === 'cloud'
    ? [{ type: 'response.output_text.delta', delta: text }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]
    : [{ choices: [{ delta: { content: text }, finish_reason: 'length' }] }];
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(events, { done: kind === 'local' }));
  const service = createAgentService({ providers: [provider(kind, fetcher)], isCurrent: () => true });
  try {
    const result = await service.request(captured());
    expect(result).toMatchObject({ status: 'failed', code: 'INCOMPLETE_OUTPUT' });
    expect(result).not.toHaveProperty('actions');
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { service.dispose(); }
});
