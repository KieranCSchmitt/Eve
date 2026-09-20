import { useEffect, useRef, useState } from "react";
import type {
  CoreCommandInput,
  CoreSnapshot,
  DispatchResult,
  TaskRecord,
} from "@eve/contracts";

type RenameCommand = Extract<CoreCommandInput, { type: "RenameTask" }>;
export interface RenameState {
  originalTitle: string;
  epoch: number;
  value: string;
  phase: "editing" | "saving" | "uncertain" | "conflict";
  submitted?: RenameCommand;
  message?: string;
  hidden?: boolean;
}

export function useRenameTask(options: {
  task(id: string): TaskRecord | undefined;
  activeTaskId(): string | null;
  flush(id: string): Promise<void>;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  merge(snapshot: CoreSnapshot): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const entries = useRef<Record<string, RenameState>>({});
  const pending = useRef(new Set<string>());
  const [states, setStates] = useState<Record<string, RenameState>>({});
  const put = (id: string, value?: RenameState) => {
    const next = { ...entries.current };
    if (value)
      next[id] = {
        ...value,
        hidden: value.hidden || latest.current.activeTaskId() !== id,
      };
    else delete next[id];
    entries.current = next;
    setStates(next);
  };
  const activeId = options.activeTaskId();
  useEffect(() => {
    for (const [id, state] of Object.entries(entries.current))
      if (id !== activeId && !state.hidden) put(id, { ...state, hidden: true });
  }, [activeId]);
  const begin = (id: string) => {
    const task = latest.current.task(id);
    if (!task || pending.current.has(id)) return;
    const existing = entries.current[id];
    put(
      id,
      existing
        ? { ...existing, hidden: false }
        : {
            originalTitle: task.title,
            epoch: task.epoch,
            value: task.title,
            phase: "editing",
          },
    );
  };
  const change = (id: string, value: string) => {
    const state = entries.current[id];
    if (state && !pending.current.has(id) && !state.submitted)
      put(id, { ...state, value, message: undefined });
  };
  const dismiss = (id: string) => {
    const state = entries.current[id];
    if (!state || pending.current.has(id)) return;
    put(id, state.submitted ? { ...state, hidden: true } : undefined);
  };
  const review = (id: string) => {
    const task = latest.current.task(id),
      state = entries.current[id];
    if (task && state && !pending.current.has(id) && !state.submitted)
      put(id, {
        originalTitle: task.title,
        epoch: task.epoch,
        value: task.title,
        phase: "editing",
      });
  };
  const submit = async (id: string): Promise<boolean> => {
    const state = entries.current[id];
    if (!state || pending.current.has(id)) return false;
    const title = state.value.trim();
    if (!title || title.length > 120) {
      put(id, {
        ...state,
        message: "Use a title between 1 and 120 characters.",
      });
      return false;
    }
    pending.current.add(id);
    put(id, { ...state, phase: "saving", message: undefined });
    let submitted = state.submitted;
    let sent = false;
    try {
      const result = await latest.current.enqueue(
        async (): Promise<DispatchResult | undefined> => {
          if (latest.current.activeTaskId() !== id)
            throw new Error("Return to this space to finish its title change.");
          if (!submitted) {
            await latest.current.flush(id);
            const current = latest.current.task(id);
            if (
              !current ||
              latest.current.activeTaskId() !== id ||
              current.epoch !== state.epoch ||
              current.title !== state.originalTitle
            ) {
              put(id, {
                ...state,
                phase: "conflict",
                message:
                  "This space changed while you were naming it. Review its current title before trying again.",
              });
              return undefined;
            }
            if (title === current.title) return undefined;
            submitted = {
              type: "RenameTask",
              taskId: id,
              requestId: crypto.randomUUID(),
              expectedEpoch: current.epoch,
              expectedRevision: current.revision,
              title,
            };
            put(id, { ...state, phase: "saving", value: title, submitted });
          }
          sent = true;
          return window.eve.dispatch(submitted);
        },
      );
      if (!result) {
        if (entries.current[id]?.phase === "conflict") return false;
        put(id);
        return true;
      }
      if (
        latest.current.activeTaskId() === id &&
        result.snapshot.activeTaskId === id
      )
        latest.current.merge(result.snapshot);
      if (result.ok) {
        put(id);
        return true;
      }
      const uncertain = result.error.code === "STORAGE_ERROR";
      put(id, {
        ...state,
        value: title,
        phase: uncertain ? "uncertain" : "conflict",
        submitted: uncertain ? submitted : undefined,
        message: result.error.message,
      });
      return false;
    } catch (error) {
      put(id, {
        ...state,
        phase: sent || state.submitted ? "uncertain" : "editing",
        submitted: sent ? submitted : state.submitted,
        message:
          error instanceof Error
            ? error.message
            : "The title change could not be confirmed.",
      });
      return false;
    } finally {
      pending.current.delete(id);
    }
  };
  return { states, begin, change, dismiss, review, submit };
}
