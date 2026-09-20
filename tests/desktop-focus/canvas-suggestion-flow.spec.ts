import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {
  CanvasDocument,
  CoreCommandInput,
} from "../../packages/contracts/src/index";
import type { EveBridge } from "../../apps/desktop/shared/bridge";

type Fixtures = typeof import("./renderer-fixture");
type CanvasWrite = Extract<CoreCommandInput, { type: "UpdateCanvas" }>;
type FixtureWindow = {
  RendererFixture: Fixtures;
  fixture: ReturnType<Fixtures["mountAppFixture"]>;
  flow: {
    writes: CanvasWrite[];
    asks: Array<
      Parameters<EveBridge["ask"]>[0] & {
        capturedCanvas: CanvasDocument | null;
        capturedRevision: number;
      }
    >;
    order: string[];
    holdWrite: boolean;
    failWrite: boolean;
    unavailable: boolean;
    releaseWrite(): void;
  };
};
let script: string;
let styles: string;
const followup =
  "Add a packing checklist for the coastal walk. Keep my existing route unchanged.";
const initialCanvas: CanvasDocument = {
  version: 1,
  title: "Coast weekend",
  subtitle: "A little room for the weekend.",
  layout: "focus",
  blocks: [
    {
      id: "route",
      kind: "text",
      title: "Walking route",
      body: "Start beside the lighthouse.",
      placement: "main",
      pinned: false,
      sourceIds: [],
    },
  ],
  suggestions: [
    {
      id: "packing",
      label: "Make a packing list",
      description: "Bring the essentials for your coastal walk.",
      request: followup,
      targetBlockId: "route",
    },
  ],
};

test.beforeAll(async () => {
  const output = await build({
    entryPoints: ["tests/desktop-focus/renderer-fixture.tsx"],
    bundle: true,
    write: false,
    outfile: "canvas-suggestion-flow.js",
    format: "iife",
    globalName: "RendererFixture",
    jsx: "automatic",
    loader: { ".woff2": "dataurl", ".woff": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  styles =
    (await readFile("apps/desktop/renderer/src/styles.css", "utf8")) +
    "\n" +
    output.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
});

async function mount(
  page: Page,
  options: {
    holdWrite?: boolean;
    failWrite?: boolean;
    unavailable?: boolean;
    canvas?: CanvasDocument;
  } = {},
) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ document: canvas, options }) => {
      const w = window as unknown as FixtureWindow;
      const fixture = (w.fixture = w.RendererFixture.mountAppFixture(
        document.getElementById("root")!,
        "note",
      ));
      fixture.patchTask("note-a", {
        canvas: { document: canvas, revision: 3, updatedAt: 1 },
        checkpoint: {
          layout: "work",
          selectedActivity: "canvas",
          returnAnchors: [],
          revision: 0,
          updatedAt: 1,
        },
      });
      let release: (() => void) | undefined;
      const flow = (w.flow = {
        writes: [],
        asks: [],
        order: [],
        holdWrite: options.holdWrite ?? false,
        failWrite: options.failWrite ?? false,
        unavailable: options.unavailable ?? false,
        releaseWrite: () => {
          flow.holdWrite = false;
          release?.();
          release = undefined;
        },
      } as FixtureWindow["flow"]);
      const dispatch = window.eve.dispatch;
      window.eve.dispatch = async (command) => {
        if (command.type !== "UpdateCanvas") return dispatch(command);
        flow.writes.push(structuredClone(command));
        flow.order.push("save-start");
        if (flow.holdWrite)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (flow.failWrite)
          return {
            ok: false,
            snapshot: structuredClone(fixture.snapshot),
            error: {
              code: "STORAGE_ERROR",
              message: "Disk unavailable. Your canvas is still here.",
            },
          };
        fixture.patchTask(command.taskId, {
          canvas: {
            document: command.document,
            revision: command.expectedRevision + 1,
            updatedAt: 2,
          },
        });
        const result = await dispatch(command);
        flow.order.push("save-complete");
        return result;
      };
      const ask = window.eve.ask;
      window.eve.ask = async (input) => {
        const task = fixture.snapshot.tasks.find(
          (item) => item.id === input.taskId,
        )!;
        flow.asks.push({
          ...input,
          capturedCanvas: structuredClone(task.canvas?.document ?? null),
          capturedRevision: task.canvas?.revision ?? 0,
        });
        flow.order.push("ask");
        const receipt = await ask(input);
        if (flow.unavailable)
          fixture.publishIntelligence({
            type: "intent",
            response: {
              requestId: receipt.requestId,
              taskId: input.taskId,
              status: "unavailable",
              message:
                "No qualified provider is configured for this request and processing policy. Direct controls still work.",
              citations: [],
              proposals: [],
            },
          });
        return receipt;
      };
    },
    { document: options.canvas ?? initialCanvas, options },
  );
  await expect(
    page
      .getByTestId("canvas")
      .getByRole("heading", { name: "Coast weekend", exact: true }),
  ).toBeVisible();
}

