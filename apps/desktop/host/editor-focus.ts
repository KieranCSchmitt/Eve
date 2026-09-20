import { randomUUID } from "node:crypto";

export interface EditorFocusTarget {
  taskId: string;
  projectId: string;
  projectRevision: number;
}
export interface EditorFocusGesture {
  readonly generation: number;
  readonly source: "shell" | "overlay" | "review";
  readonly taskId?: string;
}
export interface EditorFocusClaim {
  readonly id: string;
  readonly target: Readonly<EditorFocusTarget>;
  readonly generation: number;
}
interface Lease extends EditorFocusClaim {
  claimed: boolean;
}

/** A one-use intent to focus a real editor. No timer invents a new gesture:
 * asynchronous saves may finish, but any later input or lost window activity
 * revokes the original authority. Surface retries cannot reclaim spent intent. */
export class EditorFocusLeases {
  private generation = 0;
  private gesture?: EditorFocusGesture;
  private issuedGeneration = -1;
  private lease?: Lease;

  input(
    source: "shell" | "overlay" | "editor" | "review",
    taskId?: string,
  ): void {
    this.invalidate();
    if (source !== "editor")
      this.gesture = Object.freeze({
        generation: this.generation,
        source,
        ...(taskId ? { taskId } : {}),
      });
  }
  invalidate(): void {
    this.generation++;
    this.gesture = undefined;
    this.lease = undefined;
  }
  capture(windowActive: boolean): EditorFocusGesture | null {
    return windowActive ? (this.gesture ?? null) : null;
  }

  issue(
    target: EditorFocusTarget,
    gesture: EditorFocusGesture | null | undefined,
    windowActive: boolean,
  ): string | null {
    if (
      !windowActive ||
      !gesture ||
      gesture !== this.gesture ||
      gesture.generation !== this.generation ||
      this.issuedGeneration === this.generation ||
      (gesture.taskId && gesture.taskId !== target.taskId)
    )
      return null;
    this.issuedGeneration = this.generation;
    const id = randomUUID();
    this.lease = {
      id,
      target: Object.freeze({ ...target }),
      generation: this.generation,
      claimed: false,
    };
    return id;
  }
  claim(
    id: string | undefined,
    target: EditorFocusTarget,
  ): EditorFocusClaim | null {
    const lease = this.lease;
    if (!id || !lease || lease.id !== id || lease.claimed) return null;
    lease.claimed = true;
    if (
      lease.generation !== this.generation ||
      lease.target.taskId !== target.taskId ||
      lease.target.projectId !== target.projectId ||
      lease.target.projectRevision !== target.projectRevision
    ) {
      this.lease = undefined;
      return null;
    }
    return lease;
  }
  current(claim: EditorFocusClaim): boolean {
    return (
      this.lease === claim &&
      this.lease.claimed &&
      claim.generation === this.generation
    );
  }
  finish(claim: EditorFocusClaim): void {
    if (this.lease === claim) this.lease = undefined;
  }
}
