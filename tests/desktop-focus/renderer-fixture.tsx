import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CoreCommandInput,
  DispatchResult,
  CoreSnapshot,
  SourceRecord,
  TaskRecord,
  ProjectPreview,
  ProjectRegistrationResult,
  OrbitParameters,
} from "../../packages/contracts/src/index";
import type {
  EveBridge,
  HostStatus,
  SystemStatus,
  SystemAction,
  IntelligenceSettings,
  IntentResponse,
  PublicIntelligenceEvent,
  LessonState,
  OverlayAction,
  OverlayState,
  SurfaceRequest,
  TaskAsset,
  ProjectSelection,
  CanvasImageAttachmentInput,
  CanvasImageAttachmentResult,
} from "../../apps/desktop/shared/bridge";
import { App } from "../../apps/desktop/renderer/src/App";
import { OverlayApp } from "../../apps/desktop/renderer/src/OverlayApp";
import { Curve } from "../../apps/desktop/renderer/src/components/Curve";

export const linuxHost: HostStatus = {
  platform: "linux",
  mode: "session",
  version: "test",
  providers: {
    nemotron: "unconfigured",
    openai: "unconfigured",
    voice: "disabled",
  },
  workbench: "unconfigured",
  preview: "ready",
};
export const linuxSystem: SystemStatus = {
  available: true,
  audio: { available: true, volume: 40, muted: false },
  network: {
    available: true,
    active: [
      {
        uuid: "wifi-active",
        name: "Home connection",
        type: "wifi",
        device: "wlan0",
      },
    ],
  },
  session: true,
};

export const emptyIntelligence: IntelligenceSettings = {
  state: "ready",
  providers: [],
  storage: { available: true, backend: "test", state: "ready" },
  cloudRequestsRemaining: 20,
  localRecoveryRequired: false,
  localRecoveryOrigins: [],
};
export const responseFixture = (
  requestId = "request-1",
  taskId = "note-a",
): IntentResponse => ({
  requestId,
  taskId,
  status: "complete",
  message: "Keep the plan clear and welcoming.",
  basis: "sources",
  provider: { id: "test-local", kind: "local", model: "test-model" },
  citations: [
    {
      sourceId: "source-1",
      title: "Club notes",
      quote: "Meet near the library.",
      provenance: "authored-notes",
      canOpen: true,
    },
  ],
  proposals: [
    {
      id: "proposal-1",
      kind: "note",
      label: "Clarify the meeting plan",
      summary: "Keep the useful details in a short paragraph.",
      before: "<p>Original idea</p>",
      after: "<p>A clear meeting plan.</p>",
      status: "ready",
      expiresAt: Date.now() + 300_000,
    },
  ],
});

export const summaries = [
  {
    id: "note-a",
    title: "First idea",
    description: "A thought worth keeping",
    kind: "note" as const,
  },
  {
    id: "note-b",
    title: "Another idea",
    description: "Another thought",
    kind: "note" as const,
  },
];

export function mountOverlayFixture(
  element: HTMLElement,
  kind: "recall" | "intent" | "system" | "maintenance" = "recall",
) {
  const actions: OverlayAction[] = [];
  let listener: ((state: OverlayState | null) => void) | undefined;
  let state: OverlayState =
    kind === "recall"
      ? { instanceId: "overlay-1", kind, tasks: summaries, current: "note-a" }
      : kind === "intent"
        ? {
            instanceId: "overlay-1",
            kind,
            taskId: "note-a",
            title: "First idea",
            text: "",
            providerReady: false,
            policy: { processing: "local-only", assistancePaused: false },
            settings: emptyIntelligence,
          }
        : kind === "maintenance"
          ? {
              instanceId: "overlay-1",
              kind,
              taskId: "note-a",
              title: "Keeping your work safe.",
              detail: "Saving the workspace before creating a backup.",
              phase: "working",
            }
          : {
              instanceId: "overlay-1",
              kind,
              taskId: "note-a",
              host: null,
              policy: { processing: "local-only", assistancePaused: false },
            };
  window.eveOverlay = {
    onState: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    action: (action) => {
      actions.push(action);
    },
    ready: () => listener?.(state),
    search: async (query) => {
      await new Promise((resolve) =>
        setTimeout(resolve, query === "slow" ? 400 : 1),
      );
      return query === "slow" ? ["note-a"] : query === "fast" ? ["note-b"] : [];
    },
  };
  const root = createRoot(element);
  root.render(<OverlayApp />);
  return {
    actions,
    get state() {
      return state;
    },
    update: (next: OverlayState) => {
      state = next;
      listener?.(state);
    },
    close: () => listener?.(null),
    unmount: () => root.unmount(),
  };
}

