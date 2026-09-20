import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startProjectPreview, type ProjectPreview } from '../../apps/desktop/host/project-preview';
import type { ProjectRecord } from '../../packages/contracts/src/index';

const hooks = vi.hoisted(() => ({ created: null as ((server: Server) => void) | null, open: null as ((file: string) => Promise<void>) | null }));
vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return { ...actual, createServer: (...args: unknown[]) => { const server = Reflect.apply(actual.createServer, actual, args) as Server; hooks.created?.(server); return server; } };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => { await hooks.open?.(String(args[0])); return actual.open(...args); } };
});
let directory: string, root: string, project: ProjectRecord;
const cleanup: Array<() => Promise<unknown>> = [];
const html = '<!doctype html><link rel="stylesheet" href="./style.css"><img src="./pixel.png"><p id="status">Loading</p><script src="./app.js"></script>';
const script = "document.querySelector('#status').textContent = 'Actual static JavaScript';";
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const authorize = vi.fn(async (_project: Readonly<ProjectRecord>) => {});
beforeEach(async () => {
  hooks.created = null; hooks.open = null; authorize.mockClear();
  directory = await mkdtemp(path.join(await realpath(tmpdir()), 'eve-generic-preview-')); root = path.join(directory, 'project'); await mkdir(root);
  await Promise.all([writeFile(path.join(root, 'index.html'), html), writeFile(path.join(root, 'app.js'), script), writeFile(path.join(root, 'style.css'), 'body { color: rgb(30, 80, 40) }'), writeFile(path.join(root, 'pixel.png'), png), writeFile(path.join(root, 'package.json'), '{"scripts":{"start":"exit 99"}}')]);
  const stat = await lstat(root, { bigint: true });
  project = { id: 'generic-project', canonicalRoot: root, rootIdentity: { device: stat.dev.toString(), inode: stat.ino.toString() }, kind: 'external', adapter: 'generic', preview: { kind: 'static', entry: 'index.html' }, verification: 'verified', revision: 3, createdAt: 100, updatedAt: 200 };
});
afterEach(async () => { hooks.created = null; hooks.open = null; for (const close of cleanup.splice(0).reverse()) await close(); await rm(directory, { recursive: true, force: true }); });
const start = async (overrides: Partial<Parameters<typeof startProjectPreview>[0]> = {}): Promise<ProjectPreview> => { const result = await startProjectPreview({ project, authorize, ...overrides }); cleanup.push(result.close); return result; };
const within = async <T>(work: Promise<T>, milliseconds = 1000): Promise<T> => { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Preview shutdown did not settle')), milliseconds); })]); } finally { clearTimeout(timer); } };
function raw(url: string, suffix: string, extra: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Buffer }> {
  const target = new URL(url), prefix = target.pathname.slice(0, target.pathname.lastIndexOf('/') + 1);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: prefix + suffix, method: extra.method, headers: extra.headers }, response => {
      const chunks: Buffer[] = []; response.on('data', value => chunks.push(value)); response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) }));
    }); req.once('error', reject); req.end();
  });
}

it('serves actual HTML, client JS, CSS and images through an isolated random capability URL', async () => {
  const preview = await start(), url = new URL(preview.url!);
  expect(preview).toMatchObject({ kind: 'static', owned: true, projectId: project.id });
  expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toMatch(/^\/[a-f0-9]{48}\/index\.html$/);
  expect(authorize).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledWith(project);
  const document = await fetch(preview.url!); expect(document.status).toBe(200); expect(await document.text()).toBe(html);
  expect(document.headers.get('content-security-policy')).toContain("sandbox allow-scripts allow-same-origin");
  expect(document.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(document.headers.get('content-security-policy')).toContain("frame-src 'none'");
  expect(document.headers.get('cache-control')).toBe('no-store'); expect(document.headers.get('referrer-policy')).toBe('no-referrer'); expect(document.headers.get('x-content-type-options')).toBe('nosniff');
  expect(document.headers.has('access-control-allow-origin')).toBe(false);
  const js = await fetch(new URL('app.js', preview.url!)); expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8'); expect(await js.text()).toBe(script);
  const css = await fetch(new URL('style.css', preview.url!)); expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8'); expect(await css.text()).toContain('rgb(30, 80, 40)');
  const image = await fetch(new URL('pixel.png', preview.url!)); expect(image.headers.get('content-type')).toBe('image/png'); expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  const head = await fetch(preview.url!, { method: 'HEAD' }); expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(html))); expect(await head.text()).toBe('');
  expect((await fetch(url.origin + '/index.html')).status).toBe(404);
  expect((await raw(preview.url!, 'index.html', { method: 'POST' })).status).toBe(405);
  expect((await raw(preview.url!, 'index.html', { headers: { Host: 'attacker.test' } })).status).toBe(403);
  expect((await raw(preview.url!, 'index.html', { headers: { Origin: 'https://attacker.test' } })).status).toBe(403);
  const second = await start(); expect(new URL(second.url!).pathname).not.toBe(url.pathname);
});

