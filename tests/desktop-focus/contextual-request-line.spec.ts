import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type CanvasDocument, type CoreCommandInput } from "@eve/contracts";
import type {
  EveBridge,
  IntentResponse,
} from "../../apps/desktop/shared/bridge";

type Fixtures = typeof import("./renderer-fixture");
type Ask = Parameters<EveBridge["ask"]>[0];
type CanvasWrite = Extract<CoreCommandInput, { type: "UpdateCanvas" }>;
type FlowWindow = Window & {
  RendererFixture: Fixtures;
  fixture: ReturnType<Fixtures["mountAppFixture"]>;
  requestLine: {
    asks: Ask[];
    writes: CanvasWrite[];
    order: string[];
    holdSave: boolean;
    releaseSave(): void;
    response?: IntentResponse;
    approved: number;
    generations: number;
    compilations: number;
  };
};
const selected = "Ideas travel through conversation.";
const body = `${selected} A shared detail can become a different idea.\n\nI want to keep the ending open.`;
const canvas: CanvasDocument = {
  version: 1,
  title: "A place to exchange ideas",
  subtitle: "Synthetic browser qualification; no personal information.",
  layout: "split",
  suggestions: [],
  blocks: [
    {
      id: "writing",
      kind: "text",
      title: "An unfinished thought",
      body,
      placement: "main",
      pinned: false,
      sourceIds: [],
    },
    {
      id: "notes",
      kind: "text",
      title: "What to keep",
      body: "Keep the author's uncertainty and the original observation.",
      placement: "aside",
      pinned: true,
      sourceIds: [],
    },
  ],
};
let script: string, styles: string;
test.beforeAll(async () => {
  const output = await build({
    entryPoints: ["tests/desktop-focus/renderer-fixture.tsx"],
    bundle: true,
    write: false,
    outfile: "contextual-request-line.js",
    format: "iife",
    globalName: "RendererFixture",
    jsx: "automatic",
    loader: { ".woff2": "dataurl", ".woff": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const [global, serif, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${global}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}\n@font-face{font-family:'Newsreader Variable';font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}`;
});
async function mount(page: Page, holdSave = false, pinned = false) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ canvas, holdSave, pinned }) => {
      const w = window as unknown as FlowWindow;
      const fixture = (w.fixture = w.RendererFixture.mountAppFixture(
        document.getElementById("root")!,
        "note",
        false,
        "linux",
      ));
      canvas.blocks[0]!.pinned = pinned;
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
      const flow = (w.requestLine = {
        asks: [],
        writes: [],
        order: [],
        holdSave,
        approved: 0,
        generations: 0,
        compilations: 0,
        releaseSave() {
          flow.holdSave = false;
          release?.();
          release = undefined;
        },
      } as FlowWindow["requestLine"]);
      const dispatch = window.eve.dispatch;
      window.eve.dispatch = async (command) => {
        if (command.type !== "UpdateCanvas") return dispatch(command);
        flow.writes.push(structuredClone(command));
        flow.order.push("save-start");
        if (flow.holdSave)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
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
      window.eve.ask = (input) => {
        flow.asks.push(structuredClone(input));
        if (!input.suggestion) flow.generations++;
        flow.order.push("ask");
        return ask(input);
      };
      window.eve.applyProposal = async (input) => {
        fixture.proposalCalls.push({ ...input, operation: "apply" });
        const response = flow.response;
        if (!response) throw new Error("No controlled proposal is ready.");
        const proposal = response.proposals.find(
          (item) => item.id === input.proposalId,
        )!;
        if (!proposal.canvas)
          throw new Error("Expected the controlled canvas proposal.");
        flow.approved++;
        const current = (await window.eve.snapshot()).tasks.find(
          (task) => task.id === "note-a",
        )!.canvas!;
        fixture.patchTask("note-a", {
          canvas: {
            document: proposal.canvas,
            revision: current.revision + 1,
            updatedAt: 3,
          },
        });
        return {
          ...response,
          proposals: response.proposals.map((item) =>
            item.id === input.proposalId
              ? { ...item, status: "applied" as const }
              : item,
          ),
        };
      };
    },
    { canvas, holdSave, pinned },
  );
  await expect(writer(page)).toHaveValue(body);
  await page.evaluate(() => document.fonts.ready);
}
const writer = (page: Page) =>
  page.getByRole("textbox", {
    name: "An unfinished thought text",
    exact: true,
  });
const footer = (page: Page) =>
  page.getByRole("textbox", { name: "Ask Eve", exact: true });
const selectionPrompt = (page: Page) =>
  page.getByRole("textbox", { name: "Ask about selection", exact: true });
const explanationRequest =
  "Explain this idea and give me a useful perspective beyond a paraphrase.";
async function askSelection(page: Page, text = explanationRequest) {
  await selectionPrompt(page).click();
  await expect(selectionPrompt(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await selectionPrompt(page).press("Enter");
}
const answer = (page: Page) =>
  page.getByRole("complementary", { name: "About this passage", exact: true });
async function selectPassage(page: Page) {
  await writer(page).focus();
  await writer(page).evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(0, 0),
  );
  await page.keyboard.down("Shift");
  for (let index = 0; index < selected.length; index++)
    await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await expect(selectionPrompt(page)).toBeVisible();
}
async function respond(
  page: Page,
  message = "**Sharing observations** can give another person a new way to look at the same idea. That is one possible reading of this passage, rather than a claim about the author's intent.",
) {
  await page.evaluate((message) => {
    const w = window as unknown as FlowWindow;
    const request = w.fixture.asks.at(-1)!;
    const response: IntentResponse = {
      ...request,
      status: "complete",
      message,
      basis: "general",
      citations: [],
      proposals: [],
    };
    w.requestLine.response = response;
    w.fixture.publishIntelligence({ type: "intent", response });
  }, message);
  await expect(answer(page)).toContainText("Sharing observations");
}
async function assertNoChat(page: Page) {
  await expect(footer(page)).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Ask Eve", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /^(Learn more about this|Improve writing|Review writing)$/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Details", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: /chat history|conversation history|suggested next steps/i,
    }),
  ).toHaveCount(0);
  await expect(page.locator(".canvas-next-steps,.intent-overlay")).toHaveCount(
    0,
  );
}
for (const [width, height] of [
  [1280, 800],
  [1472, 982],
  [390, 844],
] as const)
  test(`single request line and selection explanation stay at the work at ${width}x${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await mount(page);
    await assertNoChat(page);
    const toolShelf = page.getByRole("region", {
      name: "Add to your space",
      exact: true,
    });
    await expect(
      toolShelf.getByRole("button", { name: "All tools", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(toolShelf.locator(".canvas-tool-option")).toHaveCount(0);
    const header = await page.locator(".shell-header").evaluate((node) => {
      const [brand, purpose, system] = [
        ".brand-button",
        ".purpose",
        ".system-bar",
      ].map((selector) =>
        node.querySelector(selector)!.getBoundingClientRect(),
      );
      const controls = [...node.querySelectorAll("button,input")]
        .map((control) => control.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height);
      return {
        brandRight: brand!.right,
        purposeLeft: purpose!.left,
        purposeRight: purpose!.right,
        systemLeft: system!.left,
        controlsInside: controls.every(
          (rect) => rect.left >= 0 && rect.right <= innerWidth,
        ),
      };
    });
    expect(header.brandRight).toBeLessThanOrEqual(header.purposeLeft);
    expect(header.purposeRight).toBeLessThanOrEqual(header.systemLeft);
    expect(header.controlsInside).toBe(true);
    if (width === 390) {
      await page
        .getByRole("button", { name: "Rename space", exact: true })
        .click();
      const title = page.getByRole("textbox", {
        name: "Space title",
        exact: true,
      });
      await expect(title).toBeFocused();
      expect((await title.boundingBox())!.width).toBeGreaterThan(60);
      expect(
        await page.locator(".shell-header").evaluate((node) =>
          [...node.querySelectorAll("button,input")].every((control) => {
            const box = control.getBoundingClientRect();
            return !box.width || (box.left >= 0 && box.right <= innerWidth);
          }),
        ),
      ).toBe(true);
      await title.press("Escape");
    }
    await expect(footer(page)).toBeInViewport();
    const identity = await writer(page).elementHandle();
    await selectPassage(page);
    const before = await writer(page).evaluate((node: HTMLTextAreaElement) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
      direction: node.selectionDirection,
    }));
    await askSelection(page);
    await expect(page.getByRole("form", { name: "Ask about selected text", exact: true })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("form", { name: "Ask Eve", exact: true })).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".canvas-preparation,.canvas-context-insight,.inline-work-review")).toHaveCount(0);
    await expect(answer(page)).toHaveCount(0);
    await expect(selectionPrompt(page)).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as FlowWindow).requestLine.asks.length,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as FlowWindow).requestLine.asks[0],
      ),
    ).toMatchObject({
      taskId: "note-a",
      mode: "selection",
      text: explanationRequest,
      refresh: {
        canvasRevision: 3,
        scope: {
          blockId: "writing",
          selection: {
            field: "body",
            start: 0,
            end: selected.length,
            text: selected,
          },
        },
      },
    });
    await respond(
      page,
      width === 390
        ? "**Sharing observations** can give another person a new way to look at the same idea.\n\nA concrete example is describing the same place to someone who has never visited it: they may notice an assumption that felt obvious to you.\n\nThe useful distinction is between passing on a detail and deciding what that detail means. Those are different steps, and another person may help with either one.\n\nThis is one possible reading of the sentence, rather than a claim about the author's intent."
        : undefined,
    );
    await expect(answer(page)).toContainText("General knowledge");
    await expect(page.getByRole("form", { name: "Ask about selected text", exact: true })).toHaveAttribute("aria-busy", "false");
    await expect(selectionPrompt(page)).toBeFocused();
    expect(
      await writer(page).evaluate(
        (node: HTMLTextAreaElement, original) => ({
          same: node === original,
          start: node.selectionStart,
          end: node.selectionEnd,
          direction: node.selectionDirection,
        }),
        identity,
      ),
    ).toEqual({ same: true, ...before });
    await expect(writer(page)).toHaveValue(body);
    expect(
      await page.evaluate(
        () => (window as unknown as FlowWindow).requestLine.writes.length,
      ),
    ).toBe(0);
    await assertNoChat(page);
    await expect(footer(page)).toBeInViewport();
    const geometry = await answer(page).evaluate((node) => {
      const box = node.getBoundingClientRect(),
        editor = document
          .querySelector<HTMLTextAreaElement>(
            '[aria-label="An unfinished thought text"]',
          )!
          .getBoundingClientRect(),
        footer = document
          .querySelector(".shell-footer")!
          .getBoundingClientRect();
      return {
        answer: {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        },
        editorTop: editor.top,
        editorBottom: editor.bottom,
        selectionLineHeight: parseFloat(
          getComputedStyle(
            document.querySelector(
              '[aria-label="An unfinished thought text"]',
            )!,
          ).lineHeight,
        ),
        footer: { top: footer.top, bottom: footer.bottom },
        overflow: document.documentElement.scrollWidth > innerWidth,
        belongsToWriter: node
          .closest(".canvas-block")
          ?.getAttribute("data-canvas-block-id"),
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.answer.left).toBeGreaterThanOrEqual(0);
    expect(geometry.answer.right).toBeLessThanOrEqual(width);
    expect(geometry.answer.top).toBeGreaterThanOrEqual(
      geometry.editorTop + geometry.selectionLineHeight,
    );
    expect(geometry.answer.top - geometry.editorBottom).toBeLessThan(100);
    expect(geometry.footer.bottom).toBeLessThanOrEqual(height);
    expect(geometry.belongsToWriter).toBe("writing");
    const directory = resolve(".runtime/selection-prompt-app");
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: resolve(directory, `selection-${width}.png`),
      fullPage: false,
    });
    await writeFile(
      resolve(directory, `selection-${width}.json`),
      JSON.stringify(geometry, null, 2),
    );
    await info.attach("Full App contextual explanation", {
      path: resolve(directory, `selection-${width}.png`),
      contentType: "image/png",
    });
    if (width === 390) {
      const box = await answer(page).boundingBox();
      await page.mouse.move(
        box!.x + box!.width / 2,
        Math.min(height - 90, box!.y + 65),
      );
      await page.mouse.wheel(0, 260);
      await expect
        .poll(() =>
          answer(page).evaluate(
            (node) =>
              node.getBoundingClientRect().bottom <=
              document.querySelector(".shell-footer")!.getBoundingClientRect()
                .top,
          ),
        )
        .toBe(true);
      await expect(selectionPrompt(page)).toBeFocused();
      await expect(footer(page)).toBeInViewport();
      await expect(answer(page)).toContainText("author's intent");
      expect(
        await writer(page).evaluate((node: HTMLTextAreaElement) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
      ).toEqual([0, selected.length]);
      await page.screenshot({
        path: resolve(directory, "selection-390-scrolled.png"),
        fullPage: false,
      });
      const dismissAnswer = page.getByRole("button", {
        name: "Dismiss explanation",
        exact: true,
      });
      for (
        let index = 0;
        index < 6 &&
        !(await dismissAnswer.evaluate(
          (node) => node === document.activeElement,
        ));
        index++
      )
        await page.keyboard.press("Tab");
      await expect(dismissAnswer).toBeFocused();
      const scroller = page.locator(".canvas-context-insight");
      await page.keyboard.press("PageUp");
      await expect
        .poll(() => scroller.evaluate((node) => node.scrollTop))
        .toBe(0);
      const scrollable = await scroller.evaluate(
        (node) => node.scrollHeight > node.clientHeight,
      );
      await page.keyboard.press("PageDown");
      if (scrollable)
        await expect
          .poll(() => scroller.evaluate((node) => node.scrollTop))
          .toBeGreaterThan(0);
      expect(
        await writer(page).evaluate((node: HTMLTextAreaElement) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
      ).toEqual([0, selected.length]);
      await expect(footer(page)).toBeInViewport();
    }
    await toolShelf
      .getByRole("button", { name: "All tools", exact: true })
      .click();
    await expect(toolShelf.locator(".canvas-tool-option")).toHaveCount(11);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(footer(page)).toBeInViewport();
    await page.screenshot({
      path: resolve(directory, `tools-${width}.png`),
      fullPage: false,
    });
    await toolShelf
      .getByRole("button", { name: "Fewer tools", exact: true })
      .click();
    await expect(toolShelf.locator(".canvas-tool-option")).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        asks: (window as unknown as FlowWindow).requestLine.asks.length,
        writes: (window as unknown as FlowWindow).requestLine.writes.length,
      })),
    ).toEqual({ asks: 1, writes: 0 });
  });

