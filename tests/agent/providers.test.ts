import { describe, expect, it, vi } from 'vitest';
import { createNemotronProvider, createOpenAIProvider, nemotronProviderConfigSchema, prepareContext, readSSE } from '../../packages/agent/src/index.js';
import { proposal, request, responseEvents, sseResponse } from './fixtures.js';

function openAI(fetcher: typeof fetch, resolveCredential = async (_ref: string) => 'test-key-never-log') {
  return createOpenAIProvider({ id: 'openai', model: 'configured-model', enabled: true, roles: ['explain'], credentialRef: 'eve-openai', reasoningEffort: 'low' }, { fetch: fetcher, resolveCredential });
}
const runOptions = () => ({ signal: new AbortController().signal, onTextDelta: vi.fn() });

describe('OpenAI Responses adapter', () => {
  it('uses strict structured output and streams split UTF-8 without revealing credentials', async () => {
    const value = proposal({ message: 'A π-shaped curve is only an illustration.' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(responseEvents(value), { split: 7 }));
    const adapter = openAI(fetcher);
    const options = runOptions();
    const output = await adapter.generate(prepareContext(request(), 'cloud').input, options);
    expect(JSON.parse(output.text)).toEqual(value);
    expect(output.usage).toEqual({ inputTokens: 70, outputTokens: 30 });
    expect(options.onTextDelta).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: 'configured-model', stream: true, store: false, reasoning: { effort: 'low' }, text: { format: { type: 'json_schema', strict: true, name: 'eve_proposal' } } });
    expect(body).not.toHaveProperty('tools');
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(adapter.publicSettings())).not.toContain('test-key-never-log');
    expect(JSON.stringify(adapter.publicSettings())).not.toContain('eve-openai');
  });

  it('does not fetch without a credential', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createOpenAIProvider({ id: 'openai', model: 'configured-model', enabled: true, roles: ['explain'], credentialRef: 'missing' }, { fetch: fetcher, resolveCredential: async () => undefined });
    await expect(adapter.generate(prepareContext(request(), 'cloud').input, runOptions())).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sanitizes upstream HTTP failures instead of echoing secret/source bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('test-key-never-log selected-private-text', { status: 401 }));
    await expect(openAI(fetcher).generate(prepareContext(request(), 'cloud').input, runOptions())).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', message: 'The provider returned HTTP 401. No action was applied.' });
  });

  it('rejects a truncated stream even when accumulated text happens to parse', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([{ type: 'response.output_text.delta', delta: JSON.stringify(proposal()) }]));
    await expect(openAI(fetcher).generate(prepareContext(request(), 'cloud').input, runOptions())).rejects.toMatchObject({ code: 'INCOMPLETE_OUTPUT' });
  });

  it.each(['response.refusal.delta', 'response.incomplete', 'response.failed'])('does not treat %s as successful output', async type => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([{ type, delta: 'No', response: { status: 'incomplete' } }]));
    await expect(openAI(fetcher).generate(prepareContext(request(), 'cloud').input, runOptions())).rejects.toBeInstanceOf(Error);
  });

  it('rejects unexpected tool operations from the provider', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', name: 'run_shell' }] } }]));
    await expect(openAI(fetcher).generate(prepareContext(request(), 'cloud').input, runOptions())).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' });
  });

  it('aborts and cancels the stream reader immediately', async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } }));
    const abort = new AbortController();
    const result = openAI(fetcher).generate(prepareContext(request(), 'cloud').input, { signal: abort.signal, onTextDelta: () => undefined });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    abort.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelled).toHaveBeenCalled();
  });
});

