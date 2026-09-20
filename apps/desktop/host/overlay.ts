import { canvasDocumentSchema } from '../../../packages/contracts/src/canvas';
import {
  ipcMain,
  session,
  WebContentsView,
  webContents,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { z } from "zod";
import type { OverlayAction, OverlayState } from "../shared/bridge";
import { taskPolicySchema } from "@eve/contracts";
import {
  systemActionSchema,
  systemStatusSchema,
  networkConnectionSchema,
} from "../shared/system";

const id = z.string().min(1).max(128);
const changedPassageSchema = z
  .object({
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
    before: z.string().max(8000),
    after: z.string().max(8000),
  })
  .strict()
  .refine(
    (change) =>
      change.endLine > change.startLine ||
      (change.endLine === change.startLine &&
        change.endColumn >= change.startColumn),
    "A changed passage must have an ordered original range.",
  );
const changedFilesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1).max(500),
        changes: z.array(changedPassageSchema).min(1).max(8),
      })
      .strict(),
  )
  .min(1)
  .max(8)
  .refine(
    (files) =>
      files.reduce((count, file) => count + file.changes.length, 0) <= 8,
    "At most eight passages can be reviewed together.",
  )
  .refine(
    (files) => new Set(files.map((file) => file.path)).size === files.length,
    "Files in a review must be distinct.",
  );

export const responseSchema = z.object({
  requestId: id,
  taskId: id,
  status: z.enum([
    "pending",
    "running",
    "complete",
    "unavailable",
    "cancelled",
    "stale",
    "error",
  ]),
  message: z.string().max(16000),
  basis: z.enum(["sources", "selection", "general"]).optional(),
  provider: z
    .object({
      id,
      kind: z.enum(["local", "cloud"]),
      model: z.string().max(300),
    })
    .optional(),
  citations: z
    .array(
      z.object({
        sourceId: id,
        title: z.string().max(300),
        quote: z.string().max(2000),
        provenance: z.enum(["attached", "retrieved", "authored-notes"]),
        mediaTime: z.number().nonnegative().optional(),
        canOpen: z.boolean(),
      }),
    )
    .max(12),
  proposals: z
    .array(
      z.object({
        id,
        kind: z.enum(["note", "parameter", "workspace", "canvas", "unsupported"]),
        label: z.string().max(300),
        summary: z.string().max(2000),
        before: z.string().max(1000000).optional(),
        after: z.string().max(24000).optional(),
        files: changedFilesSchema.optional(),
        canvas: canvasDocumentSchema.optional(),
        expiresAt: z.number().nonnegative(),
        status: z.enum([
          "ready",
          "applying",
          "applied",
          "discarded",
          "stale",
          "expired",
          "error",
          "uncertain",
          "unsupported",
        ]),
        message: z.string().max(2000).optional(),
      }),
    )
    .max(6),
});
const intelligenceSchema = z.object({
  state: z.enum([
    "uninitialized",
    "starting",
    "ready",
    "stopped",
    "failed",
    "disposed",
  ]),
  storage: z.object({
    available: z.boolean(),
    backend: z.string().max(100),
    state: z.enum(["ready", "unavailable", "locked"]),
    message: z.string().max(2000).optional(),
  }),
  providers: z
    .array(
      z.object({
        id,
        kind: z.enum(["local", "cloud"]),
        model: z.string().max(300),
        enabled: z.boolean(),
        protocol: z.enum(["openai-responses", "openai-chat-completions"]),
        endpoint: z.string().max(4096),
        roles: z.array(z.enum(["route", "explain", "prepare", "code"])).max(4),
        requestScope: z.literal("canvas-selection").optional(),
        authentication: z.enum(["none", "credential-store"]),
        cancellationMode: z
          .enum(["verified-disconnect", "unverified"])
          .optional(),
        quarantined: z.boolean().optional(),
        storage: z.enum(["secure", "runtime-only"]),
        credentialPresent: z.boolean(),
      }),
    )
    .max(8),
  cloudRequestsRemaining: z.number().int().nonnegative(),
  localRecoveryRequired: z.boolean(),
  localRecoveryOrigins: z.array(z.string().max(4096)).max(32),
  message: z.string().max(2000).optional(),
});
const stateSchema = z.intersection(
  z.object({
    instanceId: id,
    busy: z.boolean().optional(),
    message: z.string().max(2000).optional(),
  }),
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("maintenance"),
      taskId: id,
      title: z.string().max(120),
      detail: z.string().max(2000),
      phase: z.enum(["working", "cancelling"]),
    }),
    z.object({
      kind: z.literal("recall"),
      tasks: z
        .array(
          z.object({
            id,
            title: z.string().max(120),
            description: z.string().max(1000),
            kind: z.enum(["note", "project"]),
          }),
        )
        .max(5000),
      current: id.nullable(),
    }),
    z.object({
      kind: z.literal("intent"),
      taskId: id,
      title: z.string().max(120),
      text: z.string().max(16000),
      providerReady: z.boolean().optional(),
      busy: z.boolean().optional(),
      message: z.string().max(2000).optional(),
      requesting: z.boolean().optional(),
      response: responseSchema.optional(),
      settings: intelligenceSchema.nullable().optional(),
      policy: taskPolicySchema,
    }),
    z.object({
      kind: z.literal("system"),
      taskId: id.nullable(),
      host: z
        .object({
          platform: z.string(),
          mode: z.enum(["app", "session"]),
          version: z.string(),
          providers: z.object({
            nemotron: z.enum(["unconfigured", "ready", "error"]),
            openai: z.enum(["unconfigured", "ready", "error"]),
            voice: z.enum(["disabled", "ready"]),
          }),
          workbench: z.enum(["unconfigured", "starting", "ready", "error"]),
          preview: z.enum(["idle", "starting", "ready", "error"]),
        })
        .nullable(),
      policy: taskPolicySchema.nullable(),
      system: systemStatusSchema.nullable().optional(),
      savedNetworks: z.array(networkConnectionSchema).max(1000).optional(),
      systemLoading: z.boolean().optional(),
      networksLoading: z.boolean().optional(),
      systemBusy: z.boolean().optional(),
      systemMessage: z.string().max(2000).optional(),
      systemError: z.boolean().optional(),
    }),
  ]),
);
const actionSchema = z.intersection(
  z.object({ instanceId: id }),
  z.discriminatedUnion("type", [
    z.object({ type: z.enum(["maintenance-ready", "maintenance-cancel"]) }),
    z.object({ type: z.literal("close") }),
    z.object({ type: z.literal("select-task"), taskId: id }),
    z.object({
      type: z.literal("create-task"),
      title: z.string().trim().min(1).max(120),
    }),
    z.object({
      type: z.enum(["intent-change", "intent-submit"]),
      taskId: id,
      text: z.string().max(16000),
    }),
    z.object({
      type: z.literal("intent-cancel"),
      taskId: id,
      requestId: id.optional(),
    }),
    z.object({
      type: z.enum(["proposal-apply", "proposal-discard"]),
      taskId: id,
      requestId: id,
      proposalId: id,
    }),
    z.object({
      type: z.literal("intent-source-open"),
      taskId: id,
      requestId: id,
      sourceId: id,
    }),
    z.object({
      type: z.literal("set-policy"),
      taskId: id,
      policy: taskPolicySchema,
    }),
    z.object({
      type: z.literal("system-action"),
      taskId: id.nullable(),
      action: systemActionSchema,
    }),
    z.object({ type: z.literal("system-networks"), taskId: id.nullable() }),
  ]),
);

