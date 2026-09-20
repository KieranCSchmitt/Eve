import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type FixtureModule = typeof import("./renderer-fixture");
type FixtureWindow = {
  RendererFixture: FixtureModule;
  overlay: ReturnType<FixtureModule["mountOverlayFixture"]>;
  fixture: ReturnType<FixtureModule["mountAppFixture"]>;
};
let script: string;
let styles: string;
test.beforeAll(async () => {
  const output = await build({
    entryPoints: [
      fileURLToPath(new URL("./renderer-fixture.tsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    outfile: "renderer-fixture.js",
    format: "iife",
    loader: { ".woff2": "dataurl", ".woff": "dataurl" },
    globalName: "RendererFixture",
    define: { "process.env.NODE_ENV": '"development"' },
    jsx: "automatic",
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  styles =
    (await readFile(
      new URL("../../apps/desktop/renderer/src/styles.css", import.meta.url),
      "utf8",
    )) +
    "\n" +
    (output.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "");
});
test.beforeEach(async ({ page }) => {
  // Match the secure app origin requirement used by crypto.randomUUID in production.
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
});
async function overlay(
  page: Page,
  kind: "recall" | "intent" | "system" = "recall",
) {
  await page.evaluate((kind) => {
    const w = window as unknown as FixtureWindow;
    w.overlay = w.RendererFixture.mountOverlayFixture(
      document.getElementById("root")!,
      kind,
    );
  }, kind);
  if (kind === "recall")
    await expect(
      page.getByRole("combobox", { name: "Search tasks" }),
    ).toBeFocused();
  else if (kind === "intent")
    await expect(page.getByRole("textbox", { name: "Ask Eve" })).toBeFocused();
  else
    await expect(
      page.getByRole("dialog", { name: "Workspace settings" }),
    ).toBeVisible();
}
async function app(
  page: Page,
  initial: "note" | "project" = "note",
  fail = false,
  platform = "darwin",
) {
  await page.evaluate(
    ({ initial, fail, platform }) => {
      const w = window as unknown as FixtureWindow;
      w.fixture = w.RendererFixture.mountAppFixture(
        document.getElementById("root")!,
        initial,
        fail,
        platform,
      );
    },
    { initial, fail, platform },
  );
  if (initial === "note")
    await expect(page.locator('[data-note-task="note-a"]')).toBeFocused();
  else await expect(page.getByTestId("preview-surface")).toBeVisible();
}
async function chooseTask(page: Page, taskId: string) {
  await page
    .getByRole("button", { name: "Find anything", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.overlay?.kind,
      ),
    )
    .toBe("recall");
  await page.evaluate((taskId) => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({
      instanceId: state.overlay!.instanceId,
      type: "select-task",
      taskId,
    });
  }, taskId);
}

test("Recall Enter on Close and New space preserves native button semantics", async ({
  page,
}) => {
  await overlay(page);
  await expect(
    page.getByRole("combobox", { name: "Search tasks" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close search" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([{ type: "close", instanceId: "overlay-1" }]);
  await page.getByRole("button", { name: "New space" }).focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).overlay.actions.at(-1),
    ),
  ).toEqual({
    type: "create-task",
    instanceId: "overlay-1",
    title: "Untitled space",
  });
});

test("Recall selection clamps to real rows and ignores Enter during composition", async ({
  page,
}) => {
  await overlay(page);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: /Another idea/ }),
  ).toHaveAttribute("aria-selected", "true");
  const query = page.getByRole("combobox", { name: "Search tasks" });
  await query.fill("編集中");
  await expect(page.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
  await query.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([]);
  await query.press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    { instanceId: "overlay-1", type: "create-task", title: "編集中" },
  ]);
});

test("late Recall search cannot replace results for the current query", async ({
  page,
}) => {
  await overlay(page);
  const query = page.getByRole("combobox", { name: "Search tasks" });
  await query.fill("slow");
  await page.waitForTimeout(120);
  await query.fill("fast");
  await expect(
    page.getByRole("option", { name: /Another idea/ }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await expect(page.getByRole("option", { name: /First idea/ })).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Another idea/ }),
  ).toBeVisible();
});

test("intent composition never submits; edits preserve text in canonical action messages", async ({
  page,
}) => {
  await overlay(page, "intent");
  const input = page.getByRole("textbox", { name: "Ask Eve" });
  await input.fill("What is this?");
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).overlay.actions.filter(
        (action) => action.type === "intent-submit",
      ),
    ),
  ).toEqual([]);
  await input.press("Enter");
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).overlay.actions.at(-1),
    ),
  ).toMatchObject({
    type: "intent-submit",
    taskId: "note-a",
    text: "What is this?",
  });
});

test("curve has complete keyboard control including legal overshoot", async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).RendererFixture.mountCurveFixture(
      document.getElementById("root")!,
    ),
  );
  await page.locator("summary").focus();
  await page.keyboard.press("Enter");
  const time = page.getByRole("spinbutton", { name: "First point: time" });
  await time.fill("0.75");
  await time.press("ArrowUp");
  await expect(time).toHaveValue("0.76");
  await page
    .getByRole("spinbutton", { name: "First point: progress" })
    .fill("1.4");
  await expect(page.getByRole("img")).toHaveAttribute(
    "aria-label",
    "Easing curve 0.76, 1.4, 0.36, 1",
  );
});

test("note save failure keeps text and reports unsaved; retry acknowledges durable success", async ({
  page,
}) => {
  await app(page, "note", true);
  await page
    .getByTestId("note-editor")
    .fill("A thought that must survive failure.");
  await expect(
    page.getByText("Not saved · your text is still here"),
  ).toBeVisible();
  await expect(page.getByTestId("note-editor")).toHaveText(
    "A thought that must survive failure.",
  );
  await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = false;
  });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByText("Saved on this computer")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(1);
});

test("note selection and editing history stay alive through task recall", async ({
  page,
}) => {
  await app(page);
  const note = page.locator('[data-testid="note-editor"]:visible');
  await note.click();
  await note.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText("A thought with history.");
  await expect(note).toHaveText("A thought with history.");
  await expect(page.getByText("Saved on this computer")).toBeVisible();
  await note.press("Home");
  await note.press("ArrowRight");
  await note.press("ArrowRight");
  const offset = await page.evaluate(
    () => document.getSelection()?.anchorOffset,
  );
  await chooseTask(page, "note-b");
  await expect(
    page.getByRole("heading", { name: "Another idea", exact: true }),
  ).toBeVisible();
  await chooseTask(page, "note-a");
  await expect(note).toHaveText("A thought with history.");
  await expect(note).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.anchorOffset)).toBe(
    offset,
  );
  await expect(page.locator('[data-testid="note-editor"]')).toHaveCount(2);
  await expect(
    page
      .locator(".notes-layout:visible")
      .getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
});

test("clean note reconciles external durable revision without emitting an autosave", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toHaveText("Original idea");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishNote(
      "<p>Updated outside this editor.</p>",
    ),
  );
  await expect(page.getByTestId("note-editor")).toHaveText(
    "Updated outside this editor.",
  );
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
});

test("opening native overlays leaves the underlying surface alive and ignores stale events", async ({
  page,
}) => {
  await app(page, "project");
  await expect(page.getByTestId("preview-surface")).toBeVisible();
  const baseline = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture.hideCalls,
  );
  await page
    .getByRole("button", { name: "Find anything", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.overlay?.kind,
      ),
    )
    .toBe("recall");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.sendAction({
      instanceId: "stale",
      type: "select-task",
      taskId: "note-a",
    }),
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.snapshot.activeTaskId,
    ),
  ).toBe("project");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.hideCalls,
    ),
  ).toBe(baseline);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.surfaceCalls.every(
        (call) => call.visible,
      ),
    ),
  ).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("recall shortcut requires its modifiers and handles the macOS Option character", async ({
  page,
}) => {
  await app(page, "project");
  await page.getByRole("heading", { name: "Make room for focus." }).waitFor();
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.overlay,
    ),
  ).toBeNull();
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "˚",
        code: "KeyK",
        metaKey: true,
        altKey: true,
        bubbles: true,
      }),
    ),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.overlay?.kind,
      ),
    )
    .toBe("recall");
});

test("imported text is a separate read-only reference and cannot execute embedded markup", async ({
  page,
}) => {
  await app(page);
  await page.getByRole("button", { name: "Add material" }).click();
  await expect(
    page.getByText("Read-only reference", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".text-artifact pre")).toContainText(
    "<script>window.importedScriptRan = true</script>",
  );
  await expect(page.getByTestId("note-editor")).toHaveText("Original idea");
  expect(await page.evaluate(() => "importedScriptRan" in window)).toBe(false);
});

