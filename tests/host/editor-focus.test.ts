import { describe, expect, it } from "vitest";
import { EditorFocusLeases } from "../../apps/desktop/host/editor-focus";

const alpha = {
  taskId: "alpha",
  projectId: "project-alpha",
  projectRevision: 3,
};
const beta = { taskId: "beta", projectId: "project-beta", projectRevision: 1 };

describe("deliberate native editor focus lease", () => {
  it("requires observed shell/overlay intent and a focused window, with no authority from an editor keystroke or automatic mount", () => {
    const focus = new EditorFocusLeases();
    expect(focus.issue(alpha, focus.capture(true), true)).toBeNull();
    focus.input("editor");
    expect(focus.capture(true)).toBeNull();
    focus.input("shell");
    expect(focus.capture(false)).toBeNull();
    const gesture = focus.capture(true);
    expect(focus.issue(alpha, gesture, false)).toBeNull();
    expect(focus.issue(alpha, gesture, true)).toEqual(expect.any(String));
    expect(focus.issue(beta, gesture, true)).toBeNull();
  });

  it("consumes a navigation exactly once, so resize/retry calls cannot reclaim focus", () => {
    const focus = new EditorFocusLeases();
    focus.input("shell");
    const id = focus.issue(alpha, focus.capture(true), true)!;
    const claim = focus.claim(id, alpha)!;
    expect(focus.current(claim)).toBe(true);
    expect(focus.claim(id, alpha)).toBeNull();
    expect(focus.claim(undefined, alpha)).toBeNull();
    focus.finish(claim);
    expect(focus.current(claim)).toBe(false);
    expect(focus.claim(id, alpha)).toBeNull();
  });

  it("allows asynchronous note flush without inventing a deadline, but revokes delayed startup after another click, keystroke, overlay or window blur", async () => {
    for (const interruption of [
      "shell",
      "overlay",
      "editor",
      "blur",
    ] as const) {
      const focus = new EditorFocusLeases();
      focus.input("shell");
      const gesture = focus.capture(true);
      await Promise.resolve(); // A terminal save may complete without another input event.
      const id = focus.issue(alpha, gesture, true)!;
      const claim = focus.claim(id, alpha)!;
      if (interruption === "blur") focus.invalidate();
      else focus.input(interruption);
      expect(focus.current(claim)).toBe(false);
      expect(focus.issue(alpha, gesture, true)).toBeNull();
      expect(focus.claim(id, alpha)).toBeNull();
    }
  });

  it("binds the exact task, project and registration revision and spends mismatched claims", () => {
    for (const changed of [
      beta,
      { ...alpha, projectRevision: 4 },
      { ...alpha, projectId: "replacement" },
    ]) {
      const focus = new EditorFocusLeases();
      focus.input("overlay");
      const id = focus.issue(alpha, focus.capture(true), true)!;
      expect(focus.claim(id, changed)).toBeNull();
      expect(focus.claim(id, alpha)).toBeNull();
    }
  });

  it("scopes native trust approval to its owner and rejects completion after newer input", async () => {
    const focus = new EditorFocusLeases();
    focus.input("review", "alpha");
    const gesture = focus.capture(true);
    expect(focus.issue(beta, gesture, true)).toBeNull();
    await Promise.resolve();
    focus.input("shell"); // The user typed in the notebook during async trust persistence.
    expect(focus.issue(alpha, gesture, true)).toBeNull();
    focus.input("review", "alpha");
    const id = focus.issue(alpha, focus.capture(true), true)!;
    expect(focus.current(focus.claim(id, alpha)!)).toBe(true);
  });

  it("keeps a stale completion from retiring a newer independently issued navigation", () => {
    const focus = new EditorFocusLeases();
    focus.input("shell");
    const first = focus.claim(
      focus.issue(alpha, focus.capture(true), true)!,
      alpha,
    )!;
    focus.input("overlay");
    const second = focus.claim(
      focus.issue(beta, focus.capture(true), true)!,
      beta,
    )!;
    focus.finish(first);
    expect(focus.current(second)).toBe(true);
    expect(focus.current(first)).toBe(false);
  });
});
