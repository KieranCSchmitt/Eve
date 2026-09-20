import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  BackupError,
  exportProfileBackup,
  type BackupEntry,
  type BackupManifest,
  type Quiescence,
} from "../../../packages/backup/src/index";
import { inspectPath } from "../../../packages/imports/src/filesystem";
import { backupCoreDatabase, type CoreMaintenanceClient } from "./core-client";
import type { MutationGate } from "./mutation-gate";
import type { WorkbenchService } from "./workbench";
import type { WorkbenchPauseLease } from "./workbench-pause";
import type { RegistryWriterLease } from "./workbench-registry";

export interface ProfileInputHold {
  readonly signal?: AbortSignal;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
export type ProfileWorkbench = Pick<WorkbenchService, "acquireBackupPause">;
export interface ProfileWorkbenchScopeContext {
  readonly signal: AbortSignal;
  /** Pass the registry's per-entry signal so loss of an earlier lease cancels later acquisition. */
  pause(workbench: ProfileWorkbench, signal?: AbortSignal): Promise<WorkbenchPauseLease>;
}
interface ExportEveProfileBase {
  profileRoot: string;
  destination: string;
  appVersion: string;
  /** The existing sole-writer worker client; never a second connection to the live database. */
  core: CoreMaintenanceClient;
  mutationGate: Pick<MutationGate, "acquire">;
  holdInput(signal?: AbortSignal): Promise<ProfileInputHold>;
  /** Flush renderer state, persisted places, admitted jobs, and pending workbench startup. */
  flushRendererAndPlaces(signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}
/** Exactly one authority owns the included workbench writer set. */
export type ExportEveProfileOptions = ExportEveProfileBase & (
  | { getWorkbench(): ProfileWorkbench | undefined; acquireWorkbenchScope?: never }
  | { getWorkbench?: never; acquireWorkbenchScope(context: ProfileWorkbenchScopeContext): Promise<RegistryWriterLease> }
);

/** External editors and systemd-launched writers remain outside the owned writer barrier.
 * Before/after file verification detects ordinary changes, not every transient write.
 * A live workbench currently requires Linux pidfds; target hardware remains unqualified. */
export const PROFILE_BACKUP_QUALIFICATION = Object.freeze({
  externalWriters: "not-controlled",
  hardwareQualified: false,
});

const ALLOWED: readonly BackupEntry[] = [
  { path: "storage/assets", kind: "managed-originals" },
  { path: "storage/projects", kind: "project" },
  { path: "workspaces", kind: "project" },
  { path: "workbench/recovery", kind: "recovery" },
];
async function inventory(profileRoot: string) {
  const profile = await inspectPath(profileRoot);
  if (!profile.stat.isDirectory())
    throw new BackupError(
      "UNSAFE_PATH",
      "The Eve profile must be a directory.",
    );
  const selected: {
    entry: BackupEntry;
    chain: { path: string; dev: number; ino: number }[];
  }[] = [];
  for (const entry of ALLOWED) {
    let current = profile.path;
    let exists = true;
    for (const component of entry.path.split("/")) {
      current = path.join(current, component);
      const stat = await lstat(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      if (!stat) {
        exists = false;
        break;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new BackupError(
          "UNSAFE_PATH",
          "An allowlisted profile storage path is not an ordinary directory.",
        );
    }
    if (exists)
      selected.push({
        entry: { ...entry },
        chain: (await inspectPath(current)).chain,
      });
  }
  return { profileChain: profile.chain, selected };
}
async function schemaVersion(core: CoreMaintenanceClient): Promise<number> {
  const diagnostics = await core<unknown>("diagnostics");
  const version =
    diagnostics &&
    typeof diagnostics === "object" &&
    "schemaVersion" in diagnostics
      ? diagnostics.schemaVersion
      : undefined;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  )
    throw new BackupError(
      "VERSION_REFUSED",
      "The running core did not report a valid database schema version.",
    );
  return version;
}

/** Compose the actual host barriers with the private, atomic backup assembler.
 * Missing storage roots are omitted only if they stay absent through publication.
 * Credentials, workbench runtime state, and unrelated profile data are never selected. */
export async function exportEveProfile(
  options: ExportEveProfileOptions,
): Promise<Readonly<BackupManifest>> {
  options.signal?.throwIfAborted();
  if ((typeof options.getWorkbench === "function") === (typeof options.acquireWorkbenchScope === "function"))
    throw new Error("Provide exactly one workbench writer authority: getWorkbench or acquireWorkbenchScope.");
  const initial = await inventory(options.profileRoot);
  const version = await schemaVersion(options.core);
  const sameInventory = async () => {
    if (
      JSON.stringify(await inventory(options.profileRoot)) !==
      JSON.stringify(initial)
    )
      throw new BackupError(
        "SOURCE_CHANGED",
        "Profile storage changed while backup was starting. Retry after the current operation finishes.",
      );
  };
  return exportProfileBackup({
    profileRoot: options.profileRoot,
    destination: options.destination,
    versions: { app: options.appVersion, schema: version },
    entries: initial.selected.map((item) => item.entry),
    signal: options.signal,
    quiesce: async (signal) => {
      let input: ProfileInputHold | undefined;
      let gate: Awaited<ReturnType<MutationGate["acquire"]>> | undefined;
      let workbench: ProfileWorkbench | undefined;
      let writers: RegistryWriterLease | undefined;
      const acquireScope = options.acquireWorkbenchScope;
      const getWorkbench = options.getWorkbench;
      let released: Promise<void> | undefined;
      const ended = new AbortController();
      let combined = signal
        ? AbortSignal.any([signal, ended.signal])
        : ended.signal;
      const release = () =>
        (released ??= (async () => {
          const failures: unknown[] = [];
          // Resume owned writers before admitting host mutations, then return input last.
          for (const hold of [writers, gate, input]) {
            try {
              await hold?.release();
            } catch (error) {
              failures.push(error);
            }
          }
          // Remove the input hold before retiring a successfully completed lease;
          // normal release must not present itself as a user cancellation.
          ended.abort(new Error("The profile backup barrier ended."));
          if (failures.length)
            throw new AggregateError(
              failures,
              "One or more profile backup holds could not be released.",
            );
        })());
      const assertHeld = async () => {
        if (released)
          throw new Error("The profile backup barrier is releasing.");
        combined.throwIfAborted();
        await input!.assertHeld();
        await gate!.assertHeld();
        if (options.acquireWorkbenchScope !== acquireScope || options.getWorkbench !== getWorkbench || (!acquireScope && getWorkbench?.() !== workbench))
          throw new Error(
            "The workbench changed after the profile barrier was acquired.",
          );
        await writers?.assertHeld();
        await sameInventory();
        combined.throwIfAborted();
      };
      try {
        input = await options.holdInput(combined);
        if (
          !input ||
          typeof input.assertHeld !== "function" ||
          typeof input.release !== "function"
        )
          throw new Error("The host must provide an acknowledged input hold.");
        if (input.signal) combined = AbortSignal.any([combined, input.signal]);
        combined.throwIfAborted();
        await input.assertHeld();
        await options.flushRendererAndPlaces(combined);
        combined.throwIfAborted();
        await input.assertHeld();
        gate = await options.mutationGate.acquire(combined);
        combined.throwIfAborted();
        await input.assertHeld();
        const pause = async (selected: ProfileWorkbench, scopeSignal?: AbortSignal) => {
          const pauseSignal = scopeSignal ? AbortSignal.any([combined, scopeSignal]) : combined;
          pauseSignal.throwIfAborted();
          await input!.assertHeld(); await gate!.assertHeld();
          return selected.acquireBackupPause({
            signal: pauseSignal,
            holdInput: async () => {
              await input!.assertHeld();
              await gate!.assertHeld();
              pauseSignal.throwIfAborted();
              // The outer composition owns the real input shield until every hold is released.
              return { release: async () => {} };
            },
          });
        };
        if (acquireScope) {
          // The registry closes admission and awaits all admitted starts/closes;
          // on failure it must finish releasing every acquired writer before rejecting.
          writers = await acquireScope({ signal: combined, pause });
          if (!writers || typeof writers.assertHeld !== "function" || typeof writers.release !== "function")
            throw new Error("The registry writer scope must supply a live lease and release callback.");
        } else {
          workbench = getWorkbench!();
          if (workbench) writers = await pause(workbench);
        }
        if (writers?.signal) combined = AbortSignal.any([combined, writers.signal]);
        await assertHeld();
        if ((await schemaVersion(options.core)) !== version)
          throw new BackupError(
            "VERSION_REFUSED",
            "The core database schema changed before backup.",
          );
        return { signal: combined, assertHeld, release } satisfies Quiescence;
      } catch (error) {
        try {
          await release();
        } catch (resumeError) {
          throw new AggregateError(
            [error, resumeError],
            "Backup acquisition failed and a host hold also failed to release.",
          );
        }
        throw error;
      }
    },
    backupDatabase: async (destination, signal) => {
      const receipt = await backupCoreDatabase(
        options.core,
        destination,
        signal,
      );
      if (receipt.schemaVersion !== version)
        throw new BackupError(
          "VERSION_REFUSED",
          "The core backup schema does not match its acknowledged diagnostics.",
        );
    },
  });
}
