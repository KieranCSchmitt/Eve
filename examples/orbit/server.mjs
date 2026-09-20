import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || config.adapter !== 'eve.orbit' || typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80 || !/^#[\da-f]{6}$/i.test(config.theme)) throw new Error('Invalid Orbit configuration.');
  if (!Number.isInteger(config.durationMinutes) || config.durationMinutes < 1 || config.durationMinutes > 180 || !Number.isInteger(config.transitionMs) || config.transitionMs < 0 || config.transitionMs > 3000) throw new Error('Invalid Orbit timing values.');
  if (!Array.isArray(config.easing) || config.easing.length !== 4 || config.easing.some((n, index) => !Number.isFinite(n) || n < (index % 2 ? -2 : 0) || n > (index % 2 ? 3 : 1))) throw new Error('Invalid Orbit easing.');
  return structuredClone(config);
}

/** A host-owned, read-only HTTP preview. No command execution or file mutation routes. */
export async function startOrbitPreview({ projectRoot = HERE, port = 0 } = {}) {
  const root = await realpath(projectRoot);
  const token = randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  const clients = new Set();
  const sockets = new Set();
  let current = validateConfig(JSON.parse(await readFile(path.join(root, 'eve.project.json'), 'utf8')));
  let draft;
  let watchTimer;
  let closed = false;
  let closing;
  function broadcast(type, payload) {
    if (closed) return;
    const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) {
      if (response.writableLength > 1024 * 1024) { response.destroy(); clients.delete(response); }
      else response.write(data);
    }
  }
  const server = createServer(async (request, response) => {
    try {
      if (closed) { response.writeHead(503, { Connection: 'close' }).end(); return; }
      if (request.method !== 'GET' || !request.url?.startsWith(prefix)) { response.writeHead(404).end(); return; }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      const relative = decodeURIComponent(request.url.split('?')[0].slice(prefix.length)) || 'index.html';
      if (relative === 'events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(`event: config\ndata: ${JSON.stringify({ config: draft?.config ?? current, draft: !!draft })}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      const resolved = await realpath(path.resolve(root, relative)).catch(() => null);
      if (closed || response.destroyed) return;
      if (!resolved || !resolved.startsWith(`${root}${path.sep}`) || !TYPES[path.extname(resolved)]) { response.writeHead(404).end(); return; }
      if (relative === 'eve.project.json') {
        response.writeHead(200, { 'Content-Type': TYPES['.json'] });
        response.end(JSON.stringify(draft?.config ?? current));
        return;
      }
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(resolved)] });
      response.end(await readFile(resolved));
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  const watcher = watch(root, { recursive: true }, (_kind, filename) => {
    if (!filename || filename.startsWith('.eve-') || filename.includes('node_modules')) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      if (closed) return;
      if (filename !== 'eve.project.json') { broadcast('reload', {}); return; }
      try {
        current = validateConfig(JSON.parse(await readFile(path.join(root, 'eve.project.json'), 'utf8')));
        if (!draft) broadcast('config', { config: current, draft: false });
      } catch { broadcast('config-error', {}); }
    }, 80);
  });
  const heartbeat = setInterval(() => { for (const response of clients) response.write(': keepalive\n\n'); }, 15000);
  heartbeat.unref();
  return {
    url: `http://127.0.0.1:${address.port}${prefix}`,
    updateDraft(config, gestureId, sequence) {
      if (typeof gestureId !== 'string' || !gestureId || !Number.isInteger(sequence) || sequence < 0) throw new Error('Invalid preview draft identity.');
      if (draft?.gestureId === gestureId && sequence <= draft.sequence) return false;
      draft = { config: validateConfig(config), gestureId, sequence };
      broadcast('config', { ...draft, draft: true });
      return true;
    },
    /** Used for valid configuration changes in a dirty editor buffer. */
    updateCommitted(config) { current = validateConfig(config); draft = undefined; broadcast('config', { config: current, draft: false }); },
    clearDraft() { draft = undefined; broadcast('config', { config: current, draft: false }); },
    close() {
      if (closing) return closing;
      closed = true;
      clearTimeout(watchTimer);
      clearInterval(heartbeat);
      watcher.close();
      for (const response of clients) response.end();
      clients.clear();
      // The host owns this read-only preview server. Drain every accepted socket,
      // including a half-written request or an EventSource reconnect racing exit.
      closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      return closing;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = await startOrbitPreview();
  console.log(`Orbit preview: ${preview.url}`);
  process.once('SIGINT', async () => { await preview.close(); process.exit(0); });
  process.once('SIGTERM', async () => { await preview.close(); process.exit(0); });
}
