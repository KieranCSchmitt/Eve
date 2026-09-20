import { afterEach, describe, expect, it } from "vitest";
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
import { CoreStore } from "@eve/core";
import { ALL_CAPABILITIES } from "@eve/contracts";
import {
  exportEveProfile,
  type ExportEveProfileOptions,
  type ProfileWorkbench,
} from "../../apps/desktop/host/profile-backup";
import { MutationGate } from "../../apps/desktop/host/mutation-gate";
import { WorkbenchRegistry, type WorkbenchIdentity } from "../../apps/desktop/host/workbench-registry";
import type { CoreMaintenanceClient } from "../../apps/desktop/host/core-client";
import type { WorkbenchPauseLease } from "../../apps/desktop/host/workbench-pause";
import { verifyBackup } from "../../packages/backup/src/index";

const temporary: string[] = [],
  stores: CoreStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function put(profile: string, relative: string, content: string) {
  const file = path.join(profile, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function fixture(withWorkbench = true) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "eve-profile-backup-")),
  );
  temporary.push(root);
  const profile = path.join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  await put(profile, "workspaces/orbit/index.html", "User project");
  await put(
    profile,
    "storage/projects/imported/readme.txt",
    "Imported project",
  );
  await put(profile, "storage/assets/source/original.txt", "Original source");
  await put(
    profile,
    "workbench/recovery/unknown.journal",
    "Preserve unknown recovery bytes",
  );
  await put(profile, "workspaces/orbit/.env", "API_KEY=not-exported");
  await put(profile, "workbench/workbench-owner.json", "runtime state");
  await put(profile, "intelligence/providers.enc", "provider credentials");
  await put(profile, "unregistered.txt", "Outside the explicit allowlist");
  const store = new CoreStore({
    dbPath: path.join(profile, "eve.db"),
    orbitProjectPath: path.join(profile, "workspaces/orbit"),
  });
  stores.push(store);
  const events: string[] = [];
  const gate = new MutationGate();
  let inputHeld = false,
    writersHeld = false;
  const ended = new AbortController();
  const pause: WorkbenchPauseLease = {
    id: "test-lease",
    signal: ended.signal,
    documents: [],
    qualification: {
      ownedWriters: "paused",
      externalWriters: "not-controlled",
      platform: "linux",
      hardwareQualified: false,
    },
    assertHeld: async () => {
      ended.signal.throwIfAborted();
      if (!writersHeld) throw new Error("writers resumed");
    },
    renew: async () => {},
    release: async () => {
      events.push("resume-writers");
      writersHeld = false;
      ended.abort();
    },
  };
  const workbench = {
    acquireBackupPause: async (
      options: Parameters<
        NonNullable<
          ProfileWorkbench
        >["acquireBackupPause"]
      >[0],
    ) => {
      events.push("pause-writers");
      expect(inputHeld).toBe(true);
      await expect(gate.run(async () => {})).rejects.toThrow(/backup/);
      const hold = await options.holdInput();
      await hold.release();
      expect(inputHeld).toBe(true);
      writersHeld = true;
      return pause;
    },
  };
  const controllers = new Map<string, AbortController>();
  const core: CoreMaintenanceClient = async <T>(
    method: string,
    payload?: unknown,
  ): Promise<T> => {
    if (method === "diagnostics") return store.diagnostics() as T;
    const request = payload as { backupId: string; destination: string };
    if (method === "cancel-backup") {
      controllers.get(request.backupId)?.abort();
      return undefined as T;
    }
    if (method !== "backup-database") throw new Error("Unexpected method");
    events.push("database");
    expect(inputHeld).toBe(true);
    if (withWorkbench) expect(writersHeld).toBe(true);
    await expect(gate.run(async () => {})).rejects.toThrow(/backup/);
    const controller = new AbortController();
    controllers.set(request.backupId, controller);
    try {
      return (await store.backupDatabase(request.destination, {
        signal: controller.signal,
      })) as T;
    } finally {
      controllers.delete(request.backupId);
      events.push("database-finished");
    }
  };
  const options: ExportEveProfileOptions = {
    profileRoot: profile,
    destination: path.join(root, "backup"),
    appVersion: "0.1.0",
    core,
    mutationGate: {
      acquire: async (signal) => {
        events.push("hold-gate");
        const hold = await gate.acquire(signal);
        return {
          assertHeld: hold.assertHeld,
          release: async () => {
            events.push("release-gate");
            await hold.release();
          },
        };
      },
    },
    holdInput: async () => {
      events.push("hold-input");
      inputHeld = true;
      return {
        assertHeld: async () => {
          if (!inputHeld) throw new Error("input shield lost");
        },
        release: async () => {
          events.push("release-input");
          inputHeld = false;
        },
      };
    },
    flushRendererAndPlaces: async () => {
      events.push("flush");
      expect(inputHeld).toBe(true);
      await gate.run(async () => {
        const task = store
          .snapshot()
          .tasks.find((item) => item.id === "orbit")!;
        expect(
          store.dispatch(
            {
              type: "UpdateNote",
              requestId: "flush-before-backup",
              taskId: task.id,
              expectedEpoch: task.epoch,
              expectedRevision: task.note.revision,
              body: "Flushed before the backup barrier",
            },
            {
              actorId: "test",
              origin: "trusted-ui",
              capabilities: [...ALL_CAPABILITIES],
            },
          ).ok,
        ).toBe(true);
      });
    },
    getWorkbench: () => (withWorkbench ? workbench : undefined),
  };
  return {
    root,
    profile,
    options,
    store,
    core,
    events,
    gate,
    workbench,
    pause,
    ended,
    loseInput: () => {
      inputHeld = false;
    },
  };
}

