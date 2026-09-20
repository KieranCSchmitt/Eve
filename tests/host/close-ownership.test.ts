import { describe, expect, it } from "vitest";
import { CloseOwnership } from "../../apps/desktop/host/close-ownership";
import { MutationGate } from "../../apps/desktop/host/mutation-gate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native close admission and input ownership", () => {
  it("reserves before project startup awaits, excludes backup admission, and makes exit wait for complete close cleanup", async () => {
    const ownership = new CloseOwnership(),
      gate = new MutationGate();
    const startup = deferred(),
      disposal = deferred(),
      exitDone = deferred();
    const events: string[] = [];
    let firstInput: ReturnType<CloseOwnership["claimInput"]> | undefined;
    const close = ownership.closeProject(async () => {
      await startup.promise;
      firstInput = ownership.claimInput();
      const hold = await gate.acquire();
      events.push("project-held");
      try {
        await disposal.promise;
        return { closed: true };
      } finally {
        await hold.release();
        expect(firstInput.owns()).toBe(true);
        firstInput.release();
        events.push("project-released");
      }
    });
    expect(ownership.projectClosing).toBe(true);
    // This is the host's pre-dialog backup admission predicate. No backup can
    // claim input during the project's initial snapshot/startup awaits.
    expect(!ownership.projectClosing && !ownership.inputHeld).toBe(false);
    let secondStarted = false;
    await expect(
      ownership.closeProject(async () => {
        secondStarted = true;
      }),
    ).rejects.toThrow("already");
    expect(secondStarted).toBe(false);
    const exit = (async () => {
      await ownership.settleProjectClose();
      const input = ownership.claimInput();
      const hold = await gate.acquire();
      events.push("exit-held");
      try {
        // A stale project cleanup cannot clear the new exit's input authority.
        firstInput!.release();
        expect(input.owns()).toBe(true);
        await exitDone.promise;
      } finally {
        await hold.release();
        input.release();
        events.push("exit-released");
      }
    })();
    await Promise.resolve();
    expect(events).toEqual([]);
    startup.resolve();
    await expect.poll(() => events).toEqual(["project-held"]);
    expect(() => ownership.claimInput()).toThrow("Another close");
    expect(firstInput!.owns()).toBe(true);
    disposal.resolve();
    await expect(close).resolves.toEqual({ closed: true });
    await expect
      .poll(() => events)
      .toEqual(["project-held", "project-released", "exit-held"]);
    expect(ownership.inputHeld).toBe(true);
    exitDone.resolve();
    await exit;
    expect(ownership.inputHeld).toBe(false);
    expect(ownership.projectClosing).toBe(false);
    expect(await gate.run(async () => "writable")).toBe("writable");
  });

  it("does not release a failed or cancelled close admission until its asynchronous cleanup is terminal", async () => {
    const ownership = new CloseOwnership(),
      cleanup = deferred();
    const failure = new Error("Save failed");
    let input: ReturnType<CloseOwnership["claimInput"]> | undefined;
    const close = ownership.closeProject(async () => {
      input = ownership.claimInput();
      try {
        throw failure;
      } finally {
        await cleanup.promise;
        input.release();
      }
    });
    void close.catch(() => {});
    const cancelledExit = new AbortController();
    let terminal = false;
    const exit = (async () => {
      await ownership.settleProjectClose();
      cancelledExit.signal.throwIfAborted();
    })().finally(() => {
      terminal = true;
    });
    cancelledExit.abort();
    await Promise.resolve();
    expect(terminal).toBe(false);
    expect(ownership.projectClosing).toBe(true);
    expect(input!.owns()).toBe(true);
    cleanup.resolve();
    await expect(close).rejects.toBe(failure);
    await expect(exit).rejects.toThrow();
    expect(terminal).toBe(true);
    expect(ownership.inputHeld).toBe(false);
    expect(await ownership.closeProject(async () => "retry")).toBe("retry");
  });
});
