import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveProjectExecution,
  inspectProjectDirectory,
  inspectProjectExecutionTrust,
  type ProjectExecutionIdentity,
} from "../../apps/desktop/host/project-trust";
import {
  approveRestoredProjects,
  inspectRestoredProjectTrust,
} from "../../apps/desktop/host/restored-project-trust";

let root: string, profile: string, project: ProjectExecutionIdentity;
const race = vi.hoisted(() => ({
  afterStat: undefined as undefined | ((file: unknown) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      await race.afterStat?.(args[0]);
      return result;
    },
  };
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const decisionFile = (id = project.id, directory = profile) =>
  path.join(directory, "project-trust", `${hash(id)}.json`);
async function restoredReceipt() {
  const value = {
    version: 1,
    backupId: randomUUID(),
    versions: { app: "0.1.0", schema: 3 },
    requiresApplicationQualification: true,
    relocation: { validated: true, changedFiles: ["eve.db"], notes: [] },
    files: [{ path: "eve.db", bytes: 7, sha256: hash("fixture") }],
  };
  await writeFile(
    path.join(profile, "restore-receipt.json"),
    JSON.stringify(value),
    { mode: 0o600 },
  );
}
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "eve-scoped-trust-")),
  );
  profile = path.join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  const canonicalRoot = path.join(root, "project");
  await mkdir(canonicalRoot);
  const inspected = await inspectProjectDirectory(canonicalRoot);
  project = {
    id: "chosen-project",
    revision: 0,
    verification: "verified",
    ...inspected,
  };
});
afterEach(async () => {
  race.afterStat = undefined;
  await rm(root, { recursive: true, force: true });
});

it("does not transfer approval when a profile is replaced at the same pathname", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  await rename(profile, profile + "-original");
  await mkdir(path.join(profile, "project-trust"), {
    recursive: true,
    mode: 0o700,
  });
  await copyFile(
    decisionFile(project.id, profile + "-original"),
    decisionFile(),
  );
  const current = await inspectProjectExecutionTrust(profile, project);
  expect(current.trusted).toBe(false);
  expect(current.review.profileIdentity).not.toEqual(
    observed.review.profileIdentity,
  );
  await expect(
    approveProjectExecution(profile, project, observed.review),
  ).rejects.toMatchObject({ code: "REVIEW_CHANGED" });
});

it("rechecks directory privacy after reading a project decision", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  race.afterStat = async (file) => {
    if (file !== decisionFile()) return;
    race.afterStat = undefined;
    await chmod(path.dirname(decisionFile()), 0o755);
  };
  await expect(
    inspectProjectExecutionTrust(profile, project),
  ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

it("requires a separate explicit project decision and leaves source contents untouched", async () => {
  await writeFile(
    path.join(project.canonicalRoot, "package.json"),
    '{"scripts":{"start":"must never run"}}',
  );
  const observed = await inspectProjectExecutionTrust(profile, project);
  expect(observed.trusted).toBe(false);
  expect(await readdir(profile)).toEqual([]);
  expect(
    await approveProjectExecution(profile, project, observed.review),
  ).toMatchObject({ trusted: true });
  expect(await inspectProjectExecutionTrust(profile, project)).toMatchObject({
    trusted: true,
  });
  expect((await stat(decisionFile())).mode & 0o777).toBe(0o600);
  expect((await stat(path.dirname(decisionFile()))).mode & 0o777).toBe(0o700);
  expect(await readdir(project.canonicalRoot)).toEqual(["package.json"]);
  const first = await readFile(decisionFile());
  await approveProjectExecution(profile, project, observed.review);
  expect(await readFile(decisionFile())).toEqual(first);
});

it("keeps different project IDs and record revisions independent even at the same root", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  expect(
    (
      await inspectProjectExecutionTrust(profile, {
        ...project,
        id: "different-project",
      })
    ).trusted,
  ).toBe(false);
  const next = { ...project, revision: 1 };
  expect((await inspectProjectExecutionTrust(profile, next)).trusted).toBe(
    false,
  );
  await expect(
    approveProjectExecution(profile, next, observed.review),
  ).rejects.toMatchObject({ code: "REVIEW_CHANGED" });
  const nextReview = await inspectProjectExecutionTrust(profile, next);
  await approveProjectExecution(profile, next, nextReview.review);
  expect((await inspectProjectExecutionTrust(profile, project)).trusted).toBe(
    false,
  );
});

it("invalidates approval after folder replacement and refuses a stale choice before publication", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  const bytes = await readFile(decisionFile());
  await rename(project.canonicalRoot, project.canonicalRoot + "-original");
  await mkdir(project.canonicalRoot);
  await expect(
    inspectProjectExecutionTrust(profile, project),
  ).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
  await expect(
    approveProjectExecution(profile, project, observed.review),
  ).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
  expect(await readFile(decisionFile())).toEqual(bytes);
});

