import { describe, expect, it } from 'vitest';
import { chooseProvider, createAgentService, createProvider, type AgentRequest } from '../../packages/agent/src/index';
import { ProviderAvailabilityFailure } from '../../packages/agent/src/providers';
import { fakeProvider, request } from './fixtures';
const selected = (): AgentRequest => ({ ...request({ role: 'explain', policy: 'local-only' }),
  targets: [{ id: 'task:canvas', kind: 'canvas', revision: 1, canvas: { version: 1, title: 'Writing', subtitle: '', layout: 'focus', blocks: [{ id: 'text', kind: 'text', title: '', body: 'A clear idea.', placement: 'main', pinned: true, sourceIds: [] }] } }],
  canvasLearning: { targetId: 'task:canvas', canvasRevision: 1, scope: { blockId: 'text', selection: { field: 'body', start: 0, end: 'A clear idea.'.length, text: 'A clear idea.' } } },
});
const provider = (id: string, scoped = false) => createProvider({ id, kind: 'nemotron', model: id, endpoint: 'http://127.0.0.1:11434/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', roles: ['explain', 'prepare'], enabled: true, authentication: { type: 'none' }, ...(scoped ? { requestScope: 'canvas-selection' as const } : {}) });
describe('qualified selected-passage provider routing', () => {
  it('prefers a configured selected-passage provider only for an exact current selection', () => {
    const general = provider('general'), fast = provider('fast', true);
    expect(fast.publicSettings().requestScope).toBe('canvas-selection');
    expect(chooseProvider(selected(), [general, fast])).toBe(fast);
    expect(chooseProvider(request({ policy: 'local-only' }), [fast, general])).toBe(general);
    expect(chooseProvider(request({ policy: 'local-only' }), [fast])).toBeUndefined();
    const stale = selected(); stale.canvasLearning!.canvasRevision++;
    expect(chooseProvider(stale, [fast, general])).toBe(general);
  });
  it('keeps hybrid cloud preference and local-only boundaries', () => {
    const cloud = fakeProvider('cloud').provider, general = provider('general'), fast = provider('fast', true);
    expect(chooseProvider({ ...selected(), policy: 'hybrid' }, [general, fast, cloud])).toBe(cloud);
    expect(chooseProvider(selected(), [cloud, general, fast])).toBe(fast);
  });
  it('does not fall back from a general cloud request into a selection-only model', async () => {
    const cloud = fakeProvider('cloud'), scoped = fakeProvider('local');
    Object.assign(scoped.provider, { requestScope: 'canvas-selection' });
    cloud.generate.mockRejectedValue(new ProviderAvailabilityFailure('PROVIDER_UNAVAILABLE', 'Unavailable'));
    const service = createAgentService({ providers: [cloud.provider, scoped.provider], isCurrent: () => true });
    try { expect(await service.request(request())).toMatchObject({ status: 'unavailable' }); expect(scoped.generate).not.toHaveBeenCalled(); }
    finally { service.dispose(); }
  });
});
