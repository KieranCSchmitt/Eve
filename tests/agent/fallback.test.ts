import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFailure, createAgentService, createOpenAIProvider, type AgentService } from '../../packages/agent/src/index.js';
import { ProviderAvailabilityFailure } from '../../packages/agent/src/providers.js';
import { fakeProvider, flush, pendingOutput, proposal, request, sseResponse } from './fixtures.js';

const services: AgentService[] = [];
const make = (options: Parameters<typeof createAgentService>[0]) => { const service = createAgentService(options); services.push(service); return service; };
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); });

describe('cloud primary with a qualified local backup', () => {
  it.each(['explain', 'code', 'prepare', 'route'] as const)('prefers cloud for the hybrid %s role', async role => {
    const cloud = fakeProvider('cloud'), local = fakeProvider('local');
    const service = make({ providers: [local.provider, cloud.provider], isCurrent: () => true });
    expect(await service.request(request({ role }))).toMatchObject({ status: 'complete', provider: { kind: 'cloud' } });
    expect(local.generate).not.toHaveBeenCalled();
  });
  it.each([401, 403, 408, 429, 500, 503])('falls back after HTTP %s without exposing upstream bodies', async status => {
    const cloud = createOpenAIProvider({ id: 'primary', model: 'configured', credentialRef: 'key', enabled: true, roles: ['explain'] }, { resolveCredential: async () => 'private-key', fetch: vi.fn().mockResolvedValue(new Response('private upstream body', { status })) });
    const local = fakeProvider('local', proposal({ actions: [{ type: 'ProposeNoteEdit', targetId: 'note-1', expectedRevision: 4, text: 'Reviewed draft' }] }));
    const service = make({ providers: [cloud, local.provider], isCurrent: () => true });
    const input = request(); const first = service.request(input);
    expect(service.request(input)).toBe(first);
    const result = await first;
    expect(result).toMatchObject({ status: 'complete', provider: { kind: 'local' }, origin: 'model-proposal', requiresUserAction: true, actions: [{ type: 'ProposeNoteEdit' }] });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(local.generate).toHaveBeenCalledOnce();
    expect(await service.request(input)).toBe(result);
  });
  it('uses local when the primary credential is absent or the cloud cap is exhausted', async () => {
    const cloud = fakeProvider('cloud'), local = fakeProvider('local');
    cloud.generate.mockRejectedValue(new AgentFailure('CREDENTIALS_UNAVAILABLE', 'Missing credential'));
    expect(await make({ providers: [cloud.provider, local.provider], isCurrent: () => true }).request(request())).toMatchObject({ provider: { kind: 'local' } });
    cloud.generate.mockClear();
    expect(await make({ providers: [cloud.provider, local.provider], isCurrent: () => true, maxCloudRequests: 0 }).request(request())).toMatchObject({ provider: { kind: 'local' } });
    expect(cloud.generate).not.toHaveBeenCalled();
  });
  it.each(['local-only', 'offline'] as const)('never escalates %s to cloud', async policy => {
    const cloud = fakeProvider('cloud'), local = fakeProvider('local');
    local.generate.mockRejectedValue(new ProviderAvailabilityFailure('PROVIDER_ERROR', 'Unavailable'));
    const result = await make({ providers: [cloud.provider, local.provider], isCurrent: () => true }).request(request({ policy }));
    expect(result).toMatchObject({ status: 'failed' }); expect(cloud.generate).not.toHaveBeenCalled();
  });
  it.each(['PROVIDER_REFUSAL', 'INVALID_OUTPUT', 'UNKNOWN_SOURCE', 'UNSUPPORTED_ACTION', 'INCOMPLETE_OUTPUT', 'PROVIDER_ERROR'] as const)('does not retry terminal %s on another model', async code => {
    const cloud = fakeProvider('cloud'), local = fakeProvider('local');
    cloud.generate.mockRejectedValue(new AgentFailure(code, 'Terminal response'));
    expect(await make({ providers: [cloud.provider, local.provider], isCurrent: () => true }).request(request())).toMatchObject({ code });
    expect(local.generate).not.toHaveBeenCalled();
  });
  it('does not hide an invalid HTTP configuration by switching models', async () => {
    const cloud = createOpenAIProvider({ id: 'primary', model: 'configured', credentialRef: 'key', enabled: true, roles: ['explain'] }, { resolveCredential: async () => 'private-key', fetch: vi.fn().mockResolvedValue(new Response('', { status: 400 })) });
    const local = fakeProvider('local');
    expect(await make({ providers: [cloud, local.provider], isCurrent: () => true }).request(request())).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(local.generate).not.toHaveBeenCalled();
  });
  it.each(['network', 'disconnected-stream', 'overloaded-event'] as const)('uses local after %s failure', async scenario => {
    const fetcher = vi.fn();
    if (scenario === 'network') fetcher.mockRejectedValue(new TypeError('Connection unavailable'));
    else fetcher.mockResolvedValue(sseResponse(scenario === 'overloaded-event' ? [{ type:'response.failed', response:{ error:{ code:'server_is_overloaded' } } }] : [{type:'response.output_text.delta',delta:'{"unfinished":'}]));
    const cloud=createOpenAIProvider({id:'primary',model:'configured',credentialRef:'key',enabled:true,roles:['explain']},{resolveCredential:async()=> 'private-key',fetch:fetcher});
    const local=fakeProvider('local');
    expect(await make({providers:[cloud,local.provider],isCurrent:()=>true}).request(request())).toMatchObject({status:'complete',provider:{kind:'local'}});
    expect(local.generate).toHaveBeenCalledOnce();
  });
  it('does not retry invalid UTF-8 as a connection failure', async () => {
    const response = new Response(new Uint8Array([0xff, 0xfe]),{headers:{'content-type':'text/event-stream'}});
    const cloud=createOpenAIProvider({id:'primary',model:'configured',credentialRef:'key',enabled:true,roles:['explain']},{resolveCredential:async()=> 'private-key',fetch:vi.fn().mockResolvedValue(response)});
    const local=fakeProvider('local');
    expect(await make({providers:[cloud,local.provider],isCurrent:()=>true}).request(request())).toMatchObject({code:'INVALID_OUTPUT'});
    expect(local.generate).not.toHaveBeenCalled();
  });
  it('waits for the timed-out primary to settle before starting local', async () => {
    vi.useFakeTimers();
    const cloud = fakeProvider('cloud'), local = fakeProvider('local'), output = pendingOutput();
    cloud.generate.mockReturnValue(output.promise);
    const service = make({ providers: [cloud.provider, local.provider], isCurrent: () => true, requestTimeoutMs: 20 });
    const pending = service.request(request()); await vi.advanceTimersByTimeAsync(21);
    expect(cloud.generate.mock.calls[0]![1].signal.aborted).toBe(true); expect(local.generate).not.toHaveBeenCalled();
    output.finish();
    expect(await pending).toMatchObject({ status: 'complete', provider: { kind: 'local' } });
  });
  it('uses the separate local budget without extending the primary attempt', async () => {
    vi.useFakeTimers();
    const cloud=fakeProvider('cloud'),local=fakeProvider('local'),output=pendingOutput();
    cloud.generate.mockRejectedValue(new ProviderAvailabilityFailure('PROVIDER_ERROR','Disconnected'));
    local.generate.mockReturnValue(output.promise);
    const service=make({providers:[cloud.provider,local.provider],isCurrent:()=>true,requestTimeoutMs:20,localRequestTimeoutMs:100});
    const pending=service.request(request());await flush();
    await vi.advanceTimersByTimeAsync(21);
    expect(local.generate.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(80);
    expect(await pending).toMatchObject({status:'failed',code:'TIMEOUT'});
    expect(service.getJobCounts().local).toBe(1);
    output.finish();await flush();expect(service.getJobCounts().local).toBe(0);
  });
  it.each(['cancel', 'stale'] as const)('does not start fallback when the request becomes %s', async change => {
    const cloud = fakeProvider('cloud'), local = fakeProvider('local');
    let reject!: (reason: Error) => void, current = true;
    cloud.generate.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const service = make({ providers: [cloud.provider, local.provider], isCurrent: () => current });
    const input = request(), pending = service.request(input);
    if (change === 'cancel') service.cancel(input.intent.id); else current = false;
    reject(new ProviderAvailabilityFailure('PROVIDER_ERROR', 'Disconnected'));
    expect(await pending).toMatchObject({ status: change === 'cancel' ? 'cancelled' : 'stale' }); await flush();
    expect(local.generate).not.toHaveBeenCalled();
  });
  it('waits for an existing cancelled local generation to drain before fallback', async () => {
    const cloud = fakeProvider('cloud'), local = fakeProvider('local'), draining = pendingOutput();
    local.generate.mockReturnValueOnce(draining.promise);
    cloud.generate.mockRejectedValue(new ProviderAvailabilityFailure('PROVIDER_ERROR', 'Disconnected'));
    const service = make({ providers: [cloud.provider, local.provider], isCurrent: () => true });
    const background = service.request(request({ policy: 'local-only', priority: 'background', role: 'prepare' }));
    const foreground = service.request(request());
    expect(await background).toMatchObject({ status: 'cancelled' }); await flush();
    expect(service.getJobCounts()).toMatchObject({ local: 1, queued: 1 }); expect(local.generate).toHaveBeenCalledOnce();
    draining.finish();
    expect(await foreground).toMatchObject({ status: 'complete', provider: { kind: 'local' } });
    expect(local.generate).toHaveBeenCalledTimes(2);
  });
});
