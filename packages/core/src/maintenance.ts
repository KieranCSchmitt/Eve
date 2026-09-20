import Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectPath, syncDirectory, verifyChain } from '../../imports/src/filesystem';

export type CoreMaintenanceErrorCode = 'CANCELLED' | 'BUSY' | 'UNSAFE_DESTINATION' | 'INVALID_DATABASE' | 'VERSION_REFUSED' | 'UNSUPPORTED_SCHEMA' | 'UNSAFE_REFERENCE' | 'IO_ERROR' | 'DURABILITY_UNCERTAIN';
export class CoreMaintenanceError extends Error {
  constructor(readonly code: CoreMaintenanceErrorCode, message: string, readonly retainedPath?: string, options?: ErrorOptions) { super(message, options); this.name = 'CoreMaintenanceError'; }
}
export interface CoreBackupReceipt { schemaVersion: number; pageCount: number; bytes: number; sha256: string }
export function checkMaintenanceSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CoreMaintenanceError('CANCELLED', 'The database maintenance operation was cancelled.');
}
export function verifySqliteIntegrity(database: Database.Database): void {
  const integrity = database.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || (database.pragma('foreign_key_check') as unknown[]).length) throw new CoreMaintenanceError('INVALID_DATABASE', 'The database failed SQLite integrity or relationship validation.');
}
export async function digestDatabase(file: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 1024 ** 3) throw new CoreMaintenanceError('INVALID_DATABASE', 'The database must be a regular file no larger than 1 GiB.');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      checkMaintenanceSignal(signal);
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead));
      if (bytes > before.size) throw new CoreMaintenanceError('INVALID_DATABASE', 'The database changed during verification.');
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new CoreMaintenanceError('INVALID_DATABASE', 'The database changed during verification.');
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
export async function absent(file: string): Promise<void> {
  try { await lstat(file); throw new CoreMaintenanceError('UNSAFE_DESTINATION', 'Choose a new destination; an existing file is never overwritten.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function syncFile(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Called only by the owning CoreStore. SQLite backup reads its live connection. */
export async function writeCoreSnapshot(database: Database.Database, destination: string, options: { signal?: AbortSignal } = {}): Promise<CoreBackupReceipt> {
  checkMaintenanceSignal(options.signal);
  if (!path.isAbsolute(destination) || path.normalize(destination) !== destination || /[\u0000-\u001f\u007f]/.test(destination) || destination.split(/[\\/]/).includes('..')) throw new CoreMaintenanceError('UNSAFE_DESTINATION', 'Use a canonical absolute backup destination.');
  const parent = await inspectPath(path.dirname(destination));
  if (!parent.stat.isDirectory() || (parent.stat.mode & 0o077) !== 0 || (process.getuid && parent.stat.uid !== process.getuid())) throw new CoreMaintenanceError('UNSAFE_DESTINATION', 'The database snapshot requires a private destination directory owned by this user.');
  await absent(destination);
  const directory = path.join(parent.path, `.eve-core-snapshot-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, 'snapshot.db');
  let published = false;
  try {
    const schemaVersion = database.pragma('user_version', { simple: true }) as number;
    await database.backup(file, { progress: () => { checkMaintenanceSignal(options.signal); return 128; } });
    checkMaintenanceSignal(options.signal);
    const snapshot = new Database(file, { fileMustExist: true });
    let pageCount: number;
    try {
      snapshot.pragma('trusted_schema = OFF');
      if (snapshot.pragma('user_version', { simple: true }) !== schemaVersion) throw new CoreMaintenanceError('INVALID_DATABASE', 'The database schema changed while its snapshot was being made.');
      verifySqliteIntegrity(snapshot);
      // Only this new copy is checkpointed, never a second connection to live DB.
      snapshot.pragma('wal_checkpoint(TRUNCATE)');
      if (String(snapshot.pragma('journal_mode = DELETE', { simple: true })).toLowerCase() !== 'delete') throw new CoreMaintenanceError('INVALID_DATABASE', 'The database snapshot is not standalone.');
      pageCount = snapshot.pragma('page_count', { simple: true }) as number;
    } finally { snapshot.close(); }
    await chmod(file, 0o600);
    await absent(file + '-wal'); await absent(file + '-shm');
    await syncFile(file); await syncDirectory(directory);
    const digest = await digestDatabase(file, options.signal);
    checkMaintenanceSignal(options.signal); await verifyChain(parent.chain);
    // A hard link publishes atomically without replacing a concurrent destination.
    // Both paths are on this parent's filesystem and the private stage is removed.
    await link(file, destination); published = true;
    await rm(directory, { recursive: true });
    await syncDirectory(parent.path);
    return { schemaVersion, pageCount, ...digest };
  } catch (error) {
    if (published) throw new CoreMaintenanceError('DURABILITY_UNCERTAIN', 'The database snapshot was published, but final durability could not be confirmed. Keep it for inspection.', destination, { cause: error });
    if (error instanceof CoreMaintenanceError) throw error;
    throw new CoreMaintenanceError('IO_ERROR', 'The database snapshot could not be completed. Existing data was not replaced.', undefined, { cause: error });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