test("a model suggestion flushes edits before sending its exact canvas request and blocks duplicate submission", async ({
  page,
}) => {
  await mount(page, { holdWrite: true });
  const text = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  const card = page.getByRole("button", {
    name: "Make a packing list",
    exact: true,
  });
  await text.fill("Start beside the lighthouse. Meet at the northern gate.");
  // Two activations in one event turn also exercise the synchronous request guard.
  await card.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.writes.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.asks),
  ).toEqual([]);
  await expect(card).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).flow.releaseWrite(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.order),
  ).toEqual(["save-start", "save-complete", "ask"]);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks[0],
    ),
  ).toMatchObject({
    taskId: "note-a",
    text: followup,
    mode: "canvas",
    suggestion: { id: "packing", canvasRevision: 4 },
    capturedRevision: 4,
    capturedCanvas: {
      blocks: [
        { body: "Start beside the lighthouse. Meet at the northern gate." },
      ],
      suggestions: initialCanvas.suggestions,
    },
  });
  await expect(card).toBeDisabled();
  await text.focus();
  await text.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(6, 12, "backward"),
  );
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).fixture;
    fixture.publishIntelligence({
      type: "intent",
      response: {
        requestId: fixture.asks[0]!.requestId,
        taskId: "note-a",
        status: "complete",
        message: "Your next step is ready.",
        citations: [],
        proposals: [],
      },
    });
  });
  await expect(card).toBeEnabled();
  await expect(text).toBeFocused();
  expect(
    await text.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return [
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection,
      ];
    }),
  ).toEqual([6, 12, "backward"]);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.overlay,
    ),
  ).toBeNull();
});

test("an unavailable provider is reported honestly after a suggestion without inventing content or applying work", async ({
  page,
}) => {
  await mount(page, { unavailable: true });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.settings.providers,
    ),
  ).toEqual([]);
  const card = page.getByRole("button", {
    name: "Make a packing list",
    exact: true,
  });
  await card.click();
  await expect(page.locator(".canvas-request-status")).toContainText(
    "No qualified provider is configured",
  );
  await expect(page.locator(".canvas-request-status")).toContainText(
    "Direct controls still work.",
  );
  await expect(card).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.asks),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.writes),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (item) => item.id === "note-a",
        )!.canvas?.document,
    ),
  ).toEqual(initialCanvas);
  await expect(
    page.locator('.canvas-block[data-kind="checklist"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Describe your canvas", exact: true }),
  ).not.toBeFocused();
});

test("keyboard activation retains focus on the suggestion while its request is pending", async ({
  page,
}) => {
  await mount(page);
  const card = page.getByRole("button", {
    name: "Make a packing list",
    exact: true,
  });
  await card.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  await expect(card).toBeDisabled();
  await expect(card).toBeFocused();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks.length,
    ),
  ).toBe(1);
});

test("a failed canvas save prevents a suggestion request and keeps the local draft available", async ({
  page,
}) => {
  await mount(page, { failWrite: true });
  const text = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await text.fill("Keep my unsaved northern route.");
  await page
    .getByRole("button", { name: "Make a packing list", exact: true })
    .click();
  await expect(page.locator(".canvas-save-recovery")).toContainText(
    "Disk unavailable. Your canvas is still here.",
  );
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.asks),
  ).toEqual([]);
  await expect(
    page
      .locator('.canvas-primary > [data-testid="canvas"]')
      .getByRole("textbox", { name: "Walking route text", exact: true }),
  ).toHaveValue("Keep my unsaved northern route.");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (item) => item.id === "note-a",
        )!.canvas?.document,
    ),
  ).toEqual(initialCanvas);
});

