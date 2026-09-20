import { describe, expect, it } from "vitest";
import { MutationGate } from "../../apps/desktop/host/mutation-gate";

describe("profile mutation barrier", () => {
  it("drains admitted work and blocks new writes until the original lease releases", async () => {
    const gate = new MutationGate();
    let finish!: () => void;
    let frozen = false;
    const write = gate.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const acquiring = gate.acquire().then((lease) => {
      frozen = true;
      return lease;
    });
    await Promise.resolve();
    expect(frozen).toBe(false);
    await expect(gate.run(async () => "late")).rejects.toThrow("backup");
    finish();
    await write;
    const lease = await acquiring;
    await lease.assertHeld();
    await expect(gate.acquire()).rejects.toThrow("already");
    await lease.release();
    await expect(lease.assertHeld()).rejects.toThrow("ended");
    const next = await gate.acquire();
    await lease.release();
    await next.assertHeld();
    await next.release();
    await expect(gate.run(async () => "resumed")).resolves.toBe("resumed");
  });
  it("waits for a failed admitted writer even when acquisition is cancelled", async () => {
    const gate = new MutationGate();
    let fail!: (error: Error) => void;
    let finished = false;
    const write = gate.run(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    void write.catch(() => {});
    const cancellation = new AbortController();
    const pause = gate.acquire(cancellation.signal).finally(() => {
      finished = true;
    });
    cancellation.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    fail(new Error("disk failed"));
    await expect(pause).rejects.toThrow();
    await expect(gate.run(async () => "available")).resolves.toBe("available");
  });
});