test("thinking stays in the footer input through dispatch and generation without adding a canvas card", async ({ page }) => {
  await mount(page);
  const before = await page.locator("[data-canvas-block-id='writing']").boundingBox();
  const inputIdentity = await footer(page).elementHandle();
  await footer(page).fill("Make a graphic that explains the writing.");
  await footer(page).press("Enter");
  await expect(page.getByRole("form", { name: "Ask Eve", exact: true })).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".canvas-prompt-spinner")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  await expect(page.locator(".canvas-preparation,.contextual-answer,.inline-work-review")).toHaveCount(0);
  await expect(footer(page)).toBeFocused();
  expect(await footer(page).evaluate((node, original) => node === original, inputIdentity)).toBe(true);
  expect(await page.locator("[data-canvas-block-id='writing']").boundingBox()).toEqual(before);
  await page.evaluate(() => {
    const w = window as unknown as FlowWindow;
    w.fixture.publishIntelligence({ type: "intent", response: { ...w.fixture.asks.at(-1)!, status: "running", message: "Considering the request…", citations: [], proposals: [] } });
  });
  await expect(page.getByRole("form", { name: "Ask Eve", exact: true })).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".canvas-preparation,.contextual-answer,.inline-work-review")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(page.getByRole("form", { name: "Ask Eve", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => (window as unknown as FlowWindow).fixture.cancelled.length)).toBe(1);
  await expect(writer(page)).toHaveValue(body);
  expect(await requestCounts(page)).toMatchObject({ asks: 1, writes: 0, approved: 0 });
});