const preparedCanvas = (): CanvasDocument => {
  const canvas = structuredClone(initialCanvas);
  canvas.suggestions![0]!.prepared = {
    edits: [
      {
        type: "add",
        block: {
          id: "packing-list",
          kind: "checklist",
          title: "Things to bring",
          placement: "aside",
          pinned: false,
          sourceIds: [],
          items: [{ id: "water", label: "Water bottle", checked: false }],
        },
      },
    ],
    before: [],
  };
  return canvas;
};
async function publishPrepared(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).fixture;
    const task = fixture.snapshot.tasks.find((item) => item.id === "note-a")!;
    const canvas = structuredClone(task.canvas!.document!);
    const suggestion = canvas.suggestions![0]!;
    const edit = suggestion.prepared!.edits[0]!;
    if (!("block" in edit))
      throw new Error("The fixture must add or replace a block.");
    const next = {
      ...canvas,
      blocks:
        edit.type === "add"
          ? [...canvas.blocks, edit.block]
          : canvas.blocks.map((block) =>
              block.id === edit.block.id ? edit.block : block,
            ),
      suggestions: [],
    };
    fixture.publishIntelligence({
      type: "intent",
      response: {
        requestId: fixture.asks.at(-1)!.requestId,
        taskId: "note-a",
        status: "complete",
        message: "Preview ready. Keep it when it feels right.",
        citations: [],
        proposals: [
          {
            id: "prepared-preview",
            kind: "canvas",
            label: suggestion.label,
            summary: suggestion.description,
            canvas: next,
            beforeCanvas: canvas,
            preparedSuggestionId: suggestion.id,
            status: "ready",
            expiresAt: Date.now() + 300000,
          },
        ],
      },
    });
  });
}

test("prepared preview arrives beside the chosen card without replacing the editor, moving selection or losing native Undo", async ({
  page,
}) => {
  await mount(page, { canvas: preparedCanvas() });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.focus();
  await writer.press("End");
  await page.keyboard.type(" Keep my own route.");
  const edited = await writer.inputValue();
  await writer.evaluate((element) => {
    (window as unknown as { originalEditor: Element }).originalEditor = element;
  });
  const card = page.getByRole("button", {
    name: "Make a packing list",
    exact: true,
  });
  await expect(card).toContainText("Preview");
  await card.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.asks.length,
      ),
    )
    .toBe(1);
  await writer.focus();
  await writer.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(6, 12, "backward"),
  );
  await publishPrepared(page);
  const review = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Water bottle");
  await expect(writer).toBeFocused();
  expect(
    await writer.evaluate((element) => ({
      same:
        element ===
        (window as unknown as { originalEditor: Element }).originalEditor,
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      direction: (element as HTMLTextAreaElement).selectionDirection,
    })),
  ).toEqual({ same: true, start: 6, end: 12, direction: "backward" });
  expect(
    await review.evaluate((element) =>
      element
        .closest("[data-canvas-block-id]")
        ?.getAttribute("data-canvas-block-id"),
    ),
  ).toBe("route");
  await expect(
    page.locator('[data-canvas-block-id="packing-list"]'),
  ).toHaveCount(0);
  await writer.press("ControlOrMeta+z");
  await expect(writer).not.toHaveValue(edited);
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue(edited);
});

test("App keeps prepared arrival passive and explicitly reveals the same review without another request or accidental Keep", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const canvas = preparedCanvas();
  const route = canvas.blocks[0]!;
  if (route.kind !== "text")
    throw new Error("The fixture must retain its live writer.");
  route.body = "Take time to notice the coast.\n".repeat(40);
  const initialBody = route.body;
  const meeting = {
    ...route,
    id: "meeting",
    title: "Meeting time",
    body: "Meet at 11 AM beside the lighthouse.",
  };
  canvas.blocks.push(meeting);
  canvas.suggestions = [
    {
      id: "meeting-time",
      label: "Move the meeting earlier",
      description: "Review the proposed meeting time.",
      request: "Move the meeting to 10 AM.",
      targetBlockId: meeting.id,
      prepared: {
        before: [meeting],
        edits: [
          {
            type: "replace",
            block: { ...meeting, body: "Meet at 10 AM beside the lighthouse." },
          },
        ],
      },
    },
  ];
  await mount(page, { canvas });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  const original = await writer.elementHandle();
  await writer.focus();
  await writer.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText("A thought I added myself.");
  const edited = await writer.inputValue();
  const card = page.getByRole("button", {
    name: "Move the meeting earlier",
    exact: true,
  });
  await card.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  await writer.evaluate((node: HTMLTextAreaElement) => {
    node.focus({ preventScroll: true });
    node.setSelectionRange(6, 12, "backward");
  });
  const workspace = page.locator(".workspace.canvas-workspace");
  await workspace.evaluate((node) => {
    node.scrollTop = 100;
  });
  const scrollBefore = await workspace.evaluate((node) => node.scrollTop);
  await publishPrepared(page);
  const preview = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-review-mode", "compact");
  await expect(card).toContainText("View change");
  await expect(writer).toBeFocused();
  expect(await workspace.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
  expect(
    await writer.evaluate(
      (node: HTMLTextAreaElement, original) => ({
        same: node === original,
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      }),
      original,
    ),
  ).toEqual({ same: true, start: 6, end: 12, direction: "backward" });
  expect((await preview.boundingBox())!.y).toBeGreaterThan(900);
  await card.click();
  await expect(preview).toBeFocused();
  const viewport = (await workspace.boundingBox())!;
  const keep = await preview
    .getByRole("button", { name: "Keep", exact: true })
    .boundingBox();
  expect(keep!.y + keep!.height).toBeLessThanOrEqual(
    viewport.y + viewport.height,
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => ({
      asks: (window as unknown as FixtureWindow).flow.asks.length,
      proposalCalls: (window as unknown as FixtureWindow).fixture.proposalCalls,
    })),
  ).toEqual({ asks: 1, proposalCalls: [] });
  await preview.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(card).toContainText("Preview");
  await expect(card).not.toContainText("View change");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks.length,
    ),
  ).toBe(1);
  expect(
    await writer.evaluate((node, original) => node === original, original),
  ).toBe(true);
  await expect(writer).toHaveValue(edited);
  await writer.focus();
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue(initialBody);
});

