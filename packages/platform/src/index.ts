import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
function systemEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'DCONF_PROFILE'])
    if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
export type RunCommand = (file: string, args: readonly string[]) => Promise<string>;
export const runCommand: RunCommand = async (file, args) => {
  const result = await execute(file, [...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, env: systemEnvironment() });
  return result.stdout;
};
export type ExitAction = 'logout' | 'restart' | 'shutdown';
export interface ExitPreparation { ready: boolean; reason?: string }
export interface LinuxSystemOptions {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  launch?: (file: string, args: readonly string[]) => Promise<void>;
  /** The host queries every editor/untitled buffer and pending note save before resolving ready. */
  prepareExit: (action: ExitAction) => Promise<ExitPreparation>;
}
export interface NetworkConnection { uuid: string; name: string; type: string; device: string | null }

/** nmcli --escape yes uses backslash-escaped colons and backslashes. */
export function splitNmcliRow(line: string): string[] {
  const parts: string[] = [];
  let part = ''; let escaped = false;
  for (const character of line) {
    if (escaped) { part += character; escaped = false; }
    else if (character === '\\') escaped = true;
    else if (character === ':') { parts.push(part); part = ''; }
    else part += character;
  }
  if (escaped) part += '\\';
  parts.push(part); return parts;
}

export class LinuxSystemAdapter {
  readonly platform: NodeJS.Platform;
  private run: RunCommand;
  constructor(private options: LinuxSystemOptions) { this.platform = options.platform ?? process.platform; this.run = options.run ?? runCommand; }
  private requireLinux() { if (this.platform !== 'linux') throw new Error('This control is available in the qualified Linux desktop.'); }
  async status() {
    this.requireLinux();
    const [audio, network] = await Promise.allSettled([
      this.run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']),
      this.run('nmcli', ['--terse', '--escape', 'yes', '--fields', 'UUID,NAME,TYPE,DEVICE', 'connection', 'show', '--active']),
    ]);
    const volume = audio.status === 'fulfilled' ? audio.value.match(/Volume:\s*([\d.]+)(\s+\[MUTED\])?/) : null;
    return {
      audio: volume ? { available: true, volume: Math.round(Number(volume[1]) * 100), muted: !!volume[2] } : { available: false },
      network: network.status === 'fulfilled' ? { available: true, active: this.parseConnections(network.value) } : { available: false, active: [] },
    };
  }
  private parseConnections(output: string): NetworkConnection[] {
    return output.trim().split('\n').filter(Boolean).map(line => { const [uuid, name, type, device] = splitNmcliRow(line); return { uuid: uuid!, name: name!, type: type!, device: device && device !== '--' ? device : null }; });
  }
  async savedNetworks() { this.requireLinux(); return this.parseConnections(await this.run('nmcli', ['--terse', '--escape', 'yes', '--fields', 'UUID,NAME,TYPE,DEVICE', 'connection', 'show'])); }
  async connectSavedNetwork(uuid: string) {
    this.requireLinux();
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(uuid)) throw new Error('Select a saved network connection.');
    await this.run('nmcli', ['connection', 'up', 'uuid', uuid]);
  }
  async setVolume(percent: number) {
    this.requireLinux();
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Volume must be between 0 and 100.');
    await this.run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', String(percent / 100)]);
  }
  async setMuted(muted: boolean) { this.requireLinux(); if (typeof muted !== 'boolean') throw new Error('Choose mute or unmute.'); await this.run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0']); }
  async lock() { this.requireLinux(); await this.run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.Lock']); }
  async openSettings(panel: 'sound' | 'network' | 'bluetooth' | 'display') {
    this.requireLinux();
    if (!['sound', 'network', 'bluetooth', 'display'].includes(panel)) throw new Error('Unsupported settings panel.');
    if (this.options.launch) await this.options.launch('gnome-control-center', [panel]);
    else await new Promise<void>((resolve, reject) => {
      const child = spawn('gnome-control-center', [panel], { detached: true, stdio: 'ignore', env: systemEnvironment() });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  async exit(action: ExitAction) {
    this.requireLinux();
    if (!['logout', 'restart', 'shutdown'].includes(action)) throw new Error('Unsupported session action.');
    const preparation = await this.options.prepareExit(action);
    if (!preparation.ready) return { performed: false, reason: preparation.reason ?? 'Your work is still open.' };
    const method = action === 'logout' ? 'Logout' : action === 'restart' ? 'Reboot' : 'Shutdown';
    await this.run('gdbus', ['call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', `org.gnome.SessionManager.${method}`, ...(action === 'logout' ? ['0'] : [])]);
    return { performed: true };
  }
}

/** Persistent D-Bus peer: a one-shot gdbus command cannot hold a logout inhibitor. */
export class LinuxSessionBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private closed = false;
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private helperPath: string, private python = '/usr/bin/python3') { super(); }
  start() {
    if (process.platform !== 'linux') throw new Error('GNOME session bridge requires Linux.');
    if (this.child) throw new Error('Session bridge was already started.');
    this.child = spawn(this.python, ['-u', this.helperPath], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: process.env.HOME, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DESKTOP_AUTOSTART_ID: process.env.DESKTOP_AUTOSTART_ID } });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 65536) { this.child?.kill(); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && typeof event.id === 'string') {
            const pending = this.pending.get(event.id);
            if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); event.ok ? pending.resolve() : pending.reject(new Error(event.error ?? 'Session command failed.')); }
          } else this.emit('event', event);
        } catch { this.emit('bridgeError', new Error('Invalid response from the system session bridge.')); }
      }
    });
    this.child.on('error', error => this.emit('bridgeError', error));
    this.child.on('exit', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Session bridge stopped.')); } this.pending.clear(); if (!this.closed) this.emit('bridgeError', new Error('The session connection ended. Dirty-work inhibition is unavailable.')); });
    return this;
  }
  private command(type: string, parameters: Record<string, unknown> = {}) {
    if (!this.child || this.closed) return Promise.reject(new Error('Session bridge is not running.'));
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('System session command timed out.')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, type, ...parameters })}\n`);
    });
  }
  setDirty(dirty: boolean) { return this.command('dirty', { dirty }); }
  respondToExit(ok: boolean, reason = '') { return this.command('end-session-response', { ok, reason: reason.slice(0, 1000) }); }
  close() { this.closed = true; this.child?.stdin.end(); }
}
