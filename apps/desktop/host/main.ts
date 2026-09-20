import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
  utilityProcess,
  webContents,
  WebContentsView,
} from "electron";
import { mkdir, readFile, cp, access, chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  coreCommandSchema,
  orbitParametersSchema,
  type CoreSnapshot,
  type DispatchResult,
  type PreflightResult,
  type CoreCommand,
  type CoreCommandInput,
  type Activity,
  type SourceRecord,
  type ProjectRecord,
  type ProjectRegistrationResult,
  type TaskRecord,
} from "@eve/contracts";
import type { HostStatus, SurfaceRequest } from "../shared/bridge";
import {
  readOrbitConfig,
  parseOrbitConfig,
} from "../../../adapters/orbit/src/index";
import { readChecked } from "../../../packages/imports/src/filesystem";

import { ProjectEdits } from "./project-edits";
import { WorkbenchService } from "./workbench";
import {
  WorkbenchRegistry,
  type WorkbenchEntry,
  type WorkbenchClosePermit,
} from "./workbench-registry";
import { HostProjects } from "./projects";
import { initializeOwnedResource } from "./owned-resource";
import { CloseOwnership } from "./close-ownership";
import { MutationExecutionContext } from "./mutation-context";
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeEditor,
} from "./workspace-runtime";
import { WorkspaceEdits } from "./workspace-edits";
import { WORKSPACE_PLAN_LIMITS, type WorkspaceOwner } from "./workspace-plan";
import {
  EditorFocusLeases,
  type EditorFocusClaim,
  type EditorFocusGesture,
} from "./editor-focus";
import { SurfaceFocusOwnership, type SurfaceFocusOwner } from "./surface-focus";
import { startProjectPreview, type ProjectPreview } from "./project-preview";
import type {
  DocumentState,
  WorkbenchContext,
} from "../../../extensions/eve-workbench/src/protocol";
import { OverlayHost } from "./overlay";
import { OverlayRequests } from "./overlay-requests";
import { TaskAssets } from "./assets";
import { CanvasImageAttachments } from "./canvas-image-attachments";
import { TaskMedia } from "./media";
import { isOfficialPlayerRequest } from "../../../packages/media/src/index";
import { CredentialError, configureProviderSchema } from "./credentials";
import {
  IntelligenceController,
  type IntelligenceSettings,
} from "./intelligence";
import {
  IntentService,
  type CapturedIntentContext,
  type RegisteredIntentAction,
  type RegisteredExecutionContext,
} from "./intents";
import { WorkbenchRecoveryCoordinator } from "./workbench-recovery";
import {
  LinuxSessionBridge,
  LinuxSystemAdapter,
  type ExitAction,
} from "../../../packages/platform/src/index";
import { systemActionSchema } from "../shared/system";
import { IntentContextError } from "./intent-context";
import { MutationGate } from "./mutation-gate";
import { exportEveProfile } from "./profile-backup";
import type { OverlayState } from "../shared/bridge";
import {
  inspectRestoredProjectTrust,
  approveRestoredProjects,
} from "./restored-project-trust";
import { restoreProfileBackup } from "../../../packages/backup/src/index";
import { relocateEveProfile } from "./profile-relocation";
import {
  inspectProjectDirectory,
  inspectProjectExecutionTrust,
  approveProjectExecution,
} from "./project-trust";

const root = app.getAppPath();
const configurationMode = process.argv.includes("--configure-provider");
const sessionMode = process.argv.includes("--session");
const profileArgument = process.argv.indexOf("--profile");
const profile =
  profileArgument >= 0
    ? process.argv[profileArgument + 1]
    : process.env.EVE_PROFILE_PATH;
if (profileArgument >= 0 && (!profile || profile.startsWith("--")))
  throw new Error("--profile requires a workspace directory.");
if (profile) app.setPath("userData", path.resolve(profile));
app.setName("Eve");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", "eve");
  app.setDesktopName("org.eve.Shell.desktop");
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "eve-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "eve",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  if (configurationMode)
    console.error(
      "Close Eve before configuring its providers, then run the setup command again.",
    );
  app.exit(configurationMode || sessionMode ? 1 : 0);
}
let win: BrowserWindow;
let worker: Electron.UtilityProcess;
let exiting = false;
let closeApproved = false;
let coreReady: Promise<void>;
let preview:
  | {
      url: string;
      updateDraft: (
        config: unknown,
        gestureId: string,
        sequence: number,
      ) => unknown;
      updateCommitted: (config: unknown) => unknown;
      clearDraft: () => unknown;
      close: () => Promise<void>;
    }
  | undefined;
let previewSequence = 0;
let surfaceGeneration = 0;
let workbench: WorkbenchService | undefined;
let workbenchStarting: Promise<WorkbenchService> | undefined;
let projectEdits: ProjectEdits;
type OrbitPreview = NonNullable<typeof preview>;
interface OwnedWorkbench {
  taskId: string;
  project: ProjectRecord;
  service: WorkbenchService;
  serviceInstanceId: string;
  serviceGeneration: number;
  workspaceEditor: WorkspaceRuntimeEditor;
  recovery?: WorkbenchRecoveryCoordinator;
  restored?: Promise<void>;
  recoveryHandled?: boolean;
  recoveryDeferred?: boolean;
  recoveryTitle?: string;
  initializationError?: Error;
}
const projectBrokers = new Map<string, ProjectEdits>();
const projectPreviews = new Map<string, OrbitPreview | ProjectPreview>();
const previewStarts = new Map<string, Promise<OrbitPreview | ProjectPreview>>();
const workbenchAdmissions = new Map<string, Promise<WorkbenchService>>();
const projectSyncTimers = new Map<string, NodeJS.Timeout>();
const incompleteRecovery = new Set<string>();
let projects: HostProjects;
let workbenches = createWorkbenchRegistry();
const closeOwnership = new CloseOwnership();
const editorFocus = new EditorFocusLeases();
const surfaceFocus = new SurfaceFocusOwnership();
const intentFocus = new Map<string, EditorFocusGesture>();
const mutationExecution = new MutationExecutionContext();
const workspaceRuntime = new WorkspaceRuntime(workspaceSession);
let workspaceEdits: WorkspaceEdits;
let exitInputHeld = false;
let preparedExitRelease: (() => Promise<void>) | undefined;
let reviewAfterClose: string | undefined;
let exitPreparation: AbortController | undefined;
let exitPreparing: Promise<boolean> | undefined;
let sessionExitGeneration = 0;
let overlays: OverlayHost;
let assets: TaskAssets;
let canvasImageAttachments: CanvasImageAttachments;
let media: TaskMedia;
let intelligence: IntelligenceController;
let intents: IntentService;
const selectedSources = new Map<string, string>();
let workbenchRecovery: WorkbenchRecoveryCoordinator | undefined;
let sessionBridge: LinuxSessionBridge | undefined;
let sessionReady = false;
let sessionExitInProgress = false;
let rendererState = { dirty: true, busy: true };
let recoveryIncomplete = false;
let hostMutations = 0;
let rendererSettlement:
  { resolve(ready: boolean): void; timer: NodeJS.Timeout } | undefined;
const system = new LinuxSystemAdapter({
  prepareExit: async () => ({
    ready: (await requestRendererSettlement()) && (await prepareWorkForExit()),
  }),
});
let visibleSurface:
  { kind: string; key: string; taskId: string; sourceId?: string } | undefined;
let activeOverlayId: string | undefined;
const overlayRequests = new OverlayRequests();
let closeInProgress = false;
let projectSyncTimer: NodeJS.Timeout | undefined;
const surfaces = new Map<string, WebContentsView>();
const surfaceLoads = new Map<string, Promise<void>>();
const requests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
const status: HostStatus = {
  platform: process.platform,
  mode: sessionMode ? "session" : "app",
  version: app.getVersion(),
  providers: {
    nemotron: "unconfigured",
    openai: "unconfigured",
    voice: "disabled",
  },
  workbench: "unconfigured",
  preview: "idle",
};
const startupAlerts: string[] = [];
let projectRoot = "";
let mutationQueue = Promise.resolve<unknown>(undefined);
const mutationGate = new MutationGate();
let profileBackup: Promise<void> | undefined;
let backupCancellation: AbortController | undefined;
let maintenance:
  | {
      state: Extract<OverlayState, { kind: "maintenance" }>;
      ready: boolean;
      acknowledge(): void;
      restoreFocus: boolean;
    }
  | undefined;
let projectTrust = {
  restored: false,
  trusted: false,
  receiptHash: undefined as string | undefined,
};
let trustReviewInProgress = false;

function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (
    !win ||
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame
  )
    throw new Error("Untrusted caller");
  const url = new URL(event.senderFrame.url);
  if (
    process.env.EVE_DEV_URL
      ? url.origin !== new URL(process.env.EVE_DEV_URL).origin
      : url.protocol !== "eve:" || url.hostname !== "app"
  )
    throw new Error("Untrusted origin");
}
async function callCore<T>(method: string, payload?: unknown): Promise<T> {
  await coreReady;
  const id = randomUUID();
  const target = worker;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        if (method === "backup-database") {
          // Cancellation cannot release a backup barrier while SQLite still owns
          // its destination. Wait for a terminal receipt or the core's exit.
          const pending = requests.get(id);
          if (!pending) return;
          pending.timer = setTimeout(() => {
            if (requests.has(id)) target.kill();
          }, 15_000);
          try {
            target.postMessage({
              id: randomUUID(),
              method: "cancel-backup",
              payload: { backupId: (payload as { backupId: string }).backupId },
            });
          } catch {
            target.kill();
          }
          return;
        }
        requests.delete(id);
        reject(new Error("Your work is taking longer to save. Please retry."));
      },
      method === "backup-database" ? 120_000 : 8000,
    );
    requests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    try {
      target.postMessage({ id, method, payload });
    } catch (error) {
      clearTimeout(timer);
      requests.delete(id);
      reject(error);
    }
  });
}
function hideSurfaces() {
  surfaceFocus.clear();
  if (visibleSurface?.kind === "workbench") {
    workspaceRuntime.clear(visibleSurface.taskId);
    intents?.invalidateTask(visibleSurface.taskId);
  }
  surfaceGeneration++;
  visibleSurface = undefined;
  for (const view of surfaces.values()) view.setVisible(false);
}
function configureSession(s: Electron.Session) {
  s.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  s.setPermissionCheckHandler(() => false);
  s.on("will-download", (event) => event.preventDefault());
}
function secureContents(contents: Electron.WebContents, allowedOrigin: string) {
  const input = () =>
    editorFocus.input(contents === win.webContents ? "shell" : "editor");
  contents.on("before-input-event", (_event, event) => {
    if (event.type === "keyDown") input();
  });
  contents.on("before-mouse-event", (_event, event) => {
    if (event.type === "mouseDown" || event.type === "mouseWheel") input();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const allowed = new URL(allowedOrigin);
    if (target.protocol !== allowed.protocol || target.host !== allowed.host)
      event.preventDefault();
  });
}
async function recovery(message: string) {
  backupCancellation?.abort();
  hideSurfaces();
  const result = await dialog.showMessageBox({
    type: "error",
    title: "Eve needs a moment",
    message,
    detail: "Your saved work stays on this computer.",
    buttons: ["Restart Eve", "Quit"],
    defaultId: 0,
  });
  if (result.response === 0) app.relaunch();
  closeApproved = true;
  app.quit();
}
async function startCore() {
  coreReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Workspace storage did not start.")),
      10000,
    );
    worker = utilityProcess.fork(
      path.join(__dirname, "core.cjs"),
      [path.join(app.getPath("userData"), "eve.db"), projectRoot],
      {
        serviceName: "Eve workspace",
        stdio: "pipe",
        env: Object.fromEntries(
          [
            "LANG",
            "LC_ALL",
            "TZ",
            "TMPDIR",
            "TEMP",
            "TMP",
            "SYSTEMROOT",
            "WINDIR",
          ].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
      },
    );
    worker.on("message", (message) => {
      if (message.ready) {
        clearTimeout(timer);
        resolve();
        return;
      }
      const request = requests.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      requests.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    });
    worker.stderr?.on("data", (data) => console.error("[core]", String(data)));
    worker.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("Workspace storage stopped."));
      for (const pending of requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Workspace storage stopped."));
      }
      requests.clear();
      if (!exiting)
        void recovery("The workspace service stopped unexpectedly.");
    });
  });
  await coreReady;
}

async function dispatch(payload: unknown) {
  let command = coreCommandSchema.parse(payload);
  if (["ShowHome", "RecallTask", "CreateTask"].includes(command.type)) canvasImageAttachments?.cancelAll();
  let homeReplay: Extract<DispatchResult, { ok: true }> | undefined;
  if (command.type === "ShowHome") {
    // A stale request must not checkpoint a different space before the core
    // rejects it. The final dispatch rechecks this binding after the capture.
    const checked = await callCore<PreflightResult>("preflight", command);
    if (!checked.ok) return checked;
    homeReplay = checked.duplicate;
  }
  if (command.type === "SaveCheckpoint") {
    command = await withEditorCheckpoint(command);
    const position = await media.pauseAndCapture(command.taskId);
    if (position)
      command = {
        ...command,
        checkpoint: { ...command.checkpoint, media: position },
      };
  }
  if (
    command.type === "RecallTask" ||
    command.type === "CreateTask" ||
    (command.type === "ShowHome" && !homeReplay)
  )
    await rememberEditorPlace();
  const before = await callCore<CoreSnapshot>("snapshot");
  const owner =
    "taskId" in command
      ? before.tasks.find((task) => task.id === command.taskId)
      : undefined;
  const broker = owner ? brokerFor(owner) : undefined;
  const result =
    homeReplay ??
    (broker
      ? await broker.dispatch(command)
      : await callCore<DispatchResult>("dispatch", command));
  if (result.ok) {
    if (command.type === "ShowHome" && result.snapshot.activeTaskId === null) {
      // Home releases attention, not buffers/processes. Invalidate in-flight
      // loads and focus claims before publishing the new inactive snapshot.
      editorFocus.invalidate();
      intentFocus.clear();
      overlayRequests.invalidate();
      activeOverlayId = undefined;
      const outgoing = owner?.project && previewForProject(owner.project.id);
      if (outgoing && "clearDraft" in outgoing) outgoing.clearDraft();
      hideSurfaces();
      await overlays.setState(null, { restoreFocus: false });
      if (win.isFocused()) win.webContents.focus();
    }
    win.webContents.send("eve:snapshot-changed", result.snapshot);
    syncIntentCanonical(result.snapshot);
    if (
      command.type === "SetParameter" ||
      (command.type === "Undo" && !!broker)
    ) {
      try {
        if (owner) await syncTaskProject(owner.id);
      } catch {
        win.webContents.send(
          "eve:host-error",
          "Your change was saved. The Orbit preview could not refresh; check the project configuration.",
        );
      }
    }
  }
  return result;
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (exitInputHeld)
    return Promise.reject(
      new Error(
        "Your workspaces are preparing to close. Cancel closing before changing them.",
      ),
    );
  return mutationGate.run(() => {
    hostMutations++;
    updateSessionDirty();
    const work = mutationQueue.then(() => mutationExecution.run(operation));
    mutationQueue = work.catch(() => undefined);
    return work.finally(() => {
      hostMutations--;
      updateSessionDirty();
    });
  });
}

