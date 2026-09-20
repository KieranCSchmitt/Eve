import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script: string;
test.beforeAll(async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL("./fixture.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "FocusFixture",
    define: { "process.env.NODE_ENV": '"development"' },
    jsx: "automatic",
  });
  script = output.outputFiles[0].text;
});

async function setup(
  page: Page,
  contents = '<input id="first"><button id="last">Last</button>',
) {
  await page.setContent(`<main id="background"><button id="opener">Open</button><button id="outside">Outside</button></main>
    <aside id="already-inert" inert="original"><button>Unavailable</button></aside>
    <div id="backdrop"><section id="dialog" role="dialog" aria-label="Recall" aria-modal="true">${contents}</section></div>`);
  await page.addScriptTag({ content: script });
  await page.locator("#opener").focus();
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.escapeCount = 0;
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
      {
        onEscape: () => {
          w.escapeCount++;
        },
      },
    );
  });
}

type TestWindow = {
  FocusFixture: typeof import("./fixture.js");
  cleanup: () => void;
  nestedCleanup?: () => void;
  unmount?: () => void;
  escapeCount: number;
  parentEscapeCount?: number;
  nativeRestoreCount?: number;
};

test("initial focus, bidirectional Tab trapping, preserved inert state, and return focus", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("#first")).toBeFocused();
  await expect(page.locator("#background")).toHaveAttribute("inert", "");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#last")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#first")).toBeFocused();
  await page.evaluate(() => (window as unknown as TestWindow).cleanup());
  await expect(page.locator("#opener")).toBeFocused();
  await expect(page.locator("#background")).not.toHaveAttribute("inert");
  await expect(page.locator("#already-inert")).toHaveAttribute(
    "inert",
    "original",
  );
  await expect(page.locator("#dialog")).not.toHaveAttribute("tabindex");
});

test("dynamic controls, disabled/hidden elements, and checked radios determine tab boundaries", async ({
  page,
}) => {
  await setup(
    page,
    '<button id="first">First</button><button hidden>Hidden</button><button disabled>Disabled</button><input type="radio" name="g"><input id="checked" type="radio" name="g" checked>',
  );
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#checked")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#first")).toBeFocused();
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "new-last";
    button.textContent = "New";
    document.querySelector("#dialog")!.append(button);
  });
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#new-last")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#first")).toBeFocused();
});

test("Escape is consumed once at top layer and respects IME, repeats, and nested editor handling", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.parentEscapeCount = 0;
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") w.parentEscapeCount!++;
    });
    document
      .querySelector("#first")!
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
        }),
      );
    document
      .querySelector("#first")!
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
        }),
      );
    document
      .querySelector("#first")!
      .addEventListener("keydown", (event) => event.preventDefault(), {
        once: true,
      });
  });
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).escapeCount),
  ).toBe(0);
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).escapeCount),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as TestWindow).parentEscapeCount,
    ),
  ).toBe(3);
});

test("programmatic focus escape is contained when inert is disabled", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.cleanup();
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
      { inertOutside: false },
    );
    document.querySelector<HTMLElement>("#last")!.focus();
    document.querySelector<HTMLElement>("#outside")!.focus();
  });
  await expect(page.locator("#last")).toBeFocused();
});

test("a dialog without controls receives focus and retains it", async ({
  page,
}) => {
  await setup(page, "<p>Working…</p>");
  await expect(page.locator("#dialog")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#dialog")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#dialog")).toBeFocused();
});

test("nested portaled dialogs suspend parent trap and restore parent then original opener", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#last").focus();
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    const child = document.createElement("section");
    child.id = "child";
    child.innerHTML =
      '<input id="child-first"><button id="child-last">Close</button>';
    document.body.append(child);
    w.nestedCleanup = w.FocusFixture.activateTransientFocus(child, {
      onEscape: () => {
        w.nestedCleanup!();
        child.remove();
      },
    });
  });
  await expect(page.locator("#child-first")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#child-last")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#last")).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).escapeCount),
  ).toBe(0);
  await page.evaluate(() => (window as unknown as TestWindow).cleanup());
  await expect(page.locator("#opener")).toBeFocused();
});