test("changing prepared data while a draft flushes refuses the obsolete clicked suggestion", async ({
  page,
}) => {
  await mount(page, { canvas: preparedCanvas(), holdWrite: true });
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    const dispatch = window.eve.dispatch;
    window.eve.dispatch = async (command) => {
      const result = await dispatch(command);
      if (command.type !== "UpdateCanvas") return result;
      const saved = structuredClone(command.document);
      const edit = saved.suggestions![0]!.prepared!.edits[0]!;
      if ("block" in edit && edit.block.kind === "checklist")
        edit.block.items[0]!.label = "A different item";
      w.fixture.patchTask(command.taskId, {
        canvas: {
          document: saved,
          revision: command.expectedRevision + 2,
          updatedAt: 3,
        },
      });
      return { ...result, snapshot: structuredClone(w.fixture.snapshot) };
    };
  });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.fill("My route changed.");
  await page
    .getByRole("button", { name: "Make a packing list", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.writes.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.flow.releaseWrite();
  });
  await expect(page.locator(".canvas-request-status")).toContainText(
    "This suggestion changed while saving",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks.length,
    ),
  ).toBe(0);
  await expect(writer).toHaveValue("My route changed.");
});

const freshChoice = {
  id: "fresh-observations",
  label: "Collect the next observations",
  description: "Prepare an empty observation table beside the route.",
  request: "Prepare an empty observation table while preserving the route.",
  targetBlockId: null,
};
const nextSteps = (page: Page) =>
  page.getByRole("region", { name: "Next steps", exact: true });

const itemNextSteps = (page: Page) =>
  page.getByRole("button", {
    name: "Suggest next steps for Walking route",
    exact: true,
  });
const contextStatus = (page: Page) =>
  page.getByRole("region", {
    name: "Next steps for Walking route",
    exact: true,
  });

test("an item request flushes the exact visible item and binds its current revision once", async ({
  page,
}) => {
  await mount(page, { holdWrite: true });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.fill("Meet at the northern gate; leave the time open.");
  await itemNextSteps(page).evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.writes.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.asks),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).flow.releaseWrite(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  const request = await page.evaluate(
    () => (window as unknown as FixtureWindow).flow.asks[0]!,
  );
  expect(request).toMatchObject({
    mode: "suggestions",
    refresh: { canvasRevision: 4, scope: { blockId: "route" } },
    capturedRevision: 4,
  });
  expect(request.capturedCanvas!.blocks[0]).toMatchObject({
    body: "Meet at the northern gate; leave the time open.",
  });
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.order),
  ).toEqual(["save-start", "save-complete", "ask"]);
  await expect(contextStatus(page)).toContainText(/Finding|Looking/);
  await expect(nextSteps(page)).not.toContainText("Looking at this space");
  await expect(writer).toBeEditable();
});

