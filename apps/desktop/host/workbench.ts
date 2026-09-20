import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BufferRevision, EditorCoordinator } from '../../../adapters/orbit/src/index';
import { acquireWorkbenchPause, type PauseControl, type WorkbenchPauseLease, type WorkbenchPauseOptions } from './workbench-pause';
export type { WorkbenchPauseLease, WorkbenchPauseOptions } from './workbench-pause';
import { FrameDecoder, MAX_FRAME_BYTES, encodeFrame, type BridgeMessage, type DocumentState, type EditorCheckpoint, type RecoveryDocument, type WorkbenchContext, type WorkbenchMethod } from '../../../extensions/eve-workbench/src/protocol';

export interface WorkbenchOptions {
  codeServerExecutable: string;
  extensionDirectory: string;
  profileDirectory: string;
  /** Private authored journals, separate from runtime/user-data. Defaults to profileDirectory/recovery. */
  recoveryDirectory?: string;
  /** Trusted-host hints for other project collections beneath a legacy flat
   * recovery root only. These IDs never authorize reading child drafts. */
  readonly knownRecoveryNamespaces?: readonly string[];
  projectRoot: string;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  /** Explicit host grant for a reviewed project such as Eve's own Orbit. Never infer from a filename. */
  trustedProject?: boolean;
  /** Python 3 standard-library supervisor; it supplies kernel flock and owned-group teardown. */
  supervisorExecutable?: string;
}
export interface WorkbenchCookieSession {
  cookies: { set(details: { url: string; name: string; value: string; path: string; httpOnly: boolean; secure: boolean; sameSite: 'lax' }): Promise<void> };
}
export interface WorkbenchRecoveryBatch {
  readonly id: string;
  readonly documents: readonly RecoveryDocument[];
  readonly unrecognizedFiles: readonly string[];
}
interface RecoveryFileIdentity { name: string; sha256: string }
const recoveryName = (name: string) => name === 'current.json' || /^(?:pending-[\d-]+[a-f\d-]*|orphan-[a-f\d-]+)\.json$/.test(name);
function recoveryNamespaces(input: readonly string[]): readonly string[] {
  const reserved = /^(?:current\.json|acknowledged\.json|workbench\.lock)(?:\.|$)|^(?:pending-|orphan-)/i;
  const invalid = () => new Error('WORKBENCH_RECOVERY_REVIEW: Recovery namespaces require unique portable project IDs outside the journal and lock namespace.');
  if (!Array.isArray(input) || input.length > 10_000) throw invalid();
  const ids = [...input];
  if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || reserved.test(id)) || new Set(ids).size !== ids.length) throw invalid();
  return Object.freeze(ids);
}
function recoveryDocuments(value: unknown): RecoveryDocument[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid recovery document collection.');
  for (const document of value) if (!record(document) || typeof document.uri !== 'string' || !document.uri || typeof document.text !== 'string' || document.hash !== contentHash(document.text) || typeof document.languageId !== 'string' || typeof document.untitled !== 'boolean' || typeof document.dirty !== 'boolean' || !Number.isSafeInteger(document.version) || Number(document.version) < 0) throw new Error('Recovery content validation failed.');
  return structuredClone(value) as RecoveryDocument[];
}

/** Deliberately allowlisted. In particular no API keys, PASSWORD, NODE_OPTIONS, or provider env leaks. */
export function workbenchEnvironment(source: NodeJS.ProcessEnv, socket: string, tokenFile: string, recoveryFile?: string): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY'];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key]) environment[key] = source[key];
  environment.EVE_WORKBENCH_SOCKET = socket;
  environment.EVE_WORKBENCH_TOKEN_FILE = tokenFile;
  if (recoveryFile) environment.EVE_WORKBENCH_RECOVERY_FILE = recoveryFile;
  environment.CS_DISABLE_GETTING_STARTED_OVERRIDE = '1';
  return environment;
}

export function parseAuthenticationCookie(headers: string[]): { name: string; value: string } {
  for (const header of headers) {
    const pair = header.split(';')[0]!;
    const equals = pair.indexOf('=');
    if (equals > 0 && pair.slice(0, equals) === 'code-server-session' && pair.slice(equals + 1)) return { name: pair.slice(0, equals), value: pair.slice(equals + 1) };
  }
  throw new Error('Eve could not connect securely to the code editor. Try reopening the project.');
}

