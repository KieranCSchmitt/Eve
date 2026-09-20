import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  exportProfileBackup,
  restoreProfileBackup,
  verifyBackup,
  type ExportOptions,
  type RelocationContext,
} from "../../packages/backup/src/index";

const temporary: string[] = [];
const databases: Database.Database[] = [];
async function put(root: string, relative: string, content: string) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "eve-backup-test-")),
  );
  temporary.push(root);
  const profile = path.join(root, "original");
  await mkdir(profile, { mode: 0o700 });
  await put(
    profile,
    "storage/assets/photo/original.txt",
    "Original managed content",
  );
  await put(profile, "workspaces/orbit/index.html", "<main>My project</main>");
  await put(
    profile,
    "workspaces/orbit/.env",
    "OPENAI_API_KEY=test-never-export",
  );
  await put(
    profile,
    "workspaces/orbit/node_modules/generated.js",
    "rebuild me",
  );
  await put(
    profile,
    "workspaces/orbit/.git/objects/history",
    "Unsynced authored history",
  );
  await put(
    profile,
    "workspaces/orbit/.git/config",
    "https://token@example.invalid/repository",
  );
  await put(profile, "workspaces/orbit/runtime.sock", "not socket data");
  await put(profile, "workspaces/orbit/.eve-config.lock", "stale runtime lock");
  await put(profile, "settings/theme.json", '{"theme":"light"}');
  await put(
    profile,
    "workbench/recovery/pending.json",
    JSON.stringify({
      projectRoot: path.join(profile, "workspaces/orbit"),
      documents: [{ text: "unsaved content", uri: "untitled:Unsaved-1" }],
    }),
  );
  await put(
    profile,
    "workbench/recovery/unknown.tmp",
    "Preserve this unknown recovery material",
  );
  await put(profile, "intelligence/providers.enc", "secret ciphertext");
  const db = new Database(path.join(profile, "eve.db"));
  databases.push(db);
  db.pragma("journal_mode = WAL");
  db.pragma("user_version = 7");
  db.exec("CREATE TABLE state (project TEXT)");
  db.prepare("INSERT INTO state VALUES (?)").run(
    path.join(profile, "workspaces/orbit"),
  );
  let paused = false;
  const release = vi.fn(async () => {
    paused = false;
  });
  const backupDatabase = vi.fn(async (destination: string) => {
    expect(paused).toBe(true);
    await db.backup(destination);
  });
  const options: ExportOptions = {
    profileRoot: profile,
    destination: path.join(root, "backup"),
    versions: { app: "0.1.0", schema: 7 },
    entries: [
      { path: "storage/assets", kind: "managed-originals" },
      { path: "workspaces", kind: "project" },
      { path: "settings/theme.json", kind: "settings" },
      { path: "workbench/recovery", kind: "recovery" },
    ],
    quiesce: async () => {
      paused = true;
      return {
        release,
        assertHeld: async () => {
          if (!paused) throw new Error("Pause expired");
        },
      };
    },
    backupDatabase,
  };
  return { root, profile, db, options, release, backupDatabase };
}
async function relocate(context: RelocationContext) {
  // Deliberately tiny fixture-specific relocation, not Eve's production schema integration.
  const db = new Database(path.join(context.stagingProfile, "eve.db"));
  try {
    if (
      db.pragma("user_version", { simple: true }) !==
      context.manifest.versions.schema
    )
      throw new Error("Actual schema mismatch");
    db.prepare("UPDATE state SET project = ?").run(
      path.join(context.destinationProfile, "workspaces/orbit"),
    );
  } finally {
    db.close();
  }
  const journal = JSON.parse(
    await readFile(
      path.join(context.stagingProfile, "workbench/recovery/pending.json"),
      "utf8",
    ),
  );
  journal.projectRoot = path.join(
    context.destinationProfile,
    "workspaces/orbit",
  );
  await writeFile(
    path.join(context.stagingProfile, "workbench/recovery/pending.json"),
    JSON.stringify(journal),
  );
  return {
    validated: true as const,
    changedFiles: ["eve.db", "workbench/recovery/pending.json"],
    notes: ["Unknown recovery material retained for explicit review."],
  };
}
async function rewriteManifest(
  directory: string,
  edit: (manifest: any) => void,
) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  edit(manifest);
  const text = JSON.stringify(manifest);
  await writeFile(path.join(directory, "manifest.json"), text);
  await writeFile(
    path.join(directory, "manifest.sha256"),
    createHash("sha256").update(text).digest("hex") + "\n",
  );
}

