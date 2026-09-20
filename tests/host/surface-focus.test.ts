import { expect, it } from "vitest";
import { SurfaceFocusOwnership } from "../../apps/desktop/host/surface-focus";

it("preserves deliberate pending focus across same-view bounds updates while restoration settles", async () => {
  const scope = new SurfaceFocusOwnership();
  const requested = scope.enter("workbench:alpha", "alpha");
  let release!: () => void;
  const restoring = new Promise<void>((resolve) => {
    release = resolve;
  });
  const focusAfterRestore = restoring.then(() => scope.current(requested));
  scope.enter("workbench:alpha", "alpha");
  scope.enter("workbench:alpha", "alpha");
  release();
  expect(await focusAfterRestore).toBe(true);
});

it("revokes old focus across Home, activity changes, and task changes even on a retained view", () => {
  const scope = new SurfaceFocusOwnership();
  for (const change of [
    () => scope.clear(),
    () => scope.enter("preview:alpha", "alpha"),
    () => scope.enter("workbench:alpha", "beta"),
  ]) {
    const pending = scope.enter("workbench:alpha", "alpha");
    change();
    scope.enter("workbench:alpha", "alpha");
    expect(scope.current(pending)).toBe(false);
  }
});