test("the selection input cancels its pending request without moving focus or losing the passage", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as unknown as FlowWindow).fixture.receiptDelay = true; });
  await selectPassage(page);
  await askSelection(page);
  const form = page.getByRole("form", { name: "Ask about selected text", exact: true });
  await expect(form).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => requestCounts(page)).toMatchObject({ asks: 1 });
  await expect(page.locator(".canvas-context-insight,.canvas-preparation,.contextual-answer")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel selection request", exact: true }).click();
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(selectionPrompt(page)).toBeFocused();
  await expect(selectionPrompt(page)).toHaveValue(explanationRequest);
  await page.evaluate(() => {
    const w = window as unknown as FlowWindow;
    w.fixture.releaseReceipt(w.fixture.asks.at(-1)!.requestId);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as FlowWindow).fixture.cancelled.length)).toBe(1);
  expect(await writer(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, selected.length]);
  await expect(writer(page)).toHaveValue(body);
  expect(await requestCounts(page)).toMatchObject({ asks: 1, writes: 0, approved: 0 });
});

test("A typed selection request waits for the exact edited passage to save before scoped host dispatch", async ({
  page,
}) => {
  await mount(page, true);
  await writer(page).focus();
  await writer(page).evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" I am still working on this.");
  const edited = await writer(page).inputValue();
  await selectPassage(page);
  await askSelection(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FlowWindow).requestLine.writes.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.asks,
    ),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as FlowWindow).requestLine.releaseSave(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FlowWindow).requestLine.asks.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.order,
    ),
  ).toEqual(["save-start", "save-complete", "ask"]);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.asks[0]?.refresh,
    ),
  ).toEqual({
    canvasRevision: 4,
    scope: {
      blockId: "writing",
      selection: {
        field: "body",
        start: 0,
        end: selected.length,
        text: selected,
      },
    },
  });
  await respond(page);
  await expect(writer(page)).toHaveValue(edited);
  await expect(selectionPrompt(page)).toBeFocused();
  await selectionPrompt(page).press("Escape");
  await expect(writer(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(writer(page)).toHaveValue(body);
});