for (const second of ["another item", "whole canvas"] as const)
  test(`a same-turn ${second} click cannot relabel the admitted contextual request`, async ({
    page,
  }) => {
    const canvas = structuredClone(initialCanvas);
    canvas.blocks.push({
      id: "other",
      kind: "text",
      title: "Another thought",
      body: "Leave this independent thought here.",
      pinned: false,
      sourceIds: [],
      placement: "aside",
    });
    await mount(page, { canvas, holdWrite: true });
    await page
      .getByRole("textbox", { name: "Walking route text", exact: true })
      .fill("My current route.");
    await page.evaluate((second) => {
      const first = document.querySelector<HTMLButtonElement>(
        '[aria-label="Suggest next steps for Walking route"]',
      )!;
      const competing = document.querySelector<HTMLButtonElement>(
        second === "another item"
          ? '[aria-label="Suggest next steps for Another thought"]'
          : '[aria-label="Suggest next steps"]',
      )!;
      first.click();
      competing.click();
    }, second);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as FixtureWindow).flow.writes.length,
        ),
      )
      .toBe(1);
    await expect(contextStatus(page)).toBeVisible();
    await expect(
      page.getByRole("region", {
        name: "Next steps for Another thought",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(nextSteps(page)).not.toContainText("Looking at this space");
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).flow.releaseWrite(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as FixtureWindow).flow.asks.length,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks[0]!.refresh,
      ),
    ).toEqual({ canvasRevision: 4, scope: { blockId: "route" } });
    await publishContextRefresh(page);
    await expect(contextStatus(page)).toContainText("1 next step is ready");
  });

test("a selected passage request preserves backward native selection and sends literal UTF-16 scope", async ({
  page,
}) => {
  const canvas = structuredClone(initialCanvas);
  const body = "First 🌿 gate. Then 🌿 gate. Leave the rest in my words.";
  if (canvas.blocks[0]!.kind === "text") canvas.blocks[0]!.body = body;
  await mount(page, { canvas });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  const start = body.indexOf("🌿 gate", body.indexOf("🌿 gate") + 1),
    end = start + "🌿 gate".length;
  await writer.focus();
  await writer.evaluate(
    (element, range) => {
      (window as unknown as { originalEditor: Element }).originalEditor =
        element;
      (element as HTMLTextAreaElement).setSelectionRange(range.end, range.end);
    },
    { start, end },
  );
  for (const _ of Array.from("🌿 gate")) await writer.press("Shift+ArrowLeft");
  const action = page.getByRole("button", {
    name: "Suggest for this passage",
    exact: true,
  });
  await expect(action).toBeVisible();
  await action.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks[0]!.refresh,
    ),
  ).toEqual({
    canvasRevision: 3,
    scope: {
      blockId: "route",
      selection: { field: "body", start, end, text: "🌿 gate" },
    },
  });
  await expect(writer).toBeFocused();
  expect(
    await writer.evaluate((element) => ({
      same:
        element ===
        (window as unknown as { originalEditor: Element }).originalEditor,
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      direction: (element as HTMLTextAreaElement).selectionDirection,
    })),
  ).toEqual({ same: true, start, end, direction: "backward" });
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.writes),
  ).toEqual([]);
});

test("an item changed by the canonical save cannot silently become a different request target", async ({
  page,
}) => {
  await mount(page, { holdWrite: true });
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow,
      dispatch = window.eve.dispatch;
    window.eve.dispatch = async (command) => {
      const result = await dispatch(command);
      if (command.type !== "UpdateCanvas") return result;
      const document = structuredClone(command.document);
      if (document.blocks[0]!.kind === "text")
        document.blocks[0]!.body += " A later canonical edit.";
      w.fixture.patchTask(command.taskId, {
        canvas: {
          document,
          revision: command.expectedRevision + 2,
          updatedAt: 3,
        },
      });
      return { ...result, snapshot: structuredClone(w.fixture.snapshot) };
    };
  });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.fill("This is the item I chose.");
  await itemNextSteps(page).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.writes.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).flow.releaseWrite(),
  );
  await expect(contextStatus(page)).toContainText(
    "This item changed while saving",
  );
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.asks),
  ).toEqual([]);
});

test("unavailable contextual assistance is anchored to the item and can retry without a typed request", async ({
  page,
}) => {
  await mount(page, { unavailable: true });
  await itemNextSteps(page).click();
  await expect(contextStatus(page)).toContainText("No qualified provider");
  await expect(nextSteps(page)).not.toContainText("No qualified provider");
  await contextStatus(page)
    .getByRole("button", { name: /Try again/ })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).flow.asks.map((ask) => ask.refresh),
    ),
  ).toEqual([
    { canvasRevision: 3, scope: { blockId: "route" } },
    { canvasRevision: 3, scope: { blockId: "route" } },
  ]);
});