describe("consistent private profile export", () => {
  it("exports real online SQLite plus original/project/recovery data, with private modes and explicit omissions", async () => {
    const fixtureData = await fixture();
    const { options, release } = fixtureData;
    const manifest = await exportProfileBackup(options);
    expect(release).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(manifest.files)).toBe(true);
    expect(manifest.exclusions).toEqual(
      expect.arrayContaining([
        { path: "workspaces/orbit/.env", reason: "credentials" },
        { path: "workspaces/orbit/node_modules", reason: "rebuildable" },
        { path: "workspaces/orbit/runtime.sock", reason: "runtime-state" },
      ]),
    );
    expect(
      manifest.files.some((file) => file.path.endsWith("unknown.tmp")),
    ).toBe(true);
    expect(
      manifest.files.some((file) => file.path.endsWith(".git/objects/history")),
    ).toBe(true);
    expect(manifest.exclusions).toContainEqual({
      path: "workspaces/orbit/.git/config",
      reason: "credentials",
    });
    expect(manifest.exclusions).toContainEqual({
      path: "workspaces/orbit/.eve-config.lock",
      reason: "runtime-state",
    });
    expect(
      manifest.files.some((file) =>
        /providers|\.env|eve\.db-wal/.test(file.path),
      ),
    ).toBe(false);
    expect((await lstat(options.destination)).mode & 0o777).toBe(0o700);
    for (const item of manifest.files)
      expect(
        (await lstat(path.join(options.destination, "profile", item.path)))
          .mode & 0o777,
      ).toBe(0o600);
    // Never open the immutable archive in SQLite: a WAL-mode database may create sidecars even read-only.
    await copyFile(
      path.join(options.destination, "profile/eve.db"),
      path.join(fixtureData.root, "inspection.db"),
    );
    const saved = new Database(path.join(fixtureData.root, "inspection.db"), {
      readonly: true,
    });
    try {
      expect(saved.prepare("SELECT project FROM state").get()).toEqual({
        project: path.join(fixtureData.profile, "workspaces/orbit"),
      });
    } finally {
      saved.close();
    }
    expect(await verifyBackup(options.destination)).toEqual(manifest);
  });
  it("detects a writer that changes a project during the database snapshot and resumes exactly once", async () => {
    const { options, profile, root, release, backupDatabase } = await fixture();
    options.backupDatabase = async (destination) => {
      await backupDatabase(destination);
      await writeFile(
        path.join(profile, "workspaces/orbit/index.html"),
        "changed during backup",
      );
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    await expect(lstat(options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      (await readdir(root)).some((name) => name.startsWith(".eve-backup-")),
    ).toBe(false);
  });
  it("detects a new file added while paused and does not publish a partial snapshot", async () => {
    const { options, profile, backupDatabase } = await fixture();
    options.backupDatabase = async (destination) => {
      await backupDatabase(destination);
      await put(profile, "workspaces/orbit/new.txt", "concurrent new file");
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
  });
  it("cancels after the database callback, removes staging and releases the barrier", async () => {
    const { options, release, backupDatabase } = await fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    options.backupDatabase = async (destination) => {
      await backupDatabase(destination);
      controller.abort();
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(lstat(options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects an incomplete core snapshot and identifies an already-published backup if barrier release fails", async () => {
    const { options, release, backupDatabase } = await fixture();
    await expect(
      exportProfileBackup({
        ...options,
        backupDatabase: async (destination) => {
          await writeFile(destination, "not SQLite");
        },
      }),
    ).rejects.toMatchObject({ code: "CORRUPT_BACKUP" });
    expect(release).toHaveBeenCalledTimes(1);
    options.backupDatabase = backupDatabase;
    // Keep the fixture's actual writer pause assertion active while substituting a failing release.
    const originalQuiesce = options.quiesce;
    options.quiesce = async (signal) => {
      const lease = await originalQuiesce(signal);
      return {
        assertHeld: () => lease.assertHeld(),
        release: async () => {
          await lease.release();
          throw new Error("writer resume failed");
        },
      };
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "IO_ERROR",
      retainedPath: options.destination,
    });
    expect(release).toHaveBeenCalledTimes(2);
    await expect(verifyBackup(options.destination)).resolves.toMatchObject({
      format: "eve-profile-backup",
    });
  });
  it("refuses source links, overlapping entries, secret roots and destinations inside the profile", async () => {
    const { options, profile } = await fixture();
    await symlink(
      "/etc/passwd",
      path.join(profile, "workspaces/orbit/outside"),
    );
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await rm(path.join(profile, "workspaces/orbit/outside"));
    await expect(
      exportProfileBackup({
        ...options,
        entries: [
          ...options.entries,
          { path: "workspaces/orbit", kind: "project" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exportProfileBackup({
        ...options,
        entries: [{ path: "intelligence", kind: "project" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exportProfileBackup({
        ...options,
        destination: path.join(profile, "backup"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
  it("refuses a backup whose writer lease expires during an otherwise unchanged database snapshot", async () => {
    const { options, release, backupDatabase } = await fixture();
    const acquire = options.quiesce;
    let expired = false;
    options.quiesce = async (signal) => {
      const lease = await acquire(signal);
      return {
        release: lease.release,
        assertHeld: async () => {
          if (expired) throw new Error("Guardian released the writers");
          await lease.assertHeld();
        },
      };
    };
    options.backupDatabase = async (destination) => {
      await backupDatabase(destination);
      expired = true;
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "QUIESCENCE_LOST",
    });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(lstat(options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("checks the live lease again after verification and fsync immediately before publication", async () => {
    const { options, root, release } = await fixture();
    const acquire = options.quiesce;
    options.quiesce = async (signal) => {
      const lease = await acquire(signal);
      return {
        release: lease.release,
        assertHeld: async () => {
          await lease.assertHeld();
          const staging = (await readdir(root)).find((name) =>
            name.startsWith(".eve-backup-"),
          )!;
          if (
            await lstat(path.join(root, staging, "manifest.json")).then(
              () => true,
              () => false,
            )
          )
            throw new Error("Lease expired while verification was running");
        },
      };
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "QUIESCENCE_LOST",
    });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(lstat(options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("forwards lease loss to an active database snapshot and awaits its cleanup before release", async () => {
    const { options, release } = await fixture();
    const leaseEnded = new AbortController();
    const acquire = options.quiesce;
    let databaseStopped = false;
    options.quiesce = async (signal) => {
      const lease = await acquire(signal);
      return {
        signal: leaseEnded.signal,
        assertHeld: lease.assertHeld,
        release: async () => {
          expect(databaseStopped).toBe(true);
          await lease.release();
        },
      };
    };
    options.backupDatabase = async (_destination, signal) => {
      expect(signal?.aborted).toBe(false);
      leaseEnded.abort();
      expect(signal?.aborted).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      databaseStopped = true;
      throw new Error("Database snapshot cancelled after stopping its writer");
    };
    await expect(exportProfileBackup(options)).rejects.toMatchObject({
      code: "QUIESCENCE_LOST",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("verification and mandatory relocation restore", () => {
  it("restores to a fresh private profile only after actual schema and path relocation, preserving old data", async () => {
    const { options, profile, root, db } = await fixture();
    await exportProfileBackup(options);
    const destination = path.join(root, "restored");
    const result = await restoreProfileBackup({
      backupDirectory: options.destination,
      destination,
      validateVersions: async (versions) => versions.schema === 7,
      relocate,
    });
    const restored = new Database(path.join(destination, "eve.db"));
    try {
      expect(restored.prepare("SELECT project FROM state").get()).toEqual({
        project: path.join(destination, "workspaces/orbit"),
      });
    } finally {
      restored.close();
    }
    expect(db.prepare("SELECT project FROM state").get()).toEqual({
      project: path.join(profile, "workspaces/orbit"),
    });
    expect(result.receipt.changedFiles).toContain("eve.db");
    expect((await lstat(destination)).mode & 0o777).toBe(0o700);
    await expect(
      lstat(path.join(destination, "intelligence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      restoreProfileBackup({
        backupDirectory: options.destination,
        destination,
        validateVersions: async () => true,
        relocate,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(
      restoreProfileBackup({
        backupDirectory: options.destination,
        destination: path.join(profile, "nested"),
        validateVersions: async () => true,
        relocate,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
  it("refuses missing relocation or version consent before making a profile", async () => {
    const { options, root } = await fixture();
    await exportProfileBackup(options);
    const destination = path.join(root, "new");
    await expect(
      restoreProfileBackup({
        backupDirectory: options.destination,
        destination,
        validateVersions: async () => true,
        relocate: undefined as any,
      }),
    ).rejects.toMatchObject({ code: "RELOCATION_REQUIRED" });
    await expect(
      restoreProfileBackup({
        backupDirectory: options.destination,
        destination,
        validateVersions: async () => false,
        relocate,
      }),
    ).rejects.toMatchObject({ code: "VERSION_REFUSED" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects corruption, unlisted files, and traversal even when an attacker recomputes the manifest checksum", async () => {
    const { options } = await fixture();
    await exportProfileBackup(options);
    const file = path.join(
      options.destination,
      "profile/workspaces/orbit/index.html",
    );
    const original = await readFile(file);
    await writeFile(file, "corrupt");
    await expect(verifyBackup(options.destination)).rejects.toMatchObject({
      code: "CORRUPT_BACKUP",
    });
    await writeFile(file, original);
    await put(options.destination, "profile/extra.txt", "unlisted");
    await expect(verifyBackup(options.destination)).rejects.toMatchObject({
      code: "CORRUPT_BACKUP",
    });
    await rm(path.join(options.destination, "profile/extra.txt"));
    await rewriteManifest(options.destination, (manifest) => {
      manifest.files[0].path = "../escape";
    });
    await expect(verifyBackup(options.destination)).rejects.toMatchObject({
      code: "CORRUPT_BACKUP",
    });
  });
  it("rejects a credential entry disguised in a recomputed manifest", async () => {
    const { options } = await fixture();
    await exportProfileBackup(options);
    await rewriteManifest(options.destination, (manifest) => {
      manifest.files[0].path = "workspaces/orbit/.env";
    });
    await expect(verifyBackup(options.destination)).rejects.toMatchObject({
      code: "CORRUPT_BACKUP",
    });
  });
  it("requires declared relocation changes, refuses unexpected callback outputs and supports cancellation", async () => {
    const { options, root } = await fixture();
    await exportProfileBackup(options);
    const destination = path.join(root, "restored");
    await expect(
      restoreProfileBackup({
        backupDirectory: options.destination,
        destination,
        validateVersions: async () => true,
        relocate: async (context) => {
          await writeFile(
            path.join(context.stagingProfile, "settings/theme.json"),
            '{"theme":"dark"}',
          );
          return { validated: true, changedFiles: [], notes: [] };
        },
      }),
    ).rejects.toMatchObject({ code: "RELOCATION_REQUIRED" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const controller = new AbortController();
    await expect(
      restoreProfileBackup({
        backupDirectory: options.destination,
        destination,
        validateVersions: async () => true,
        signal: controller.signal,
        relocate: async (context) => {
          const receipt = await relocate(context);
          controller.abort();
          return receipt;
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