test("one footer request previews a generic inline change and cannot write until explicit approval", async ({
  page,
}) => {
  await mount(page);
  const identity = await writer(page).elementHandle();
  await footer(page).fill("Make the opening a little shorter.");
  await footer(page).press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FlowWindow).requestLine.asks.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.asks[0],
    ),
  ).toMatchObject({
    taskId: "note-a",
    text: "Make the opening a little shorter.",
    mode: "canvas",
  });
  await expect(footer(page)).toHaveValue("");
  const shortened = "An idea grows through conversation.";
  await page.evaluate(
    ({ canvas, shortened }) => {
      const w = window as unknown as FlowWindow,
        request = w.fixture.asks.at(-1)!;
      const next = structuredClone(canvas);
      const block = next.blocks[0]!;
      if (block.kind === "text") block.body = shortened;
      const response: IntentResponse = {
        ...request,
        status: "complete",
        message: "A shorter opening, ready to review.",
        basis: "general",
        citations: [],
        proposals: [
          {
            id: "inline-change",
            kind: "canvas",
            label: "A shorter opening",
            summary: "Review the words before keeping them.",
            status: "ready",
            expiresAt: Date.now() + 300000,
            beforeCanvas: canvas,
            canvas: next,
          },
        ],
      };
      w.requestLine.response = response;
      w.fixture.publishIntelligence({ type: "intent", response });
    },
    { canvas, shortened },
  );
  const preview = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-review-mode", "compact");
  await expect(preview.locator(".suggestion-compact-values del")).toHaveText(
    body,
  );
  await expect(preview.locator(".suggestion-compact-values ins")).toHaveText(
    shortened,
  );
  await expect(preview.locator(".suggestion-compact-values ins")).toHaveCSS(
    "color",
    "rgb(49, 91, 201)",
  );
  await expect(writer(page)).toHaveValue(body);
  expect(
    await page.evaluate(() => ({
      writes: (window as unknown as FlowWindow).requestLine.writes.length,
      approved: (window as unknown as FlowWindow).requestLine.approved,
    })),
  ).toEqual({ writes: 0, approved: 0 });
  await writer(page).focus();
  await writer(page).evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(2, 8, "backward"),
  );
  await preview.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(writer(page)).toHaveValue(shortened);
  expect(
    await writer(page).evaluate(
      (node, original) => node === original,
      identity,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      asks: (window as unknown as FlowWindow).requestLine.asks.length,
      approved: (window as unknown as FlowWindow).requestLine.approved,
      calls: (window as unknown as FlowWindow).fixture.proposalCalls,
    })),
  ).toMatchObject({
    asks: 1,
    approved: 1,
    calls: [{ proposalId: "inline-change", operation: "apply" }],
  });
  await assertNoChat(page);
});

