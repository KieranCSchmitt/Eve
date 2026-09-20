import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  CoreCommandInput,
  CoreSnapshot,
  DispatchResult,
  TaskRecord,
} from "@eve/contracts";
import type { NoteConflictRecord } from "../components/NoteConflict";

export interface NoteDraft {
  taskId: string;
  noteId: string;
  baseRevision: number;
  body: string;
}
type FlushOptions = { allowConflicts?: boolean; taskId?: string };
interface CopyAttempt {
  edit: NoteDraft;
  create: Extract<CoreCommandInput, { type: "CreateTask" }>;
  target?: { id: string; noteId: string; revision: number };
  write?: Extract<CoreCommandInput, { type: "UpdateNote" }>;
}
const uid = () => crypto.randomUUID();
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Your note could not be saved.";

/** Local drafts are never rebased onto somebody else's acknowledged revision. */
export function useNoteDrafts(options: {
  pending: RefObject<Map<string, NoteDraft>>;
  snapshot: () => CoreSnapshot | null;
  dispatch: (command: CoreCommandInput) => Promise<DispatchResult>;
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
  persistPlace: () => Promise<void>;
  setSaving: (saving: boolean) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const conflictsRef = useRef<Record<string, NoteConflictRecord>>({});
  const copies = useRef(new Map<string, CopyAttempt>());
  const resolutions = useRef(new Set<string>());
  const activeWrites = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTail = useRef(Promise.resolve());
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [conflicts, setConflicts] = useState<
    Record<string, NoteConflictRecord>
  >({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [copyingIds, setCopyingIds] = useState<Set<string>>(new Set());
  const task = (id: string) =>
    latest.current.snapshot()?.tasks.find((item) => item.id === id);
  const publish = () => {
    setDirtyIds(new Set(latest.current.pending.current.keys()));
    latest.current.setSaving(
      activeWrites.current > 0 ||
        [...latest.current.pending.current.keys()].some(
          (id) => !conflictsRef.current[id],
        ),
    );
  };
  const conflict = (id: string, next: NoteConflictRecord | undefined) => {
    const records = { ...conflictsRef.current };
    if (next) records[id] = next;
    else delete records[id];
    conflictsRef.current = records;
    setConflicts(records);
  };
  const markConflict = (current: TaskRecord) => {
    conflict(
      current.id,
      conflictsRef.current[current.id] ?? { saved: { ...current.note } },
    );
    setErrors((previous) => ({ ...previous, [current.id]: "" }));
  };
  const acknowledge = (edit: NoteDraft, saved: TaskRecord) => {
    const newer = latest.current.pending.current.get(edit.taskId);
    if (newer === edit) latest.current.pending.current.delete(edit.taskId);
    else if (
      newer?.noteId === edit.noteId &&
      newer.baseRevision === edit.baseRevision
    ) {
      // Only our own successful write advances the base of a newer local edit.
      latest.current.pending.current.set(edit.taskId, {
        ...newer,
        baseRevision: saved.note.revision,
      });
    }
  };
  const flush = useCallback((settings: FlushOptions = {}) => {
    if (timer.current) clearTimeout(timer.current);
    const run = saveTail.current.then(async () => {
      activeWrites.current++;
      publish();
      let failure: Error | undefined;
      try {
        for (const edit of [...latest.current.pending.current.values()]) {
          if (conflictsRef.current[edit.taskId]) continue;
          try {
            const current = task(edit.taskId);
            if (!current)
              throw new Error(
                "This note could not be located. Your unsaved text is still open.",
              );
            if (
              current.note.id !== edit.noteId ||
              current.note.revision !== edit.baseRevision
            ) {
              markConflict(current);
              continue;
            }
            const result = await latest.current.dispatch({
              type: "UpdateNote",
              requestId: uid(),
              taskId: current.id,
              expectedEpoch: current.epoch,
              expectedRevision: edit.baseRevision,
              body: edit.body,
            });
            if (!result.ok) {
              const changed = result.snapshot.tasks.find(
                (item) => item.id === current.id,
              );
              if (result.error.code === "REVISION_CONFLICT" && changed) {
                markConflict(changed);
                continue;
              }
              throw new Error(result.error.message);
            }
            const saved = result.snapshot.tasks.find(
              (item) => item.id === current.id,
            );
            if (!saved)
              throw new Error(
                "The saved note could not be located. Your draft is still here.",
              );
            acknowledge(edit, saved);
            setErrors((previous) => ({ ...previous, [edit.taskId]: "" }));
          } catch (error) {
            setErrors((previous) => ({
              ...previous,
              [edit.taskId]: message(error),
            }));
            failure ??= new Error(message(error));
          }
        }
      } finally {
        activeWrites.current--;
        // Failed drafts are dirty, not an endlessly running save operation.
        setDirtyIds(new Set(latest.current.pending.current.keys()));
        latest.current.setSaving(false);
      }
      if (failure) throw failure;
      if (
        ![...latest.current.pending.current.keys()].some(
          (id) => conflictsRef.current[id],
        )
      )
        latest.current.onError("");
      const unresolved = [...latest.current.pending.current.keys()].find(
        (id) =>
          conflictsRef.current[id] &&
          (!settings.taskId || settings.taskId === id),
      );
      if (unresolved && !settings.allowConflicts)
        throw new Error(
          `“${task(unresolved)?.title ?? "Your note"}” has two versions to review. Your draft is still here.`,
        );
      await latest.current.persistPlace();
    });
    saveTail.current = run.catch(() => undefined);
    return run;
  }, []);
  const queue = useCallback(
    (taskId: string, body: string) => {
      const current = task(taskId);
      if (!current) return;
      const previous = latest.current.pending.current.get(taskId);
      latest.current.pending.current.set(taskId, {
        taskId,
        noteId: previous?.noteId ?? current.note.id,
        baseRevision: previous?.baseRevision ?? current.note.revision,
        body,
      });
      setErrors((previous) => ({ ...previous, [taskId]: "" }));
      publish();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void latest.current
          .enqueue(() => flush({ allowConflicts: true }))
          .catch((error) => latest.current.onError(message(error)));
      }, 250);
    },
    [flush],
  );
  const review = useCallback((taskId: string) => {
    const current = task(taskId),
      previous = conflictsRef.current[taskId];
    if (current && previous && !resolutions.current.has(taskId))
      conflict(taskId, {
        ...previous,
        saved: { ...current.note },
        message: undefined,
      });
  }, []);
  const resolve = useCallback(
    (
      taskId: string,
      choice: "saved" | "copy" | "replace",
      displayedDraft: string,
    ) => {
      const reviewed = conflictsRef.current[taskId];
      const captured = latest.current.pending.current.get(taskId);
      if (!reviewed || !captured || resolutions.current.has(taskId)) return;
      if (captured.body !== displayedDraft) {
        conflict(taskId, {
          ...reviewed,
          message:
            "Your draft changed. Review the current text before choosing.",
        });
        return;
      }
      resolutions.current.add(taskId);
      setResolving(new Set(resolutions.current));
      void latest.current
        .enqueue(async () => {
          const current = task(taskId);
          if (!current)
            throw new Error(
              "The original space is unavailable. Your draft is still here.",
            );
          if (latest.current.pending.current.get(taskId) !== captured)
            throw new Error(
              "Your draft changed. Review the current text before choosing.",
            );
          if (
            choice !== "copy" &&
            (current.note.id !== reviewed.saved.id ||
              current.note.revision !== reviewed.saved.revision)
          )
            throw new Error(
              "The saved version changed again. Review the latest version before choosing.",
            );
          if (choice === "saved") {
            latest.current.pending.current.delete(taskId); // The explicit discard choice.
            conflict(taskId, undefined);
            copies.current.delete(taskId);
            setErrors((previous) => ({ ...previous, [taskId]: "" }));
            latest.current.onNotice("Kept the saved version");
            latest.current.onError("");
            publish();
            return;
          }
          activeWrites.current++;
          publish();
          let copyTarget: string | undefined;
          try {
            if (choice === "replace") {
              const result = await latest.current.dispatch({
                type: "UpdateNote",
                requestId: uid(),
                taskId,
                expectedEpoch: current.epoch,
                expectedRevision: reviewed.saved.revision,
                body: captured.body,
              });
              if (!result.ok) throw new Error(result.error.message);
              const saved = result.snapshot.tasks.find(
                (item) => item.id === taskId,
              );
              if (!saved)
                throw new Error(
                  "The saved note could not be located. Your draft is still here.",
                );
              acknowledge(captured, saved);
              conflict(taskId, undefined);
              copies.current.delete(taskId);
              latest.current.onNotice("Your reviewed draft is saved");
            } else {
              // CreateTask activates its new space. Remember the exact attempt so a
              // failed/uncertain acknowledgement can be retried idempotently.
              let attempt = copies.current.get(taskId);
              if (!attempt) {
                attempt = {
                  edit: captured,
                  create: {
                    type: "CreateTask",
                    requestId: uid(),
                    title: `${current.title.slice(0, 107)} · draft copy`,
                    kind: "note",
                  },
                };
                copies.current.set(taskId, attempt);
              }
              // A definite failed write can use the draft now being reviewed.
              // An uncertain write must first replay its exact idempotency key.
              if (!attempt.write) attempt.edit = captured;
              if (!attempt.target) {
                const created = await latest.current.dispatch(attempt.create);
                if (!created.ok) throw new Error(created.error.message);
                const createdTask = task(created.operation.taskId);
                if (!createdTask)
                  throw new Error(
                    "The new space could not be located. Your draft is still here.",
                  );
                attempt.target = {
                  id: createdTask.id,
                  noteId: createdTask.note.id,
                  revision: 0,
                };
              }
              copyTarget = attempt.target.id;
              setCopyingIds((previous) => new Set([...previous, copyTarget!]));
              const target = task(copyTarget);
              if (!target)
                throw new Error(
                  "The copy could not be located. Your original draft is still here.",
                );
              if (
                !attempt.write &&
                (target.note.id !== attempt.target.noteId ||
                  target.note.revision !== attempt.target.revision)
              ) {
                copies.current.delete(taskId);
                throw new Error(
                  "The copy changed before it could be saved. It was kept; choose Save draft as new space to create another.",
                );
              }
              attempt.write ??= {
                type: "UpdateNote",
                requestId: uid(),
                taskId: target.id,
                expectedEpoch: target.epoch,
                expectedRevision: attempt.target.revision,
                body: attempt.edit.body,
              };
              const saved = await latest.current.dispatch(attempt.write);
              if (!saved.ok) {
                // A definite failure did not commit. A retry can refresh the
                // task epoch while retaining the exact original note revision.
                attempt.write = undefined;
                if (saved.error.code === "REVISION_CONFLICT") {
                  // An independently edited copy must never be overwritten on retry.
                  copies.current.delete(taskId);
                  throw new Error(
                    "The copy changed before it could be saved. It was kept; choose Save draft as new space to create another.",
                  );
                }
                throw new Error(saved.error.message);
              }
              const savedCopy = saved.snapshot.tasks.find(
                (item) => item.id === target.id,
              );
              if (!savedCopy || savedCopy.note.body !== attempt.edit.body) {
                copies.current.delete(taskId);
                throw new Error(
                  "The saved copy changed again. Your original draft is still here; save it in another space when ready.",
                );
              }
              copies.current.delete(taskId);
              if (latest.current.pending.current.get(taskId) === attempt.edit) {
                latest.current.pending.current.delete(taskId);
                conflict(taskId, undefined);
              } else {
                conflict(taskId, {
                  ...reviewed,
                  copyPending: false,
                  message:
                    "The reviewed draft was saved in a new space. Your newer edits are still here to resolve.",
                });
              }
              // On a retry the copy may no longer be active; open it only after its
              // contents have a durable acknowledgement.
              if (latest.current.snapshot()?.activeTaskId !== target.id) {
                const opened = await latest.current.dispatch({
                  type: "RecallTask",
                  requestId: uid(),
                  taskId: target.id,
                });
                if (!opened.ok) latest.current.onError(opened.error.message);
              }
              latest.current.onNotice(
                `Saved a separate copy in “${target.title}”`,
              );
            }
            setErrors((previous) => ({ ...previous, [taskId]: "" }));
            latest.current.onError("");
          } catch (error) {
            // A failed second copy write leaves the original editable draft visible.
            if (
              choice === "copy" &&
              latest.current.snapshot()?.activeTaskId === copyTarget
            ) {
              await latest.current
                .dispatch({ type: "RecallTask", requestId: uid(), taskId })
                .catch(() => undefined);
            }
            throw error;
          } finally {
            activeWrites.current--;
            if (copyTarget)
              setCopyingIds(
                (previous) =>
                  new Set([...previous].filter((id) => id !== copyTarget)),
              );
            publish();
          }
        })
        .catch((error) => {
          const previous = conflictsRef.current[taskId];
          if (previous)
            conflict(taskId, {
              ...previous,
              message: `${message(error)}${copies.current.has(taskId) ? (copies.current.get(taskId)?.write ? " Retry will confirm the previous copy; any newer edits will stay here." : " Retry will save your current draft in this same new space.") : ""}`,
              copyPending: copies.current.has(taskId),
            });
        })
        .finally(() => {
          resolutions.current.delete(taskId);
          setResolving(new Set(resolutions.current));
          publish();
        });
    },
    [],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return {
    flush,
    queue,
    dirtyIds,
    conflicts,
    errors,
    resolving,
    copyingIds,
    review,
    resolve,
  };
}
