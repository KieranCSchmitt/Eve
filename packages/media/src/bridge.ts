import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { contextSnapshotSchema, type ContextSnapshot } from '../../contracts/src/index';
import { generatePlayerDocument } from './document';
import { mediaCheckpointSchema, mediaCommandSchema, mediaEventSchema, mediaScopeSchema, sameMediaScope, toCoreMediaContext, type MediaCheckpoint, type MediaCommandInput, type MediaEvent, type MediaScope, type PlayerSnapshot, type UnavailableReason } from './protocol';
import { applicationReferer, sourceMomentUrl, youtubeSourceSchema, type YouTubeSource } from './youtube';

export interface MediaPlayerOptions {
  source: YouTubeSource;
  scope: MediaScope;
  title: string;
  appId: string;
  checkpoint?: MediaCheckpoint;
  signal?: AbortSignal;
  onEvent?: (event: MediaEvent) => void;
  commandTimeoutMs?: number;
}
export type MediaAvailability = 'connecting' | 'ready' | 'closed' | UnavailableReason;
export interface MediaPlayerBridge {
  readonly url: string;
  readonly referer: string;
  readonly connected: boolean;
  readonly availability: MediaAvailability;
  readonly checkpoint: MediaCheckpoint | null;
  send(input: MediaCommandInput, options?: { signal?: AbortSignal }): Promise<MediaCheckpoint>;
  captureContext(options?: { selection?: ContextSnapshot['selection']; signal?: AbortSignal }): Promise<{ context: ContextSnapshot; checkpoint: MediaCheckpoint; sourceMomentUrl: string }>;
  close(): Promise<void>;
}

