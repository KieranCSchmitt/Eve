import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { validRelative } from '../../../packages/backup/src/index';
import { inspectPath, syncDirectory, verifyChain, writeDurable } from '../../../packages/imports/src/filesystem';

export type RestoredProjectTrustErrorCode = 'UNSAFE_PATH' | 'INVALID_RECEIPT' | 'RECEIPT_CHANGED' | 'IO_ERROR' | 'DURABILITY_UNCERTAIN';
export class RestoredProjectTrustError extends Error {
  constructor(readonly code: RestoredProjectTrustErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'RestoredProjectTrustError'; }
}
export interface RestoredProjectTrust { restored: boolean; trusted: boolean; receiptHash?: string }
export const RESTORE_RECEIPT_FILE = 'restore-receipt.json';
/** Local user decision only. Never include this root file in profile exports. */
export const RESTORED_PROJECT_TRUST_FILE = 'restore-trust.json';
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_APPROVAL_BYTES = 16 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(4096).refine(validRelative);
const receiptSchema = z.object({
  version: z.literal(1), backupId: z.string().uuid(),
  versions: z.object({ app: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/), schema: z.number().int().positive().safe() }).strict(),
  requiresApplicationQualification: z.literal(true),
  relocation: z.object({ validated: z.literal(true), changedFiles: z.array(relative).max(100_000), notes: z.array(z.string().max(4096)).max(1000) }).strict(),
  files: z.array(z.object({ path: relative, bytes: z.number().int().nonnegative().max(1024 ** 3), sha256: digest }).strict()).min(1).max(100_000),
}).strict().superRefine((receipt, context) => {
  const files = new Set(receipt.files.map(file => file.path));
  const changed = new Set(receipt.relocation.changedFiles);
  if (files.size !== receipt.files.length || !files.has('eve.db') || files.has(RESTORE_RECEIPT_FILE) || files.has(RESTORED_PROJECT_TRUST_FILE) || changed.size !== receipt.relocation.changedFiles.length || receipt.relocation.changedFiles.some(file => !files.has(file))) context.addIssue({ code: 'custom', message: 'Invalid restore receipt namespace.' });
});
const approvalSchema = z.object({
  version: z.literal(1), kind: z.literal('eve-restored-project-approval'),
  profileRoot: z.string().min(1).max(4096), restoreReceiptSha256: digest,
  scope: z.literal('restored-project-content'), approvedAt: z.string().datetime(),
}).strict();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}:${stat.uid}:${stat.nlink}`;
const ownedPrivate = (stat: Stats) => (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
const failure = (code: RestoredProjectTrustErrorCode, message: string): never => { throw new RestoredProjectTrustError(code, message); };
const json = (bytes: Buffer): unknown => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return undefined; } };

async function profile(profileRoot: string) {
  if (!path.isAbsolute(profileRoot) || profileRoot.length > 4096 || path.normalize(profileRoot) !== profileRoot || profileRoot.includes('\\') || /[\u0000-\u001f\u007f]/.test(profileRoot)) return failure('UNSAFE_PATH', 'Project trust requires a canonical private profile path.');
  try {
    const root = await inspectPath(profileRoot);
    if (!root.stat.isDirectory() || !ownedPrivate(root.stat)) return failure('UNSAFE_PATH', 'Project trust requires a private profile directory owned by this user.');
    return root;
  } catch (error) {
    if (error instanceof RestoredProjectTrustError) throw error;
    throw new RestoredProjectTrustError('UNSAFE_PATH', 'The profile path could not be verified without following links.', { cause: error });
  }
}

/** Missing only means ENOENT at this exact filename beneath a verified root. */
async function privateBytes(root: Awaited<ReturnType<typeof profile>>, name: string, limit: number): Promise<Buffer | undefined> {
  try {
    await verifyChain(root.chain);
    if (!ownedPrivate(await lstat(root.path))) return failure('UNSAFE_PATH', 'The profile directory is no longer private.');
    const file = path.join(root.path, name);
    let stat: Stats;
    try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await verifyChain(root.chain); return undefined; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownedPrivate(stat)) return failure('UNSAFE_PATH', 'Project trust metadata must be private regular files owned by this user, without links.');
    if (stat.size > limit) return failure(name === RESTORE_RECEIPT_FILE ? 'INVALID_RECEIPT' : 'UNSAFE_PATH', 'Project trust metadata exceeds its supported size.');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (identity(before) !== identity(stat)) return failure('UNSAFE_PATH', 'Project trust metadata changed while it was being opened.');
      // Bounded reads, including when the file grows after its first stat.
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      await verifyChain(root.chain);
      if (!ownedPrivate(await lstat(root.path))) return failure('UNSAFE_PATH', 'The profile directory is no longer private.');
      if (length !== before.size || identity(before) !== identity(after) || identity(await lstat(file)) !== identity(after)) return failure('UNSAFE_PATH', 'Project trust metadata changed while it was being read.');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof RestoredProjectTrustError) throw error;
    throw new RestoredProjectTrustError('UNSAFE_PATH', 'Project trust metadata could not be read safely.', { cause: error });
  }
}

async function receipt(root: Awaited<ReturnType<typeof profile>>) {
  const bytes = await privateBytes(root, RESTORE_RECEIPT_FILE, MAX_RECEIPT_BYTES);
  if (bytes === undefined) return undefined;
  if (!receiptSchema.safeParse(json(bytes)).success) return failure('INVALID_RECEIPT', 'The restored profile receipt is invalid or unsupported. Projects remain blocked; your notes can still be opened.');
  return hash(bytes);
}

/** This is a launch decision, not a signature or a freeze on later project edits.
 * Call again immediately before admitting project execution. No files named in
 * the receipt are opened; this inspector never follows archive-authored paths. */
export async function inspectRestoredProjectTrust(profileRoot: string): Promise<RestoredProjectTrust> {
  const root = await profile(profileRoot);
  const receiptHash = await receipt(root);
  const approvalBytes = await privateBytes(root, RESTORED_PROJECT_TRUST_FILE, MAX_APPROVAL_BYTES);
  if (!receiptHash) {
    if (approvalBytes !== undefined) return failure('INVALID_RECEIPT', 'A restore approval exists without its restore receipt. Projects remain blocked until the profile is reviewed.');
    return { restored: false, trusted: true };
  }
  const approval = approvalBytes === undefined ? undefined : approvalSchema.safeParse(json(approvalBytes));
  // A copied, stale or malformed decision never grants authority. An explicit
  // new user decision may replace this regular private file after revalidation.
  const trusted = !!approval?.success && approval.data.profileRoot === root.path && approval.data.restoreReceiptSha256 === receiptHash;
  if (await receipt(root) !== receiptHash) return failure('RECEIPT_CHANGED', 'The restore receipt changed. Review this profile again before trusting its projects.');
  return { restored: true, trusted, receiptHash };
}

/** The native host calls this only after an explicit user choice bound to the
 * receiptHash it displayed. Never invoke it from a model, settings, or archive. */
export async function approveRestoredProjects(profileRoot: string, expectedReceiptHash: string): Promise<RestoredProjectTrust> {
  if (!digest.safeParse(expectedReceiptHash).success) return failure('RECEIPT_CHANGED', 'The restore receipt identity is invalid. Review this profile again.');
  const root = await profile(profileRoot);
  const observed = await inspectRestoredProjectTrust(root.path);
  if (!observed.restored || observed.receiptHash !== expectedReceiptHash) return failure('RECEIPT_CHANGED', 'The restore receipt changed since you reviewed it. No new project approval was written.');
  if (observed.trusted) return observed;
  const target = path.join(root.path, RESTORED_PROJECT_TRUST_FILE);
  const temporary = path.join(root.path, `.restore-trust-${randomUUID()}.tmp`);
  let published = false;
  try {
    const record = { version: 1, kind: 'eve-restored-project-approval', profileRoot: root.path, restoreReceiptSha256: expectedReceiptHash, scope: 'restored-project-content', approvedAt: new Date().toISOString() };
    await writeDurable(temporary, `${JSON.stringify(record, null, 2)}\n`);
    // Revalidate after writing the private stage and immediately before publish.
    // The old approval may be replaced only after this explicit fresh choice.
    if (await receipt(root) !== expectedReceiptHash) return failure('RECEIPT_CHANGED', 'The restore receipt changed before approval. Review this profile again.');
    await privateBytes(root, RESTORED_PROJECT_TRUST_FILE, MAX_APPROVAL_BYTES);
    await verifyChain(root.chain);
    await rename(temporary, target); published = true;
    await syncDirectory(root.path);
    const current = await inspectRestoredProjectTrust(root.path);
    if (!current.trusted || current.receiptHash !== expectedReceiptHash) return failure('RECEIPT_CHANGED', 'The profile changed while approval was being saved. Project execution remains blocked.');
    return current;
  } catch (error) {
    if (error instanceof RestoredProjectTrustError) throw error;
    throw new RestoredProjectTrustError(published ? 'DURABILITY_UNCERTAIN' : 'IO_ERROR', published ? 'Project approval was written, but its durability could not be confirmed. Projects remain blocked for this attempt.' : 'Project approval could not be saved. Projects remain blocked.', { cause: error });
  } finally {
    // Never clean through a profile path whose identity changed under this call.
    await verifyChain(root.chain).then(() => rm(temporary, { force: true })).catch(() => {});
  }
}
