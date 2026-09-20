import { AsyncLocalStorage } from "node:async_hooks";

/** Identifies an operation already admitted by the host queue/gate. The token
 * expires at its terminal reply, including in detached asynchronous descendants. */
export class MutationExecutionContext {
  private readonly storage = new AsyncLocalStorage<{ active: boolean }>();
  get active(): boolean {
    return this.storage.getStore()?.active === true;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    const token = { active: true };
    return this.storage.run(token, async () => {
      try {
        return await operation();
      } finally {
        token.active = false;
      }
    });
  }
}
