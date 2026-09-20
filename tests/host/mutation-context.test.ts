import { describe, expect, it } from "vitest";
import { MutationExecutionContext } from "../../apps/desktop/host/mutation-context";

describe("serialized mutation capture context", () => {
  it("recognizes the held operation across awaited work but expires detached descendants on terminal completion", async () => {
    const context = new MutationExecutionContext();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<boolean>;
    expect(context.active).toBe(false);
    await context.run(async () => {
      expect(context.active).toBe(true);
      await Promise.resolve();
      expect(context.active).toBe(true);
      detached = wait.then(() => context.active);
    });
    release();
    expect(await detached).toBe(false);
    expect(context.active).toBe(false);
  });
  it("expires on rejection and never admits an unrelated concurrent caller", async () => {
    const context = new MutationExecutionContext();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = context.run(async () => {
      await wait;
      throw new Error("failed");
    });
    expect(context.active).toBe(false);
    release();
    await expect(held).rejects.toThrow("failed");
    expect(context.active).toBe(false);
  });
});