test("learning keeps authored notes available and states an embedding failure honestly", async ({
  page,
}) => {
  await app(page, "project");
  await page
    .getByRole("button", { name: /Why some motion feels better/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Follow your curiosity." }),
  ).toBeVisible();
  await expect(
    page.getByText("STUDY NOTES · NOT A TRANSCRIPT", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This video cannot play inside Eve. Open the original source to watch it.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("video-surface")).toBeVisible();
  await page.getByRole("button", { name: "Open original" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.openedSources,
    ),
  ).toEqual(["lesson"]);
  await page.getByRole("button", { name: "Try the curve" }).click();
  await expect(
    page.getByRole("heading", { name: "A feeling, in motion." }),
  ).toBeVisible();
});

test("arbitrary note spaces attach a reference without pretending the page was read", async ({
  page,
}) => {
  await app(page);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Add a link" }).click();
  await page
    .getByRole("textbox", { name: "A name to remember" })
    .fill("A useful article");
  await page
    .getByRole("textbox", { name: "Source link" })
    .fill("https://example.com/article");
  await page.getByRole("button", { name: "Bring it here" }).click();
  await expect(
    page.getByRole("heading", { name: "A useful article" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This reference is saved as a link. Its page has not been read or summarized here.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("video-surface")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to your work" }).click();
  await expect(page.getByTestId("note-editor")).toBeVisible();
});

async function ask(page: Page, text = "Make the plan clearer") {
  await page
    .getByRole("button", {
      name: /Ask Eve|View response|Eve is working/,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.overlay?.kind,
      ),
    )
    .toBe("intent");
  await page.evaluate((text) => {
    const state = (window as unknown as FixtureWindow).fixture;
    const current = state.overlay!;
    if (current.kind !== "intent") throw new Error("Expected intent panel");
    state.sendAction({
      type: "intent-submit",
      instanceId: current.instanceId,
      taskId: current.taskId,
      text,
    });
  }, text);
}

test("intent shows real configuration, source provenance, and gates apply behind an explicit preview", async ({
  page,
}) => {
  await overlay(page, "intent");
  await expect(
    page.getByText("On this computer · AI unavailable · AI is not set up yet", {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    w.overlay.update({
      ...w.overlay.state,
      response: w.RendererFixture.responseFixture(),
    });
  });
  await expect(
    page.getByText("On this computer", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Your notes", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Meet near the library.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply change" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Preview change" }).click();
  await expect(
    page.getByRole("region", { name: "Before change" }),
  ).toContainText("Original idea");
  await expect(
    page.getByRole("region", { name: "After change" }),
  ).toContainText("A clear meeting plan.");
  await page.screenshot({
    path: test.info().outputPath("intent-proposal.png"),
  });
  await page.getByRole("button", { name: "Apply change" }).click();
  await page.getByRole("button", { name: "Open source", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    {
      type: "proposal-apply",
      instanceId: "overlay-1",
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "proposal-1",
    },
    {
      type: "intent-source-open",
      instanceId: "overlay-1",
      taskId: "note-a",
      requestId: "request-1",
      sourceId: "source-1",
    },
  ]);
});

test("model text and proposal markup cannot add executable content or navigation", async ({
  page,
}) => {
  await overlay(page, "intent");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    const response = w.RendererFixture.responseFixture();
    response.message =
      '**Useful thought** <script>window.modelRan=true</script> <img src="https://invalid.example/probe" onerror="window.modelRan=true"> [Click me](javascript:window.modelRan=true)';
    response.proposals[0].after =
      '<p>A safe preview</p><iframe src="https://invalid.example"></iframe><button autofocus onclick="window.modelRan=true">Dangerous action</button>';
    w.overlay.update({ ...w.overlay.state, response });
  });
  await expect(page.getByText("Useful thought", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview change" }).click();
  await expect(
    page.getByRole("region", { name: "After change" }),
  ).toContainText("A safe preview");
  expect(
    await page
      .locator(
        ".intent-response script, .intent-response img, .intent-response iframe, .intent-response a, .proposal-comparison button",
      )
      .count(),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { modelRan?: boolean }).modelRan,
    ),
  ).toBeUndefined();
  await expect(
    page.getByRole("button", { name: "Dangerous action" }),
  ).toHaveCount(0);
});

test("expired, stale, unsupported, and applied proposals have no apply affordance", async ({
  page,
}) => {
  await overlay(page, "intent");
  for (const status of [
    "expired",
    "stale",
    "unsupported",
    "applied",
  ] as const) {
    await page.evaluate((status) => {
      const w = window as unknown as FixtureWindow;
      if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
      const response = w.RendererFixture.responseFixture();
      response.proposals[0].status = status;
      w.overlay.update({ ...w.overlay.state, response });
    }, status);
    await expect(
      page.getByRole("button", { name: "Apply change" }),
    ).toHaveCount(0);
  }
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([]);
});

test("intent has cancellation before a request receipt and does not block Escape during work", async ({
  page,
}) => {
  await overlay(page, "intent");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    w.overlay.update({
      ...w.overlay.state,
      requesting: true,
      text: "Clarify this",
    });
  });
  await expect(
    page.getByRole("button", { name: "Submit question" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel request" }).click();
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    { type: "intent-cancel", instanceId: "overlay-1", taskId: "note-a" },
    { type: "close", instanceId: "overlay-1" },
  ]);
});

test("early result is bound to its receipt and a late progress message cannot erase it", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.earlyResponse = true;
  });
  await ask(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.response?.status : undefined;
      }),
    )
    .toBe("complete");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.fixture.publishIntelligence({
      type: "intent",
      response: {
        ...w.RendererFixture.responseFixture(),
        status: "running",
        message: "Late progress",
      },
    });
    w.fixture.publishIntelligence({
      type: "intent",
      response: {
        ...w.RendererFixture.responseFixture("unrelated"),
        message: "Unrelated answer",
      },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.response?.message : undefined;
      }),
    )
    .toBe("Keep the plan clear and welcoming.");
});

test("cancel before receipt cancels the eventual host ID and rejects late completion", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.receiptDelay = true;
  });
  await ask(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.asks.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({
      type: "intent-cancel",
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
    });
    state.releaseReceipt("request-1");
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.cancelled,
      ),
    )
    .toEqual(["request-1"]);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.fixture.publishIntelligence({
      type: "intent",
      response: w.RendererFixture.responseFixture(),
    });
  });
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as FixtureWindow).fixture.overlay;
      return state?.kind === "intent" ? state.response : null;
    }),
  ).toBeUndefined();
});

test("dismissed results stay with their space without reopening or moving note focus", async ({
  page,
}) => {
  await app(page);
  await ask(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.asks.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({ type: "close", instanceId: state.overlay!.instanceId });
  });
  const editor = page.getByTestId("note-editor");
  await editor.focus();
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.fixture.publishIntelligence({
      type: "intent",
      response: w.RendererFixture.responseFixture(),
    });
  });
  await expect(
    page.getByRole("button", { name: "View response" }),
  ).toBeVisible();
  await expect(editor).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.overlay,
    ),
  ).toBeNull();
  await chooseTask(page, "note-b");
  await expect(page.getByRole("button", { name: "Ask Eve" })).toBeVisible();
  await chooseTask(page, "note-a");
  await expect(
    page.getByRole("button", { name: "View response" }),
  ).toBeVisible();
});

test("duplicate apply actions make one host mutation, with busy and durable status", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.earlyResponse = true;
  });
  await ask(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.response?.status : undefined;
      }),
    )
    .toBe("complete");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    const action = {
      type: "proposal-apply" as const,
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "proposal-1",
    };
    state.sendAction(action);
    state.sendAction(action);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent"
          ? state.response?.proposals[0].status
          : undefined;
      }),
    )
    .toBe("applied");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.proposalCalls.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.rendererStates.some(
        (state) => state.busy,
      ),
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
      ),
    )
    .toEqual({ dirty: false, busy: false });
});

test("note dirty state reaches the host immediately and a failed close is explicitly cancelled", async ({
  page,
}) => {
  await app(page, "note", true);
  await page.getByTestId("note-editor").fill("This is not safely saved yet.");
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
    ),
  ).toEqual({ dirty: true, busy: true });
  await expect(
    page.getByText("Not saved · your text is still here", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.closeReadies,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
    ),
  ).toEqual({ dirty: true, busy: false });
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = false;
  });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
      ),
    )
    .toEqual({ dirty: false, busy: false });
});

test("host attention changes activity only in the active space and preserves native overlay dismissal", async ({
  page,
}) => {
  await app(page, "project");
  await ask(page, "open the code");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishAttention({
      taskId: "note-b",
      activity: "notes",
    }),
  );
  await expect(page.getByTestId("preview-surface")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishAttention({
      taskId: "project",
      activity: "code",
    }),
  );
  await expect(page.getByTestId("workbench-surface")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as FixtureWindow).fixture.overlay),
    )
    .toBeNull();
});

test("local-only availability never advertises configured cloud access or a quarantined local runtime", async ({
  page,
}) => {
  await overlay(page, "intent");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    w.overlay.update({
      ...w.overlay.state,
      settings: {
        ...w.RendererFixture.emptyIntelligence,
        providers: [
          {
            id: "cloud",
            kind: "cloud",
            model: "test",
            enabled: true,
            protocol: "openai-responses",
            endpoint: "https://api.openai.com/v1",
            roles: ["explain"],
            authentication: "credential-store",
            credentialPresent: true,
            storage: "secure",
          },
          {
            id: "local",
            kind: "local",
            model: "test",
            enabled: true,
            protocol: "openai-chat-completions",
            endpoint: "http://127.0.0.1:8000/v1",
            roles: ["explain"],
            authentication: "none",
            credentialPresent: false,
            storage: "runtime-only",
            quarantined: true,
          },
        ],
        localRecoveryRequired: true,
      },
    });
  });
  await expect(
    page.getByText("On this computer · AI unavailable while reconnecting", {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    w.overlay.update({
      ...w.overlay.state,
      policy: { processing: "hybrid", assistancePaused: false },
    });
  });
  await expect(
    page.getByText("Online AI allowed · Online AI set up", {
      exact: true,
    }),
  ).toBeVisible();
});

test("editor selection asks open a suggestion without submitting and video panels keep honest paused state", async ({
  page,
}) => {
  await app(page, "project");
  await expect(page.getByTestId("preview-surface")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.askSelection(),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.text : undefined;
      }),
    )
    .toBe("Explain this selection");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.asks,
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({ type: "close", instanceId: state.overlay!.instanceId });
  });
  await page
    .getByRole("button", { name: /Why some motion feels better/ })
    .click();
  await expect(page.getByTestId("video-surface")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.sourceContexts.at(-1),
      ),
    )
    .toEqual({ taskId: "project", sourceId: "lesson" });
  await page.getByRole("button", { name: "Ask Eve" }).click();
  await expect(
    page.getByText("Video paused while this panel is open.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("video-surface")).toContainText("Video paused");
});

test("saved web references become the selected context and clear when leaving sources", async ({
  page,
}) => {
  await app(page);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Add a link", exact: true }).click();
  await page
    .getByRole("textbox", { name: "A name to remember" })
    .fill("A source for the idea");
  await page
    .getByRole("textbox", { name: "Source link" })
    .fill("https://example.com/reference");
  await page.getByRole("button", { name: "Bring it here", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.sourceContexts.at(-1),
      ),
    )
    .toEqual({ taskId: "note-a", sourceId: "source-1" });
  await page
    .getByRole("button", { name: "Back to your work", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.sourceContexts.at(-1),
      ),
    )
    .toEqual({ taskId: "note-a", sourceId: null });
});

test("an untouched startup reports clean state and acknowledges close", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
      ),
    )
    .toEqual({ dirty: false, busy: false });
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeReadies,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.closeCancellations,
    ),
  ).toBe(0);
});