function currentWorkspaceOwner(snapshot: CoreSnapshot): WorkspaceOwner | null {
  if (
    maintenance ||
    exitInputHeld ||
    exiting ||
    closeOwnership.projectClosing ||
    visibleSurface?.kind !== "workbench" ||
    visibleSurface.taskId !== snapshot.activeTaskId
  )
    return null;
  const task = snapshot.tasks.find((item) => item.id === snapshot.activeTaskId);
  const entry = task?.project && workbenches.get(task.project.id);
  if (
    !task?.project ||
    !entry ||
    entry.value.initializationError ||
    !entry.value.service.connected ||
    task.project.verification !== "verified" ||
    entry.value.taskId !== task.id ||
    JSON.stringify(entry.value.project) !== JSON.stringify(task.project)
  )
    return null;
  return {
    taskId: task.id,
    taskEpoch: task.epoch,
    taskRevision: task.revision,
    policyRevision: task.policy.revision,
    processing: task.policy.processing,
    project: task.project,
    serviceInstanceId: entry.value.serviceInstanceId,
    serviceGeneration: entry.generation,
  };
}
async function workspaceSession(taskId: string) {
  const { project } = await requireTaskProjectTrust(taskId);
  const snapshot = await callCore<CoreSnapshot>("snapshot");
  const owner = currentWorkspaceOwner(snapshot);
  const entry = workbenches.get(project.id);
  if (
    !owner ||
    owner.taskId !== taskId ||
    !entry ||
    JSON.stringify(owner.project) !== JSON.stringify(project)
  )
    return null;
  return { owner, editor: entry.value.workspaceEditor };
}
function syncIntentCanonical(snapshot: CoreSnapshot) {
  if (!intents) return;
  try {
    const workbenchContext =
      visibleSurface?.kind === "workbench" &&
      visibleSurface.taskId === snapshot.activeTaskId &&
      editorForTask(visibleSurface.taskId)?.connected
        ? editorForTask(visibleSurface.taskId)!.context
        : null;
    intents.syncCanonical({
      snapshot,
      workbenchContext,
      workspace: workspaceRuntime.current(
        currentWorkspaceOwner(snapshot),
        workbenchContext,
      ),
      selectedSourceId:
        selectedSources.get(snapshot.activeTaskId ?? "") ?? null,
    });
  } catch {
    if (snapshot.activeTaskId) intents.invalidateTask(snapshot.activeTaskId);
  }
}

async function publishWorkspaceJournal(): Promise<void> {
  try {
    const snapshot = await callCore<CoreSnapshot>("snapshot");
    if (win && !win.isDestroyed())
      win.webContents.send("eve:snapshot-changed", snapshot);
    syncIntentCanonical(snapshot);
  } catch {
    // Do not replace an acknowledged/uncertain edit outcome with a failed UI
    // refresh. The private coordinator and durable core journal retain it.
  }
}

async function captureIntentContext(
  taskId: string,
): Promise<CapturedIntentContext> {
  if (!mutationExecution.active) await mutationQueue;
  const surface = JSON.stringify(visibleSurface);
  const sourceId = selectedSources.get(taskId);
  const editor = editorForTask(taskId);
  const context =
    visibleSurface?.kind === "workbench" &&
    visibleSurface.taskId === taskId &&
    editor?.connected
      ? await editor.call<WorkbenchContext>("context")
      : null;
  const position =
    visibleSurface?.kind === "video" && visibleSurface.taskId === taskId
      ? await media.captureIntent(taskId, sourceId)
      : undefined;
  const [attached, material] = await Promise.all([
    media.contextSources(taskId),
    mutationExecution.active
      ? assets.ensureSources(taskId)
      : enqueueMutation(() => assets.ensureSources(taskId)),
  ]);
  const sources = [
    ...attached.filter((source) => !source.assetId),
    ...material,
  ];
  const workspace = context
    ? await workspaceRuntime.capture(taskId, context)
    : null;
  const snapshot = await callCore<CoreSnapshot>("snapshot");
  const currentEditorContext =
    context && editor?.connected && editorForTask(taskId) === editor
      ? await editor.call<WorkbenchContext>("context")
      : null;
  if (
    JSON.stringify(context?.active) !==
      JSON.stringify(currentEditorContext?.active) ||
    sourceId !== selectedSources.get(taskId) ||
    surface !== JSON.stringify(visibleSurface)
  )
    throw new IntentContextError(
      "STALE_CONTEXT",
      "The activity changed while capturing this question.",
    );
  return {
    snapshot,
    workbenchContext: context,
    workspace:
      workspace &&
      workspaceRuntime.current(currentWorkspaceOwner(snapshot), context),
    media: position,
    assets: await assets.list(taskId),
    sources,
    selectedSourceId: sourceId ?? null,
  };
}

async function openSavedSource(taskId: string, sourceId: string) {
  const state = await callCore<CoreSnapshot>("snapshot");
  if (state.activeTaskId !== taskId)
    throw new Error("Open this space before opening its source.");
  const source = (await media.list(taskId)).find(
    (source) => source.id === sourceId,
  );
  if (source?.assetId) {
    const target = await assets.resolveSource(taskId, sourceId);
    const task = state.tasks.find((task) => task.id === taskId)!;
    await executeRegistered(
      { type: "ChangeAttention", activity: "notes" },
      { requestId: randomUUID(), taskId, taskEpoch: task.epoch },
    );
    win.webContents.send("eve:material", target);
    return;
  }
  if (!source?.url)
    throw new Error("This source does not have an external link.");
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("This source cannot be opened.");
  await shell.openExternal(url.href);
}

async function showSavedSource(taskId: string, sourceId: string) {
  const state = await callCore<CoreSnapshot>("snapshot");
  const task = state.tasks.find(item => item.id === taskId);
  const source = (await media.list(taskId)).find(item => item.id === sourceId);
  if (!task || state.activeTaskId !== taskId || !source) throw new Error("Return to this space to open its source.");
  if (source.assetId) return openSavedSource(taskId, sourceId);
  selectedSources.set(taskId, sourceId);
  const activity = task.checkpoint?.selectedActivity === "canvas" ? "canvas" : "video";
  await executeRegistered({ type: "ChangeAttention", activity }, { requestId: randomUUID(), taskId, taskEpoch: task.epoch });
  win.webContents.send("eve:attention", { taskId, activity, sourceId });
}

async function discoverSources({ taskId, query, kind }: { taskId: string; query: string; kind: "article" | "video" }) {
  const state = await callCore<CoreSnapshot>("snapshot");
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || state.activeTaskId !== taskId) throw new Error("Return to this space to find a source.");
  const activity = task.checkpoint?.selectedActivity === "canvas" ? "canvas" : "video";
  await executeRegistered({ type: "ChangeAttention", activity }, { requestId: randomUUID(), taskId, taskEpoch: task.epoch });
  win.webContents.send("eve:attention", { taskId, activity, sourceQuery: query, sourceKind: kind });
}

async function executeRegistered(
  action: RegisteredIntentAction,
  context: RegisteredExecutionContext,
) {
  return enqueueMutation(async () => {
    const state = await callCore<CoreSnapshot>("snapshot");
    const task = state.tasks.find((task) => task.id === context.taskId);
    if (
      !task ||
      state.activeTaskId !== task.id ||
      task.epoch !== context.taskEpoch
    )
      throw new Error("The open space changed. Try again from this space.");
    const run = async (command: CoreCommandInput) => {
      const result = await dispatch(command);
      if (!result.ok) throw new Error(result.error.message);
      return result.snapshot;
    };
    if (action.type === "Undo") {
      await run({
        type: "Undo",
        requestId: context.requestId,
        taskId: task.id,
        expectedEpoch: task.epoch,
      });
      return;
    }
    if (action.type === "PauseAssistance") {
      await run({
        type: "SetTaskPolicy",
        requestId: context.requestId,
        taskId: task.id,
        expectedEpoch: task.epoch,
        expectedRevision: task.policy.revision,
        policy: { processing: task.policy.processing, assistancePaused: true },
      });
      return;
    }
    if (action.type === "RecallTask") {
      const matches = state.tasks.filter(
        (item) =>
          item.title.toLocaleLowerCase() ===
          action.query.trim().toLocaleLowerCase(),
      );
      if (matches.length !== 1) {
        win.webContents.send("eve:recall");
        return;
      }
      const next = matches[0]!;
      const saved = await run({
        type: "RecallTask",
        requestId: context.requestId,
        taskId: next.id,
      });
      const recalled = saved.tasks.find((item) => item.id === next.id)!;
      const activity =
        recalled.checkpoint?.selectedActivity ??
        (recalled.kind === "project" ? "preview" : "notes");
      const focusLeaseId =
        activity === "code" && recalled.project
          ? editorFocus.issue(
              {
                taskId: recalled.id,
                projectId: recalled.project.id,
                projectRevision: recalled.project.revision,
              },
              intentFocus.get(context.requestId),
              win.isFocused(),
            )
          : null;
      win.webContents.send("eve:attention", {
        taskId: recalled.id,
        activity,
        ...(focusLeaseId ? { focusLeaseId } : {}),
      });
      return;
    }
    if (
      action.type !== "ChangeAttention" &&
      action.type !== "RestoreCheckpoint"
    )
      throw new Error("Review the suggested change before applying it.");
    const next: Activity =
      action.type === "ChangeAttention"
        ? action.activity
        : (task.checkpoint?.returnAnchors.at(-1) ??
          (task.kind === "project" ? "preview" : "notes"));
    if (["code", "preview", "easing"].includes(next) && !task.project)
      throw new Error("This activity needs an attached project.");
    if (next === "easing" && task.project?.adapter !== "orbit")
      throw new Error("This project does not have Orbit easing controls.");
    if (next === "preview" && task.project?.preview.kind === "none")
      throw new Error(
        "This project has no preview set up. You can open its code or notes.",
      );
    const previous =
      task.checkpoint?.selectedActivity ??
      (task.kind === "project" ? "preview" : "notes");
    const {
      revision: _revision,
      updatedAt: _updated,
      ...checkpoint
    } = task.checkpoint ?? { returnAnchors: [] };
    await run({
      type: "SaveCheckpoint",
      requestId: context.requestId,
      taskId: task.id,
      expectedEpoch: task.epoch,
      expectedRevision: task.checkpoint?.revision ?? 0,
      checkpoint: {
        ...checkpoint,
        layout: next === "easing" || next === "video" ? "learn" : "work",
        selectedActivity: next,
        returnAnchors:
          action.type === "RestoreCheckpoint"
            ? checkpoint.returnAnchors.slice(0, -1)
            : next === previous
              ? checkpoint.returnAnchors
              : ["easing", "video"].includes(next)
                ? [...checkpoint.returnAnchors, previous].slice(-20)
                : [],
      },
    });
    const focusLeaseId =
      next === "code" && task.project
        ? editorFocus.issue(
            {
              taskId: task.id,
              projectId: task.project.id,
              projectRevision: task.project.revision,
            },
            intentFocus.get(context.requestId),
            win.isFocused(),
          )
        : null;
    win.webContents.send("eve:attention", {
      taskId: task.id,
      activity: next,
      ...(focusLeaseId ? { focusLeaseId } : {}),
    });
  });
}

function publishIntelligenceSettings(settings: IntelligenceSettings) {
  for (const [key, kind] of [
    ["nemotron", "local"],
    ["openai", "cloud"],
  ] as const) {
    const configured = settings.providers.filter(
      (provider) => provider.kind === kind && provider.enabled,
    );
    status.providers[key] = !configured.length
      ? "unconfigured"
      : settings.state === "ready" &&
          configured.some(
            (provider) =>
              !provider.quarantined &&
              (provider.authentication === "none" ||
                provider.credentialPresent),
          )
        ? "ready"
        : "error";
  }
  if (win && !win.isDestroyed())
    win.webContents.send("eve:intelligence", { type: "status", settings });
}

async function withEditorCheckpoint(
  command: Extract<CoreCommand, { type: "SaveCheckpoint" }>,
) {
  const editor = editorForTask(command.taskId);
  if (!editor?.connected) return command;
  const checkpoint = await editor.captureCheckpoint();
  if (!checkpoint) return command;
  const selection = checkpoint.selections[0];
  return {
    ...command,
    checkpoint: {
      ...command.checkpoint,
      selectedFile: checkpoint.uri,
      ...(selection
        ? {
            selection: {
              anchorLine: selection.anchor.line,
              anchorColumn: selection.anchor.character,
              activeLine: selection.active.line,
              activeColumn: selection.active.character,
            },
          }
        : {}),
      topLine: checkpoint.visibleRanges[0]?.start.line ?? 0,
    },
  };
}

async function rememberEditorPlace() {
  const state = await callCore<CoreSnapshot>("snapshot");
  const task = state.tasks.find((item) => item.id === state.activeTaskId);
  if (!task) return;
  const position = await media.pauseAndCapture(task.id);
  if (!position && !editorForTask(task.id)?.connected) return;
  const {
    revision: _revision,
    updatedAt: _updated,
    ...checkpoint
  } = task.checkpoint ?? {
    layout: "work" as const,
    selectedActivity: "code" as const,
    returnAnchors: [],
  };
  const command = await withEditorCheckpoint({
    type: "SaveCheckpoint",
    requestId: randomUUID(),
    taskId: task.id,
    expectedEpoch: task.epoch,
    expectedRevision: task.checkpoint?.revision ?? 0,
    checkpoint: { ...checkpoint, ...(position ? { media: position } : {}) },
  });
  const result = await callCore<DispatchResult>("dispatch", command);
  if (!result.ok) throw new Error(result.error.message);
  if (win && !win.isDestroyed())
    win.webContents.send("eve:snapshot-changed", result.snapshot);
  syncIntentCanonical(result.snapshot);
}

