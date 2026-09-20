import { z } from 'zod';
import {
  AgentFailure, agentRoleSchema,
  type AgentProvider, type ProviderInput, type ProviderOutput,
  type PublicProviderSettings, type Usage,
} from './contracts.js';

const common = {
  id: z.string().min(1).max(128), model: z.string().min(1).max(200),
  enabled: z.boolean().default(false), roles: z.array(agentRoleSchema).max(4),
  requestScope: z.literal('canvas-selection').optional(),
  maxOutputTokens: z.number().int().min(128).max(16_384).default(4096),
};
export const openAIProviderConfigSchema = z.object({
  ...common, kind: z.literal('openai'), credentialRef: z.string().min(1).max(200),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
}).strict();
/** Local runtimes/models must qualify this optional chat field; omission retains their default. */
export const nemotronReasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'max']);
export function validateNemotronReasoningProtocol(config: { protocol: string; reasoningEffort?: string }, context: z.RefinementCtx): void {
  if (config.reasoningEffort !== undefined && config.protocol !== 'openai-chat-completions') {
    context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Local reasoning effort is supported only for a qualified chat-completions runtime/model.' });
  }
}
export const nemotronProviderConfigSchema = z.object({
  ...common, kind: z.literal('nemotron'), endpoint: z.string().url(),
  protocol: z.enum(['openai-responses', 'openai-chat-completions']),
  outputMode: z.enum(['json-schema', 'json-object']),
  // https://docs.ollama.com/api/openai-compatibility — never infer support from a model name.
  reasoningEffort: nemotronReasoningEffortSchema.optional(),
  /** Set verified-disconnect only after the actual runtime passes cancellation qualification. */
  cancellationMode: z.enum(['verified-disconnect', 'unverified']).default('unverified'),
  maxGenerationMs: z.number().int().min(1000).max(300_000).default(120_000),
  authentication: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }).strict(),
    z.object({ type: z.literal('bearer'), credentialRef: z.string().min(1).max(200) }).strict(),
  ]),
}).strict().superRefine(validateNemotronReasoningProtocol);
export type OpenAIProviderConfig = z.input<typeof openAIProviderConfigSchema>;
export type NemotronProviderConfig = z.input<typeof nemotronProviderConfigSchema>;
export type ProviderConfig = OpenAIProviderConfig | NemotronProviderConfig;

export interface ProviderDependencies {
  fetch?: typeof globalThis.fetch;
  /** Called only in the trusted worker. Returned secrets never enter public settings. */
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  maxOutputCharacters?: number;
}

/** Only observed availability/transport failures may trigger a different provider.
 * Invalid model output, refusals and API configuration errors are deliberately excluded. */
