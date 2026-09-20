import { invoke } from './presentation-invoke';
import { contextBridge, ipcRenderer } from "electron";
import type { EveBridge } from "../shared/bridge";

const subscribe = <T>(channel: string, listener: (value: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) =>
    listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const bridge: EveBridge = {
  systemStatus: () => invoke("eve:system-status"),
  systemAction: (action) => invoke("eve:system-action", action),
  savedNetworks: () => invoke("eve:saved-networks"),
  onPrivacyLock: (listener) => subscribe("eve:privacy-lock", listener),
  ask: (input) => invoke("eve:ask", input),
  cancelIntent: (requestId) =>
    invoke("eve:cancel-intent", requestId),
  applyProposal: (input) => invoke("eve:apply-proposal", input),
  discardProposal: (input) => invoke("eve:discard-proposal", input),
  openIntentSource: (input) =>
    invoke("eve:open-intent-source", input),
  intelligenceSettings: () => invoke("eve:intelligence-settings"),
  onIntelligence: (listener) => subscribe("eve:intelligence", listener),
  onAttention: (listener) => subscribe("eve:attention", listener),
  onAskSelection: (listener) => subscribe("eve:ask-selection", listener),
  onMaterial: (listener) => subscribe("eve:material", listener),
  setSourceContext: (taskId, sourceId) =>
    invoke("eve:source-context", taskId, sourceId),
  lesson: (taskId) => invoke("eve:lesson", taskId),
  attachSource: (taskId, url, title) =>
    invoke("eve:attach-source", taskId, url, title),
  openSource: (taskId, sourceId) =>
    invoke("eve:open-source", taskId, sourceId),
  readSource: (taskId, sourceId) =>
    invoke("eve:read-source", taskId, sourceId),
  searchSources: (taskId, query) =>
    invoke("eve:search-sources", taskId, query),
  openVideoSearch: (taskId, query) =>
    invoke("eve:video-search", taskId, query),
  assets: (taskId) => invoke("eve:assets", taskId),
  assetText: (taskId, assetId) =>
    invoke("eve:asset-text", taskId, assetId),
  importAssets: (taskId) => invoke("eve:import-assets", taskId),
  attachCanvasImage: (input) => invoke("eve:attach-canvas-image", input),
  cancelCanvasImageAttachment: (input) => invoke("eve:cancel-canvas-image-attachment", input),
  snapshot: () => invoke("eve:snapshot"),
  dispatch: (command) => invoke("eve:dispatch", command),
  search: (query) => invoke("eve:search", query),
  status: () => invoke("eve:status"),
  beginEditorNavigation: (taskId) =>
    invoke("eve:begin-editor-navigation", taskId),
  surface: (request) => invoke("eve:surface", request),
  hideSurfaces: () => invoke("eve:hide-surfaces"),
  previewDraft: (taskId, values) =>
    invoke("eve:preview-draft", taskId, values),
  openProject: () => invoke("eve:open-project"),
  chooseProject: (taskId) => invoke("eve:choose-project", taskId),
  registerProject: (input) => invoke("eve:register-project", input),
  dismissProjectSelection: (selectionId) =>
    invoke("eve:dismiss-project-selection", selectionId),
  reviewProject: (taskId) => invoke("eve:review-project", taskId),
  closeProject: (taskId) => invoke("eve:close-project", taskId),
  reloadPreview: (taskId) => invoke("eve:reload-preview", taskId),
  onSnapshot: (listener) => subscribe("eve:snapshot-changed", listener),
  onRecall: (listener) => subscribe("eve:recall", listener),
  onHome: (listener) => subscribe("eve:home", listener),
  onPrepareClose: (listener) => subscribe("eve:prepare-close", listener),
  onError: (listener) => subscribe("eve:host-error", listener),
  setOverlay: (state) => invoke("eve:set-overlay", state),
  onOverlayAction: (listener) => subscribe("eve:overlay-action", listener),
  reportRendererState: (state) => ipcRenderer.send("eve:renderer-state", state),
  closeCancelled: () => ipcRenderer.send("eve:close-cancelled"),
  readyToClose: () => ipcRenderer.send("eve:ready-to-close"),
};
contextBridge.exposeInMainWorld("eve", bridge);
