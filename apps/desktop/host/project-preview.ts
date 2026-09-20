import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { projectRecordSchema, type ProjectRecord } from '../../../packages/contracts/src/index';

export type ProjectPreviewErrorCode = 'INVALID_PROJECT' | 'UNTRUSTED_PROJECT' | 'PROJECT_CHANGED' | 'UNSAFE_PATH' | 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'CANCELLED' | 'IO_ERROR';
export class ProjectPreviewError extends Error {
  constructor(readonly code: ProjectPreviewErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ProjectPreviewError'; }
}
export interface ProjectPreviewOptions {
  project: ProjectRecord;
  /** Must freshly inspect the canonical registration and host-local project trust.
   * No callback/default means no preview. Returning false is also a refusal. */
  authorize: (capturedProject: Readonly<ProjectRecord>) => Promise<void>;
  signal?: AbortSignal;
  /** Defaults to 16 MiB per file; cannot exceed 32 MiB. At most four reads/responses coexist. */
  maxFileBytes?: number;
}
export interface ProjectPreview {
  kind: ProjectRecord['preview']['kind'];
  projectId: string;
  url: string | null;
  owned: boolean;
  /** Idempotent and terminal. A borrowed loopback server is never terminated. */
  close(): Promise<void>;
}
const DEFAULT_LIMIT = 16 * 1024 * 1024, MAX_LIMIT = 32 * 1024 * 1024;
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; sandbox allow-scripts allow-same-origin";
interface Directory { file: string; device: bigint; inode: bigint }
function fail(code: ProjectPreviewErrorCode, message: string): never { throw new ProjectPreviewError(code, message); }
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) fail('CANCELLED', 'Project preview startup was cancelled.'); };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function canonicalRoot(input: string): string {
  if (!path.isAbsolute(input) || path.normalize(input) !== input || input.includes('\\') || /[\u0000-\u001f\u007f]/.test(input) || input.length > 4096) fail('UNSAFE_PATH', 'Choose the original project folder before opening its preview.');
  return input;
}
async function directories(root: string): Promise<Directory[]> {
  const result: Directory[] = []; let file = path.parse(root).root;
  for (const component of ['', ...path.relative(file, root).split(path.sep).filter(Boolean)]) {
    if (component) file = path.join(file, component);
    const stat = await lstat(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Choose the original folder, rather than a link to it.');
    result.push({ file, device: stat.dev, inode: stat.ino });
  }
  if (await realpath(root) !== root) fail('UNSAFE_PATH', 'Choose the original project folder before opening its preview.');
  return result;
}
async function verifyDirectories(chain: readonly Directory[]): Promise<void> {
  for (const entry of chain) {
    const stat = await lstat(entry.file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.device || stat.ino !== entry.inode) fail('PROJECT_CHANGED', 'The project folder changed. Review it again before opening the preview.');
  }
}
function assetPath(relative: string): { relative: string; mediaType: string } {
  if (!relative || relative.length > 4096 || relative.startsWith('/') || relative.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative) || /[\u0000-\u001f\u007f]/.test(relative)) fail('UNSAFE_PATH', 'Choose a preview file inside the project folder.');
  const segments = relative.split('/');
  if (segments.some(part => !part || part.startsWith('.') || ['node_modules', 'credentials', 'secrets', 'private-keys'].includes(part.toLowerCase()))) fail('UNSAFE_PATH', 'Preview cannot open hidden files or folders containing passwords, keys, or installed packages.');
  const filename = segments.at(-1)!.toLowerCase(), extension = path.posix.extname(filename);
  const mediaType = TYPES[extension];
  if (!mediaType || /(?:^|[._-])(credentials?|secrets?|tokens?|service[-_]?account|private[-_]?key|adminsdk)(?:[._-]|$)/.test(filename) || /^id_(rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(filename) || /^auth\.json$/.test(filename)) fail('UNSUPPORTED_TYPE', 'This file cannot be shown in the preview.');
  return { relative, mediaType };
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
async function readAsset(root: string, rootChain: readonly Directory[], relative: string, limit: number): Promise<{ bytes: Buffer; mediaType: string }> {
  const validated = assetPath(relative); await verifyDirectories(rootChain);
  const file = path.join(root, ...validated.relative.split('/'));
  const chain = await directories(path.dirname(file));
  // A replaced root might be stable again by the time nested directories were
  // captured. It must still be the registration's originally captured tree.
  await verifyDirectories(rootChain);
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('UNSAFE_PATH', 'Choose the original file, rather than a folder or link.');
  if (before.size > BigInt(limit)) fail('TOO_LARGE', 'This preview file exceeds its size limit.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) fail('PROJECT_CHANGED', 'The preview file changed before it could be read.');
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    if (length > limit) fail('TOO_LARGE', 'The preview file grew beyond its size limit.');
    if (length !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(file, { bigint: true }))) fail('PROJECT_CHANGED', 'The preview file changed during the read.');
    await verifyDirectories(chain); await verifyDirectories(rootChain);
    return { bytes: bytes.subarray(0, length), mediaType: validated.mediaType };
  } finally { await handle.close(); }
}
function status(error: unknown): number {
  if (error instanceof ProjectPreviewError) return error.code === 'TOO_LARGE' ? 413 : error.code === 'PROJECT_CHANGED' ? 409 : 404;
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code ?? '') ? 404 : 500;
}

