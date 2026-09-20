import { describe, expect, it } from "vitest";
import { initializeOwnedResource } from "../../apps/desktop/host/owned-resource";
import { WorkbenchRegistry } from "../../apps/desktop/host/workbench-registry";

describe("partially initialized owned runtime", () => {
  it("retains a constructed service when asynchronous startup and its authenticated stop fail", async () => {
    let rejectStartup!: (error: Error) => void;
    let stops = 0;
    const constructed = {
      started: false,
      start: async () => {
        constructed.started = true;
        await new Promise<void>((_resolve, reject) => {
          rejectStartup = reject;
        });
      },
      close: async () => {
        if (++stops === 1)
          throw new Error("Supervisor stop is not yet acknowledged");
      },
    };
    const registry = new WorkbenchRegistry<{
      service: typeof constructed;
      initializationError?: Error;
    }>({
      maxEntries: 1,
      create: async () =>
        initializeOwnedResource<{
          service: typeof constructed;
          initializationError?: Error;
        }>(
          {
            value: { service: constructed },
            dispose: () => constructed.close(),
          },
          () => constructed.start(),
        ),
      prepareClose: async () => ({
        assertHeld: async () => {},
        release: async () => {},
      }),
    });
    const identity = {
      projectId: "partially-started",
      canonicalRoot: "/projects/partial",
      rootIdentity: { device: "1", inode: "9" },
    };
    const opening = registry.ensure(identity);
    await expect.poll(() => constructed.started).toBe(true);
    expect(registry.size).toBe(1);
    rejectStartup(new Error("The runtime never announced its endpoint"));
    const retained = await opening;
    expect(retained.value.service).toBe(constructed);
    expect(retained.value.initializationError).toBeInstanceOf(AggregateError);
    expect(registry.get(identity.projectId)?.value.service).toBe(constructed);
    expect(stops).toBe(1);
    expect(
      await registry.close(identity.projectId, {
        reason: "Retry authenticated cleanup",
      }),
    ).toEqual({ closed: true });
    expect(stops).toBe(2);
    expect(registry.size).toBe(0);
  });

  it("awaits complete cleanup before rejecting a factory and allowing an isolated retry", async () => {
    let finish!: () => void,
      disposed = false,
      rejected = false;
    const error = new Error("observer setup failed");
    const resource = {
      value: {} as { initializationError?: Error },
      dispose: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        disposed = true;
      },
    };
    const operation = initializeOwnedResource(resource, () => {
      throw error;
    });
    const observed = operation.catch((failure) => {
      rejected = true;
      return failure;
    });
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(disposed).toBe(false);
    finish();
    expect(await observed).toBe(error);
    expect(disposed).toBe(true);
  });
  it("retains registry capacity and the exact process handle when setup and cleanup both fail, until explicit disposal succeeds", async () => {
    const processHandle = {},
      setupFailure = new Error("setup failed"),
      cleanupFailure = new Error("authenticated stop unavailable");
    let stops = 0;
    const registry = new WorkbenchRegistry<{
      processHandle: object;
      initializationError?: Error;
    }>({
      maxEntries: 1,
      create: async () =>
        initializeOwnedResource<{
          processHandle: object;
          initializationError?: Error;
        }>(
          {
            value: { processHandle },
            dispose: async () => {
              if (++stops === 1) throw cleanupFailure;
            },
          },
          () => {
            throw setupFailure;
          },
        ),
      prepareClose: async () => ({
        assertHeld: async () => {},
        release: async () => {},
      }),
    });
    const identity = {
      projectId: "alpha",
      canonicalRoot: "/projects/alpha",
      rootIdentity: { device: "1", inode: "10" },
    };
    const entry = await registry.ensure(identity);
    expect(entry.value.processHandle).toBe(processHandle);
    expect((entry.value.initializationError as AggregateError).errors).toEqual([
      setupFailure,
      cleanupFailure,
    ]);
    expect((await registry.ensure(identity)).value.initializationError).toBe(
      entry.value.initializationError,
    );
    await expect(
      registry.ensure({
        projectId: "beta",
        canonicalRoot: "/projects/beta",
        rootIdentity: { device: "1", inode: "11" },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY" });
    expect(registry.size).toBe(1);
    expect(stops).toBe(1);
    expect(
      await registry.close("alpha", { reason: "Retry owned cleanup" }),
    ).toEqual({ closed: true });
    expect(stops).toBe(2);
    expect(registry.size).toBe(0);
  });
});