test("close drains a newer edit that arrived during the first save before acknowledging readiness", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.saveDelayMs = 150;
  });
  await page.getByTestId("note-editor").fill("First pending edit.");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.saveAttempts,
      ),
    )
    .toBe(1);
  await page.getByTestId("note-editor").fill("A newer edit must also survive.");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.closeReadies,
    ),
  ).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeReadies,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "note-a",
        )!.note.body,
    ),
  ).toContain("A newer edit must also survive.");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(2);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
    ),
  ).toEqual({ dirty: false, busy: false });
});

async function linuxOverlay(page: Page) {
  await overlay(page, "system");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({
      ...w.overlay.state,
      host: w.RendererFixture.linuxHost,
      system: structuredClone(w.RendererFixture.linuxSystem),
    });
  });
}
async function openSystem(page: Page) {
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.overlay?.kind,
      ),
    )
    .toBe("system");
}

test("application mode on macOS exposes workspace policy without pretend desktop controls", async ({
  page,
}) => {
  await overlay(page, "system");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({
      ...w.overlay.state,
      host: { ...w.RendererFixture.linuxHost, platform: "darwin", mode: "app" },
    });
  });
  await expect(
    page.getByRole("radio", { name: "On this computer only", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("slider", { name: "System volume" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Lock desktop" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Saved connections" }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).overlay.unmount(),
  );
  await app(page);
  await openSystem(page);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.systemReads,
    ),
  ).toBe(0);
});

test("Linux missing capabilities show unavailable state without invented sound or network values", async ({
  page,
}) => {
  await linuxOverlay(page);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({
      ...w.overlay.state,
      system: {
        available: true,
        audio: { available: false },
        network: { available: false, active: [] },
        session: false,
      },
    });
  });
  await expect(
    page.getByText("Audio controls are unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Network status is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Power" })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({
      ...w.overlay.state,
      system: { ...w.overlay.state.system!, available: false },
    });
  });
  await expect(
    page.getByText("Eve cannot access this computer’s system controls.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Lock desktop" })).toHaveCount(
    0,
  );
});

test("Linux volume uses keyboard commit and actual mute state; pending actions disable repeat controls", async ({
  page,
}) => {
  await linuxOverlay(page);
  const slider = page.getByRole("slider", { name: "System volume" });
  await expect(slider).toHaveValue("40");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("41");
  await page.getByRole("button", { name: "Mute sound", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    {
      type: "system-action",
      instanceId: "overlay-1",
      taskId: "note-a",
      action: { type: "volume", percent: 41 },
    },
    {
      type: "system-action",
      instanceId: "overlay-1",
      taskId: "note-a",
      action: { type: "mute", muted: true },
    },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({ ...w.overlay.state, systemBusy: true });
  });
  await expect(slider).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Mute sound", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Lock desktop" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({
      ...w.overlay.state,
      systemBusy: false,
      system: {
        ...w.overlay.state.system!,
        audio: { available: true, volume: 41, muted: true },
      },
    });
  });
  await expect(
    page.getByRole("button", { name: "Unmute sound" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Linux saved connections are explicit selections and never connect just by expanding", async ({
  page,
}) => {
  await linuxOverlay(page);
  await expect(
    page.getByText("Home connection", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Saved connections" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    { type: "system-networks", instanceId: "overlay-1", taskId: "note-a" },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "system") throw new Error("Expected settings");
    w.overlay.update({
      ...w.overlay.state,
      savedNetworks: [
        ...w.RendererFixture.linuxSystem.network.active,
        {
          uuid: "studio-saved",
          name: "Studio connection",
          type: "ethernet",
          device: null,
        },
      ],
    });
  });
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Choose a connection" })
    .selectOption("wifi-active");
  await expect(
    page.getByRole("button", { name: "Already connected" }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Choose a connection" })
    .selectOption("studio-saved");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).overlay.actions.at(-1),
    ),
  ).toEqual({
    type: "system-action",
    instanceId: "overlay-1",
    taskId: "note-a",
    action: { type: "connect", uuid: "studio-saved" },
  });
  await page.screenshot({
    path: test.info().outputPath("linux-system-controls.png"),
  });
});

test("session actions require a specific confirmation and Cancel performs nothing", async ({
  page,
}) => {
  await linuxOverlay(page);
  await page.getByRole("button", { name: "Power" }).click();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Confirm restart" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Confirm restart" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Shut down", exact: true }).click();
  await page
    .getByRole("group", { name: "Confirm shut down" })
    .getByRole("button", { name: "Shut down", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    {
      type: "system-action",
      instanceId: "overlay-1",
      taskId: "note-a",
      action: { type: "exit", action: "shutdown" },
    },
  ]);
});

test("failed system actions remain truthful and duplicate requests are suppressed while busy", async ({
  page,
}) => {
  await app(page, "note", false, "linux");
  await openSystem(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.system?.available : undefined;
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.systemActionDelay = 120;
    state.systemActionResult = {
      performed: false,
      reason: "The audio service declined the change.",
    };
    const action = {
      type: "system-action" as const,
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      action: { type: "volume" as const, percent: 80 },
    };
    state.sendAction(action);
    state.sendAction(action);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.systemBusy : undefined;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.systemMessage : undefined;
      }),
    )
    .toBe("The audio service declined the change.");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.systemActions.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.system.audio.volume,
    ),
  ).toBe(40);
});

test("session exit can settle a pending note without awaiting its own system action", async ({
  page,
}) => {
  await app(page, "note", false, "linux");
  await page.getByTestId("note-editor").fill("Keep this before logout.");
  await openSystem(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.system?.available : undefined;
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.exitRequiresSettlement = true;
    state.sendAction({
      type: "system-action",
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      action: { type: "exit", action: "logout" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeReadies,
      ),
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.systemBusy : undefined;
      }),
    )
    .toBe(false);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "note-a",
        )!.note.body,
    ),
  ).toContain("Keep this before logout.");
});

test("a failed note save cancels session exit and retains dirty state", async ({
  page,
}) => {
  await app(page, "note", true, "linux");
  await page.getByTestId("note-editor").fill("Do not lose this note.");
  await openSystem(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.system?.available : undefined;
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.exitRequiresSettlement = true;
    state.sendAction({
      type: "system-action",
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      action: { type: "exit", action: "shutdown" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.closeReadies,
    ),
  ).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "system" ? state.systemMessage : undefined;
      }),
    )
    .toBe("Save your note before ending the session.");
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.rendererStates.at(-1),
    ),
  ).toEqual({ dirty: true, busy: false });
});

test("privacy lock closes panels, clears drafts and response presentation, and cancels a late receipt", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.receiptDelay = true;
  });
  await ask(page, "A private question");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.asks.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.privacyLock();
    state.releaseReceipt("request-1");
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as FixtureWindow).fixture.overlay),
    )
    .toBeNull();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.cancelled,
      ),
    )
    .toEqual(["request-1"]);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.fixture.publishIntelligence({
      type: "intent",
      response: w.RendererFixture.responseFixture(),
    });
  });
  await page.getByRole("button", { name: "Ask Eve" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.text : undefined;
      }),
    )
    .toBe("");
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as FixtureWindow).fixture.overlay;
      return state?.kind === "intent" ? state.response : null;
    }),
  ).toBeUndefined();
});

async function selectNoteText(page: Page, anchor: number, head = anchor) {
  await page.locator('[data-note-task="note-a"]').evaluate(
    (element, { anchor, head }) => {
      const text = element.querySelector("p")!.firstChild!;
      document.getSelection()!.setBaseAndExtent(text, anchor, text, head);
    },
    { anchor, head },
  );
}

test("cold note remount restores revision-bound backwards selection and clamped workspace viewport", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishNote(
      Array.from(
        { length: 75 },
        (_, index) =>
          `<p>Line ${index}: a long thought to keep in context.</p>`,
      ).join(""),
    ),
  );
  await expect(page.locator('[data-note-task="note-a"] p')).toHaveCount(75);
  await selectNoteText(page, 18, 4);
  await page.locator(".workspace").evaluate((element) => {
    element.scrollTop = 650;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
            (task) => task.id === "note-a",
          )!.checkpoint?.noteView,
      ),
    )
    .toMatchObject({
      version: 1,
      noteId: "note-a-note",
      noteRevision: 1,
      selection: { anchor: 19, head: 5 },
      scrollTop: 650,
    });
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.remount(),
  );
  await expect(page.locator('[data-note-task="note-a"] p')).toHaveCount(75);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        anchor: document.getSelection()?.anchorOffset,
        head: document.getSelection()?.focusOffset,
      })),
    )
    .toEqual({ anchor: 18, head: 4 });
  await expect
    .poll(() =>
      page.locator(".workspace").evaluate((element) => element.scrollTop),
    )
    .toBe(650);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
});

test("an old note checkpoint cannot replay a cursor or viewport into an externally revised note", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await selectNoteText(page, 8);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks[0]
            .checkpoint?.noteView?.selection.anchor,
      ),
    )
    .toBe(9);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.publishNote("<p>New</p>");
    state.remount();
  });
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText("New");
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.anchorOffset))
    .toBe(0);
  expect(
    await page.locator(".workspace").evaluate((element) => element.scrollTop),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
});

test("retained editors are bounded and an evicted clean note restores its saved selection", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await selectNoteText(page, 7);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.addNotes(8),
  );
  for (let index = 0; index < 8; index++) {
    await chooseTask(page, `extra-${index}`);
    await expect(
      page.locator(`[data-note-task="extra-${index}"]`),
    ).toBeVisible();
    expect(await page.locator("[data-note-task]").count()).toBeLessThanOrEqual(
      7,
    );
  }
  await expect(page.locator('[data-note-task="note-a"]')).toHaveCount(0);
  await chooseTask(page, "note-a");
  await expect(page.locator('[data-note-task="note-a"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.anchorOffset))
    .toBe(7);
  expect(await page.locator("[data-note-task]").count()).toBeLessThanOrEqual(7);
});