export function mountCurveFixture(element: HTMLElement) {
  function Fixture() {
    const [curve, setCurve] = useState<[number, number, number, number]>([
      0.22, 1, 0.36, 1,
    ]);
    return <Curve interactive value={curve} onChange={setCurve} />;
  }
  const root = createRoot(element);
  root.render(<Fixture />);
}

export function mountAppFixture(
  element: HTMLElement,
  initial: "note" | "project" | "home" = "note",
  failSaves = false,
  platform = "darwin",
) {
  const task = (id: string, title: string): TaskRecord => ({
    id,
    title,
    description: "A thought",
    kind: "note",
    projectPath: null,
    revision: 0,
    epoch: 1,
    createdAt: 1,
    updatedAt: 1,
    note: {
      id: `${id}-note`,
      body: "<p>Original idea</p>",
      revision: 0,
      updatedAt: 1,
    },
    parameters: null,
    checkpoint: null,
    policy: { processing: "local-only", assistancePaused: false, revision: 0 },
  });
  const project: TaskRecord = {
    ...task("project", "Orbit"),
    kind: "project" as const,
    projectPath: "/fixture/orbit",
    project: {
      id: "fixture-orbit",
      canonicalRoot: "/fixture/orbit",
      adapter: "orbit",
      verification: "verified",
      rootIdentity: { device: "1", inode: "1" },
      kind: "managed",
      preview: { kind: "static", entry: "index.html" },
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    parameters: {
      revision: 0,
      updatedAt: 1,
      values: {
        durationMinutes: 25,
        transitionMs: 260,
        easing: [0.22, 1, 0.36, 1] as [number, number, number, number],
        theme: "#5677FF",
      },
    },
  };
  let snapshot: CoreSnapshot = {
    version: 1,
    activeTaskId:
      initial === "home" ? null : initial === "note" ? "note-a" : "project",
    tasks: [
      task("note-a", "First idea"),
      task("note-b", "Another idea"),
      project,
    ],
    recentActions: [],
  };
  const listeners = new Set<(snapshot: CoreSnapshot) => void>();
  const commandReceipts = new Map<
    string,
    { fingerprint: string; result: Extract<DispatchResult, { ok: true }> }
  >();
  const sources: SourceRecord[] = [
    {
      id: "lesson",
      taskId: "project",
      title: "How motion feels · Authored notes",
      url: "https://www.youtube.com/watch?v=lVLzkleL_CE",
      excerpt:
        "Easing changes the distribution of motion. These are authored notes for the project.",
      retrievedAt: 1,
      createdAt: 1,
      provenance: {
        kind: "timestamped-notes",
        attribution: "Original notes by the Eve project",
        rights: "An original explanation, not a transcript.",
      },
    },
  ];
  const lesson: LessonState = {
    sources,
    sourceId: null,
    availability: "embedding-disabled",
    checkpoint: null,
  };
  let intelligenceListener:
    ((event: PublicIntelligenceEvent) => void) | undefined;
  let materialListener: Parameters<EveBridge["onMaterial"]>[0] | undefined;
  let privacyLock: (() => void) | undefined;
  let settleSystemExit: ((accepted: boolean) => void) | undefined;
  let askSelection: (() => void) | undefined;
  let home: (() => void) | undefined;
  let prepareClose: (() => void) | undefined;
  let attentionListener: Parameters<EveBridge["onAttention"]>[0] | undefined;
  const receipts = new Map<string, () => void>();
  const heldProposals: Array<() => void> = [];
  const heldImageAttachments: Array<() => void> = [];
  let projectReceipt:
    Extract<ProjectRegistrationResult, { ok: true }> | undefined;
  let projectChoice: Parameters<EveBridge["registerProject"]>[0] | undefined;
  let nextRequest = 0;
  let actionListener: ((action: OverlayAction) => void) | undefined;
  const asset: TaskAsset = {
    id: "material",
    taskId: "note-a",
    title: "Reference.md",
    mediaType: "text/markdown",
    byteLength: 100,
    url: "eve-asset://workspace/note-a/material",
    provenance: {
      kind: "user-import",
      attribution: "Your selected material",
      rights: "User supplied",
    },
  };
  const state = {
    projectSelection: {
      selectionId: "fixture-selection",
      taskId: "note-a",
      title: "Campus site",
      canonicalRoot: "/fixture/campus-site",
      availableAdapters: ["generic"],
    } as ProjectSelection,
    projectChooserCancelled: false,
    projectChooseDelayMs: 0,
    projectChooseError: "",
    projectRegisterDelayMs: 0,
    projectRegisterRejectOnce: false,
    projectLostAckOnce: false,
    projectCoreFailure: null as "STORAGE_ERROR" | "STALE_EPOCH" | null,
    projectDismissError: "",
    projectReviewDelayMs: 0,
    projectReviewResult: { trusted: false } as {
      trusted: boolean;
      message?: string;
    },
    projectCloseResult: { closed: false },
    projectCloseDelayMs: 0,
    projectCloses: [] as string[],
    previewReloads: [] as string[],
    editorNavigations: [] as {
      taskId: string;
      leaseId: string;
      saves: number;
    }[],
    editorFocusAvailable: true,
    recallAckDelayMs: 0,
    renameCommands: [] as Extract<CoreCommandInput, { type: "RenameTask" }>[],
    renameDelayMs: 0,
    renameAckDelayMs: 0,
    renameLostAckOnce: false,
    renameRejectOnce: false,
    previewReloadDelayMs: 0,
    previewReloadResult: { reloaded: true } as {
      reloaded: boolean;
      message?: string;
    },
    projectChooses: [] as string[],
    projectRegistrations: [] as Parameters<EveBridge["registerProject"]>[0][],
    projectDismissals: [] as string[],
    projectReviews: [] as string[],
    overlay: null as OverlayState | null,
    platform,
    system:
      platform === "linux"
        ? structuredClone(linuxSystem)
        : ({
            available: false,
            audio: { available: false },
            network: { available: false, active: [] },
            session: false,
          } as SystemStatus),
    systemStatusError: "",
    systemReads: 0,
    networkReads: 0,
    systemActionDelay: 0,
    exitRequiresSettlement: false,
    systemActions: [] as SystemAction[],
    systemActionResult: { performed: true } as {
      performed: boolean;
      reason?: string;
    },
    privacyLock: () => privacyLock?.(),
    settings: emptyIntelligence,
    receiptDelay: false,
    lessonDelayMs: 0,
    askContexts: [] as (
      { taskId: string; sourceId: string | null } | undefined
    )[],
    earlyResponse: false,
    asks: [] as { requestId: string; taskId: string; text: string }[],
    cancelled: [] as string[],
    proposalDelayMs: 40,
    holdProposal: false,
    releaseProposal: () => {
      const release = heldProposals.shift();
      if (!release) throw new Error("There is no held proposal to release.");
      release();
    },
    proposalResult: undefined as IntentResponse | undefined,
    proposalFailure: false,
    proposalCalls: [] as {
      requestId: string;
      proposalId: string;
      operation: string;
    }[],
    intentSources: [] as { requestId: string; sourceId: string }[],
    rendererStates: [] as { dirty: boolean; busy: boolean }[],
    closeCancellations: 0,
    closeReadies: 0,
    sourceContexts: [] as { taskId: string; sourceId: string | null }[],
    publishIntelligence: (event: PublicIntelligenceEvent) =>
      intelligenceListener?.(event),
    publishAttention: (
      target: Parameters<Parameters<EveBridge["onAttention"]>[0]>[0],
    ) => attentionListener?.(target),
    releaseReceipt: (requestId: string) => receipts.get(requestId)?.(),
    prepareClose: () => prepareClose?.(),
    askSelection: () => askSelection?.(),
    home: () => home?.(),
    surfaceCalls: [] as SurfaceRequest[],
    previewDrafts: [] as { taskId: string; values: OrbitParameters | null }[],
    surfaceResult: { ready: true } as { ready: boolean; message?: string },
    hideCalls: 0,
    savedWrites: 0,
    saveAttempts: 0,
    updateCommands: [] as Extract<CoreCommandInput, { type: "UpdateNote" }>[],
    createdTasks: 0,
    dropCopyAckOnce: false,
    saveDelayMs: 0,
    failSaves,
    assets: [] as TaskAsset[],
    imageAttachmentCalls: [] as CanvasImageAttachmentInput[],
    imageAttachmentCancellations: [] as Parameters<EveBridge["cancelCanvasImageAttachment"]>[0][],
    holdImageAttachment: false,
    imageAttachmentFailure: "",
    imageAttachmentResult: { status: "failed", assetId: null, message: "This fixture has no image attachment configured." } as Pick<CanvasImageAttachmentResult, "status" | "assetId" | "message">,
    releaseImageAttachment: () => {
      const release = heldImageAttachments.shift();
      if (!release) throw new Error("There is no held image attachment to release.");
      release();
    },
    actions: [] as OverlayAction[],
    openedSources: [] as string[],
    get snapshot() {
      return snapshot;
    },
    sendAction: (action: OverlayAction) => actionListener?.(action),
    remount: () => {
      root.unmount();
      root = createRoot(element);
      root.render(<App />);
    },
    addNotes: (count: number) => {
      snapshot = {
        ...snapshot,
        tasks: [
          ...snapshot.tasks,
          ...Array.from({ length: count }, (_, index) =>
            task(`extra-${index}`, `Extra idea ${index}`),
          ),
        ],
      };
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    },
    // Presentation-only fixtures. These do not register or execute a native project.
    addProject: (
      id: string,
      title: string,
      preview: ProjectPreview = { kind: "none" },
      verified = true,
    ) => {
      const base = {
        id: `record-${id}`,
        canonicalRoot: `/fixture/${id}`,
        adapter: "generic" as const,
        preview,
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      snapshot = {
        ...snapshot,
        tasks: [
          ...snapshot.tasks,
          {
            ...task(id, title),
            kind: "project",
            projectPath: base.canonicalRoot,
            description: "Ideas and code for the campus exhibition.",
            project: verified
              ? {
                  ...base,
                  verification: "verified",
                  rootIdentity: { device: "1", inode: "2" },
                  kind: "external",
                }
              : {
                  ...base,
                  verification: "legacy-unverified",
                  rootIdentity: null,
                  kind: null,
                },
          },
        ],
      };
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    },
    patchTask: (taskId: string, changes: Partial<TaskRecord>) => {
      snapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map((item) =>
          item.id === taskId ? { ...item, ...changes } : item,
        ),
      };
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    },
    switchTask: (taskId: string) => {
      snapshot = { ...snapshot, activeTaskId: taskId };
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    },
    material: (taskId: string, assetId: string) =>
      materialListener?.({ taskId, assetId }),
    addMaterialSource: (taskId: string, second = false) => {
      const material = second
        ? {
            ...asset,
            id: "material-2",
            title: "Second reference.md",
            url: "eve-asset://workspace/note-a/material-2",
          }
        : asset;
      state.assets = second ? [...state.assets, material] : [material];
      sources.push({
        id: second ? "material-source-2" : "material-source",
        taskId,
        assetId: material.id,
        title: "Saved reference",
        excerpt: "Your original text.",
        retrievedAt: 1,
        createdAt: 1,
        provenance: asset.provenance,
      });
    },
    publishNote: (body: string, taskId = snapshot.activeTaskId) => {
      snapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map((item) =>
          item.id === taskId
            ? {
                ...item,
                note: { ...item.note, body, revision: item.note.revision + 1 },
              }
            : item,
        ),
      };
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    },
  };
  window.eve = {
    chooseProject: async (taskId) => {
      state.projectChooses.push(taskId);
      if (state.projectChooseDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.projectChooseDelayMs),
        );
      if (state.projectChooseError) throw new Error(state.projectChooseError);
      return state.projectChooserCancelled
        ? null
        : { ...state.projectSelection, taskId };
    },
    registerProject: async (input) => {
      state.projectRegistrations.push(structuredClone(input));
      if (state.projectRegisterDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.projectRegisterDelayMs),
        );
      if (
        projectChoice &&
        JSON.stringify(projectChoice) !== JSON.stringify(input)
      )
        throw new Error(
          "A different choice cannot replace a submitted registration.",
        );
      projectChoice ??= structuredClone(input);
      if (state.projectRegisterRejectOnce) {
        state.projectRegisterRejectOnce = false;
        throw new Error("The registration reply was interrupted.");
      }
      if (projectReceipt)
        return {
          ...projectReceipt,
          snapshot: structuredClone(snapshot),
          idempotent: true,
        };
      if (state.projectCoreFailure)
        return {
          ok: false,
          snapshot: structuredClone(snapshot),
          error: {
            code: state.projectCoreFailure,
            message:
              state.projectCoreFailure === "STORAGE_ERROR"
                ? "Storage confirmation is unavailable."
                : "This space changed. Choose the folder again.",
          },
        };
      const id = state.projectChooses.at(-1)!;
      const registered = {
        id: "attached-project",
        canonicalRoot: state.projectSelection.canonicalRoot,
        verification: "verified" as const,
        rootIdentity: { device: "1", inode: "5" },
        kind: "external" as const,
        adapter: input.adapter,
        preview: input.preview,
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      snapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map((task) =>
          task.id === id
            ? {
                ...task,
                kind: "project",
                projectPath: registered.canonicalRoot,
                project: registered,
                epoch: task.epoch + 1,
                revision: task.revision + 1,
                parameters:
                  input.adapter === "orbit" ? project.parameters : null,
              }
            : task,
        ),
      };
      projectReceipt = {
        ok: true,
        project: registered,
        snapshot: structuredClone(snapshot),
        idempotent: false,
      };
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
      if (state.projectLostAckOnce) {
        state.projectLostAckOnce = false;
        throw new Error(
          "The acknowledgement was interrupted after registration.",
        );
      }
      return projectReceipt;
    },
    dismissProjectSelection: async (selectionId) => {
      state.projectDismissals.push(selectionId);
      if (state.projectDismissError) throw new Error(state.projectDismissError);
      if (projectChoice && !projectReceipt && !state.projectCoreFailure)
        throw new Error(
          "This registration awaits confirmation. Retry before dismissing.",
        );
      projectChoice = undefined;
    },
    reviewProject: async (taskId) => {
      state.projectReviews.push(taskId);
      if (state.projectReviewDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.projectReviewDelayMs),
        );
      return state.projectReviewResult;
    },
    closeProject: async (taskId) => {
      state.projectCloses.push(taskId);
      if (state.projectCloseDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.projectCloseDelayMs),
        );
      return state.projectCloseResult;
    },
    reloadPreview: async (taskId) => {
      state.previewReloads.push(taskId);
      if (state.previewReloadDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.previewReloadDelayMs),
        );
      return state.previewReloadResult;
    },
    systemStatus: async () => {
      state.systemReads++;
      if (state.systemStatusError) throw new Error(state.systemStatusError);
      return structuredClone(state.system);
    },
    systemAction: async (action) => {
      state.systemActions.push(action);
      if (state.systemActionDelay)
        await new Promise((resolve) =>
          setTimeout(resolve, state.systemActionDelay),
        );
      if (action.type === "exit" && state.exitRequiresSettlement) {
        const accepted = await new Promise<boolean>((resolve) => {
          settleSystemExit = resolve;
          prepareClose?.();
        });
        if (!accepted)
          return {
            performed: false,
            reason: "Save your note before ending the session.",
          };
      }
      if (state.systemActionResult.performed) {
        if (action.type === "volume")
          state.system.audio.volume = action.percent;
        else if (action.type === "mute")
          state.system.audio.muted = action.muted;
        else if (action.type === "connect")
          state.system.network.active = [
            {
              uuid: action.uuid,
              name: "Studio connection",
              type: "ethernet",
              device: "eth0",
            },
          ];
      }
      return state.systemActionResult;
    },
    savedNetworks: async () => {
      state.networkReads++;
      return [
        ...linuxSystem.network.active,
        {
          uuid: "studio-saved",
          name: "Studio connection",
          type: "ethernet",
          device: null,
        },
      ];
    },
    onMaterial: (listener) => {
      materialListener = listener;
      return () => {
        materialListener = undefined;
      };
    },
    onPrivacyLock: (listener) => {
      privacyLock = listener;
      return () => {
        privacyLock = undefined;
      };
    },
    ask: async ({ taskId, text }) => {
      const requestId = `request-${++nextRequest}`;
      state.asks.push({ requestId, taskId, text });
      state.askContexts.push(state.sourceContexts.at(-1));
      if (state.earlyResponse)
        intelligenceListener?.({
          type: "intent",
          response: responseFixture(requestId, taskId),
        });
      if (state.receiptDelay)
        await new Promise<void>((resolve) => receipts.set(requestId, resolve));
      return { requestId };
    },
    cancelIntent: async (requestId) => {
      state.cancelled.push(requestId);
    },
    applyProposal: async (input) => {
      state.proposalCalls.push({ ...input, operation: "apply" });
      const result = state.proposalResult;
      const owner = snapshot.activeTaskId!;
      if (state.holdProposal)
        await new Promise<void>((resolve) => heldProposals.push(resolve));
      else
        await new Promise((resolve) =>
          setTimeout(resolve, state.proposalDelayMs),
        );
      if (state.proposalFailure)
        throw new Error("Status could not be confirmed.");
      if (result) return result;
      const response = responseFixture(input.requestId, owner);
      response.proposals[0].status = "applied";
      return response;
    },
    discardProposal: async (input) => {
      state.proposalCalls.push({ ...input, operation: "discard" });
      const response = responseFixture(input.requestId, snapshot.activeTaskId!);
      response.proposals[0].status = "discarded";
      return response;
    },
    openIntentSource: async (input) => {
      state.intentSources.push(input);
    },
    intelligenceSettings: async () => state.settings,
    onIntelligence: (listener) => {
      intelligenceListener = listener;
      return () => {
        intelligenceListener = undefined;
      };
    },
    onAttention: (listener) => {
      attentionListener = listener;
      return () => {
        attentionListener = undefined;
      };
    },
    setSourceContext: async (taskId, sourceId) => {
      state.sourceContexts.push({ taskId, sourceId });
    },
    reportRendererState: (value) => {
      state.rendererStates.push(value);
    },
    closeCancelled: () => {
      state.closeCancellations++;
      settleSystemExit?.(false);
      settleSystemExit = undefined;
    },
    lesson: async (taskId) => {
      if (state.lessonDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.lessonDelayMs),
        );
      return {
        ...lesson,
        sources: sources.filter((source) => source.taskId === taskId),
      };
    },
    attachSource: async (taskId, url, title) => {
      sources.push({
        id: `source-${sources.length}`,
        taskId,
        title,
        url,
        excerpt: "",
        retrievedAt: 1,
        createdAt: 1,
        provenance: {
          kind: "web-source",
          attribution: "User attached reference",
          rights: "Source belongs to its publisher",
        },
      });
      return sources.filter((source) => source.taskId === taskId);
    },
    openSource: async (_taskId, sourceId) => {
      state.openedSources.push(sourceId);
    },
    readSource: async () => { throw new Error("The fixture has no live article connection."); },
    searchSources: async () => [],
    openVideoSearch: async () => {},
    assets: async () => state.assets,
    assetText: async () =>
      "# Reference\n<script>window.importedScriptRan = true</script>\nYour original text.",
    importAssets: async () => {
      state.assets = [asset];
      return { assets: state.assets, errors: [] };
    },
    attachCanvasImage: async input => {
      state.imageAttachmentCalls.push(structuredClone(input));
      if (state.holdImageAttachment) await new Promise<void>(resolve => heldImageAttachments.push(resolve));
      if (state.imageAttachmentFailure) throw new Error(state.imageAttachmentFailure);
      return { requestId: input.requestId, taskId: input.taskId, blockId: input.blockId, ...state.imageAttachmentResult };
    },
    cancelCanvasImageAttachment: async input => { state.imageAttachmentCancellations.push(structuredClone(input)); },
    snapshot: async () => structuredClone(snapshot),
    status: async () => ({
      platform: state.platform,
      mode: state.system.session ? "session" : "app",
      version: "test",
      providers: {
        nemotron: "unconfigured",
        openai: "unconfigured",
        voice: "disabled",
      },
      workbench: "unconfigured",
      preview: "ready",
    }),
    surface: async (request) => {
      state.surfaceCalls.push(request);
      if (request.kind === "video")
        lesson.sourceId = request.sourceId ?? "lesson";
      return state.surfaceResult;
    },
    beginEditorNavigation: async (taskId) => {
      const leaseId = `focus-${state.editorNavigations.length + 1}`;
      state.editorNavigations.push({
        taskId,
        leaseId,
        saves: state.saveAttempts,
      });
      return state.editorFocusAvailable ? leaseId : null;
    },
    hideSurfaces: async () => {
      state.hideCalls++;
    },
    dispatch: async (command) => {
      if (command.type === "RenameTask")
        state.renameCommands.push(structuredClone(command));
      const receipt = commandReceipts.get(command.requestId);
      if (receipt) {
        if (receipt.fingerprint !== JSON.stringify(command))
          return {
            ok: false,
            snapshot: structuredClone(snapshot),
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "The request changed.",
            },
          };
        return {
          ...receipt.result,
          snapshot: structuredClone(snapshot),
          idempotent: true,
        };
      }
      if (command.type === "RenameTask") {
        if (state.renameDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, state.renameDelayMs),
          );
        if (state.renameRejectOnce) {
          state.renameRejectOnce = false;
          throw new Error("The title request could not be confirmed.");
        }
        const current = snapshot.tasks.find(
          (item) => item.id === command.taskId,
        )!;
        if (
          current.epoch !== command.expectedEpoch ||
          current.revision !== command.expectedRevision
        )
          return {
            ok: false,
            snapshot: structuredClone(snapshot),
            error: {
              code: "REVISION_CONFLICT",
              message:
                "The space changed. Review its current title before trying again.",
            },
          };
        snapshot = {
          ...snapshot,
          tasks: snapshot.tasks.map((item) =>
            item.id === command.taskId
              ? { ...item, title: command.title, revision: item.revision + 1 }
              : item,
          ),
        };
      } else if (command.type === "UpdateNote") {
        state.saveAttempts++;
        state.updateCommands.push(structuredClone(command));
        if (state.saveDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, state.saveDelayMs),
          );
        if (state.failSaves)
          return {
            ok: false,
            snapshot: structuredClone(snapshot),
            error: {
              code: "STORAGE_ERROR",
              message: "Disk unavailable. Retry when it is ready.",
            },
          };
        const current = snapshot.tasks.find(
          (item) => item.id === command.taskId,
        )!;
        if (current.epoch !== command.expectedEpoch)
          return {
            ok: false,
            snapshot: structuredClone(snapshot),
            error: {
              code: "STALE_EPOCH",
              message:
                "The task context changed. Refresh the request before applying it.",
            },
          };
        if (current.note.revision !== command.expectedRevision)
          return {
            ok: false,
            snapshot: structuredClone(snapshot),
            error: {
              code: "REVISION_CONFLICT",
              message:
                "This note changed elsewhere. Your local text is still here.",
            },
          };
        state.savedWrites++;
        snapshot = {
          ...snapshot,
          tasks: snapshot.tasks.map((item) =>
            item.id === command.taskId
              ? {
                  ...item,
                  revision: item.revision + 1,
                  note: {
                    ...item.note,
                    body: command.body,
                    revision: item.note.revision + 1,
                  },
                }
              : item,
          ),
        };
      } else if (command.type === "CreateTask") {
        const created = task(`copy-${++state.createdTasks}`, command.title);
        created.note.body = "";
        snapshot = {
          ...snapshot,
          activeTaskId: created.id,
          tasks: [
            ...snapshot.tasks.map((item) =>
              item.id === snapshot.activeTaskId
                ? { ...item, epoch: item.epoch + 1 }
                : item,
            ),
            created,
          ],
        };
      } else if (command.type === "RecallTask")
        snapshot = {
          ...snapshot,
          activeTaskId: command.taskId,
          tasks: snapshot.tasks.map((item) =>
            snapshot.activeTaskId !== command.taskId &&
            (item.id === snapshot.activeTaskId || item.id === command.taskId)
              ? { ...item, epoch: item.epoch + 1 }
              : item,
          ),
        };
      else if (command.type === "ShowHome") {
        const current = snapshot.tasks.find(
          (item) => item.id === command.taskId,
        );
        if (
          snapshot.activeTaskId !== command.taskId ||
          current?.epoch !== command.expectedEpoch
        )
          return {
            ok: false,
            snapshot: structuredClone(snapshot),
            error: {
              code: "STALE_EPOCH",
              message: "The active space changed.",
            },
          };
        snapshot = {
          ...snapshot,
          activeTaskId: null,
          tasks: snapshot.tasks.map((item) =>
            item.id === command.taskId
              ? { ...item, epoch: item.epoch + 1 }
              : item,
          ),
        };
      } else if (command.type === "SaveCheckpoint")
        snapshot = {
          ...snapshot,
          tasks: snapshot.tasks.map((item) =>
            item.id === command.taskId
              ? {
                  ...item,
                  checkpoint: {
                    ...command.checkpoint,
                    returnAnchors: command.checkpoint.returnAnchors ?? [],
                    revision: (item.checkpoint?.revision ?? 0) + 1,
                    updatedAt: 1,
                  },
                }
              : item,
          ),
        };
      else if (command.type === "SetTaskPolicy")
        snapshot = {
          ...snapshot,
          tasks: snapshot.tasks.map((item) =>
            item.id === command.taskId
              ? {
                  ...item,
                  policy: {
                    ...command.policy,
                    revision: item.policy.revision + 1,
                  },
                }
              : item,
          ),
        };
      const result: Extract<DispatchResult, { ok: true }> = {
        ok: true,
        snapshot: structuredClone(snapshot),
        operation: {
          id: command.requestId,
          requestId: command.requestId,
          taskId:
            command.type === "ShowHome"
              ? command.taskId
              : snapshot.activeTaskId!,
          type: command.type,
          label: command.type,
          createdAt: 1,
          undoable: true,
          undone: false,
        },
        idempotent: false,
      };
      commandReceipts.set(command.requestId, {
        fingerprint: JSON.stringify(command),
        result,
      });
      if (command.type === "RecallTask" && state.recallAckDelayMs) {
        // The host publishes canonical state before the command receipt arrives.
        listeners.forEach((listener) => listener(structuredClone(snapshot)));
        await new Promise((resolve) =>
          setTimeout(resolve, state.recallAckDelayMs),
        );
      }
      if (command.type === "RenameTask") {
        if (state.renameAckDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, state.renameAckDelayMs),
          );
        if (state.renameLostAckOnce) {
          state.renameLostAckOnce = false;
          listeners.forEach((listener) => listener(structuredClone(snapshot)));
          throw new Error("The title acknowledgement was interrupted.");
        }
      }
      if (
        command.type === "UpdateNote" &&
        command.taskId.startsWith("copy-") &&
        state.dropCopyAckOnce
      ) {
        state.dropCopyAckOnce = false;
        listeners.forEach((listener) => listener(structuredClone(snapshot)));
        throw new Error("The copy acknowledgement was interrupted.");
      }
      return result;
    },
    search: async () => [],
    previewDraft: async (taskId, values) => {
      state.previewDrafts.push({ taskId, values });
    },
    openProject: async () => {},
    setOverlay: async (overlay) => {
      state.overlay = overlay;
    },
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onOverlayAction: (listener) => {
      actionListener = listener;
      return () => {
        actionListener = undefined;
      };
    },
    onRecall: () => () => {},
    onHome: (listener) => {
      home = listener;
      return () => {
        home = undefined;
      };
    },
    onAskSelection: (listener) => {
      askSelection = listener;
      return () => {
        askSelection = undefined;
      };
    },
    onPrepareClose: (listener) => {
      prepareClose = listener;
      return () => {
        prepareClose = undefined;
      };
    },
    onError: () => () => {},
    readyToClose: () => {
      state.closeReadies++;
      settleSystemExit?.(true);
      settleSystemExit = undefined;
    },
  } satisfies EveBridge;
  let root = createRoot(element);
  root.render(<App />);
  return state;
}