it('preserves project HTML bytes and nested relative assets without evaluating any project scripts on the host', async () => {
  await mkdir(path.join(root, 'dist')); await writeFile(path.join(root, 'dist', 'my page.html'), html);
  await writeFile(path.join(root, 'dist', 'app.js'), "import {writeFileSync} from 'node:fs'; writeFileSync('must-not-exist.txt','server executed project');");
  const preview = await start({ project: { ...project, preview: { kind: 'static', entry: 'dist/my page.html' } } });
  expect(preview.url).toContain('/dist/my%20page.html'); expect(await (await fetch(preview.url!)).text()).toBe(html);
  expect(await (await fetch(new URL('app.js', preview.url!))).text()).toContain("from 'node:fs'");
  await expect(readFile(path.join(root, 'must-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.resolve('must-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses traversal, hidden/credential files, source maps, dependency folders, listings and server event routes', async () => {
  await Promise.all([writeFile(path.join(root, '.env'), 'PRIVATE'), writeFile(path.join(root, 'credentials.json'), 'PRIVATE'), writeFile(path.join(root, 'server.key'), 'PRIVATE'), writeFile(path.join(directory, 'outside.html'), 'PRIVATE'), mkdir(path.join(root, 'assets')), mkdir(path.join(root, 'node_modules'))]);
  await writeFile(path.join(root, 'node_modules', 'dependency.js'), 'PRIVATE');
  const preview = await start();
  for (const relative of ['../outside.html', '%2e%2e/outside.html', '%2e%2e%2foutside.html', '..\\outside.html', '%00index.html', '%zz', '.env', 'credentials.json', 'server.key', 'app.js.map', 'node_modules/dependency.js', 'assets/', 'events', '//index.html', 'https://example.com/index.html']) {
    const response = await raw(preview.url!, relative); expect(response.status, relative).toBe(404); expect(response.body.length).toBe(0);
  }
  const eventRequest = await fetch(new URL('events', preview.url!), { headers: { Accept: 'text/event-stream' } }); expect(eventRequest.status).toBe(404); expect(await eventRequest.text()).toBe('');
});

it('rejects symlinks and revalidates directory identity while a static server is running', async () => {
  await writeFile(path.join(directory, 'outside.html'), 'PRIVATE'); await symlink(path.join(directory, 'outside.html'), path.join(root, 'linked.html'));
  const preview = await start(); expect((await raw(preview.url!, 'linked.html')).status).toBe(404);
  await rename(root, root + '-original'); await mkdir(root); await writeFile(path.join(root, 'index.html'), 'REPLACEMENT');
  const response = await fetch(preview.url!); expect(response.status).toBe(409); expect(await response.text()).not.toContain('REPLACEMENT');
});

it('never publishes bytes read through an ancestor swapped between lstat and open', async () => {
  await mkdir(path.join(root, 'sub')); await writeFile(path.join(root, 'sub', 'page.html'), 'Original');
  await mkdir(path.join(directory, 'outside')); await writeFile(path.join(directory, 'outside', 'page.html'), 'PRIVATE');
  const preview = await start();
  hooks.open = async file => {
    if (file !== path.join(root, 'sub', 'page.html')) return;
    hooks.open = null; await rename(path.join(root, 'sub'), path.join(root, 'sub-original')); await symlink(path.join(directory, 'outside'), path.join(root, 'sub'));
  };
  const response = await raw(preview.url!, 'sub/page.html'); expect(response.status).toBe(409); expect(response.body.length).toBe(0);
});

it('requires current host trust and actual directory identity, including after the authorization await', async () => {
  await expect(start({ authorize: undefined as never })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  await expect(start({ project: { ...project, verification: 'legacy-unverified', rootIdentity: null, kind: null } })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  await expect(start({ project: { ...project, verification: 'verified', kind: 'external', rootIdentity: { device: '1', inode: '2' } } })).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  await expect(start({ authorize: async () => { throw new Error('Host refuses trust'); } })).rejects.toMatchObject({ code: 'UNTRUSTED_PROJECT' });
  await expect(start({ authorize: (async () => false) as never })).rejects.toMatchObject({ code: 'UNTRUSTED_PROJECT' });
  await expect(start({ authorize: async captured => {
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.rootIdentity)).toBe(true);
    await rename(root, root + '-original'); await mkdir(root); await writeFile(path.join(root, 'index.html'), 'Changed during prompt');
  } })).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
});

it('enforces entry/file size bounds before and after startup', async () => {
  await expect(start({ maxFileBytes: 1 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  await expect(start({ maxFileBytes: 33 * 1024 * 1024 })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  const preview = await start({ maxFileBytes: 512 }); await writeFile(path.join(root, 'large.json'), 'a'.repeat(513));
  expect((await raw(preview.url!, 'large.json')).status).toBe(413);
  await expect(start({ project: { ...project, preview: { kind: 'static', entry: '../outside.html' } } })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  await expect(start({ project: { ...project, preview: { kind: 'static', entry: 'missing.html' } } })).rejects.toMatchObject({ code: 'IO_ERROR' });
});

it('closes keep-alive, SSE-style and half-written TCP requests terminally and idempotently', async () => {
  const preview = await start(), url = new URL(preview.url!), sockets: Socket[] = [];
  for (let index = 0; index < 3; index++) {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) }); socket.on('error', () => {}); await once(socket, 'connect'); sockets.push(socket);
  }
  sockets[0]!.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`);
  await once(sockets[0]!, 'data');
  sockets[1]!.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\n`);
  sockets[2]!.write('GET ');
  const terminal = sockets.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
  const closing = preview.close(); expect(preview.close()).toBe(closing);
  await within(Promise.all([closing, ...terminal])); await expect(fetch(preview.url!)).rejects.toThrow();
  for (const socket of sockets) socket.destroy();
});

it('waits for the owned listener to close when cancellation arrives just after listen', async () => {
  const controller = new AbortController(); let origin = '';
  hooks.created = server => server.once('listening', () => { const address = server.address(); if (address && typeof address !== 'string') origin = `http://127.0.0.1:${address.port}`; controller.abort(); });
  await expect(within(start({ signal: controller.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(origin).not.toBe(''); await expect(fetch(origin)).rejects.toThrow();
});

it('closes an actually bound listener after a startup listen error and honors later cancellation', async () => {
  let origin = '';
  hooks.created = server => server.once('listening', () => { const address = server.address(); if (address && typeof address !== 'string') origin = `http://127.0.0.1:${address.port}`; server.emit('error', new Error('Injected listener failure')); });
  await expect(within(start())).rejects.toMatchObject({ code: 'IO_ERROR' }); expect(origin).not.toBe(''); await expect(fetch(origin)).rejects.toThrow();
  hooks.created = null;
  const controller = new AbortController(), preview = await start({ signal: controller.signal }); controller.abort(); await within(preview.close()); await expect(fetch(preview.url!)).rejects.toThrow();
});

it('borrows only explicit literal loopback URLs without fetching, rewriting or terminating the existing server', async () => {
  let requests = 0; const server = createServer((_request, response) => { requests++; response.end('Existing user server'); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const url = `http://127.0.0.1:${address.port}/app?theme=dark`;
  const preview = await start({ project: { ...project, preview: { kind: 'loopback', url } } });
  expect(preview).toMatchObject({ kind: 'loopback', url, owned: false }); expect(requests).toBe(0); await preview.close(); expect(requests).toBe(0);
  expect(await (await fetch(url)).text()).toBe('Existing user server'); expect(requests).toBe(1);
  for (const invalid of ['http://localhost:3000/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://user@127.0.0.1/', 'http://127.0.0.1/#fragment', 'https://127.0.0.1/', 'http://127.0.0.1.evil.test/', 'http://[::ffff:127.0.0.1]/']) await expect(start({ project: { ...project, preview: { kind: 'loopback', url: invalid } } })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  const ipv6 = await start({ project: { ...project, preview: { kind: 'loopback', url: 'http://[::1]:1234/demo' } } }); expect(ipv6.url).toBe('http://[::1]:1234/demo');
});

it('bounds concurrent reads and awaits an in-progress file read during close', async () => {
  const preview = await start();
  let release!: () => void, allEntered!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { allEntered = resolve; });
  hooks.open = async file => { if (file === path.join(root, 'app.js')) { if (++reads === 4) allEntered(); await held; } };
  const requests = Array.from({ length: 4 }, () => fetch(new URL('app.js', preview.url!)).catch(() => null));
  try {
    await within(entered);
    expect((await fetch(new URL('style.css', preview.url!))).status).toBe(503);
    let complete = false; const closing = preview.close().then(() => { complete = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(complete).toBe(false);
    release(); await within(closing); await within(Promise.all(requests)); expect(complete).toBe(true);
  } finally { release(); await Promise.all(requests); }
});
