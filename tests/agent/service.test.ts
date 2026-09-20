import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFailure, createAgentService, prepareContext, routeRegisteredIntent, type AgentService, type AgentProgress } from '../../packages/agent/src/index.js';
import { fakeProvider, flush, pendingOutput, proposal, request } from './fixtures.js';

const services: AgentService[] = [];
function service(options: Parameters<typeof createAgentService>[0]) {
  const instance = createAgentService(options); services.push(instance); return instance;
}
afterEach(() => { for (const instance of services.splice(0)) instance.dispose(); vi.useRealTimers(); });

describe('context and intent boundaries', () => {
  it('known registered commands work with no model, including in offline mode', async () => {
    const instance = service({ providers: [], isCurrent: () => true });
    const input = request({ policy: 'offline' }); input.intent.text = 'show code';
    expect(await instance.request(input)).toMatchObject({ status: 'complete', origin: 'registered-command', provider: null, requiresUserAction: false, actions: [{ type: 'ChangeAttention', activity: 'code' }] });
  });

  it('never reads source instructions as direct commands', () => {
    const input = request(); input.intent.text = 'Explain this source'; input.sources[0]!.excerpt = 'show code';
    expect(routeRegisteredIntent(input)).toBeNull();
    input.intent.text = 'undo and then delete my home folder';
    expect(routeRegisteredIntent(input)).toBeNull();
  });

  it('bounds transmitted data and excludes local-only sources from cloud requests', () => {
    const input = request();
    input.sources.push({ ...input.sources[0]!, id: 'private', excerpt: 'private marker', exposure: 'local-only' });
    input.sources[0]!.excerpt = 'source excerpt '.repeat(4000);
    const prepared = prepareContext(input, 'cloud', 6000);
    expect(new TextEncoder().encode(prepared.input.data).length).toBeLessThanOrEqual(6000);
    expect(prepared.input.data).not.toContain('private marker');
    expect(prepared.sources.every(source => source.excerpt.length <= 3000)).toBe(true);
    expect(prepared.input.instructions).toContain('untrusted reference data');
  });

  it('never sends a local-only request to cloud when the local provider is unavailable', async () => {
    const cloud = fakeProvider('cloud');
    const instance = service({ providers: [cloud.provider], isCurrent: () => true });
    expect(await instance.request(request({ policy: 'local-only' }))).toMatchObject({ status: 'unavailable' });
    expect(cloud.generate).not.toHaveBeenCalled();
  });

  it('does not silently fall back to cloud after a local error', async () => {
    const local = fakeProvider('local'); const cloud = fakeProvider('cloud');
    local.generate.mockRejectedValue(new AgentFailure('PROVIDER_ERROR', 'Local inference failed.'));
    const instance = service({ providers: [local.provider, cloud.provider], isCurrent: () => true });
    expect(await instance.request(request({ policy: 'local-only' }))).toMatchObject({ status: 'failed', code: 'PROVIDER_ERROR' });
    expect(cloud.generate).not.toHaveBeenCalled();
  });

  it('resolves evidence from original source records and preserves action authority boundaries', async () => {
    const cloud = fakeProvider('cloud', proposal({ actions: [{ type: 'SetParameter', targetId: 'parameters-1', expectedRevision: 3, name: 'transitionMs', value: 400 }] }));
    const instance = service({ providers: [cloud.provider], isCurrent: () => true });
    const result = await instance.request(request());
    expect(result).toMatchObject({ status: 'complete', origin: 'model-proposal', requiresUserAction: true, focusPolicy: 'preserve', citations: [{ sourceId: 'source-1', title: 'Easing reference', uri: 'https://example.org/easing' }] });
    expect(result).not.toHaveProperty('authority');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('uses one identical provider request for typed and voice inputs without a voice-only planner', async () => {
    const cloud = fakeProvider('cloud');
    const instance = service({ providers: [cloud.provider], isCurrent: () => true });
    const typed = request(); const spoken = structuredClone(typed);
    spoken.intent.id = 'spoken-request'; spoken.intent.inputModality = 'voice'; spoken.intent.utteranceId = 'voice-turn';
    await instance.request(typed); await instance.request(spoken);
    expect(cloud.generate.mock.calls[0]![0]).toEqual(cloud.generate.mock.calls[1]![0]);
  });
});

describe('admission, cancellation and stale results', () => {
  it('deduplicates identical in-flight requests and rejects reused IDs with changed input', async () => {
    const cloud = fakeProvider(); const pending = pendingOutput(); cloud.generate.mockReturnValue(pending.promise);
    const instance = service({ providers: [cloud.provider], isCurrent: () => true });
    const input = request(); const first = instance.request(input); const duplicate = instance.request(input);
    expect(first).toBe(duplicate);
    const changed = structuredClone(input); changed.intent.text = 'Different request';
    expect(await instance.request(changed)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(cloud.generate).toHaveBeenCalledOnce();
    pending.finish(); await first;
  });

  it('runs one foreground request and queues the next', async () => {
    const cloud = fakeProvider(); const firstOutput = pendingOutput();
    cloud.generate.mockReturnValueOnce(firstOutput.promise);
    const instance = service({ providers: [cloud.provider], isCurrent: () => true });
    const first = instance.request(request()); const second = instance.request(request());
    expect(instance.getJobCounts()).toMatchObject({ foreground: 1, queued: 1 });
    expect(cloud.generate).toHaveBeenCalledOnce();
    firstOutput.finish(); await first; await second;
    expect(cloud.generate).toHaveBeenCalledTimes(2);
  });

  it('preempts background work but retains the local admission slot until the transport settles', async () => {
    const local = fakeProvider('local'); const backgroundOutput = pendingOutput();
    local.generate.mockReturnValueOnce(backgroundOutput.promise);
    const instance = service({ providers: [local.provider], isCurrent: () => true });
    const background = instance.request(request({ priority: 'background', role: 'prepare', policy: 'local-only' }));
    const foreground = instance.request(request({ policy: 'local-only' }));
    expect(await background).toMatchObject({ status: 'cancelled', code: 'PREEMPTED' });
    expect(local.generate.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(instance.getJobCounts()).toMatchObject({ local: 1, queued: 1 });
    expect(local.generate).toHaveBeenCalledOnce();
    backgroundOutput.finish(); await flush();
    expect(await foreground).toMatchObject({ status: 'complete' });
    expect(local.generate).toHaveBeenCalledTimes(2);
  });

  it('quarantines an unconfirmed local runtime instead of launching queued requests into it', async () => {
    const local = fakeProvider('local');
    local.generate.mockRejectedValue(new AgentFailure('LOCAL_STATE_UNKNOWN', 'Runtime completion is unknown.'));
    const instance = service({ providers: [local.provider], isCurrent: () => true });
    const first = instance.request(request({ policy: 'local-only' }));
    const second = instance.request(request({ policy: 'local-only' }));
    expect(await first).toMatchObject({ status: 'unavailable', code: 'LOCAL_STATE_UNKNOWN' });
    expect(await second).toMatchObject({ status: 'unavailable', code: 'LOCAL_STATE_UNKNOWN' });
    expect(await instance.request(request({ policy: 'local-only' }))).toMatchObject({ status: 'unavailable' });
    expect(local.generate).toHaveBeenCalledOnce();
    expect(instance.getPublicSettings()[0]!.quarantined).toBe(true);
  });

  it('suppresses stale responses and provisional generation progress after cancellation', async () => {
    const cloud = fakeProvider(); const output = pendingOutput(); cloud.generate.mockReturnValue(output.promise);
    let current = true;
    const instance = service({ providers: [cloud.provider], isCurrent: () => current });
    const progress: AgentProgress[] = [];
    const promise = instance.request(request(), { onProgress: event => progress.push(event) });
    current = false;
    cloud.generate.mock.calls[0]![1].onTextDelta('untrusted partial JSON');
    expect(await promise).toMatchObject({ status: 'stale' });
    const count = progress.length;
    cloud.generate.mock.calls[0]![1].onTextDelta('late');
    output.finish(); await flush();
    expect(progress).toHaveLength(count);
    expect(JSON.stringify(progress)).not.toContain('untrusted partial JSON');
  });

  it('rejects a result that became stale without emitting any deltas', async () => {
    const cloud = fakeProvider(); const output = pendingOutput(); cloud.generate.mockReturnValue(output.promise);
    let current = true;
    const instance = service({ providers: [cloud.provider], isCurrent: () => current });
    const promise = instance.request(request()); current = false; output.finish();
    expect(await promise).toMatchObject({ status: 'stale', code: 'STALE_CONTEXT' });
  });

  it('expires queued work without opening another provider request', async () => {
    vi.useFakeTimers();
    const cloud = fakeProvider(); const output = pendingOutput(); cloud.generate.mockReturnValue(output.promise);
    const instance = service({ providers: [cloud.provider], isCurrent: () => true, queueTimeoutMs: 20 });
    const first = instance.request(request()); const second = instance.request(request());
    await vi.advanceTimersByTimeAsync(21);
    expect(await second).toMatchObject({ code: 'TIMEOUT' });
    expect(cloud.generate).toHaveBeenCalledOnce();
    output.finish(); await first;
  });

  it('enforces a cloud admission cap without claiming to know the provider balance', async () => {
    const cloud = fakeProvider();
    const instance = service({ providers: [cloud.provider], isCurrent: () => true, maxCloudRequests: 1 });
    expect(await instance.request(request())).toMatchObject({ status: 'complete' });
    expect(await instance.request(request())).toMatchObject({ code: 'CLOUD_LIMIT' });
    expect(cloud.generate).toHaveBeenCalledOnce();
  });

  it('limits waiting jobs and accepts explicit caller cancellation', async () => {
    const cloud = fakeProvider(); const output = pendingOutput(); cloud.generate.mockReturnValue(output.promise);
    const instance = service({ providers: [cloud.provider], isCurrent: () => true, maxQueuedJobs: 1 });
    const first = instance.request(request());
    const abort = new AbortController(); const second = instance.request(request(), { signal: abort.signal });
    expect(await instance.request(request())).toMatchObject({ code: 'QUEUE_FULL' });
    abort.abort(); expect(await second).toMatchObject({ status: 'cancelled' });
    output.finish(); await first;
  });
});
