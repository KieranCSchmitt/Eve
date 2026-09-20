import { vi } from 'vitest';
import type { AgentProvider, AgentRequest, ModelProposal, ProviderOutput } from '../../packages/agent/src/index.js';

let requestNumber = 0;
export function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    intent: { id: `request-${++requestNumber}`, text: 'Explain why the transition feels abrupt', inputModality: 'typed', taskId: 'orbit', taskEpoch: 2, contextSnapshotId: 'context-1', generation: 3 },
    context: { id: 'context-1', taskId: 'orbit', taskEpoch: 2, createdAt: 100, selection: { artifactId: 'note-1', revision: 4, text: 'transition: none' } },
    purpose: 'Make a study timer', policy: 'hybrid', priority: 'foreground', role: 'explain',
    sources: [{ id: 'source-1', title: 'Easing reference', uri: 'https://example.org/easing', excerpt: 'Ease-out starts quickly and then slows toward completion.', provenance: 'attached', retrievedAt: 100, exposure: 'cloud-allowed' }],
    targets: [
      { id: 'parameters-1', kind: 'parameters', revision: 3, parameters: { theme: '#6085ff', durationMinutes: 25, transitionMs: 200, easing: [0, 0, 1, 1] } },
      { id: 'note-1', kind: 'note', revision: 4 },
      { id: 'workspace-1', kind: 'workspace', revision: 7, files: [{ path: 'src/timer.ts', content: 'const duration = 200;\nexport { duration };\n' }] },
    ],
    ...overrides,
  };
}

export function proposal(overrides: Partial<ModelProposal> = {}): ModelProposal {
  return { version: 1, message: 'An ease-out transition slows toward its destination.', basis: 'sources', citations: [{ sourceId: 'source-1', quote: 'Ease-out starts quickly' }], actions: [], needsClarification: false, ...overrides };
}

export function fakeProvider(kind: 'local' | 'cloud' = 'cloud', output: unknown = proposal()) {
  const generate = vi.fn<AgentProvider['generate']>().mockResolvedValue({ text: JSON.stringify(output), usage: { inputTokens: 100, outputTokens: 50 } });
  const provider: AgentProvider = {
    id: `${kind}-test`, kind, model: 'test-model', enabled: true,
    roles: ['route', 'prepare', 'code', 'explain'], generate,
    publicSettings: () => ({ id: `${kind}-test`, kind, model: 'test-model', enabled: true, roles: ['route', 'prepare', 'code', 'explain'], protocol: 'openai-responses', endpoint: kind === 'local' ? 'http://127.0.0.1:8000/v1/responses' : 'https://api.openai.com/v1/responses', authentication: 'none' }),
  };
  return { provider, generate };
}

export function pendingOutput() {
  let resolve!: (value: ProviderOutput) => void;
  const promise = new Promise<ProviderOutput>(accept => { resolve = accept; });
  return { promise, finish: (value: unknown = proposal()) => resolve({ text: JSON.stringify(value), usage: {} }) };
}

export async function flush(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }

export function sseResponse(events: unknown[], options: { done?: boolean; split?: number; contentType?: string } = {}): Response {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (options.done ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const size = options.split ?? bytes.length;
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
      controller.close();
    },
  }), { headers: { 'content-type': options.contentType ?? 'text/event-stream' } });
}

export function responseEvents(value: unknown = proposal()): unknown[] {
  const text = JSON.stringify(value);
  return [
    { type: 'response.created', response: { id: 'response-1', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: text.slice(0, 20) },
    { type: 'response.output_text.delta', delta: text.slice(20) },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 70, output_tokens: 30 } } },
  ];
}
