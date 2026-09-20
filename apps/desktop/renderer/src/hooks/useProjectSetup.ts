import { useRef, useState } from "react";
import type { CoreSnapshot, ProjectPreview, TaskRecord } from "@eve/contracts";
import type { ProjectSelection } from "../../../shared/bridge";

export type ProjectChoice = {
  selectionId: string;
  adapter: "generic" | "orbit";
  preview: ProjectPreview;
};
export interface ProjectSetupState {
  phase:
    | "choosing"
    | "review"
    | "registering"
    | "uncertain"
    | "refused"
    | "attached"
    | "cancelling"
    | "opening"
    | "closing";
  selection?: ProjectSelection;
  submitted?: ProjectChoice;
  message?: string;
}
export const projectSetupBusy = (state?: ProjectSetupState) =>
  !!state &&
  ["choosing", "registering", "cancelling", "opening", "closing"].includes(
    state.phase,
  );
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The project could not be confirmed. Your note is still here.";

/** The host owns selections, registration receipts and execution permission. */
export function useProjectSetup(options: {
  activeTaskId(): string | null;
  task(id: string): TaskRecord | undefined;
  flush(taskId: string): Promise<void>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  merge(snapshot: CoreSnapshot): void;
  openCode(taskId: string, focusLeaseId?: string): Promise<unknown>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const entries = useRef<Record<string, ProjectSetupState>>({});
  const [states, setStates] = useState<Record<string, ProjectSetupState>>({});
  const pending = useRef(new Set<string>());
  const put = (id: string, state?: ProjectSetupState) => {
    const next = { ...entries.current };
    if (state) next[id] = state;
    else delete next[id];
    entries.current = next;
    setStates(next);
  };
  const isCurrent = (id: string) => latest.current.activeTaskId() === id;
  const current = (id: string) => {
    if (!isCurrent(id))
      throw new Error(
        "Return to the space where you chose this project to continue.",
      );
  };
  const mergeCurrent = (snapshot: CoreSnapshot, id: string) => {
    // A delayed receipt is evidence for its task, never a navigation request.
    if (isCurrent(id) && snapshot.activeTaskId === id)
      latest.current.merge(snapshot);
  };
  const choose = async (id: string) => {
    if (pending.current.has(id) || entries.current[id]?.selection) return;
    pending.current.add(id);
    put(id, { phase: "choosing" });
    try {
      const selection = await latest.current.enqueue(async () => {
        await latest.current.flush(id);
        current(id);
        return window.eve.chooseProject(id);
      });
      if (!selection) {
        put(id);
        return;
      }
      if (selection.taskId !== id)
        throw new Error(
          "The folder selection belongs to another space. Choose it again here.",
        );
      put(id, { phase: "review", selection });
    } catch (error) {
      put(id, { phase: "refused", message: message(error) });
    } finally {
      pending.current.delete(id);
    }
  };
  const register = async (id: string, choice: ProjectChoice) => {
    const previous = entries.current[id];
    if (pending.current.has(id) || !previous?.selection) return;
    if (choice.selectionId !== previous.selection.selectionId) return;
    const submitted = previous.submitted ?? structuredClone(choice);
    pending.current.add(id);
    put(id, {
      ...previous,
      phase: "registering",
      submitted,
      message: undefined,
    });
    let sent = false;
    try {
      const result = await latest.current.enqueue(async () => {
        await latest.current.flush(id);
        current(id);
        sent = true;
        return window.eve.registerProject(submitted);
      });
      mergeCurrent(result.snapshot, id);
      if (result.ok)
        put(id, {
          ...previous,
          phase: "attached",
          submitted,
          message: "The folder is attached. Your note stays with this space.",
        });
      else
        put(id, {
          ...previous,
          phase:
            result.error.code === "STORAGE_ERROR" ? "uncertain" : "refused",
          submitted:
            result.error.code === "STORAGE_ERROR" ? submitted : undefined,
          message: result.error.message,
        });
    } catch (error) {
      put(id, {
        ...previous,
        phase: sent ? "uncertain" : previous.submitted ? "uncertain" : "review",
        submitted: sent || previous.submitted ? submitted : undefined,
        message: message(error),
      });
    } finally {
      pending.current.delete(id);
    }
  };
  const cancel = async (id: string) => {
    const previous = entries.current[id];
    if (!previous || pending.current.has(id)) return;
    if (!previous.selection) {
      put(id);
      return;
    }
    pending.current.add(id);
    put(id, { ...previous, phase: "cancelling", message: undefined });
    let dismissed = false;
    try {
      await window.eve.dismissProjectSelection(previous.selection.selectionId);
      dismissed = true;
      const snapshot = await window.eve.snapshot();
      mergeCurrent(snapshot, id);
      put(
        id,
        snapshot.tasks.find((task) => task.id === id)?.project
          ? {
              phase: "attached",
              message:
                "The project was already attached. Its files and your note are kept.",
            }
          : undefined,
      );
    } catch (error) {
      // A denied cancellation leaves the exact submission available for retry.
      put(
        id,
        dismissed
          ? {
              phase: "refused",
              message:
                "The setup was dismissed, but the current workspace could not be refreshed. " +
                message(error),
            }
          : { ...previous, message: message(error) },
      );
    } finally {
      pending.current.delete(id);
    }
  };
  const review = async (id: string) => {
    if (pending.current.has(id)) return;
    const previous = entries.current[id];
    pending.current.add(id);
    put(id, { ...previous, phase: "opening", message: undefined });
    try {
      const result = await latest.current.enqueue(async () => {
        await latest.current.flush(id);
        current(id);
        return window.eve.reviewProject(id);
      });
      put(id, {
        phase: "attached",
        message:
          result.message ??
          (result.trusted
            ? undefined
            : "Your project stays attached. Open it when you are ready."),
      });
      if (result.trusted && isCurrent(id))
        await latest.current.openCode(id, result.focusLeaseId);
    } catch (error) {
      put(id, { ...previous, phase: "attached", message: message(error) });
    } finally {
      pending.current.delete(id);
    }
  };
  const later = (id: string) => {
    if (!pending.current.has(id) && entries.current[id]?.phase === "attached")
      put(id);
  };
  const close = async (id: string) => {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    put(id, { phase: "closing" });
    try {
      const result = await latest.current.enqueue(async () => {
        await latest.current.flush(id);
        current(id);
        return window.eve.closeProject(id);
      });
      put(id, {
        phase: "attached",
        message: result.closed
          ? "Code and preview are closed. The folder and your note stay attached."
          : "Your code and preview remain open.",
      });
    } catch (error) {
      put(id, { phase: "attached", message: message(error) });
    } finally {
      pending.current.delete(id);
    }
  };
  return { states, choose, register, cancel, review, later, close };
}
