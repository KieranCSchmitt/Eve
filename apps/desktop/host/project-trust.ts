import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  syncDirectory,
  writeDurable,
} from "../../../packages/imports/src/filesystem";
import { inspectRestoredProjectTrust } from "./restored-project-trust";

export interface ProjectDirectoryIdentity {
  device: string;
  inode: string;
}
/** These fields come from a fresh core ProjectRecord, never a renderer payload. */
export interface ProjectExecutionIdentity {
  id: string;
  revision: number;
  canonicalRoot: string;
  verification: "verified" | "legacy-unverified";
  rootIdentity: ProjectDirectoryIdentity | null;
}
export class ProjectTrustError extends Error {
  constructor(
    readonly code:
      | "UNSAFE_PATH"
      | "UNVERIFIED_PROJECT"
      | "PROJECT_CHANGED"
      | "REVIEW_CHANGED"
      | "IO_ERROR"
      | "DURABILITY_UNCERTAIN",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectTrustError";
  }
}
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const directoryIdentity = z
  .object({ device: decimal, inode: decimal })
  .strict();
const executionIdentity = z
  .object({
    id: z.string().min(1).max(128),
    revision: z.number().int().nonnegative().safe(),
    canonicalRoot: z.string().min(1).max(4096),
    verification: z.literal("verified"),
    rootIdentity: directoryIdentity,
  })
  .strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("eve-project-execution-approval"),
    profileRoot: z.string().min(1).max(4096),
    profileIdentity: directoryIdentity,
    project: executionIdentity,
    restoreReceiptSha256: digest.nullable(),
    reviewFingerprint: digest,
    approvedAt: z.string().datetime(),
  })
  .strict();
export interface ProjectTrustReview {
  readonly profileRoot: string;
  readonly profileIdentity: Readonly<ProjectDirectoryIdentity>;
  readonly project: Readonly<ProjectExecutionIdentity>;
  readonly restoreReceiptSha256: string | null;
  readonly fingerprint: string;
}
export interface ProjectExecutionTrust {
  readonly trusted: boolean;
  readonly review: ProjectTrustReview;
}
interface DirectoryChain {
  canonicalRoot: string;
  privateDirectory: boolean;
  rootIdentity: ProjectDirectoryIdentity;
  chain: { file: string; device: bigint; inode: bigint }[];
}
const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");
const fail = (code: ProjectTrustError["code"], message: string): never => {
  throw new ProjectTrustError(code, message);
};
const ownedPrivate = (stat: BigIntStats) =>
  (stat.mode & 0o077n) === 0n &&
  (!process.getuid || stat.uid === BigInt(process.getuid()));
const statIdentity = (stat: BigIntStats) =>
  [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.mode,
    stat.uid,
    stat.nlink,
  ].join(":");