it("requires new review for a restored receipt and never inherits profile-wide trust", async () => {
  const original = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, original.review);
  await restoredReceipt();
  const legacy = await inspectRestoredProjectTrust(profile);
  await approveRestoredProjects(profile, legacy.receiptHash!);
  const restored = await inspectProjectExecutionTrust(profile, project);
  expect(restored.trusted).toBe(false);
  expect(restored.review.restoreReceiptSha256).toBe(legacy.receiptHash);
  await expect(
    approveProjectExecution(profile, project, original.review),
  ).rejects.toMatchObject({ code: "REVIEW_CHANGED" });
  await approveProjectExecution(profile, project, restored.review);
  expect((await inspectProjectExecutionTrust(profile, project)).trusted).toBe(
    true,
  );
  await restoredReceipt();
  expect((await inspectProjectExecutionTrust(profile, project)).trusted).toBe(
    false,
  );
});

it("does not transfer decisions to another profile or infer authority from malformed approval", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  const other = path.join(root, "other-profile");
  await mkdir(path.join(other, "project-trust"), {
    recursive: true,
    mode: 0o700,
  });
  await copyFile(decisionFile(), decisionFile(project.id, other));
  expect((await inspectProjectExecutionTrust(other, project)).trusted).toBe(
    false,
  );
  await writeFile(decisionFile(), '{"trusted":true}');
  expect((await inspectProjectExecutionTrust(profile, project)).trusted).toBe(
    false,
  );
  await approveProjectExecution(profile, project, observed.review);
  expect((await inspectProjectExecutionTrust(profile, project)).trusted).toBe(
    true,
  );
});

it("does not grant unverified legacy records any project authority", async () => {
  const legacy: ProjectExecutionIdentity = {
    ...project,
    verification: "legacy-unverified",
    rootIdentity: null,
  };
  await expect(
    inspectProjectExecutionTrust(profile, legacy),
  ).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
  expect(await readdir(profile)).toEqual([]);
});

it("rejects linked project roots and metadata paths without reading their targets", async () => {
  const alias = path.join(root, "alias");
  await symlink(project.canonicalRoot, alias);
  await expect(inspectProjectDirectory(alias)).rejects.toMatchObject({
    code: "UNSAFE_PATH",
  });
  await expect(
    inspectProjectDirectory(path.join(alias, "child")),
  ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  const outside = path.join(root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(profile, "project-trust"));
  await expect(
    inspectProjectExecutionTrust(profile, project),
  ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  expect(await readdir(outside)).toEqual([]);
});

it("refuses public profiles, public decisions and hardlinked decisions", async () => {
  await chmod(profile, 0o755);
  await expect(
    inspectProjectExecutionTrust(profile, project),
  ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  await chmod(profile, 0o700);
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  await chmod(decisionFile(), 0o644);
  await expect(
    inspectProjectExecutionTrust(profile, project),
  ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  await chmod(decisionFile(), 0o600);
  await link(decisionFile(), path.join(root, "linked-decision"));
  await expect(
    inspectProjectExecutionTrust(profile, project),
  ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

it("keeps one project decision from approving a second folder", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  const otherRoot = path.join(root, "other-folder");
  await mkdir(otherRoot);
  const other = { ...project, ...(await inspectProjectDirectory(otherRoot)) };
  expect((await inspectProjectExecutionTrust(profile, other)).trusted).toBe(
    false,
  );
  await expect(
    approveProjectExecution(profile, other, observed.review),
  ).rejects.toMatchObject({ code: "REVIEW_CHANGED" });
});

it("allows ordinary source edits after approval without pretending it is a sandbox", async () => {
  const observed = await inspectProjectExecutionTrust(profile, project);
  await approveProjectExecution(profile, project, observed.review);
  await writeFile(
    path.join(project.canonicalRoot, "new-file.ts"),
    "export const ordinaryEdit = true;",
  );
  expect((await inspectProjectExecutionTrust(profile, project)).trusted).toBe(
    true,
  );
});