/** Read-only serving, never a project process runner. HTML is not rewritten:
 * use relative asset URLs beneath the random capability prefix. Absolute `/...`
 * resources, remote dependencies, directory listings and server routes are not
 * provided. The host must load this URL in a separate sandboxed WebContents with
 * no Eve preload/IPC and blocked external navigation, permissions and popups. */
export async function startProjectPreview(options: ProjectPreviewOptions): Promise<ProjectPreview> {
  const parsed = projectRecordSchema.safeParse(options.project);
  if (!parsed.success || parsed.data.verification !== 'verified' || typeof options.authorize !== 'function') fail('INVALID_PROJECT', 'Eve could not confirm that this project can be opened. Review the project before trying its preview.');
  const project = freeze(structuredClone(parsed.data));
  if (project.verification !== 'verified') return fail('INVALID_PROJECT', 'Inspect this project before previewing it.');
  const limit = options.maxFileBytes ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail('INVALID_PROJECT', 'The preview file limit must be between 1 byte and 32 MiB.');
  cancelled(options.signal);
  const root = canonicalRoot(project.canonicalRoot);
  let chain: Directory[];
  try { chain = await directories(root); }
  catch (error) { if (error instanceof ProjectPreviewError) throw error; throw new ProjectPreviewError('UNSAFE_PATH', 'Eve could not open the project folder. Check that it is still available.', { cause: error }); }
  const identity = chain.at(-1)!;
  if (identity.device.toString() !== project.rootIdentity.device || identity.inode.toString() !== project.rootIdentity.inode) fail('PROJECT_CHANGED', 'The project folder has been replaced or moved. Review it again before opening the preview.');
  if (project.preview.kind === 'static') {
    try { await readAsset(root, chain, project.preview.entry, limit); }
    catch (error) { if (error instanceof ProjectPreviewError) throw error; throw new ProjectPreviewError('IO_ERROR', 'Eve could not read the HTML file chosen for this preview.', { cause: error }); }
  }
  cancelled(options.signal);
  try {
    const result: unknown = await options.authorize(project);
    if (result === false) fail('UNTRUSTED_PROJECT', 'This project has not been approved for preview.');
  } catch (error) { throw new ProjectPreviewError('UNTRUSTED_PROJECT', 'This project has not been approved for preview.', { cause: error }); }
  cancelled(options.signal); await verifyDirectories(chain); cancelled(options.signal);
  if (project.preview.kind !== 'static') return { kind: project.preview.kind, projectId: project.id, url: project.preview.kind === 'loopback' ? project.preview.url : null, owned: false, close: async () => {} };

  const prefix = `/${randomBytes(24).toString('hex')}/`, entry = project.preview.entry;
  const sockets = new Set<Socket>(), handlers = new Set<Promise<void>>();
  let closed = false, closing: Promise<void> | undefined, active = 0, origin = '';
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    request.on('error', () => response.destroy()); response.on('error', () => response.destroy());
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CSP); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=()');
    const end = (code: number) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '0' }).end(); };
    if (closed) { response.setHeader('Connection', 'close'); end(503); return; }
    const target = request.url;
    if (!target || target.length > 8192 || !target.startsWith(prefix)) { end(404); return; }
    if (request.headers.host !== origin.slice('http://'.length) || (request.headers.origin !== undefined && request.headers.origin !== origin)) { end(403); return; }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, HEAD'); end(405); return; }
    if (active >= 4) { response.setHeader('Connection', 'close'); end(503); return; }
    active++; let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once('finish', release); response.once('close', release);
    try {
      const raw = target.slice(prefix.length).split('?')[0]!;
      if (raw.includes('#') || /%2f|%5c/i.test(raw)) { end(404); return; }
      let relative: string; try { relative = decodeURIComponent(raw) || entry; } catch { end(404); return; }
      const asset = await readAsset(root, chain, relative, limit);
      if (closed || response.destroyed) return;
      response.writeHead(200, { 'Content-Type': asset.mediaType, 'Content-Length': asset.bytes.length });
      response.end(request.method === 'HEAD' ? undefined : asset.bytes);
    } catch (error) { if (!closed && !response.destroyed) end(status(error)); }
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const work = handleRequest(request, response); handlers.add(work);
    void work.finally(() => handlers.delete(work)).catch(() => { response.destroy(); });
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 32; server.maxRequestsPerSocket = 32;
  server.setTimeout(5000, socket => socket.destroy());
  server.on('connection', socket => { if (closed) { socket.destroy(); return; } sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('clientError', (_error, socket) => socket.destroy());
  const onAbort = () => { void close().catch(() => {}); };
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; options.signal?.removeEventListener('abort', onAbort);
    const terminal = new Promise<void>((resolve, reject) => server.close(error => { if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve(); else reject(error); }));
    server.closeAllConnections(); for (const socket of sockets) socket.destroy();
    closing = Promise.all([terminal, Promise.allSettled([...handlers])]).then(() => {});
    return closing;
  }
  server.on('error', () => { if (origin) void close().catch(() => {}); });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') fail('IO_ERROR', 'The preview could not start on this computer.');
    origin = `http://127.0.0.1:${address.port}`;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    cancelled(options.signal);
    return { kind: 'static', projectId: project.id, url: `${origin}${prefix}${entry.split('/').map(encodeURIComponent).join('/')}`, owned: true, close };
  } catch (error) {
    await close();
    if (error instanceof ProjectPreviewError) throw error;
    throw new ProjectPreviewError('IO_ERROR', 'The local preview server could not start.', { cause: error });
  }
}
