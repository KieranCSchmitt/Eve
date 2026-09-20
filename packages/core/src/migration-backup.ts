import Database from 'better-sqlite3';
import { constants, chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CoreMaintenanceError, verifySqliteIntegrity } from './maintenance';

export interface MigrationRollbackReceipt { path: string; fromVersion: number; toVersion: number; bytes: number; sha256: string }
const sync = (file: string) => { const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
function inspect(file: string) {
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Rollback snapshot path contains a symbolic link.');
  }
  if (realpathSync(file) !== file) throw new Error('Rollback snapshot path is not canonical.');
  return lstatSync(file);
}
const owned = (stat: Stats) => !process.getuid || stat.uid === process.getuid();
function sameDirectory(file: string, expected: Stats, privateDirectory = true): void {
  const current = inspect(file);
  if (!current.isDirectory() || !owned(current) || current.dev !== expected.dev || current.ino !== expected.ino || (privateDirectory && (current.mode & 0o077) !== 0)) throw new Error('Rollback storage changed.');
}
function sameFile(current: Stats, expected: Stats): boolean {
  return current.isFile() && owned(current) && (current.mode & 0o077) === 0 && current.dev === expected.dev && current.ino === expected.ino && current.size === expected.size && current.mtimeMs === expected.mtimeMs && current.ctimeMs === expected.ctimeMs;
}

/** Constructor migration cannot race admission. The caller already retains an
 * exclusive source lock. VACUUM INTO snapshots it without changing source rows;
 * no source migration begins before both the DB and verification receipt sync. */
export function writeMigrationRollback(database: Database.Database, dbPath: string, fromVersion: number, toVersion: number): MigrationRollbackReceipt {
  let directory: string | undefined, stageIdentity: Stats | undefined;
  let collection: string | undefined, collectionIdentity: Stats | undefined;
  let parent: string | undefined, parentIdentity: Stats | undefined;
  try {
    const db = lstatSync(dbPath);
    if (!db.isFile() || db.isSymbolicLink() || !owned(db)) throw new Error('The old database must be a regular file owned by this user.');
    parent = realpathSync(path.dirname(path.resolve(dbPath))); parentIdentity = inspect(parent);
    if (!parentIdentity.isDirectory() || !owned(parentIdentity)) throw new Error('The old profile must be owned by this user.');
    collection = path.join(parent, 'migration-backups');
    mkdirSync(collection, { mode: 0o700, recursive: true }); collectionIdentity = inspect(collection);
    sameDirectory(collection, collectionIdentity);
    directory = path.join(collection, `schema-${fromVersion}-to-${toVersion}-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 }); stageIdentity = inspect(directory); sameDirectory(directory, stageIdentity);
    const file = path.join(directory, 'eve.db');
    verifySqliteIntegrity(database); database.prepare('VACUUM main INTO ?').run(file);
    chmodSync(file, 0o600);
    const snapshot = new Database(file, { fileMustExist: true });
    try {
      snapshot.pragma('trusted_schema = OFF'); snapshot.pragma('synchronous = FULL');
      if (snapshot.pragma('user_version', { simple: true }) !== fromVersion) throw new Error('Rollback schema changed during snapshot.');
      verifySqliteIntegrity(snapshot); snapshot.pragma('wal_checkpoint(TRUNCATE)');
      if (snapshot.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Rollback snapshot is not standalone.');
    } finally { snapshot.close(); }
    for (const suffix of ['-wal', '-shm']) { try { lstatSync(file + suffix); throw new Error('Rollback sidecar remains.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    sameDirectory(parent, parentIdentity, false); sameDirectory(collection, collectionIdentity); sameDirectory(directory, stageIdentity);
    const expected = inspect(file);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    try {
      if (!sameFile(fstatSync(fd), expected) || expected.size > 1024 ** 3) throw new Error('Rollback snapshot is unsafe or exceeds 1 GiB.');
      for (;;) { const count = readSync(fd, buffer, 0, buffer.length, bytes); if (!count) break; bytes += count; if (bytes > 1024 ** 3) throw new Error('Rollback snapshot exceeded 1 GiB.'); hash.update(buffer.subarray(0, count)); }
      fsyncSync(fd);
      if (bytes !== expected.size || !sameFile(fstatSync(fd), expected) || !sameFile(inspect(file), expected)) throw new Error('Rollback snapshot changed during verification.');
    } finally { closeSync(fd); }
    const receipt: MigrationRollbackReceipt = { path: file, fromVersion, toVersion, bytes, sha256: hash.digest('hex') };
    // A crash before this final marker leaves an explicitly unverified snapshot.
    // This is not a profile restore receipt and never grants project trust.
    const receiptPath = path.join(directory, 'receipt.json');
    const receiptFd = openSync(receiptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(receiptFd, JSON.stringify({ version: 1, ...receipt }) + '\n'); fsyncSync(receiptFd); } finally { closeSync(receiptFd); }
    sameDirectory(parent, parentIdentity, false); sameDirectory(collection, collectionIdentity); sameDirectory(directory, stageIdentity);
    if (!sameFile(inspect(file), expected)) throw new Error('Rollback snapshot changed before publication.');
    sync(directory); sync(collection); sync(parent);
    return receipt;
  } catch (error) {
    // Remove only our unchanged private stage. Never remove a replacement or
    // follow a changed ancestor; such paths remain untrusted for manual review.
    if (directory && stageIdentity && collection && collectionIdentity && parent && parentIdentity) {
      try { sameDirectory(parent, parentIdentity, false); sameDirectory(collection, collectionIdentity); sameDirectory(directory, stageIdentity); rmSync(directory, { recursive: true }); sync(collection); }
      catch { /* Changed/unknown paths are preserved. */ }
    }
    throw new CoreMaintenanceError('IO_ERROR', 'Eve could not create a verified rollback snapshot. The database migration was refused.', undefined, { cause: error });
  }
}
