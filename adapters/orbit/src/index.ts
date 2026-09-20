import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface OrbitConfig {
  schemaVersion: 1;
  adapter: 'eve.orbit';
  name: string;
  theme: string;
  durationMinutes: number;
  transitionMs: number;
  easing: [number, number, number, number];
}

export class OrbitConflict extends Error {
  readonly code = 'ORBIT_CONFLICT';
}

export const DEFAULT_ORBIT_CONFIG: OrbitConfig = {
  schemaVersion: 1, adapter: 'eve.orbit', name: 'Orbit', theme: '#5677FF',
  durationMinutes: 25, transitionMs: 260, easing: [0.22, 1, 0.36, 1],
};

export function parseOrbitConfig(value: string | unknown): OrbitConfig {
  const source: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Orbit configuration must be an object.');
  const c = source as Record<string, unknown>;
  const known = ['schemaVersion', 'adapter', 'name', 'theme', 'durationMinutes', 'transitionMs', 'easing'];
  if (Object.keys(c).some(key => !known.includes(key))) throw new Error('Orbit configuration has an unknown field.');
  if (c.schemaVersion !== 1 || c.adapter !== 'eve.orbit') throw new Error('This project requires a different adapter version.');
  if (typeof c.name !== 'string' || c.name.trim().length === 0 || c.name.length > 80) throw new Error('Use a project name between 1 and 80 characters.');
  if (typeof c.theme !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.theme)) throw new Error('Theme must be a six-digit hex color.');
  if (typeof c.durationMinutes !== 'number' || !Number.isInteger(c.durationMinutes) || c.durationMinutes < 1 || c.durationMinutes > 180) throw new Error('Session duration must be a whole number between 1 and 180 minutes.');
  if (typeof c.transitionMs !== 'number' || !Number.isInteger(c.transitionMs) || c.transitionMs < 0 || c.transitionMs > 3000) throw new Error('Transition duration must be 0–3000 milliseconds.');
  if (!Array.isArray(c.easing) || c.easing.length !== 4 || c.easing.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Easing requires four finite numbers.');
  const [x1, y1, x2, y2] = c.easing as number[];
  if (x1! < 0 || x1! > 1 || x2! < 0 || x2! > 1 || y1! < -2 || y1! > 3 || y2! < -2 || y2! > 3) throw new Error('Easing x values must be 0–1 and y values −2–3.');
  return { schemaVersion: 1, adapter: 'eve.orbit', name: c.name.trim(), theme: c.theme, durationMinutes: c.durationMinutes, transitionMs: c.transitionMs, easing: [...c.easing] as OrbitConfig['easing'] };
}

export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const serializeOrbitConfig = (config: OrbitConfig): string => `${JSON.stringify(parseOrbitConfig(config), null, 2)}\n`;

export async function readOrbitConfig(projectRoot: string) {
  const root = await realpath(projectRoot);
  const file = path.join(root, 'eve.project.json');
  if (await realpath(file) !== file) throw new Error('Project configuration must not be a symbolic link.');
  const text = await readFile(file, 'utf8');
  return { file, text, hash: contentHash(text), config: parseOrbitConfig(text) };
}

export interface BufferRevision { uri: string; version: number; hash: string; text: string; }
export interface EditorCoordinator {
  /** Must include inactive documents. Null means the editor positively confirmed it is not open. */
  inspect(file: string): Promise<BufferRevision | null>;
  /** Applies through a version-checked WorkspaceEdit, never by writing the underlying disk. */
  replace(revision: BufferRevision, text: string, operationId: string): Promise<BufferRevision>;
}

/** Core records this receipt and its before/after hashes in its durable edit journal. */
export interface OrbitEditReceipt {
  operationId: string;
  location: 'buffer' | 'file';
  file: string;
  beforeHash: string;
  afterHash: string;
  beforeText: string;
  afterText: string;
  documentVersion?: number;
}

export async function commitOrbitConfig(options: {
  projectRoot: string;
  expectedHash: string;
  next: OrbitConfig;
  operationId: string;
  /** A connected workbench must provide the coordinator, even while hidden. */
  editor?: EditorCoordinator;
  /** Set only if the runtime owns a confirmed editor-free project lease. */
  editorFreeLease?: boolean;
}): Promise<OrbitEditReceipt> {
  const afterText = serializeOrbitConfig(options.next);
  const root = await realpath(options.projectRoot);
  const file = path.join(root, 'eve.project.json');
  if (await realpath(file) !== file) throw new Error('Project configuration must not be a symbolic link.');
  if (options.editor) {
    const buffer = await options.editor.inspect(file);
    if (buffer) {
      if (buffer.hash !== options.expectedHash) throw new OrbitConflict('The configuration changed in the editor. Review the latest values.');
      const result = await options.editor.replace(buffer, afterText, options.operationId);
      if (result.hash !== contentHash(afterText)) throw new OrbitConflict('The editor changed again while the update was applying.');
      return { operationId: options.operationId, location: 'buffer', file, beforeHash: buffer.hash, afterHash: result.hash, beforeText: buffer.text, afterText, documentVersion: result.version };
    }
  } else if (!options.editorFreeLease) {
    throw new OrbitConflict('The editor connection must be checked before editing this project.');
  }
  const lockFile = path.join(root, '.eve-config.lock');
  // Exclusive cooperative lease serializes all Eve writes. External editors remain hash-checked.
  const lock = await open(lockFile, 'wx', 0o600).catch(() => { throw new OrbitConflict('Another configuration change is in progress.'); });
  const temporary = path.join(root, `.eve-config-${randomUUID()}.tmp`);
  try {
    const beforeText = await readFile(file, 'utf8');
    const beforeHash = contentHash(beforeText);
    if (beforeHash !== options.expectedHash) throw new OrbitConflict('The configuration changed on disk. Review the latest values.');
    const mode = (await stat(file)).mode & 0o777;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try { await handle.writeFile(afterText, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (options.editor && await options.editor.inspect(file)) throw new OrbitConflict('The configuration was opened in the editor. Retry against its current buffer.');
    if (contentHash(await readFile(file, 'utf8')) !== beforeHash) throw new OrbitConflict('The configuration changed before the update could be committed.');
    await rename(temporary, file);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { operationId: options.operationId, location: 'file', file, beforeHash, afterHash: contentHash(afterText), beforeText, afterText };
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockFile);
  }
}

/** Drafts are ephemeral. Only release calls commit; one gesture is one undo group. */
export class OrbitDraft {
  private value: OrbitConfig;
  private sequence = 0;
  constructor(readonly gestureId: string, readonly baseHash: string, config: OrbitConfig) { this.value = parseOrbitConfig(config); }
  update(patch: Partial<Pick<OrbitConfig, 'theme' | 'durationMinutes' | 'transitionMs' | 'easing'>>) {
    this.value = parseOrbitConfig({ ...this.value, ...patch });
    return { type: 'orbit.draft' as const, version: 1 as const, gestureId: this.gestureId, sequence: ++this.sequence, config: this.value };
  }
  current(): OrbitConfig { return parseOrbitConfig(this.value); }
}
