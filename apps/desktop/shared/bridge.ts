import type {
  CoreCommandInput,
  CoreSnapshot,
  DispatchResult,
  OrbitParameters,
  SearchResult,
  TaskRecord,
  TaskPolicy,
  AssetRecord,
  SourceRecord,
  Activity,
  ProjectPreview,
  ProjectRegistrationResult,
  CanvasSuggestionSelection,
  CanvasSuggestionRefreshScope,
} from "@eve/contracts";
import type {
  MediaCheckpoint,
  MediaAvailability,
} from "../../../packages/media/src/index";
import type { IntentResponse, IntentEvent } from "../host/intents";
import type { IntelligenceSettings } from "../host/intelligence";
import type { ProjectSelection } from "../host/projects";
import type { ArticleReading, SourceSearchResult } from "../../../packages/imports/src/web-reader";
export type { ArticleReading, SourceSearchResult } from "../../../packages/imports/src/web-reader";
export type { ProjectSelection } from "../host/projects";
export type { ProjectPreview, ProjectRegistrationResult } from "@eve/contracts";
export type {
  IntentResponse,
  IntentProposal,
  IntentCitation,
} from "../host/intents";
export type { IntelligenceSettings } from "../host/intelligence";
export type PublicIntelligenceEvent =
  IntentEvent | { type: "status"; settings: IntelligenceSettings };
import type { NetworkConnection } from "../../../packages/platform/src/index";
export type { NetworkConnection } from "../../../packages/platform/src/index";
export interface SystemStatus {
  available: boolean;
  audio: { available: boolean; volume?: number; muted?: boolean };
  network: { available: boolean; active: NetworkConnection[] };
  session: boolean;
}
export type SystemAction =
  | { type: "volume"; percent: number }
  | { type: "mute"; muted: boolean }
  | { type: "connect"; uuid: string }
  | { type: "lock" }
  | { type: "settings"; panel: "sound" | "network" | "bluetooth" | "display" }
  | { type: "exit"; action: "logout" | "restart" | "shutdown" };

export interface LessonState {
  sources: SourceRecord[];
  sourceId: string | null;
  availability: MediaAvailability | "not-open";
  checkpoint: MediaCheckpoint | null;
}

export interface HostStatus {
  platform: string;
  mode: "app" | "session";
  version: string;
  providers: {
    nemotron: "unconfigured" | "ready" | "error";
    openai: "unconfigured" | "ready" | "error";
    voice: "disabled" | "ready";
  };
  workbench: "unconfigured" | "starting" | "ready" | "error";
  preview: "idle" | "starting" | "ready" | "error";
}
export type SurfaceKind = "preview" | "workbench" | "video";
export interface SurfaceRequest {
  kind: SurfaceKind;
  taskId: string;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  sourceId?: string;
  /** Host-issued, one-use intent from a deliberate navigation gesture. */
  focusLeaseId?: string;
}
export interface EveBridge {
  systemStatus(): Promise<SystemStatus>;
  systemAction(
    action: SystemAction,
  ): Promise<{ performed: boolean; reason?: string }>;
  savedNetworks(): Promise<NetworkConnection[]>;
  onPrivacyLock(listener: () => void): () => void;
  ask(input: { taskId: string; text: string; mode?: "canvas" | "ask" | "suggestions" | "learn" | "selection"; suggestion?: CanvasSuggestionSelection; refresh?: { canvasRevision: number; scope: CanvasSuggestionRefreshScope } }): Promise<{ requestId: string }>;
  cancelIntent(requestId: string): Promise<void>;
  applyProposal(input: {
    requestId: string;
    proposalId: string;
  }): Promise<IntentResponse>;
  discardProposal(input: {
    requestId: string;
    proposalId: string;
  }): Promise<IntentResponse>;
  openIntentSource(input: {
    requestId: string;
    sourceId: string;
  }): Promise<void>;
  intelligenceSettings(): Promise<IntelligenceSettings>;
  onIntelligence(
    listener: (event: PublicIntelligenceEvent) => void,
  ): () => void;
  onAttention(
    listener: (target: {
      taskId: string;
      activity: Activity;
      focusLeaseId?: string;
      sourceId?: string;
      sourceQuery?: string;
      sourceKind?: "article" | "video";
    }) => void,
  ): () => void;
  onAskSelection(listener: () => void): () => void;
  onMaterial(
    listener: (target: { taskId: string; assetId: string }) => void,
  ): () => void;
  setSourceContext(taskId: string, sourceId: string | null): Promise<void>;
  lesson(taskId: string): Promise<LessonState>;
  attachSource(
    taskId: string,
    url: string,
    title: string,
  ): Promise<SourceRecord[]>;
  openSource(taskId: string, sourceId: string): Promise<void>;
  readSource(taskId: string, sourceId: string): Promise<ArticleReading>;
  searchSources(taskId: string, query: string): Promise<SourceSearchResult[]>;
  openVideoSearch(taskId: string, query: string): Promise<void>;
  assets(taskId: string): Promise<TaskAsset[]>;
  assetText(taskId: string, assetId: string): Promise<string>;
  importAssets(
    taskId: string,
  ): Promise<{ assets: TaskAsset[]; errors: string[] }>;
  attachCanvasImage(input: CanvasImageAttachmentInput): Promise<CanvasImageAttachmentResult>;
  cancelCanvasImageAttachment(input: { taskId: string; requestId: string }): Promise<void>;
  snapshot(): Promise<CoreSnapshot>;
  dispatch(command: CoreCommandInput): Promise<DispatchResult>;
  search(query: string): Promise<SearchResult[]>;
  status(): Promise<HostStatus>;
  beginEditorNavigation(taskId: string): Promise<string | null>;
  surface(
    request: SurfaceRequest,
  ): Promise<{ ready: boolean; message?: string }>;
  hideSurfaces(): Promise<void>;
  previewDraft(taskId: string, values: OrbitParameters | null): Promise<void>;
  openProject(): Promise<void>;
  chooseProject(taskId: string): Promise<ProjectSelection | null>;
  registerProject(input: {
    selectionId: string;
    adapter: "generic" | "orbit";
    preview: ProjectPreview;
  }): Promise<ProjectRegistrationResult>;
  dismissProjectSelection(selectionId: string): Promise<void>;
  reviewProject(
    taskId: string,
  ): Promise<{ trusted: boolean; message?: string; focusLeaseId?: string }>;
  closeProject(taskId: string): Promise<{ closed: boolean }>;
  reloadPreview(
    taskId: string,
  ): Promise<{ reloaded: boolean; message?: string }>;
  onSnapshot(listener: (snapshot: CoreSnapshot) => void): () => void;
  onRecall(listener: () => void): () => void;
  onHome(listener: () => void): () => void;
  onPrepareClose(listener: () => void): () => void;
  onError(listener: (message: string) => void): () => void;
  setOverlay(state: OverlayState | null): Promise<void>;
  onOverlayAction(listener: (action: OverlayAction) => void): () => void;
  reportRendererState(state: { dirty: boolean; busy: boolean }): void;
  closeCancelled(): void;
  readyToClose(): void;
}
export type TaskAsset = Pick<
  AssetRecord,
  "id" | "taskId" | "title" | "mediaType" | "byteLength" | "provenance"