async function verifyChain(root: DirectoryChain) {
  for (const entry of root.chain) {
    const current = await lstat(entry.file, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== entry.device ||
      current.ino !== entry.inode
    )
      fail(
        "PROJECT_CHANGED",
        "A folder changed while it was being checked. Choose the current folder again.",
      );
    if (
      root.privateDirectory &&
      entry.file === root.canonicalRoot &&
      !ownedPrivate(current)
    )
      fail(
        "UNSAFE_PATH",
        "Eve needs a folder that only your account can access to save project approvals.",
      );
  }
}
async function inspectDirectory(
  input: string,
  privateDirectory = false,
): Promise<DirectoryChain> {
  if (
    typeof input !== "string" ||
    !path.isAbsolute(input) ||
    path.normalize(input) !== input ||
    input.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    input.length > 4096
  )
    return fail(
      "UNSAFE_PATH",
      "Choose the project folder itself. Folder shortcuts cannot be used here.",
    );
  const chain: DirectoryChain["chain"] = [];
  let file = path.parse(input).root;
  for (const component of [
    "",
    ...path.relative(file, input).split(path.sep).filter(Boolean),
  ]) {
    if (component) file = path.join(file, component);
    const stat = await lstat(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return fail(
        "UNSAFE_PATH",
        "Choose the project folder itself. Folder shortcuts cannot be used here.",
      );
    chain.push({ file, device: stat.dev, inode: stat.ino });
    if (file === input && privateDirectory && !ownedPrivate(stat))
      return fail(
        "UNSAFE_PATH",
        "Eve needs a workspace folder that only your account can access to save project approvals.",
      );
  }
  if ((await realpath(input)) !== input)
    return fail("UNSAFE_PATH", "Choose the project folder itself.");
  const last = chain.at(-1)!;
  const result = {
    canonicalRoot: input,
    privateDirectory,
    rootIdentity: {
      device: last.device.toString(),
      inode: last.inode.toString(),
    },
    chain,
  };
  await verifyChain(result);
  return result;
}

/** No file contents, project scripts, manifests or extensions are evaluated. */
export async function inspectProjectDirectory(
  canonicalRoot: string,
): Promise<{ canonicalRoot: string; rootIdentity: ProjectDirectoryIdentity }> {
  const result = await inspectDirectory(canonicalRoot);
  return {
    canonicalRoot: result.canonicalRoot,
    rootIdentity: result.rootIdentity,
  };
}

function verifiedProject(project: ProjectExecutionIdentity) {
  const parsed = executionIdentity.safeParse({
    id: project.id,
    revision: project.revision,
    canonicalRoot: project.canonicalRoot,
    verification: project.verification,
    rootIdentity: project.rootIdentity,
  });
  if (!parsed.success)
    return fail(
      "UNVERIFIED_PROJECT",
      "Choose this project folder again before opening its code or preview.",
    );
  return parsed.data;
}
async function review(profileRoot: string, input: ProjectExecutionIdentity) {
  const project = verifiedProject(input);
  const profile = await inspectDirectory(profileRoot, true);
  const directory = await inspectDirectory(project.canonicalRoot);
  if (
    project.rootIdentity.device !== directory.rootIdentity.device ||
    project.rootIdentity.inode !== directory.rootIdentity.inode
  )
    return fail(
      "PROJECT_CHANGED",
      "This project folder was replaced. Its previous trust decision does not apply to the new folder.",
    );
  // The legacy profile-wide decision deliberately grants no project authority.
  // Only the verified receipt identity is included in this project decision.
  const restore = await inspectRestoredProjectTrust(profileRoot);
  const body = {
    profileRoot,
    profileIdentity: Object.freeze({ ...profile.rootIdentity }),
    project,
    restoreReceiptSha256: restore.receiptHash ?? null,
  };
  const result: ProjectTrustReview = Object.freeze({
    ...body,
    project: Object.freeze({
      ...project,
      rootIdentity: Object.freeze(project.rootIdentity),
    }),
    fingerprint: hash(JSON.stringify(body)),
  });
  await verifyChain(profile);
  await verifyChain(directory);
  return { result, profile, directory };
}

const approvalDirectory = (profileRoot: string) =>
  path.join(profileRoot, "project-trust");
const approvalName = (projectId: string) => `${hash(projectId)}.json`;
async function privateApproval(
  profile: DirectoryChain,
  projectId: string,
): Promise<z.infer<typeof approvalSchema> | undefined> {
  await verifyChain(profile);
  const folder = approvalDirectory(profile.canonicalRoot);
  try {
    await lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await verifyChain(profile);
      return undefined;
    }
    throw error;
  }
  const directory = await inspectDirectory(folder, true);
  const file = path.join(folder, approvalName(projectId));
  let observed: BigIntStats;
  try {
    observed = await lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await verifyChain(directory);
      return undefined;
    }
    throw error;
  }
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.nlink !== 1n ||
    !ownedPrivate(observed) ||
    observed.size > 16_384n
  )
    return fail(
      "UNSAFE_PATH",
      "Eve could not securely read this saved project approval. Check the permissions for your Eve workspace folder.",
    );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (statIdentity(before) !== statIdentity(observed))
      return fail(
        "REVIEW_CHANGED",
        "The saved project decision changed during inspection.",
      );
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await verifyChain(profile);
    await verifyChain(directory);
    if (
      count !== Number(before.size) ||
      statIdentity(before) !== statIdentity(after) ||
      statIdentity(await lstat(file, { bigint: true })) !== statIdentity(after)
    )
      return fail(
        "REVIEW_CHANGED",
        "The saved project decision changed during inspection.",
      );
    let json: unknown;
    try {
      json = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, count),
        ),
      );
    } catch {
      return undefined;
    }
    const parsed = approvalSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } finally {
    await handle.close();
  }
}