async function restoreEditorPlace(taskId = "orbit") {
  const workbench = editorForTask(taskId);
  if (!workbench?.connected) return;
  // A live workbench keeps every selection and buffer. Cold restoration fills only an empty editor.
  if (await workbench.captureCheckpoint()) return;
  const state = await callCore<CoreSnapshot>("snapshot");
  const task = state.tasks.find((item) => item.id === taskId);
  const saved = task?.checkpoint;
  const s = saved?.selection;
  const top = saved?.topLine ?? 0;
  const uri = saved?.selectedFile?.startsWith("file:")
    ? saved.selectedFile
    : task?.project?.adapter === "orbit"
      ? pathToFileURL(
          path.join(task.project.canonicalRoot, "eve.project.json"),
        ).toString()
      : undefined;
  if (!uri) return;
  await workbench.restoreCheckpoint({
    uri,
    version: 0,
    viewColumn: 1,
    selections: [
      {
        anchor: { line: s?.anchorLine ?? 6, character: s?.anchorColumn ?? 2 },
        active: { line: s?.activeLine ?? 6, character: s?.activeColumn ?? 16 },
      },
    ],
    visibleRanges: [
      { start: { line: top, character: 0 }, end: { line: top, character: 0 } },
    ],
  });
}

async function syncProject() {
  const current = await projectEdits.current();
  const { theme, durationMinutes, transitionMs, easing } = current.config;
  const result = await callCore<{
    ok: boolean;
    value?: CoreSnapshot;
    error?: { message: string };
  }>("observe-project", {
    taskId: "orbit",
    values: { theme, durationMinutes, transitionMs, easing },
  });
  if (result.ok && result.value) {
    if (win && !win.isDestroyed())
      win.webContents.send("eve:snapshot-changed", result.value);
    preview?.updateCommitted(current.config);
    syncIntentCanonical(result.value);
  }
}

function editorForTask(taskId: string): WorkbenchService | undefined {
  return workbenches.entries().find((entry) => entry.value.taskId === taskId)
    ?.value.service;
}
function updateKnownRecoveryNamespaces(snapshot: CoreSnapshot) {
  const legacy = editorForTask("orbit");
  if (
    legacy?.options.profileDirectory ===
    path.join(app.getPath("userData"), "workbench")
  )
    legacy.setKnownRecoveryNamespaces([
      ...new Set(
        snapshot.tasks.flatMap((task) =>
          task.id !== "orbit" && task.project ? [task.project.id] : [],
        ),
      ),
    ]);
}
function previewForProject(projectId: string) {
  return projectPreviews.get(projectId);
}
async function taskProject(
  taskId: string,
  expected?: ProjectRecord,
): Promise<{ task: TaskRecord; project: ProjectRecord }> {
  const snapshot = await callCore<CoreSnapshot>("snapshot");
  const task = snapshot.tasks.find((item) => item.id === taskId);
  const project = task?.project;
  if (!task || !project)
    throw new Error("This space does not have an attached project.");
  if (expected && JSON.stringify(project) !== JSON.stringify(expected))
    throw new Error(
      "The project changed. Review its current folder before continuing.",
    );
  return { task, project };
}
async function requireTaskProjectTrust(
  taskId: string,
  expected?: ProjectRecord,
) {
  const { task, project } = await taskProject(taskId, expected);
  if (project.verification !== "verified" || !project.rootIdentity)
    throw new Error(
      "Review this project's folder before opening its editor or preview.",
    );
  if (
    !(await inspectProjectExecutionTrust(app.getPath("userData"), project))
      .trusted
  )
    throw new Error(
      "This project is paused. Review and trust its folder before opening code or preview.",
    );
  return { task, project };
}
function brokerFor(task: TaskRecord): ProjectEdits | undefined {
  const project = task.project;
  if (
    !project ||
    project.adapter !== "orbit" ||
    project.verification !== "verified"
  )
    return undefined;
  let broker = projectBrokers.get(project.id);
  if (!broker) {
    broker = new ProjectEdits(
      callCore,
      project.canonicalRoot,
      () => {
        const service = editorForTask(task.id);
        return service?.connected ? service : null;
      },
      () =>
        !workbenchAdmissions.has(project.id) && !workbenches.get(project.id),
      async () => {
        const current = (await taskProject(task.id, project)).project;
        const inspected = await inspectProjectDirectory(current.canonicalRoot);
        if (
          JSON.stringify(inspected.rootIdentity) !==
          JSON.stringify(current.rootIdentity)
        )
          throw new Error(
            "The project folder was moved or replaced. Review its location before continuing.",
          );
      },
    );
    projectBrokers.set(project.id, broker);
  }
  return broker;
}
async function syncTaskProject(taskId: string) {
  const { task, project } = await taskProject(taskId);
  const broker = brokerFor(task);
  if (!broker) return;
  const current = await broker.current();
  const { theme, durationMinutes, transitionMs, easing } = current.config;
  const result = await callCore<{ ok: boolean; value?: CoreSnapshot }>(
    "observe-project",
    { taskId, values: { theme, durationMinutes, transitionMs, easing } },
  );
  if (result.ok && result.value) {
    if (win && !win.isDestroyed())
      win.webContents.send("eve:snapshot-changed", result.value);
    const target = previewForProject(project.id);
    if (target && "updateCommitted" in target)
      target.updateCommitted(current.config);
    syncIntentCanonical(result.value);
  }
}
function createWorkbenchRegistry() {
  return new WorkbenchRegistry<OwnedWorkbench>({
    maxEntries: 4,
    create: async ({ identity, generation, signal }) => {
      const snapshot = await callCore<CoreSnapshot>("snapshot");
      const owner = snapshot.tasks.find(
        (task) => task.project?.id === identity.projectId,
      );
      if (!owner?.project)
        throw new Error("This project no longer belongs to a space.");
      const { project } = await requireTaskProjectTrust(
        owner.id,
        owner.project,
      );
      if (
        project.canonicalRoot !== identity.canonicalRoot ||
        JSON.stringify(project.rootIdentity) !==
          JSON.stringify(identity.rootIdentity)
      )
        throw new Error(
          "The project folder changed before the editor could open. Choose its current folder and try again.",
        );
      const legacyOrbit =
        owner.id === "orbit" && project.canonicalRoot === projectRoot;
      const executable =
        process.env.EVE_CODE_SERVER ??
        path.join(
          root,
          ".runtime/code-server/code-server-4.138.0-" +
            (process.platform === "darwin" ? "macos" : "linux") +
            "-arm64/bin/code-server",
        );
      await access(executable);
      const service = new WorkbenchService({
        codeServerExecutable: executable,
        extensionDirectory: path.join(root, "extensions/eve-workbench"),
        profileDirectory: path.join(
          app.getPath("userData"),
          "workbench",
          ...(legacyOrbit ? [] : ["instances", project.id]),
        ),
        ...(legacyOrbit
          ? {}
          : {
              recoveryDirectory: path.join(
                app.getPath("userData"),
                "workbench/recovery",
                project.id,
              ),
            }),
        projectRoot: project.canonicalRoot,
        trustedProject: true,
        ...(legacyOrbit
          ? {
              knownRecoveryNamespaces: [
                ...new Set(
                  snapshot.tasks.flatMap((task) =>
                    task.id !== "orbit" && task.project
                      ? [task.project.id]
                      : [],
                  ),
                ),
              ],
            }
          : {}),
        signal,
      });
      const owned: OwnedWorkbench = {
        taskId: owner.id,
        project,
        service,
        serviceInstanceId: randomUUID(),
        serviceGeneration: generation,
        workspaceEditor: {
          get connected() {
            return service.connected;
          },
          context: () => service.call<WorkbenchContext>("context"),
          inspect: (uri) =>
            service.call<DocumentState | null>("document.inspect", {
              uri,
              maxBytes: WORKSPACE_PLAN_LIMITS.documentBytes,
            }),
          apply: (input) => service.call("edit.apply", input),
        },
      };
      const resource = {
        value: owned,
        dispose: async () => {
          workspaceRuntime.clear(owner.id);
          intents?.invalidateTask(owner.id);
          await service.close();
          const key = `workbench:${project.id}`,
            view = surfaces.get(key);
          if (view) {
            win.contentView.removeChildView(view);
            view.webContents.close();
            surfaces.delete(key);
            surfaceLoads.delete(key);
          }
          service.removeAllListeners();
          clearTimeout(projectSyncTimers.get(project.id));
          projectSyncTimers.delete(project.id);
          incompleteRecovery.delete(project.id);
          workbenchAdmissions.delete(project.id);
          if (workbench === service) {
            workbench = undefined;
            workbenchStarting = undefined;
          }
        },
      };
      return initializeOwnedResource(resource, async () => {
        // Own the disposal handle before startup can allocate a process. A
        // failed startup whose stop also fails must remain registry-owned.
        await service.start();
        if (legacyOrbit) workbench = service;
        service.on("context", () => {
          if (
            visibleSurface?.taskId === owner.id &&
            visibleSurface.kind === "workbench"
          )
            void callCore<CoreSnapshot>("snapshot")
              .then(syncIntentCanonical)
              .catch(() => undefined);
          if (project.adapter === "orbit") {
            clearTimeout(projectSyncTimers.get(project.id));
            projectSyncTimers.set(
              project.id,
              setTimeout(() => {
                void enqueueMutation(() => syncTaskProject(owner.id)).catch(
                  () => undefined,
                );
              }, 180),
            );
          }
        });
        service.on("selectionIntent", () => {
          if (
            visibleSurface?.taskId === owner.id &&
            visibleSurface.kind === "workbench"
          )
            win.webContents.send("eve:ask-selection");
        });
        service.on("status", () => {
          if (!service.connected) {
            workspaceRuntime.clear(owner.id);
            intents?.invalidateTask(owner.id);
          }
          if (visibleSurface?.taskId === owner.id)
            status.workbench = service.connected ? "ready" : "starting";
          updateSessionDirty();
        });
        service.on("dirty", () => {
          incompleteRecovery.delete(project.id);
          updateSessionDirty();
        });
        service.on("recoveryError", () => {
          incompleteRecovery.add(project.id);
          updateSessionDirty();
          win.webContents.send(
            "eve:host-error",
            `${owner.title}: a recovery copy of your code could not be saved. Keep the editor open and save your files.`,
          );
        });
      });
    },
    prepareClose: prepareWorkbenchClose,
  });
}
async function ensureWorkbench(taskId = "orbit") {
  const { project } = await requireTaskProjectTrust(taskId);
  if (!project.rootIdentity)
    throw new Error("Verify this project folder first.");
  const retained = workbenches.get(project.id);
  if (retained?.value.initializationError)
    throw retained.value.initializationError;
  if (retained && retained.value.taskId !== taskId)
    throw new Error("This project editor already belongs to another space.");
  const existing = workbenchAdmissions.get(project.id);
  if (existing) return existing;
  status.workbench = "starting";
  const starting = workbenches
    .ensure({
      projectId: project.id,
      canonicalRoot: project.canonicalRoot,
      rootIdentity: project.rootIdentity,
    })
    .then((entry) => {
      if (entry.value.initializationError)
        throw entry.value.initializationError;
      if (entry.value.taskId !== taskId)
        throw new Error(
          "This editor belongs to another space. Open that space to continue editing.",
        );
      return entry.value.service;
    });
  workbenchAdmissions.set(project.id, starting);
  if (taskId === "orbit") workbenchStarting = starting;
  void starting.catch(() => {
    if (workbenchAdmissions.get(project.id) === starting)
      workbenchAdmissions.delete(project.id);
    if (workbenchStarting === starting) workbenchStarting = undefined;
    status.workbench = "error";
  });
  return starting;
}

