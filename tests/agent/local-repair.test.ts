import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentService, type AgentService } from '../../packages/agent/src/index.js';
import { fakeProvider, flush, pendingOutput, proposal, request } from './fixtures.js';
import { prepareContext } from '../../packages/agent/src/context.js';

const services: AgentService[] = [];
const make = (options: Parameters<typeof createAgentService>[0]) => { const service = createAgentService(options); services.push(service); return service; };
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); });

describe('bounded local proposal correction', () => {
  it('corrects invalid local JSON once without exposing the draft or changing context', async () => {
    const local = fakeProvider('local');
    local.generate.mockResolvedValueOnce({ text: '{"invalid":"untrusted draft"}', usage: { inputTokens: 10, outputTokens: 20 } });
    const input = request({ policy: 'local-only' });
    const service = make({ providers: [local.provider], isCurrent: () => true });
    const result = await service.request(input);
    expect(result).toMatchObject({ status: 'complete', usage: { inputTokens: 110, outputTokens: 70 }, context: input.context });
    expect(local.generate).toHaveBeenCalledTimes(2);
    const [first, second] = local.generate.mock.calls;
    const data = JSON.parse(second![0].data);
    const { validationFeedback, ...original } = data;
    expect(original).toEqual(JSON.parse(first![0].data));
    expect(validationFeedback).toMatchObject({ previousResponse: '{"invalid":"untrusted draft"}', previousResponseTruncated: false });
    expect(validationFeedback.error).toMatch(/valid|proposal|message|version/i);
    expect(second![0].schema).toBe(first![0].schema);
    expect(second![1].signal).toBe(first![1].signal);
    expect(JSON.stringify(result)).not.toContain('untrusted draft');
  });
  it('stops after a second invalid draft', async () => {
    const local = fakeProvider('local', { invalid: true });
    const result = await make({ providers: [local.provider], isCurrent: () => true }).request(request({ policy: 'local-only' }));
    expect(result).toMatchObject({ status: 'failed', code: 'INVALID_OUTPUT' });
    expect(local.generate).toHaveBeenCalledTimes(2);
  });
  it('bounds correction feedback without truncating the captured original request', async () => {
    const local = fakeProvider('local'), input = request({ policy: 'local-only' });
    const initial = prepareContext(input, 'local', 24_000).input;
    const maxContextBytes = Buffer.byteLength(initial.data) + 800;
    local.generate.mockResolvedValueOnce({ text: JSON.stringify({ draft: 'x'.repeat(8000) }), usage: {} });
    expect(await make({ providers: [local.provider], isCurrent: () => true, maxContextBytes }).request(input)).toMatchObject({ status: 'complete' });
    const corrected = local.generate.mock.calls[1]![0];
    expect(Buffer.byteLength(corrected.data)).toBeLessThanOrEqual(maxContextBytes);
    const { validationFeedback, ...original } = JSON.parse(corrected.data);
    expect(original).toEqual(JSON.parse(initial.data));
    expect(validationFeedback.previousResponseTruncated).toBe(true);
  });
  it('does not repair or switch models for an invalid cloud draft', async () => {
    const cloud = fakeProvider('cloud', { invalid: true }), local = fakeProvider('local');
    expect(await make({ providers: [cloud.provider, local.provider], isCurrent: () => true }).request(request())).toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(cloud.generate).toHaveBeenCalledOnce(); expect(local.generate).not.toHaveBeenCalled();
  });
  it('does not turn an unknown source into a correction loop', async () => {
    const local = fakeProvider('local', proposal({ citations: [{ sourceId: 'invented', quote: 'invented' }] }));
    expect(await make({ providers: [local.provider], isCurrent: () => true }).request(request({ policy: 'local-only' }))).toMatchObject({ code: 'UNKNOWN_SOURCE' });
    expect(local.generate).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'stale'] as const)('does not repair when the original request becomes %s', async change => {
    const local = fakeProvider('local'), first = pendingOutput(); let current = true;
    local.generate.mockReturnValueOnce(first.promise);
    const service = make({ providers: [local.provider], isCurrent: () => current });
    const input = request({ policy: 'local-only' }), pending = service.request(input);
    if (change === 'cancel') service.cancel(input.intent.id); else current = false;
    first.finish({ invalid: true });
    expect(await pending).toMatchObject({ status: change === 'cancel' ? 'cancelled' : 'stale' });
    expect(local.generate).toHaveBeenCalledOnce();
  });
  it('uses the remaining deadline and retains the local slot until correction drains', async () => {
    vi.useFakeTimers();
    const local = fakeProvider('local'), first = pendingOutput(), correction = pendingOutput();
    local.generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(correction.promise);
    const service = make({ providers: [local.provider], isCurrent: () => true, localRequestTimeoutMs: 100 });
    const pending = service.request(request({ policy: 'local-only' }));
    await vi.advanceTimersByTimeAsync(80); first.finish({ invalid: true }); await flush();
    expect(local.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: 'failed', code: 'TIMEOUT' });
    expect(local.generate.mock.calls[1]![1].signal.aborted).toBe(true);
    expect(service.getJobCounts().local).toBe(1);
    correction.finish(); await flush(); expect(service.getJobCounts().local).toBe(0);
  });
});
