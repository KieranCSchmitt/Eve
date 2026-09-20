export interface SurfaceFocusOwner {
  readonly key: string;
  readonly taskId: string;
  readonly generation: number;
}

/** Bounds updates do not change the input owner. Navigation does, even when a
 * later request returns to the same retained native view. */
export class SurfaceFocusOwnership {
  private generation = 0;
  private owner?: SurfaceFocusOwner;

  enter(key: string, taskId: string): SurfaceFocusOwner {
    if (this.owner?.key !== key || this.owner.taskId !== taskId)
      this.owner = Object.freeze({
        key,
        taskId,
        generation: ++this.generation,
      });
    return this.owner;
  }

  clear(): void {
    this.generation++;
    this.owner = undefined;
  }

  current(owner: SurfaceFocusOwner): boolean {
    return this.owner === owner;
  }
}