export class ProviderAvailabilityFailure extends AgentFailure {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parseJSON(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new AgentFailure('INVALID_OUTPUT', 'The provider sent malformed JSON.'); }
}
function usage(value: unknown, protocol: 'responses' | 'chat'): Usage {
  const data = record(value);
  const safe = (key: string) => typeof data?.[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0 ? data[key] as number : undefined;
  return { inputTokens: safe(protocol === 'responses' ? 'input_tokens' : 'prompt_tokens'), outputTokens: safe(protocol === 'responses' ? 'output_tokens' : 'completion_tokens') };
}

function responseText(response: Record<string, unknown>): string {
  let text = '';
  if (!Array.isArray(response.output)) return text;
  for (const item of response.output) {
    const output = record(item);
    if (!output) continue;
    if (output.type === 'reasoning') continue;
    if (output.type !== 'message') throw new AgentFailure('UNSUPPORTED_ACTION', 'The provider attempted an unregistered tool operation.');
    if (!Array.isArray(output.content)) continue;
    for (const part of output.content) {
      const content = record(part);
      if (content?.type === 'refusal') throw new AgentFailure('PROVIDER_REFUSAL', 'The provider declined this request.');
      if (content?.type === 'output_text' && typeof content.text === 'string') text += content.text;
    }
  }
  return text;
}

/** SSE parser with split UTF-8/chunk handling, multiline data, and bounded event buffers. */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (bytes?: Uint8Array, stream = false) => {
    try { return decoder.decode(bytes, { stream }); }
    catch { throw new AgentFailure('INVALID_OUTPUT', 'The provider stream contained invalid UTF-8.'); }
  };
  let buffer = '';
  let totalBytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new AgentFailure('CANCELLED', 'The request was cancelled.');
      const chunk = await reader.read();
      if (signal.aborted) throw new AgentFailure('CANCELLED', 'The request was cancelled.');
      if (chunk.done) { buffer += decode(); break; }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > 2_000_000) throw new AgentFailure('INVALID_OUTPUT', 'The provider stream exceeded its size limit.');
      buffer += decode(chunk.value, true);
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        if (boundary.index > 131_072) throw new AgentFailure('INVALID_OUTPUT', 'A provider event exceeded its size limit.');
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 131_072) throw new AgentFailure('INVALID_OUTPUT', 'A provider event exceeded its size limit.');
    }
    if (buffer.trim()) throw new ProviderAvailabilityFailure('INCOMPLETE_OUTPUT', 'The provider stream ended mid-event.');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateLocalEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AgentFailure('INVALID_REQUEST', 'The local model endpoint must be an explicitly configured loopback URL without credentials or query parameters. Use a scoped SSH forward for a remote GX10.');
  }
}