describe("host profile backup composition", () => {
  it("removes the input hold before retiring a successful lease, without announcing a false cancellation", async () => {
    const value = await fixture();
    const acquire = value.options.holdInput;
    const events: string[] = [];
    value.options.holdInput = async (signal) => {
      const hold = await acquire(signal);
      const cancelled = () => events.push("cancelled");
      signal?.addEventListener("abort", cancelled);
      return {
        assertHeld: hold.assertHeld,
        release: async () => {
          events.push("released");
          expect(signal?.aborted).toBe(false);
          signal?.removeEventListener("abort", cancelled);
          await hold.release();
        },
      };
    };
    await exportEveProfile(value.options);
    expect(events).toEqual(["released"]);
  });
  it("exports the real sole-writer database and exact managed roots after input, flush, gate and writer acknowledgments", async () => {
    const value = await fixture();
    const manifest = await exportEveProfile(value.options);
    expect(value.events.slice(0, 5)).toEqual([
      "hold-input",
      "flush",
      "hold-gate",
      "pause-writers",
      "database",
    ]);
    expect(value.events.slice(-4)).toEqual([
      "database-finished",
      "resume-writers",
      "release-gate",
      "release-input",
    ]);
    expect(manifest.versions.schema).toBe(
      value.store.diagnostics().schemaVersion,
    );
    expect(manifest.entries.map((item) => item.path).sort()).toEqual([
      "storage/assets",
      "storage/projects",
      "workbench/recovery",
      "workspaces",
    ]);
    expect(manifest.files.map((file) => file.path)).toContain(
      "workbench/recovery/unknown.journal",
    );
    expect(
      manifest.files.some((file) =>
        /providers|owner|unregistered|\.env/.test(file.path),
      ),
    ).toBe(false);
    expect(await verifyBackup(value.options.destination)).toEqual(manifest);
    expect((await lstat(value.options.destination)).mode & 0o777).toBe(0o700);
    // Open a disposable copy, never the immutable archive (SQLite may create sidecars).
    const inspected = path.join(value.root, "inspection.db");
    await copyFile(
      path.join(value.options.destination, "profile/eve.db"),
      inspected,
    );
    const cold = new CoreStore({ dbPath: inspected });
    stores.push(cold);
    expect(
      cold.snapshot().tasks.find((item) => item.id === "orbit")!.note.body,
    ).toBe("Flushed before the backup barrier");
    await expect(value.gate.run(async () => "resumed")).resolves.toBe(
      "resumed",
    );
  });
  it("waits for an already admitted project write before copying its settled result", async () => {
    const value = await fixture(false);
    let finish!: () => void;
    const admitted = value.gate.run(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await put(
        value.profile,
        "workspaces/orbit/index.html",
        "Settled admitted edit",
      );
    });
    const pending = exportEveProfile(value.options);
    const deadline = Date.now() + 2000;
    while (!value.events.includes("hold-gate") && Date.now() < deadline)
      await new Promise((resolve) => setImmediate(resolve));
    expect(value.events).toContain("hold-gate");
    expect(value.events).not.toContain("database");
    finish();
    await admitted;
    await pending;
    expect(
      await readFile(
        path.join(
          value.options.destination,
          "profile/workspaces/orbit/index.html",
        ),
        "utf8",
      ),
    ).toBe("Settled admitted edit");
  });
  it("allows a profile without a running workbench and does not start one to export", async () => {
    const value = await fixture(false);
    await rm(path.join(value.profile, "workbench"), { recursive: true });
    const manifest = await exportEveProfile(value.options);
    expect(value.events).not.toContain("pause-writers");
    expect(
      manifest.entries.some((item) => item.path.startsWith("workbench")),
    ).toBe(false);
    expect(
      await readFile(
        path.join(
          value.options.destination,
          "profile/workspaces/orbit/index.html",
        ),
        "utf8",
      ),
    ).toBe("User project");
  });
  it("rejects unsupported live-workbench pause and releases the host gate and input shield", async () => {
    const value = await fixture();
    value.workbench.acquireBackupPause = async () => {
      throw new Error("WORKBENCH_PAUSE_UNSUPPORTED");
    };
    await expect(exportEveProfile(value.options)).rejects.toThrow(
      /UNSUPPORTED/,
    );
    expect(value.events.slice(-2)).toEqual(["release-gate", "release-input"]);
    expect(value.events).not.toContain("database");
    await expect(lstat(value.options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(value.gate.run(async () => true)).resolves.toBe(true);
  });
  it("refuses a newly added storage root during flush instead of silently omitting it", async () => {
    const value = await fixture(false);
    await rm(path.join(value.profile, "storage/projects"), { recursive: true });
    const flush = value.options.flushRendererAndPlaces;
    value.options.flushRendererAndPlaces = async (signal) => {
      await flush(signal);
      await put(value.profile, "storage/projects/late/new.txt", "New import");
    };
    await expect(exportEveProfile(value.options)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    expect(value.events.slice(-2)).toEqual(["release-gate", "release-input"]);
    expect(value.events).not.toContain("database");
  });
  it("refuses a symlinked ancestor even when its target has no selected child", async () => {
    const value = await fixture(false);
    await rm(path.join(value.profile, "storage"), { recursive: true });
    await symlink(
      path.join(value.root, "missing-external-directory"),
      path.join(value.profile, "storage"),
    );
    await expect(exportEveProfile(value.options)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    expect(value.events).toEqual([]);
  });
  it("cancels an in-flight owning-worker backup on lease loss and waits for its terminal reply before releasing host holds", async () => {
    const value = await fixture();
    let finish!: () => void;
    let cancelled = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    value.options.core = async <T>(
      method: string,
      payload?: unknown,
    ): Promise<T> => {
      if (method === "diagnostics") return value.core<T>(method, payload);
      if (method === "cancel-backup") {
        cancelled = true;
        return undefined as T;
      }
      if (method !== "backup-database") throw new Error("Unexpected method");
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      value.events.push("worker-terminal");
      throw new Error("Snapshot cancelled and cleaned");
    };
    const pending = exportEveProfile(value.options);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "QUIESCENCE_LOST",
    });
    await ready;
    value.ended.abort(new Error("watchdog expired"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
    expect(value.events).not.toContain("release-gate");
    finish();
    await rejected;
    expect(value.events.slice(-4)).toEqual([
      "worker-terminal",
      "resume-writers",
      "release-gate",
      "release-input",
    ]);
    await expect(lstat(value.options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("still releases gate and input when owned-writer resume fails, preserving the published backup for review", async () => {
    const value = await fixture();
    value.pause.release = async () => {
      value.events.push("resume-failed");
      throw new Error("watchdog unavailable");
    };
    await expect(exportEveProfile(value.options)).rejects.toMatchObject({
      code: "IO_ERROR",
      retainedPath: value.options.destination,
    });
    expect(value.events.slice(-3)).toEqual([
      "resume-failed",
      "release-gate",
      "release-input",
    ]);
    await expect(
      verifyBackup(value.options.destination),
    ).resolves.toMatchObject({ format: "eve-profile-backup" });
    await expect(value.gate.run(async () => true)).resolves.toBe(true);
  });
  it("rejects a lost input hold or newly started workbench before publication", async () => {
    for (const change of ["input", "workbench"] as const) {
      const value = await fixture(false);
      value.options.core = async <T>(
        method: string,
        payload?: unknown,
      ): Promise<T> => {
        const result = await value.core<T>(method, payload);
        if (method === "backup-database") {
          if (change === "input") value.loseInput();
          else value.options.getWorkbench = () => value.workbench;
        }
        return result;
      };
      await expect(exportEveProfile(value.options)).rejects.toMatchObject({
        code: "QUIESCENCE_LOST",
      });
      await expect(lstat(value.options.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await readdir(value.root)).some((name) =>
          name.startsWith(".eve-backup-"),
        ),
      ).toBe(false);
    }
  });
  it("refuses invalid core diagnostics and a mismatched completed snapshot schema", async () => {
    const invalid = await fixture(false);
    invalid.options.core = async <T>() => ({ schemaVersion: null }) as T;
    await expect(exportEveProfile(invalid.options)).rejects.toMatchObject({
      code: "VERSION_REFUSED",
    });
    expect(invalid.events).toEqual([]);
    const changed = await fixture(false);
    changed.options.core = async <T>(
      method: string,
      payload?: unknown,
    ): Promise<T> => {
      const result = await changed.core<Record<string, unknown>>(
        method,
        payload,
      );
      return (
        method === "backup-database"
          ? { ...result, schemaVersion: 999 }
          : result
      ) as T;
    };
    await expect(exportEveProfile(changed.options)).rejects.toMatchObject({
      code: "VERSION_REFUSED",
    });
    expect(changed.events.slice(-2)).toEqual(["release-gate", "release-input"]);
    await expect(lstat(changed.options.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function aggregateFixture() {
  const value = await fixture(false);
  const controllers = new Map<string, AbortController>();
  const hooks: { create?: (id: string) => Promise<void>; pause?: (id: string) => Promise<void>; release?: (id: string) => Promise<void>; close?: (id: string) => Promise<void> } = {};
  const held = new Set<string>();
  const registry = new WorkbenchRegistry<ProfileWorkbench>({
    maxEntries: 4,
    create: async ({ identity }) => {
      await hooks.create?.(identity.projectId);
      value.events.push(`started-${identity.projectId}`);
      return {
        value: { acquireBackupPause: async options => {
          const id = identity.projectId;
          value.events.push(`pause-${id}`); options.signal?.throwIfAborted();
          const input = await options.holdInput(); await input.release();
          await expect(value.gate.run(async () => {})).rejects.toThrow(/backup/);
          await hooks.pause?.(id);
          const controller = new AbortController(); controllers.set(id, controller); held.add(id);
          return { id, signal: controller.signal, documents: [], qualification: { ownedWriters: 'paused', externalWriters: 'not-controlled', platform: 'linux', hardwareQualified: false },
            assertHeld: async () => { controller.signal.throwIfAborted(); if (!held.has(id)) throw new Error('writer was resumed'); }, renew: async () => {},
            release: async () => { await hooks.release?.(id); value.events.push(`resume-${id}`); held.delete(id); controller.abort(); },
          };
        } },
        dispose: async () => { value.events.push(`dispose-${identity.projectId}`); },
      };
    },
    prepareClose: async entry => { await hooks.close?.(entry.identity.projectId); return { assertHeld: async () => {}, release: async () => { value.events.push(`close-permit-${entry.identity.projectId}`); } }; },
  });
  const { getWorkbench: _legacy, ...base } = value.options;
  const options: ExportEveProfileOptions = { ...base, acquireWorkbenchScope: ({ signal, pause }) => {
    value.events.push('freeze-registry');
    return registry.freeze({ signal, pause: (entry, entrySignal) => pause(entry.value, entrySignal) });
  } };
  const identity = (id: string): WorkbenchIdentity => ({ projectId: id, canonicalRoot: path.join(value.profile, 'workspaces', id), rootIdentity: { device: '1', inode: String(id.charCodeAt(0)) } });
  return { ...value, options, registry, identity, hooks, controllers, held };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!test() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  expect(test()).toBe(true);
}

describe('aggregate retained workbench backup', () => {
  it('requires exactly one explicit writer authority', async () => {
    const value = await fixture(false);
    await expect(exportEveProfile({ ...value.options, acquireWorkbenchScope: async () => ({ assertHeld: async () => {}, release: async () => {} }) } as unknown as ExportEveProfileOptions)).rejects.toThrow('exactly one');
    const { getWorkbench: _omitted, ...none } = value.options;
    await expect(exportEveProfile(none as ExportEveProfileOptions)).rejects.toThrow('exactly one');
    expect(value.events).toEqual([]);
  });
  it('waits for an admitted second startup, pauses both, and resumes in reverse before releasing the host', async () => {
    const value = await aggregateFixture(); await value.registry.ensure(value.identity('alpha'));
    const startup = deferred(); value.hooks.create = async id => { if (id === 'beta') await startup.promise; };
    const starting = value.registry.ensure(value.identity('beta'));
    await put(value.profile, 'workbench/recovery/alpha/workbench.lock', 'runtime-lock');
    await put(value.profile, 'workbench/recovery/alpha/opaque.journal', 'alpha bytes');
    await put(value.profile, 'workbench/recovery/beta/opaque.journal', 'beta bytes');
    const pending = exportEveProfile(value.options);
    await until(() => value.events.includes('freeze-registry'));
    expect(value.events).not.toContain('database'); expect(value.events).not.toContain('release-input');
    await expect(value.registry.ensure(value.identity('gamma'))).rejects.toMatchObject({ code: 'MAINTENANCE' });
    startup.resolve(); await starting;
    const manifest = await pending;
    expect(value.events.indexOf('started-beta')).toBeLessThan(value.events.indexOf('pause-alpha'));
    expect(value.events.slice(-5)).toEqual(['database-finished', 'resume-beta', 'resume-alpha', 'release-gate', 'release-input']);
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(['workbench/recovery/alpha/opaque.journal', 'workbench/recovery/beta/opaque.journal']));
    expect(manifest.files.some(file => file.path.endsWith('workbench.lock'))).toBe(false);
    expect(value.held.size).toBe(0); expect(value.registry.size).toBe(2);
  });
  it('waits for a close already holding authority instead of pausing or omitting it early', async () => {
    const value = await aggregateFixture(); await Promise.all(['alpha', 'beta'].map(id => value.registry.ensure(value.identity(id))));
    const prompt = deferred(); value.hooks.close = async id => { if (id === 'beta') await prompt.promise; };
    const closing = value.registry.close('beta', { reason: 'User close before backup' });
    const pending = exportEveProfile(value.options); await until(() => value.events.includes('freeze-registry'));
    expect(value.events).not.toContain('pause-alpha'); expect(value.events).not.toContain('release-input');
    prompt.resolve(); await closing; await pending;
    expect(value.events.indexOf('close-permit-beta')).toBeLessThan(value.events.indexOf('pause-alpha'));
    expect(value.events).not.toContain('pause-beta'); expect(value.registry.size).toBe(1);
  });
  it('does not drop the gate or input until rollback of an earlier pause finishes after a second-entry failure', async () => {
    const value = await aggregateFixture(); await Promise.all(['alpha', 'beta'].map(id => value.registry.ensure(value.identity(id))));
    const release = deferred(); value.hooks.pause = async id => { if (id === 'beta') throw new Error('second writer cannot pause'); };
    value.hooks.release = async id => { if (id === 'alpha') { value.events.push('rollback-wait'); await release.promise; } };
    const pending = exportEveProfile(value.options), rejected = expect(pending).rejects.toThrow('second writer cannot pause');
    await until(() => value.events.includes('rollback-wait'));
    expect(value.events).not.toContain('release-gate'); expect(value.events).not.toContain('release-input'); expect(value.events).not.toContain('database');
    release.resolve(); await rejected;
    expect(value.events.slice(-3)).toEqual(['resume-alpha', 'release-gate', 'release-input']);
    await expect(lstat(value.options.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('awaits an unfinished factory after cancellation before releasing the profile barrier', async () => {
    const value = await aggregateFixture(); await value.registry.ensure(value.identity('alpha'));
    const startup = deferred(); value.hooks.create = async id => { if (id === 'beta') await startup.promise; };
    const starting = value.registry.ensure(value.identity('beta'));
    const cancel = new AbortController(); value.options.signal = cancel.signal;
    const pending = exportEveProfile(value.options), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => value.events.includes('freeze-registry')); cancel.abort(); await new Promise(resolve => setImmediate(resolve));
    expect(value.events).not.toContain('release-input'); expect(value.events).not.toContain('pause-alpha');
    startup.resolve(); await starting; await rejected;
    expect(value.events.slice(-2)).toEqual(['release-gate', 'release-input']); expect(value.registry.size).toBe(2);
    await expect(lstat(value.options.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('holds both editors and the host through a cancelled database terminal reply, then attempts every reverse release', async () => {
    const value = await aggregateFixture(); await Promise.all(['alpha', 'beta'].map(id => value.registry.ensure(value.identity(id))));
    const ready = deferred(), terminal = deferred(); let cancelled = false;
    value.options.core = async <T>(method: string, payload?: unknown): Promise<T> => {
      if (method === 'diagnostics') return value.core<T>(method, payload);
      if (method === 'cancel-backup') { cancelled = true; return undefined as T; }
      expect([...value.held].sort()).toEqual(['alpha', 'beta']); ready.resolve(); await terminal.promise;
      value.events.push('worker-terminal'); throw new Error('Cancelled snapshot finished');
    };
    value.hooks.release = async id => { if (id === 'beta') { value.events.push('resume-beta-failed'); throw new Error('resume uncertain'); } };
    const pending = exportEveProfile(value.options), rejected = expect(pending).rejects.toMatchObject({ code: 'IO_ERROR' });
    await ready.promise; value.controllers.get('alpha')!.abort(new Error('pause expired')); await until(() => cancelled);
    expect(value.events).not.toContain('release-gate'); expect(value.events).not.toContain('resume-alpha');
    terminal.resolve(); await rejected;
    expect(value.events.slice(-5)).toEqual(['worker-terminal', 'resume-beta-failed', 'resume-alpha', 'release-gate', 'release-input']);
    await expect(lstat(value.options.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