/** Call immediately before each new workbench/preview execution admission. A
 * decision identifies a folder and revision; it is not a sandbox or file freeze. */
export async function inspectProjectExecutionTrust(
  profileRoot: string,
  project: ProjectExecutionIdentity,
): Promise<ProjectExecutionTrust> {
  const observed = await review(profileRoot, project);
  const approval = await privateApproval(observed.profile, project.id);
  const current = await review(profileRoot, project);
  if (current.result.fingerprint !== observed.result.fingerprint)
    return fail(
      "REVIEW_CHANGED",
      "The project changed while its trust decision was being checked.",
    );
  const trusted =
    !!approval &&
    approval.reviewFingerprint === current.result.fingerprint &&
    approval.profileRoot === current.result.profileRoot &&
    approval.profileIdentity.device === current.result.profileIdentity.device &&
    approval.profileIdentity.inode === current.result.profileIdentity.inode &&
    approval.restoreReceiptSha256 === current.result.restoreReceiptSha256 &&
    JSON.stringify(approval.project) === JSON.stringify(current.result.project);
  return { trusted, review: current.result };
}

/** Only a native explicit user choice may call this. The host must fetch the
 * current core record again after the dialog; expectedReview binds that choice. */
export async function approveProjectExecution(
  profileRoot: string,
  project: ProjectExecutionIdentity,
  expectedReview: ProjectTrustReview,
): Promise<ProjectExecutionTrust> {
  const observed = await inspectProjectExecutionTrust(profileRoot, project);
  if (
    observed.review.fingerprint !== expectedReview.fingerprint ||
    expectedReview.profileRoot !== profileRoot ||
    expectedReview.project.id !== project.id
  )
    return fail(
      "REVIEW_CHANGED",
      "The project or restored workspace changed since you reviewed it. Review it again before opening.",
    );
  if (observed.trusted) return observed;
  const profile = await inspectDirectory(profileRoot, true);
  const directory = approvalDirectory(profileRoot);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const decisions = await inspectDirectory(directory, true);
  const temporary = path.join(directory, `.decision-${randomUUID()}.tmp`);
  const target = path.join(directory, approvalName(project.id));
  let published = false;
  try {
    const value = {
      version: 1,
      kind: "eve-project-execution-approval",
      profileRoot,
      profileIdentity: observed.review.profileIdentity,
      project: observed.review.project,
      restoreReceiptSha256: observed.review.restoreReceiptSha256,
      reviewFingerprint: observed.review.fingerprint,
      approvedAt: new Date().toISOString(),
    };
    await writeDurable(temporary, `${JSON.stringify(value, null, 2)}\n`);
    const current = await inspectProjectExecutionTrust(profileRoot, project);
    if (current.review.fingerprint !== expectedReview.fingerprint)
      return fail(
        "REVIEW_CHANGED",
        "The project changed before its decision could be saved.",
      );
    await verifyChain(profile);
    await verifyChain(decisions);
    await rename(temporary, target);
    published = true;
    await syncDirectory(directory);
    await syncDirectory(profileRoot);
    const saved = await inspectProjectExecutionTrust(profileRoot, project);
    if (
      !saved.trusted ||
      saved.review.fingerprint !== expectedReview.fingerprint
    )
      return fail(
        "REVIEW_CHANGED",
        "The project changed while the decision was being saved. Opening remains blocked.",
      );
    return saved;
  } catch (error) {
    if (error instanceof ProjectTrustError) throw error;
    throw new ProjectTrustError(
      published ? "DURABILITY_UNCERTAIN" : "IO_ERROR",
      published
        ? "Eve could not confirm that your project approval finished saving. Try reviewing the project again before opening it."
        : "The project decision could not be saved. Opening remains blocked.",
      { cause: error },
    );
  } finally {
    await verifyChain(decisions)
      .then(() => rm(temporary, { force: true }))
      .catch(() => {});
  }
}