export function createProvider(configuration: ProviderConfig, dependencies: ProviderDependencies = {}): AgentProvider {
  const result = configuration.kind === 'openai' ? openAIProviderConfigSchema.safeParse(configuration) : nemotronProviderConfigSchema.safeParse(configuration);
  if (!result.success) throw new AgentFailure('INVALID_REQUEST', 'The provider configuration is incomplete or invalid.');
  const config = result.data;
  const kind = config.kind === 'openai' ? 'cloud' : 'local';
  const protocol = config.kind === 'openai' ? 'openai-responses' : config.protocol;
  const endpoint = config.kind === 'openai' ? 'https://api.openai.com/v1/responses' : config.endpoint;
  if (config.kind === 'nemotron') validateLocalEndpoint(endpoint);
  const credentialRef = config.kind === 'openai' ? config.credentialRef : config.authentication.type === 'bearer' ? config.authentication.credentialRef : undefined;
  const outputMode = config.kind === 'openai' ? 'json-schema' : config.outputMode;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const maxOutputCharacters = dependencies.maxOutputCharacters ?? 64_000;
  const publicSettings: PublicProviderSettings = Object.freeze({
    id: config.id, kind, model: config.model, enabled: config.enabled, protocol, endpoint,
    roles: Object.freeze([...config.roles]), authentication: credentialRef ? 'credential-store' : 'none',
    ...(config.requestScope ? { requestScope: config.requestScope } : {}),
    ...(config.kind === 'nemotron' ? { cancellationMode: config.cancellationMode } : {}),
  });

  return {
    id: config.id, kind, model: config.model, enabled: config.enabled, roles: publicSettings.roles,
    ...(config.requestScope ? { requestScope: config.requestScope } : {}),
    publicSettings: () => publicSettings,
    async generate(input, options): Promise<ProviderOutput> {
      if (!config.enabled) throw new AgentFailure('PROVIDER_UNAVAILABLE', 'This model provider is not enabled.');
      const drainOnCancel = config.kind === 'nemotron' && config.cancellationMode === 'unverified';
      const transportAbort = new AbortController();
      const abortTransport = () => transportAbort.abort();
      if (!drainOnCancel) options.signal.addEventListener('abort', abortTransport, { once: true });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let requestStarted = false;
      let remoteFinished = false;
      try {
        if (options.signal.aborted) throw new AgentFailure('CANCELLED', 'The request was cancelled.');
        const secret = credentialRef ? await dependencies.resolveCredential?.(credentialRef) : undefined;
        if (credentialRef && !secret) throw new AgentFailure('CREDENTIALS_UNAVAILABLE', 'Add the provider credential through Eve’s secure configuration flow.');
        if (options.signal.aborted) throw new AgentFailure('CANCELLED', 'The request was cancelled.');
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
        if (secret) headers.Authorization = `Bearer ${secret}`;
        if (input.maxOutputTokens !== undefined && (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 128 || input.maxOutputTokens > 16_384)) throw new AgentFailure('INVALID_REQUEST', 'The request output budget is invalid.');
        const outputTokens = Math.min(config.maxOutputTokens, input.maxOutputTokens ?? config.maxOutputTokens);
        const body = protocol === 'openai-responses' ? responsesBody(config.model, input, outputMode, outputTokens, config.kind === 'openai' ? config.reasoningEffort : undefined) : chatBody(config.model, input, outputMode, outputTokens, config.kind === 'nemotron' ? config.reasoningEffort : undefined);
        deadline = setTimeout(abortTransport, config.kind === 'nemotron' ? config.maxGenerationMs : 120_000);
        requestStarted = true;
        const response = await fetcher(endpoint, {
          method: 'POST', headers, body: JSON.stringify(body), signal: transportAbort.signal, redirect: 'error',
        });
        if (!response.ok) {
          remoteFinished = true;
          // Never surface raw upstream bodies: they can echo source text or credentials.
          const Failure = [401, 403, 408, 429].includes(response.status) || response.status >= 500 ? ProviderAvailabilityFailure : AgentFailure;
          throw new Failure(response.status === 401 || response.status === 403 ? 'CREDENTIALS_UNAVAILABLE' : 'PROVIDER_ERROR', `The provider returned HTTP ${response.status}. No action was applied.`);
        }
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
          throw new AgentFailure('PROVIDER_ERROR', 'This endpoint did not return the configured streaming protocol. Qualify its API settings.');
        }
        let text = '';
        let completed = false;
        let stats: Usage = {};
        const append = (delta: string) => {
          text += delta;
          if (text.length > maxOutputCharacters) throw new AgentFailure('INVALID_OUTPUT', 'The model response exceeded its size limit.');
          if (!options.signal.aborted) options.onTextDelta(delta);
        };
        for await (const eventData of readSSE(response.body, transportAbort.signal)) {
          if (eventData === '[DONE]') break;
          const event = record(parseJSON(eventData));
          if (!event) throw new AgentFailure('INVALID_OUTPUT', 'The provider sent an invalid event.');
          if (protocol === 'openai-responses') {
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') append(event.delta);
            if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') throw new AgentFailure('PROVIDER_REFUSAL', 'The provider declined this request.');
            if (event.type === 'error' || event.type === 'response.failed') {
              remoteFinished = true;
              const code = record(event.error)?.code ?? record(record(event.response)?.error)?.code ?? event.code;
              const Failure = ['server_error', 'rate_limit_exceeded', 'server_is_overloaded', 'service_unavailable', 'slow_down'].includes(String(code)) ? ProviderAvailabilityFailure : AgentFailure;
              throw new Failure('PROVIDER_ERROR', 'The provider could not complete this request.');
            }
            if (event.type === 'response.incomplete') { remoteFinished = true; throw new AgentFailure('INCOMPLETE_OUTPUT', 'The model response was incomplete. Try a smaller request.'); }
            if (event.type === 'response.completed') {
              remoteFinished = true;
              const final = record(event.response);
              if (!final || final.status !== 'completed') throw new AgentFailure('INCOMPLETE_OUTPUT', 'The model response was incomplete.');
              const canonical = responseText(final);
              if (canonical) text = canonical;
              stats = usage(final.usage, 'responses');
              completed = true;
              break;
            }
          } else {
            if (event.error) { remoteFinished = true; throw new AgentFailure('PROVIDER_ERROR', 'The local provider could not complete this request.'); }
            if (event.usage) stats = usage(event.usage, 'chat');
            if (Array.isArray(event.choices)) for (const rawChoice of event.choices) {
              const choice = record(rawChoice);
              const delta = record(choice?.delta);
              if (delta?.tool_calls || delta?.function_call) throw new AgentFailure('UNSUPPORTED_ACTION', 'The provider attempted an unregistered tool operation.');
              if (delta?.refusal) throw new AgentFailure('PROVIDER_REFUSAL', 'The provider declined this request.');
              if (typeof delta?.content === 'string') append(delta.content);
              if (choice?.finish_reason) remoteFinished = true;
              if (choice?.finish_reason === 'stop') completed = true;
              else if (choice?.finish_reason) throw new AgentFailure('INCOMPLETE_OUTPUT', 'The local model response was incomplete or attempted an unsupported operation.');
            }
          }
        }
        if (!completed) throw new ProviderAvailabilityFailure('INCOMPLETE_OUTPUT', 'The provider disconnected before a complete response arrived.');
        if (!text.trim()) throw new AgentFailure('INCOMPLETE_OUTPUT', 'The provider returned an empty response.');
        if (text.length > maxOutputCharacters) throw new AgentFailure('INVALID_OUTPUT', 'The model response exceeded its size limit.');
        return { text, usage: stats };
      } catch (error) {
        if (drainOnCancel && requestStarted && !remoteFinished) throw new AgentFailure('LOCAL_STATE_UNKNOWN', 'The local connection ended before inference completion was confirmed. Check that the runtime is idle before requalifying this provider.');
        if (options.signal.aborted) throw new AgentFailure('CANCELLED', 'The request was cancelled.');
        if (error instanceof AgentFailure) throw error;
        throw new ProviderAvailabilityFailure('PROVIDER_ERROR', 'The provider connection failed. Your work is unchanged.');
      } finally {
        if (deadline) clearTimeout(deadline);
        options.signal.removeEventListener('abort', abortTransport);
      }
    },
  };
}