async function publishContextRefresh(page: Page, empty = false, late = false) {
  await page.evaluate(
    ({ empty, late }) => {
      const w = window as unknown as FixtureWindow;
      const current = w.fixture.snapshot.tasks.find(
        (task) => task.id === "note-a",
      )!.canvas!;
      const block = current.document!.blocks.find(
        (block) => block.id === "route",
      )!;
      if (block.kind !== "text") throw new Error("Expected writer");
      const document: CanvasDocument = {
        ...current.document!,
        suggestions: [
          ...(current.document!.suggestions ?? []).filter(
            (choice) => choice.targetBlockId !== "route",
          ),
          ...(empty
            ? []
            : [
                {
                  id: "route-detail",
                  label: "Clarify the meeting point",
                  description: "Review a more specific opening.",
                  request:
                    "Clarify the meeting point while keeping my other words.",
                  targetBlockId: "route",
                  prepared: {
                    before: [block],
                    edits: [
                      {
                        type: "replace" as const,
                        block: {
                          ...block,
                          body: `Meet beside the lighthouse. ${block.body}`,
                        },
                      },
                    ],
                  },
                },
              ]),
        ],
      };
      if (!late)
        w.fixture.patchTask("note-a", {
          canvas: { document, revision: current.revision + 1, updatedAt: 5 },
        });
      w.fixture.publishIntelligence({
        type: "intent",
        response: {
          requestId: w.fixture.asks.at(-1)!.requestId,
          taskId: "note-a",
          status: "complete",
          message: empty
            ? "No useful next step to suggest right now."
            : "1 next step is ready to consider.",
          citations: [],
          proposals: [
            {
              id: "context-choices",
              kind: "canvas",
              label: "Fresh next steps",
              summary: "Choices for your item.",
              canvas: document,
              status: "applied",
              expiresAt: Date.now() + 300000,
            },
          ],
        },
      });
    },
    { empty, late },
  );
}

test("contextual metadata receipt retains the live writer, exact foreign choice and native Undo", async ({
  page,
}) => {
  const canvas = structuredClone(initialCanvas);
  canvas.suggestions!.push({
    id: "whole-space",
    label: "Compare the routes",
    description: "An existing whole-space direction.",
    request: "Compare routes when details are ready.",
    targetBlockId: null,
  });
  await mount(page, { canvas });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.focus();
  await writer.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.keyboard.insertText(" Keep my choice of words.");
  const edited = await writer.inputValue();
  await itemNextSteps(page).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  await writer.focus();
  await writer.evaluate((element) => {
    (window as unknown as { originalEditor: Element }).originalEditor = element;
    (element as HTMLTextAreaElement).setSelectionRange(2, 9, "backward");
  });
  await publishContextRefresh(page);
  await expect(contextStatus(page)).toContainText("1 next step is ready");
  await expect(
    page.getByRole("button", {
      name: "Clarify the meeting point",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compare the routes", exact: true }),
  ).toBeVisible();
  await expect(writer).toHaveValue(edited);
  await expect(writer).toBeFocused();
  expect(
    await writer.evaluate((element) => ({
      same:
        element ===
        (window as unknown as { originalEditor: Element }).originalEditor,
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      direction: (element as HTMLTextAreaElement).selectionDirection,
    })),
  ).toEqual({ same: true, start: 2, end: 9, direction: "backward" });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks.length,
    ),
  ).toBe(1);
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue("Start beside the lighthouse.");
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue(edited);
});

test("an empty item refresh reports empty even while a foreign suggestion remains", async ({
  page,
}) => {
  const canvas = structuredClone(initialCanvas);
  canvas.suggestions!.push({
    id: "whole-space",
    label: "Compare the routes",
    description: "Keep this separate direction.",
    request: "Compare routes when ready.",
    targetBlockId: null,
  });
  await mount(page, { canvas });
  await itemNextSteps(page).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  await publishContextRefresh(page, true);
  await expect(contextStatus(page)).toHaveAttribute("data-state", "empty");
  await expect(contextStatus(page)).toContainText("No useful next step");
  await expect(
    page.getByRole("button", { name: "Compare the routes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Make a packing list", exact: true }),
  ).toHaveCount(0);
});