test("new background portal branches become inert until close", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const extra = document.createElement("button");
    extra.id = "late-background";
    extra.textContent = "Background";
    document.body.append(extra);
  });
  await expect(page.locator("#late-background")).toHaveAttribute("inert", "");
  await page.evaluate(() => (window as unknown as TestWindow).cleanup());
  await expect(page.locator("#late-background")).not.toHaveAttribute("inert");
});

test("selection returns to the note caret, with no scroll jump", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.cleanup();
    const note = document.createElement("div");
    note.id = "note";
    note.contentEditable = "true";
    note.textContent = "Keep this thought";
    document.querySelector("#background")!.append(note);
    note.focus();
    const range = document.createRange();
    range.setStart(note.firstChild!, 5);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
    );
  });
  await page.locator("#first").fill("Search words");
  await page.evaluate(() => (window as unknown as TestWindow).cleanup());
  await expect(page.locator("#note")).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.anchorOffset)).toBe(
    5,
  );
});

test("explicit return target survives a removed opener and cleanup is idempotent", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.cleanup();
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
      {
        returnFocus: () => document.querySelector<HTMLElement>("#outside"),
      },
    );
    document.querySelector("#opener")!.remove();
    w.cleanup();
    w.cleanup();
  });
  await expect(page.locator("#outside")).toBeFocused();
  await expect(page.locator("#background")).not.toHaveAttribute("inert");
});

test("a backwards selection keeps its direction after returning to an input", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.cleanup();
    const editor = document.createElement("textarea");
    editor.id = "editor";
    editor.value = "Keep this thought";
    document.querySelector("#background")!.append(editor);
    editor.focus();
    editor.setSelectionRange(2, 8, "backward");
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
    );
    w.cleanup();
  });
  await expect(page.locator("#editor")).toBeFocused();
  expect(
    await page
      .locator("#editor")
      .evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
        element.selectionDirection,
      ]),
  ).toEqual([2, 8, "backward"]);
});

test("removed dialog still restores focus on teardown", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    document.querySelector("#dialog")!.remove();
    (window as unknown as TestWindow).cleanup();
  });
  await expect(page.locator("#opener")).toBeFocused();
  await expect(page.locator("#background")).not.toHaveAttribute("inert");
});

test("host native focus restoration can override DOM focus; dismissal can suppress restoration", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.cleanup();
    w.nativeRestoreCount = 0;
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
      {
        onRestoreFocus: () => {
          w.nativeRestoreCount!++;
          return true;
        },
      },
    );
    w.cleanup();
  });
  expect(
    await page.evaluate(
      () => (window as unknown as TestWindow).nativeRestoreCount,
    ),
  ).toBe(1);
  await expect(page.locator("#opener")).not.toBeFocused();
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    document.querySelector<HTMLElement>("#opener")!.focus();
    w.cleanup = w.FocusFixture.activateTransientFocus(
      document.querySelector<HTMLElement>("#dialog")!,
      { restoreFocus: false },
    );
    w.cleanup();
  });
  await expect(page.locator("#opener")).not.toBeFocused();
});

test("React rerenders keep focus and use the latest dismissal callback, including StrictMode cleanup", async ({
  page,
}) => {
  await page.setContent('<div id="react-root"></div>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.unmount = w.FocusFixture.mountReactFixture(
      document.querySelector<HTMLElement>("#react-root")!,
    );
  });
  await page.locator("#opener").click();
  await expect(page.locator("#query")).toBeFocused();
  await page.locator("#rerender").click();
  await expect(page.locator("#rerender")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(page.locator("#react-root")).toHaveAttribute(
    "data-closed-with-revision",
    "1",
  );
  await expect(page.locator("#opener")).toBeFocused();
  await page.locator("#opener").click();
  await page.evaluate(() => (window as unknown as TestWindow).unmount!());
  expect(await page.locator("[inert]").count()).toBe(0);
});