test("dirty inactive editors stay pinned beyond the clean cache and retain every unsaved draft", async ({
  page,
}) => {
  await app(page, "note", true);
  // Native Select All updates the editor selection before typing. A direct
  // contenteditable.fill DOM range can race ProseMirror's focus reconciliation.
  await page.getByTestId("note-editor").press("ControlOrMeta+a");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Original idea");
  await page.keyboard.insertText("Private unsaved first draft.");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.addNotes(8);
    state.switchTask("note-b");
  });
  const second = page.locator('[data-note-task="note-b"]');
  await expect(second).toBeFocused();
  await second.press("ControlOrMeta+a");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Original idea");
  await page.keyboard.insertText("Unsaved second draft.");
  for (let index = 0; index < 8; index++) {
    await page.evaluate(
      (index) =>
        (window as unknown as FixtureWindow).fixture.switchTask(
          `extra-${index}`,
        ),
      index,
    );
    await expect(
      page.locator(`[data-note-task="extra-${index}"]`),
    ).toBeVisible();
  }
  expect(await page.locator("[data-note-task]").count()).toBeLessThanOrEqual(9);
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "Private unsaved first draft.",
  );
  await expect(page.locator('[data-note-task="note-b"]')).toHaveText(
    "Unsaved second draft.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
          ?.dirty,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.failSaves = false;
    state.prepareClose();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeReadies,
      ),
    )
    .toBe(1);
  const notes = await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.snapshot.tasks
      .filter((task) => task.id === "note-a" || task.id === "note-b")
      .map((task) => task.note.body),
  );
  expect(notes).toEqual([
    "<p>Private unsaved first draft.</p>",
    "<p>Unsaved second draft.</p>",
  ]);
});

test("an external note revision never gets overwritten by an older pending local draft", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.saveDelayMs = 150;
  });
  await page.getByTestId("note-editor").fill("My unsaved local version.");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.publishNote("<p>A newer external version.</p>");
    state.prepareClose();
  });
  await expect(
    page.getByText("Not saved · your text is still here", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "My unsaved local version.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks[0].note
          .body,
    ),
  ).toBe("<p>A newer external version.</p>");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
});

test("note view acknowledgements do not loop or create authored note writes", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await selectNoteText(page, 5);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks[0]
            .checkpoint?.noteView?.selection.anchor,
      ),
    )
    .toBe(6);
  const revision = await page.evaluate(
    () =>
      (window as unknown as FixtureWindow).fixture.snapshot.tasks[0].checkpoint!
        .revision,
  );
  await page.waitForTimeout(1400);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks[0]
          .checkpoint!.revision,
    ),
  ).toBe(revision);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
});

test("saved material sources open the actual read-only reference without changing the note", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.addMaterialSource("note-a"),
  );
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(page.getByText("SAVED MATERIAL", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "This saved copy stays with your work. Open it as a read-only reference.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open material", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.openedSources,
    ),
  ).toEqual(["material-source"]);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.publishAttention({ taskId: "note-a", activity: "notes" });
    state.material("note-a", "material");
  });
  await expect(
    page.getByText("Read-only reference", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".text-artifact pre")).toContainText(
    "Your original text.",
  );
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "Original idea",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
});

test("asking about selected material waits for its canonical source binding", async ({
  page,
}) => {
  await app(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.addMaterialSource("note-a");
    state.addMaterialSource("note-a", true);
    state.lessonDelayMs = 180;
    state.material("note-a", "material");
  });
  await page
    .getByRole("button", { name: "Second reference.md", exact: true })
    .click();
  await ask(page, "Explain this reference");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.asks.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.askContexts[0],
    ),
  ).toEqual({ taskId: "note-a", sourceId: "material-source-2" });
});

async function conflictingNote(
  page: Page,
  draft = "My local draft.",
  saved = "Saved by another editor.",
) {
  await app(page);
  await page.getByTestId("note-editor").fill(draft);
  await page.evaluate(
    (saved) =>
      (window as unknown as FixtureWindow).fixture.publishNote(
        `<p>${saved}</p>`,
      ),
    saved,
  );
  await expect(
    page.getByRole("button", { name: "Review versions" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review versions" }).click();
  await expect(
    page.getByRole("region", { name: "Saved version", exact: true }),
  ).toContainText(saved);
  await expect(
    page.getByRole("region", { name: "Your draft", exact: true }),
  ).toContainText(draft);
}

test("a note conflict stays local while another space can save, and explicit discard releases close", async ({
  page,
}) => {
  await conflictingNote(page);
  const attempts = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture.saveAttempts,
  );
  await page.getByTestId("note-editor").fill("My revised local draft.");
  await page.waitForTimeout(350);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.saveAttempts,
    ),
  ).toBe(attempts);
  await chooseTask(page, "note-b");
  const other = page.locator('[data-note-task="note-b"]');
  await expect(other).toBeVisible();
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
  await other.fill("Another space keeps moving.");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
            (task) => task.id === "note-b",
          )?.note.body,
      ),
    )
    .toBe("<p>Another space keeps moving.</p>");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
  await chooseTask(page, "note-a");
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "My revised local draft.",
  );
  await page
    .getByRole("button", { name: "Discard draft · keep saved" })
    .click();
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "Saved by another editor.",
  );
  await expect(
    page.getByRole("complementary", { name: "Review note conflict" }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeReadies,
      ),
    )
    .toBe(1);
});

test("conflict review freezes the shown saved revision until an explicit refresh", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishNote(
      "<p>A third version arrived.</p>",
    ),
  );
  const saved = page.getByRole("region", {
    name: "Saved version",
    exact: true,
  });
  await expect(saved).toContainText("Saved by another editor.");
  await expect(saved).not.toContainText("A third version arrived.");
  await expect(
    page.getByRole("button", { name: "Replace saved with draft" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Discard draft · keep saved" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review latest saved version" })
    .click();
  await expect(saved).toContainText("A third version arrived.");
  await expect(saved).toContainText("Version 2");
  await page.getByRole("button", { name: "Replace saved with draft" }).click();
  await expect(
    page.getByRole("complementary", { name: "Review note conflict" }),
  ).toHaveCount(0);
  const result = await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    return {
      note: state.snapshot.tasks[0].note,
      write: state.updateCommands.at(-1),
    };
  });
  expect(result.note.body).toBe("<p>My local draft.</p>");
  expect(result.note.revision).toBe(3);
  expect(result.write?.expectedRevision).toBe(2);
});

test("a change during explicit replacement stays a conflict and preserves both texts", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.saveDelayMs = 200;
  });
  await page.getByRole("button", { name: "Replace saved with draft" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.updateCommands.at(-1)
            ?.expectedRevision,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishNote(
      "<p>A concurrent winner.</p>",
    ),
  );
  await expect(
    page.getByRole("button", { name: "Review latest saved version" }),
  ).toBeEnabled();
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "My local draft.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks[0].note
          .body,
    ),
  ).toBe("<p>A concurrent winner.</p>");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
});

test("typing during an acknowledged replacement saves the newer local edit against only that acknowledgement", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.saveDelayMs = 180;
  });
  await page.getByRole("button", { name: "Replace saved with draft" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.updateCommands.at(-1)
            ?.expectedRevision,
      ),
    )
    .toBe(1);
  await page
    .locator('[data-note-task="note-a"]')
    .fill("The thought continued while saving.");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks[0].note
            .body,
      ),
    )
    .toBe("<p>The thought continued while saving.</p>");
  await expect(
    page.getByRole("complementary", { name: "Review note conflict" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.updateCommands.map(
        (write) => write.expectedRevision,
      ),
    ),
  ).toEqual([1, 2]);
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
});

test("saving a conflict as a new space preserves the original saved version", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.getByRole("button", { name: "Save draft as new space" }).click();
  await expect(page.locator('[data-note-task="copy-1"]')).toHaveText(
    "My local draft.",
  );
  const state = await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    return {
      notes: state.snapshot.tasks.map((task) => ({
        id: task.id,
        body: task.note.body,
      })),
      created: state.createdTasks,
      dirty: state.rendererStates.at(-1)?.dirty,
    };
  });
  expect(state.created).toBe(1);
  expect(state.notes.find((task) => task.id === "note-a")?.body).toBe(
    "<p>Saved by another editor.</p>",
  );
  expect(state.notes.find((task) => task.id === "copy-1")?.body).toBe(
    "<p>My local draft.</p>",
  );
  expect(state.dirty).toBe(false);
  await chooseTask(page, "note-a");
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "Saved by another editor.",
  );
});

test("failed copy persistence retains the original draft and retries the same empty copy safely", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = true;
  });
  await page.getByRole("button", { name: "Save draft as new space" }).click();
  await expect(page.locator('[data-note-task="note-a"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry saving copy" }),
  ).toBeEnabled();
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "My local draft.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
          ?.dirty,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.failSaves = false;
    state.prepareClose();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "Retry saving copy" }).click();
  await expect(page.locator('[data-note-task="copy-1"]')).toHaveText(
    "My local draft.",
  );
  await expect(page.locator('[data-note-task="copy-1"]')).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.createdTasks,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "note-a",
        )?.note.body,
    ),
  ).toBe("<p>Saved by another editor.</p>");
});

test("an uncertain copy acknowledgement replays exactly once and keeps newer original edits", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.dropCopyAckOnce = true;
  });
  await page.getByRole("button", { name: "Save draft as new space" }).click();
  await expect(
    page.getByRole("button", { name: "Retry saving copy" }),
  ).toBeEnabled();
  await page
    .locator('[data-note-task="note-a"]')
    .fill("A newer thought after the failure.");
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = false;
  });
  await page.getByRole("button", { name: "Retry saving copy" }).click();
  await expect(page.locator('[data-note-task="copy-1"]')).toHaveText(
    "My local draft.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
          ?.dirty,
    ),
  ).toBe(true);
  await chooseTask(page, "note-a");
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "A newer thought after the failure.",
  );
  await expect(
    page.getByRole("complementary", { name: "Review note conflict" }),
  ).toContainText("Your newer edits are still here to resolve.");
});

test("a definite copy failure can retry with the current reviewed draft", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = true;
  });
  await page.getByRole("button", { name: "Save draft as new space" }).click();
  await expect(
    page.getByRole("button", { name: "Retry saving copy" }),
  ).toBeEnabled();
  await page
    .locator('[data-note-task="note-a"]')
    .fill("A revised draft to copy.");
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = false;
  });
  await page.getByRole("button", { name: "Retry saving copy" }).click();
  await expect(page.locator('[data-note-task="copy-1"]')).toHaveText(
    "A revised draft to copy.",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.createdTasks,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
          ?.dirty,
    ),
  ).toBe(false);
});

