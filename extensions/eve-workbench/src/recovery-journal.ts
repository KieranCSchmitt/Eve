import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RecoveryDocument } from './protocol';

const same = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
function privateFile(info: Stats) {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe recovery journal.');
}
async function existingFile(file: string): Promise<Stats | undefined> {
  try { const info = await lstat(file); privateFile(info); return info; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
}
async function pinDirectory(directory: string) {
  const root = path.parse(directory).root;
  const pins: Array<{ path: string; identity: Stats }> = [];
  let current = root;
  for (const part of ['', ...directory.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const identity = await lstat(current);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('The recovery directory has an unsafe ancestor.');
    pins.push({ path: current, identity });
  }
  const leaf = pins[pins.length - 1]!.identity;
  if ((leaf.mode & 0o077) || (process.getuid && leaf.uid !== process.getuid())) throw new Error('Unsafe recovery journal directory.');
  const assert = async () => {
    for (const pin of pins) {
      const info = await lstat(pin.path);
      if (!info.isDirectory() || info.isSymbolicLink() || !same(info, pin.identity)) throw new Error('The recovery directory identity changed.');
    }
    const info = await lstat(directory);
    if ((info.mode & 0o077) || !same(info, leaf)) throw new Error('The recovery directory permissions or identity changed.');
  };
  await assert();
  return { leaf, assert };
}

interface Location { directory: string; pinned: Awaited<ReturnType<typeof pinDirectory>> }

/** One session's pinned orphan-v1 writer, shared by scheduled capture and edit acknowledgement. */
export class OrphanRecoveryWriter {
  private location?: Location;
  constructor(private readonly recoveryFile: string | undefined) {}

  async initialize(): Promise<void> {
    if (this.location) { await this.location.pinned.assert(); return; }
    if (!this.recoveryFile || !/^orphan-[a-f\d-]+\.json$/.test(path.basename(this.recoveryFile))) throw new Error('Durable editor recovery is not configured safely.');
    const directory = await realpath(path.dirname(this.recoveryFile));
    this.location = { directory, pinned: await pinDirectory(directory) };
  }

  async persist(projectRoot: string | undefined, documents: readonly RecoveryDocument[], options: { writeEmpty?: boolean } = {}): Promise<void> {
    await this.initialize();
    await persistOrphanRecovery(this.recoveryFile!, this.location!, projectRoot, documents, options.writeEmpty === true);
  }
}

async function persistOrphanRecovery(recoveryFile: string, location: Location, projectRoot: string | undefined, documents: readonly RecoveryDocument[], writeEmpty: boolean): Promise<void> {
  if (!documents.length && !writeEmpty) return;
  const { directory, pinned } = location;
  // All operations use the captured canonical path, never an alias that can be redirected later.
  const target = path.join(directory, path.basename(recoveryFile));
  const existing = await existingFile(target);
  if (!projectRoot) throw new Error('The recovery workspace is unavailable.');
  const temporary = path.join(directory, `${path.basename(recoveryFile)}.${randomUUID()}.tmp`);
  const parentHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let temporaryIdentity: Stats | undefined;
  try {
    if (!same(await parentHandle.stat(), pinned.leaf)) throw new Error('The recovery directory changed before capture.');
    await pinned.assert();
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      temporaryIdentity = await file.stat(); privateFile(temporaryIdentity);
      await pinned.assert();
      if (!same(await lstat(temporary), temporaryIdentity)) throw new Error('The recovery stage identity changed.');
      const serialized = JSON.stringify({ version: 1, capturedAt: Date.now(), projectRoot: await realpath(projectRoot), documents });
      await file.writeFile(serialized);
      await file.sync();
      const written = await file.stat(); privateFile(written);
      if (!same(written, temporaryIdentity) || written.size !== Buffer.byteLength(serialized)) throw new Error('The recovery stage changed while writing.');
      await pinned.assert();
      const beforePublish = await existingFile(target);
      if (existing ? !beforePublish || !same(beforePublish, existing) || beforePublish.size !== existing.size || beforePublish.mtimeMs !== existing.mtimeMs || beforePublish.ctimeMs !== existing.ctimeMs : beforePublish !== undefined) throw new Error('The previous recovery journal changed before publication.');
      const stage = await lstat(temporary); privateFile(stage);
      if (!same(stage, written) || stage.size !== written.size || stage.mtimeMs !== written.mtimeMs || stage.ctimeMs !== written.ctimeMs) throw new Error('The recovery stage changed before publication.');
      await pinned.assert();
      await rename(temporary, target);
      await parentHandle.sync();
      await pinned.assert();
      const published = await lstat(target); privateFile(published);
      if (!same(published, written) || published.size !== written.size || published.mtimeMs !== written.mtimeMs || !same(await parentHandle.stat(), pinned.leaf)) throw new Error('The recovery journal changed before acknowledgement.');
    } finally { await file.close(); }
  } finally {
    // Never remove a path in a replaced directory or a stage whose identity is no longer ours.
    if (temporaryIdentity) {
      try {
        await pinned.assert();
        const info = await lstat(temporary);
        if (same(info, temporaryIdentity) && info.isFile() && info.nlink === 1) await rm(temporary);
      } catch { /* A changed/unknown stage remains for explicit recovery review. */ }
    }
    await parentHandle.close();
  }
}
