import { randomBytes } from 'node:crypto';
import { mediaScopeSchema, type MediaScope } from './protocol';
import { applicationReferer, mediaSecondsSchema, youtubeSourceSchema, type YouTubeSource } from './youtube';

export interface PlayerDocumentOptions {
  source: YouTubeSource;
  scope: MediaScope;
  title: string;
  /** Exact private loopback page URL issued by the host bridge. */
  url: string;
  appId: string;
  initialTime?: number;
}
interface RuntimeConfig { source: YouTubeSource; scope: MediaScope; origin: string; route: string; initialTime: number }

/** Fixed trusted code; no model or source HTML is ever executed. Keep this function closure-free. */
function playerRuntime(config: RuntimeConfig) {
  type Snapshot = { videoId: string; currentTime: number; duration: number; playbackState: string };
  type Player = { getVideoUrl(): string; getCurrentTime(): number; getDuration(): number; getPlayerState(): number; playVideo(): void; pauseVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void; cueVideoById(value: object): void; destroy(): void };
  const global = window as unknown as { YT?: { Player: new (id: string, options: object) => Player }; onYouTubeIframeAPIReady?: () => void };
  const status = document.getElementById('status')!;
  let player: Player | undefined;
  let ready = false;
  let readyReported = false;
  let disposed = false;
  let unavailable = false;
  let eventQueue = Promise.resolve();
  let commandQueue = Promise.resolve();
  let queueLength = 0;
  let activeRequest: string | null = null;
  const cancelled = new Set<string>();
  const names: Record<number, string> = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
  const sameScope = (value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return Object.keys(v).length === 4 && v.taskId === config.scope.taskId && v.taskEpoch === config.scope.taskEpoch && v.generation === config.scope.generation && v.sourceId === config.scope.sourceId;
  };
  const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 604800;
  function snapshot(): Snapshot {
    if (!ready || !player || disposed || unavailable) throw new Error('The player is unavailable.');
    const playingUrl = player.getVideoUrl();
    const playingId = playingUrl ? new URL(playingUrl).searchParams.get('v') : null;
    if (!playingId) throw new Error('The player has not identified the current video.');
    if (playingId !== config.source.videoId) { fail('source-changed'); throw new Error('Playback moved to another video; attach its source before capturing context.'); }
    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();
    const playbackState = names[player.getPlayerState()];
    if (!time(currentTime) || !time(duration) || !playbackState) throw new Error('The player has not reported a valid position.');
    return { videoId: config.source.videoId, currentTime, duration, playbackState };
  }
  function emit(value: object) {
    if (disposed) return;
    const body = JSON.stringify({ version: 1, scope: config.scope, ...value });
    eventQueue = eventQueue.then(async () => {
      const response = await fetch(`${config.route}events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'omit' });
      if (!response.ok) throw new Error('Media bridge rejected an event.');
    }).catch(() => { if (player) player.pauseVideo(); status.textContent = 'Connection to Eve was lost. Your saved notes are still available.'; });
  }
  function fail(reason: string, code?: number) {
    unavailable = reason !== 'autoplay-blocked';
    const labels: Record<string, string> = {
      network: 'The lesson could not connect. Your source and notes are still available.',
      'invalid-video': 'This video link is invalid.', 'playback-error': 'The official player cannot play this video here.',
      'removed-or-private': 'This video is private or no longer available.', 'embedding-disabled': 'YouTube did not allow playback in this embedded player.',
      'missing-client-identity': 'The player could not verify this installed application.',
      'autoplay-blocked': 'Use the YouTube play button to continue.', 'bridge-disconnected': 'Connection to Eve was lost. Playback is paused.',
      'source-changed': 'Playback moved to another video. Open its source as a new lesson to use its context.',
      unknown: 'This video is unavailable in the official player.',
    };
    status.textContent = labels[reason] ?? labels.unknown;
    emit({ type: 'unavailable', reason, ...(code === undefined ? {} : { code }) });
  }
  async function waitUntil(test: () => boolean, message: string) {
    const end = performance.now() + 4000;
    while (!test()) {
      if (disposed || unavailable) throw new Error('The player is unavailable.');
      if (activeRequest && cancelled.has(activeRequest)) throw new Error('Media command cancelled.');
      if (performance.now() >= end) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  async function pause() {
    const current = snapshot();
    if (['paused', 'cued', 'unstarted', 'ended'].includes(current.playbackState)) return;
    player!.pauseVideo();
    await waitUntil(() => [2, 5, 0, -1].includes(player!.getPlayerState()), 'The player did not acknowledge pause.');
  }
  function publish() {
    try {
      const value = snapshot();
      emit({ type: readyReported ? 'snapshot' : 'ready', snapshot: value });
      readyReported = true;
    } catch { /* An unobserved position is never fabricated into a checkpoint. */ }
  }
  function validCommand(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (v.version !== 1 || !sameScope(v.scope) || typeof v.requestId !== 'string' || !v.requestId || v.requestId.length > 128) return false;
    const extras: Record<string, string[]> = { pause: [], seek: ['seconds'], capture: ['pause'], play: ['intent', 'visible'] };
    if (typeof v.type !== 'string' || !Object.hasOwn(extras, v.type)) return false;
    const keys = ['version', 'scope', 'requestId', 'type', ...extras[v.type]];
    if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) return false;
    return v.type === 'seek' ? time(v.seconds) : v.type === 'capture' ? typeof v.pause === 'boolean' : v.type === 'play' ? v.intent === 'explicit-user' && v.visible === true : true;
  }
  async function command(c: Record<string, unknown>) {
    try {
      if (cancelled.has(c.requestId as string)) return;
      activeRequest = c.requestId as string;
      snapshot();
      if (c.type === 'pause' || (c.type === 'capture' && c.pause)) await pause();
      else if (c.type === 'seek') {
        await pause();
        const seconds = Math.min(c.seconds as number, player!.getDuration() || (c.seconds as number));
        // seekTo on an unstarted/cued player may begin playback. Cue preserves autoplay-off.
        if ([-1, 5, 0].includes(player!.getPlayerState())) {
          player!.cueVideoById({ videoId: config.source.videoId, startSeconds: seconds, ...(config.source.endSeconds === undefined ? {} : { endSeconds: config.source.endSeconds }) });
          await waitUntil(() => player!.getPlayerState() === 5 && Math.abs(player!.getCurrentTime() - seconds) < 1.5, 'The player has not confirmed the requested position.');
        } else {
          player!.seekTo(seconds, true);
          await waitUntil(() => player!.getPlayerState() === 2 && Math.abs(player!.getCurrentTime() - seconds) < 1.5, 'The player has not confirmed the requested position.');
        }
      } else if (c.type === 'play') {
        if (document.visibilityState !== 'visible' || innerWidth < 200 || innerHeight < 200) throw new Error('The player must be visible before playback.');
        player!.playVideo();
        await waitUntil(() => player!.getPlayerState() === 1, 'Use the YouTube play button to continue.');
      }
      emit({ type: 'command-result', requestId: c.requestId, ok: true, snapshot: snapshot() });
    } catch (error) { emit({ type: 'command-error', requestId: c.requestId, message: error instanceof Error ? error.message.slice(0, 500) : 'Player command failed.' }); }
    finally { activeRequest = null; cancelled.delete(c.requestId as string); }
  }
  const stream = new EventSource(`${config.route}commands`);
  stream.addEventListener('command', event => {
    let parsed: unknown;
    try { parsed = JSON.parse((event as MessageEvent).data); } catch { return; }
    if (!validCommand(parsed) || queueLength >= 16 || disposed) return;
    queueLength++;
    commandQueue = commandQueue.then(() => command(parsed)).finally(() => { queueLength--; });
  });
  stream.addEventListener('cancel', event => {
    let value: Record<string, unknown>;
    try { value = JSON.parse((event as MessageEvent).data); } catch { return; }
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || value.version !== 1 || !sameScope(value.scope) || typeof value.requestId !== 'string' || value.requestId.length > 128) return;
    cancelled.add(value.requestId);
    if (cancelled.size > 64) cancelled.delete(cancelled.values().next().value!);
    if (activeRequest === value.requestId) player?.pauseVideo();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true; ready = false;
    clearInterval(interval); clearTimeout(loadTimeout);
    stream.close(); player?.pauseVideo(); player?.destroy();
  };
  stream.addEventListener('dispose', () => { status.textContent = 'This lesson session has ended. Your saved place and notes are retained.'; dispose(); });
  stream.onerror = () => { if (!disposed) { player?.pauseVideo(); status.textContent = 'Connection to Eve was lost. Playback is paused.'; } };
  window.addEventListener('pagehide', dispose, { once: true });
  const interval = setInterval(() => { if (ready && !unavailable && !disposed) publish(); }, 1000);
  const loadTimeout = setTimeout(() => { if (!ready) fail('network'); }, 20000);
  global.onYouTubeIframeAPIReady = () => {
    if (disposed || !global.YT) return;
    player = new global.YT.Player('player', {
      events: {
        onReady: () => {
          if (disposed) return;
          ready = true; unavailable = false; clearTimeout(loadTimeout);
          player!.cueVideoById({ videoId: config.source.videoId, startSeconds: config.initialTime, ...(config.source.endSeconds === undefined ? {} : { endSeconds: config.source.endSeconds }) });
          status.textContent = 'Ready when you are. Playback starts only when you choose.';
          publish();
        },
        onStateChange: () => {
          if (!ready || disposed || unavailable) return;
          try {
            const value = snapshot();
            status.textContent = value.playbackState === 'playing' ? 'Playing on YouTube' : value.playbackState === 'buffering' ? 'Buffering…' : 'Your place stays with this task.';
            publish();
          } catch { /* Wait for the official player to identify the video. */ }
        },
        onError: (event: { data: number }) => {
          const reasons: Record<number, string> = { 2: 'invalid-video', 5: 'playback-error', 100: 'removed-or-private', 101: 'embedding-disabled', 150: 'embedding-disabled', 153: 'missing-client-identity' };
          fail(reasons[event.data] ?? 'unknown', event.data);
        },
        onAutoplayBlocked: () => fail('autoplay-blocked'),
      },
    });
  };
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => fail('network');
  document.head.appendChild(script);
}

function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!)); }
function json(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

export function generatePlayerDocument(options: PlayerDocumentOptions): { html: string; contentSecurityPolicy: string } {
  const source = youtubeSourceSchema.parse(options.source);
  const scope = mediaScopeSchema.parse(options.scope);
  const url = new URL(options.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !/^\/[a-f0-9]{48}\/$/.test(url.pathname) || url.search || url.hash) throw new Error('The document requires an exact private loopback player URL.');
  if (!options.title || options.title.length > 240) throw new Error('A bounded lesson title is required.');
  const referer = applicationReferer(options.appId);
  const initialTime = mediaSecondsSchema.parse(options.initialTime ?? source.startSeconds);
  const nonce = randomBytes(18).toString('base64');
  const params = new URLSearchParams({ enablejsapi: '1', autoplay: '0', controls: '1', playsinline: '1', origin: url.origin, widget_referrer: referer });
  const embed = `https://www.youtube.com/embed/${source.videoId}?${params}`;
  const contentSecurityPolicy = `default-src 'none'; script-src 'nonce-${nonce}' https://www.youtube.com https://s.ytimg.com; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src https://www.youtube.com; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const config: RuntimeConfig = { source, scope, origin: url.origin, route: url.pathname, initialTime };
  return { contentSecurityPolicy, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="strict-origin-when-cross-origin"><title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">*{box-sizing:border-box}html,body{margin:0;min-width:200px;min-height:242px;height:100%;background:#fafaf7;color:#283731;font:13px system-ui,sans-serif}body{display:flex;flex-direction:column}main{flex:1;min-height:200px;display:grid;place-items:center;background:#111}iframe{border:0;width:100%;height:100%;min-width:200px;min-height:200px}footer{min-height:42px;display:flex;align-items:center;gap:18px;justify-content:space-between;padding:10px 16px}#status{margin:0;color:#5e6b64}a{color:#3e614c;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}:focus-visible{outline:2px solid #5d7d65;outline-offset:3px}</style></head>
<body><main aria-label="Official YouTube player"><iframe id="player" title="${escapeHtml(options.title)}" src="${escapeHtml(embed)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></main><footer><p id="status" role="status" aria-live="polite">Connecting to the official player…</p><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">View source ↗</a></footer>
<script nonce="${nonce}">(${playerRuntime.toString()})(${json(config)});</script></body></html>` };
}
