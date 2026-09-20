import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  BookOpen,
  Check,
  Code2,
  FileText,
  FolderOpen,
  House,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type {
  Activity,
  CanvasSuggestion,
  CanvasSuggestionRefreshScope,
  SourceRecord,
  CoreCommandInput,
  CoreSnapshot,
  OrbitParameters,
  TaskRecord,
} from "@eve/contracts";
import { canvasDataEqual, assertCanvasSuggestionRefreshScope, assertCanvasLearningScope } from "@eve/contracts";
import type {
  HostStatus,
  OverlayState,
  OverlayAction,
  TaskAsset,
} from "../../shared/bridge";
import { Logo } from "./Logo";
import { Home } from "./components/Home";
import { Canvas } from "./components/Canvas";
import { useCanvasImageAttachments } from "./hooks/useCanvasImageAttachments";
import { CanvasSuggestionPreview } from "./components/CanvasSuggestionPreview";
import { ContextualAnswer } from "./components/ContextualAnswer";
import { IntentResponse } from "./components/IntentResponse";
import type { CanvasNextStepsState } from "./components/CanvasNextSteps";
import { useCanvasDrafts } from "./hooks/useCanvasDrafts";
import { Curve, curveLabel } from "./components/Curve";
import { NoteEditor } from "./components/NoteEditor";
import { NoteConflict } from "./components/NoteConflict";
import { useNoteDrafts } from "./hooks/useNoteDrafts";
import { AssetsPanel } from "./components/AssetsPanel";
import { ActivitySurface } from "./components/ActivitySurface";
import { ProjectActivities } from "./components/ProjectActivities";
import { ProjectSetup } from "./components/ProjectSetup";
import { TaskTitle } from "./components/TaskTitle";
import { useRenameTask } from "./hooks/useRenameTask";
import { projectSetupBusy, useProjectSetup } from "./hooks/useProjectSetup";
import { taskActivity, taskCapabilities } from "./taskCapabilities";
import { LearningActivity } from "./components/LearningActivity";
import {
  intentIsRunning,
  useIntentAssistance,
} from "./hooks/useIntentAssistance";
import { useSystemControls } from "./hooks/useSystemControls";
import { retainedNoteIds, useNoteContinuity } from "./hooks/useNoteContinuity";

