/** Tracks admitted host writes before freezing a profile for maintenance. */
export class MutationGate {
  private active = new Set<Promise<unknown>>();
  private held: symbol | undefined;
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.held)
      return Promise.reject(
        new Error(
          "Your workspace backup is in progress. Try again when it finishes.",
        ),
      );
    const work = Promise.resolve().then(operation);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  async acquire(
    signal?: AbortSignal,
  ): Promise<{ assertHeld(): Promise<void>; release(): Promise<void> }> {
    signal?.throwIfAborted();
    if (this.held)
      throw new Error(
        "A workspace maintenance operation is already in progress.",
      );
    const token = Symbol();
    this.held = token;
    try {
      // Do not race cancellation: an already admitted write still needs its
      // terminal result before any caller may copy or release the profile.
      await Promise.allSettled([...this.active]);
      signal?.throwIfAborted();
    } catch (error) {
      if (this.held === token) this.held = undefined;
      throw error;
    }
    return {
      assertHeld: async () => {
        signal?.throwIfAborted();
        if (this.held !== token)
          throw new Error("The workspace maintenance pause ended.");
      },
      release: async () => {
        if (this.held === token) this.held = undefined;
      },
    };
  }
}
