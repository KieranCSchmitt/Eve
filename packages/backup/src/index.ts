import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  copyChecked,
  inspectPath,
  readChecked,
  syncDirectory,
  verifyChain,
  writeDurable,
} from "../../imports/src/filesystem";

export type BackupErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_PATH"
  | "SOURCE_CHANGED"
  | "CORRUPT_BACKUP"
  | "VERSION_REFUSED"
  | "RELOCATION_REQUIRED"
  | "CANCELLED"
  | "QUIESCENCE_LOST"
  | "IO_ERROR"
  | "DURABILITY_UNCERTAIN";
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    readonly retainedPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupError";
  }
}
export type BackupEntryKind =
  "managed-originals" | "project" | "settings" | "recovery";
export interface BackupEntry {
  path: string;
  kind: BackupEntryKind;
}
export interface BackupVersions {
  app: string;
  schema: number;
}
export interface Quiescence {
  /** Abort when the original pause ends or expires. */
  readonly signal?: AbortSignal;
  /** Verify the original lease is still held; renewal must never hide a prior lapse. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
export interface ExportOptions {
  profileRoot: string;
  destination: string;
  versions: BackupVersions;
  entries: readonly BackupEntry[];
  /** Stop every participating writer and acknowledge dirty recovery snapshots before resolving. */
  quiesce(signal?: AbortSignal): Promise<Quiescence>;
  /** Core-owned SQLite online backup. Resolve only after closing/checkpointing the new standalone file. */
  backupDatabase(destination: string, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}
const relativePath = z.string().min(1).max(4096).refine(validRelative);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z
  .object({
    path: relativePath,
    kind: z.enum(["managed-originals", "project", "settings", "recovery"]),
  })
  .strict();
const versionsSchema = z
  .object({
    app: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
    schema: z.number().int().positive(),
  })
  .strict();
const fileSchema = z
  .object({
    path: relativePath,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 ** 3),
    sha256: digest,
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("eve-profile-backup"),
    formatVersion: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    versions: versionsSchema,
    // This private mapping root is necessary for relocation; discovered source paths remain relative.
    originalProfileRoot: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          path.isAbsolute(value) &&
          !/[\u0000-\u001f\u007f]/.test(value) &&
          path.normalize(value) === value &&
          !value.split(/[\\/]/).includes(".."),
      ),
    entries: z.array(entrySchema).max(64),
    files: z.array(fileSchema).min(1).max(100_000),
    exclusions: z
      .array(
        z
          .object({
            path: relativePath,
            reason: z.enum(["credentials", "runtime-state", "rebuildable"]),
          })
          .strict(),
      )
      .max(100_000),
    directories: z.array(relativePath).max(100_000),
    database: z.literal("eve.db"),
    requiresRelocation: z.literal(true),
    credentialsIncluded: z.literal(false),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
export interface RelocationContext {
  stagingProfile: string;
  destinationProfile: string;
  originalProfileRoot: string;
  manifest: Readonly<BackupManifest>;
  signal?: AbortSignal;
}
export interface RelocationReceipt {
  /** Host validates the actual offline DB schema/integrity and every surviving absolute reference. */
  validated: true;
  changedFiles: string[];
  /** User-visible qualifications: external project references, unknown journals, etc. No credentials. */
  notes: string[];
}
export interface RestoreOptions {
  backupDirectory: string;
  destination: string;
  validateVersions(versions: Readonly<BackupVersions>): Promise<boolean>;
  /** Mandatory app-specific transformation AND validation; no default string replacement. */
  relocate(context: RelocationContext): Promise<RelocationReceipt>;
  signal?: AbortSignal;
}
const MAX_BYTES = 10 * 1024 ** 3;
const MAX_FILE = 1024 ** 3;
const MAX_COUNT = 100_000;

export function validRelative(value: string): boolean {
  return (
    !!value &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !path.posix.isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}
function check(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new BackupError(
      "CANCELLED",
      "Backup operation cancelled. Existing profiles were not changed.",
    );
}
function fail(code: BackupErrorCode, message: string): never {
  throw new BackupError(code, message);
}
function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function compare(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function payloadDirectories(
  files: readonly { path: string }[],
  directories: readonly string[],
) {
  const result = new Set(directories);
  for (const item of [...files.map((file) => file.path), ...directories]) {
    let parent = path.posix.dirname(item);
    while (parent !== ".") {
      result.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...result].sort();
}
function exclusion(
  relative: string,
): BackupManifest["exclusions"][number]["reason"] | undefined {
  const parts = relative.split("/");
  if (
    parts.some((part) =>
      /^(?:intelligence|\.ssh|\.aws|\.env(?:\..*)?|\.npmrc|\.pnpmrc|\.yarnrc(?:\.yml)?|credentials?(?:\..*)?|secrets?(?:\..*)?|providers\.enc|id_(?:rsa|ed25519|ecdsa))$/i.test(
        part,
      ),
    ) ||
    /\.(?:pem|p12|pfx|key)$/i.test(relative)
  )
    return "credentials";
  // Git objects/history are authored data, not a rebuildable cache. Repository config can carry URL credentials.
  if (/(?:^|\/)\.git\/config$/.test(relative)) return "credentials";
  if (
    parts.some((part) =>
      /^(?:node_modules|\.cache|Cache|Code Cache|GPUCache|CachedData|Service Worker)$/i.test(
        part,
      ),
    )
  )
    return "rebuildable";
  if (
    parts.some((part) =>
      /^(?:workbench\.lock|workbench-owner\.json|workbench\.token|code-server\.yaml|\.eve-.*\.lock|Singleton.*)$/i.test(
        part,
      ),
    ) ||
    /\.(?:sock|socket|pid|log)$/i.test(relative) ||
    /(?:^|\/)\.git\/.*\.lock$/.test(relative) ||
    /(?:^|\/)eve\.db(?:-wal|-shm)?$/.test(relative)
  )
    return "runtime-state";
  return undefined;
}
function validateEntries(entries: readonly BackupEntry[]) {
  const parsed = z
    .array(entrySchema)
    .max(64)
    .parse(entries)
    .sort((a, b) => a.path.localeCompare(b.path));
  for (let index = 0; index < parsed.length; index++) {
    const item = parsed[index]!;
    if (
      exclusion(item.path) ||
      ["manifest.json", "manifest.sha256", "restore-receipt.json"].includes(
        item.path,
      )
    )
      fail(
        "INVALID_INPUT",
        "A selected entry is reserved or contains credential/runtime state.",
      );
    if (
      parsed
        .slice(0, index)
        .some(
          (previous) =>
            item.path === previous.path ||
            item.path.startsWith(previous.path + "/"),
        )
    )
      fail("INVALID_INPUT", "Backup entries cannot overlap.");
    if (item.kind === "settings" && !/\.json$/.test(item.path))
      fail(
        "INVALID_INPUT",
        "Settings exports must select explicit JSON files, not a profile directory.",
      );
  }
  return parsed;
}
interface Scan {
  files: { path: string; bytes: number; sha256: string; identity: string }[];
  directories: string[];
  exclusions: BackupManifest["exclusions"];
}
async function hashFile(file: string, signal?: AbortSignal) {
  const inspected = await inspectPath(file);
  if (!inspected.stat.isFile() || inspected.stat.size > MAX_FILE)
    fail("UNSAFE_PATH", "Backup accepts only bounded regular files.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.ino !== inspected.stat.ino || before.dev !== inspected.stat.dev)
      fail("SOURCE_CHANGED", "A file changed before backup inspection.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let bytes = 0;
    while (true) {
      check(signal);
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > MAX_FILE)
        fail("SOURCE_CHANGED", "A source grew during backup.");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    await verifyChain(inspected.chain);
    const identity = (stat: typeof before) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (identity(before) !== identity(after) || bytes !== before.size)
      fail("SOURCE_CHANGED", "A source changed during backup.");
    return { bytes, sha256: hash.digest("hex"), identity: identity(after) };
  } finally {
    await handle.close();
  }
}
async function scan(
  root: string,
  entries: readonly BackupEntry[],
  signal?: AbortSignal,
  filtering = true,
): Promise<Scan> {
  const result: Scan = { files: [], directories: [], exclusions: [] };
  let total = 0;
  let count = 0;
  async function walk(relative: string) {
    check(signal);
    if (++count > MAX_COUNT)
      fail("INVALID_INPUT", "Backup file-count limit exceeded.");
    const omitted = exclusion(relative);
    if (omitted && filtering) {
      result.exclusions.push({ path: relative, reason: omitted });
      return;
    }
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (stat.isSymbolicLink())
      fail(
        "UNSAFE_PATH",
        "Symbolic links are not followed or stored in backups.",
      );
    if (stat.isDirectory()) {
      await inspectPath(file);
      result.directories.push(relative);
      for (const name of (await readdir(file)).sort()) {
        const next = `${relative}/${name}`;
        if (!validRelative(next)) fail("UNSAFE_PATH", "Unsafe backup path.");
        await walk(next);
      }
    } else if (stat.isFile()) {
      const hashed = await hashFile(file, signal);
      total += hashed.bytes;
      if (total > MAX_BYTES)
        fail("INVALID_INPUT", "Backup size limit exceeded.");
      result.files.push({ path: relative, ...hashed });
    } else if (filtering && (stat.isSocket() || stat.isFIFO()))
      result.exclusions.push({ path: relative, reason: "runtime-state" });
    else
      fail(
        "UNSAFE_PATH",
        "Backup contains a device, socket or other unsupported file.",
      );
  }
  for (const entry of entries) await walk(entry.path);
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  result.directories.sort();
  result.exclusions.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
async function syncTree(root: string, signal?: AbortSignal) {
  check(signal);
  for (const name of await readdir(root)) {
    check(signal);
    const file = path.join(root, name);
    const stat = await lstat(file);
    if (stat.isDirectory()) await syncTree(file, signal);
    else if (stat.isFile()) {
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else
      fail("UNSAFE_PATH", "Unexpected entry during backup durability check.");
  }
  await syncDirectory(root);
}
async function stageFor(destination: string, excludedRoot: string) {
  if (
    !path.isAbsolute(destination) ||
    destination.includes("\0") ||
    destination.split(/[\\/]/).includes("..")
  )
    fail(
      "UNSAFE_PATH",
      "Use an absolute destination without parent traversal.",
    );
  const parent = await inspectPath(path.dirname(destination));
  if (!parent.stat.isDirectory() || within(excludedRoot, parent.path))
    fail("UNSAFE_PATH", "Choose a destination outside the source directory.");
  try {
    await lstat(destination);
    fail(
      "UNSAFE_PATH",
      "Destination already exists. Existing profiles and backups are never overwritten.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = path.join(parent.path, `.eve-backup-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  return { staging, parent };
}
async function publish(
  staging: string,
  destination: string,
  parent: Awaited<ReturnType<typeof inspectPath>>,
  signal?: AbortSignal,
  beforeRename?: () => Promise<void>,
) {
  await syncTree(staging, signal);
  await verifyChain(parent.chain);
  check(signal);
  // Exclusive reservation prevents replacing an existing destination; only our empty reservation is replaced.
  await mkdir(destination, { mode: 0o700 });
  const reservation = await lstat(destination);
  try {
    check(signal);
    await beforeRename?.();
    check(signal);
    await rename(staging, destination);
  } catch (error) {
    const current = await lstat(destination).catch(() => undefined);
    if (current?.ino === reservation.ino && current?.dev === reservation.dev)
      await rmdir(destination).catch(() => {});
    throw error;
  }
  try {
    await syncDirectory(parent.path);
  } catch (error) {
    throw new BackupError(
      "DURABILITY_UNCERTAIN",
      "The new directory is visible, but its parent sync failed. Preserve it for review.",
      destination,
      { cause: error },
    );
  }
}
function freezeManifest(manifest: BackupManifest): Readonly<BackupManifest> {
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  const copy = structuredClone(manifest);
  freeze(copy);
  return copy;
}
async function sqliteFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (header.toString("binary") !== "SQLite format 3\0")
      fail(
        "CORRUPT_BACKUP",
        "The core backup callback did not produce a standalone SQLite database.",
      );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Offline artifact assembly only: no UI, networking, provider access, service control or live DB reads. */
export async function exportProfileBackup(
  options: ExportOptions,
): Promise<Readonly<BackupManifest>> {
  check(options.signal);
  const entries = validateEntries(options.entries);
  const versions = versionsSchema.parse(options.versions);
  const source = await inspectPath(options.profileRoot);
  if (!source.stat.isDirectory())
    fail("UNSAFE_PATH", "Choose a profile directory.");
  const { staging, parent } = await stageFor(options.destination, source.path);
  let barrier: Quiescence | undefined;
  let published = false;
  let signal = options.signal;
  const held = async () => {
    check(options.signal);
    try {
      await barrier!.assertHeld();
    } catch (error) {
      throw new BackupError(
        "QUIESCENCE_LOST",
        "The backup pause ended before export finished. Retry after Eve resumes your work.",
        undefined,
        { cause: error },
      );
    }
  };
  try {
    barrier = await options.quiesce(options.signal);
    if (
      !barrier ||
      typeof barrier.release !== "function" ||
      typeof barrier.assertHeld !== "function"
    )
      fail(
        "INVALID_INPUT",
        "Quiescence requires both a live lease assertion and a release callback.",
      );
    signal = barrier.signal
      ? AbortSignal.any([
          barrier.signal,
          ...(options.signal ? [options.signal] : []),
        ])
      : options.signal;
    await held();
    const before = await scan(source.path, entries, signal);
    await held();
    const payload = path.join(staging, "profile");
    await privateDirectory(payload);
    for (const directory of before.directories)
      await privateDirectory(path.join(payload, directory));
    for (const record of before.files) {
      await held();
      await privateDirectory(path.dirname(path.join(payload, record.path)));
      const copied = await copyChecked({
        source: path.join(source.path, record.path),
        destination: path.join(payload, record.path),
        maxBytes: MAX_FILE,
        signal,
      });
      if (copied.sha256 !== record.sha256 || copied.byteLength !== record.bytes)
        fail(
          "SOURCE_CHANGED",
          "A source changed after the backup barrier. Retry after stopping its writer.",
        );
    }
    await held();
    await options.backupDatabase(path.join(payload, "eve.db"), signal);
    await held();
    const databaseFile = await inspectPath(path.join(payload, "eve.db"));
    if (!databaseFile.stat.isFile())
      fail(
        "UNSAFE_PATH",
        "The core backup must create a regular database file inside staging.",
      );
    await chmod(path.join(payload, "eve.db"), 0o600);
    await sqliteFile(path.join(payload, "eve.db"));
    const db = await hashFile(path.join(payload, "eve.db"), signal);
    await verifyChain(source.chain);
    const after = await scan(source.path, entries, signal);
    await held();
    if (!compare(before, after))
      fail(
        "SOURCE_CHANGED",
        "The source changed during export. No backup was published.",
      );
    const manifest = manifestSchema.parse({
      format: "eve-profile-backup",
      formatVersion: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      versions,
      originalProfileRoot: source.path,
      entries,
      files: [
        ...before.files.map(({ identity: _identity, ...record }) => record),
        { path: "eve.db", bytes: db.bytes, sha256: db.sha256 },
      ].sort((a, b) => a.path.localeCompare(b.path)),
      directories: payloadDirectories(before.files, before.directories),
      exclusions: before.exclusions,
      database: "eve.db",
      requiresRelocation: true,
      credentialsIncluded: false,
    });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeDurable(path.join(staging, "manifest.json"), text);
    await writeDurable(
      path.join(staging, "manifest.sha256"),
      `${createHash("sha256").update(text).digest("hex")}\n`,
    );
    await verifyBackup(staging, { signal });
    check(signal);
    // Keep all participating writers paused through the final copy, verification and publish.
    await publish(staging, options.destination, parent, signal, held);
    published = true;
    return freezeManifest(manifest);
  } catch (error) {
    if (
      barrier?.signal?.aborted &&
      !options.signal?.aborted &&
      !(error instanceof BackupError && error.retainedPath)
    )
      throw new BackupError(
        "QUIESCENCE_LOST",
        "The backup pause ended before export finished. Retry after Eve resumes your work.",
        undefined,
        { cause: error },
      );
    throw error;
  } finally {
    try {
      await barrier?.release();
    } catch (error) {
      throw new BackupError(
        "IO_ERROR",
        published
          ? "Backup was published, but resuming the application failed. Preserve this backup and inspect the writer state."
          : "Resuming the application after backup failure also failed. Inspect the writer state.",
        published ? options.destination : undefined,
        { cause: error },
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function verifyBackup(
  directory: string,
  options: { signal?: AbortSignal } = {},
): Promise<Readonly<BackupManifest>> {
  check(options.signal);
  const root = await inspectPath(directory);
  const text = await readChecked(
    path.join(root.path, "manifest.json"),
    32 * 1024 * 1024,
  );
  const checksum = (
    await readChecked(path.join(root.path, "manifest.sha256"), 128)
  )
    .toString("utf8")
    .trim();
  if (
    !/^[a-f0-9]{64}$/.test(checksum) ||
    createHash("sha256").update(text).digest("hex") !== checksum
  )
    fail("CORRUPT_BACKUP", "Backup manifest checksum mismatch.");
  let manifest: BackupManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(text.toString("utf8")));
  } catch (error) {
    throw new BackupError(
      "CORRUPT_BACKUP",
      "Backup manifest schema or paths are invalid.",
      undefined,
      { cause: error },
    );
  }
  validateEntries(manifest.entries);
  if (
    new Set(manifest.files.map((file) => file.path)).size !==
      manifest.files.length ||
    new Set(manifest.directories).size !== manifest.directories.length
  )
    fail("CORRUPT_BACKUP", "Duplicate backup paths.");
  const admitted = (relative: string) =>
    manifest.entries.some(
      (entry) =>
        relative === entry.path || relative.startsWith(entry.path + "/"),
    );
  for (const file of manifest.files)
    if (
      file.path !== "eve.db" &&
      (!admitted(file.path) || exclusion(file.path))
    )
      fail(
        "CORRUPT_BACKUP",
        "Manifest contains an unadmitted or credential/runtime path.",
      );
  for (const directory of manifest.directories)
    if (
      (!admitted(directory) &&
        !manifest.entries.some((entry) =>
          entry.path.startsWith(directory + "/"),
        )) ||
      exclusion(directory)
    )
      fail("CORRUPT_BACKUP", "Manifest contains an unadmitted directory.");
  const top = (await readdir(root.path)).sort();
  if (!compare(top, ["manifest.json", "manifest.sha256", "profile"]))
    fail("CORRUPT_BACKUP", "Unexpected data alongside the backup manifest.");
  const payload = path.join(root.path, "profile");
  // Scanning the actual whole payload catches unlisted additions and links, not just manifest members.
  const payloadEntries = (await readdir(payload))
    .sort()
    .map((name) => ({ path: name, kind: "project" as const }));
  const actual = await scan(payload, payloadEntries, options.signal, false);
  const actualFiles = actual.files.map(
    ({ identity: _identity, ...record }) => record,
  );
  if (
    !compare(actualFiles, manifest.files) ||
    !compare(actual.directories, manifest.directories)
  )
    fail(
      "CORRUPT_BACKUP",
      "Backup files, directories or hashes do not match the manifest.",
    );
  await sqliteFile(path.join(payload, "eve.db"));
  await verifyChain(root.chain);
  return freezeManifest(manifest);
}

export async function restoreProfileBackup(
  options: RestoreOptions,
): Promise<{
  profilePath: string;
  manifest: Readonly<BackupManifest>;
  receipt: RelocationReceipt;
}> {
  check(options.signal);
  if (typeof options.relocate !== "function")
    fail(
      "RELOCATION_REQUIRED",
      "Restore requires an application-specific path relocation validator.",
    );
  if (typeof options.validateVersions !== "function")
    fail(
      "VERSION_REFUSED",
      "Restore requires explicit application/database version validation.",
    );
  const manifest = await verifyBackup(options.backupDirectory, {
    signal: options.signal,
  });
  if (
    (await options.validateVersions(
      Object.freeze({ ...manifest.versions }),
    )) !== true
  )
    fail(
      "VERSION_REFUSED",
      "This application/database version was not accepted for restore.",
    );
  if (within(manifest.originalProfileRoot, options.destination))
    fail(
      "UNSAFE_PATH",
      "Restore into a separate new profile, not inside the original profile.",
    );
  const source = await inspectPath(options.backupDirectory);
  const { staging, parent } = await stageFor(options.destination, source.path);
  try {
    for (const directory of manifest.directories)
      await privateDirectory(path.join(staging, directory));
    for (const record of manifest.files) {
      check(options.signal);
      await privateDirectory(path.dirname(path.join(staging, record.path)));
      const copied = await copyChecked({
        source: path.join(source.path, "profile", record.path),
        destination: path.join(staging, record.path),
        maxBytes: MAX_FILE,
        signal: options.signal,
      });
      if (copied.sha256 !== record.sha256 || copied.byteLength !== record.bytes)
        fail("CORRUPT_BACKUP", "The backup changed while restoring.");
    }
    // Recheck source namespace and manifest before granting a trusted transformation callback access.
    const current = await verifyBackup(source.path, { signal: options.signal });
    if (!compare(current, manifest))
      fail("CORRUPT_BACKUP", "The backup changed while restoring.");
    const response = await options.relocate({
      stagingProfile: staging,
      destinationProfile: options.destination,
      originalProfileRoot: manifest.originalProfileRoot,
      manifest,
      signal: options.signal,
    });
    const receiptResult = z
      .object({
        validated: z.literal(true),
        changedFiles: z.array(relativePath).max(MAX_COUNT),
        notes: z.array(z.string().max(4096)).max(1000),
      })
      .strict()
      .safeParse(response);
    if (!receiptResult.success)
      fail(
        "RELOCATION_REQUIRED",
        "Path relocation was not explicitly validated.",
      );
    const receipt: RelocationReceipt = receiptResult.data;
    const paths = new Set(manifest.files.map((file) => file.path));
    if (
      new Set(receipt.changedFiles).size !== receipt.changedFiles.length ||
      receipt.changedFiles.some((file) => !paths.has(file))
    )
      fail(
        "RELOCATION_REQUIRED",
        "Relocation receipt contains unknown or duplicate files.",
      );
    const actual = await scan(
      staging,
      (await readdir(staging))
        .sort()
        .map((name) => ({ path: name, kind: "project" as const })),
      options.signal,
      false,
    );
    if (
      !compare(actual.directories, manifest.directories) ||
      !compare(
        actual.files.map((file) => file.path),
        manifest.files.map((file) => file.path),
      )
    )
      fail(
        "RELOCATION_REQUIRED",
        "Relocation added or removed unexpected files.",
      );
    for (const file of actual.files) {
      const original = manifest.files.find(
        (record) => record.path === file.path,
      )!;
      if (
        (original.sha256 !== file.sha256 || original.bytes !== file.bytes) &&
        !receipt.changedFiles.includes(file.path)
      )
        fail(
          "RELOCATION_REQUIRED",
          "Relocation changed a file without identifying it in the receipt.",
        );
      await chmod(path.join(staging, file.path), 0o600);
    }
    for (const directory of actual.directories)
      await chmod(path.join(staging, directory), 0o700);
    await chmod(staging, 0o700);
    await sqliteFile(path.join(staging, "eve.db"));
    check(options.signal);
    await writeDurable(
      path.join(staging, "restore-receipt.json"),
      `${JSON.stringify({ version: 1, backupId: manifest.id, versions: manifest.versions, requiresApplicationQualification: true, relocation: receipt, files: actual.files.map(({ identity: _identity, ...file }) => file) }, null, 2)}\n`,
    );
    await publish(staging, options.destination, parent, options.signal);
    return {
      profilePath: options.destination,
      manifest,
      receipt: structuredClone(receipt),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