const uid = () => crypto.randomUUID();
const colors = ["#5677FF", "#56836F", "#C17B5B", "#A38ABF", "#25364B"];
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);
  return (
    <time>
      {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<CoreSnapshot | null>(null);
  const snapshotRef = useRef<CoreSnapshot | null>(null);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [overlay, setOverlay] = useState<{
    kind: OverlayState["kind"];
    instanceId: string;
  } | null>(null);
  const overlayRef = useRef(overlay);
  const requestInput = useRef<HTMLInputElement>(null);
  const closeOverlay = useCallback(() => {
    overlayRef.current = null;
    setOverlay(null);
  }, []);
  const openOverlay = useCallback((kind: OverlayState["kind"]) => {
    if (kind === "intent" && requestInput.current) {
      overlayRef.current = null; setOverlay(null);
      requestInput.current.focus({ preventScroll: true });
      return;
    }
    const next = { kind, instanceId: uid() };
    overlayRef.current = next;
    setOverlay(next);
    setError("");
  }, []);
  const toggleOverlay = useCallback(
    (kind: OverlayState["kind"]) => {
      if (overlayRef.current?.kind === kind) closeOverlay();
      else openOverlay(kind);
    },
    [closeOverlay, openOverlay],
  );
  const [requestedActivity, setRequestedActivity] = useState<{
    taskId: string | null;
    activity: Activity;
  }>({ taskId: null, activity: "preview" });
  const setActivity = useCallback((activity: Activity) => {
    setRequestedActivity({ taskId: snapshotRef.current?.activeTaskId ?? null, activity });
  }, []);
  const [editorNavigation, setEditorNavigation] = useState<{
    taskId: string;
    leaseId: string;
  } | null>(null);
  const navigationGeneration = useRef(0);
  const homeNavigation = useRef<() => void>(() => {});
  const task = snapshot?.tasks.find(
    (item) => item.id === snapshot.activeTaskId,
  );
  const capabilities = taskCapabilities(task);
  // A canonical task change can arrive before its navigation IPC resolves.
  // Never mount the previous task's activity (and checkpoint it) for a new one.
  const activity = taskActivity(task, requestedActivity.taskId === task?.id
    ? requestedActivity.activity : task?.checkpoint?.selectedActivity);
  const notebookOpen = !!task && activity === "notes";
  const [saving, setSavingState] = useState(false);
  const pendingNotes = useRef(
    new Map<
      string,
      { taskId: string; noteId: string; baseRevision: number; body: string }
    >(),
  );
  const saveBusy = useRef(false);
  const mutationCount = useRef(0);
  const proposalActions = useRef(new Set<string>());
  const suggestionTrigger = useRef<HTMLElement | null>(null);
  const preparedWritingResponses = useRef(new Set<string>());
  const canvasDirty = useRef(false);
  const reportState = useCallback(() => {
    window.eve?.reportRendererState({
      dirty: pendingNotes.current.size > 0 || canvasDirty.current,
      busy: saveBusy.current || mutationCount.current > 0,
    });
  }, []);
  const setSaving = useCallback(
    (value: boolean) => {
      saveBusy.current = value;
      setSavingState(value);
      reportState();
    },
    [reportState],
  );
  const assistance = useIntentAssistance();
  const systemControls = useSystemControls(
    overlay?.kind === "system",
    host?.platform,
  );
  const clearIntentPresentation = assistance.clearPresentation;
  const clearSystemPresentation = systemControls.clearPresentation;
  const sourceContextTail = useRef(Promise.resolve());
  const sourceContextGeneration = useRef(0);
  const selectedMaterials = useRef(new Map<string, string>());
  const setSourceContext = useCallback(
    (taskId: string, sourceId: string | null) => {
      ++sourceContextGeneration.current;
      const pending = window.eve.setSourceContext(taskId, sourceId);
      sourceContextTail.current = pending;
      void pending.catch((error: Error) => {
        if (sourceContextTail.current === pending) setError(error.message);
      });
    },
    [],
  );
  const setMaterialContext = useCallback((taskId: string, assetId: string) => {
    selectedMaterials.current.set(taskId, assetId);
    const generation = ++sourceContextGeneration.current;
    const pending = window.eve.lesson(taskId).then((lesson) => {
      if (
        generation !== sourceContextGeneration.current ||
        snapshotRef.current?.activeTaskId !== taskId
      )
        return;
      const source = lesson.sources.find((item) => item.assetId === assetId);
      return window.eve.setSourceContext(taskId, source?.id ?? null);
    });
    sourceContextTail.current = pending;
    void pending.catch((error: Error) => {
      if (sourceContextTail.current === pending) setError(error.message);
    });
  }, []);
  const [visitedNotes, setVisitedNotes] = useState<string[]>([]);
  const [taskAssets, setTaskAssets] = useState<Record<string, TaskAsset[]>>({});
  const [requestedAssets, setRequestedAssets] = useState<
    Record<string, { assetId: string; requestId: string }>
  >({});
  const workspace = useRef<HTMLElement>(null);
  const addProjectButton = useRef<HTMLButtonElement>(null);
  const readyNoteEditors = useRef(new Set<string>());
  const restoredNoteViewport = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<OrbitParameters | null>(null);
  const [curveDraft, setCurveDraft] = useState<
    [number, number, number, number]
  >([0.22, 1, 0.36, 1]);
  const [experiment, setExperiment] = useState(0);
  const [pendingOperations, setPendingOperations] = useState(0);
  const interactionTail = useRef(Promise.resolve<unknown>(undefined));
  const previewRevision = useRef(0);
  const [reloadingPreview, setReloadingPreview] = useState<string | null>(null);
  const enqueue = useCallback(
    <T,>(operation: () => Promise<T>) => {
      mutationCount.current++;
      setPendingOperations(mutationCount.current);
      reportState();
      const pending = interactionTail.current.then(operation);
      interactionTail.current = pending.catch(() => undefined);
      return pending.finally(() => {
        mutationCount.current--;
        setPendingOperations(mutationCount.current);
        reportState();
      });
    },
    [reportState],
  );
  const [intent, setIntent] = useState("");
  const intentTask = useRef<string | null>(null);
  const merge = useCallback((value: CoreSnapshot) => {
    snapshotRef.current = value;
    setSnapshot(value);
  }, []);
  const command = useCallback(
    async (input: CoreCommandInput) => {
      const result = await window.eve.dispatch(input);
      merge(result.snapshot);
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
    [merge],
  );
  const canvasDrafts = useCanvasDrafts({
    getTask: id => snapshotRef.current?.tasks.find(item => item.id === id),
    dispatch: async input => { const result = await window.eve.dispatch(input); merge(result.snapshot); return result; },
    enqueue,
    onDirty: dirty => { canvasDirty.current = dirty; reportState(); },
  });
  const flushCanvas = canvasDrafts.flush;
  const [canvasSources, setCanvasSources] = useState<Record<string, SourceRecord[]>>({});
  const [canvasRequests, setCanvasRequests] = useState<Record<string, string>>({});
  const [canvasNextStepsRequested, setCanvasNextStepsRequested] = useState<Record<string, boolean>>({});
  const [canvasContextSteps, setCanvasContextSteps] = useState<Record<string, CanvasSuggestionRefreshScope | undefined>>({});
  const [canvasLearningScopes, setCanvasLearningScopes] = useState<Record<string, CanvasSuggestionRefreshScope | undefined>>({});
  const [hiddenResponses, setHiddenResponses] = useState<Record<string, string | undefined>>({});
  const [initializingCanvas, setInitializingCanvas] = useState<string | null>(null);
  const [requestedSources, setRequestedSources] = useState<Record<string, string>>({});
  const [canvasSourcePanels, setCanvasSourcePanels] = useState<Record<string, boolean>>({});
  const [sourceQueries, setSourceQueries] = useState<Record<string, { query: string; kind: "article" | "video" }>>({});
  const canvasRequest = task ? canvasRequests[task.id] ?? "" : "";
  const nextStepsResponse = task && canvasNextStepsRequested[task.id] ? assistance.responses[task.id] : undefined;
  const canvasPending = !!task && (initializingCanvas === task.id || !!assistance.requesting[task.id] || intentIsRunning(assistance.responses[task.id]) || !!nextStepsResponse?.proposals.some(proposal => proposal.status === "ready" || proposal.status === "applying"));
  const inputPending = canvasPending && !(task && canvasLearningScopes[task.id]);
  const activeCanvasProposals = task ? assistance.responses[task.id]?.proposals.filter(proposal => proposal.kind === "canvas" && proposal.status !== "discarded" && proposal.status !== "applied") : undefined;
  const onlyCanvasProposal = activeCanvasProposals?.length === 1 ? activeCanvasProposals[0] : undefined;
  const canvasAdditionProposal = onlyCanvasProposal?.beforeCanvas && onlyCanvasProposal.canvas?.blocks.some(block => !onlyCanvasProposal.beforeCanvas!.blocks.some(before => before.id === block.id)) ? onlyCanvasProposal : undefined;
  const currentContextScope = task ? canvasContextSteps[task.id] : undefined;
  const nextStepsState: CanvasNextStepsState = !task || !canvasNextStepsRequested[task.id] ? "idle" : canvasPending ? "loading" : assistance.messages[task.id] ? "error" :
    nextStepsResponse?.status === "complete" ? nextStepsResponse.proposals[0]?.status === "applied" ? ((canvasDrafts.document(task)?.suggestions ?? []).some(choice => !currentContextScope || choice.targetBlockId === currentContextScope.blockId) ? "ready" : "empty") : "error" :
    nextStepsResponse && ["error", "unavailable", "stale"].includes(nextStepsResponse.status) ? "error" : "idle";
  const nextStepsMessage = task && canvasNextStepsRequested[task.id] ? assistance.messages[task.id] || nextStepsResponse?.proposals.find(proposal => ["error", "stale", "unsupported"].includes(proposal.status))?.message || nextStepsResponse?.message : undefined;
  const setCanvasRequest = (text: string) => { if (task) setCanvasRequests(previous => ({ ...previous, [task.id]: text })); };
  const noteContinuity = useNoteContinuity({
    getTask: (taskId) =>
      snapshotRef.current?.tasks.find((item) => item.id === taskId),
    dispatch: async (input) => {
      const result = await window.eve.dispatch(input);
      merge(result.snapshot);
      return result;
    },
    enqueue,
    onError: setError,
  });
  const persistNotePlace = noteContinuity.persist;
  const noteDrafts = useNoteDrafts({
    pending: pendingNotes,
    snapshot: () => snapshotRef.current,
    dispatch: async (input) => {
      const result = await window.eve.dispatch(input);
      merge(result.snapshot);
      return result;
    },
    enqueue,
    persistPlace: persistNotePlace,
    setSaving,
    onError: setError,
    onNotice: setNotice,
  });
  const flushNote = noteDrafts.flush;
  const imageAttachments = useCanvasImageAttachments({
    activeTaskId: task?.id, visible: activity === "canvas",
    getTask: id => snapshotRef.current?.tasks.find(item => item.id === id),
    isCurrent: id => snapshotRef.current?.activeTaskId === id && activity === "canvas",
    enqueue,
    flush: async id => { await flushCanvas(id); await flushNote({ taskId: id }); },
    assets: (id, assets) => setTaskAssets(previous => ({ ...previous, [id]: assets })),
    snapshot: merge,
  });
  const rename = useRenameTask({
    task: (id) => snapshotRef.current?.tasks.find((item) => item.id === id),
    activeTaskId: () => snapshotRef.current?.activeTaskId ?? null,
    flush: (id) => flushNote({ taskId: id }),
    enqueue,
    merge,
  });
  const queueNote = noteDrafts.queue;
  const dirtyNoteIds = noteDrafts.dirtyIds;
  const flushNavigating = useCallback(
    async () => { await flushCanvas(); await flushNote({ allowConflicts: true }); },
    [flushNote, flushCanvas],
  );
  useEffect(() => {
    if (!window.eve) {
      setError(
        "Open Eve through the desktop application to access your workspace.",
      );
      return;
    }
    void window.eve
      .snapshot()
      .then((value) => {
        merge(value);
        reportState();
        const current = value.tasks.find(
          (task) => task.id === value.activeTaskId,
        );
        setActivity(
          taskActivity(current, current?.checkpoint?.selectedActivity),
        );
      })
      .catch((err) => setError(err.message));
    const off = window.eve.onSnapshot(merge);
    const offError = window.eve.onError(setError);
    const offRecall = window.eve.onRecall(() => toggleOverlay("recall"));
    const offHome = window.eve.onHome(() => homeNavigation.current());
    const offMaterial = window.eve.onMaterial(({ taskId, assetId }) => {
      if (snapshotRef.current?.activeTaskId !== taskId) return;
      setMaterialContext(taskId, assetId);
      setRequestedAssets((previous) => ({
        ...previous,
        [taskId]: { assetId, requestId: uid() },
      }));
      void window.eve
        .assets(taskId)
        .then((assets) =>
          setTaskAssets((previous) => ({ ...previous, [taskId]: assets })),
        )
        .catch((error: Error) => setError(error.message));
    });
    const offPrivacyLock = window.eve.onPrivacyLock(() => {
      imageAttachments.cancelTask();
      ++navigationGeneration.current;
      setEditorNavigation(null);
      closeOverlay();
      setIntent("");
      setCanvasRequests({});
      setCanvasNextStepsRequested({});
      setCanvasContextSteps({});
      setCanvasLearningScopes({});
      setHiddenResponses({});
      clearIntentPresentation();
      clearSystemPresentation();
    });
    const offAskSelection = window.eve.onAskSelection(() => {
      if (!snapshotRef.current?.activeTaskId) return;
      setIntent("Explain this selection");
      const owner = snapshotRef.current?.activeTaskId;
      if (owner) setCanvasRequests(previous => ({ ...previous, [owner]: "Explain this selection" }));
      openOverlay("intent");
    });
    const offAttention = window.eve.onAttention(
      ({ taskId, activity, focusLeaseId, sourceId, sourceQuery, sourceKind }) => {
        const current = snapshotRef.current?.tasks.find(
          (task) => task.id === taskId,
        );
        if (snapshotRef.current?.activeTaskId !== taskId || !current) return;
        const next = taskActivity(current, activity);
        ++navigationGeneration.current;
        setEditorNavigation(
          next === "code" && focusLeaseId
            ? { taskId, leaseId: focusLeaseId }
            : null,
        );
        setActivity(next);
        if (sourceId) {
          setRequestedSources(previous => ({ ...previous, [taskId]: sourceId }));
          if (next === "canvas") setCanvasSourcePanels(previous => ({ ...previous, [taskId]: true }));
          void window.eve.lesson(taskId).then(lesson => setCanvasSources(previous => ({ ...previous, [taskId]: lesson.sources }))).catch(() => {});
        }
        if (sourceQuery) {
          setSourceQueries(previous => ({ ...previous, [taskId]: { query: sourceQuery, kind: sourceKind ?? "article" } }));
          if (next === "canvas") setCanvasSourcePanels(previous => ({ ...previous, [taskId]: true }));
        }
        if (next === "easing")
          setCurveDraft(
            current.parameters?.values.easing ?? [0.22, 1, 0.36, 1],
          );
        if (overlayRef.current?.kind === "intent") closeOverlay();
      },
    );
    const offClose = window.eve.onPrepareClose(() => {
      void (async () => {
        // A write can finish while a newer edit is still waiting. Drain the
        // actual queues, then report their real state before acknowledging exit.
        for (let attempt = 0; attempt < 3; attempt++) {
          await interactionTail.current;
          await flushCanvas();
          await flushNote();
          reportState();
          if (
            pendingNotes.current.size === 0 && !canvasDirty.current &&
            !saveBusy.current &&
            mutationCount.current === 0
          ) {
            window.eve.readyToClose();
            return;
          }
        }
        throw new Error(
          "New changes are still being saved. Please try closing again when they finish.",
        );
      })().catch((err) => {
        setError(`Please save your changes before closing. ${err.message}`);
        reportState();
        window.eve.closeCancelled();
      });
    });
    const updateStatus = () => {
      void window.eve
        .status()
        .then(setHost)
        .catch((err: Error) => setError(err.message));
    };
    updateStatus();
    const id = setInterval(updateStatus, 3000);
    return () => {
      off();
      offError();
      offRecall();
      offHome();
      offAskSelection();
      offPrivacyLock();
      offMaterial();
      offAttention();
      offClose();
      clearInterval(id);
    };
  }, [
    merge,
    flushNote,
    toggleOverlay,
    closeOverlay,
    openOverlay,
    reportState,
    clearIntentPresentation,
    clearSystemPresentation,
    setMaterialContext,
  ]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.defaultPrevented ||
        event.repeat
      )
        return;
      const primary =
        host?.platform === "darwin"
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
      if (primary && event.shiftKey && !event.altKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        homeNavigation.current();
        return;
      }
      if (
        primary &&
        event.altKey &&
        !event.shiftKey &&
        (event.code === "KeyK" || event.key.toLowerCase() === "k")
      ) {
        event.preventDefault();
        toggleOverlay("recall");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [host?.platform, toggleOverlay]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    setVisitedNotes((previous) => {
      const recent =
        task && notebookOpen
          ? [...previous.filter((id) => id !== task.id), task.id]
          : previous;
      const next = retainedNoteIds(
        recent,
        task && (notebookOpen || previous.includes(task.id)) ? task.id : null,
        dirtyNoteIds,
      );
      return previous.length === next.length &&
        previous.every((id, index) => id === next[index])
        ? previous
        : next;
    });
    if (intentTask.current !== (task?.id ?? null)) {
      intentTask.current = task?.id ?? null;
      ++previewRevision.current;
      setDraft(null);
      setIntent("");
      if (
        overlayRef.current?.kind === "intent" ||
        overlayRef.current?.kind === "system"
      )
        closeOverlay();
    }
  }, [task?.id, notebookOpen, closeOverlay, dirtyNoteIds]);
  useEffect(() => {
    if (task && activity !== "video") {
      const material = selectedMaterials.current.get(task.id);
      if (activity === "notes" && material)
        setMaterialContext(task.id, material);
      else setSourceContext(task.id, null);
    }
  }, [task?.id, activity, setSourceContext, setMaterialContext]);
  const restoreNoteViewport = useCallback(
    (taskId: string) => {
      const current = snapshotRef.current?.tasks.find(
        (item) => item.id === taskId,
      );
      if (
        !current ||
        !readyNoteEditors.current.has(taskId) ||
        restoredNoteViewport.current === taskId ||
        snapshotRef.current?.activeTaskId !== taskId ||
        !workspace.current ||
        !workspace.current.classList.contains("note-workspace")
      )
        return;
      const region = workspace.current;
      const top = Math.min(
        noteContinuity.position(current),
        Math.max(0, region.scrollHeight - region.clientHeight),
      );
      region.scrollTop = top;
      restoredNoteViewport.current = taskId;
    },
    [noteContinuity.position],
  );
  const activeNoteViewport = notebookOpen ? (task?.id ?? null) : null;
  useLayoutEffect(() => {
    restoredNoteViewport.current = null;
    if (activeNoteViewport) restoreNoteViewport(activeNoteViewport);
  }, [activeNoteViewport, restoreNoteViewport]);
  const keptNoteIds = retainedNoteIds(
    visitedNotes,
    task && (notebookOpen || visitedNotes.includes(task.id)) ? task.id : null,
    dirtyNoteIds,
  );
  useEffect(() => {
    const keep = new Set(keptNoteIds);
    noteContinuity.prune(keep);
    for (const id of readyNoteEditors.current)
      if (!keep.has(id)) readyNoteEditors.current.delete(id);
  }, [
    visitedNotes,
    task?.id,
    notebookOpen,
    dirtyNoteIds,
    noteContinuity.prune,
  ]);
  useEffect(() => {
    if (!task || (!notebookOpen && activity !== "canvas")) return;
    let cancelled = false;
    void window.eve.lesson(task.id).then(lesson => { if (!cancelled) setCanvasSources(previous => ({ ...previous, [task.id]: lesson.sources })); }).catch(() => {});
    void window.eve
      .assets(task.id)
      .then((assets) => {
        if (!cancelled)
          setTaskAssets((previous) => ({ ...previous, [task.id]: assets }));
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.canvas?.revision, notebookOpen, activity]);
  const values = draft ?? task?.parameters?.values;
  const currentTask = (id = task?.id) =>
    snapshotRef.current?.tasks.find((item) => item.id === id);
  const requestEditorFocus = (taskId: string | undefined, next: Activity) =>
    next === "code" && taskId
      ? window.eve.beginEditorNavigation(taskId).catch(() => null)
      : Promise.resolve(null);
  const navigate = (
    next: Activity,
    returning = false,
    requestedFocus?: Promise<string | null>,
  ) => {
    const ownerId = task?.id;
    if (next !== "canvas") imageAttachments.cancelTask(ownerId);
    const generation = ++navigationGeneration.current;
    const focus = requestedFocus ?? requestEditorFocus(ownerId, next);
    if (next !== "code") setEditorNavigation(null);
    return enqueue(async () => {
      await flushNavigating();
      const current = currentTask();
      if (
        !current ||
        generation !== navigationGeneration.current ||
        snapshotRef.current?.activeTaskId !== ownerId ||
        current.id !== ownerId
      )
        return false;
      if (!taskCapabilities(current).activities.includes(next)) return false;
      const focusLeaseId = await focus;
      if (
        generation !== navigationGeneration.current ||
        snapshotRef.current?.activeTaskId !== ownerId
      )
        return false;
      if (next === activity) {
        setEditorNavigation(
          focusLeaseId ? { taskId: ownerId, leaseId: focusLeaseId } : null,
        );
        return true;
      }
      const {
        revision: _revision,
        updatedAt: _updatedAt,
        ...previousCheckpoint
      } = current.checkpoint ?? {};
      await command({
        type: "SaveCheckpoint",
        requestId: uid(),
        taskId: current.id,
        expectedEpoch: current.epoch,
        expectedRevision: current.checkpoint?.revision ?? 0,
        checkpoint: {
          ...previousCheckpoint,
          layout: next === "easing" || next === "video" ? "learn" : "work",
          selectedActivity: next,
          returnAnchors:
            next === "easing" || next === "video"
              ? returning
                ? (current.checkpoint?.returnAnchors ?? []).slice(0, -1)
                : [
                    ...(current.checkpoint?.returnAnchors ?? []),
                    activity,
                  ].slice(-20)
              : [],
        },
      });
      if (
        generation !== navigationGeneration.current ||
        snapshotRef.current?.activeTaskId !== ownerId
      )
        return false;
      setEditorNavigation(
        next === "code" && focusLeaseId
          ? { taskId: ownerId, leaseId: focusLeaseId }
          : null,
      );
      setActivity(next);
      if (next === "easing")
        setCurveDraft(current.parameters?.values.easing ?? [0.22, 1, 0.36, 1]);
      return true;
    }).catch((err: Error) => {
      if (snapshotRef.current?.activeTaskId === ownerId) setError(err.message);
      return false;
    });
  };
  const returnToPrevious = () =>
    navigate(taskActivity(task, task?.checkpoint?.returnAnchors.at(-1)), true);
  const projectSetup = useProjectSetup({
    activeTaskId: () => snapshotRef.current?.activeTaskId ?? null,
    task: (taskId) =>
      snapshotRef.current?.tasks.find((item) => item.id === taskId),
    flush: (taskId) => flushNote({ taskId }),
    enqueue,
    merge,
    openCode: async (taskId, focusLeaseId) => {
      if (snapshotRef.current?.activeTaskId === taskId)
        await navigate("code", false, Promise.resolve(focusLeaseId ?? null));
    },
  });
  const selectTask = (next: TaskRecord) => {
    const generation = ++navigationGeneration.current;
    const focus = requestEditorFocus(
      next.id,
      taskActivity(next, next.checkpoint?.selectedActivity),
    );
    setEditorNavigation(null);
    return enqueue(async () => {
      await flushNavigating();
      if (generation !== navigationGeneration.current) return;
      const result = await command({
        type: "RecallTask",
        requestId: uid(),
        taskId: next.id,
      });
      const latest = result.snapshot.tasks.find((t) => t.id === next.id)!;
      const selectedActivity = taskActivity(
        latest,
        latest.checkpoint?.selectedActivity,
      );
      const focusLeaseId = await focus;
      if (
        generation !== navigationGeneration.current ||
        snapshotRef.current?.activeTaskId !== next.id
      )
        return;
      setEditorNavigation(
        selectedActivity === "code" && focusLeaseId
          ? { taskId: next.id, leaseId: focusLeaseId }
          : null,
      );
      setActivity(selectedActivity);
      closeOverlay();
      setDraft(null);
      setError("");
    }).catch((err: Error) => setError(err.message));
  };
  const createTask = (title: string) => {
    ++navigationGeneration.current;
    setEditorNavigation(null);
    return enqueue(async () => {
      await flushNavigating();
      await command({
        type: "CreateTask",
        requestId: uid(),
        title,
        kind: "note",
      });
      closeOverlay();
      setActivity("notes");
    }).catch((err: Error) => setError(err.message));
  };
  const createCanvas = (request: string) => {
    const text = request.trim(); if (!text) return;
    const generation = ++navigationGeneration.current;
    setEditorNavigation(null);
    void enqueue(async () => {
      await flushNavigating();
      if (generation !== navigationGeneration.current) return;
      const result = await command({ type: "CreateTask", requestId: uid(), title: text.length > 65 ? text.slice(0, 62) + "…" : text, description: text.slice(0, 1000), kind: "note" });
      const created = result.snapshot.tasks.find(item => item.id === result.snapshot.activeTaskId)!;
      setInitializingCanvas(created.id);
      setCanvasRequests(previous => ({ ...previous, [created.id]: text }));
      await command({ type: "SaveCheckpoint", requestId: uid(), taskId: created.id, expectedEpoch: created.epoch, expectedRevision: 0, checkpoint: { layout: "work", selectedActivity: "canvas", returnAnchors: [] } });
      closeOverlay(); setActivity("canvas");
      return result.snapshot.activeTaskId!;
    }).then(id => id && assistance.submit(id, text, async () => { if (snapshotRef.current?.activeTaskId !== id || generation !== navigationGeneration.current) throw new Error("Open this space to continue."); }, "canvas")).catch((error: Error) => setError(error.message)).finally(() => setInitializingCanvas(null));
  };
  const showHome = () => {
    imageAttachments.cancelTask();
    const generation = ++navigationGeneration.current;
    setEditorNavigation(null);
    closeOverlay();
    void enqueue(async () => {
      // Settle note writes/checkpoints before releasing the task's authority.
      // Conflicted drafts remain mounted and protected, just as during recall.
      await flushNavigating();
      if (generation !== navigationGeneration.current) return;
      const state = snapshotRef.current;
      const current = state?.tasks.find((item) => item.id === state.activeTaskId);
      if (!current) return;
      await command({ type: "ShowHome", requestId: uid(), taskId: current.id, expectedEpoch: current.epoch });
      if (generation !== navigationGeneration.current || snapshotRef.current?.activeTaskId) return;
      ++sourceContextGeneration.current;
      setDraft(null);
      setIntent("");
      setError("");
      setNotice("");
      requestAnimationFrame(() => {
        if (!snapshotRef.current?.activeTaskId) workspace.current?.focus({ preventScroll: true });
      });
    }).catch((error: Error) => setError(error.message));
  };
  useLayoutEffect(() => { homeNavigation.current = showHome; });
  const addMaterial = () =>
    enqueue(async () => {
      const current = currentTask();
      if (!current) return;
      await flushNavigating();
      const result = await window.eve.importAssets(current.id);
      setTaskAssets((previous) => ({
        ...previous,
        [current.id]: result.assets,
      }));
      const material = await window.eve.lesson(current.id);
      setCanvasSources(previous => ({ ...previous, [current.id]: material.sources }));
      if (result.errors.length) {
        setError(result.errors.join(" "));
        return;
      }
      if (result.assets.length > (taskAssets[current.id]?.length ?? 0))
        setNotice("Your material is saved with this space");
    }).catch((error: Error) => setError(error.message));
  const changeParameter = (
    name: keyof OrbitParameters,
    value: OrbitParameters[keyof OrbitParameters],
  ): Promise<boolean> => {
    const ownerId = task?.id;
    if (!ownerId) return Promise.resolve(false);
    const revision = ++previewRevision.current;
    return enqueue(async () => {
      const current = currentTask();
      if (
        !taskCapabilities(current).orbit ||
        !current?.parameters ||
        current.id !== ownerId ||
        snapshotRef.current?.activeTaskId !== ownerId
      )
        return false;
      await command({
        type: "SetParameter",
        requestId: uid(),
        taskId: current.id,
        expectedEpoch: current.epoch,
        expectedRevision: current.parameters.revision,
        name,
        value,
      });
      if (snapshotRef.current?.activeTaskId !== ownerId) return false;
      if (previewRevision.current === revision) {
        setDraft(null);
        await window.eve.previewDraft(ownerId, null);
      }
      setNotice("Updated in your project");
      setError("");
      return true;
    }).catch(async (err: Error) => {
      if (previewRevision.current === revision) {
        setDraft(null);
        await window.eve.previewDraft(ownerId, null).catch(() => undefined);
      }
      if (snapshotRef.current?.activeTaskId === ownerId) setError(err.message);
      return false;
    });
  };
  const cancelPreview = () => {
    const ownerId = task?.id;
    if (!ownerId) return;
    ++previewRevision.current;
    setDraft(null);
    void window.eve.previewDraft(ownerId, null).catch((err: Error) => {
      if (snapshotRef.current?.activeTaskId === ownerId) setError(err.message);
    });
  };
  const previewChange = (
    name: keyof OrbitParameters,
    value: OrbitParameters[keyof OrbitParameters],
  ) => {
    const ownerId = task?.id;
    if (!ownerId || !capabilities.orbit || !values) return;
    ++previewRevision.current;
    const next = { ...values, [name]: value };
    setDraft(next);
    void window.eve.previewDraft(ownerId, next).catch((err: Error) => {
      if (snapshotRef.current?.activeTaskId === ownerId) setError(err.message);
    });
  };
  const undo = () =>
    enqueue(async () => {
      const current = currentTask();
      if (!current) return;
      await flushCanvas(current.id);
      await command({
        type: "Undo",
        taskId: current.id,
        expectedEpoch: current.epoch,
        requestId: uid(),
      });
      setNotice("Change undone");
    }).catch((err: Error) => setError(err.message));
  const setPolicy = (
    change: Partial<
      Pick<TaskRecord["policy"], "processing" | "assistancePaused">
    >,
  ) =>
    enqueue(async () => {
      const current = currentTask();
      if (!current) return;
      await command({
        type: "SetTaskPolicy",
        requestId: uid(),
        taskId: current.id,
        expectedEpoch: current.epoch,
        expectedRevision: current.policy.revision,
        policy: {
          processing: current.policy.processing,
          assistancePaused: current.policy.assistancePaused,
          ...change,
        },
      });
    }).catch((err: Error) => setError(err.message));
  const submitIntent = (text: string, mode?: "canvas" | "ask" | "suggestions" | "learn" | "selection", suggestion?: CanvasSuggestion, refreshScope?: CanvasSuggestionRefreshScope) => {
    const textValue = text.trim();
    const taskId = task?.id;
    if (!textValue || !taskId) return;
    // Freeze the visible item before saving. A later flush must not silently
    // retarget the user's passage offsets or include newer item edits.
    const scopedBlock = refreshScope ? structuredClone(canvasDrafts.document(task)?.blocks.find(block => block.id === refreshScope.blockId)) : undefined;
    const capturedScope = refreshScope ? structuredClone(refreshScope) : undefined;
    const response = assistance.responses[taskId];
    if (assistance.requesting[taskId] || intentIsRunning(response) ||
        (canvasNextStepsRequested[taskId] && response?.proposals.some(proposal =>
          proposal.status === "ready" || proposal.status === "applying"))) return;
    // The hook admits one attempt synchronously before invoking this callback.
    // A competing item/global click cannot relabel an already admitted request.
    return assistance.submit(taskId, textValue, () => {
      setCanvasNextStepsRequested(previous => ({ ...previous, [taskId]: mode === "suggestions" }));
      setCanvasLearningScopes(previous => ({ ...previous, [taskId]: mode === "learn" || mode === "selection" ? capturedScope : undefined }));
      setHiddenResponses(previous => ({ ...previous, [taskId]: undefined }));
      setCanvasContextSteps(previous => ({ ...previous, [taskId]: mode === "suggestions" ? capturedScope : undefined }));
      if (suggestion?.prepared) suggestionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return enqueue(async () => {
        await flushCanvas(taskId);
        await flushNote({ taskId });
        let context;
        do {
          context = sourceContextTail.current;
          await context;
        } while (context !== sourceContextTail.current);
        if (snapshotRef.current?.activeTaskId !== taskId)
          throw new Error("The active space changed. Ask again in this space.");
      });
    }, mode, suggestion ? () => {
        const current = snapshotRef.current?.tasks.find(candidate => candidate.id === taskId)?.canvas;
        const saved = current?.document?.suggestions?.find(candidate => candidate.id === suggestion.id);
        if (!current || !saved || !canvasDataEqual(saved, suggestion))
          throw new Error("This suggestion changed while saving. Choose a current suggestion to continue.");
        return { id: saved.id, canvasRevision: current.revision };
      } : undefined, capturedScope ? () => {
        const current = snapshotRef.current?.tasks.find(candidate => candidate.id === taskId)?.canvas;
        const savedBlock = current?.document?.blocks.find(block => block.id === capturedScope.blockId);
        if (!current?.document || !scopedBlock || !savedBlock || !canvasDataEqual(scopedBlock, savedBlock))
          throw new Error("This item changed while saving. Select the current item or passage to continue.");
        (mode === "learn" || mode === "selection" ? assertCanvasLearningScope : assertCanvasSuggestionRefreshScope)(current.document, capturedScope);
        return { canvasRevision: current.revision, scope: capturedScope };
      } : undefined,
    );
  };
  const reviewCanvasSuggestion = (taskId: string, requestId: string, proposalId: string, operation: "apply" | "discard") => {
    const key = `${requestId}:${proposalId}`;
    if (proposalActions.current.has(key)) return;
    proposalActions.current.add(key);
    const focusAtClick = document.activeElement;
    const originalTrigger = suggestionTrigger.current;
    void enqueue(async () => {
      const response = assistance.responses[taskId];
      const proposal = response?.proposals.find(item => item.id === proposalId);
      if (operation === "discard" && proposal?.status !== "ready") {
        assistance.cancel(taskId, requestId); return;
      }
      await assistance.proposal(taskId, requestId, proposalId, operation, async () => {
        if (operation === "discard") return;
        await flushCanvas(taskId); await flushNote({ taskId });
        let context;
        do { context = sourceContextTail.current; await context; } while (context !== sourceContextTail.current);
        if (snapshotRef.current?.activeTaskId !== taskId) throw new Error("Open this canvas before keeping its suggestion.");
      });
    }).catch((error: Error) => setError(error.message)).finally(() => {
      proposalActions.current.delete(key);
      if (operation === "discard" && snapshotRef.current?.activeTaskId === taskId && originalTrigger?.isConnected &&
          (document.activeElement === document.body || (focusAtClick instanceof HTMLElement && !!focusAtClick.closest(".canvas-suggestion-preview") && document.activeElement === focusAtClick)))
        originalTrigger.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (!task || nextStepsState !== "ready" || !currentContextScope?.selection || !nextStepsResponse || preparedWritingResponses.current.has(nextStepsResponse.requestId)) return;
    preparedWritingResponses.current.add(nextStepsResponse.requestId);
    // Improve writing requests one alternative. Expose its exact preview
    // directly, without another inference, only while that passage is current.
    const selection = currentContextScope.selection;
    const region = document.querySelector(`[data-canvas-block-id="${CSS.escape(currentContextScope.blockId)}"]`);
    const writer = region?.querySelector("textarea.canvas-editable-copy");
    if (!(writer instanceof HTMLTextAreaElement) || !region?.contains(document.activeElement) || writer.selectionStart !== selection.start || writer.selectionEnd !== selection.end || writer.value.slice(selection.start, selection.end) !== selection.text) return;
    const choices = canvasDrafts.document(task)?.suggestions?.filter(choice => choice.prepared && choice.targetBlockId === currentContextScope.blockId && canvasDataEqual(choice.textSelection, selection)) ?? [];
    if (choices.length === 1) void submitIntent(choices[0]!.request, "canvas", choices[0]);
  }, [task, nextStepsState, currentContextScope, nextStepsResponse, canvasDrafts, submitIntent]);
  const dismissAssistance = (taskId: string) => {
    const response = assistance.responses[taskId];
    if (assistance.requesting[taskId] || intentIsRunning(response)) assistance.cancel(taskId);
    setCanvasLearningScopes(previous => ({ ...previous, [taskId]: undefined }));
    setHiddenResponses(previous => ({ ...previous, [taskId]: response?.requestId ?? `message:${assistance.messages[taskId] || ""}` }));
  };
  const openAnswerSource = (taskId: string, sourceId: string) => {
    const response = assistance.responses[taskId];
    if (!response) return;
    void enqueue(async () => { await flushNavigating(); await window.eve.openIntentSource({ requestId: response.requestId, sourceId }); }).catch((error: Error) => setError(error.message));
  };
  const openCanvasSource = (sourceId?: string) => {
    if (!task) return;
    setRequestedSources(previous => ({ ...previous, [task.id]: sourceId ?? "" }));
    setCanvasSourcePanels(previous => ({ ...previous, [task.id]: true }));
  };
  const reloadPreview = () => {
    const ownerId = task?.id;
    if (!ownerId || reloadingPreview || capabilities.orbit) return;
    setReloadingPreview(ownerId);
    void enqueue(async () => {
      if (snapshotRef.current?.activeTaskId !== ownerId) return;
      const result = await window.eve.reloadPreview(ownerId);
      if (snapshotRef.current?.activeTaskId !== ownerId) return;
      if (!result.reloaded)
        throw new Error(result.message || "The preview could not reload.");
      setNotice("Preview reloaded from your project.");
    })
      .catch((error: Error) => {
        if (snapshotRef.current?.activeTaskId === ownerId)
          setError(error.message);
      })
      .finally(() => setReloadingPreview(null));
  };
  const overlayAction = useRef<(action: OverlayAction) => void>(() => {});
  useLayoutEffect(() => {
    overlayAction.current = (action) => {
      const active = overlayRef.current;
      if (!active || active.instanceId !== action.instanceId) return;
      if (action.type === "close") {
        closeOverlay();
        return;
      }
      if (action.type === "select-task" && active.kind === "recall") {
        const selected = snapshotRef.current?.tasks.find(
          (item) => item.id === action.taskId,
        );
        if (selected) void selectTask(selected);
      } else if (action.type === "create-task" && active.kind === "recall") {
        void createTask(action.title);
      } else if (
        "taskId" in action &&
        action.taskId === snapshotRef.current?.activeTaskId
      ) {
        if (
          active.kind === "intent" &&
          (action.type === "intent-change" || action.type === "intent-submit")
        ) {
          setIntent(action.text);
          if (action.type === "intent-submit") submitIntent(action.text);
        } else if (
          active.kind === "intent" &&
          action.type === "intent-cancel"
        ) {
          assistance.cancel(action.taskId, action.requestId);
        } else if (
          active.kind === "intent" &&
          (action.type === "proposal-apply" ||
            action.type === "proposal-discard")
        ) {
          const key = `${action.requestId}:${action.proposalId}`;
          if (proposalActions.current.has(key)) return;
          proposalActions.current.add(key);
          void enqueue(() =>
            assistance.proposal(
              action.taskId,
              action.requestId,
              action.proposalId,
              action.type === "proposal-apply" ? "apply" : "discard",
              async () => {
                if (action.type !== "proposal-apply") return;
                await flushCanvas(action.taskId); await flushNote({ taskId: action.taskId });
                let context;
                do { context = sourceContextTail.current; await context; } while (context !== sourceContextTail.current);
                if (snapshotRef.current?.activeTaskId !== action.taskId) throw new Error("Open this space before applying its suggestion.");
              },
            ),
          )
            .catch((error: Error) => setError(error.message))
            .finally(() => proposalActions.current.delete(key));
        } else if (
          active.kind === "intent" &&
          action.type === "intent-source-open"
        ) {
          void enqueue(async () => {
            await flushNavigating();
            await window.eve.openIntentSource({
              requestId: action.requestId,
              sourceId: action.sourceId,
            });
          }).catch((error: Error) => setError(error.message));
        } else if (
          active.kind === "system" &&
          action.type === "system-action"
        ) {
          // The host asks this renderer to settle edits before a session exit.
          // Keeping the request out of interactionTail avoids waiting on itself.
          void systemControls.perform(action.action);
        } else if (
          active.kind === "system" &&
          action.type === "system-networks"
        ) {
          void systemControls.loadNetworks();
        } else if (active.kind === "system" && action.type === "set-policy")
          void setPolicy(action.policy);
      }
    };
  });
  useEffect(
    () =>
      window.eve?.onOverlayAction((action) => overlayAction.current(action)),
    [],
  );
  useEffect(() => {
    if (!window.eve) return;
    let state: OverlayState | null = null;
    if (overlay && snapshot) {
      const common = {
        instanceId: overlay.instanceId,
        busy: pendingOperations > 0,
        message: error || undefined,
      };
      if (overlay.kind === "recall") state = {
        ...common, kind: "recall",
        tasks: snapshot.tasks.map(({ id, title, description, kind }) => ({ id, title, description, kind })),
        current: task?.id ?? null,
      };
      else if (overlay.kind === "intent" && task) state = {
        ...common, kind: "intent", taskId: task.id, title: task.title, text: intent,
        response: assistance.responses[task.id], requesting: assistance.requesting[task.id],
        settings: assistance.settings, policy: { processing: task.policy.processing, assistancePaused: task.policy.assistancePaused },
        message: error || assistance.messages[task.id] || undefined,
      };
      else if (overlay.kind === "system") state = {
        ...common, kind: "system", taskId: task?.id ?? null, host,
        system: systemControls.status, savedNetworks: systemControls.networks,
        systemLoading: systemControls.loading, networksLoading: systemControls.networksLoading,
        systemBusy: systemControls.busy, systemMessage: systemControls.message || undefined,
        systemError: systemControls.error,
        policy: task ? { processing: task.policy.processing, assistancePaused: task.policy.assistancePaused } : null,
      };
    }
    void window.eve.setOverlay(state).catch((err: Error) => {
      closeOverlay();
      setError(err.message);
    });
  }, [
    overlay,
    task,
    snapshot,
    host,
    intent,
    assistance.responses,
    assistance.requesting,
    assistance.messages,
    assistance.settings,
    systemControls.status,
    systemControls.networks,
    systemControls.loading,
    systemControls.networksLoading,
    systemControls.busy,
    systemControls.message,
    systemControls.error,
    error,
    pendingOperations,
    closeOverlay,
  ]);
  if (!snapshot)
    return (
      <div className="boot">
        <Logo />
        <p>{error || "Making room for your work…"}</p>
      </div>
    );
  const noteSaveError = task && noteDrafts.errors[task.id];
  const noteConflict = task && noteDrafts.conflicts[task.id];
  const activeNoteDirty = !!task && dirtyNoteIds.has(task.id);
  const copyingNote = !!task && noteDrafts.copyingIds.has(task.id);
  const assistancePaused = task?.policy.assistancePaused ?? false;
  const busy = saving || pendingOperations > 0;
  const retainedNotes = snapshot.tasks.filter((item) =>
    keptNoteIds.includes(item.id),
  );
  return (
    <div className={`eve-app${task ? "" : " is-home"}`}>
      <header className="shell-header">
        <button
          className="brand-button"
          onClick={showHome}
          aria-label="Go home"
          title="Home"
        >
          <Logo />
          <span className="brand-dot" />
        </button>
        <div className="purpose">
          {task ? <>
            <button className="icon-button" aria-label={activity === "easing" || activity === "video" ? "Back to previous activity" : "Return home"}
              title={activity === "easing" || activity === "video" ? "Back" : "Home"}
              onClick={() => activity === "easing" || activity === "video" ? void returnToPrevious() : showHome()}>
              {activity === "easing" || activity === "video" ? <ArrowLeft size={19} /> : <House size={18} />}
            </button>
            <span className="header-divider" />
            <TaskTitle key={task.id} title={task.title} state={rename.states[task.id]}
              onRecall={() => openOverlay("recall")} onBegin={() => rename.begin(task.id)}
              onChange={(value) => rename.change(task.id, value)} onDismiss={() => rename.dismiss(task.id)}
              onReview={() => rename.review(task.id)} onSubmit={() => rename.submit(task.id)} />
          </> : <span className="home-location"><House size={15} /> Home</span>}
        </div>
        <div className="system-bar">
          {task && activity !== "canvas" && <button className="quiet-button" aria-label="Open canvas" onClick={() => void navigate("canvas")}><Sparkles size={15} />Canvas</button>}
          <Clock />
          <button
            className="icon-button"
            onClick={() => toggleOverlay("system")}
            aria-label="Workspace settings"
            aria-haspopup="dialog"
            aria-expanded={overlay?.kind === "system"}
          >
            <Settings2 size={20} />
          </button>
        </div>
      </header>
      <main
        ref={workspace}
        tabIndex={task ? undefined : -1}
        aria-label={task ? undefined : "Home"}
        onScroll={(event) => {
          if (notebookOpen)
            noteContinuity.scroll(task.id, event.currentTarget.scrollTop);
        }}
        className={`workspace ${!task ? "home-workspace" : activity === "canvas" ? "canvas-workspace" : notebookOpen ? "note-workspace" : activity === "video" && !capabilities.orbit ? "learning-workspace" : "project-workspace"}`}
      >
        {!task && <Home tasks={snapshot.tasks} busy={busy}
          onOpenTask={(id) => { const selected = snapshotRef.current?.tasks.find((item) => item.id === id); if (selected) void selectTask(selected); }}
          onCompose={createCanvas} onCreate={(title) => void createTask(title)} onFind={() => openOverlay("recall")} />}
        {task && capabilities.orbit && !notebookOpen && activity !== "canvas" && (
          <>
            <div className="workspace-heading">
              <div>
                <div className="eyebrow">
                  <span className="tiny-orbit" />
                  YOUR STUDY TIMER
                </div>
                <h1>
                  {activity === "easing"
                    ? "A feeling, in motion."
                    : activity === "video"
                      ? "Follow your curiosity."
                      : "Make room for focus."}
                </h1>
                <p className="subtitle">
                  {activity === "easing"
                    ? "Shape the transition. See how it feels. Make it yours."
                    : "A calmer rhythm for the things you want to make."}
                </p>
              </div>
              <button
                className="quiet-button project-files"
                onClick={() => void window.eve.openProject()}
              >
                <FolderOpen size={17} />
                Project files
                <ArrowUpRight size={14} />
              </button>
            </div>
            <div
              className={`project-layout ${activity === "video" ? "learning-layout" : ""}`}
            >
              <section className="primary-activity">
                {activity === "easing" ? (
                  <div className="easing-workspace">
                    <div className="activity-toolbar">
                      <span className="activity-title">
                        <SlidersHorizontal size={16} />
                        Transition studio
                      </span>
                      <span className="caption">Connected to Orbit</span>
                    </div>
                    <div className="easing-experiment">
                      <div className="curve-panel">
                        <div className="eyebrow">THE SHAPE OF CHANGE</div>
                        <Curve
                          value={curveDraft}
                          interactive
                          onChange={setCurveDraft}
                        />
                        <code>{curveLabel(curveDraft)}</code>
                        <div className="preset-row">
                          {(
                            [
                              { name: "Linear", value: [0, 0, 1, 1] },
                              { name: "Gentle", value: [0.22, 1, 0.36, 1] },
                              { name: "Balanced", value: [0.65, 0, 0.35, 1] },
                            ] as const
                          ).map((preset) => (
                            <button
                              key={preset.name}
                              className={
                                preset.value.every(
                                  (v, i) => v === curveDraft[i],
                                )
                                  ? "active"
                                  : ""
                              }
                              aria-pressed={preset.value.every(
                                (value, index) => value === curveDraft[index],
                              )}
                              onClick={() => setCurveDraft([...preset.value])}
                            >
                              {preset.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="motion-panel">
                        <div
                          className="motion-orbit"
                          key={experiment}
                          style={{
                            animationTimingFunction: curveLabel(curveDraft),
                            animationDuration: `${values?.transitionMs ?? 260}ms`,
                          }}
                        >
                          <span />
                        </div>
                        <p>
                          Every ending
                          <br />
                          <em>is a new beginning.</em>
                        </p>
                        <button
                          className="quiet-button"
                          onClick={() => setExperiment((v) => v + 1)}
                        >
                          <Play size={14} />
                          Replay transition
                        </button>
                      </div>
                    </div>
                    <div className="easing-footer">
                      <span>
                        Drag a handle, adjust its values, or choose a starting
                        point.
                      </span>
                      <button
                        className="primary-button"
                        onClick={() => {
                          const destination =
                            [...(task.checkpoint?.returnAnchors ?? [])]
                              .reverse()
                              .find(
                                (activity) =>
                                  activity === "preview" || activity === "code",
                              ) ?? "preview";
                          const focus = requestEditorFocus(
                            task.id,
                            destination,
                          );
                          void changeParameter("easing", curveDraft).then(
                            (applied) => {
                              if (applied)
                                return navigate(destination, true, focus);
                            },
                          );
                        }}
                      >
                        Use this in Orbit
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  </div>
                ) : activity === "video" ? (
                  <LearningActivity
                    key={task.id}
                    taskId={task.id}
                    overlayOpen={!!overlay}
                    onSourceContext={setSourceContext}
                    beforeAttach={flushNavigating}
                    runMutation={enqueue}
                    onBack={() => void returnToPrevious()}
                    onTryCurve={() => void navigate("easing")}
                  />
                ) : (
                  <div className="project-frame">
                    <div className="activity-toolbar">
                      <span className="activity-title">
                        <span className="tiny-orbit" />
                        Orbit
                        <span className="live-badge">
                          <span />
                          {activity === "code"
                            ? host?.workbench === "ready"
                              ? "Connected"
                              : "Opening"
                            : host?.preview === "ready"
                              ? "Live"
                              : "Opening"}
                        </span>
                      </span>
                      <ProjectActivities
                        task={task}
                        activity={activity}
                        onChange={(next) => void navigate(next)}
                      />
                    </div>
                    <ActivitySurface
                      kind={activity === "code" ? "workbench" : "preview"}
                      taskId={task.id}
                      focusLeaseId={
                        activity === "code" &&
                        editorNavigation?.taskId === task.id
                          ? editorNavigation.leaseId
                          : undefined
                      }
                    />
                    <div className="frame-footer">
                      <span>
                        <span className="status-dot" />
                        {host?.preview === "ready"
                          ? "Running from your project"
                          : "Preparing project"}
                      </span>
                      <span>Changes stay with your work</span>
                    </div>
                  </div>
                )}
                <div className="place-saved">
                  <Bookmark size={16} />
                  <span>
                    {activity === "easing"
                      ? "Your place in Orbit is saved"
                      : "Your place is saved"}
                  </span>
                  <span className="middle-dot">·</span>
                  <button
                    onClick={() =>
                      void navigate(activity === "easing" ? "preview" : "code")
                    }
                  >
                    {activity === "easing" ? "Back to making" : "See the code"}
                    <ArrowRight size={14} />
                  </button>
                </div>
              </section>
              {activity !== "video" && (
                <aside className="context-panel">
                  <div className="panel-heading">
                    <h2>
                      {activity === "easing"
                        ? "The little details"
                        : "Make it yours"}
                    </h2>
                    <SlidersHorizontal size={18} />
                  </div>
                  <p className="panel-intro">
                    Small changes. A different feeling.
                  </p>
                  <div className="inspector-section">
                    <div className="field-label">
                      <span>Color</span>
                      <span className="field-value">
                        {values?.theme.toUpperCase()}
                      </span>
                    </div>
                    <div className="color-options">
                      {colors.map((color) => (
                        <button
                          key={color}
                          aria-label={`Set theme ${color}`}
                          aria-pressed={
                            values?.theme.toUpperCase() === color.toUpperCase()
                          }
                          className={`swatch ${values?.theme.toUpperCase() === color.toUpperCase() ? "selected" : ""}`}
                          style={{ "--swatch": color } as React.CSSProperties}
                          onClick={() => void changeParameter("theme", color)}
                        >
                          {values?.theme.toUpperCase() ===
                            color.toUpperCase() && <Check size={17} />}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="inspector-section">
                    <label className="field-label" htmlFor="duration">
                      Focus session
                      <span className="field-value">
                        {values?.durationMinutes} min
                      </span>
                    </label>
                    <input
                      id="duration"
                      aria-label="Focus session duration"
                      type="range"
                      min="5"
                      max="60"
                      step="5"
                      value={values?.durationMinutes ?? 25}
                      onChange={(e) =>
                        previewChange("durationMinutes", Number(e.target.value))
                      }
                      onPointerDown={(e) =>
                        e.currentTarget.setPointerCapture(e.pointerId)
                      }
                      onPointerCancel={cancelPreview}
                      onBlur={() => {
                        if (draft) cancelPreview();
                      }}
                      onPointerUp={(e) =>
                        void changeParameter(
                          "durationMinutes",
                          Number(e.currentTarget.value),
                        )
                      }
                      onKeyUp={(e) => {
                        if (
                          [
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                            "PageUp",
                            "PageDown",
                          ].includes(e.key)
                        )
                          void changeParameter(
                            "durationMinutes",
                            Number(e.currentTarget.value),
                          );
                      }}
                    />
                    <div className="range-labels">
                      <span>A quick reset</span>
                      <span>A deep dive</span>
                    </div>
                    <p className="field-help">
                      For your next session. Your current focus stays
                      uninterrupted.
                    </p>
                  </div>
                  <div className="inspector-section motion-setting">
                    <div className="field-label">
                      Transition
                      <span className="field-value">
                        {values?.transitionMs} ms
                      </span>
                    </div>
                    <input
                      aria-label="Transition duration"
                      type="range"
                      min="100"
                      max="1200"
                      step="20"
                      value={values?.transitionMs ?? 260}
                      onChange={(e) =>
                        previewChange("transitionMs", Number(e.target.value))
                      }
                      onPointerDown={(e) =>
                        e.currentTarget.setPointerCapture(e.pointerId)
                      }
                      onPointerCancel={cancelPreview}
                      onBlur={() => {
                        if (draft) cancelPreview();
                      }}
                      onPointerUp={(e) =>
                        void changeParameter(
                          "transitionMs",
                          Number(e.currentTarget.value),
                        )
                      }
                      onKeyUp={(e) => {
                        if (
                          [
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                            "PageUp",
                            "PageDown",
                          ].includes(e.key)
                        )
                          void changeParameter(
                            "transitionMs",
                            Number(e.currentTarget.value),
                          );
                      }}
                    />
                    <button
                      className="curve-summary"
                      onClick={() => void navigate("easing")}
                    >
                      <svg viewBox="0 0 70 35">
                        <path d="M2 32 C16 32 18 3 68 3" />
                      </svg>
                      <span>
                        Shape the movement
                        <small>Explore the easing curve</small>
                      </span>
                      <ArrowUpRight size={17} />
                    </button>
                  </div>
                  <div className="related-section">
                    <div className="eyebrow">A LITTLE INSPIRATION</div>
                    <button
                      className="related-action"
                      onClick={() => void navigate("video")}
                    >
                      <span className="related-icon">
                        <Sparkles size={19} />
                      </span>
                      <span>
                        Why some motion feels better
                        <small>Explore, then try it in your project</small>
                      </span>
                      <ArrowUpRight size={17} />
                    </button>
                  </div>
                  <div className="change-status" role="status">
                    <Check size={15} />
                    <span>
                      {busy
                        ? "Saving your change…"
                        : "Changes are yours to keep"}
                    </span>
                    <button onClick={() => void undo()}>Undo</button>
                  </div>
                </aside>
              )}
            </div>
          </>
        )}
        {task && capabilities.project &&
          !capabilities.orbit &&
          (activity === "code" || activity === "preview") && (
            <>
              <div className="workspace-heading">
                <div>
                  <div className="eyebrow">YOUR PROJECT</div>
                  <h1>{task.title}</h1>
                  <p className="subtitle">
                    {task.description ||
                      "A place for the things you are making."}
                  </p>
                </div>
              </div>
              <section
                className="project-frame generic-project-frame"
                aria-label={`${task.title} activity`}
              >
                <div className="activity-toolbar">
                  <span className="activity-title">
                    <FolderOpen size={16} />
                    {task.title}
                  </span>
                  <ProjectActivities
                    task={task}
                    activity={activity}
                    onChange={(next) => void navigate(next)}
                  />
                </div>
                <ActivitySurface
                  kind={activity === "code" ? "workbench" : "preview"}
                  taskId={task.id}
                  focusLeaseId={
                    activity === "code" && editorNavigation?.taskId === task.id
                      ? editorNavigation.leaseId
                      : undefined
                  }
                />
                <div className="frame-footer">
                  {activity === "preview" ? (
                    <button
                      className="quiet-button"
                      onClick={reloadPreview}
                      disabled={reloadingPreview === task.id || busy}
                    >
                      <RotateCw size={14} />
                      {reloadingPreview === task.id
                        ? "Reloading preview…"
                        : "Reload preview"}
                    </button>
                  ) : (
                    <span>Your project, in this space</span>
                  )}
                  <button
                    className="quiet-button"
                    onClick={() => void navigate("notes")}
                  >
                    <FileText size={14} />
                    Keep a thought
                  </button>
                </div>
              </section>
            </>
          )}
        {task && !capabilities.orbit && activity === "video" && (
          <>
            <div className="workspace-heading">
              <div>
                <div className="eyebrow">
                  CONNECTED TO {task.title.toUpperCase()}
                </div>
                <h1>Follow your curiosity.</h1>
                <p className="subtitle">
                  Bring a useful reference into the thought.
                </p>
              </div>
            </div>
            <LearningActivity
              key={task.id}
              taskId={task.id}
              initialSourceId={requestedSources[task.id] || undefined}
              initialQuery={sourceQueries[task.id]?.query} sourceKind={sourceQueries[task.id]?.kind}
              onSourcesChanged={(taskId, sources) => setCanvasSources(previous => ({ ...previous, [taskId]: sources }))}
              onAsk={text => { void submitIntent(text, "ask"); }}
              overlayOpen={!!overlay}
              onSourceContext={setSourceContext}
              beforeAttach={flushNavigating}
              runMutation={enqueue}
              onBack={() => void returnToPrevious()}
            />
          </>
        )}
        {task && activity === "canvas" && <section className={`canvas-space ${canvasSourcePanels[task.id] ? "has-source-pane" : ""}`}>
          <div className="canvas-space-navigation">
            <button className="quiet-button" onClick={() => void navigate("notes")}><FileText size={15} />Notebook</button>
            <button className="quiet-button" onClick={() => openCanvasSource()}><BookOpen size={15} />Sources</button>
            {capabilities.code && <button className="quiet-button" onClick={() => void navigate("code")}><Code2 size={15} />Code</button>}
          </div>
          <div className="canvas-space-body"><div className="canvas-primary">
          {canvasDrafts.document(task) ? <Canvas key={task.id} document={canvasDrafts.document(task)!}
            assets={taskAssets[task.id] ?? []} sources={canvasSources[task.id] ?? []}
            onChange={document => { setCanvasLearningScopes(previous => ({ ...previous, [task.id]: undefined })); imageAttachments.cancelTask(task.id); if (assistance.requesting[task.id] || intentIsRunning(assistance.responses[task.id])) assistance.cancel(task.id); canvasDrafts.queue(task.id, document); }}
            onAttachImage={(blockId, assetId) => imageAttachments.attach(task.id, blockId, assetId)}
            imageAttachments={imageAttachments.states[task.id]}
            onCancelImageAttachment={() => imageAttachments.cancelTask(task.id)}
            onCheckImageAttachment={blockId => imageAttachments.check(task.id, blockId)}
            onOpenNote={() => void navigate("notes")} onAddMaterial={() => void addMaterial()}
            onOpenSource={openCanvasSource} onAddSource={() => openCanvasSource()}
            requestPending={canvasPending}
            onLearnAboutSelection={scope => { if (!canvasPending) void submitIntent("Explain the idea in this selected passage briefly. Distinguish established knowledge from uncertainty; do not change my writing.", "learn", undefined, scope); }}
            onAskAboutSelection={(text, scope) => { void submitIntent(text, "selection", undefined, scope); }}
            selectionInsight={canvasLearningScopes[task.id] && !assistance.responses[task.id]?.proposals.some(proposal => proposal.kind === "canvas" && proposal.status !== "discarded") ? { scope: canvasLearningScopes[task.id]!, pending: canvasPending, onCancel: () => assistance.cancel(task.id), content: canvasPending ? null : <ContextualAnswer response={assistance.responses[task.id]} message={assistance.messages[task.id]} onDismiss={() => dismissAssistance(task.id)} onOpenSource={sourceId => openAnswerSource(task.id, sourceId)} /> } : undefined}
            onRequestContextSteps={scope => { if (!canvasPending) void submitIntent(scope.selection
              ? "Suggest one clearer version of this selected passage using plain language. Preserve my meaning, voice, facts, and uncertainty. If it is already clear, leave it unchanged."
              : "Suggest useful next steps for this item. Prepare exact options I can choose while keeping the current work unchanged.", "suggestions", undefined, scope); }}
            contextSteps={currentContextScope ? { scope: currentContextScope, state: nextStepsState, message: nextStepsMessage } : undefined}
            onCancelContextSteps={() => { assistance.cancel(task.id); setCanvasNextStepsRequested(previous => ({ ...previous, [task.id]: false })); setCanvasContextSteps(previous => ({ ...previous, [task.id]: undefined })); }}
            onRequestSuggestion={suggestion => { if (!canvasPending) void submitIntent(suggestion.request, "canvas", suggestion); }}
            proposedChange={canvasAdditionProposal ? {
              proposal: canvasAdditionProposal,
              onKeep: () => reviewCanvasSuggestion(task.id, assistance.responses[task.id]!.requestId, canvasAdditionProposal.id, "apply"),
              onDismiss: () => reviewCanvasSuggestion(task.id, assistance.responses[task.id]!.requestId, canvasAdditionProposal.id, "discard"),
            } : undefined}
            suggestionPreview={(() => {
              if (canvasAdditionProposal) return undefined;
              const response = assistance.responses[task.id];
              const proposals = response?.proposals.filter(item => item.kind === "canvas" && item.status !== "discarded" && item.status !== "applied");
              if (!response || !proposals?.length) return undefined;
              const proposal = proposals[0]!;
              const selected = proposal.beforeCanvas?.suggestions?.find(item => item.id === proposal.preparedSuggestionId);
              const changed = proposal.beforeCanvas && proposal.canvas ? proposal.beforeCanvas.blocks.filter(before => !canvasDataEqual(before, proposal.canvas!.blocks.find(after => after.id === before.id))) : [];
              const sameItems = proposal.beforeCanvas && proposal.canvas && proposal.beforeCanvas.blocks.length === proposal.canvas.blocks.length && proposal.beforeCanvas.blocks.every(before => proposal.canvas!.blocks.some(after => after.id === before.id));
              const targetBlockId = proposals.length === 1 ? selected?.targetBlockId ?? (sameItems && changed.length === 1 ? changed[0]!.id : null) : null;
              return { targetBlockId,
                readyChoice: proposals.length === 1 && proposal.status === "ready" && selected ? { suggestion: selected, expiresAt: proposal.expiresAt } : undefined,
                content: <>{proposals.map(item => <CanvasSuggestionPreview key={item.id}
                  proposal={item} assets={taskAssets[task.id] ?? []} sources={canvasSources[task.id] ?? []}
                  onKeep={() => reviewCanvasSuggestion(task.id, response.requestId, item.id, "apply")}
                  onDismiss={() => reviewCanvasSuggestion(task.id, response.requestId, item.id, "discard")} />)}</> };
            })()}
            onRequestOutline={() => { void submitIntent(`Create an outline for ${canvasDrafts.document(task)!.title}. Keep any writing already on the page unchanged.`, "canvas"); }}
            saveState={canvasDrafts.errors[task.id] ? "error" : canvasDrafts.hasDraft(task.id) ? "saving" : "saved"}
            saveMessage={canvasDrafts.errors[task.id]} onUndo={() => void undo()}
            canUndo={snapshot.recentActions.some(item => item.taskId === task.id && item.undoable && !item.undone)} /> :
            <div className="canvas-empty"><span className="eyebrow">A PLACE TO BEGIN</span><h1>Make room for<br /><em>your next thought.</em></h1><p>Start writing, or ask Eve to bring the tools you need into this space.</p><button className="canvas-secondary-button" onClick={() => { if (canvasPending) { ++navigationGeneration.current; setInitializingCanvas(null); assistance.cancel(task.id); } canvasDrafts.queue(task.id, { version: 1, title: task.title, subtitle: "", layout: "focus", blocks: [{ id: uid(), kind: "text", title: "", body: "", placement: "main", pinned: false, sourceIds: [] }] }); }}><FileText size={15} />Start with a blank page</button></div>}
          {canvasDrafts.errors[task.id] && <div className="canvas-save-recovery" role="alert">
            <p>{canvasDrafts.errors[task.id]}</p>
            {task.canvas?.document && <details><summary>Review the saved canvas</summary><Canvas document={task.canvas.document} assets={taskAssets[task.id] ?? []} sources={canvasSources[task.id] ?? []} onChange={() => {}} disabled /></details>}
            <div className="canvas-space-navigation">
              <button className="quiet-button" onClick={() => void enqueue(() => flushCanvas(task.id)).catch((error: Error) => setError(error.message))}>Retry save</button>
              <button className="quiet-button" onClick={() => canvasDrafts.resolve(task.id, "saved", task.canvas?.revision ?? 0)}>Use saved canvas</button>
              <button className="quiet-button" onClick={() => canvasDrafts.resolve(task.id, "draft", task.canvas?.revision ?? 0)}>Replace saved canvas with my draft</button>
            </div>
          </div>}
          {Object.entries(imageAttachments.states[task.id] ?? {}).filter(([blockId, state]) => state.needsCheck && !canvasDrafts.document(task)?.blocks.some(block => block.id === blockId && block.kind === "image")).map(([blockId, state]) => <div className="canvas-request-status" role="status" key={blockId}>
            <span>{state.message || "An earlier image attachment needs checking."}</span>
            <button className="quiet-button" aria-disabled={state.pending} onClick={() => { if (!state.pending) imageAttachments.check(task.id, blockId); }}>Check previous image attachment</button>
          </div>)}
          {!canvasPending && !canvasNextStepsRequested[task.id] && !canvasLearningScopes[task.id] && (assistance.responses[task.id] || assistance.messages[task.id]) && hiddenResponses[task.id] !== (assistance.responses[task.id]?.requestId ?? `message:${assistance.messages[task.id] || ""}`) && !assistance.responses[task.id]?.proposals.some(item => item.kind === "canvas" && item.status !== "discarded") && <div className="inline-assistance-result">
            <ContextualAnswer response={assistance.responses[task.id]} message={assistance.messages[task.id]} onDismiss={() => dismissAssistance(task.id)} onOpenSource={sourceId => openAnswerSource(task.id, sourceId)} />
          </div>}
          </div>
          {canvasSourcePanels[task.id] && <aside className="canvas-source-pane" aria-label="Sources beside your work">
            <div className="canvas-source-pane-heading"><span>Beside your work</span><button className="icon-button" aria-label="Close sources" onClick={() => { setCanvasSourcePanels(previous => ({ ...previous, [task.id]: false })); setSourceContext(task.id, null); }}><X size={16} /></button></div>
            <LearningActivity key={task.id} taskId={task.id} initialSourceId={requestedSources[task.id] || undefined}
              initialQuery={sourceQueries[task.id]?.query} sourceKind={sourceQueries[task.id]?.kind}
              onSourcesChanged={(taskId, sources) => setCanvasSources(previous => ({ ...previous, [taskId]: sources }))}
              onAsk={text => { void submitIntent(text, "ask"); }}
              overlayOpen={!!overlay} onSourceContext={setSourceContext} beforeAttach={flushNavigating} runMutation={enqueue}
              onBack={() => { setCanvasSourcePanels(previous => ({ ...previous, [task.id]: false })); setSourceContext(task.id, null); }} />
          </aside>}
          </div>
        </section>}
        <div hidden={!notebookOpen} className="retained-note-spaces">
          {task && <>
          <div className="workspace-heading">
            <div>
              <div className="eyebrow">
                {capabilities.project
                  ? "YOUR PROJECT NOTEBOOK"
                  : "A SPACE FOR YOUR IDEAS"}
              </div>
              <h1>{task.title}</h1>
              <p className="subtitle">
                Keep the thought. Follow where it goes.
              </p>
            </div>
            <div className="note-heading-actions">
              {capabilities.project && (
                <ProjectActivities
                  task={task}
                  activity={activity}
                  onChange={(next) => void navigate(next)}
                />
              )}
              <div className="note-material-actions">
                <button className="quiet-button" onClick={() => void navigate("canvas")}><Sparkles size={16} />Canvas</button>
                {!task.project && !projectSetup.states[task.id]?.selection && (
                  <button
                    ref={addProjectButton}
                    className="quiet-button"
                    disabled={
                      pendingOperations > 0 ||
                      projectSetupBusy(projectSetup.states[task.id])
                    }
                    onClick={() => void projectSetup.choose(task.id)}
                  >
                    <FolderOpen size={16} />
                    Add project
                  </button>
                )}
                <button
                  className="quiet-button"
                  onClick={() => void navigate("video")}
                >
                  <BookOpen size={16} />
                  Sources
                </button>
                <button
                  className="quiet-button"
                  disabled={pendingOperations > 0}
                  onClick={() => void addMaterial()}
                >
                  <Plus size={16} />
                  Add material
                </button>
              </div>
              <div
                className={`saved-state ${noteSaveError || noteConflict ? "save-error" : ""}`}
              >
                <span
                  className={
                    activeNoteDirty || copyingNote
                      ? "pending-dot"
                      : "status-dot"
                  }
                />
                <span role="status" aria-live="polite">
                  {copyingNote
                    ? "Saving your draft copy…"
                    : noteSaveError || noteConflict
                      ? "Not saved · your text is still here"
                      : activeNoteDirty
                        ? "Saving…"
                        : "Saved on this computer"}
                </span>
                {noteSaveError && (
                  <button
                    onClick={() =>
                      void enqueue(flushNavigating).catch((error: Error) =>
                        setError(error.message),
                      )
                    }
                  >
                    Retry save
                  </button>
                )}
              </div>
            </div>
          </div>
          {notebookOpen && (
            <ProjectSetup
              key={task.id}
              task={task}
              state={projectSetup.states[task.id]}
              onChoose={() => void projectSetup.choose(task.id)}
              onSubmit={(choice) => void projectSetup.register(task.id, choice)}
              onCancel={() => {
                const taskId = task.id;
                void projectSetup.cancel(taskId).then(() => {
                  if (snapshotRef.current?.activeTaskId === taskId)
                    requestAnimationFrame(() =>
                      addProjectButton.current?.focus(),
                    );
                });
              }}
              onReview={() => void projectSetup.review(task.id)}
              onClose={() => void projectSetup.close(task.id)}
              onLater={() => projectSetup.later(task.id)}
            />
          )}
          </>}
          {retainedNotes.map((noteTask) => {
            const materials = taskAssets[noteTask.id] ?? [];
            return (
              <div
                key={noteTask.id}
                hidden={task?.id !== noteTask.id}
                className={`notes-layout ${materials.length ? "with-material" : ""}`}
              >
                {materials.length > 0 && (
                  <AssetsPanel
                    assets={materials}
                    active={task?.id === noteTask.id && notebookOpen}
                    onSelected={(assetId) =>
                      setMaterialContext(noteTask.id, assetId)
                    }
                    requestedAssetId={requestedAssets[noteTask.id]?.assetId}
                    requestToken={requestedAssets[noteTask.id]?.requestId}
                  />
                )}
                <section className="note-paper">
                  <div className="panel-heading">
                    <h2>
                      {materials.length
                        ? "The thought, so far"
                        : "Make room for an idea."}
                    </h2>
                    <FileText size={18} />
                  </div>
                  {noteDrafts.conflicts[noteTask.id] && (
                    <NoteConflict
                      conflict={noteDrafts.conflicts[noteTask.id]}
                      task={noteTask}
                      draft={pendingNotes.current.get(noteTask.id)?.body ?? ""}
                      busy={noteDrafts.resolving.has(noteTask.id)}
                      onReview={() => noteDrafts.review(noteTask.id)}
                      onResolve={(choice, displayedDraft) =>
                        noteDrafts.resolve(noteTask.id, choice, displayedDraft)
                      }
                    />
                  )}
                  <NoteEditor
                    task={noteTask}
                    active={task?.id === noteTask.id && notebookOpen}
                    dirty={dirtyNoteIds.has(noteTask.id)}
                    onChange={(body) => queueNote(noteTask.id, body)}
                    onViewChange={(view) =>
                      noteContinuity.capture(noteTask.id, view)
                    }
                    onReady={() => {
                      readyNoteEditors.current.add(noteTask.id);
                      restoreNoteViewport(noteTask.id);
                    }}
                  />
                  <div className="note-hint">
                    <Bookmark size={15} />
                    Every thought has a place to come back to.
                  </div>
                </section>
              </div>
            );
          })}
        </div>
        {task && activity !== "canvas" && !assistance.responses[task.id] && assistance.messages[task.id] && hiddenResponses[task.id] !== `message:${assistance.messages[task.id]}` && <div className="inline-assistance-result"><ContextualAnswer message={assistance.messages[task.id]} onDismiss={() => dismissAssistance(task.id)} onOpenSource={() => {}} /></div>}
        {task && !canvasPending && !canvasLearningScopes[task.id] && !canvasNextStepsRequested[task.id] && assistance.responses[task.id] && hiddenResponses[task.id] !== (assistance.responses[task.id]?.requestId ?? `message:${assistance.messages[task.id] || ""}`) && (activity !== "canvas" || assistance.responses[task.id]!.proposals.some(item => item.kind !== "canvas" || !canvasDrafts.document(task))) && <aside className="inline-work-review" aria-label="Review beside your work">
          <IntentResponse response={{ ...assistance.responses[task.id]!, proposals: assistance.responses[task.id]!.proposals.filter(item => activity !== "canvas" || item.kind !== "canvas" || !canvasDrafts.document(task)) }} inline
            busy={!!assistance.requesting[task.id]} onApply={proposalId => reviewCanvasSuggestion(task.id, assistance.responses[task.id]!.requestId, proposalId, "apply")}
            onDiscard={proposalId => reviewCanvasSuggestion(task.id, assistance.responses[task.id]!.requestId, proposalId, "discard")} onOpenSource={sourceId => openAnswerSource(task.id, sourceId)} />
          <button className="quiet-button" onClick={() => dismissAssistance(task.id)}>Dismiss response</button>
        </aside>}
      </main>

      <footer className="shell-footer">
        <button
          className="find-control"
          aria-label="Find anything"
          aria-keyshortcuts={
            host?.platform === "darwin" ? "Meta+Alt+K" : "Control+Alt+K"
          }
          onClick={() => openOverlay("recall")}
        >
          <Search size={22} />
          <span>Find anything</span>
          <kbd>{host?.platform === "darwin" ? "⌘ ⌥ K" : "Ctrl Alt K"}</kbd>
        </button>
        <div className="footer-center">
          {error ? (
            <div role="alert" className="error-message">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={14} />
              </button>
            </div>
          ) : notice ? (
            <div className="notice" role="status">
              <Check size={15} />
              {notice}
            </div>
          ) : null}
          {task && <form className="canvas-prompt" aria-label="Ask Eve" aria-busy={inputPending} data-pending={inputPending} onSubmit={event => { event.preventDefault(); if (!canvasRequest.trim() || canvasPending) return; const request = canvasRequest; const owner = task.id; void submitIntent(request, activity === "canvas" ? "canvas" : "ask")?.then(receipt => { if (receipt) setCanvasRequests(previous => previous[owner] === request ? { ...previous, [owner]: "" } : previous); }); }}>
            {inputPending ? <LoaderCircle size={16} className="canvas-prompt-spinner" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}<input ref={requestInput} aria-label="Ask Eve" placeholder={inputPending ? "Thinking…" : "Ask Eve…"} value={canvasRequest} maxLength={16000} onChange={event => setCanvasRequest(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
            {inputPending ? <button type="button" className="canvas-prompt-submit canvas-prompt-cancel" aria-label="Cancel request" onClick={() => { if (initializingCanvas === task.id) { ++navigationGeneration.current; setInitializingCanvas(null); } assistance.cancel(task.id); }}><X size={16} /></button> : <button className="canvas-prompt-submit" aria-label="Send request to Eve" disabled={canvasPending || !canvasRequest.trim()}><ArrowUp size={16} /></button>}
          </form>}

        </div>
        {task && <button
          className="assistance-control"
          aria-pressed={assistancePaused}
          onClick={() =>
            void setPolicy({ assistancePaused: !assistancePaused })
          }
          aria-label={
            assistancePaused
              ? "Resume background assistance"
              : "Pause background assistance"
          }
        >
          <span className="pause-icon">
            {assistancePaused ? <Play size={12} /> : <Pause size={12} />}
          </span>
          <span>
            {assistancePaused ? "A little quiet" : "Here when you need me"}
          </span>
        </button>}
      </footer>
    </div>
  );
}