test("pinned writing can be explained without proposing an edit", async ({
  page,
}) => {
  await mount(page, false, true);
  await selectPassage(page);
  await expect(selectionPrompt(page)).toBeEnabled();
  await askSelection(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FlowWindow).requestLine.asks.length,
      ),
    )
    .toBe(1);
  await respond(page);
  await expect(
    page.getByRole("region", { name: "Suggestion preview", exact: true }),
  ).toHaveCount(0);
  await expect(writer(page)).toHaveValue(body);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.writes.length,
    ),
  ).toBe(0);
});

async function passiveRerender(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as FlowWindow;
    const current = w.fixture.snapshot.tasks.find(
      (task) => task.id === "note-a",
    )!.canvas!;
    w.fixture.patchTask("note-a", {
      canvas: { ...current, updatedAt: current.updatedAt + 1 },
    });
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
const requestCounts = (page: Page) =>
  page.evaluate(() => {
    const flow = (window as unknown as FlowWindow).requestLine;
    return {
      asks: flow.asks.length,
      generations: flow.generations,
      compilations: flow.compilations,
      writes: flow.writes.length,
      approved: flow.approved,
    };
  });

test("a request transport error stays visible beside the work without creating history or losing the draft", async ({
  page,
}) => {
  await mount(page);
  const identity = await writer(page).elementHandle();
  await page.evaluate(() => {
    window.eve.ask = async () => {
      throw new Error(
        "The local provider is unavailable. Your work is unchanged.",
      );
    };
  });
  await footer(page).fill("Make the opening clearer.");
  await footer(page).press("Enter");
  await expect(answer(page)).toContainText(
    "The local provider is unavailable. Your work is unchanged.",
  );
  await expect(footer(page)).toHaveValue("Make the opening clearer.");
  await expect(writer(page)).toHaveValue(body);
  expect(
    await writer(page).evaluate(
      (node, original) => node === original,
      identity,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.writes,
    ),
  ).toEqual([]);
  await assertNoChat(page);
  await page
    .getByRole("button", { name: "Dismiss explanation", exact: true })
    .click();
  await expect(answer(page)).toHaveCount(0);
  await expect(footer(page)).toHaveValue("Make the opening clearer.");
  await footer(page).press("Enter");
  await expect(answer(page)).toContainText(
    "The local provider is unavailable. Your work is unchanged.",
  );
});

async function mountEmptyCanvas(page: Page) {
  await mount(page);
  await page.evaluate(() =>
    (window as unknown as FlowWindow).fixture.patchTask("note-a", {
      canvas: { document: null, revision: 0, updatedAt: 1 },
    }),
  );
  await expect(
    page.getByRole("button", { name: "Start with a blank page", exact: true }),
  ).toBeVisible();
  await footer(page).fill("Organize the thought into a useful space.");
  await footer(page).press("Enter");
  await expect
    .poll(() => requestCounts(page))
    .toMatchObject({ asks: 1, writes: 0, approved: 0 });
}
async function initialCompositionResponse(
  page: Page,
  status: "ready" | "uncertain" = "ready",
) {
  await page.evaluate(
    ({ canvas, status }) => {
      const w = window as unknown as FlowWindow;
      const request = w.fixture.asks.at(-1)!;
      const response: IntentResponse = {
        ...request,
        status: "complete",
        message: "The first composition is available to inspect.",
        citations: [],
        proposals: [
          {
            id: "first-composition",
            kind: "canvas",
            label: "Create this space",
            summary: "The proposed first canvas.",
            canvas,
            status,
            expiresAt: Date.now() + 300000,
            ...(status === "uncertain"
              ? {
                  message:
                    "The save could not be confirmed. Check your work before another change.",
                }
              : {}),
          },
        ],
      };
      // No fabricated beforeCanvas: there was no document in the host capture.
      w.requestLine.response = response;
      w.fixture.publishIntelligence({ type: "intent", response });
    },
    { canvas, status },
  );
}
const initialReview = (page: Page) =>
  page.getByRole("complementary", {
    name: "Review beside your work",
    exact: true,
  });
const canonicalCanvas = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as FlowWindow).fixture.snapshot.tasks.find(
        (task) => task.id === "note-a",
      )!.canvas,
  );

