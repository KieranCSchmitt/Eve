import { afterEach, describe, expect, it } from 'vitest';
import { startMediaPlayer, type MediaPlayerBridge } from '../../packages/media/src/bridge';
import type { MediaCommand } from '../../packages/media/src/protocol';

const source = { provider: 'youtube' as const, videoId: 'lVLzkleL_CE', url: 'https://www.youtube.com/watch?v=lVLzkleL_CE', startSeconds: 0 };
const scope = { taskId: 'orbit', taskEpoch: 3, generation: 4, sourceId: 'chrome-lesson' };
const snapshot = { videoId: source.videoId, currentTime: 12.5, duration: 80, playbackState: 'paused' };
const sessions: MediaPlayerBridge[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); await Promise.all(readers.splice(0).map(r => r.cancel().catch(() => {}))); });
async function create() {
  const player = await startMediaPlayer({ source, scope, title: 'CSS animations', appId: 'org.eve.Shell', commandTimeoutMs: 1000 });
  sessions.push(player);
  const response = await fetch(`${player.url}commands`);
  const reader = response.body!.getReader(); readers.push(reader);
  await reader.read();
  const post = (event: object, origin = new URL(player.url).origin) => fetch(`${player.url}events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ version: 1, scope, ...event }) });
  async function command(): Promise<MediaCommand> {
    const { value } = await reader.read();
    const data = new TextDecoder().decode(value).split('\n').find(line => line.startsWith('data: '));
    return JSON.parse(data!.slice(6));
  }
  return { player, post, command };
}
describe('media host bridge', () => {
  it('requires the private route, exact origin, bound source and generation', async () => {
    const { player, post } = await create();
    expect((await fetch(new URL('/', player.url))).status).toBe(404);
    expect((await post({ type: 'ready', snapshot }, 'https://evil.test')).status).toBe(403);
    expect((await post({ type: 'ready', snapshot, scope: { ...scope, generation: 5 } })).status).toBe(422);
    expect((await post({ type: 'ready', snapshot: { ...snapshot, videoId: '8FuafvJLDpM' } })).status).toBe(422);
    expect((await post({ type: 'ready', snapshot: { ...snapshot, currentTime: -1 } })).status).toBe(422);
    expect(player.checkpoint).toBeNull();
    expect((await post({ type: 'ready', snapshot })).status).toBe(204);
    expect(player.availability).toBe('ready');
  });
  it('freezes selection, waits for real paused acknowledgement and retains unavailable source position', async () => {
    const { player, post, command } = await create();
    await post({ type: 'ready', snapshot: { ...snapshot, playbackState: 'playing' } });
    const selection = { artifactId: 'config', revision: 7, text: 'transitionMs' };
    const result = player.captureContext({ selection });
    selection.text = 'later selection';
    const request = await command();
    expect(request.type).toBe('capture');
    expect(request.scope).toEqual(scope);
    await post({ type: 'command-result', requestId: request.requestId, ok: true, snapshot });
    const captured = await result;
    expect(captured.context.selection!.text).toBe('transitionMs');
    expect(captured.context.media).toEqual({ videoId: source.videoId, currentTime: 12.5, state: 'paused' });
    expect(captured.sourceMomentUrl).toContain('&t=12s');
    await post({ type: 'unavailable', reason: 'embedding-disabled', code: 150 });
    expect(player.availability).toBe('embedding-disabled');
    expect(player.checkpoint!.snapshot.currentTime).toBe(12.5);
    await expect(player.send({ type: 'pause' })).rejects.toThrow('not ready');
  });
  it('discards cancelled request acknowledgements and rejects work after teardown', async () => {
    const { player, post, command } = await create();
    await post({ type: 'ready', snapshot });
    const abort = new AbortController();
    const promise = player.send({ type: 'seek', seconds: 40 }, { signal: abort.signal });
    const rejected = expect(promise).rejects.toThrow('cancelled');
    const request = await command();
    abort.abort(new Error('cancelled'));
    await rejected;
    await post({ type: 'command-result', requestId: request.requestId, ok: true, snapshot: { ...snapshot, currentTime: 40 } });
    expect(player.checkpoint!.snapshot.currentTime).toBe(12.5);
    const waiting = player.send({ type: 'pause' });
    const closed = expect(waiting).rejects.toThrow('closed');
    await player.close(); await closed;
    expect(player.connected).toBe(false);
    expect(player.availability).toBe('closed');
  });
  it('cannot restore another task source or fabricate paused context from a playing acknowledgement', async () => {
    await expect(startMediaPlayer({ source, scope, title: 'CSS', appId: 'org.eve.Shell', checkpoint: { version: 1, scope: { ...scope, taskId: 'other' }, snapshot: { ...snapshot, playbackState: 'paused' }, capturedAt: 1 } })).rejects.toThrow('different source or task');
    const { player, post, command } = await create();
    await post({ type: 'ready', snapshot });
    const capture = player.captureContext();
    const error = expect(capture).rejects.toThrow('paused media position');
    const request = await command();
    await post({ type: 'command-result', requestId: request.requestId, ok: true, snapshot: { ...snapshot, playbackState: 'playing' } });
    await error;
  });
});
