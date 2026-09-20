/** Serializes the host's project-close admission before any asynchronous work.
 * Input ownership is a separate token: a losing/stale caller cannot release the
 * guards of a later close, even if its cleanup runs after that close started. */
export class CloseOwnership {
  private closing?: Promise<unknown>;
  private inputOwner?: symbol;

  get projectClosing(): boolean {
    return !!this.closing;
  }
  get inputHeld(): boolean {
    return !!this.inputOwner;
  }

  closeProject<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new Error("Project views are already preparing to close."),
      );
    const pending = Promise.resolve().then(operation);
    this.closing = pending;
    void pending
      .finally(() => {
        if (this.closing === pending) this.closing = undefined;
      })
      .catch(() => {});
    return pending;
  }

  /** An exit must wait for the existing close's complete cleanup, even if it
   * failed. Cancellation of the waiting exit cannot forget the owned close. */
  async settleProjectClose(): Promise<void> {
    await this.closing?.catch(() => undefined);
  }

  claimInput(): { owns(): boolean; release(): void } {
    if (this.inputOwner)
      throw new Error("Another close owns the workspace input hold.");
    const token = Symbol("close-input");
    this.inputOwner = token;
    return {
      owns: () => this.inputOwner === token,
      release: () => {
        if (this.inputOwner === token) this.inputOwner = undefined;
      },
    };
  }
}