test("a first-canvas ready proposal without beforeCanvas has a read-only review and only explicit approval creates it", async ({
  page,
}) => {
  await mountEmptyCanvas(page);
  const notebook = await page.evaluate(
    () =>
      (window as unknown as FlowWindow).fixture.snapshot.tasks.find(
        (task) => task.id === "note-a",
      )!.note,
  );
  await initialCompositionResponse(page);
  const review = initialReview(page);
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("textbox", {
      name: "An unfinished thought text",
      exact: true,
    }),
  ).toHaveValue(body);
  await expect(
    review.getByRole("textbox", {
      name: "An unfinished thought text",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(review).not.toContainText(
    "A complete before-and-after preview is unavailable",
  );
  await expect(
    page.getByRole("region", { name: "Suggestion preview", exact: true }),
  ).toHaveCount(0);
  expect(await canonicalCanvas(page)).toMatchObject({
    document: null,
    revision: 0,
  });
  expect(await requestCounts(page)).toMatchObject({
    asks: 1,
    writes: 0,
    approved: 0,
  });
  await review
    .getByRole("button", { name: "Approve change", exact: true })
    .click();
  await expect
    .poll(() => canonicalCanvas(page))
    .toMatchObject({ document: canvas, revision: 1 });
  await expect(initialReview(page)).toHaveCount(0);
  await expect(writer(page)).toHaveValue(body);
  expect(await requestCounts(page)).toMatchObject({ asks: 1, approved: 1 });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FlowWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "note-a",
        )!.note,
    ),
  ).toEqual(notebook);
  await assertNoChat(page);
});