test("an independently edited copy is preserved and a fresh copy requires another explicit choice", async ({
  page,
}) => {
  await conflictingNote(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = true;
  });
  await page.getByRole("button", { name: "Save draft as new space" }).click();
  await expect(
    page.getByRole("button", { name: "Retry saving copy" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.failSaves = false;
    state.publishNote("<p>Independent work in the copy.</p>", "copy-1");
  });
  await page.getByRole("button", { name: "Retry saving copy" }).click();
  await expect(
    page.getByRole("complementary", { name: "Review note conflict" }),
  ).toContainText("The copy changed before it could be saved.");
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "My local draft.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "copy-1",
        )?.note.body,
    ),
  ).toBe("<p>Independent work in the copy.</p>");
  await page.getByRole("button", { name: "Save draft as new space" }).click();
  await expect(page.locator('[data-note-task="copy-2"]')).toHaveText(
    "My local draft.",
  );
});

test("conflict previews show inert document content without loading embedded resources", async ({
  page,
}, testInfo) => {
  await app(page);
  await page.getByTestId("note-editor").fill("A local thought.");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishNote(
      '<p>External saved text</p><img src="https://example.invalid/tracking.png" onerror="window.__injected=true"><script>window.__injected=true</script>',
    ),
  );
  await page.getByRole("button", { name: "Review versions" }).click();
  const region = page.getByRole("complementary", {
    name: "Review note conflict",
  });
  await expect(region).toContainText("External saved text");
  await expect(region.locator("img,script,iframe,a")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __injected?: boolean }).__injected,
    ),
  ).toBeUndefined();
  await page.screenshot({
    path: testInfo.outputPath("note-conflict-review.png"),
    fullPage: true,
  });
});

async function maintenance(page: Page) {
  await page.evaluate(() => {
    const opener = document.createElement("button");
    opener.id = "maintenance-opener";
    opener.textContent = "Background operation menu";
    document.body.appendChild(opener);
    opener.focus();
    const w = window as unknown as FixtureWindow;
    w.overlay = w.RendererFixture.mountOverlayFixture(
      document.getElementById("root")!,
      "maintenance",
    );
  });
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).overlay.actions.filter(
            (action) => action.type === "maintenance-ready",
          ).length,
      ),
    )
    .toBe(1);
}

test("maintenance shields the entire viewport, traps input, and stays open after Escape requests cancellation", async ({
  page,
}, testInfo) => {
  await maintenance(page);
  const dialog = page.getByRole("dialog", { name: "Keeping your work safe." });
  const coverage = await page.evaluate(() => {
    const shield = document.querySelector(".maintenance-shield")!;
    const bounds = shield.getBoundingClientRect();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      viewport: [innerWidth, innerHeight],
      hit: document.elementFromPoint(5, 5) === shield,
      inert: document.getElementById("maintenance-opener")!.inert,
    };
  });
  expect([coverage.x, coverage.y]).toEqual([0, 0]);
  expect([coverage.width, coverage.height]).toEqual(coverage.viewport);
  expect(coverage.hit).toBe(true);
  expect(coverage.inert).toBe(true);
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Cancelling…", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel requested" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    { type: "maintenance-ready", instanceId: "overlay-1" },
    { type: "maintenance-cancel", instanceId: "overlay-1" },
  ]);
  await page.screenshot({
    path: testInfo.outputPath("maintenance-cancelling.png"),
  });
});

test("maintenance readiness is once per instance and host cancellation never dismisses or restores old focus", async ({
  page,
}) => {
  await maintenance(page);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).overlay;
    state.update({
      kind: "maintenance",
      instanceId: "overlay-1",
      taskId: "note-a",
      title: "Keeping your work safe.",
      detail: "Finishing the current backup step.",
      phase: "cancelling",
    });
  });
  await expect(
    page.getByText("Finishing the current backup step."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Cancel requested" })
    .dispatchEvent("click");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([{ type: "maintenance-ready", instanceId: "overlay-1" }]);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).overlay.close(),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#maintenance-opener")).not.toBeFocused();
  expect(
    await page
      .locator("#maintenance-opener")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(false);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).overlay.update({
      kind: "maintenance",
      instanceId: "overlay-2",
      taskId: "note-a",
      title: "Checking the restored workspace.",
      detail: "Verifying saved material.",
      phase: "working",
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).overlay.actions.filter(
            (action) => action.type === "maintenance-ready",
          ).length,
      ),
    )
    .toBe(2);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).overlay.actions.at(-1),
    ),
  ).toEqual({ type: "maintenance-cancel", instanceId: "overlay-2" });
});

test("maintenance ignores composition Escape and emits no action for a removed shield", async ({
  page,
}) => {
  await maintenance(page);
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
        }),
      );
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
        }),
      );
    });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([{ type: "maintenance-ready", instanceId: "overlay-1" }]);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.overlay.update({
      kind: "maintenance",
      instanceId: "never-mounted",
      taskId: "note-a",
      title: "Working",
      detail: "Host cancelled before presentation.",
      phase: "working",
    });
    w.overlay.close();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([{ type: "maintenance-ready", instanceId: "overlay-1" }]);
});

// These cases qualify renderer presentation and continuity with an explicit
// bridge fixture. They do not qualify native generic-project execution.
async function genericProject(
  page: Page,
  preview: "none" | "static" | "loopback" = "none",
  verified = true,
) {
  await app(page);
  await page.evaluate(
    ({ preview, verified }) => {
      (window as unknown as FixtureWindow).fixture.addProject(
        "exhibition",
        "Campus exhibition",
        preview === "none"
          ? { kind: "none" }
          : preview === "static"
            ? { kind: "static", entry: "index.html" }
            : { kind: "loopback", url: "http://127.0.0.1:3000/" },
        verified,
      );
    },
    { preview, verified },
  );
  await chooseTask(page, "exhibition");
  await expect(
    page.getByRole("heading", { name: "Campus exhibition", exact: true }),
  ).toBeVisible();
}

test("generic project presentation uses its title and declared activities without Orbit affordances", async ({
  page,
}, info) => {
  await genericProject(page);
  await expect(
    page.getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Preview", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Notebook", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(page.getByText("YOUR STUDY TIMER", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", {
      name: /Shape the movement|Project files|Use this in Orbit/,
    }),
  ).toHaveCount(0);
  await expect(page.locator(".live-badge")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
      ),
    )
    .toMatchObject({ kind: "workbench", taskId: "exhibition" });
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.locator('[data-note-task="exhibition"]')).toBeFocused();
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("generic-project-notebook.png"),
  });
});

for (const preview of ["static", "loopback"] as const)
  test(`generic ${preview} preview is explicit and keeps its task binding`, async ({
    page,
  }) => {
    await genericProject(page, preview);
    await expect(
      page.getByRole("button", { name: "Preview", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
        ),
      )
      .toMatchObject({ kind: "preview", taskId: "exhibition" });
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
        ),
      )
      .toMatchObject({ kind: "workbench", taskId: "exhibition" });
    await expect(page.getByRole("slider")).toHaveCount(0);
  });

test("unverified and missing project records preserve usable notes and honest paused code", async ({
  page,
}) => {
  await genericProject(page, "none", false);
  const note = page.locator('[data-note-task="exhibition"]');
  await expect(note).toBeFocused();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.surfaceResult = {
      ready: false,
      message: "This project is paused. Review its folder before opening code.",
    };
  });
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByTestId("workbench-surface")).toContainText(
    "This project is paused.",
  );
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await note.fill("A useful thought while the project is paused.");
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.patchTask("exhibition", {
      project: null,
      parameters: state.snapshot.tasks.find((task) => task.id === "project")!
        .parameters,
    });
    state.publishAttention({ taskId: "exhibition", activity: "easing" });
  });
  await expect(note).toBeVisible();
  await expect(note).toHaveText(
    "A useful thought while the project is paused.",
  );
  await expect(
    page.getByRole("button", { name: "Preview", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("slider")).toHaveCount(0);
});

test("project notebook retains selection and working undo across code and other tasks", async ({
  page,
}) => {
  await genericProject(page);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  const note = page.locator('[data-note-task="exhibition"]');
  await note.fill("A thought with project history.");
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
  await note.evaluate((element) => {
    const text = element.querySelector("p")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 17, text, 5);
  });
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(note).toBeHidden();
  await expect(note).toHaveCount(1);
  await chooseTask(page, "note-b");
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await chooseTask(page, "exhibition");
  await expect(
    page.getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(note).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        anchor: document.getSelection()?.anchorOffset,
        head: document.getSelection()?.focusOffset,
      })),
    )
    .toEqual({ anchor: 17, head: 5 });
  await page
    .locator(".notes-layout:visible")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(note).toHaveText("Original idea");
});

test("project notebook cold restoration remembers selection and scroll while preserving code checkpoint", async ({
  page,
}) => {
  await genericProject(page);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishNote(
      Array.from(
        { length: 70 },
        (_, index) => `<p>Project line ${index}: keep this useful thought.</p>`,
      ).join(""),
      "exhibition",
    ),
  );
  const note = page.locator('[data-note-task="exhibition"]');
  await expect(note.locator("p")).toHaveCount(70);
  // Notebook activation focuses Tiptap on its next animation frame. Wait for
  // that initial focus before installing a DOM selection, or the pending
  // frame can restore the editor's post-setContent selection at the end.
  await expect(note).toBeFocused();
  await note.evaluate((element) => {
    const text = element.querySelector("p")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 15, text, 3);
  });
  await page.locator(".workspace").evaluate((element) => {
    element.scrollTop = 600;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
            (task) => task.id === "exhibition",
          )!.checkpoint?.noteView,
      ),
    )
    .toMatchObject({
      noteId: "exhibition-note",
      noteRevision: 1,
      selection: { anchor: 16, head: 4 },
      scrollTop: 600,
    });
  // Isolate cold checkpoint restoration from pointer scrolling. At scrollTop
  // 600, Code is above the viewport; Playwright's pointer click first scrolls
  // it into view, legitimately replacing the saved notebook position with 0.
  // Other project-navigation cases exercise the actual pointer gesture.
  await page
    .getByRole("button", { name: "Code", exact: true })
    .dispatchEvent("click");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
            (task) => task.id === "exhibition",
          )!.checkpoint?.selectedActivity,
      ),
    )
    .toBe("code");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "exhibition",
        )!.checkpoint?.noteView?.scrollTop,
    ),
  ).toBe(600);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.remount(),
  );
  await expect(
    page.getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(note).toHaveCount(0);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(note).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        anchor: document.getSelection()?.anchorOffset,
        head: document.getSelection()?.focusOffset,
      })),
    )
    .toEqual({ anchor: 15, head: 3 });
  await expect
    .poll(() =>
      page.locator(".workspace").evaluate((element) => element.scrollTop),
    )
    .toBe(600);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.savedWrites,
    ),
  ).toBe(0);
});

