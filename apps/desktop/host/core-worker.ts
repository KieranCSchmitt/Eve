import { CoreStore, CoreMaintenanceError } from "@eve/core";
import {
  ALL_CAPABILITIES,
  type ProjectEditPreparation,
  type ProjectEditReceipt,
  type ProjectEditObservation,
  type OrbitParameters,
  type WorkspaceEditDispatch,
  type WorkspaceEditReceipt,
  type WorkspaceEditObservation,
} from "@eve/contracts";

const parent = (
  process as unknown as {
    parentPort: {
      on: (
        event: string,
        callback: (event: {
          data: { id: string; method: string; payload?: unknown };
        }) => void,
      ) => void;
      postMessage: (message: unknown) => void;
    };
  }
).parentPort;
const store = new CoreStore({
  dbPath: process.argv[2]!,
  orbitProjectPath: process.argv[3]!,
  // Each GUI launch begins at Home. Per-space checkpoints remain durable and
  // are opened only after an explicit choice; provider setup never starts core.
  startAtHome: true,
});
const auth = {
  actorId: "desktop",
  origin: "trusted-ui" as const,
  capabilities: [...ALL_CAPABILITIES],
};
// Normal requests are serialized through the sole writer. Cancellation alone is
// out-of-band so it can reach SQLite's asynchronous backup progress callback.
let queue: Promise<void> = Promise.resolve();
const backups = new Map<string, AbortController>();
parent.on("message", ({ data }) => {
  if (data.method === "cancel-backup") {
    const backupId = (data.payload as { backupId?: unknown } | undefined)
      ?.backupId;
    const controller =
      typeof backupId === "string" ? backups.get(backupId) : undefined;
    controller?.abort();
    parent.postMessage({ id: data.id, value: { acknowledged: !!controller } });
    return;
  }
  let backup:
    | { backupId: string; destination: string; controller: AbortController }
    | undefined;
  if (data.method === "backup-database") {
    const payload = data.payload as
      { backupId?: unknown; destination?: unknown } | undefined;
    if (
      typeof payload?.backupId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.backupId) ||
      typeof payload.destination !== "string" ||
      backups.has(payload.backupId)
    ) {
      parent.postMessage({
        id: data.id,
        error: "Invalid or duplicate database backup request.",
      });
      return;
    }
    const controller = new AbortController();
    backups.set(payload.backupId, controller);
    backup = {
      backupId: payload.backupId,
      destination: payload.destination,
      controller,
    };
  }
  queue = queue.then(async () => {
    try {
      let value: unknown;
      switch (data.method) {
        case "diagnostics":
          value = store.diagnostics();
          break;
        case "backup-database":
          value = await store.backupDatabase(backup!.destination, {
            signal: backup!.controller.signal,
          });
          break;
        case "snapshot":
          value = store.snapshot();
          break;
        case "search":
          value = store.search(String(data.payload ?? ""));
          break;
        case "dispatch":
          value = store.dispatch(data.payload, {
            actorId: "desktop",
            origin: "trusted-ui",
            capabilities: [...ALL_CAPABILITIES],
          });
          break;
        case "preflight":
          value = store.preflight(data.payload, auth);
          break;
        case "prepare-project-edit": {
          const p = data.payload as {
            command: unknown;
            preparation: ProjectEditPreparation;
          };
          value = store.prepareProjectEdit(p.command, auth, p.preparation);
          break;
        }
        case "record-project-receipt": {
          const p = data.payload as {
            editId: string;
            receipt: ProjectEditReceipt;
          };
          value = store.recordProjectEditReceipt(p.editId, p.receipt, auth);
          break;
        }
        case "finalize-project-edit":
          value = store.finalizeProjectEdit(String(data.payload), auth);
          break;
        case "pending-project-edits":
          value = store.listPendingProjectEdits();
          break;
        case "reconcile-project-edit": {
          const p = data.payload as {
            editId: string;
            observation: ProjectEditObservation;
          };
          value = store.reconcileProjectEdit(p.editId, p.observation, auth);
          break;
        }
        case "abort-project-edit": {
          const p = data.payload as {
            editId: string;
            observation: ProjectEditObservation;
          };
          value = store.abortProjectEdit(p.editId, p.observation, auth);
          break;
        }
        case "observe-project": {
          const p = data.payload as { taskId: string; values: OrbitParameters };
          value = store.observeProjectParameters(p.taskId, p.values, auth);
          break;
        }
        case "lookup-workspace-edit":
          value = store.lookupWorkspaceEdit(data.payload, auth);
          break;
        case "read-workspace-edit":
          value = store.readWorkspaceEdit(String(data.payload), auth);
          break;
        case "read-workspace-edit-request":
          value = store.readWorkspaceEditRequest(String(data.payload), auth);
          break;
        case "cancel-prepared-workspace-edit": {
          const p = data.payload as {
            editId: string;
            dispatch: WorkspaceEditDispatch;
          };
          value = store.cancelPreparedWorkspaceEdit(p.editId, p.dispatch, auth);
          break;
        }
        case "prepare-workspace-edit":
          value = store.prepareWorkspaceEdit(data.payload, auth);
          break;
        case "dispatch-workspace-edit": {
          const p = data.payload as {
            editId: string;
            dispatch: WorkspaceEditDispatch;
          };
          value = store.markWorkspaceEditDispatched(p.editId, p.dispatch, auth);
          break;
        }
        case "record-workspace-receipt": {
          const p = data.payload as {
            editId: string;
            receipt: WorkspaceEditReceipt;
          };
          value = store.recordWorkspaceEditReceipt(p.editId, p.receipt, auth);
          break;
        }
        case "finalize-workspace-edit":
          value = store.finalizeWorkspaceEdit(String(data.payload), auth);
          break;
        case "pending-workspace-edits":
          value = store.listPendingWorkspaceEdits(auth);
          break;
        case "reconcile-workspace-edit": {
          const p = data.payload as {
            editId: string;
            observation: WorkspaceEditObservation;
          };
          value = store.reconcileWorkspaceEdit(p.editId, p.observation, auth);
          break;
        }
        case "abort-workspace-edit": {
          const p = data.payload as {
            editId: string;
            observation: WorkspaceEditObservation;
          };
          value = store.abortWorkspaceEdit(p.editId, p.observation, auth);
          break;
        }
        case "register-asset":
          value = store.registerAsset(data.payload, auth);
          break;
        case "register-project":
          value = store.registerProject(data.payload, auth);
          break;
        case "lookup-project-registration":
          value = store.lookupProjectRegistration(data.payload, auth);
          break;
        case "verify-project":
          value = store.verifyProject(data.payload, auth);
          break;
        case "list-assets":
          value = store.listAssets(String(data.payload));
          break;
        case "register-source":
          value = store.registerSource(data.payload, auth);
          break;
        case "list-sources":
          value = store.listSources(String(data.payload));
          break;
        case "close":
          store.close();
          parent.postMessage({ id: data.id, value: true });
          process.exit(0);
          break;
        default:
          throw new Error("Unsupported core method");
      }
      parent.postMessage({ id: data.id, value });
    } catch (error) {
      parent.postMessage({
        id: data.id,
        error: error instanceof Error ? error.message : "Core request failed",
        ...(error instanceof CoreMaintenanceError ? { code: error.code } : {}),
      });
    } finally {
      if (backup) backups.delete(backup.backupId);
    }
  });
});
parent.postMessage({ ready: true });