describe('qualified local OpenAI-compatible adapter', () => {
  it('drains an unverified local runtime after caller cancellation instead of freeing its slot early', async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } }));
    const adapter = createNemotronProvider({ id: 'gx10', model: 'observed-model', enabled: true, roles: ['explain'], endpoint: 'http://localhost:8000/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', authentication: { type: 'none' } }, { fetch: fetcher });
    const abort = new AbortController();
    const progress = vi.fn();
    let finished = false;
    const result = adapter.generate(prepareContext(request(), 'local').input, { signal: abort.signal, onTextDelta: progress }).then(value => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    abort.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
    expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(false);
    writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(proposal()) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
    writer.close();
    await result;
    expect(finished).toBe(true);
    expect(progress).not.toHaveBeenCalled();
  });

  it('reports unknown local inference state when the connection disappears without a terminal event', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([{ choices: [{ delta: { content: '{}' }, finish_reason: null }] }]));
    const adapter = createNemotronProvider({ id: 'gx10', model: 'observed-model', enabled: true, roles: ['explain'], endpoint: 'http://localhost:8000/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', authentication: { type: 'none' } }, { fetch: fetcher });
    await expect(adapter.generate(prepareContext(request(), 'local').input, runOptions())).rejects.toMatchObject({ code: 'LOCAL_STATE_UNKNOWN' });
  });

  it('uses the explicitly configured chat protocol, output mode, and no guessed credential', async () => {
    const text = JSON.stringify(proposal());
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ], { done: true }));
    const adapter = createNemotronProvider({ id: 'gx10', model: 'observed-checkpoint', enabled: true, roles: ['explain'], endpoint: 'http://127.0.0.1:8112/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-object', authentication: { type: 'none' } }, { fetch: fetcher });
    const output = await adapter.generate(prepareContext(request(), 'local').input, runOptions());
    expect(JSON.parse(output.text)).toEqual(proposal());
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('Required JSON schema');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
    expect(fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Authorization');
  });

  it.each(['none', 'low', 'medium', 'high', 'max'] as const)('sends only the explicitly qualified chat effort %s without adding a credential', async reasoningEffort => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([{ choices: [{ delta: { content: JSON.stringify(proposal()) }, finish_reason: 'stop' }] }], { done: true }));
    const resolveCredential = vi.fn();
    const adapter = createNemotronProvider({ id: 'gx10', model: 'qualified-checkpoint', enabled: true, roles: ['explain'], endpoint: 'http://127.0.0.1:8112/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', authentication: { type: 'none' }, reasoningEffort }, { fetch: fetcher, resolveCredential });
    await adapter.generate(prepareContext(request(), 'local').input, runOptions());
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ model: 'qualified-checkpoint', reasoning_effort: reasoningEffort, response_format: { type: 'json_schema' } });
    expect(body).not.toHaveProperty('reasoning');
    expect(fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Authorization');
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(adapter.publicSettings().authentication).toBe('none');
  });

  it('rejects unsupported effort values and a chat-only setting on Responses instead of dropping it', () => {
    const configuration = { kind: 'nemotron', id: 'gx10', model: 'qualified-checkpoint', enabled: false, roles: ['explain'], endpoint: 'http://127.0.0.1:8112/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', authentication: { type: 'none' } };
    for (const reasoningEffort of ['minimal', 'xhigh', '', null, 0]) expect(nemotronProviderConfigSchema.safeParse({ ...configuration, reasoningEffort }).success).toBe(false);
    expect(nemotronProviderConfigSchema.safeParse({ ...configuration, protocol: 'openai-responses', reasoningEffort: 'none' }).success).toBe(false);
    expect(nemotronProviderConfigSchema.safeParse({ ...configuration, protocol: 'openai-responses' }).success).toBe(true);
  });

  it.each(['https://api.openai.com/v1/responses', 'http://192.168.1.2:8000/v1/chat/completions', 'http://secret@127.0.0.1:8000/v1/responses', 'http://127.0.0.1:8000/v1/responses?key=secret'])('rejects endpoint %s as an implicit local boundary', endpoint => {
    expect(() => createNemotronProvider({ id: 'gx10', model: 'observed-model', enabled: true, roles: ['route'], endpoint, protocol: 'openai-responses', outputMode: 'json-schema', authentication: { type: 'none' } })).toThrow();
  });

  it('does not accept an omitted local protocol', () => {
    expect(() => createNemotronProvider({ id: 'gx10', model: 'observed-model', roles: ['route'], endpoint: 'http://localhost:8000/v1/chat/completions', outputMode: 'json-schema', authentication: { type: 'none' } } as Parameters<typeof createNemotronProvider>[0])).toThrow();
  });
});

describe('SSE framing', () => {
  it('supports CRLF, comments and multiline data', async () => {
    const body = new Response(': comment\r\ndata: first\r\ndata: second\r\n\r\n').body!;
    const values: string[] = [];
    for await (const value of readSSE(body, new AbortController().signal)) values.push(value);
    expect(values).toEqual(['first\nsecond']);
  });
});