async function activateWorkbenchRecovery(owned: OwnedWorkbench): Promise<void> {
  if (owned.recoveryHandled || owned.restored) return owned.restored;
  const active = async () => {
    if (
      maintenance ||
      exitInputHeld ||
      exiting ||
      visibleSurface?.kind !== "workbench" ||
      visibleSurface.taskId !== owned.taskId ||
      visibleSurface.key !== `workbench:${owned.project.id}`
    )
      return false;
    const state = await callCore<CoreSnapshot>("snapshot");
    const task = state.tasks.find((item) => item.id === owned.taskId);
    if (task && state.activeTaskId === owned.taskId) {
      owned.recoveryTitle = task.title;
      return true;
    }
    return false;
  };
  // Recovery writes real buffers and journals; maintenance/close must drain it
  // before suspending or disposing any owned editor.
  const operation = mutationGate.run(async () => {
    await owned.service.waitUntilConnected();
    if (!(await active())) return;
    status.workbench = "ready";
    owned.recoveryDeferred = false;
    owned.recovery ??= new WorkbenchRecoveryCoordinator({
      workbench: owned.service,
      assertActive: async () => {
        if (!(await active())) {
          owned.recoveryDeferred = true;
          throw new Error(
            "Open Code in this space to finish recovering its drafts.",
          );
        }
      },
      chooseRecovery: async (drafts) => {
        if (!(await active())) {
          owned.recoveryDeferred = true;
          return "later";
        }
        const state = await callCore<CoreSnapshot>("snapshot"),
          title =
            state.tasks.find((task) => task.id === owned.taskId)?.title ??
            "This space";
        const choice = await dialog.showMessageBox(win, {
          type: "question",
          message: `${drafts.length} editor ${drafts.length === 1 ? "draft is" : "drafts are"} ready to recover`,
          detail: `${title}: recovered drafts open as separate unsaved files. Current project files stay intact.`,
          buttons: ["Recover drafts", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        if (!(await active())) {
          owned.recoveryDeferred = true;
          return "later";
        }
        return choice.response === 0 ? "recover" : "later";
      },
      notify: (result) => {
        if (result.status !== "empty" && !owned.recoveryDeferred)
          win.webContents.send(
            "eve:host-error",
            `${owned.recoveryTitle ?? "This space"}: ${result.message}`,
          );
      },
    });
    const result = await owned.recovery.run();
    if (owned.recoveryDeferred || !(await active())) return;
    owned.recoveryHandled = ["empty", "later", "recovered"].includes(
      result.status,
    );
    await restoreEditorPlace(owned.taskId);
  });
  owned.restored = operation;
  try {
    await operation;
  } catch (error) {
    status.workbench = "error";
    win.webContents.send(
      "eve:host-error",
      error instanceof Error
        ? error.message
        : "The editor could not restore its place.",
    );
  } finally {
    if (owned.restored === operation) owned.restored = undefined;
  }
}

async function requestWorkbenchRecovery(): Promise<void> {
  try {
    if (maintenance || exitInputHeld || exiting)
      throw new Error(
        "Wait for the current operation to finish, then recover your code drafts.",
      );
    const visible = visibleSurface;
    const state = await callCore<CoreSnapshot>("snapshot");
    const task = state.tasks.find((item) => item.id === state.activeTaskId);
    const owned = task?.project && workbenches.get(task.project.id)?.value;
    if (
      !owned ||
      visible?.kind !== "workbench" ||
      visible.taskId !== task.id ||
      visible.key !== `workbench:${owned.project.id}` ||
      visibleSurface !== visible
    )
      throw new Error(
        "Open Code in this space to recover its drafts.",
      );
    owned.recoveryHandled = false;
    await activateWorkbenchRecovery(owned);
  } catch (error) {
    win.webContents.send(
      "eve:host-error",
      error instanceof Error
        ? error.message
        : "Editor drafts could not be opened.",
    );
  }
}

async function focusReadyEditor(
  owned: OwnedWorkbench,
  view: WebContentsView,
  claim: EditorFocusClaim,
  owner: SurfaceFocusOwner,
  restoration: Promise<void>,
) {
  try {
    await restoration;
    if (!editorFocus.current(claim)) return;
    await owned.service.waitUntilConnected();
    const snapshot = await callCore<CoreSnapshot>("snapshot");
    const task = snapshot.tasks.find((item) => item.id === owned.taskId);
    if (
      editorFocus.current(claim) &&
      surfaceFocus.current(owner) &&
      !maintenance &&
      !exitInputHeld &&
      !exiting &&
      !activeOverlayId &&
      win.isFocused() &&
      !view.webContents.isDestroyed() &&
      view.getVisible() &&
      owned.service.connected &&
      visibleSurface?.key === `workbench:${owned.project.id}` &&
      visibleSurface.taskId === owned.taskId &&
      snapshot.activeTaskId === owned.taskId &&
      task?.project?.id === claim.target.projectId &&
      task.project.revision === claim.target.projectRevision
    )
      view.webContents.focus();
  } catch {
    /* Focus is optional; actual editor/recovery failures use their existing status path. */
  } finally {
    editorFocus.finish(claim);
  }
}

function updateSessionDirty() {
  if (!sessionReady || !sessionBridge) return;
  const dirty =
    !!profileBackup ||
    rendererState.dirty ||
    rendererState.busy ||
    hostMutations > 0 ||
    recoveryIncomplete ||
    incompleteRecovery.size > 0 ||
    workbenchAdmissions.size > workbenches.entries().length ||
    workbenches
      .entries()
      .some(
        ({ value }) =>
          !value.service.connected || value.service.dirtyDocuments.length > 0,
      );
  void sessionBridge.setDirty(dirty).catch(() => {
    sessionReady = false;
    win.webContents.send(
      "eve:host-error",
      "Session save protection is unavailable. Save your work before using the desktop logout controls.",
    );
  });
}

function requestRendererSettlement(): Promise<boolean> {
  if (rendererSettlement || win.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rendererSettlement = undefined;
      resolve(false);
    }, 20_000);
    rendererSettlement = { resolve, timer };
    win.webContents.send("eve:prepare-close");
  });
}