test("typing while contextual choices are pending retires the request and ignores a late completion", async ({
  page,
}) => {
  await mount(page);
  await itemNextSteps(page).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.fill("My later route stays current.");
  await publishContextRefresh(page, false, true);
  await expect(writer).toHaveValue("My later route stays current.");
  await expect(
    page.getByRole("button", {
      name: "Clarify the meeting point",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(contextStatus(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.asks.length,
    ),
  ).toBe(1);
});
async function publishRefresh(
  page: Page,
  phase: "ready" | "applying" | "applied",
  options: { empty?: boolean; requestId?: string; late?: boolean } = {},
) {
  await page.evaluate(
    ({ phase, options, choice }) => {
      const w = window as unknown as FixtureWindow;
      const task = w.fixture.snapshot.tasks.find(
        (item) => item.id === "note-a",
      )!;
      const canvas = {
        ...task.canvas!.document!,
        suggestions: options.empty ? [] : [choice],
      };
      if (phase === "applied" && !options.late)
        w.fixture.patchTask("note-a", {
          canvas: {
            document: canvas,
            revision: task.canvas!.revision + 1,
            updatedAt: 3,
          },
        });
      w.fixture.publishIntelligence({
        type: "intent",
        response: {
          requestId: options.requestId ?? w.fixture.asks.at(-1)!.requestId,
          taskId: "note-a",
          status: "complete",
          message:
            phase === "applied"
              ? options.empty
                ? "No useful next step to suggest right now."
                : "1 next step is ready to consider."
              : "Options prepared.",
          citations: [],
          proposals: [
            {
              id: "fresh-choices",
              kind: "canvas",
              label: "Fresh next steps",
              summary: "Suggestions for your current work.",
              canvas,
              status: phase,
              expiresAt: Date.now() + 300000,
            },
          ],
        },
      });
    },
    { phase, options, choice: freshChoice },
  );
}

test("fresh next steps flush current edits, issue one explicit refresh and retain the live writer through the metadata receipt", async ({
  page,
}) => {
  await mount(page, { holdWrite: true });
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.focus();
  await writer.press("End");
  await page.keyboard.type(" Keep the northern gate in my route.");
  const edited = await writer.inputValue();
  await writer.evaluate((element) => {
    (window as unknown as { originalEditor: Element }).originalEditor = element;
  });
  const button = nextSteps(page).getByRole("button", {
    name: "Suggest next steps",
    exact: true,
  });
  await button.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.writes.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).flow.asks),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).flow.releaseWrite(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(
    () => (window as unknown as FixtureWindow).flow.asks[0]!,
  );
  expect(sent).toMatchObject({
    mode: "suggestions",
    capturedRevision: 4,
    capturedCanvas: { blocks: [{ body: edited }] },
  });
  expect(sent.suggestion).toBeUndefined();
  await writer.focus();
  await writer.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(6, 12, "backward"),
  );
  await publishRefresh(page, "ready");
  await expect(nextSteps(page)).toHaveAttribute("data-state", "loading");
  await publishRefresh(page, "applying");
  await expect(
    nextSteps(page).locator(".canvas-next-steps-request"),
  ).toBeDisabled();
  await publishRefresh(page, "applied");
  await expect(nextSteps(page)).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByRole("button", { name: freshChoice.label, exact: true }),
  ).toBeVisible();
  await expect(writer).toBeFocused();
  await expect(writer).toHaveValue(edited);
  expect(
    await writer.evaluate((element) => ({
      same:
        element ===
        (window as unknown as { originalEditor: Element }).originalEditor,
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      direction: (element as HTMLTextAreaElement).selectionDirection,
    })),
  ).toEqual({ same: true, start: 6, end: 12, direction: "backward" });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).flow.writes.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.proposalCalls,
    ),
  ).toEqual([]);
  await writer.press("ControlOrMeta+z");
  await expect(writer).not.toHaveValue(edited);
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue(edited);
});

for (const condition of [
  "no choices",
  "the last choice was kept",
  "the only choice is stale",
] as const)
  test(`fresh next steps remain reachable when ${condition}`, async ({
    page,
  }) => {
    const canvas = structuredClone(initialCanvas);
    if (condition === "the only choice is stale") {
      const before = structuredClone(canvas.blocks[0]!);
      canvas.suggestions![0]!.prepared = {
        before: [before],
        edits: [
          {
            type: "replace",
            block: { ...before, title: "An organized route" },
          },
        ],
      };
      if (canvas.blocks[0]!.kind === "text")
        canvas.blocks[0]!.body += " My newer route.";
    } else {
      canvas.suggestions = [];
      if (condition === "the last choice was kept")
        canvas.blocks.push({
          id: "packing-list",
          kind: "checklist",
          title: "Things to bring",
          placement: "aside",
          pinned: false,
          sourceIds: [],
          items: [{ id: "water", label: "Water bottle", checked: false }],
        });
    }
    await mount(page, { canvas });
    if (condition === "the only choice is stale")
      await expect(
        page.getByRole("button", { name: "Make a packing list", exact: true }),
      ).toBeDisabled();
    await nextSteps(page)
      .getByRole("button", { name: "Suggest next steps", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as FixtureWindow).flow.asks.length,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks[0]!.mode,
      ),
    ).toBe("suggestions");
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).flow.writes,
      ),
    ).toEqual([]);
    await publishRefresh(page, "applied", { empty: true });
    await expect(nextSteps(page)).toHaveAttribute("data-state", "empty");
    await expect(nextSteps(page)).toContainText("No useful next step");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
            (item) => item.id === "note-a",
          )!.canvas!.document!.blocks,
      ),
    ).toEqual(canvas.blocks);
  });