test("project notebook failed save preserves the draft and prevents unsafe close or activity departure", async ({
  page,
}) => {
  await genericProject(page);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = true;
  });
  const note = page.locator('[data-note-task="exhibition"]');
  await note.fill("Unsaved project thought.");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(
    page.getByText("Not saved · your text is still here", { exact: true }),
  ).toBeVisible();
  await expect(note).toHaveText("Unsaved project thought.");
  await expect(note).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.prepareClose(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.closeCancellations,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.closeReadies,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.failSaves = false;
  });
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(note).toBeHidden();
});

test("legacy Orbit compatibility is restricted to its identity and parameter adapter", async ({
  page,
}) => {
  await app(page, "project");
  await expect(
    page.getByRole("heading", { name: "Make room for focus.", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.patchTask("project", { project: undefined });
  });
  await expect(
    page.getByRole("heading", { name: "Orbit", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.addProject("orbit", "Orbit");
    state.patchTask("orbit", {
      project: undefined,
      parameters: state.snapshot.tasks.find((task) => task.id === "project")!
        .parameters,
    });
  });
  await chooseTask(page, "orbit");
  await expect(
    page.getByRole("heading", { name: "Make room for focus.", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Focus session duration" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.locator('[data-note-task="orbit"]')).toBeFocused();
});

async function projectSetup(page: Page) {
  await app(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Project setup", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Campus site", exact: true }),
  ).toBeVisible();
}

test("project setup defaults to generic without execution and keeps existing and newer notes", async ({
  page,
}, info) => {
  await app(page);
  await page
    .getByTestId("note-editor")
    .fill("An idea before choosing a folder.");
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Campus site", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /Code and notebook/ }),
  ).toBeChecked();
  await expect(page.getByRole("radio", { name: /Orbit controls/ })).toHaveCount(
    0,
  );
  await page.screenshot({ path: info.outputPath("project-folder-review.png") });
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectRegisterDelayMs = 180;
  });
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Attaching project…", exact: true }),
  ).toBeDisabled();
  await page
    .getByTestId("note-editor")
    .fill("A newer idea while attachment is being confirmed.");
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved on this computer", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectRegistrations,
    ),
  ).toEqual([
    {
      selectionId: "fixture-selection",
      adapter: "generic",
      preview: { kind: "none" },
    },
  ]);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectReviews,
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "note-a",
        )!.note.body,
    ),
  ).toBe("<p>A newer idea while attachment is being confirmed.</p>");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.surfaceCalls,
    ),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Keep for later", exact: true })
    .click();
  await expect(page.locator('[data-note-task="note-a"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
});

test("native folder cancellation and pre-submit cancellation clean up without replacing the note", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectChooserCancelled = true;
  });
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Project setup", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("note-editor")).toHaveText("Original idea");
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectChooserCancelled =
      false;
  });
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Campus site", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add project", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectDismissals,
    ),
  ).toEqual(["fixture-selection"]);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectRegistrations,
    ),
  ).toEqual([]);
});

test("project preview configuration is explicit, bounded, and Orbit controls require a selected supported adapter", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectSelection = {
      ...(window as unknown as FixtureWindow).fixture.projectSelection,
      availableAdapters: ["generic", "orbit"],
    };
  });
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("radio", { name: /Orbit controls/ }).check();
  await page.getByText("Add a preview", { exact: false }).click();
  await page
    .getByLabel("Preview source", { exact: true })
    .selectOption("static");
  await page
    .getByLabel("HTML file in this folder", { exact: true })
    .fill("../outside.html");
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Choose an HTML file inside this folder",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectRegistrations,
    ),
  ).toEqual([]);
  await page
    .getByLabel("Preview source", { exact: true })
    .selectOption("loopback");
  await page
    .getByLabel("Local server address", { exact: true })
    .fill("https://example.com/");
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("127.0.0.1");
  await page
    .getByLabel("Local server address", { exact: true })
    .fill("http://127.0.0.1:3100/site/");
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectRegistrations,
    ),
  ).toEqual([
    {
      selectionId: "fixture-selection",
      adapter: "orbit",
      preview: { kind: "loopback", url: "http://127.0.0.1:3100/site/" },
    },
  ]);
});

test("an interrupted registration keeps exact immutable choices and retries without a second attachment", async ({
  page,
}) => {
  await projectSetup(page);
  await page.getByText("Add a preview", { exact: false }).click();
  await page
    .getByLabel("Preview source", { exact: true })
    .selectOption("static");
  await page
    .getByLabel("HTML file in this folder", { exact: true })
    .fill("pages/start.html");
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectLostAckOnce = true;
  });
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry adding project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("HTML file in this folder", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("HTML file in this folder", { exact: true }),
  ).toHaveValue("pages/start.html");
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry adding project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    return {
      calls: state.projectRegistrations,
      project: state.snapshot.tasks.find((task) => task.id === "note-a")!
        .project,
      epoch: state.snapshot.tasks.find((task) => task.id === "note-a")!.epoch,
    };
  });
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]).toEqual(result.calls[1]);
  expect(result.project?.id).toBe("attached-project");
  expect(result.epoch).toBe(2);
});

test("uncertain cancellation obeys the host and cannot discard a still-unconfirmed registration", async ({
  page,
}) => {
  await projectSetup(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectRegisterRejectOnce =
      true;
  });
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check and cancel setup", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("awaits confirmation");
  await expect(
    page.getByRole("button", { name: "Retry adding project", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry adding project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
});

test("cancelling a lost completed receipt refreshes the attached project instead of claiming it was removed", async ({
  page,
}) => {
  await projectSetup(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectLostAckOnce = true;
  });
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check and cancel setup", exact: true })
    .click();
  await expect(
    page.getByText(
      "The project was already attached. Its files and your note are kept.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectRegistrations,
    ),
  ).toHaveLength(1);
});

test("execution opens only after explicit native approval and a late approval cannot move another task", async ({
  page,
}) => {
  await projectSetup(page);
  await page
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review and open code", exact: true })
    .click();
  await expect(
    page.getByText("Your project stays attached. Open it when you are ready.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.surfaceCalls,
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.projectReviewResult = { trusted: true };
    state.projectReviewDelayMs = 160;
  });
  await page
    .getByRole("button", { name: "Review and open code", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reviewing project…", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.switchTask("note-b"),
  );
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
            ?.busy,
      ),
    )
    .toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.surfaceCalls,
    ),
  ).toEqual([]);
  await chooseTask(page, "note-a");
  await page
    .getByRole("button", { name: "Review and open code", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
      ),
    )
    .toMatchObject({ kind: "workbench", taskId: "note-a" });
});

test("a folder chooser arriving after a task change stays with its original task", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.projectChooseDelayMs = 160;
  });
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.switchTask("note-b"),
  );
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
            ?.busy,
      ),
    )
    .toBe(false);
  await expect(
    page.getByRole("region", { name: "Project setup", exact: true }),
  ).toHaveCount(0);
  await chooseTask(page, "note-a");
  await expect(
    page.getByRole("heading", { name: "Campus site", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectRegistrations,
    ),
  ).toEqual([]);
});

test("closing project views honors native cancellation and preserves the attached notebook", async ({
  page,
}) => {
  await genericProject(page);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  const note = page.locator('[data-note-task="exhibition"]');
  await note.fill("Keep the idea while closing only its views.");
  await page
    .getByRole("button", { name: "Close code and preview", exact: true })
    .click();
  await expect(
    page.getByText("Your code and preview remain open.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.projectCloses,
    ),
  ).toEqual(["exhibition"]);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.projectCloseResult = { closed: true };
    state.projectCloseDelayMs = 120;
  });
  await page
    .getByRole("button", { name: "Close code and preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Closing code and preview…",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Code and preview are closed. The folder and your note stay attached.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(note).toHaveText("Keep the idea while closing only its views.");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "exhibition",
        )!.project?.id,
    ),
  ).toBe("record-exhibition");
});

test("generic preview reload is explicit, scoped and reports refusal without losing the notebook", async ({
  page,
}) => {
  await genericProject(page, "static");
  await expect(
    page.getByRole("button", { name: "Reload preview", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.previewReloads,
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.previewReloadDelayMs = 120;
    state.previewReloadResult = {
      reloaded: false,
      message: "Review the changed project before opening its preview.",
    };
  });
  await page
    .getByRole("button", { name: "Reload preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reloading preview…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Review the changed project before opening its preview.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.previewReloads,
    ),
  ).toEqual(["exhibition"]);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.locator('[data-note-task="exhibition"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload preview", exact: true }),
  ).toHaveCount(0);
});

test("late preview reload completion stays with its original project", async ({
  page,
}) => {
  await genericProject(page, "loopback");
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.previewReloadDelayMs = 160;
  });
  await page
    .getByRole("button", { name: "Reload preview", exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.switchTask("note-b"),
  );
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
            ?.busy,
      ),
    )
    .toBe(false);
  await expect(
    page.getByText("Preview reloaded from your project.", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.previewReloads,
    ),
  ).toEqual(["exhibition"]);
});