function responsesBody(model: string, input: ProviderInput, mode: 'json-schema' | 'json-object', maxTokens: number, effort?: string): Record<string, unknown> {
  return {
    model, instructions: mode === 'json-object' ? `${input.instructions}\nRequired JSON schema: ${JSON.stringify(input.schema)}` : input.instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: input.data }] }],
    text: { format: mode === 'json-schema' ? { type: 'json_schema', name: 'eve_proposal', strict: true, schema: input.schema } : { type: 'json_object' } },
    max_output_tokens: maxTokens, stream: true, store: false,
    ...(effort ? { reasoning: { effort } } : {}),
  };
}

function chatBody(model: string, input: ProviderInput, mode: 'json-schema' | 'json-object', maxTokens: number, effort?: z.infer<typeof nemotronReasoningEffortSchema>): Record<string, unknown> {
  return {
    model,
    messages: [
      // Ollama's grammar constrains decoding; the model also needs to see the
      // schema to choose meaningful branches and fields instead of guessing.
      // https://docs.ollama.com/capabilities/structured-outputs
      { role: 'system', content: `${input.instructions}\nRequired JSON schema: ${JSON.stringify(input.schema)}` },
      { role: 'user', content: input.data },
    ],
    response_format: mode === 'json-schema' ? { type: 'json_schema', json_schema: { name: 'eve_proposal', strict: true, schema: input.schema } } : { type: 'json_object' },
    max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, temperature: 0,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  };
}

export function createOpenAIProvider(config: Omit<OpenAIProviderConfig, 'kind'>, dependencies?: ProviderDependencies): AgentProvider {
  return createProvider({ ...config, kind: 'openai' }, dependencies);
}
export function createNemotronProvider(config: Omit<NemotronProviderConfig, 'kind'>, dependencies?: ProviderDependencies): AgentProvider {
  return createProvider({ ...config, kind: 'nemotron' }, dependencies);
}