test("an unconfirmed first-canvas apply remains visible with no automatic or duplicate retry", async ({
  page,
}) => {
  await mountEmptyCanvas(page);
  await initialCompositionResponse(page);
  await page.evaluate(() => {
    const w = window as unknown as FlowWindow;
    window.eve.applyProposal = async (input) => {
      w.fixture.proposalCalls.push({ ...input, operation: "apply" });
      throw new Error(
        "The first canvas save could not be confirmed. Check your work before trying again.",
      );
    };
  });
  await initialReview(page)
    .getByRole("button", { name: "Approve change", exact: true })
    .click();
  await expect(initialReview(page)).toContainText(
    "The first canvas save could not be confirmed. Check your work before trying again.",
  );
  await expect(initialReview(page)).toContainText(
    "Change could not be applied",
  );
  await expect(
    initialReview(page).getByRole("button", {
      name: "Approve change",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    initialReview(page).getByRole("button", {
      name: "Check status",
      exact: true,
    }),
  ).toHaveCount(0);
  await passiveRerender(page);
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).fixture.proposalCalls,
    ),
  ).toEqual([
    {
      requestId: "request-1",
      proposalId: "first-composition",
      operation: "apply",
    },
  ]);
  expect(await canonicalCanvas(page)).toMatchObject({
    document: null,
    revision: 0,
  });
  expect(await requestCounts(page)).toMatchObject({
    asks: 1,
    writes: 0,
    approved: 0,
  });
  await initialReview(page)
    .getByRole("button", { name: "Dismiss response", exact: true })
    .click();
  await expect(initialReview(page)).toHaveCount(0);
  await assertNoChat(page);
});

test("a no-document uncertain canvas receipt exposes the candidate and warning without offering unsafe replay", async ({
  page,
}) => {
  await mountEmptyCanvas(page);
  await initialCompositionResponse(page, "uncertain");
  await expect(initialReview(page)).toContainText("Change needs review");
  await expect(initialReview(page)).toContainText(
    "The save could not be confirmed. Check your work before another change.",
  );
  await expect(
    initialReview(page).getByRole("textbox", {
      name: "An unfinished thought text",
      exact: true,
    }),
  ).toHaveValue(body);
  await expect(
    initialReview(page).getByRole("button", {
      name: "Approve change",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    initialReview(page).getByRole("button", {
      name: "Check status",
      exact: true,
    }),
  ).toHaveCount(0);
  await passiveRerender(page);
  expect(await canonicalCanvas(page)).toMatchObject({
    document: null,
    revision: 0,
  });
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).fixture.proposalCalls,
    ),
  ).toEqual([]);
  expect(await requestCounts(page)).toMatchObject({
    asks: 1,
    writes: 0,
    approved: 0,
  });
  await assertNoChat(page);
});

test("an arbitrary selected writing request previews only its exact passage in a long essay until Keep", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1472, height: 982 });
  await mount(page);
  const longBody = `${body}\n\n${"An observation can support several interpretations, and I want to leave room for that uncertainty. ".repeat(12)}`;
  await page.evaluate((longBody) => {
    const w = window as unknown as FlowWindow;
    const document = structuredClone(
      w.fixture.snapshot.tasks.find((task) => task.id === "note-a")!.canvas!
        .document!,
    );
    const block = document.blocks[0]!;
    if (block.kind === "text") block.body = longBody;
    w.fixture.patchTask("note-a", {
      canvas: { document, revision: 3, updatedAt: 2 },
    });
  }, longBody);
  await expect(writer(page)).toHaveValue(longBody);
  const identity = await writer(page).elementHandle();
  await selectPassage(page);
  const requestText =
    "Make only these selected words clearer. Keep the uncertainty and the rest of my essay.";
  await askSelection(page, requestText);
  await expect
    .poll(() => requestCounts(page))
    .toMatchObject({ asks: 1, generations: 1, writes: 0 });
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.asks[0],
    ),
  ).toMatchObject({
    text: requestText,
    mode: "selection",
    refresh: {
      canvasRevision: 3,
      scope: {
        blockId: "writing",
        selection: {
          field: "body",
          start: 0,
          end: selected.length,
          text: selected,
        },
      },
    },
  });
  const alternative = "Conversation can give an idea room to grow.";
  await page.evaluate(
    ({ selected, alternative }) => {
      const w = window as unknown as FlowWindow;
      const before = structuredClone(
        w.fixture.snapshot.tasks.find((task) => task.id === "note-a")!.canvas!
          .document!,
      );
      const after = structuredClone(before);
      const block = after.blocks[0]!;
      if (block.kind !== "text") throw new Error("Expected writing");
      block.body = alternative + block.body.slice(selected.length);
      const response: IntentResponse = {
        ...w.fixture.asks.at(-1)!,
        status: "complete",
        message: "Review the selected words.",
        citations: [],
        proposals: [
          {
            id: "selected-writing",
            kind: "canvas",
            label: "A clearer sentence",
            summary: "Only the selected sentence changes.",
            status: "ready",
            expiresAt: Date.now() + 300000,
            beforeCanvas: before,
            canvas: after,
            textSelection: {
              field: "body",
              start: 0,
              end: selected.length,
              text: selected,
            },
          },
        ],
      };
      w.requestLine.response = response;
      w.fixture.publishIntelligence({ type: "intent", response });
    },
    { selected, alternative },
  );
  const preview = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(preview).toHaveAttribute("data-review-mode", "compact");
  await expect(preview.locator(".suggestion-compact-values del")).toHaveText(
    selected,
  );
  await expect(preview.locator(".suggestion-compact-values ins")).toHaveText(
    alternative,
  );
  await expect(selectionPrompt(page)).toBeFocused();
  await expect(writer(page)).toHaveValue(longBody);
  expect(
    await writer(page).evaluate(
      (node: HTMLTextAreaElement, original) => ({
        same: node === original,
        start: node.selectionStart,
        end: node.selectionEnd,
      }),
      identity,
    ),
  ).toEqual({ same: true, start: 0, end: selected.length });
  await passiveRerender(page);
  expect(await requestCounts(page)).toMatchObject({
    asks: 1,
    generations: 1,
    writes: 0,
    approved: 0,
  });
  await preview.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(writer(page)).toHaveValue(
    alternative + longBody.slice(selected.length),
  );
  expect(await requestCounts(page)).toMatchObject({
    asks: 1,
    generations: 1,
    approved: 1,
  });
  expect(
    await writer(page).evaluate(
      (node, original) => node === original,
      identity,
    ),
  ).toBe(true);
  await assertNoChat(page);
});