test("Orbit preview and its clear operation carry the owning task", async ({
  page,
}) => {
  await app(page, "project");
  const slider = page.getByRole("slider", {
    name: "Transition duration",
    exact: true,
  });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.previewDrafts.length,
      ),
    )
    .toBeGreaterThan(1);
  const drafts = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture.previewDrafts,
  );
  expect(drafts.every((item) => item.taskId === "project")).toBe(true);
  expect(drafts.some((item) => item.values?.transitionMs === 280)).toBe(true);
  expect(drafts.at(-1)?.values).toBeNull();
  await expect(
    page.getByRole("button", { name: "Reload preview", exact: true }),
  ).toHaveCount(0);
});

test("renaming a space flushes its note and restores the note selection without navigation", async ({
  page,
}, info) => {
  await app(page);
  const note = page.locator('[data-note-task="note-a"]');
  await note.fill("A title changes; the thought stays.");
  await note.evaluate((element) => {
    const text = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode()!;
    document.getSelection()!.setBaseAndExtent(text, 12, text, 3);
  });
  await page.getByRole("button", { name: "Rename space", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Space title", exact: true });
  await expect(input).toBeFocused();
  await input.fill("A clearer thought");
  await page.screenshot({ path: info.outputPath("space-title-editor.png") });
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer thought", exact: true }),
  ).toBeVisible();
  await expect(note).toHaveText("A title changes; the thought stays.");
  await expect(note).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        anchor: document.getSelection()?.anchorOffset,
        head: document.getSelection()?.focusOffset,
      })),
    )
    .toEqual({ anchor: 12, head: 3 });
  const state = await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    return {
      requests: state.renameCommands,
      note: state.snapshot.tasks.find((task) => task.id === "note-a")!.note,
      active: state.snapshot.activeTaskId,
    };
  });
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({
    taskId: "note-a",
    title: "A clearer thought",
    expectedRevision: 1,
  });
  expect(state.note.body).toContain("the thought stays");
  expect(state.active).toBe("note-a");
  await page.screenshot({ path: info.outputPath("renamed-space.png") });
});

test("title Escape cancels, composition does not submit or dismiss, and blank names stay disabled", async ({
  page,
}) => {
  await app(page);
  await page.getByRole("button", { name: "Rename space", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Space title", exact: true });
  await input.fill("A composition");
  await input.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        isComposing: true,
        cancelable: true,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
        cancelable: true,
      }),
    );
  });
  await expect(input).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.renameCommands,
    ),
  ).toEqual([]);
  await input.fill("   ");
  await expect(
    page.getByRole("button", { name: "Save title", exact: true }),
  ).toBeDisabled();
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.renameCommands,
    ),
  ).toEqual([]);
});

test("a changed title needs explicit current-title review before a new rename", async ({
  page,
}) => {
  await app(page);
  await page.getByRole("button", { name: "Rename space", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Space title", exact: true })
    .fill("My proposed title");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.patchTask("note-a", {
      title: "An independently changed title",
      revision: 1,
    }),
  );
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(
    page.getByText("Current title:", { exact: false }),
  ).toContainText("An independently changed title");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.renameCommands,
    ),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Review current title", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Space title", exact: true }),
  ).toHaveValue("An independently changed title");
  await page
    .getByRole("textbox", { name: "Space title", exact: true })
    .fill("The reviewed title");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The reviewed title", exact: true }),
  ).toBeVisible();
});

test("a lost rename acknowledgement freezes the exact retry and applies the title once", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.renameLostAckOnce = true;
  });
  await page.getByRole("button", { name: "Rename space", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Space title", exact: true })
    .fill("Already kept");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry title change", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Space title", exact: true }),
  ).toHaveAttribute("readonly", "");
  await page
    .getByRole("button", { name: "Leave title change for later", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Space title", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review title change", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry title change", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Space title", exact: true }),
  ).toHaveCount(0);
  const state = await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    return {
      requests: state.renameCommands,
      task: state.snapshot.tasks.find((task) => task.id === "note-a"),
    };
  });
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1]).toEqual(state.requests[0]);
  expect(state.task).toMatchObject({ title: "Already kept", revision: 1 });
});

test("a late rename acknowledgement cannot return to its old task or steal note focus", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.renameAckDelayMs = 180;
  });
  await page.getByRole("button", { name: "Rename space", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Space title", exact: true })
    .fill("First space renamed");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saving title", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.switchTask("note-b"),
  );
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
            ?.busy,
      ),
    )
    .toBe(false);
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Space title", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.snapshot.activeTaskId,
    ),
  ).toBe("note-b");
});

test("title rename keeps generic Code activity and tolerates unrelated checkpoint acknowledgements", async ({
  page,
}) => {
  await genericProject(page);
  await page.getByRole("button", { name: "Rename space", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Space title", exact: true })
    .fill("Exhibition website");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    const task = state.snapshot.tasks.find((item) => item.id === "exhibition")!;
    state.patchTask(task.id, {
      checkpoint: {
        selectedActivity: "code",
        layout: "work",
        returnAnchors: [],
        revision: 10,
        updatedAt: 100,
      },
    });
  });
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Exhibition website", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    (
      await page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.renameCommands,
      )
    )[0],
  ).toMatchObject({ taskId: "exhibition", title: "Exhibition website" });
});

test("editor focus is requested only by deliberate Code navigation and spent on its first surface request", async ({
  page,
}) => {
  await app(page, "project");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.editorNavigations,
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
      ),
    )
    .toMatchObject({
      kind: "workbench",
      taskId: "project",
      focusLeaseId: "focus-1",
    });
  await page.setViewportSize({ width: 1320, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.surfaceCalls.filter(
            (request) => request.kind === "workbench",
          ).length,
      ),
    )
    .toBeGreaterThan(1);
  const state = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture,
  );
  expect(state.editorNavigations).toHaveLength(1);
  expect(
    state.surfaceCalls.filter((request) => request.focusLeaseId === "focus-1"),
  ).toHaveLength(1);
});

test("Code captures its focus lease before a note flush and failed saving does not open the editor", async ({
  page,
}) => {
  await genericProject(page);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page
    .locator('[data-note-task="exhibition"]')
    .fill("Keep this note before code opens.");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.saveDelayMs = 120;
    state.failSaves = true;
    state.surfaceCalls = [];
    state.editorNavigations = [];
  });
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.editorNavigations.length,
      ),
    )
    .toBe(1);
  await expect(
    page.getByText("Not saved", { exact: false }).first(),
  ).toBeVisible();
  const state = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture,
  );
  expect(state.editorNavigations[0]).toMatchObject({
    taskId: "exhibition",
    saves: 0,
  });
  expect(state.surfaceCalls).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Notebook", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("host attention forwards an existing focus lease and never invents one", async ({
  page,
}) => {
  await app(page, "project");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishAttention({
      taskId: "project",
      activity: "code",
      focusLeaseId: "host-gesture",
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
      ),
    )
    .toMatchObject({ kind: "workbench", focusLeaseId: "host-gesture" });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.editorNavigations,
    ),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishAttention({
      taskId: "project",
      activity: "preview",
    }),
  );
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.publishAttention({
      taskId: "project",
      activity: "code",
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
      ),
    )
    .toMatchObject({ kind: "workbench" });
  expect(
    (
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.surfaceCalls.at(-1),
      )
    )?.focusLeaseId,
  ).toBeUndefined();
});

test("workspace changed passages are complete literal code with exact ranges and existing apply actions", async ({
  page,
}) => {
  await overlay(page, "intent");
  const probes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("invalid.example")) probes.push(request.url());
  });
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    const response = w.RendererFixture.responseFixture();
    response.proposals = [
      {
        id: "workspace-1",
        kind: "workspace",
        label: "Clarify the welcome",
        summary: "Update the title and its style.",
        status: "ready",
        expiresAt: Date.now() + 60_000,
        files: [
          {
            path: "src/index.html",
            changes: [
              {
                startLine: 4,
                startColumn: 2,
                endLine: 4,
                endColumn: 19,
                before: "<h1>Hello</h1>",
                after:
                  '<h1>Make room.</h1>\n<img src="https://invalid.example/probe" onerror="window.codeRan=true">\n<script>window.codeRan=true</script>',
              },
              {
                startLine: 9,
                startColumn: 1,
                endLine: 9,
                endColumn: 1,
                before: "",
                after: "<!-- [literal](https://invalid.example/link) -->",
              },
            ],
          },
          {
            path: "src/theme.css",
            changes: [
              {
                startLine: 12,
                startColumn: 3,
                endLine: 14,
                endColumn: 2,
                before: ".old { color: red; }",
                after: "",
              },
            ],
          },
        ],
      },
    ];
    w.overlay.update({ ...w.overlay.state, response });
  });
  await expect(
    page.getByRole("button", { name: "Apply change" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Preview change" }).click();
  const passages = page.getByRole("region", {
    name: "Changed passages",
    exact: true,
  });
  await expect(passages).toContainText("2 files · 3 passages");
  await expect(passages).toContainText("Original range · L4:C2 – L4:C19");
  await expect(passages).toContainText("Original range · L9:C1 – L9:C1");
  await expect(
    page
      .getByRole("region", {
        name: "After passage 1 in src/index.html",
        exact: true,
      })
      .locator("code"),
  ).toHaveText(
    '<h1>Make room.</h1>\n<img src="https://invalid.example/probe" onerror="window.codeRan=true">\n<script>window.codeRan=true</script>',
  );
  await expect(passages).toContainText("Empty · insertion point");
  expect(await passages.locator("img, script, a, h1").count()).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { codeRan?: boolean }).codeRan,
    ),
  ).toBeUndefined();
  expect(probes).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("workspace-changed-passages.png"),
  });
  const second = page.getByRole("button", {
    name: "src/theme.css 1 passage",
    exact: true,
  });
  await second.focus();
  await second.press("Enter");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await expect(second).toBeFocused();
  await expect(passages).toContainText("Original range · L12:C3 – L14:C2");
  await expect(passages).toContainText("Empty · passage removed");
  await expect(
    page
      .getByRole("region", {
        name: "Before passage 1 in src/theme.css",
        exact: true,
      })
      .locator("code"),
  ).toHaveText(".old { color: red; }");
  await page.getByRole("button", { name: "Apply change" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    {
      type: "proposal-apply",
      instanceId: "overlay-1",
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "workspace-1",
    },
  ]);
});

