/** Order renderer overlay requests across asynchronous checkpoint preparation.
 * OverlayHost owns ordering after publication; this gate covers the earlier
 * await where a dismissed question could otherwise reopen after Home/lock. */
export class OverlayRequests {
  private generation = 0;

  invalidate(): void {
    this.generation++;
  }

  async publishAfter(
    prepare: () => Promise<void>,
    publish: () => Promise<void>,
    onPrepareError: (error: unknown) => void,
  ): Promise<boolean> {
    const generation = ++this.generation;
    let failed = false;
    let error: unknown;
    try {
      await prepare();
    } catch (reason) {
      failed = true;
      error = reason;
    }
    if (generation !== this.generation) return false;
    if (failed) onPrepareError(error);
    await publish();
    return generation === this.generation;
  }
}