test("unavailable refresh can retry, cancellation and later typing reject late response presentation", async ({
  page,
}) => {
  await mount(page, { unavailable: true });
  await nextSteps(page)
    .getByRole("button", { name: "Suggest next steps", exact: true })
    .click();
  await expect(nextSteps(page)).toHaveAttribute("data-state", "error");
  await expect(nextSteps(page)).toContainText("No qualified provider");
  await expect(
    page.getByRole("button", { name: "Make a packing list", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () => ((window as unknown as FixtureWindow).flow.unavailable = false),
  );
  await nextSteps(page)
    .getByRole("button", { name: "Try again: suggest next steps", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(2);
  const cancelledId = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture.asks.at(-1)!.requestId,
  );
  await nextSteps(page)
    .getByRole("button", { name: "Cancel next steps request", exact: true })
    .click();
  await expect(nextSteps(page)).toHaveAttribute("data-state", "idle");
  await publishRefresh(page, "applied", { requestId: cancelledId, late: true });
  await expect(nextSteps(page)).toHaveAttribute("data-state", "idle");
  await expect(
    page.getByRole("button", { name: freshChoice.label, exact: true }),
  ).toHaveCount(0);
  await nextSteps(page)
    .getByRole("button", { name: "Suggest next steps", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(3);
  const editingId = await page.evaluate(
    () => (window as unknown as FixtureWindow).fixture.asks.at(-1)!.requestId,
  );
  const writer = page.getByRole("textbox", {
    name: "Walking route text",
    exact: true,
  });
  await writer.fill("Keep this newer route.");
  await publishRefresh(page, "applied", { requestId: editingId, late: true });
  await expect(writer).toBeFocused();
  await expect(writer).toHaveValue("Keep this newer route.");
  await expect(
    page.getByRole("button", { name: freshChoice.label, exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.cancelled,
    ),
  ).toEqual(expect.arrayContaining([cancelledId, editingId]));
});

test("the automatic metadata save keeps truthful busy state when another request is attempted", async ({
  page,
}) => {
  const canvas = {
    ...initialCanvas,
    blocks: initialCanvas.blocks.map((block) =>
      block.kind === "text" ? { ...block, body: "" } : block,
    ),
    suggestions: [],
  };
  await mount(page, { canvas });
  await nextSteps(page)
    .getByRole("button", { name: "Suggest next steps", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    )
    .toBe(1);
  for (const phase of ["ready", "applying"] as const) {
    await publishRefresh(page, phase);
    const outline = page.getByRole("button", {
      name: "Make an outline",
      exact: true,
    });
    await expect(outline).toBeDisabled();
    await outline.evaluate((element) => (element as HTMLButtonElement).click());
    // The global Ask surface is another route to App.submitIntent; it must not
    // reset refresh bookkeeping when its submission is refused as busy.
    if (phase === "ready")
      await page.getByRole("button", { name: "Ask Eve", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as FixtureWindow).fixture.overlay?.kind,
        ),
      )
      .toBe("intent");
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture;
      fixture.sendAction({
        instanceId: fixture.overlay!.instanceId,
        type: "intent-submit",
        taskId: "note-a",
        text: "Create an outline for this canvas.",
      });
    });
    await expect(nextSteps(page)).toHaveAttribute("data-state", "loading");
    await expect(
      nextSteps(page).locator(".canvas-next-steps-request"),
    ).toBeDisabled();
    await expect(
      nextSteps(page).getByRole("button", {
        name: "Cancel next steps request",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).flow.asks.length,
      ),
    ).toBe(1);
  }
  await publishRefresh(page, "applied");
  await expect(nextSteps(page)).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByRole("button", { name: "Make an outline", exact: true }),
  ).toBeEnabled();
});