for (const changed of ["focus", "selection"] as const)
  test(`a typed selection answer never reclaims ${changed} after the user moves on`, async ({
    page,
  }) => {
    await mount(page);
    await selectPassage(page);
    await askSelection(
      page,
      "What other perspective could help me understand these words?",
    );
    await expect.poll(() => requestCounts(page)).toMatchObject({ asks: 1 });
    const target =
      changed === "focus"
        ? page.getByRole("textbox", { name: "What to keep text", exact: true })
        : writer(page);
    await target.focus();
    if (changed === "selection") {
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
    }
    const before = await writer(page).evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]);
    await page.evaluate(() => {
      const w = window as unknown as FlowWindow;
      w.fixture.publishIntelligence({
        type: "intent",
        response: {
          ...w.fixture.asks.at(-1)!,
          status: "complete",
          message: "An observation can invite several interpretations.",
          basis: "general",
          citations: [],
          proposals: [],
        },
      });
    });
    await passiveRerender(page);
    await expect(target).toBeFocused();
    expect(
      await writer(page).evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual(before);
    await expect(writer(page)).toHaveValue(body);
    expect(await requestCounts(page)).toMatchObject({
      asks: 1,
      generations: 1,
      writes: 0,
      approved: 0,
    });
    await assertNoChat(page);
  });

test("a typed video request displays the host-opened exact search query without inventing a video or changing writing", async ({
  page,
}) => {
  await mount(page);
  const identity = await writer(page).elementHandle();
  await selectPassage(page);
  await askSelection(page, "Find a video explaining this.");
  await expect.poll(() => requestCounts(page)).toMatchObject({ asks: 1 });
  expect(
    await page.evaluate(
      () => (window as unknown as FlowWindow).requestLine.asks[0],
    ),
  ).toMatchObject({
    text: "Find a video explaining this.",
    mode: "selection",
    refresh: {
      canvasRevision: 3,
      scope: {
        blockId: "writing",
        selection: {
          field: "body",
          start: 0,
          end: selected.length,
          text: selected,
        },
      },
    },
  });
  const query = "how conversation can develop an idea";
  await page.evaluate((query) => {
    const w = window as unknown as FlowWindow;
    // Public events from the host, not a model-generated UI or fake video.
    w.fixture.publishAttention({
      taskId: "note-a",
      activity: "canvas",
      sourceQuery: query,
      sourceKind: "video",
    });
    w.fixture.publishIntelligence({
      type: "intent",
      response: {
        ...w.fixture.asks.at(-1)!,
        status: "complete",
        message:
          "Opened video search for your selection. Choose a result to view or attach it.",
        citations: [],
        proposals: [],
      },
    });
  }, query);
  await expect(page.locator(".source-video-search h3")).toHaveText(query);
  await expect(
    page.getByRole("button", { name: "Search YouTube", exact: false }),
  ).toBeVisible();
  await expect(page.locator(".contextual-answer-sources")).toHaveCount(0);
  await expect(writer(page)).toHaveValue(body);
  expect(
    await writer(page).evaluate(
      (node, original) => node === original,
      identity,
    ),
  ).toBe(true);
  expect(await canonicalCanvas(page)).toMatchObject({
    document: canvas,
    revision: 3,
  });
  expect(await requestCounts(page)).toMatchObject({
    asks: 1,
    writes: 0,
    approved: 0,
  });
  await assertNoChat(page);
});