> & { url: string };
export interface CanvasImageAttachmentInput {
  requestId: string;
  taskId: string;
  expectedEpoch: number;
  expectedRevision: number;
  blockId: string;
  source: { kind: "import" } | { kind: "existing"; assetId: string };
}
export interface CanvasImageAttachmentResult {
  requestId: string;
  taskId: string;
  blockId: string;
  status: "attached" | "cancelled" | "not-attached" | "failed" | "uncertain";
  assetId: string | null;
  message: string;
}
export type RecallTaskSummary = Pick<
  TaskRecord,
  "id" | "title" | "description" | "kind"
>;
export type OverlayState = {
  instanceId: string;
  busy?: boolean;
  message?: string;
} & (
  | { kind: "recall"; tasks: RecallTaskSummary[]; current: string | null }
  | {
      kind: "maintenance";
      taskId: string;
      title: string;
      detail: string;
      phase: "working" | "cancelling";
    }
  | {
      kind: "intent";
      taskId: string;
      title: string;
      text: string;
      providerReady?: boolean;
      busy?: boolean;
      message?: string;
      requesting?: boolean;
      response?: IntentResponse;
      settings?: IntelligenceSettings | null;
      policy: TaskPolicy;
    }
  | {
      kind: "system";
      taskId: string | null;
      host: HostStatus | null;
      policy: TaskPolicy | null;
      system?: SystemStatus | null;
      savedNetworks?: NetworkConnection[];
      systemLoading?: boolean;
      networksLoading?: boolean;
      systemBusy?: boolean;
      systemMessage?: string;
      systemError?: boolean;
    }
);
export type OverlayAction = { instanceId: string } & (
  | { type: "close" }
  | { type: "maintenance-ready" | "maintenance-cancel" }
  | { type: "select-task"; taskId: string }
  | { type: "create-task"; title: string }
  | { type: "intent-change" | "intent-submit"; taskId: string; text: string }
  | { type: "intent-cancel"; taskId: string; requestId?: string }
  | {
      type: "proposal-apply" | "proposal-discard";
      taskId: string;
      requestId: string;
      proposalId: string;
    }
  | {
      type: "intent-source-open";
      taskId: string;
      requestId: string;
      sourceId: string;
    }
  | { type: "set-policy"; taskId: string; policy: TaskPolicy }
  | { type: "system-action"; taskId: string | null; action: SystemAction }
  | { type: "system-networks"; taskId: string | null }
);
export interface EveOverlayBridge {
  search(query: string): Promise<string[]>;
  onState(listener: (state: OverlayState | null) => void): () => void;
  action(action: OverlayAction): void;
  ready(): void;
}
declare global {
  interface Window {
    eve: EveBridge;
    eveOverlay: EveOverlayBridge;
  }
}
