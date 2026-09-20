import type { WorkbenchResource } from "./workbench-registry";

/** Finish initialization only after the resource has an owned disposal handle.
 * A rejected factory promises terminal cleanup. If that promise cannot be kept,
 * retain a failed entry so callers can refuse use and retry explicit disposal. */
export async function initializeOwnedResource<
  T extends { initializationError?: Error },
>(
  resource: WorkbenchResource<T>,
  setup: () => void | Promise<void>,
): Promise<WorkbenchResource<T>> {
  try {
    await setup();
    return resource;
  } catch (error) {
    try {
      await resource.dispose();
    } catch (cleanupError) {
      resource.value.initializationError = new AggregateError(
        [error, cleanupError],
        "The code editor could not finish opening or closing. Close this project before reopening it.",
      );
      return resource;
    }
    throw error;
  }
}