/** Private per-view transport. The page can report playback only; it has no Eve action or filesystem API. */
export async function startMediaPlayer(options: MediaPlayerOptions): Promise<MediaPlayerBridge> {
  const source = youtubeSourceSchema.parse(options.source);
  const scope = mediaScopeSchema.parse(options.scope);
  const referer = applicationReferer(options.appId);
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Media session cancelled.');
  let initialTime = source.startSeconds;
  if (options.checkpoint) {
    const restored = mediaCheckpointSchema.parse(options.checkpoint);
    if (restored.scope.taskId !== scope.taskId || restored.scope.sourceId !== scope.sourceId || restored.snapshot.videoId !== source.videoId) throw new Error('The checkpoint belongs to a different source or task.');
    initialTime = restored.snapshot.currentTime;
  }
  const commandTimeoutMs = options.commandTimeoutMs ?? 6500;
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 50 || commandTimeoutMs > 30000) throw new Error('Invalid media command timeout.');
  const route = `/${randomBytes(24).toString('hex')}/`;
  let origin = '';
  let url = '';
  let document: ReturnType<typeof generatePlayerDocument>;
  let stream: ServerResponse | null = null;
  let availability: MediaAvailability = 'connecting';
  let checkpoint: MediaCheckpoint | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const pending = new Map<string, { resolve(value: MediaCheckpoint): void; reject(reason: unknown): void }>();
  function rejectPending(error: Error) { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); }
  function observe(snapshot: PlayerSnapshot): MediaCheckpoint {
    checkpoint = mediaCheckpointSchema.parse({ version: 1, scope, snapshot, capturedAt: Date.now() });
    return checkpoint;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Host and Origin checks prevent DNS rebinding and ambient requests from other web views.
    if (closed || request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403).end(); return; }
    if (request.method === 'GET' && request.url === route) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': document.contentSecurityPolicy, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
      response.end(document.html); return;
    }
    if (request.method === 'GET' && request.url === `${route}commands`) {
      // A new connection must not replace a live controller or replay old explicit play requests.
      if (stream) { response.writeHead(409).end(); return; }
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      response.on('close', () => {
        if (stream === response) stream = null;
        if (!closed) {
          availability = 'bridge-disconnected';
          rejectPending(new Error('The player disconnected; a requested action may already have occurred. Capture its actual state after reconnection.'));
        }
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== `${route}events` || request.headers['content-type'] !== 'application/json' || request.headers.origin !== origin) { response.writeHead(404).end(); return; }
    if (!stream) { response.writeHead(409).end(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16_384) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const parsed = mediaEventSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!parsed.success || !sameMediaScope(parsed.data.scope, scope) || ('snapshot' in parsed.data && parsed.data.snapshot.videoId !== source.videoId)) { response.writeHead(422).end(); return; }
      const event = parsed.data;
      if (event.type === 'command-result' || event.type === 'command-error') {
        const waiter = pending.get(event.requestId);
        // Cancelled generations/requests cannot overwrite a durable place through late acknowledgements.
        if (!waiter) { response.writeHead(204).end(); return; }
        if (event.type === 'command-error') waiter.reject(new Error(event.message));
        else waiter.resolve(observe(event.snapshot));
      } else if (event.type === 'unavailable') {
        availability = event.reason;
        if (event.reason !== 'autoplay-blocked') rejectPending(new Error(`Official player unavailable: ${event.reason}.`));
      } else {
        availability = 'ready';
        observe(event.snapshot);
      }
      response.writeHead(204).end();
      try { options.onEvent?.(event); } catch { /* Observers cannot break the transport. */ }
    } catch { if (!response.headersSent) response.writeHead(400).end(); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 32;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Media bridge failed to bind loopback.');
    origin = `http://127.0.0.1:${address.port}`; url = `${origin}${route}`;
    document = generatePlayerDocument({ source, scope, title: options.title, appId: options.appId, url, initialTime });
  } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  function send(input: MediaCommandInput, sendOptions: { signal?: AbortSignal } = {}): Promise<MediaCheckpoint> {
    if (closed || !stream || !['ready', 'autoplay-blocked'].includes(availability)) return Promise.reject(new Error('The official player is not ready.'));
    if (sendOptions.signal?.aborted) return Promise.reject(sendOptions.signal.reason ?? new Error('Media command cancelled.'));
    if (pending.size >= 16) return Promise.reject(new Error('Too many pending media commands.'));
    const command = mediaCommandSchema.parse({ ...input, version: 1, scope, requestId: randomUUID() });
    return new Promise<MediaCheckpoint>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); pending.delete(command.requestId); sendOptions.signal?.removeEventListener('abort', cancel); };
      const stop = () => stream?.write(`event: cancel\ndata: ${JSON.stringify({ version: 1, scope, requestId: command.requestId })}\n\n`);
      const cancel = () => { stop(); cleanup(); reject(sendOptions.signal?.reason ?? new Error('Media command cancelled.')); };
      const timeout = setTimeout(() => { stop(); cleanup(); reject(new Error('The player did not acknowledge the request; its actual state must be recaptured.')); }, commandTimeoutMs);
      pending.set(command.requestId, { resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } });
      sendOptions.signal?.addEventListener('abort', cancel, { once: true });
      stream!.write(`event: command\ndata: ${JSON.stringify(command)}\n\n`);
    });
  }
  async function captureContext(captureOptions: { selection?: ContextSnapshot['selection']; signal?: AbortSignal } = {}) {
    // Freeze the target synchronously before pausing; later editor selections cannot retarget this question.
    const frozen = contextSnapshotSchema.parse({ id: randomUUID(), taskId: scope.taskId, taskEpoch: scope.taskEpoch, createdAt: Date.now(), selection: captureOptions.selection });
    const value = await send({ type: 'capture', pause: true }, { signal: captureOptions.signal });
    const media = toCoreMediaContext(value.snapshot);
    if (!media || media.state === 'playing') throw new Error('A paused media position has not been acknowledged. Source notes remain available.');
    return { context: contextSnapshotSchema.parse({ ...frozen, media }), checkpoint: value, sourceMomentUrl: sourceMomentUrl(source, media.currentTime) };
  }
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true; availability = 'closed';
    options.signal?.removeEventListener('abort', abort);
    rejectPending(new Error('Media session closed.'));
    stream?.end('event: dispose\ndata: {}\n\n'); stream = null;
    closePromise = new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    return closePromise;
  }
  const abort = () => { void close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) { await close(); throw options.signal.reason ?? new Error('Media session cancelled.'); }
  return {
    url, referer, get connected() { return !closed && stream !== null; }, get availability() { return availability; },
    get checkpoint() { return checkpoint ? structuredClone(checkpoint) : null; }, send, captureContext, close,
  };
}