/** A trusted transparent surface sits above native activities without unloading or covering them with replicas. */
export class OverlayHost {
  private view?: WebContentsView;
  private loading?: Promise<void>;
  private ready = false;
  private state: OverlayState | null = null;
  private previousFocus?: { contents: WebContents; taskId: string | null };
  private generation = 0;
  constructor(
    private options: {
      window: BrowserWindow;
      preload: string;
      url: string;
      onAction: (action: OverlayAction) => void;
      search: (query: string) => Promise<string[]>;
      canRestore: (contents: WebContents, taskId: string) => Promise<boolean>;
      onError: (message: string) => void;
      onUserInput?: () => void;
    },
  ) {
    ipcMain.on("eve:overlay-ready", this.onReady);
    ipcMain.on("eve:overlay-event", this.onAction);
    ipcMain.handle("eve:overlay-search", this.onSearch);
    options.window.on("resize", this.resize);
  }
  private trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (
      !this.view ||
      event.sender !== this.view.webContents ||
      event.senderFrame !== this.view.webContents.mainFrame
    )
      return false;
    const expected = new URL(this.options.url),
      actual = new URL(event.senderFrame.url);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.hash === "#overlay"
    );
  };
  private onReady = (event: IpcMainEvent) => {
    if (!this.trusted(event)) return;
    this.ready = true;
    this.publish();
  };
  private onSearch = async (event: IpcMainInvokeEvent, query: unknown) => {
    if (!this.trusted(event)) throw new Error("Untrusted overlay caller.");
    if (
      this.state?.kind !== "recall" ||
      typeof query !== "string" ||
      query.length > 500
    )
      throw new Error("Invalid search request.");
    return this.options.search(query);
  };
  private onAction = (event: IpcMainEvent, payload: unknown) => {
    if (!this.trusted(event)) return;
    const action = actionSchema.safeParse(payload);
    const state = this.state;
    if (
      !action.success ||
      !state ||
      action.data.instanceId !== state.instanceId
    )
      return;
    const value = action.data as OverlayAction;
    if (
      state.kind === "maintenance" &&
      value.type !== "maintenance-ready" &&
      value.type !== "maintenance-cancel"
    )
      return;
    if (
      (value.type === "maintenance-ready" ||
        value.type === "maintenance-cancel") &&
      state.kind !== "maintenance"
    )
      return;
    if (
      value.type === "select-task" &&
      (state.kind !== "recall" ||
        !state.tasks.some((task) => task.id === value.taskId))
    )
      return;
    if (value.type === "create-task" && state.kind !== "recall") return;
    if (
      (value.type === "intent-change" || value.type === "intent-submit") &&
      (state.kind !== "intent" || state.taskId !== value.taskId)
    )
      return;
    if (
      [
        "intent-cancel",
        "proposal-apply",
        "proposal-discard",
        "intent-source-open",
      ].includes(value.type) &&
      (state.kind !== "intent" ||
        !("taskId" in value) ||
        state.taskId !== value.taskId)
    )
      return;
    if (
      value.type === "set-policy" &&
      (state.kind !== "system" || state.taskId !== value.taskId)
    )
      return;
    if (
      (value.type === "system-action" || value.type === "system-networks") &&
      (state.kind !== "system" || state.taskId !== value.taskId)
    )
      return;
    this.options.onAction(value);
  };
  private resize = () => {
    const { width, height } = this.options.window.getContentBounds();
    this.view?.setBounds({ x: 0, y: 0, width, height });
  };
  raise() {
    if (this.view && this.state)
      this.options.window.contentView.addChildView(this.view);
  }
  private publish() {
    if (!this.ready || !this.view || this.view.webContents.isDestroyed())
      return;
    this.view.webContents.send("eve:overlay-state", this.state);
  }
  private async ensureView() {
    if (this.loading) return this.loading;
    this.view = new WebContentsView({
      webPreferences: {
        preload: this.options.preload,
        session: session.defaultSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.view.setBackgroundColor("#00000000");
    this.view.webContents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown") this.options.onUserInput?.();
    });
    this.view.webContents.on("before-mouse-event", (_event, input) => {
      if (input.type === "mouseDown" || input.type === "mouseWheel")
        this.options.onUserInput?.();
    });
    this.view.setVisible(false);
    this.view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.view.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    this.view.webContents.on("render-process-gone", () => {
      const state = this.state;
      this.state = null;
      this.view?.setVisible(false);
      if (this.view) this.options.window.contentView.removeChildView(this.view);
      this.view = undefined;
      this.loading = undefined;
      this.ready = false;
      if (state)
        this.options.onAction({ type: "close", instanceId: state.instanceId });
      this.options.onError(
        "The temporary panel closed unexpectedly. Your activity is still open.",
      );
    });
    this.options.window.contentView.addChildView(this.view);
    this.resize();
    this.loading = this.view.webContents.loadURL(this.options.url);
    return this.loading;
  }
  async setState(payload: unknown, options: { restoreFocus?: boolean } = {}) {
    const next =
      payload === null ? null : (stateSchema.parse(payload) as OverlayState);
    const generation = ++this.generation;
    const previous = this.state;
    this.state = next;
    if (!next) {
      this.publish();
      this.view?.setVisible(false);
      const focus = this.previousFocus;
      this.previousFocus = undefined;
      // A repeated absent state is only a visibility update. It has no focus to
      // restore and must not steal input from an explicitly opened editor.
      if (!previous || options.restoreFocus === false) return;
      if (
        focus &&
        !focus.contents.isDestroyed() &&
        focus.taskId !== null &&
        (await this.options.canRestore(focus.contents, focus.taskId)) &&
        generation === this.generation
      )
        focus.contents.focus();
      else if (
        generation === this.generation &&
        !this.options.window.isDestroyed()
      )
        this.options.window.webContents.focus();
      return;
    }
    if (!previous)
      this.previousFocus = {
        contents:
          webContents.getFocusedWebContents() ??
          this.options.window.webContents,
        taskId: next.kind === "recall" ? next.current : next.taskId,
      };
    await this.ensureView();
    if (generation !== this.generation || !this.state) return;
    this.resize();
    this.raise();
    this.publish();
    this.view!.setVisible(true);
    if (!previous || previous.instanceId !== next.instanceId)
      this.view!.webContents.focus();
  }
  /** Reassert an already-visible overlay after a hidden native page asks for
   * focus. This never opens a panel or activates its operating-system window. */
  focusActive(): boolean {
    if (
      !this.state ||
      !this.view?.getVisible() ||
      this.view.webContents.isDestroyed()
    )
      return false;
    this.view.webContents.focus();
    return true;
  }
  close() {
    ipcMain.removeListener("eve:overlay-ready", this.onReady);
    ipcMain.removeListener("eve:overlay-event", this.onAction);
    ipcMain.removeHandler("eve:overlay-search");
    this.options.window.removeListener("resize", this.resize);
    if (this.view && !this.view.webContents.isDestroyed())
      this.view.webContents.close();
  }
}
