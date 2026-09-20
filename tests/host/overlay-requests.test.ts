import { describe, expect, it } from "vitest";
import { OverlayRequests } from "../../apps/desktop/host/overlay-requests";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("overlay requests waiting for an actual checkpoint boundary", () => {
  it("dismissal publishes immediately and a late private opening cannot replace it", async () => {
    const requests = new OverlayRequests(),
      checkpoint = deferred(),
      events: string[] = [];
    const opening = requests.publishAfter(
      () => checkpoint.promise,
      async () => {
        events.push("private question");
      },
      () => {
        events.push("error");
      },
    );
    await requests.publishAfter(
      async () => {},
      async () => {
        events.push("closed");
      },
      () => {},
    );
    checkpoint.resolve();
    expect(await opening).toBe(false);
    expect(events).toEqual(["closed"]);
  });

  it("a replacement panel wins even if the older capture later fails", async () => {
    const requests = new OverlayRequests(),
      checkpoint = deferred(),
      events: string[] = [];
    const opening = requests.publishAfter(
      () => checkpoint.promise,
      async () => {
        events.push("old");
      },
      () => {
        events.push("stale error");
      },
    );
    await requests.publishAfter(
      async () => {},
      async () => {
        events.push("settings");
      },
      () => {},
    );
    checkpoint.reject(new Error("Old video capture failed"));
    expect(await opening).toBe(false);
    expect(events).toEqual(["settings"]);
  });

  it("Home or lock invalidation prevents a pending opening without needing renderer dismissal", async () => {
    const requests = new OverlayRequests(),
      checkpoint = deferred(),
      events: string[] = [];
    const opening = requests.publishAfter(
      () => checkpoint.promise,
      async () => {
        events.push("private");
      },
      () => {},
    );
    requests.invalidate();
    checkpoint.resolve();
    expect(await opening).toBe(false);
    expect(events).toEqual([]);
    expect(
      await requests.publishAfter(
        async () => {},
        async () => {
          events.push("new deliberate request");
        },
        () => {},
      ),
    ).toBe(true);
    expect(events).toEqual(["new deliberate request"]);
  });

  it("a current capture failure is reported without hiding the deliberately requested panel", async () => {
    const requests = new OverlayRequests(),
      events: string[] = [];
    expect(
      await requests.publishAfter(
        async () => {
          throw new Error("Capture failed");
        },
        async () => {
          events.push("panel");
        },
        () => {
          events.push("capture warning");
        },
      ),
    ).toBe(true);
    expect(events).toEqual(["capture warning", "panel"]);
  });
});