async function durableJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const contentHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Host-owned process, authenticated editor bridge, and durable dirty-buffer recovery. */
export class WorkbenchService extends EventEmitter implements EditorCoordinator {
  private process?: ChildProcess;
  private listener?: Server;
  private bridge?: Socket;
  private sockets = new Set<Socket>();
  private runtimeDirectory?: string;
  private password = randomBytes(32).toString('hex');
  private token = randomBytes(32).toString('hex');
  private cookie?: { name: string; value: string };
  private baseUrl?: string;
  private disposed = false;
  private closing?: Promise<void>;
  private stopped = false;
  private started = false;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; detach: () => void }>();
  private recoveryQueue = Promise.resolve();
  private acknowledgmentQueue = Promise.resolve();
  private recoveryBatches = new Map<string, { files: RecoveryFileIdentity[]; documents: RecoveryDocument[] }>();
  private latestContext: WorkbenchContext | null = null;
  private latestDirty: RecoveryDocument[] = [];
  private instance = randomUUID();
  private supervisorToken = randomBytes(32).toString('hex');
  private supervisorOwned = false;
  private failure?: Error;
  private startupLog = '';
  private pauseGate = false;
  private pauseLease?: WorkbenchPauseLease;
  private resolvedRecoveryDirectory?: string;
  private recoveryDirectoryIdentity?: { device: bigint; inode: bigint };
  private recoveryChain: { file: string; device: bigint; inode: bigint }[] = [];
  private knownRecoveryNamespaces: readonly string[];
  readonly options: WorkbenchOptions;

  constructor(options: WorkbenchOptions) {
    super();
    this.knownRecoveryNamespaces = recoveryNamespaces(options.knownRecoveryNamespaces ?? []);
    this.options = { ...options, ...(options.knownRecoveryNamespaces === undefined ? {} : { knownRecoveryNamespaces: this.knownRecoveryNamespaces }) };
  }
  /** Host-only classification hints from current canonical project IDs. This
   * neither inspects child contents nor acknowledges any recovery collection. */
  setKnownRecoveryNamespaces(projectIds: readonly string[]): void {
    this.knownRecoveryNamespaces = recoveryNamespaces(projectIds);
  }
  get recoveryDirectory(): string { return this.resolvedRecoveryDirectory ?? this.options.recoveryDirectory ?? path.join(this.options.profileDirectory, 'recovery'); }
  get connected() { return !!this.bridge && !this.bridge.destroyed; }
  get context() { return this.latestContext; }
  get dirtyDocuments(): readonly RecoveryDocument[] { return this.latestDirty; }
  get url(): string {
    if (!this.baseUrl) throw new Error('The code editor is not ready yet.');
    const url = new URL(this.baseUrl);
    url.searchParams.set('folder', this.options.projectRoot);
    return url.toString();
  }

  async start(): Promise<this> {
    if (this.disposed) throw new Error('The code editor is closing or has stopped.');
    if (this.started) throw new Error('The code editor is already opening or open.');
    this.started = true;
    try {
      this.options.signal?.throwIfAborted();
      this.options.projectRoot = await realpath(this.options.projectRoot);
      await stat(this.options.codeServerExecutable);
      await stat(path.join(this.options.extensionDirectory, 'dist/extension.cjs'));
      await mkdir(this.options.profileDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.options.profileDirectory, 0o700);
      this.options.profileDirectory = await realpath(this.options.profileDirectory);
      await this.prepareRecoveryDirectory();
      Object.freeze(this.options);
      // macOS tmpdir may exceed Unix-socket path limits; /tmp is private through mkdtemp + 0700.
      this.runtimeDirectory = await mkdtemp(path.join(os.platform() === 'darwin' ? '/tmp' : os.tmpdir(), 'eve-wb-'));
      await chmod(this.runtimeDirectory, 0o700);
      const socketFile = path.join(this.runtimeDirectory, 'bridge.sock');
      const tokenFile = path.join(this.runtimeDirectory, 'bridge.token');
      const credential = await open(tokenFile, 'wx', 0o600);
      try { await credential.writeFile(this.token); } finally { await credential.close(); }
      const extensionRoot = path.join(this.options.profileDirectory, 'extensions');
      const userData = path.join(this.options.profileDirectory, 'user-data');
      const configFile = path.join(this.runtimeDirectory, 'code-server.yaml');
      const config = await open(configFile, 'wx', 0o600);
      try { await config.writeFile(`bind-addr: 127.0.0.1:0\nauth: password\npassword: ${JSON.stringify(this.password)}\ncert: false\n`); } finally { await config.close(); }
      const args = ['--config', configFile, '--user-data-dir', userData, '--extensions-dir', extensionRoot, '--session-socket', path.join(this.runtimeDirectory, 'code.sock'), '--disable-telemetry', '--disable-update-check', '--disable-proxy', ...(this.options.trustedProject ? ['--disable-workspace-trust'] : []), this.options.projectRoot];
      const supervisorFile = path.join(this.options.extensionDirectory, 'scripts', 'supervisor.py');
      await stat(supervisorFile);
      const specFile = path.join(this.runtimeDirectory, 'supervisor.json');
      await durableJson(specFile, {
        version: 1, instance: this.instance, supervisorToken: this.supervisorToken, hostPid: process.pid,
        profileDirectory: this.options.profileDirectory, recoveryDirectory: this.recoveryDirectory, runtimeDirectory: this.runtimeDirectory, projectRoot: this.options.projectRoot,
        command: [this.options.codeServerExecutable, ...args],
        environment: workbenchEnvironment(process.env, socketFile, tokenFile, path.join(this.recoveryDirectory, `orphan-${this.instance}.json`)),
      });
      if (process.platform === 'win32') throw new Error('The code editor is currently available on Linux and macOS only.');
      this.process = spawn(this.options.supervisorExecutable ?? '/usr/bin/python3', ['-I', supervisorFile, specFile], { cwd: this.options.projectRoot, env: workbenchEnvironment(process.env, socketFile, tokenFile), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      this.process.once('error', error => { this.failure = error; this.emit('status', { state: 'failed', message: error.message }); });
      this.process.once('exit', (code, signal) => {
        this.failure ??= new Error(`The code editor stopped unexpectedly (${signal ?? code ?? 'unknown'}).`);
        this.bridge?.destroy();
        this.rejectPending(this.failure);
        this.emit('pauseInvalidated', { reason: 'The workbench supervisor stopped.' });
        if (!this.disposed) this.emit('status', { state: 'failed', message: this.failure.message });
      });
      const observe = (chunk: Buffer) => {
        this.startupLog = (this.startupLog + chunk.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '')).slice(-16384);
        for (const line of this.startupLog.split('\n')) if (line.startsWith('EVE_SUPERVISOR ')) {
          try {
            const message = JSON.parse(line.slice(15));
            if (message.state === 'owned' && message.instance === this.instance) this.supervisorOwned = true;
            if (message.state === 'failed') this.failure = new Error(`WORKBENCH_OWNERSHIP_REVIEW: ${message.message}`);
            if (message.state === 'resumed' && typeof message.leaseId === 'string') this.emit('pauseInvalidated', { leaseId: message.leaseId, reason: message.reason ?? 'Supervisor released the pause.' });
          } catch { /* Wait for a complete line. */ }
        }
        const match = this.startupLog.match(/HTTP server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) this.baseUrl = match[1];
      };
      this.process.stdout?.on('data', observe);
      this.process.stderr?.on('data', observe);
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30000);
      while (!this.supervisorOwned) {
        this.options.signal?.throwIfAborted();
        if (this.failure) throw this.failure;
        if (Date.now() > deadline) throw new Error('Eve could not safely open the code editor. Close this project and try again.');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      await this.startBridge(socketFile);
      const extensionInstall = path.join(extensionRoot, 'eve.eve-workbench-0.1.0');
      await mkdir(extensionInstall, { recursive: true, mode: 0o700 });
      for (const entry of ['package.json', 'dist', 'themes']) await cp(path.join(this.options.extensionDirectory, entry), path.join(extensionInstall, entry), { recursive: true, force: true });
      const settingsDirectory = path.join(userData, 'User');
      await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
      const settingsFile = path.join(settingsDirectory, 'settings.json');
      try { await stat(settingsFile); }
      catch {
        await durableJson(settingsFile, {
          'workbench.colorTheme': 'Eve Light', 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false,
          'window.menuBarVisibility': 'compact', 'editor.fontSize': 14, 'editor.lineHeight': 24,
          'editor.minimap.enabled': false, 'editor.scrollBeyondLastLine': false, 'files.autoSave': 'off',
          'files.hotExit': 'onExitAndWindowClose', 'terminal.integrated.fontSize': 13,
          'remote.autoForwardPorts': false, 'security.workspace.trust.enabled': true,
          'telemetry.telemetryLevel': 'off',
          'git.openRepositoryInParentFolders': 'never',
          'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.disableAIFeatures': true,
        });
      }
      // The supervisor holds both profile and recovery locks before any journal can change.
      await this.assertRecoveryDirectory();
      await this.readRecovery(false);
      // Retain unresolved crash recovery even if the newly opened workbench initially reports no dirty buffers.
      try {
        const previous = JSON.parse(await this.readRecoveryFile('current.json')) as { documents?: unknown[] };
        if (Array.isArray(previous.documents) && previous.documents.length) await this.writeRecoveryFile(`pending-${Date.now()}-${randomUUID()}.json`, previous);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.supervisorControl('launch');
      while (!this.baseUrl) {
        this.options.signal?.throwIfAborted();
        if (this.failure) throw this.failure;
        if (Date.now() > deadline) throw new Error('The code editor took too long to open. Try reopening the project.');
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      const login = await fetch(new URL('/login', this.baseUrl), { method: 'POST', body: new URLSearchParams({ password: this.password }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: this.baseUrl }, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(this.options.signal ? [this.options.signal] : [])]) });
      if (![200, 302, 303].includes(login.status)) throw new Error(`Eve could not connect securely to the code editor (${login.status}).`);
      this.cookie = parseAuthenticationCookie(login.headers.getSetCookie());
      this.password = '';
      this.startupLog = '';
      this.emit('status', { state: 'ready', connected: this.connected });
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  private async prepareRecoveryDirectory(create = true) {
    if (this.recoveryDirectoryIdentity) { await this.assertRecoveryDirectory(); return; }
    const selected = this.options.recoveryDirectory ?? path.join(this.options.profileDirectory, 'recovery');
    if (!path.isAbsolute(selected) || path.normalize(selected) !== selected || /[\u0000-\u001f\u007f]/.test(selected) || selected.includes('\\') || selected === this.options.profileDirectory) throw new Error('WORKBENCH_RECOVERY_REVIEW: Choose a separate canonical recovery directory.');
    let file = path.parse(selected).root;
    const chain: typeof this.recoveryChain = [];
    for (const component of ['', ...path.relative(file, selected).split(path.sep).filter(Boolean)]) {
      if (component) file = path.join(file, component);
      let info = await lstat(file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (!info) {
        if (!create) throw Object.assign(new Error('Recovery directory is absent.'), { code: 'ENOENT' });
        await mkdir(file, { mode: 0o700 }); info = await lstat(file, { bigint: true });
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WORKBENCH_RECOVERY_REVIEW: Recovery directory links are not followed.');
      chain.push({ file, device: info.dev, inode: info.ino });
    }
    const info = await lstat(selected, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077n) || (process.getuid && info.uid !== BigInt(process.getuid()))) throw new Error('WORKBENCH_RECOVERY_REVIEW: Recovery storage must remain a private directory owned by this user.');
    if (await realpath(selected) !== selected) throw new Error('WORKBENCH_RECOVERY_REVIEW: Recovery storage must use its canonical directory.');
    if (this.recoveryDirectoryIdentity) {
      // Concurrent cold reads must never repin a replacement tree.
      await this.assertRecoveryDirectory(); return;
    }
    this.resolvedRecoveryDirectory = selected;
    this.recoveryChain = chain;
    this.recoveryDirectoryIdentity = { device: info.dev, inode: info.ino };
    await this.assertRecoveryDirectory();
  }
  private async assertRecoveryDirectory() {
    for (const part of this.recoveryChain) {
      const info = await lstat(part.file, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== part.device || info.ino !== part.inode) throw new Error('WORKBENCH_RECOVERY_REVIEW: The recovery directory identity changed.');
    }
    const info = await lstat(this.recoveryDirectory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077n) || (process.getuid && info.uid !== BigInt(process.getuid())) || (this.recoveryDirectoryIdentity && (this.recoveryDirectoryIdentity.device !== info.dev || this.recoveryDirectoryIdentity.inode !== info.ino))) throw new Error('WORKBENCH_RECOVERY_REVIEW: Recovery storage must remain a private directory owned by this user.');
  }
  private async readRecoveryFile(name: string): Promise<string> {
    await this.assertRecoveryDirectory();
    const file = path.join(this.recoveryDirectory, name);
    const beforePath = await lstat(file, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n || (beforePath.mode & 0o077n) || (process.getuid && beforePath.uid !== BigInt(process.getuid())) || beforePath.size > BigInt(MAX_FRAME_BYTES)) throw new Error('WORKBENCH_RECOVERY_REVIEW: A recovery journal is not a bounded private regular file.');
    const identity = (info: typeof beforePath) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid, info.nlink].join(':');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (identity(before) !== identity(beforePath)) throw new Error('WORKBENCH_RECOVERY_REVIEW: A recovery journal changed while opening.');
      const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      const after = await handle.stat({ bigint: true });
      await this.assertRecoveryDirectory();
      if (count !== Number(before.size) || identity(before) !== identity(after) || identity(await lstat(file, { bigint: true })) !== identity(after)) throw new Error('WORKBENCH_RECOVERY_REVIEW: A recovery journal changed while reading.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } finally { await handle.close(); }
  }
  private async writeRecoveryFile(name: string, value: unknown): Promise<void> {
    await this.assertRecoveryDirectory();
    const file = path.join(this.recoveryDirectory, name);
    const existing = await lstat(file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n || (existing.mode & 0o077n) || (process.getuid && existing.uid !== BigInt(process.getuid())))) throw new Error('WORKBENCH_RECOVERY_REVIEW: An unsafe journal was preserved rather than replaced.');
    await durableJson(file, value); await this.assertRecoveryDirectory();
  }

  private supervisorControl(type: 'launch' | 'stop' | PauseControl, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.runtimeDirectory) return Promise.reject(new Error('Supervisor runtime unavailable.'));
    return new Promise((resolve, reject) => {
      const connection = createConnection(path.join(this.runtimeDirectory!, 'supervisor.sock'));
      let response = '';
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('The workbench supervisor did not acknowledge ownership control.')); }, type === 'pause-acquire' ? 10000 : 4000);
      connection.once('error', error => { clearTimeout(timer); reject(error); });
      connection.once('connect', () => connection.write(JSON.stringify({ ...params, type, token: this.supervisorToken, instance: this.instance }) + '\n'));
      connection.on('data', chunk => {
        response += chunk.toString('utf8');
        if (response.length > 8192) { connection.destroy(); clearTimeout(timer); reject(new Error('Invalid supervisor response.')); return; }
        if (!response.includes('\n')) return;
        clearTimeout(timer); connection.destroy();
        try { const result = JSON.parse(response.split('\n')[0]); result.ok ? resolve(result.result) : reject(new Error(result.message ?? 'Supervisor request refused.')); }
        catch { reject(new Error('Invalid supervisor response.')); }
      });
    });
  }

  /** The cookie goes straight to the isolated workbench session, never through shell renderer IPC. */
  async authenticate(session: WorkbenchCookieSession) {
    if (!this.baseUrl || !this.cookie) throw new Error('Eve has not connected securely to the code editor yet.');
    await session.cookies.set({ url: this.baseUrl, ...this.cookie, path: '/', httpOnly: true, secure: false, sameSite: 'lax' });
  }

  waitUntilConnected(timeoutMs = 20000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('status', changed); reject(new Error('The editor extension has not connected. Check project trust and extension activation.')); }, timeoutMs);
      const changed = (status: { state: string }) => {
        if (status.state === 'connected') { clearTimeout(timer); this.off('status', changed); resolve(); }
        else if (status.state === 'failed' || status.state === 'stopped') { clearTimeout(timer); this.off('status', changed); reject(new Error('The workbench stopped before its extension connected.')); }
      };
      this.on('status', changed);
    });
  }

  private async startBridge(socketFile: string) {
    this.listener = createServer(socket => {
      this.sockets.add(socket);
      const decoder = new FrameDecoder();
      let authorized = false;
      const timer = setTimeout(() => socket.destroy(), 5000);
      socket.on('error', () => {});
      socket.on('data', chunk => {
        try {
          for (const raw of decoder.feed(chunk)) {
            if (!record(raw) || raw.version !== 1) throw new Error('Invalid protocol.');
            if (!authorized) {
              const supplied = typeof raw.token === 'string' ? Buffer.from(raw.token) : Buffer.alloc(0);
              const expected = Buffer.from(this.token);
              if (raw.type !== 'hello' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || this.connected) throw new Error('Workbench peer rejected.');
              authorized = true; clearTimeout(timer);
              this.bridge = socket;
              socket.write(encodeFrame({ version: 1, type: 'welcome', accepted: true }));
              this.emit('status', { state: 'connected' });
              continue;
            }
            if (raw.type === 'response' && typeof raw.id === 'string') {
              const pending = this.pending.get(raw.id);
              if (!pending) continue;
              clearTimeout(pending.timer); pending.detach(); this.pending.delete(raw.id);
              if (record(raw.error)) pending.reject(new Error(typeof raw.error.message === 'string' ? raw.error.message : 'Workbench request rejected.'));
              else pending.resolve(raw.result);
            } else if (raw.type === 'event' && typeof raw.event === 'string') this.onBridgeEvent(raw.event, raw.data);
            else throw new Error('Invalid workbench message.');
          }
        } catch { socket.destroy(); }
      });
      socket.once('close', () => {
        clearTimeout(timer); this.sockets.delete(socket);
        if (this.bridge === socket) {
          this.bridge = undefined;
          this.emit('pauseInvalidated', { reason: 'The editor bridge disconnected.' });
          this.rejectPending(new Error('WORKBENCH_OUTCOME_UNKNOWN: The editor disconnected. Check the current file contents before retrying changes.'));
          if (!this.disposed) this.emit('status', { state: 'disconnected' });
        }
      });
    });
    await new Promise<void>((resolve, reject) => { this.listener!.once('error', reject); this.listener!.listen(socketFile, resolve); });
    await chmod(socketFile, 0o600);
  }

  private onBridgeEvent(event: string, value: unknown) {
    if (event === 'context.changed') { this.latestContext = value as WorkbenchContext; this.emit('context', value); }
    else if (event === 'dirty.changed') {
      if (!record(value) || !Array.isArray(value.documents) || value.incomplete) { this.emit('recoveryError', new Error('Some open files could not be backed up. Save them before closing Eve.')); return; }
      const documents = value.documents as RecoveryDocument[];
      if (documents.some(document => typeof document.uri !== 'string' || typeof document.text !== 'string' || document.hash !== contentHash(document.text))) { this.emit('recoveryError', new Error('Eve could not verify the backup of your open files. Save them before closing Eve.')); return; }
      void this.persistRecoveryDocuments(documents).catch(() => { /* Reported through recoveryError. */ });
    } else if (event === 'intent.selection') this.emit('selectionIntent', value);
    else if (event === 'checkpoint.saved') this.emit('checkpoint', value);
  }
  private persistRecoveryDocuments(input: unknown): Promise<void> {
    const documents = recoveryDocuments(input);
    this.latestDirty = documents;
    const write = this.recoveryQueue.then(() => this.writeRecoveryFile('current.json', { version: 1, capturedAt: Date.now(), projectRoot: this.options.projectRoot, documents }));
    this.recoveryQueue = write.catch(error => { this.emit('recoveryError', error); });
    return write.then(() => { this.emit('dirty', structuredClone(documents)); });
  }

  /** A fresh extension capture, acknowledged only after the host snapshot is fsynced. */
  async captureDurableRecovery(options: { signal?: AbortSignal } = {}): Promise<RecoveryDocument[]> {
    const documents = recoveryDocuments(await this.call('recovery.capture', undefined, options));
    await this.persistRecoveryDocuments(documents);
    return documents;
  }

  /** Linux-only owned writer barrier. The renderer input hold and external-writer policy belong to the host. */
  async acquireBackupPause(options: WorkbenchPauseOptions): Promise<WorkbenchPauseLease> {
    const lease = await acquireWorkbenchPause({
      platform: process.platform,
      blockCommands: () => {
        if (this.pauseGate || this.disposed || !this.connected) throw new Error('The code editor cannot pause for backup right now. Wait for it to finish opening or closing, then try again.');
        this.pauseGate = true;
        return () => { this.pauseGate = false; this.pauseLease = undefined; };
      },
      drain: async signal => {
        const deadline = Date.now() + 20000;
        while (this.pending.size) {
          signal?.throwIfAborted();
          if (!this.connected || this.disposed || Date.now() > deadline) throw new Error('The code editor did not finish its changes in time for backup. Check your files before trying again.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await this.recoveryQueue;
      },
      capture: async signal => {
        const documents = recoveryDocuments(await this.dispatchCall('recovery.capture', undefined, { signal }));
        await this.persistRecoveryDocuments(documents);
        return documents;
      },
      control: (type, params) => this.supervisorControl(type, params),
      subscribeInvalidation: listener => { this.on('pauseInvalidated', listener); return () => { this.off('pauseInvalidated', listener); }; },
    }, options);
    this.pauseLease = lease;
    return lease;
  }

  call<T = unknown>(method: WorkbenchMethod, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.pauseGate) return Promise.reject(new Error('WORKBENCH_PAUSED: Editing is paused while Eve backs up your work.'));
    return this.dispatchCall<T>(method, params, options);
  }

  private dispatchCall<T = unknown>(method: WorkbenchMethod, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('The code editor is closing or has stopped.'));
    if (!this.connected) return Promise.reject(new Error('The editor connection is not ready.'));
    if (this.pending.size >= 64) return Promise.reject(new Error('The code editor is busy. Wait a moment and try again.'));
    options.signal?.throwIfAborted();
    const id = randomUUID();
    const frame = encodeFrame({ version: 1, type: 'request', id, method, params });
    return new Promise<T>((resolve, reject) => {
      const expire = (reason: string) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.detach();
        reject(new Error(`${reason}: If you were changing a file, check its current contents before trying again.`));
      };
      const aborted = () => expire('WORKBENCH_OUTCOME_UNKNOWN: Cancel was requested after the editor had started');
      const timer = setTimeout(() => expire('WORKBENCH_OUTCOME_UNKNOWN: The editor did not confirm what happened'), options.timeoutMs ?? 15000);
      const detach = () => options.signal?.removeEventListener('abort', aborted);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, detach });
      options.signal?.addEventListener('abort', aborted, { once: true });
      this.bridge!.write(frame);
    });
  }

  async inspect(file: string): Promise<BufferRevision | null> {
    const state = await this.call<DocumentState | null>('document.inspect', { uri: pathToFileURL(file).toString() });
    if (!state) return null;
    if (typeof state.text !== 'string') throw new Error('Eve could not read the file’s current text from the editor.');
    return { uri: state.uri, version: state.version, hash: state.hash, text: state.text };
  }
  async replace(revision: BufferRevision, text: string, operationId: string): Promise<BufferRevision> {
    const result = await this.call<{ synchronized: boolean; documents: DocumentState[] }>('edit.apply', { operationId, documents: [{ uri: revision.uri, expectedVersion: revision.version, expectedHash: revision.hash, text }] });
    const document = result.documents[0];
    if (!result.synchronized || !document || typeof document.text !== 'string') throw new Error('The file changed again while Eve was editing it. Check its current contents before trying again.');
    return { uri: document.uri, version: document.version, hash: document.hash, text: document.text };
  }
  captureCheckpoint() { return this.call<EditorCheckpoint | null>('checkpoint.capture'); }
  restoreCheckpoint(checkpoint: EditorCheckpoint) { return this.call('checkpoint.restore', checkpoint); }
  saveAll() { return this.call<{ saved: boolean; remaining: DocumentState[] }>('files.saveAll', undefined, { timeoutMs: 120000 }); }
  closeWithPrompt(documents: Array<{ uri: string; version: number }>) { return this.call<{ closed: boolean; remaining: DocumentState[] }>('files.closeWithPrompt', { documents }, { timeoutMs: 120000 }); }
  async loadRecovery(): Promise<RecoveryDocument[]> {
    return (await this.readRecovery(false)).documents;
  }
  private async recoveryAcknowledgments(): Promise<RecoveryFileIdentity[]> {
    try {
      const parsed: unknown = JSON.parse(await this.readRecoveryFile('acknowledged.json'));
      if (!record(parsed) || parsed.version !== 1 || parsed.projectRoot !== this.options.projectRoot || !Array.isArray(parsed.files) || parsed.files.length > 10_000 || parsed.files.some(file => !record(file) || typeof file.name !== 'string' || !recoveryName(file.name) || file.name === 'current.json' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Recovery acknowledgment history needs review.');
      return parsed.files as RecoveryFileIdentity[];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async classifiedRecoveryNamespaces(names: readonly string[], known: readonly string[]): Promise<ReadonlySet<string>> {
    const allowed = new Set(known), excluded = new Set<string>();
    const userId = process.getuid?.();
    const privateDirectory = (info: BigIntStats) => userId !== undefined && info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077n) === 0n && info.uid === BigInt(userId);
    for (const name of names) {
      if (!allowed.has(name)) continue;
      await this.assertRecoveryDirectory();
      const file = path.join(this.recoveryDirectory, name);
      // lstat the immediate child only. Never enumerate, read, hash or infer a
      // child journal; its own workbench owns every recovery decision there.
      try {
        const before = await lstat(file, { bigint: true });
        if (!privateDirectory(before)) continue;
        await this.assertRecoveryDirectory();
        const after = await lstat(file, { bigint: true });
        if (privateDirectory(after) && before.dev === after.dev && before.ino === after.ino && before.uid === after.uid) excluded.add(name);
      } catch { /* An absent/unsafe/uninspectable matching name remains visible. */ }
    }
    await this.assertRecoveryDirectory();
    // A setter racing this read can only make classification more conservative.
    return known === this.knownRecoveryNamespaces ? excluded : new Set<string>();
  }
  private async readRecovery(pendingOnly: boolean): Promise<{ documents: RecoveryDocument[]; files: RecoveryFileIdentity[]; unrecognizedFiles: string[] }> {
    const directory = this.recoveryDirectory;
    const knownNamespaces = this.knownRecoveryNamespaces;
    let names: string[];
    try {
      if (knownNamespaces.length) await this.prepareRecoveryDirectory(false);
      names = await readdir(directory);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { documents: [], files: [], unrecognizedFiles: [] }; throw error; }
    const acknowledged = new Set((await this.recoveryAcknowledgments()).map(file => `${file.name}:${file.sha256}`));
    const results = new Map<string, RecoveryDocument>();
    const files: RecoveryFileIdentity[] = [];
    let total = 0;
    for (const name of names.filter(recoveryName).sort()) {
      if (pendingOnly && (name === 'current.json' || name === `orphan-${this.instance}.json`)) continue;
      const file = path.join(directory, name);
      total += (await lstat(file)).size;
      if (total > MAX_FRAME_BYTES * 4) throw new Error('Recovery history needs review before additional snapshots can be loaded.');
      const text = await this.readRecoveryFile(name);
      const fingerprint = { name, sha256: contentHash(text) };
      if (acknowledged.has(`${name}:${fingerprint.sha256}`)) continue;
      const parsed: unknown = JSON.parse(text);
      if (!record(parsed) || parsed.version !== 1 || parsed.projectRoot !== this.options.projectRoot || !Array.isArray(parsed.documents)) throw new Error('Recovery snapshot does not belong to this project.');
      for (const value of recoveryDocuments(parsed.documents)) results.set(`${value.uri}:${value.hash}`, value);
      files.push(fingerprint);
    }
    const ownJournalTemporary = new RegExp(`^orphan-${this.instance}\\.json\\.[a-f\\d-]+\\.tmp$`);
    const namespaces = knownNamespaces.length ? await this.classifiedRecoveryNamespaces(names, knownNamespaces) : new Set<string>();
    return { documents: [...results.values()], files, unrecognizedFiles: names.filter(name => !recoveryName(name) && name !== 'acknowledged.json' && name !== 'workbench.lock' && !ownJournalTemporary.test(name) && !namespaces.has(name)) };
  }
  /** Capture an exact, immutable decision batch. Current live buffers are not cold-recovery drafts. */
  async loadRecoveryBatch(): Promise<WorkbenchRecoveryBatch> {
    // Do not mistake our own in-flight atomic current.json temporary for a crash artifact.
    await this.acknowledgmentQueue;
    const read = this.recoveryQueue.then(() => this.readRecovery(true));
    this.recoveryQueue = read.then(() => {}, () => {});
    const batch = await read;
    const id = `${this.instance}:${contentHash(JSON.stringify(batch.files))}`;
    if (!this.recoveryBatches.has(id) && this.recoveryBatches.size >= 64) throw new Error('Too many recovery decision batches are pending.');
    this.recoveryBatches.set(id, { files: batch.files, documents: structuredClone(batch.documents) });
    return Object.freeze({ id, documents: Object.freeze(batch.documents.map(document => Object.freeze(document))), unrecognizedFiles: Object.freeze(batch.unrecognizedFiles) });
  }
  /** Explicit host acknowledgment of exactly the captured files; never delete a journal or sweep newer drafts. */
  async acknowledgeRecovery(batch: WorkbenchRecoveryBatch) {
    const observed = this.recoveryBatches.get(batch.id);
    if (!observed) throw new Error('This recovery batch was not captured by the current workbench service.');
    const write = this.acknowledgmentQueue.then(async () => {
      const files = new Map((await this.recoveryAcknowledgments()).map(file => [`${file.name}:${file.sha256}`, file]));
      for (const file of observed.files) files.set(`${file.name}:${file.sha256}`, file);
      if (files.size > 10_000) throw new Error('Recovery acknowledgment history needs review before it can grow further.');
      await this.writeRecoveryFile('acknowledged.json', { version: 1, projectRoot: this.options.projectRoot, files: [...files.values()] });
      this.recoveryBatches.delete(batch.id);
    });
    this.acknowledgmentQueue = write.catch(() => {});
    await write;
  }
  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.detach(); pending.reject(error); }
    this.pending.clear();
  }
  close(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.closing) return this.closing;
    // Refuse new editor operations immediately, but keep ownership until shutdown
    // completes. A failed authenticated stop must remain explicitly retryable.
    this.disposed = true;
    const closing = Promise.resolve().then(() => this.closeOwned()).then(() => { this.stopped = true; });
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = undefined; }).catch(() => {});
    return closing;
  }
  private async closeOwned(): Promise<void> {
    this.emit('pauseInvalidated', { reason: 'The workbench is closing.' });
    try { await this.pauseLease?.release(); } catch (error) { this.emit('recoveryError', error); }
    this.rejectPending(new Error('Workbench runtime stopped.'));
    for (const socket of this.sockets) socket.destroy();
    if (this.listener?.listening) await new Promise<void>(resolve => this.listener!.close(() => resolve()));
    const child = this.process;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // Cancellation may arrive while the supervisor is retiring the previous orphan.
      // Wait for an owned socket (or clean refusal), then stop through authenticated control.
      const ownershipDeadline = Date.now() + 8000;
      while (!this.supervisorOwned && child.exitCode === null && child.signalCode === null && Date.now() < ownershipDeadline) await new Promise(resolve => setTimeout(resolve, 40));
      if (this.supervisorOwned) await this.supervisorControl('stop');
      await new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timeout = setTimeout(() => reject(new Error('WORKBENCH_OWNERSHIP_REVIEW: Supervisor still running; its lock and runtime were preserved. No PID fallback was attempted.')), 6000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    await this.recoveryQueue;
    await this.acknowledgmentQueue;
    if (this.runtimeDirectory) await rm(this.runtimeDirectory, { recursive: true, force: true });
    this.password = ''; this.token = ''; this.supervisorToken = ''; this.cookie = undefined;
    this.emit('status', { state: 'stopped' });
  }
}

export async function startWorkbench(options: WorkbenchOptions) { return new WorkbenchService(options).start(); }