const exitGuards = new Map<Electron.WebContents, () => void>();
function blockExitInput(contents: Electron.WebContents) {
  if (exitGuards.has(contents) || contents.isDestroyed()) return;
  const stop = (event: Electron.Event) => event.preventDefault();
  contents.on("before-input-event", stop);
  contents.on("before-mouse-event", stop);
  contents.setIgnoreMenuShortcuts(true);
  exitGuards.set(contents, () => {
    if (!contents.isDestroyed()) {
      contents.off("before-input-event", stop);
      contents.off("before-mouse-event", stop);
      contents.setIgnoreMenuShortcuts(false);
    }
  });
}
function allowExitInput(contents?: Electron.WebContents) {
  if (!contents) return;
  exitGuards.get(contents)?.();
  exitGuards.delete(contents);
}
async function prepareWorkbenchClose(
  entry: WorkbenchEntry<OwnedWorkbench>,
): Promise<WorkbenchClosePermit | null> {
  if (!exitInputHeld)
    throw new Error(
      "Eve could not pause editing to close this project. Please try again.",
    );
  const { service, taskId } = entry.value,
    key = `workbench:${entry.identity.projectId}`;
  if (entry.value.initializationError)
    return {
      assertHeld: async () => {
        if (!exitInputHeld) throw new Error("Closing was interrupted. Please try again.");
      },
      release: async () => {},
    };
  if (!service.connected)
    throw new Error(
      "An editor connection is recovering. Reconnect it before closing so Eve can check its unsaved files.",
    );
  const documents = await service.call<DocumentState[]>("dirty.list");
  const view = surfaces.get(key);
  if (documents.length) {
    const state = await callCore<CoreSnapshot>("snapshot"),
      title =
        state.tasks.find((task) => task.id === taskId)?.title ?? "This space";
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      message: "Keep your changes before leaving?",
      detail: `${title} has unsaved work, including any untitled files. Other editors stay open until every space is ready.`,
      buttons: ["Save All", "Review before closing", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return null;
    if (response === 1) {
      reviewAfterClose = taskId;
      return null;
    }
    if (view) {
      for (const other of surfaces.values()) other.setVisible(false);
      allowExitInput(view.webContents);
      view.setVisible(true);
      view.webContents.focus();
    }
    try {
      if (!(await service.saveAll()).saved) return null;
    } finally {
      if (view) {
        blockExitInput(view.webContents);
        view.setVisible(false);
      }
    }
  }
  const assertHeld = async () => {
    if (
      !exitInputHeld ||
      !service.connected ||
      (view && !exitGuards.has(view.webContents))
    )
      throw new Error("Closing was interrupted. Your editor is still open.");
    // The explicit extension capture fsyncs its current-session orphan; the
    // service then fsyncs current.json. A delayed save notification is not a
    // durable clean-close acknowledgement.
    const documents = await service.captureDurableRecovery();
    if (
      !exitInputHeld ||
      !service.connected ||
      (view && !exitGuards.has(view.webContents))
    )
      throw new Error("Closing was interrupted while saving a recovery copy. Keep the editor open and save your files.");
    if (documents.length)
      throw new Error(
        "An editor changed while closing. Its new work remains open.",
      );
  };
  await assertHeld();
  return { assertHeld, release: async () => {} }; // The enclosing host owns all input guards through disposal.
}
async function restoreCloseAttention(previous: typeof visibleSurface) {
  const reviewTask = reviewAfterClose;
  reviewAfterClose = undefined;
  if (reviewTask) {
    const state = await callCore<CoreSnapshot>("snapshot");
    if (state.activeTaskId !== reviewTask)
      await enqueueMutation(() =>
        dispatch({
          type: "RecallTask",
          requestId: randomUUID(),
          taskId: reviewTask,
        }),
      );
    win.webContents.send("eve:attention", {
      taskId: reviewTask,
      activity: "code",
    });
    const owned = workbenches
      .entries()
      .find((entry) => entry.value.taskId === reviewTask);
    if (owned) {
      const key = `workbench:${owned.identity.projectId}`;
      visibleSurface = { kind: "workbench", key, taskId: reviewTask };
      surfaces.get(key)?.setVisible(true);
      surfaces.get(key)?.webContents.focus();
    }
  } else if (previous)
    surfaces
      .get(previous.key)
      ?.setVisible(previous.kind !== "video" || !activeOverlayId);
}
async function rememberAllEditorPlaces() {
  await rememberEditorPlace();
  for (const { value } of workbenches.entries()) {
    const state = await callCore<CoreSnapshot>("snapshot"),
      task = state.tasks.find((item) => item.id === value.taskId);
    if (!task || state.activeTaskId === task.id || !value.service.connected)
      continue;
    const {
      revision: _revision,
      updatedAt: _updated,
      ...checkpoint
    } = task.checkpoint ?? {
      layout: "work" as const,
      selectedActivity: "code" as const,
      returnAnchors: [],
    };
    const command = await withEditorCheckpoint({
      type: "SaveCheckpoint",
      requestId: randomUUID(),
      taskId: task.id,
      expectedEpoch: task.epoch,
      expectedRevision: task.checkpoint?.revision ?? 0,
      checkpoint,
    });
    const result = await callCore<DispatchResult>("dispatch", command);
    if (!result.ok) throw new Error(result.error.message);
    win.webContents.send("eve:snapshot-changed", result.snapshot);
  }
}
function prepareWorkForExit(signal?: AbortSignal): Promise<boolean> {
  if (exitPreparing) return exitPreparing;
  const pending = prepareWorkForExitOwned(signal);
  exitPreparing = pending;
  void pending
    .finally(() => {
      if (exitPreparing === pending) exitPreparing = undefined;
    })
    .catch(() => {});
  return pending;
}
async function prepareWorkForExitOwned(signal?: AbortSignal): Promise<boolean> {
  if (preparedExitRelease) return true;
  const preparation = new AbortController();
  exitPreparation = preparation;
  const cancellation = signal
    ? AbortSignal.any([signal, preparation.signal])
    : preparation.signal;
  cancellation.throwIfAborted();
  await closeOwnership.settleProjectClose();
  cancellation.throwIfAborted();
  if (profileBackup) {
    backupCancellation?.abort();
    await profileBackup.catch(() => undefined);
  }
  await mutationQueue;
  await workbenches.settledStarts(cancellation);
  await Promise.all([...previewStarts.values()]);
  await enqueueMutation(() => rememberAllEditorPlaces());
  cancellation.throwIfAborted();
  const previous = visibleSurface;
  const inputOwner = closeOwnership.claimInput();
  editorFocus.invalidate();
  exitInputHeld = true;
  surfaceGeneration++;
  blockExitInput(win.webContents);
  for (const view of surfaces.values()) {
    blockExitInput(view.webContents);
    view.setVisible(false);
  }
  let gate: Awaited<ReturnType<MutationGate["acquire"]>> | undefined;
  let retained = false;
  let releasing: Promise<void> | undefined;
  const release = () =>
    (releasing ??= (async () => {
      if (!inputOwner.owns()) return;
      try {
        await gate?.release();
      } finally {
        exitInputHeld = false;
        for (const contents of [...exitGuards.keys()]) allowExitInput(contents);
        if (preparedExitRelease === release) preparedExitRelease = undefined;
        if (exitPreparation === preparation) exitPreparation = undefined;
        try {
          if (!exiting) {
            if (workbenches.size === 0) workbenches = createWorkbenchRegistry();
            await restoreCloseAttention(previous);
          }
        } finally {
          inputOwner.release();
        }
      }
    })());
  try {
    gate = await mutationGate.acquire(cancellation);
    await gate.assertHeld();
    if (rendererState.dirty || rendererState.busy) return false;
    const result = await workbenches.dispose({
      reason: "Leave Eve",
      signal: cancellation,
    });
    if (!result.disposed) return false;
    await gate.assertHeld();
    cancellation.throwIfAborted();
    preparedExitRelease = release;
    retained = true;
    updateSessionDirty();
    return true;
  } finally {
    if (!retained) await release();
  }
}
async function closeOwnedServices() {
  if (!preparedExitRelease && !(await prepareWorkForExit())) return;
  exiting = true;
  clearTimeout(projectSyncTimer);
  for (const timer of projectSyncTimers.values()) clearTimeout(timer);
  await media.close();
  await Promise.all(
    [...projectPreviews.values()].map((value) => value.close()),
  );
  projectPreviews.clear();
  preview = undefined;
  intents?.dispose();
  await intelligence?.dispose();
  await callCore("close");
  sessionBridge?.close();
  await preparedExitRelease?.();
  closeApproved = true;
  win.close();
}
function closeProjectViews(taskId: string): Promise<{ closed: boolean }> {
  // Reserve before snapshot/checkpoint/startup awaits. UI serialization is not
  // authority for native exit or backup requests arriving concurrently.
  if (
    profileBackup ||
    exitPreparing ||
    closeInProgress ||
    closeOwnership.inputHeld
  )
    return Promise.reject(
      new Error(
        "Finish the current workspace operation before closing project views.",
      ),
    );
  return closeOwnership.closeProject(() => closeProjectViewsOwned(taskId));
}
async function closeProjectViewsOwned(
  taskId: string,
): Promise<{ closed: boolean }> {
  if (
    maintenance ||
    exitInputHeld ||
    exiting ||
    closeInProgress ||
    profileBackup
  )
    throw new Error(
      "Wait for the current operation to finish, then close this project's code and preview.",
    );
  const snapshot = await callCore<CoreSnapshot>("snapshot");
  if (snapshot.activeTaskId !== taskId)
    throw new Error("Open this space before closing its code and preview.");
  const { project } = await taskProject(taskId);
  await workbenches.settledStarts();
  await Promise.all([...previewStarts.values()]);
  await enqueueMutation(() => rememberEditorPlace());
  const previous = visibleSurface;
  const inputOwner = closeOwnership.claimInput();
  editorFocus.invalidate();
  exitInputHeld = true;
  surfaceGeneration++;
  blockExitInput(win.webContents);
  for (const view of surfaces.values()) {
    blockExitInput(view.webContents);
    view.setVisible(false);
  }
  let gate: Awaited<ReturnType<MutationGate["acquire"]>> | undefined;
  try {
    gate = await mutationGate.acquire();
    await gate.assertHeld();
    const result = await workbenches.close(project.id, {
      reason: "Close project views",
    });
    if (!result.closed) return result;
    const target = projectPreviews.get(project.id);
    await target?.close();
    projectPreviews.delete(project.id);
    const key = `preview:${project.id}`,
      view = surfaces.get(key);
    if (view) {
      win.contentView.removeChildView(view);
      view.webContents.close();
      surfaces.delete(key);
      surfaceLoads.delete(key);
    }
    if (taskId === "orbit") preview = undefined;
    if (visibleSurface && !surfaces.has(visibleSurface.key))
      visibleSurface = undefined;
    return { closed: true };
  } finally {
    if (inputOwner.owns()) {
      try {
        await gate?.release();
      } finally {
        exitInputHeld = false;
        for (const contents of [...exitGuards.keys()]) allowExitInput(contents);
        try {
          await restoreCloseAttention(previous);
        } finally {
          inputOwner.release();
        }
      }
    }
  }
}

async function approveClose() {
  if (closeInProgress) return;
  closeInProgress = true;
  try {
    if (!(await prepareWorkForExit())) return;
    await closeOwnedServices();
  } catch (error) {
    if (exiting) {
      await dialog.showMessageBox(win, {
        type: "error",
        message: "Eve could not finish closing.",
        detail:
          "Your saved work and recovery drafts remain on this computer. Restart Eve to open them again.",
        buttons: ["Restart Eve"],
        defaultId: 0,
      });
      app.relaunch();
      closeApproved = true;
      app.exit(1);
    } else
      await dialog.showMessageBox(win, {
        type: "error",
        message: "Your workspace is still open.",
        detail:
          error instanceof Error
            ? error.message
            : "Please save your work and try again.",
      });
  } finally {
    closeInProgress = false;
  }
}

function startSessionIntegration() {
  if (!sessionMode) return;
  if (
    process.platform !== "linux" ||
    process.env.EVE_SESSION !== "1" ||
    !/^[a-f0-9-]{36}$/i.test(process.env.EVE_SESSION_ID ?? "")
  )
    throw new Error(
      "Eve session mode must be started by its installed session launcher.",
    );
  sessionBridge = new LinuxSessionBridge(
    "/usr/lib/eve-session/session-bridge.py",
  );
  sessionBridge.on("bridgeError", () => {
    sessionExitGeneration++;
    exitPreparation?.abort(new Error("The session save bridge disconnected."));
    void preparedExitRelease?.().catch(() => undefined);
    sessionReady = false;
    win.webContents.send(
      "eve:host-error",
      "Eve could not connect to the session save protection. Save your work before leaving the desktop.",
    );
  });
  sessionBridge.on("event", async (event) => {
    try {
      if (event.type === "ready") {
        sessionReady = true;
        updateSessionDirty();
      }
      if (event.type === "lock" && event.locked) {
        handlePrivacyBoundary();
      }
      if (event.type === "exit-cancelled") {
        sessionExitGeneration++;
        exitPreparation?.abort(new Error("The desktop cancelled leaving Eve."));
        await preparedExitRelease?.();
        updateSessionDirty();
        return;
      }
      if (
        event.type === "exit-request" &&
        event.dirty &&
        !sessionExitInProgress
      ) {
        sessionExitInProgress = true;
        const generation = ++sessionExitGeneration;
        try {
          win.show();
          win.focus();
          const choice = await dialog.showMessageBox(win, {
            type: "question",
            message: "Save your work before leaving Eve?",
            detail: "The desktop is waiting while your changes are still open.",
            buttons: ["Save and continue", "Stay in Eve"],
            defaultId: 0,
            cancelId: 1,
          });
          if (
            generation === sessionExitGeneration &&
            choice.response === 0 &&
            (await requestRendererSettlement()) &&
            generation === sessionExitGeneration &&
            (await prepareWorkForExit())
          ) {
            if (generation !== sessionExitGeneration) {
              await preparedExitRelease?.();
              return;
            }
            await sessionBridge!.setDirty(false);
            if (generation !== sessionExitGeneration) {
              await preparedExitRelease?.();
              return;
            }
            await sessionBridge!.respondToExit(true);
          } else
            await sessionBridge!.respondToExit(
              false,
              "Your work is still open in Eve.",
            );
        } catch (error) {
          await preparedExitRelease?.();
          throw error;
        } finally {
          sessionExitInProgress = false;
        }
      }
      if (event.type === "stop" && !exiting) await closeOwnedServices();
    } catch (error) {
      win.webContents.send(
        "eve:host-error",
        error instanceof Error
          ? error.message
          : "The desktop is still waiting for your work to be saved.",
      );
    }
  });
  sessionBridge.start();
}

function handlePrivacyBoundary() {
  if (exiting || !win || win.isDestroyed()) return;
  editorFocus.invalidate();
  intentFocus.clear();
  overlayRequests.invalidate();
  workspaceRuntime.clear();
  backupCancellation?.abort();
  if (maintenance) maintenance.restoreFocus = false;
  // Retire context immediately: a model completion must not race the durable
  // checkpoint or the asynchronous OS/session bridge at a privacy boundary.
  intents?.cancelAll();
  canvasImageAttachments?.cancelAll();
  win.webContents.send("eve:privacy-lock");
  activeOverlayId = undefined;
  void overlays.setState(null, { restoreFocus: false });
  const mediaTaskId = visibleSurface?.taskId;
  if (mediaTaskId)
    void media.pauseAndCapture(mediaTaskId).catch(() => undefined);
  void enqueueMutation(() => rememberEditorPlace()).catch(() => {
    if (!win.isDestroyed())
      win.webContents.send(
        "eve:host-error",
        "Eve could not update your saved place before the computer paused. Your saved work is still here.",
      );
  });
}

async function holdBackupInput(
  signal?: AbortSignal,
  copy?: { title: string; detail: string },
) {
  signal?.throwIfAborted();
  editorFocus.invalidate();
  const snapshot = await callCore<CoreSnapshot>("snapshot");
  const state: Extract<OverlayState, { kind: "maintenance" }> = {
    kind: "maintenance",
    instanceId: randomUUID(),
    taskId: snapshot.activeTaskId ?? "workspace",
    title: copy?.title ?? "Keeping your work safe.",
    detail:
      copy?.detail ??
      "Preparing a verified copy of your spaces, originals, and project files.",
    phase: "working",
  };
  let acknowledge!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    rejectReady = reject;
  });
  // Install rejection handling before the renderer can crash or cancel during load.
  void ready.catch(() => undefined);
  const current = { state, ready: false, acknowledge, restoreFocus: true };
  maintenance = current;
  overlayRequests.invalidate();
  // A native activity may still be awaiting authentication or its first load.
  // Its older request cannot reveal a view after this input hold takes over.
  const heldGeneration = ++surfaceGeneration;
  const heldSurface = visibleSurface;
  intents.cancelAll();
  canvasImageAttachments?.cancelAll();
  win.webContents.send("eve:privacy-lock");
  activeOverlayId = state.instanceId;
  for (const view of surfaces.values()) view.setVisible(false);
  const cancel = () => {
    rejectReady(new Error("Backup cancelled before the workspace was paused."));
    if (maintenance === current) {
      current.state = {
        ...current.state,
        phase: "cancelling",
        detail: "Finishing the current save and resuming your workspace.",
      };
      void overlays.setState(current.state);
    }
  };
  const timer = setTimeout(
    () =>
      rejectReady(
        new Error(
          "Eve could not pause the workspace controls. The backup was not started.",
        ),
      ),
    8000,
  );
  signal?.addEventListener("abort", cancel, { once: true });
  const release = async () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (maintenance !== current) return;
    maintenance = undefined;
    activeOverlayId = undefined;
    await overlays.setState(null, { restoreFocus: current.restoreFocus });
    const snapshot = await callCore<CoreSnapshot>("snapshot").catch(() => null);
    if (
      surfaceGeneration === heldGeneration &&
      visibleSurface === heldSurface &&
      heldSurface &&
      snapshot?.activeTaskId === heldSurface.taskId
    )
      surfaces.get(heldSurface.key)?.setVisible(true);
  };
  try {
    await overlays.setState(state);
    await ready;
    clearTimeout(timer);
    signal?.throwIfAborted();
    return {
      assertHeld: async () => {
        signal?.throwIfAborted();
        if (maintenance !== current || !current.ready || win.isDestroyed())
          throw new Error("Your workspace resumed before this operation finished. Please try again.");
      },
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

function beginProfileExport() {
  if (
    profileBackup ||
    exiting ||
    exitPreparing ||
    exitInputHeld ||
    closeOwnership.projectClosing ||
    closeOwnership.inputHeld
  )
    return;
  const controller = new AbortController();
  backupCancellation = controller;
  const operation = (async () => {
    const selected = await dialog.showSaveDialog(win, {
      title: "Export Eve backup",
      buttonLabel: "Export backup",
      defaultPath: path.join(
        app.getPath("documents"),
        `Eve ${new Date().toISOString().slice(0, 10)}.evebackup`,
      ),
      message: "Choose a new location for a private backup folder.",
    });
    if (selected.canceled || !selected.filePath) return;
    await exportEveProfile({
      profileRoot: app.getPath("userData"),
      destination: selected.filePath,
      appVersion: app.getVersion(),
      core: callCore,
      mutationGate,
      signal: controller.signal,
      holdInput: holdBackupInput,
      flushRendererAndPlaces: async (signal) => {
        signal?.throwIfAborted();
        if (!(await requestRendererSettlement()))
          throw new Error(
            "Finish reviewing your unsaved changes, then export the workspace again.",
          );
        await workbenches.settledStarts(signal);
        await Promise.all([...previewStarts.values()]);
        await enqueueMutation(() => rememberAllEditorPlaces());
        signal?.throwIfAborted();
      },
      acquireWorkbenchScope: ({ signal, pause }) =>
        workbenches.freeze({
          signal,
          pause: (entry, entrySignal) =>
            pause(entry.value.service, entrySignal),
        }),
    });
    return selected.filePath;
  })();
  const finished = operation
    .then(() => undefined)
    .finally(() => {
      if (profileBackup === finished) {
        profileBackup = undefined;
        backupCancellation = undefined;
        updateSessionDirty();
      }
    });
  profileBackup = finished;
  updateSessionDirty();
  void operation
    .then(async (destination) => {
      await finished;
      if (destination && !exiting && !win.isDestroyed())
        await dialog.showMessageBox(win, {
          type: "info",
          message: "Your Eve backup is saved.",
          detail: destination,
          buttons: ["Done"],
        });
    })
    .catch(async (error) => {
      await finished.catch(() => undefined);
      if (!controller.signal.aborted && !exiting && !win.isDestroyed())
        await dialog.showMessageBox(win, {
          type: "error",
          message: "The backup could not finish.",
          detail:
            error instanceof Error
              ? error.message
              : "Your original workspace is still here.",
          buttons: ["Keep working"],
        });
    });
}

function beginProfileRestore() {
  if (
    profileBackup ||
    exiting ||
    exitPreparing ||
    exitInputHeld ||
    closeOwnership.projectClosing ||
    closeOwnership.inputHeld
  )
    return;
  const controller = new AbortController();
  backupCancellation = controller;
  const operation = (async () => {
    const selected = await dialog.showOpenDialog(win, {
      title: "Choose an Eve backup",
      buttonLabel: "Choose backup",
      properties: ["openDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return;
    const destination = await dialog.showSaveDialog(win, {
      title: "Restore into a new workspace",
      buttonLabel: "Restore workspace",
      defaultPath: path.join(
        app.getPath("documents"),
        `Eve restored ${new Date().toISOString().slice(0, 10)}`,
      ),
      message: "Choose a new folder. Your current workspace remains open.",
    });
    if (destination.canceled || !destination.filePath) return;
    const input = await holdBackupInput(controller.signal, {
      title: "Bringing your work back.",
      detail: "Checking the backup and restoring it into a separate workspace.",
    });
    try {
      await restoreProfileBackup({
        backupDirectory: selected.filePaths[0],
        destination: destination.filePath,
        signal: controller.signal,
        validateVersions: async (versions) =>
          versions.app === app.getVersion() &&
          [3, 4, 5, 6].includes(versions.schema),
        relocate: relocateEveProfile,
      });
      return destination.filePath;
    } finally {
      await input.release();
    }
  })();
  const finished = operation
    .then(() => undefined)
    .finally(() => {
      if (profileBackup === finished) {
        profileBackup = undefined;
        backupCancellation = undefined;
        updateSessionDirty();
      }
    });
  profileBackup = finished;
  updateSessionDirty();
  void operation
    .then(async (destination) => {
      await finished;
      if (!destination || exiting || win.isDestroyed()) return;
      const choice = await dialog.showMessageBox(win, {
        type: "info",
        message: "Your restored workspace is ready.",
        detail: `Saved to ${destination}. Project content stays paused until you choose to trust it.`,
        buttons: ["Open restored workspace", "Keep working here"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) await launchProfile(destination);
    })
    .catch(async (error) => {
      await finished.catch(() => undefined);
      if (!controller.signal.aborted && !exiting && !win.isDestroyed())
        await dialog.showMessageBox(win, {
          type: "error",
          message: "The workspace could not be restored.",
          detail:
            error instanceof Error
              ? error.message
              : "Your backup and current workspace were preserved.",
          buttons: ["Keep working"],
        });
    });
}

async function launchProfile(directory: string) {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "EVE_CODE_SERVER",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  const args = [
    ...(app.isPackaged ? [] : [root]),
    "--app",
    "--profile",
    directory,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: environment,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function ensureProjectPreview(
  taskId: string,
): Promise<OrbitPreview | ProjectPreview> {
  const { project } = await requireTaskProjectTrust(taskId);
  const existing = projectPreviews.get(project.id);
  if (existing) return existing;
  const starting = previewStarts.get(project.id);
  if (starting) return starting;
  if (projectPreviews.size + previewStarts.size >= 8)
    throw new Error(
      "Close one of your open project previews before opening another.",
    );
  status.preview = "starting";
  const operation = (async () => {
    let started: OrbitPreview | ProjectPreview;
    if (project.adapter === "orbit") {
      const { startOrbitPreview } = await import(
        pathToFileURL(path.join(root, "examples/orbit/server.mjs")).href
      );
      await requireTaskProjectTrust(taskId, project);
      started = await startOrbitPreview({ projectRoot: project.canonicalRoot });
    } else
      started = await startProjectPreview({
        project,
        authorize: async (captured) => {
          await requireTaskProjectTrust(taskId, captured);
        },
      });
    try {
      await requireTaskProjectTrust(taskId, project);
    } catch (error) {
      await started.close();
      throw error;
    }
    projectPreviews.set(project.id, started);
    if (taskId === "orbit" && "updateCommitted" in started) preview = started;
    status.preview = "ready";
    return started;
  })();
  previewStarts.set(project.id, operation);
  void operation
    .finally(() => {
      if (previewStarts.get(project.id) === operation)
        previewStarts.delete(project.id);
    })
    .catch(() => {});
  return operation;
}
async function startTrustedPreview() {
  if (!projectTrust.trusted) return;
  await mutationGate.run(() => ensureProjectPreview("orbit"));
}

async function orbitProjectRecord(): Promise<ProjectRecord> {
  const snapshot = await callCore<CoreSnapshot>("snapshot");
  const project = snapshot.tasks.find((task) => task.id === "orbit")?.project;
  if (
    !project ||
    project.canonicalRoot !== projectRoot ||
    project.verification !== "verified" ||
    project.adapter !== "orbit"
  )
    throw new Error(
      "Orbit's folder needs verification before its editor or preview can open.",
    );
  return project;
}

async function assertOrbitDirectoryIdentity() {
  const project = await orbitProjectRecord();
  const inspected = await inspectProjectDirectory(project.canonicalRoot);
  if (
    project.rootIdentity?.device !== inspected.rootIdentity.device ||
    project.rootIdentity?.inode !== inspected.rootIdentity.inode
  )
    throw new Error(
      "Orbit's folder was replaced. Your previous project has not been changed; choose the current folder before continuing.",
    );
}

async function prepareOrbitRegistration(freshReviewedStarter: boolean) {
  try {
    const snapshot = await callCore<CoreSnapshot>("snapshot");
    const task = snapshot.tasks.find((task) => task.id === "orbit");
    if (!task?.project || task.project.canonicalRoot !== projectRoot)
      throw new Error(
        "The saved Orbit folder needs to be located before it can open. Your notes remain available.",
      );
    if (task.project.verification === "legacy-unverified") {
      const inspected = await inspectProjectDirectory(projectRoot);
      const config = parseOrbitConfig(
        (
          await readChecked(path.join(projectRoot, "eve.project.json"), 64_000)
        ).toString("utf8"),
      );
      const checked = await inspectProjectDirectory(projectRoot);
      if (JSON.stringify(inspected) !== JSON.stringify(checked))
        throw new Error(
          "The project folder changed while it was being verified.",
        );
      const result = await callCore<ProjectRegistrationResult>(
        "verify-project",
        {
          requestId: randomUUID(),
          taskId: task.id,
          expectedEpoch: task.epoch,
          expectedTaskRevision: task.revision,
          projectId: task.project.id,
          expectedProjectRevision: task.project.revision,
          rootIdentity: checked.rootIdentity,
          kind: "managed",
          adapter: "orbit",
          preview: { kind: "static", entry: "index.html" },
          parameters: {
            theme: config.theme,
            durationMinutes: config.durationMinutes,
            transitionMs: config.transitionMs,
            easing: config.easing,
          },
        },
      );
      if (!result.ok) throw new Error(result.error.message);
    }
    const project = await orbitProjectRecord();
    const trust = await inspectProjectExecutionTrust(
      app.getPath("userData"),
      project,
    );
    // Only the starter copied from this reviewed application during this launch
    // inherits its execution approval. Existing/imported/restored files do not.
    if (freshReviewedStarter && !projectTrust.restored)
      await approveProjectExecution(
        app.getPath("userData"),
        project,
        trust.review,
      );
    projectTrust.trusted = (
      await inspectProjectExecutionTrust(app.getPath("userData"), project)
    ).trusted;
  } catch (error) {
    projectTrust.trusted = false;
    startupAlerts.push(
      error instanceof Error
        ? error.message
        : "The project needs review before opening.",
    );
  }
}

async function requireProjectTrust() {
  await requireTaskProjectTrust("orbit");
}
async function reviewProject(
  taskId: string,
): Promise<{ trusted: boolean; message?: string; focusLeaseId?: string }> {
  if (trustReviewInProgress || maintenance || exiting || exitInputHeld)
    return {
      trusted: false,
      message: "Finish the current workspace operation first.",
    };
  trustReviewInProgress = true;
  let focusGesture = editorFocus.capture(win.isFocused());
  try {
    const restored = await inspectRestoredProjectTrust(app.getPath("userData"));
    if (projectTrust.restored && !restored.restored)
      throw new Error(
        "Eve could not verify how this workspace was restored. Its projects remain paused.",
      );
    let { task, project } = await taskProject(taskId);
    if (project.verification !== "verified") {
      const captured = project;
      const result = await enqueueMutation(async () => {
        const current = await taskProject(taskId, captured);
        const inspected = await inspectProjectDirectory(
          current.project.canonicalRoot,
        );
        const config =
          current.project.adapter === "orbit"
            ? (await readOrbitConfig(current.project.canonicalRoot)).config
            : undefined;
        const checked = await inspectProjectDirectory(
          current.project.canonicalRoot,
        );
        if (JSON.stringify(checked) !== JSON.stringify(inspected))
          throw new Error("The project folder changed during inspection.");
        const result = await callCore<ProjectRegistrationResult>(
          "verify-project",
          {
            requestId: randomUUID(),
            taskId,
            expectedEpoch: current.task.epoch,
            expectedTaskRevision: current.task.revision,
            projectId: current.project.id,
            expectedProjectRevision: current.project.revision,
            rootIdentity: checked.rootIdentity,
            kind: current.project.kind ?? "external",
            adapter: current.project.adapter,
            preview: current.project.preview,
            ...(config
              ? {
                  parameters: {
                    theme: config.theme,
                    durationMinutes: config.durationMinutes,
                    transitionMs: config.transitionMs,
                    easing: config.easing,
                  },
                }
              : {}),
          },
        );
        if (!result.ok) throw new Error(result.error.message);
        win.webContents.send("eve:snapshot-changed", result.snapshot);
        syncIntentCanonical(result.snapshot);
        return result;
      });
      project = result.project;
      task = result.snapshot.tasks.find((item) => item.id === taskId)!;
    }
    const scoped = await inspectProjectExecutionTrust(
      app.getPath("userData"),
      project,
    );
    if (!scoped.trusted) {
      const isLegacyMenu = taskId === "orbit" && restored.restored;
      const choice = await dialog.showMessageBox(win, {
        type: "question",
        message: isLegacyMenu
          ? "Open the restored projects?"
          : `Open ${task.title}'s project?`,
        detail: `Folder: ${project.canonicalRoot}\n\nOpening this project's editor or preview can run code from this folder. Approve it only if you know where its files came from. Your notes remain available while it is paused. This decision applies to this project only.`,
        buttons: isLegacyMenu
          ? ["Trust and open projects", "Keep projects paused"]
          : ["Trust and open project", "Keep project paused"],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response !== 0)
        return {
          trusted: false,
          message: "The project remains paused; your notes are available.",
        };
      editorFocus.input("review", taskId);
      focusGesture = editorFocus.capture(true);
      if (maintenance || exiting || exitInputHeld)
        throw new Error(
          "Another operation started. Wait for it to finish, then review this project again.",
        );
      await enqueueMutation(async () => {
        const current = await taskProject(taskId, project);
        await approveProjectExecution(
          app.getPath("userData"),
          current.project,
          scoped.review,
        );
        // Legacy receipt metadata is retained for compatibility, but grants no project authority.
        if (restored.restored && taskId === "orbit")
          await approveRestoredProjects(
            app.getPath("userData"),
            restored.receiptHash!,
          );
      });
    }
    await requireTaskProjectTrust(taskId, project);
    if (taskId === "orbit")
      projectTrust = {
        ...restored,
        trusted: true,
        receiptHash: restored.receiptHash,
      };
    const focusLeaseId = editorFocus.issue(
      { taskId, projectId: project.id, projectRevision: project.revision },
      focusGesture,
      win.isFocused(),
    );
    return { trusted: true, ...(focusLeaseId ? { focusLeaseId } : {}) };
  } finally {
    trustReviewInProgress = false;
  }
}
async function reviewRestoredProjects() {
  try {
    if ((await reviewProject("orbit")).trusted) await startTrustedPreview();
  } catch (error) {
    win.webContents.send(
      "eve:host-error",
      error instanceof Error
        ? error.message
        : "The project trust could not be confirmed.",
    );
  }
}

function installHandlers() {
  ipcMain.handle("eve:system-status", async (event) => {
    trusted(event);
    if (process.platform !== "linux")
      return {
        available: false,
        audio: { available: false },
        network: { available: false, active: [] },
        session: false,
      };
    return {
      available: true,
      ...(await system.status()),
      session: sessionMode && sessionReady,
    };
  });
  ipcMain.handle("eve:saved-networks", (event) => {
    trusted(event);
    return system.savedNetworks();
  });
  ipcMain.handle("eve:system-action", async (event, input) => {
    trusted(event);
    const action = systemActionSchema.parse(input);
    if (action.type === "volume") await system.setVolume(action.percent);
    else if (action.type === "mute") await system.setMuted(action.muted);
    else if (action.type === "connect")
      await system.connectSavedNetwork(action.uuid);
    else if (action.type === "lock") await system.lock();
    else if (action.type === "settings")
      await system.openSettings(action.panel);
    else {
      if (!sessionMode || !sessionReady)
        return {
          performed: false,
          reason:
            "Use the desktop session controls after saving your work. Eve session protection is not active.",
        };
      try {
        const result = await system.exit(action.action);
        if (!result.performed) await preparedExitRelease?.();
        return result;
      } catch (error) {
        await preparedExitRelease?.();
        throw error;
      }
    }
    return { performed: true };
  });
  ipcMain.handle("eve:ask", async (event, input) => {
    trusted(event);
    const gesture = editorFocus.capture(win.isFocused());
    if (maintenance)
      throw new Error("Your workspace is paused while its backup finishes.");
    if (!input || typeof input.taskId !== "string")
      throw new Error("Open the space you want to ask about.");
    const state = await callCore<CoreSnapshot>("snapshot");
    if (state.activeTaskId !== input.taskId)
      throw new Error("The open space changed. Ask again from this space.");
    const result = intents.ask(input);
    if (gesture) intentFocus.set(result.requestId, gesture);
    return result;
  });
  ipcMain.handle("eve:cancel-intent", (event, requestId) => {
    trusted(event);
    if (typeof requestId !== "string" || requestId.length > 128)
      throw new Error("Choose a request from this space.");
    intents.cancel(requestId);
    intentFocus.delete(requestId);
  });
  ipcMain.handle("eve:apply-proposal", (event, input) => {
    trusted(event);
    return intents.applyProposal(input);
  });
  ipcMain.handle("eve:discard-proposal", (event, input) => {
    trusted(event);
    return intents.discardProposal(input);
  });
  ipcMain.handle("eve:open-intent-source", (event, input) => {
    trusted(event);
    return intents.openSource(input);
  });
  ipcMain.handle("eve:intelligence-settings", (event) => {
    trusted(event);
    return intelligence.publicSettings();
  });
  ipcMain.handle("eve:source-context", async (event, taskId, sourceId) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot");
    if (
      typeof taskId !== "string" ||
      taskId !== state.activeTaskId ||
      (sourceId !== null &&
        (typeof sourceId !== "string" || sourceId.length > 128))
    )
      throw new Error("Choose a source from this space.");
    if (
      sourceId !== null &&
      !(await media.list(taskId)).some((source) => source.id === sourceId)
    )
      throw new Error("This source is not attached to this space.");
    if ((selectedSources.get(taskId) ?? null) !== sourceId) {
      sourceId === null
        ? selectedSources.delete(taskId)
        : selectedSources.set(taskId, sourceId);
      intents.invalidateTask(taskId);
    }
  });
  ipcMain.handle("eve:lesson", (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string" || taskId.length > 128)
      throw new Error("Open a space first.");
    return media.status(taskId);
  });
  ipcMain.handle("eve:attach-source", async (event, taskId, url, title) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot");
    if (
      taskId !== state.activeTaskId ||
      typeof url !== "string" ||
      typeof title !== "string"
    )
      throw new Error("Choose a source for this space.");
    return enqueueMutation(() => media.attach(taskId, url, title));
  });
  ipcMain.handle("eve:open-source", async (event, taskId, sourceId) => {
    trusted(event);
    if (typeof taskId !== "string" || typeof sourceId !== "string")
      throw new Error("Choose a saved source.");
    await openSavedSource(taskId, sourceId);
  });
  ipcMain.handle("eve:read-source", async (event, taskId, sourceId) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot");
    if (typeof taskId !== "string" || taskId !== state.activeTaskId || typeof sourceId !== "string" || sourceId.length > 128)
      throw new Error("Choose an article from this space.");
    return media.read(taskId, sourceId);
  });
  ipcMain.handle("eve:search-sources", async (event, taskId, query) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot");
    if (taskId !== state.activeTaskId || typeof query !== "string" || !query.trim() || query.length > 300)
      throw new Error("Search for a source from this space.");
    return media.search(query);
  });
  ipcMain.handle("eve:video-search", async (event, taskId, query) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot");
    if (taskId !== state.activeTaskId || typeof query !== "string" || !query.trim() || query.length > 300)
      throw new Error("Search for a video from this space.");
    await shell.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}`);
  });
  ipcMain.handle("eve:asset-text", (event, taskId, assetId) => {
    trusted(event);
    if (
      typeof taskId !== "string" ||
      typeof assetId !== "string" ||
      taskId.length > 128 ||
      assetId.length > 128
    )
      throw new Error("Choose saved material.");
    return assets.text(taskId, assetId);
  });
  ipcMain.handle("eve:assets", async (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string" || taskId.length > 128)
      throw new Error("Open a space first.");
    return assets.list(taskId);
  });
  ipcMain.handle("eve:import-assets", async (event, taskId) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot");
    if (typeof taskId !== "string" || state.activeTaskId !== taskId)
      throw new Error("The open space changed. Choose where to add your material.");
    const selected = await dialog.showOpenDialog(win, {
      title: "Add material to this space",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Notes and images",
          extensions: ["txt", "md", "markdown", "png", "jpg", "jpeg", "webp"],
        },
      ],
    });
    const errors: string[] = [];
    for (const file of selected.canceled ? [] : selected.filePaths) {
      try {
        await enqueueMutation(() => assets.import(taskId, file));
      } catch (error) {
        errors.push(
          `${path.basename(file)}: ${error instanceof Error ? error.message : "Could not import this file."}`,
        );
      }
    }
    return { assets: await assets.list(taskId), errors };
  });
  ipcMain.handle("eve:attach-canvas-image", (event, input) => {
    trusted(event);
    return canvasImageAttachments.attach(input);
  });
  ipcMain.handle("eve:cancel-canvas-image-attachment", (event, input) => {
    trusted(event);
    canvasImageAttachments.cancel(input);
  });
  ipcMain.handle("eve:set-overlay", async (event, payload) => {
    trusted(event);
    if (maintenance || exitInputHeld) return;
    if (payload?.kind === "maintenance")
      throw new Error("This panel cannot be opened here.");
    const nextId = payload?.instanceId;
    const opening = nextId && nextId !== activeOverlayId;
    if (opening) editorFocus.invalidate();
    activeOverlayId = nextId;
    await overlayRequests.publishAfter(
      async () => {
        if (opening && visibleSurface?.kind === "video")
          await enqueueMutation(() => rememberEditorPlace());
      },
      async () => {
        if (maintenance || exitInputHeld || exiting) return;
        await overlays.setState(payload);
        // Official player branding and controls must never sit underneath Eve panels.
        // Keep the native page alive and return to its acknowledged paused position.
        if (visibleSurface && !maintenance && !exitInputHeld)
          surfaces
            .get(visibleSurface.key)
            ?.setVisible(visibleSurface.kind !== "video" || !activeOverlayId);
      },
      (error) => {
        win.webContents.send(
          "eve:host-error",
          error instanceof Error
            ? error.message
            : "The current video moment could not be captured.",
        );
      },
    );
  });
  ipcMain.handle("eve:snapshot", async (event) => {
    trusted(event);
    const snapshot = await callCore("snapshot");
    for (const message of startupAlerts.splice(0))
      win.webContents.send("eve:host-error", message);
    return snapshot;
  });
  ipcMain.handle("eve:search", (event, query) => {
    trusted(event);
    if (typeof query !== "string" || query.length > 500)
      throw new Error("Invalid search");
    return callCore("search", query);
  });
  ipcMain.handle("eve:status", (event) => {
    trusted(event);
    return status;
  });
  ipcMain.handle("eve:begin-editor-navigation", async (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string" || taskId.length > 128)
      throw new Error("Choose the space for this editor.");
    const gesture = editorFocus.capture(win.isFocused());
    if (!gesture || maintenance || exitInputHeld || exiting) return null;
    const { project } = await taskProject(taskId);
    if (maintenance || exitInputHeld || exiting) return null;
    return editorFocus.issue(
      { taskId, projectId: project.id, projectRevision: project.revision },
      gesture,
      win.isFocused(),
    );
  });
  ipcMain.handle("eve:dispatch", (event, payload) => {
    trusted(event);
    return enqueueMutation(() => dispatch(payload));
  });
  ipcMain.handle("eve:hide-surfaces", async (event) => {
    trusted(event);
    if (maintenance) {
      hideSurfaces();
      return;
    }
    const previous = visibleSurface;
    hideSurfaces();
    if (previous?.kind === "video")
      await enqueueMutation(() => rememberEditorPlace());
  });
  ipcMain.handle("eve:preview-draft", async (event, taskId, values) => {
    trusted(event);
    if (typeof taskId !== "string")
      throw new Error("Choose the space for this preview.");
    if (maintenance || exitInputHeld || exiting)
      throw new Error("Wait for the current operation to finish, then try again.");
    const state = await callCore<CoreSnapshot>("snapshot"),
      task = state.tasks.find((task) => task.id === taskId);
    if (state.activeTaskId !== taskId) return;
    if (!task?.project || task.project.adapter !== "orbit")
      throw new Error("This space has no Orbit preview controls.");
    const target = previewForProject(task.project.id);
    if (!target || !("updateDraft" in target)) return;
    if (values === null) {
      target.clearDraft();
      return;
    }
    const parameters = orbitParametersSchema.parse(values);
    const current = await brokerFor(task)!.current();
    const fresh = await callCore<CoreSnapshot>("snapshot");
    if (
      fresh.activeTaskId !== taskId ||
      fresh.tasks.find((item) => item.id === taskId)?.epoch !== task.epoch ||
      maintenance ||
      exitInputHeld
    )
      return;
    target.updateDraft(
      { ...current.config, ...parameters },
      `desktop-inspector:${task.project.id}`,
      ++previewSequence,
    );
  });
  ipcMain.handle("eve:open-project", async (event) => {
    trusted(event);
    const state = await callCore<CoreSnapshot>("snapshot"),
      task = state.tasks.find((task) => task.id === state.activeTaskId);
    if (!task?.project) throw new Error("This space has no attached project.");
    const inspected = await inspectProjectDirectory(task.project.canonicalRoot);
    if (
      task.project.rootIdentity &&
      JSON.stringify(inspected.rootIdentity) !==
        JSON.stringify(task.project.rootIdentity)
    )
      throw new Error("The project folder changed. Review it before opening.");
    const error = await shell.openPath(inspected.canonicalRoot);
    if (error) throw new Error(error);
  });
  ipcMain.handle("eve:choose-project", async (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string" || maintenance || exitInputHeld || exiting)
      throw new Error(
        "Finish the current operation before choosing a project.",
      );
    return projects.chooseExisting(taskId);
  });
  ipcMain.handle("eve:register-project", async (event, input) => {
    trusted(event);
    return projects.register(input);
  });
  ipcMain.handle(
    "eve:dismiss-project-selection",
    async (event, selectionId) => {
      trusted(event);
      if (typeof selectionId !== "string")
        throw new Error("Invalid project selection.");
      projects.dismiss(selectionId);
    },
  );
  ipcMain.handle("eve:review-project", async (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string") throw new Error("Invalid space.");
    const state = await callCore<CoreSnapshot>("snapshot");
    if (state.activeTaskId !== taskId)
      throw new Error("Choose the space you want to review.");
    return reviewProject(taskId);
  });
  ipcMain.handle("eve:close-project", async (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string") throw new Error("Invalid space.");
    return closeProjectViews(taskId);
  });
  ipcMain.handle("eve:reload-preview", async (event, taskId) => {
    trusted(event);
    if (typeof taskId !== "string" || maintenance || exitInputHeld || exiting)
      throw new Error(
        "Finish the current workspace operation before reloading the preview.",
      );
    return mutationGate.run(async () => {
      const snapshot = await callCore<CoreSnapshot>("snapshot");
      if (snapshot.activeTaskId !== taskId)
        throw new Error("Choose the space whose preview you want to reload.");
      const { project } = await requireTaskProjectTrust(taskId);
      if (project.adapter !== "generic")
        throw new Error(
          "Orbit updates through its project controls; its running timer was preserved.",
        );
      const key = `preview:${project.id}`,
        view = surfaces.get(key),
        target = projectPreviews.get(project.id);
      if (!view || !target?.url)
        return {
          reloaded: false,
          message: "Open this project's preview before reloading it.",
        };
      const contents = view.webContents;
      const loaded = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          contents.off("did-finish-load", ready);
          contents.off("did-fail-load", failed);
          contents.off("destroyed", destroyed);
          error ? reject(error) : resolve();
        };
        const ready = () => finish();
        const failed = (
          _event: Electron.Event,
          code: number,
          description: string,
          _url: string,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame)
            finish(
              new Error(`Preview reload failed (${code}): ${description}`),
            );
        };
        const destroyed = () =>
          finish(new Error("The preview closed before reload completed."));
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                "The preview has not finished reloading. Its project and editor remain open.",
              ),
            ),
          30000,
        );
        contents.once("did-finish-load", ready);
        contents.on("did-fail-load", failed);
        contents.once("destroyed", destroyed);
        contents.reloadIgnoringCache();
      });
      surfaceLoads.set(key, loaded);
      await loaded;
      return { reloaded: true };
    });
  });
  ipcMain.handle("eve:surface", async (event, request: SurfaceRequest) => {
    trusted(event);
    if (
      !request ||
      !["preview", "workbench", "video"].includes(request.kind) ||
      typeof request.taskId !== "string" ||
      typeof request.visible !== "boolean" ||
      (request.focusLeaseId !== undefined &&
        (typeof request.focusLeaseId !== "string" ||
          request.focusLeaseId.length > 128))
    )
      throw new Error("Unknown activity");
    const bounds = request.bounds;
    if (
      !bounds ||
      [bounds.x, bounds.y, bounds.width, bounds.height].some(
        (value) => !Number.isFinite(value) || value < 0 || value > 10000,
      )
    )
      throw new Error("This activity could not fit in the window. Resize the window and try again.");
    const snapshot = await callCore<CoreSnapshot>("snapshot"),
      task = snapshot.tasks.find((task) => task.id === request.taskId);
    const project = task?.project;
    const key =
      request.kind === "video"
        ? "video"
        : project
          ? `${request.kind}:${project.id}`
          : undefined;
    if (!key || snapshot.activeTaskId !== request.taskId)
      return { ready: false, message: "Choose the space for this activity." };
    const focusClaim =
      request.kind === "workbench" && request.visible && project
        ? editorFocus.claim(request.focusLeaseId, {
            taskId: request.taskId,
            projectId: project.id,
            projectRevision: project.revision,
          })
        : null;
    const position = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    if (maintenance || exitInputHeld || exiting) {
      surfaceGeneration++;
      surfaces.get(key)?.setBounds(position);
      return {
        ready: false,
        message: "Your workspace will resume after this operation.",
      };
    }
    const previous = visibleSurface,
      generation = ++surfaceGeneration;
    const focusOwner = request.visible
      ? surfaceFocus.enter(key, request.taskId)
      : undefined;
    if (!request.visible) surfaceFocus.clear();
    const interrupted = () =>
      generation !== surfaceGeneration ||
      !!maintenance ||
      exitInputHeld ||
      exiting;
    const retrySurface = {
      ready: false,
      message: "Your activity is waiting for the workspace to resume.",
    };
    // A scrolled-away native view must stop covering the shell immediately;
    // checkpoint acknowledgement may take longer than the next painted frame.
    if (!request.visible)
      for (const surface of surfaces.values()) surface.setVisible(false);
    if (
      previous?.kind === "video" &&
      (!request.visible ||
        request.kind !== "video" ||
        request.taskId !== previous.taskId ||
        request.sourceId !== previous.sourceId)
    )
      await enqueueMutation(() => rememberEditorPlace());
    if (interrupted()) return retrySurface;
    for (const [ownedKey, surface] of surfaces)
      if (!request.visible || ownedKey !== key) surface.setVisible(false);
    if (
      !request.visible ||
      visibleSurface?.key !== key ||
      visibleSurface?.taskId !== request.taskId
    )
      visibleSurface = undefined;
    if (!request.visible) return { ready: true };
    let targetUrl: string, editor: WorkbenchService | undefined;
    try {
      if (request.kind === "video")
        targetUrl = (await media.open(request.taskId, request.sourceId)).url;
      else {
        await requireTaskProjectTrust(request.taskId, project!);
        if (request.kind === "workbench") {
          editor = await mutationGate.run(() =>
            ensureWorkbench(request.taskId),
          );
          targetUrl = editor.url;
        } else {
          const target = await mutationGate.run(() =>
            ensureProjectPreview(request.taskId),
          );
          if (!target.url)
            return {
              ready: false,
              message:
                "This project has no preview set up. You can open its code or notes.",
            };
          targetUrl = target.url;
        }
      }
    } catch (error) {
      if (request.kind === "preview" && !interrupted())
        status.preview = "error";
      return {
        ready: false,
        message:
          error instanceof Error
            ? error.message
            : "This activity could not open. Your files and notes are safe.",
      };
    }
    if (interrupted()) return retrySurface;
    let view = surfaces.get(key);
    if (
      request.kind === "video" &&
      view &&
      view.webContents.getURL() !== targetUrl
    ) {
      win.contentView.removeChildView(view);
      view.webContents.close();
      surfaces.delete(key);
      surfaceLoads.delete(key);
      view = undefined;
    }
    if (!view) {
      const partition = `eve-${request.kind}-${project?.id ?? "media"}-${randomUUID()}`;
      const isolated = session.fromPartition(partition);
      configureSession(isolated);
      if (editor) await editor.authenticate(isolated);
      if (interrupted()) return retrySurface;
      view = new WebContentsView({
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      view.setVisible(false);
      secureContents(view.webContents, new URL(targetUrl).origin);
      const ownedView = view;
      let focusCorrection: NodeJS.Immediate | undefined;
      ownedView.webContents.on("focus", () => {
        // Chromium may focus its page while completing an asynchronous load,
        // including a view hidden by navigation. On Linux, changing focus from
        // inside this native event is overwritten when the event completes.
        // Recheck ownership on the next turn so intervening real input wins.
        clearImmediate(focusCorrection);
        focusCorrection = setImmediate(() => {
          focusCorrection = undefined;
          if (
            ownedView.webContents.isDestroyed() ||
            (ownedView.getVisible() && visibleSurface?.key === key) ||
            webContents.getFocusedWebContents() !== ownedView.webContents ||
            !win.isFocused()
          )
            return;
          if (activeOverlayId && overlays.focusActive()) return;
          const active = visibleSurface && surfaces.get(visibleSurface.key);
          if (active?.getVisible() && !active.webContents.isDestroyed())
            active.webContents.focus();
          else win.webContents.focus();
        });
      });
      ownedView.webContents.once("destroyed", () =>
        clearImmediate(focusCorrection),
      );
      if (request.kind === "video") {
        const contentsId = view.webContents.id,
          referer = media.player!.referer;
        isolated.webRequest.onBeforeSendHeaders((details, callback) => {
          if (
            details.webContentsId === contentsId &&
            isOfficialPlayerRequest(details.url)
          ) {
            const headers = { ...details.requestHeaders };
            for (const name of Object.keys(headers))
              if (name.toLowerCase() === "referer") delete headers[name];
            headers.Referer = referer;
            callback({ requestHeaders: headers });
          } else callback({ requestHeaders: details.requestHeaders });
        });
      }
      view.setBackgroundColor(
        request.kind === "preview" ? "#f2f5ee" : "#fbfbf8",
      );
      win.contentView.addChildView(view);
      surfaces.set(key, view);
      view.setBounds(position);
      surfaceLoads.set(key, view.webContents.loadURL(targetUrl));
    }
    await surfaceLoads.get(key);
    const current = await callCore<CoreSnapshot>("snapshot");
    if (interrupted() || current.activeTaskId !== request.taskId)
      return retrySurface;
    if (project) await requireTaskProjectTrust(request.taskId, project);
    if (interrupted()) return retrySurface;
    view.setBounds(position);
    view.setVisible(request.kind !== "video" || !activeOverlayId);
    visibleSurface = {
      kind: request.kind,
      key,
      taskId: request.taskId,
      sourceId: request.sourceId,
    };
    overlays.raise();
    if (editor) {
      const owned = workbenches.get(project!.id)!.value;
      const restoration = activateWorkbenchRecovery(owned);
      if (focusClaim && focusOwner)
        void focusReadyEditor(owned, view, focusClaim, focusOwner, restoration);
      else void restoration;
    }
    return { ready: true };
  });
  ipcMain.on("eve:ready-to-close", (event) => {
    trusted(event);
    if (rendererSettlement) {
      const pending = rendererSettlement;
      rendererSettlement = undefined;
      clearTimeout(pending.timer);
      pending.resolve(!rendererState.dirty && !rendererState.busy);
      return;
    }
    void approveClose();
  });
  ipcMain.on("eve:close-cancelled", (event) => {
    trusted(event);
    if (rendererSettlement) {
      const pending = rendererSettlement;
      rendererSettlement = undefined;
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
  });
  ipcMain.on("eve:renderer-state", (event, value) => {
    trusted(event);
    if (
      !value ||
      typeof value.dirty !== "boolean" ||
      typeof value.busy !== "boolean"
    )
      return;
    if (value.dirty && !rendererState.dirty) intents?.invalidateForUserEdit();
    rendererState = { dirty: value.dirty, busy: value.busy };
    updateSessionDirty();
  });
}

if (hasLock)
  app
    .whenReady()
    .then(async () => {
      await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
      const profileInfo = await lstat(app.getPath("userData"));
      if (
        !profileInfo.isDirectory() ||
        profileInfo.isSymbolicLink() ||
        (process.getuid && profileInfo.uid !== process.getuid())
      )
        throw new Error(
          "Eve needs a private workspace directory owned by this user.",
        );
      await chmod(app.getPath("userData"), 0o700);
      if (configurationMode) {
        let data = "";
        for await (const chunk of process.stdin) {
          data += chunk.toString();
          if (Buffer.byteLength(data) > 32768)
            throw new Error("Provider configuration exceeds its size limit.");
        }
        let input: unknown;
        try {
          input = JSON.parse(data);
        } catch {
          throw new Error("INVALID_PROVIDER_INPUT");
        }
        const parsed = configureProviderSchema.safeParse(input);
        if (!parsed.success || parsed.data.storage !== "secure")
          throw new Error(
            "Setup requires a valid provider configuration and secure storage.",
          );
        const setup = new IntelligenceController({
          profilePath: app.getPath("userData"),
          workerPath: path.join(__dirname, "model.cjs"),
        });
        try {
          await setup.initialize();
          await setup.configure(parsed.data);
        } finally {
          await setup.dispose();
        }
        data = "";
        console.log(
          "Provider configuration saved with operating-system encryption.",
        );
        app.exit(0);
        return;
      }
      projectRoot = path.join(app.getPath("userData"), "workspaces/orbit");
      try {
        const inspected = await inspectRestoredProjectTrust(
          app.getPath("userData"),
        );
        projectTrust = { ...inspected, receiptHash: inspected.receiptHash };
      } catch (error) {
        projectTrust = {
          restored: true,
          trusted: false,
          receiptHash: undefined,
        };
        startupAlerts.push(
          error instanceof Error
            ? error.message
            : "Restored projects need review before they can open.",
        );
      }
      let freshReviewedStarter = false;
      try {
        await access(path.join(projectRoot, "eve.project.json"));
      } catch {
        if (projectTrust.restored)
          startupAlerts.push(
            "The restored Orbit configuration is missing. Its files were preserved; add or repair the project before opening its preview.",
          );
        else if (
          !(await lstat(projectRoot).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }))
        ) {
          await mkdir(path.dirname(projectRoot), { recursive: true });
          await cp(path.join(root, "examples/orbit"), projectRoot, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          freshReviewedStarter = true;
        } else
          startupAlerts.push(
            "The Orbit configuration is missing. Your existing folder was preserved; repair its configuration before opening the project.",
          );
      }
      configureSession(session.defaultSession);
      protocol.handle("eve", (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "app")
          return new Response("Not found", { status: 404 });
        const relative = decodeURIComponent(
          url.pathname === "/" ? "/index.html" : url.pathname,
        );
        const file = path.resolve(root, "dist/renderer", "." + relative);
        if (!file.startsWith(path.join(root, "dist/renderer") + path.sep))
          return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
      });
      await startCore();
      await prepareOrbitRegistration(freshReviewedStarter);
      media = new TaskMedia(callCore);
      if (!projectTrust.restored) await media.seed();
      assets = await TaskAssets.open(
        path.join(app.getPath("userData"), "storage"),
        callCore,
      );
      canvasImageAttachments = new CanvasImageAttachments({
        snapshot: () => callCore<CoreSnapshot>("snapshot"),
        records: taskId => assets.records(taskId),
        importImage: (taskId, file) => {
          if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(file).toLowerCase())) throw new Error("Choose a PNG, JPEG or WebP image.");
          return assets.import(taskId, file);
        },
        chooseImage: async () => {
          const result = await dialog.showOpenDialog(win, {
            title: "Choose an image for this canvas", properties: ["openFile"],
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
          });
          return result.canceled ? null : result.filePaths[0] ?? null;
        },
        mutate: enqueueMutation, dispatch,
        preflight: command => callCore<PreflightResult>("preflight", command),
        available: () => !maintenance && !exitInputHeld && !exiting,
      });
      protocol.handle("eve-asset", (request) => assets.serve(request.url));
      if (
        !projectTrust.restored &&
        !(await assets.records("photo-walk")).length
      ) {
        await assets.import(
          "photo-walk",
          path.join(root, "apps/desktop/renderer/public/assets/photo-walk.png"),
          "Original artwork generated for Eve. Attribution is recorded in docs/CREDITS.md.",
          "Morning by the river",
        );
      }
      const initialProjects = await callCore<CoreSnapshot>("snapshot");
      const initialOrbit = initialProjects.tasks.find(
        (task) => task.id === "orbit",
      );
      projectEdits = initialOrbit
        ? brokerFor(initialOrbit)!
        : new ProjectEdits(
            callCore,
            projectRoot,
            () => null,
            () => true,
            assertOrbitDirectoryIdentity,
          );
      projects = new HostProjects({
        core: callCore,
        pickDirectory: async () => {
          const result = await dialog.showOpenDialog(win, {
            title: "Choose a project folder",
            buttonLabel: "Review folder",
            properties: ["openDirectory"],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        mutate: enqueueMutation,
        publish: (snapshot) => {
          win.webContents.send("eve:snapshot-changed", snapshot);
          syncIntentCanonical(snapshot);
          updateKnownRecoveryNamespaces(snapshot);
        },
      });
      intelligence = new IntelligenceController({
        profilePath: app.getPath("userData"),
        workerPath: path.join(__dirname, "model.cjs"),
        onEvent: (event) => {
          intents?.handleIntelligenceEvent(event);
          if (event.type === "status")
            publishIntelligenceSettings(event.settings);
        },
      });
      workspaceEdits = new WorkspaceEdits({
        core: callCore,
        editor: (plan) => workspaceRuntime.editor(plan),
        assertReview: (plan, review) =>
          intents.assertWorkspaceReview(plan, review),
      });
      intents = new IntentService({
        intelligence,
        captureContext: captureIntentContext,
        applyWorkspace: (plan, review) =>
          enqueueMutation(async () => {
            try {
              return await workspaceEdits.apply(plan, review);
            } finally {
              await publishWorkspaceJournal();
            }
          }),
        settleWorkspace: (requestId) =>
          enqueueMutation(async () => {
            try {
              return await workspaceEdits.settleOnly(requestId);
            } finally {
              await publishWorkspaceJournal();
            }
          }),
        dispatch: (command) => enqueueMutation(() => dispatch(command)),
        executeRegistered,
        discoverSources,
        attachSource: async ({ taskId, url, title }) => {
          const source = await enqueueMutation(() => media.attachOne(taskId, url, title));
          return { sourceId: source.id };
        },
        openSource: (context) =>
          showSavedSource(context.taskId, context.sourceId),
        onEvent: (event) => {
          if (!["pending", "running"].includes(event.response.status))
            intentFocus.delete(event.response.requestId);
          if (win && !win.isDestroyed())
            win.webContents.send("eve:intelligence", event);
        },
      });
      void intelligence.initialize().catch(() => {
        const message =
          "Assistance could not start. Your workspace and direct controls are still available.";
        if (win && !win.isDestroyed())
          win.webContents.send("eve:host-error", message);
        else startupAlerts.push(message);
      });
      await projectEdits
        ?.recover()
        .catch((error) =>
          startupAlerts.push(
            error instanceof Error
              ? error.message
              : "An interrupted project change needs review.",
          ),
        );
      await syncProject().catch((error) =>
        startupAlerts.push(
          error instanceof Error
            ? error.message
            : "Your project configuration needs review.",
        ),
      );
      win = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1024,
        minHeight: 700,
        title: "Eve",
        backgroundColor: "#fbfbf8",
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 18, y: 22 },
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Eve",
            submenu: [
              { role: "about" },
              { label: "Export workspace backup…", click: beginProfileExport },
              {
                label: "Restore backup into new workspace…",
                click: beginProfileRestore,
              },
              {
                label: "Recover editor drafts…",
                click: () => {
                  void requestWorkbenchRecovery();
                },
              },
              ...(projectTrust.restored || !projectTrust.trusted
                ? [
                    {
                      label: projectTrust.restored
                        ? "Review restored projects…"
                        : "Review project…",
                      click: () => {
                        void reviewRestoredProjects();
                      },
                    },
                  ]
                : []),
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "View",
            submenu: [
              {
                label: "Home",
                accelerator: "CommandOrControl+Shift+H",
                click: () => win.webContents.send("eve:home"),
              },
              {
                label: "Find anything",
                accelerator:
                  process.platform === "darwin"
                    ? "Command+Alt+K"
                    : "Control+Alt+K",
                click: () => win.webContents.send("eve:recall"),
              },
              { role: "togglefullscreen" },
              { role: "toggleDevTools" },
            ],
          },
        ]),
      );
      overlays = new OverlayHost({
        window: win,
        preload: path.join(__dirname, "overlay-preload.cjs"),
        url: (process.env.EVE_DEV_URL ?? "eve://app/index.html") + "#overlay",
        onUserInput: () => editorFocus.input("overlay"),
        onAction: (action) => {
          if (action.type === "maintenance-ready") {
            if (maintenance?.state.instanceId === action.instanceId) {
              maintenance.ready = true;
              maintenance.acknowledge();
            }
          } else if (action.type === "maintenance-cancel") {
            if (maintenance?.state.instanceId === action.instanceId)
              backupCancellation?.abort();
          } else win.webContents.send("eve:overlay-action", action);
        },
        onError: (message) => {
          backupCancellation?.abort();
          win.webContents.send("eve:host-error", message);
        },
        search: async (query) =>
          (await callCore<Array<{ taskId: string }>>("search", query)).map(
            (item) => item.taskId,
          ),
        canRestore: async (contents, taskId) => {
          const state = await callCore<CoreSnapshot>("snapshot");
          return (
            state.activeTaskId === taskId &&
            (contents === win.webContents ||
              (visibleSurface?.taskId === taskId &&
                surfaces.get(visibleSurface.key)?.webContents === contents))
          );
        },
      });
      installHandlers();
      secureContents(win.webContents, process.env.EVE_DEV_URL ?? "eve://app");
      win.on("blur", () => editorFocus.invalidate());
      win.webContents.on("render-process-gone", () => {
        if (!exiting) void recovery("The display stopped unexpectedly.");
      });
      win.on("close", (event) => {
        if (!closeApproved) {
          event.preventDefault();
          if (profileBackup) {
            backupCancellation?.abort();
            void profileBackup
              .catch(() => undefined)
              .then(() => {
                if (!win.isDestroyed())
                  win.webContents.send("eve:prepare-close");
              });
          } else win.webContents.send("eve:prepare-close");
        }
      });
      win.on("closed", () => {
        overlays.close();
        for (const view of surfaces.values()) view.webContents.close();
        surfaces.clear();
      });
      win.once("ready-to-show", () => win.show());
      await win.loadURL(process.env.EVE_DEV_URL ?? "eve://app/index.html");
      // Electron supplies lock-screen on macOS/Windows. Linux lock state comes
      // from the qualified GNOME bridge; suspend is available on all platforms.
      powerMonitor.on("lock-screen", handlePrivacyBoundary);
      powerMonitor.on("suspend", handlePrivacyBoundary);
      win.once("closed", () => {
        powerMonitor.off("lock-screen", handlePrivacyBoundary);
        powerMonitor.off("suspend", handlePrivacyBoundary);
      });
      startSessionIntegration();
      // Project servers and native views are admitted lazily by the active
      // space's surface request. Merely having Orbit in storage starts neither.
    })
    .catch((error) => {
      if (configurationMode) {
        console.error(
          error instanceof CredentialError
            ? error.message
            : "Provider setup failed. Check the configuration and secure storage, then retry.",
        );
        app.exit(1);
        return;
      }
      console.error(error);
      void recovery("Eve could not open your workspace.");
    });
app.on("second-instance", (_event, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (argv.includes("--recall")) win.webContents.send("eve:recall");
  }
});
app.on("before-quit", () => {
  if (closeApproved) {
    exiting = true;
    for (const preview of projectPreviews.values()) void preview.close();
    for (const entry of workbenches.entries()) void entry.value.service.close();
    void media?.close();
    intents?.dispose();
    void intelligence?.dispose();
    sessionBridge?.close();
    worker?.kill();
  }
});
app.on("window-all-closed", () => {
  exiting = true;
  for (const preview of projectPreviews.values()) void preview.close();
  for (const entry of workbenches.entries()) void entry.value.service.close();
  void media?.close();
  intents?.dispose();
  void intelligence?.dispose();
  sessionBridge?.close();
  worker?.kill();
  app.quit();
});