test("workspace review reaches all eight bounded passages without truncating long literal fragments", async ({
  page,
}) => {
  await overlay(page, "intent");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    const response = w.RendererFixture.responseFixture();
    response.proposals = [
      {
        id: "workspace-1",
        kind: "workspace",
        label: "Eight exact changes",
        summary: "Review every passage.",
        status: "ready",
        expiresAt: Date.now() + 60_000,
        files: Array.from({ length: 8 }, (_, index) => ({
          path: `src/file-${index + 1}.txt`,
          changes: [
            {
              startLine: index + 1,
              startColumn: 1,
              endLine: index + 1,
              endColumn: 8001,
              before: "A".repeat(7995) + "END!!",
              after: "B".repeat(7995) + "END!!",
            },
          ],
        })),
      },
    ];
    w.overlay.update({ ...w.overlay.state, response });
  });
  await page.getByRole("button", { name: "Preview change" }).click();
  for (let index = 1; index <= 8; index += 1) {
    await page
      .getByRole("button", {
        name: `src/file-${index}.txt 1 passage`,
        exact: true,
      })
      .click();
    const after = page.getByRole("region", {
      name: `After passage 1 in src/file-${index}.txt`,
      exact: true,
    });
    expect(await after.locator("code").textContent()).toBe(
      "B".repeat(7995) + "END!!",
    );
    await after.locator("pre").focus();
    await after.locator("pre").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    expect(
      await after.locator("pre").evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(0);
  }
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    {
      type: "proposal-discard",
      instanceId: "overlay-1",
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "workspace-1",
    },
  ]);
});

test("workspace preview refuses out-of-bound or incomplete payloads instead of hiding changes", async ({
  page,
}) => {
  await overlay(page, "intent");
  for (const invalid of [
    "missing",
    "files",
    "passages",
    "text",
    "position",
  ] as const) {
    await page.evaluate((invalid) => {
      const w = window as unknown as FixtureWindow;
      if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
      const response = w.RendererFixture.responseFixture();
      const change = {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 2,
        before: "a",
        after: "b",
      };
      let files = [{ path: "file.txt", changes: [change] }];
      if (invalid === "files")
        files = Array.from({ length: 9 }, (_, index) => ({
          path: `file-${index}.txt`,
          changes: [change],
        }));
      if (invalid === "passages")
        files[0].changes = Array.from({ length: 9 }, () => change);
      if (invalid === "text") change.after = "x".repeat(8001);
      if (invalid === "position") change.endColumn = 0;
      response.proposals = [
        {
          id: `workspace-${invalid}`,
          kind: "workspace",
          label: "Incomplete preview",
          summary: "Review this change.",
          status: "ready",
          expiresAt: Date.now() + 60_000,
          files: invalid === "missing" ? undefined : files,
        },
      ];
      w.overlay.update({ ...w.overlay.state, response });
    }, invalid);
    await expect(
      page.getByText(
        "This change cannot be previewed completely. Ask again for a smaller change.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Preview change" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Apply change" }),
    ).toBeDisabled();
  }
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([]);
});

test("workspace uncertain and terminal states remain reviewable but cannot replay an application", async ({
  page,
}) => {
  await overlay(page, "intent");
  for (const status of [
    "uncertain",
    "applying",
    "applied",
    "stale",
    "expired",
    "error",
  ] as const) {
    await page.evaluate((status) => {
      const w = window as unknown as FixtureWindow;
      if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
      const response = w.RendererFixture.responseFixture();
      response.proposals = [
        {
          id: `workspace-${status}`,
          kind: "workspace",
          label: "Update title",
          summary: "One passage.",
          status,
          expiresAt: Date.now() + 60_000,
          files: [
            {
              path: "index.html",
              changes: [
                {
                  startLine: 1,
                  startColumn: 1,
                  endLine: 1,
                  endColumn: 4,
                  before: "Old",
                  after: "New",
                },
              ],
            },
          ],
        },
      ];
      w.overlay.update({ ...w.overlay.state, response });
    }, status);
    await expect(
      page.getByRole("button", { name: "Apply change" }),
    ).toHaveCount(0);
    if (status === "uncertain")
      await expect(
        page.getByText("Change needs review", { exact: true }),
      ).toBeVisible();
    await page.getByRole("button", { name: "Preview change" }).click();
    await expect(
      page.getByRole("region", {
        name: "After passage 1 in index.html",
        exact: true,
      }),
    ).toContainText("New");
  }
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([]);
});

test("workspace passage review stays within a narrow question panel and Escape uses the existing overlay lifecycle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await overlay(page, "intent");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    const response = w.RendererFixture.responseFixture();
    response.proposals = [
      {
        id: "workspace-1",
        kind: "workspace",
        label: "A clearer introduction",
        summary: "Keep the idea, change the wording.",
        status: "ready",
        expiresAt: Date.now() + 60_000,
        files: [
          {
            path: "src/components/a-long-but-real-component-name.tsx",
            changes: [
              {
                startLine: 41,
                startColumn: 7,
                endLine: 42,
                endColumn: 3,
                before: "const title = 'Hello';",
                after:
                  "const title = 'Make room for focus.';\nreturn <h1>{title}</h1>;",
              },
            ],
          },
        ],
      },
    ];
    w.overlay.update({ ...w.overlay.state, response });
  });
  await page.getByRole("button", { name: "Preview change" }).click();
  const before = await page
    .getByRole("region", { name: /^Before passage/ })
    .boundingBox();
  const after = await page
    .getByRole("region", { name: /^After passage/ })
    .boundingBox();
  expect(before && after && after.y >= before.y + before.height).toBeTruthy();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath("workspace-passages-narrow.png"),
  });
  await page
    .getByRole("region", { name: /^After passage/ })
    .locator("pre")
    .focus();
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([{ type: "close", instanceId: "overlay-1" }]);
});

test("uncertain workspace status is checked without preview or Apply, even after cancellation", async ({
  page,
}) => {
  await overlay(page, "intent");
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    if (w.overlay.state.kind !== "intent") throw new Error("Expected intent");
    const response = w.RendererFixture.responseFixture();
    response.status = "cancelled";
    response.proposals[0] = {
      ...response.proposals[0],
      kind: "workspace",
      status: "uncertain",
      before: undefined,
      after: undefined,
    };
    w.overlay.update({ ...w.overlay.state, response });
  });
  await expect(page.getByRole("button", { name: "Apply change" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Preview change" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).overlay.actions,
    ),
  ).toEqual([
    {
      type: "proposal-apply",
      instanceId: "overlay-1",
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "proposal-1",
    },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.overlay.update({ ...w.overlay.state, busy: true });
  });
  await expect(
    page.getByRole("button", { name: "Checking status…" }),
  ).toBeDisabled();
});

test("receipt status checks deduplicate before queuing, bypass dirty note saving, and keep late results with their task", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.earlyResponse = true;
  });
  await ask(page);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    const response = w.RendererFixture.responseFixture();
    response.status = "stale";
    response.proposals[0] = {
      ...response.proposals[0],
      kind: "workspace",
      status: "uncertain",
    };
    w.fixture.publishIntelligence({ type: "intent", response });
    w.fixture.proposalResult = {
      ...response,
      proposals: [{ ...response.proposals[0], status: "applied" }],
    };
    w.fixture.proposalDelayMs = 180;
    w.fixture.failSaves = true;
  });
  await page
    .locator('[data-note-task="note-a"]')
    .fill("An unsaved draft stays here.");
  await expect(
    page.getByRole("button", { name: "Retry save", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    const action = {
      type: "proposal-apply" as const,
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "proposal-1",
    };
    state.sendAction(action);
    state.sendAction(action);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.proposalCalls.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.switchTask("note-b"),
  );
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.rendererStates.at(-1)
            ?.busy,
      ),
    )
    .toBe(false);
  await expect(page.locator('[data-note-task="note-b"]')).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.snapshot.activeTaskId,
    ),
  ).toBe("note-b");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.switchTask("note-a"),
  );
  await expect(page.locator('[data-note-task="note-a"]')).toHaveText(
    "An unsaved draft stays here.",
  );
  await page
    .getByRole("button", { name: "Dismiss error", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View response", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent"
          ? state.response?.proposals[0].status
          : undefined;
      }),
    )
    .toBe("applied");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.proposalCalls.length,
    ),
  ).toBe(1);
});

test("cancelling an approved workspace change retains its settlement and a failed check cannot erase the review", async ({
  page,
}) => {
  await app(page);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).fixture.earlyResponse = true;
  });
  await ask(page);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    const response = w.RendererFixture.responseFixture();
    response.proposals[0] = {
      ...response.proposals[0],
      kind: "workspace",
      status: "ready",
    };
    w.fixture.publishIntelligence({ type: "intent", response });
    w.fixture.proposalResult = {
      ...response,
      proposals: [{ ...response.proposals[0], status: "uncertain" }],
    };
    // Cancellation must happen during Apply, even when other browser workers
    // delay this test. Release the controlled response explicitly below.
    w.fixture.holdProposal = true;
    w.fixture.sendAction({
      type: "proposal-apply",
      instanceId: w.fixture.overlay!.instanceId,
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "proposal-1",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent"
          ? state.response?.proposals[0].status
          : undefined;
      }),
    )
    .toBe("applying");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({
      type: "intent-cancel",
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      requestId: "request-1",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.response?.status : undefined;
      }),
    )
    .toBe("cancelled");
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.holdProposal = false;
    state.releaseProposal();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent"
          ? [state.response?.status, state.response?.proposals[0]?.status]
          : [];
      }),
    )
    .toEqual(["cancelled", "uncertain"]);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({
      type: "intent-submit",
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      text: "Replace this question",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent" ? state.message : undefined;
      }),
    )
    .toBe(
      "Check the status of this approved change before replacing its review.",
    );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.asks.length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.proposalFailure = true;
    state.sendAction({
      type: "proposal-apply",
      instanceId: state.overlay!.instanceId,
      taskId: "note-a",
      requestId: "request-1",
      proposalId: "proposal-1",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as FixtureWindow).fixture.overlay;
        return state?.kind === "intent"
          ? state.response?.proposals[0]?.message
          : undefined;
      }),
    )
    .toBe("Status could not be confirmed.");
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as FixtureWindow).fixture.overlay;
      return state?.kind === "intent"
        ? state.response?.proposals[0]?.status
        : undefined;
    }),
  ).toBe("uncertain");
});
