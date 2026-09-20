import { useCallback, useEffect, useRef } from "react";
import type {
  CoreCommandInput,
  DispatchResult,
  NoteViewCheckpoint,
  TaskRecord,
} from "@eve/contracts";

export interface NoteSelectionSnapshot {
  noteId: string;
  /** Null while the editor's document contains an unacknowledged local change. */
  noteRevision: number | null;
  body: string;
  anchor: number;
  head: number;
}
export function matchingNoteView(
  task: TaskRecord,
): NoteViewCheckpoint | undefined {
  const value = task.checkpoint?.noteView;
  return value?.version === 1 &&
    value.noteId === task.note.id &&
    value.noteRevision === task.note.revision
    ? value
    : undefined;
}
export function retainedNoteIds(
  recent: readonly string[],
  active: string | null,
  dirty: ReadonlySet<string>,
  limit = 6,
): string[] {
  const pinned = new Set([...dirty, ...(active ? [active] : [])]);
  const clean = [...new Set(recent)]
    .filter((id) => !pinned.has(id))
    .slice(-limit);
  return [...clean, ...pinned];
}
function sameView(a: NoteViewCheckpoint | undefined, b: NoteViewCheckpoint) {
  return (
    a?.noteId === b.noteId &&
    a.noteRevision === b.noteRevision &&
    a.selection.anchor === b.selection.anchor &&
    a.selection.head === b.selection.head &&
    a.scrollTop === b.scrollTop
  );
}

export function useNoteContinuity(options: {
  getTask(taskId: string): TaskRecord | undefined;
  dispatch(command: CoreCommandInput): Promise<DispatchResult>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  onError(message: string): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const views = useRef(new Map<string, NoteSelectionSnapshot>());
  const scrolls = useRef(new Map<string, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tail = useRef(Promise.resolve());
  const mounted = useRef(true);
  const persist = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const run = tail.current.then(async () => {
      for (const taskId of views.current.keys()) {
        // A native checkpoint may advance concurrently. Retry once using its
        // returned canonical snapshot, preserving every unrelated checkpoint field.
        for (let attempt = 0; attempt < 2; attempt++) {
          const task = latest.current.getTask(taskId);
          const view = views.current.get(taskId);
          if (
            !task ||
            !view ||
            task.note.id !== view.noteId ||
            (view.noteRevision !== task.note.revision &&
              view.body !== task.note.body)
          )
            break;
          const noteView: NoteViewCheckpoint = {
            version: 1,
            noteId: task.note.id,
            noteRevision: task.note.revision,
            selection: { anchor: view.anchor, head: view.head },
            scrollTop:
              scrolls.current.get(taskId) ??
              matchingNoteView(task)?.scrollTop ??
              0,
          };
          if (sameView(task.checkpoint?.noteView, noteView)) break;
          const {
            revision: _revision,
            updatedAt: _updatedAt,
            ...checkpoint
          } = task.checkpoint ?? {
            layout: "work" as const,
            selectedActivity: "notes" as const,
            returnAnchors: [],
          };
          const result = await latest.current.dispatch({
            type: "SaveCheckpoint",
            requestId: crypto.randomUUID(),
            taskId,
            expectedEpoch: task.epoch,
            expectedRevision: task.checkpoint?.revision ?? 0,
            checkpoint: { ...checkpoint, noteView },
          });
          if (result.ok) break;
          if (result.error.code !== "REVISION_CONFLICT" || attempt === 1)
            throw new Error(
              `Your text is saved, but its place could not be remembered. ${result.error.message}`,
            );
        }
      }
    });
    tail.current = run.catch(() => undefined);
    return run;
  }, []);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (mounted.current)
        void latest.current
          .enqueue(persist)
          .catch((error: Error) => latest.current.onError(error.message));
    }, 600);
  }, [persist]);
  const capture = useCallback(
    (taskId: string, view: NoteSelectionSnapshot) => {
      const previous = views.current.get(taskId);
      if (
        previous &&
        previous.noteId === view.noteId &&
        previous.noteRevision === view.noteRevision &&
        previous.body === view.body &&
        previous.anchor === view.anchor &&
        previous.head === view.head
      )
        return;
      if (
        previous &&
        view.noteRevision !== null &&
        previous.noteRevision !== view.noteRevision &&
        previous.body !== view.body
      )
        scrolls.current.delete(taskId);
      views.current.set(taskId, view);
      schedule();
    },
    [schedule],
  );
  const scroll = useCallback(
    (taskId: string, scrollTop: number) => {
      const value = Math.max(0, Math.min(10_000_000, scrollTop));
      if (scrolls.current.get(taskId) === value) return;
      scrolls.current.set(taskId, value);
      schedule();
    },
    [schedule],
  );
  const position = useCallback((task: TaskRecord) => {
    const view = views.current.get(task.id);
    const current =
      view?.noteId === task.note.id &&
      (view.noteRevision === task.note.revision ||
        view.body === task.note.body ||
        view.noteRevision === null);
    return (
      (current ? scrolls.current.get(task.id) : undefined) ??
      matchingNoteView(task)?.scrollTop ??
      0
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const prune = useCallback((keep: ReadonlySet<string>) => {
    for (const taskId of views.current.keys())
      if (!keep.has(taskId)) {
        views.current.delete(taskId);
        scrolls.current.delete(taskId);
      }
  }, []);
  return { capture, scroll, position, persist, prune };
}
