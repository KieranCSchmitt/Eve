import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import type { CanvasDocument, CoreCommandInput } from "@eve/contracts";
import type { TaskAsset } from "../../apps/desktop/shared/bridge";

type Fixtures = typeof import("./renderer-fixture");
type Write = Extract<CoreCommandInput, { type: "UpdateCanvas" }>;
type FixtureWindow = Window & {
  RendererFixture: Fixtures;
  fixture: ReturnType<Fixtures["mountAppFixture"]>;
  attachmentFlow: {
    writes: Write[];
    order: string[];
    holdWrite: boolean;
    releaseWrite(): void;
    assetDelivery?: {
      reads: number;
      phases: string[];
      release(): void;
    };
  };
};
const canvas: CanvasDocument = {
  version: 1,
  title: "A picture for the invitation",
  subtitle: "A browser-only fixture.",
  layout: "split",
  blocks: [
    {
      id: "writing",
      kind: "text",
      title: "Invitation words",
      body: "Come by for an afternoon together.",
      placement: "main",
      pinned: false,
      sourceIds: [],
    },
    {
      id: "slot",
      kind: "image",
      title: "An image to choose",
      assetId: null,
      caption: "Keep this caption.",
      placement: "aside",
      pinned: true,
      sourceIds: [],
    },
    {
      id: "second-slot",
      kind: "image",
      title: "Another image",
      assetId: null,
      caption: "",
      placement: "aside",
      pinned: false,
      sourceIds: [],
    },
  ],
};
let script: string, styles: string, asset: TaskAsset;
test.beforeAll(async () => {
  const output = await build({
    entryPoints: ["tests/desktop-focus/renderer-fixture.tsx"],
    bundle: true,
    write: false,
    outfile: "canvas-image-attachment-flow.js",
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
  const bytes = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  asset = {
    id: "fixture-photo",
    taskId: "note-a",
    title: "River photograph",
    mediaType: "image/png",
    byteLength: bytes.length,
    url: `data:image/png;base64,${bytes.toString("base64")}`,
    provenance: {
      kind: "user-import",
      attribution: "Repository image used only in the renderer fixture.",
      rights: "Test fixture.",
    },
  };
});
async function mount(page: Page, holdWrite = false) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ canvas, holdWrite }) => {
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
      fixture.holdImageAttachment = true;
      let release: (() => void) | undefined;
      const flow = (w.attachmentFlow = {
        writes: [],
        order: [],
        holdWrite,
        releaseWrite: () => {
          flow.holdWrite = false;
          release?.();
          release = undefined;
        },
      } as FixtureWindow["attachmentFlow"]);
      const dispatch = window.eve.dispatch;
      window.eve.dispatch = async (command) => {
        if (command.type !== "UpdateCanvas") return dispatch(command);
        flow.writes.push(structuredClone(command));
        flow.order.push("save-start");
        if (flow.holdWrite)
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
      const attach = window.eve.attachCanvasImage;
      window.eve.attachCanvasImage = (input) => {
        flow.order.push("attach");
        return attach(input);
      };
    },
    { canvas, holdWrite },
  );
  await expect(
    page
      .getByTestId("canvas")
      .getByRole("heading", { name: canvas.title, exact: true }),
  ).toBeVisible();
}
const slot = (page: Page, id = "slot") =>
  page.locator(`[data-canvas-image="${id}"]`);
const importer = (page: Page, id = "slot") =>
  slot(page, id).getByRole("button", { name: "Import image", exact: true });
const writer = (page: Page) =>
  page.getByRole("textbox", { name: "Invitation words text", exact: true });
const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as FixtureWindow).fixture.imageAttachmentCalls,
  );
async function finish(
  page: Page,
  status: "attached" | "cancelled" | "not-attached" | "uncertain",
  message: string,
) {
  await page.evaluate(
    ({ status, message }) => {
      const fixture = (window as unknown as FixtureWindow).fixture;
      fixture.imageAttachmentResult = {
        status,
        message,
        assetId: status === "attached" ? "fixture-photo" : null,
      };
      fixture.releaseImageAttachment();
    },
    { status, message },
  );
}

test("App flushes the latest canvas before one exact scoped attachment IPC despite repeated activation", async ({
  page,
}) => {
  await mount(page, true);
  await writer(page).fill(
    "The invitation changed before choosing its photograph.",
  );
  await importer(page).evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).attachmentFlow.writes.length,
      ),
    )
    .toBe(1);
  expect(await calls(page)).toEqual([]);
  await expect(importer(page)).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).attachmentFlow.releaseWrite(),
  );
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  expect((await calls(page))[0]).toMatchObject({
    taskId: "note-a",
    blockId: "slot",
    expectedEpoch: 1,
    expectedRevision: 4,
    source: { kind: "import" },
    requestId: expect.any(String),
  });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).attachmentFlow.order,
    ),
  ).toEqual(["save-start", "save-complete", "attach"]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(
          (task) => task.id === "note-a",
        )?.canvas?.document?.blocks[0],
    ),
  ).toMatchObject({
    body: "The invitation changed before choosing its photograph.",
  });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.asks,
    ),
  ).toEqual([]);
  await slot(page)
    .getByRole("button", { name: "Cancel image attachment", exact: true })
    .click();
  await finish(page, "cancelled", "Image attachment cancelled.");
  await expect(importer(page)).toBeEnabled();
  await expect(importer(page)).toBeFocused();
});

test("typing remains native while a picker is pending and cancellation retires its late response without changing that writing", async ({
  page,
}) => {
  await mount(page);
  const input = writer(page),
    original = await input.elementHandle();
  await importer(page).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await input.focus();
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" Bring a notebook.");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).fixture
            .imageAttachmentCancellations.length,
      ),
    )
    .toBeGreaterThan(0);
  const request = (await calls(page))[0]!;
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).fixture
          .imageAttachmentCancellations[0],
    ),
  ).toEqual({ taskId: request.taskId, requestId: request.requestId });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).attachmentFlow.writes.length,
      ),
    )
    .toBe(1);
  await finish(
    page,
    "not-attached",
    "Your canvas changed. The image was not attached.",
  );
  await expect(slot(page)).toContainText("Your canvas changed.");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element, previous) => element === previous, original),
  ).toBe(true);
  await expect(input).toHaveValue(
    "Come by for an afternoon together. Bring a notebook.",
  );
  await expect(slot(page).locator("[data-empty-image]")).toBeVisible();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveValue("Come by for an afternoon together.");
  expect(await calls(page)).toHaveLength(1);
});

test("uncertain attachment checks replay the exact input and block another slot until the receipt settles", async ({
  page,
}) => {
  await mount(page);
  await importer(page).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await finish(page, "uncertain", "The attachment result needs checking.");
  const check = slot(page).getByRole("button", {
    name: "Check attachment",
    exact: true,
  });
  await expect(check).toBeVisible();
  await importer(page).press("Enter");
  await importer(page, "second-slot").click();
  expect(await calls(page)).toHaveLength(1);
  await check.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  expect((await calls(page))[1]).toEqual((await calls(page))[0]);
  await finish(
    page,
    "not-attached",
    "The image was not attached. You can choose again.",
  );
  await expect(check).toHaveCount(0);
  await importer(page, "second-slot").click();
  await expect.poll(async () => (await calls(page)).length).toBe(3);
  expect((await calls(page))[2]).toMatchObject({
    blockId: "second-slot",
    source: { kind: "import" },
  });
  expect((await calls(page))[2]!.requestId).not.toBe(
    (await calls(page))[0]!.requestId,
  );
  await finish(page, "cancelled", "Image attachment cancelled.");
});

for (const undoBeforeCheck of [false, true]) test(`a canonical filled slot retains its uncertain Check action and current native editor when Undo is ${undoBeforeCheck ? "before" : "after"} the receipt`, async ({
  page,
}, testInfo) => {
  await mount(page);
  const caption = slot(page).getByRole("textbox", {
    name: "An image to choose caption",
  });
  const original = await caption.elementHandle();
  await importer(page).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await caption.focus();
  await caption.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(2, 7, "backward"),
  );
  await page.evaluate((asset) => {
    const w = window as unknown as FixtureWindow;
    const fixture = w.fixture;
    const task = fixture.snapshot.tasks.find((task) => task.id === "note-a")!;
    // A new canonical revision independently refreshes managed metadata. Hold
    // that actual bridge read so Loading is a deliberate state, not a race
    // against the fixture's normally immediate asset response.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const delivery = (w.attachmentFlow.assetDelivery = {
      reads: 0,
      phases: [] as string[],
      release: () => {
        delivery.phases.push("metadata-released");
        release();
      },
    });
    const assets = window.eve.assets;
    window.eve.assets = async (taskId) => {
      if (taskId !== task.id) return assets(taskId);
      delivery.reads += 1;
      delivery.phases.push("metadata-requested");
      await held;
      const result = await assets(taskId);
      delivery.phases.push("metadata-resolved");
      return result;
    };
    fixture.assets = [asset];
    fixture.patchTask(task.id, {
      canvas: {
        ...task.canvas!,
        revision: 4,
        document: {
          ...task.canvas!.document!,
          blocks: task.canvas!.document!.blocks.map((block) =>
            block.id === "slot" && block.kind === "image"
              ? { ...block, assetId: asset.id }
              : block,
          ),
        },
      },
    });
    delivery.phases.push("canonical-filled-published");
  }, asset);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as FixtureWindow).attachmentFlow.assetDelivery!.reads,
  )).toBeGreaterThan(0);
  await expect(slot(page)).toHaveAttribute("data-image-empty", "false");
  await expect(slot(page)).toContainText("Loading your image…");
  await expect(caption).toBeFocused();
  expect(await caption.evaluate((element, previous) => element === previous, original)).toBe(true);
  expect(await caption.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart, element.selectionEnd, element.selectionDirection,
  ])).toEqual([2, 7, "backward"]);
  await page.evaluate(() => {
    const delivery = (window as unknown as FixtureWindow).attachmentFlow.assetDelivery!;
    delivery.phases.push("loading-observed-with-editor-retained");
    delivery.release();
  });
  await finish(
    page,
    "uncertain",
    "The image may be attached. Check its result.",
  );
  const check = slot(page).getByRole("button", {
    name: "Check attachment",
    exact: true,
  });
  await expect(check).toBeVisible();
  await expect(
    slot(page).locator(".canvas-photo-stage > [data-adjusted-image]"),
  ).toHaveAttribute("data-status", "ready");
  await expect(caption).toBeFocused();
  expect(
    await caption.evaluate(
      (element, previous) => element === previous,
      original,
    ),
  ).toBe(true);
  expect(
    await caption.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]),
  ).toEqual([2, 7, "backward"]);
  const undoAttachment = () => page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).fixture;
    const task = fixture.snapshot.tasks.find((task) => task.id === "note-a")!;
    fixture.patchTask(task.id, {
      canvas: {
        ...task.canvas!,
        revision: 5,
        document: {
          ...task.canvas!.document!,
          blocks: task.canvas!.document!.blocks.map((block) =>
            block.id === "slot" && block.kind === "image"
              ? { ...block, assetId: null }
              : block,
          ),
        },
      },
    });
  });
  if (undoBeforeCheck) {
    await undoAttachment();
    await expect(slot(page).locator("[data-empty-image]")).toBeVisible();
    await expect(check).toBeVisible();
  }
  await check.click();
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  expect((await calls(page))[1]).toEqual((await calls(page))[0]);
  await finish(page, "attached", "Image attached. Original preserved.");
  await expect(check).toHaveCount(0);
  await expect(slot(page)).toContainText(undoBeforeCheck
    ? "The earlier image attachment was saved. Your current canvas is unchanged."
    : "Image attached. Original preserved.");
  // Canonical Undo must not leave a current-success receipt on an empty slot,
  // including when an older saved receipt arrives only after that Undo.
  await caption.focus();
  if (!undoBeforeCheck) await undoAttachment();
  await expect(slot(page).locator("[data-empty-image]")).toBeVisible();
  await expect(slot(page)).not.toContainText("Image attached.");
  await expect(caption).toBeFocused();
  expect(await caption.evaluate((element, previous) => element === previous, original)).toBe(true);
  const phases = await page.evaluate(() =>
    (window as unknown as FixtureWindow).attachmentFlow.assetDelivery!.phases,
  );
  expect(phases.indexOf("metadata-resolved")).toBeGreaterThan(phases.indexOf("loading-observed-with-editor-retained"));
  const evidencePath = testInfo.outputPath("image-metadata-phase-order.json");
  await writeFile(evidencePath, JSON.stringify({ undoBeforeCheck, phases }, null, 2));
  await testInfo.attach("image-metadata-phase-order", {
    path: evidencePath,
    contentType: "application/json",
  });
});

test("an uncertain attachment remains recoverable when its slot is removed or changes kind", async ({
  page,
}) => {
  for (const change of ["remove", "replace"] as const) {
    await mount(page);
    await importer(page).click();
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    await finish(
      page,
      "uncertain",
      "The previous image attachment needs checking.",
    );
    await expect(
      slot(page).getByRole("button", { name: "Check attachment", exact: true }),
    ).toBeVisible();
    await page.evaluate((change) => {
      const fixture = (window as unknown as FixtureWindow).fixture;
      const task = fixture.snapshot.tasks.find((task) => task.id === "note-a")!;
      const blocks =
        change === "remove"
          ? task.canvas!.document!.blocks.filter((block) => block.id !== "slot")
          : task.canvas!.document!.blocks.map((block) =>
              block.id === "slot"
                ? {
                    id: "slot",
                    kind: "text" as const,
                    title: "A changed item",
                    body: "A new direction.",
                    placement: "aside" as const,
                    pinned: false,
                    sourceIds: [],
                  }
                : block,
            );
      fixture.patchTask(task.id, {
        canvas: {
          ...task.canvas!,
          revision: 4,
          document: { ...task.canvas!.document!, blocks },
        },
      });
    }, change);
    const recovery = page.getByRole("status").filter({
      has: page.getByRole("button", {
        name: "Check previous image attachment",
        exact: true,
      }),
    });
    const check = recovery.getByRole("button", {
      name: "Check previous image attachment",
      exact: true,
    });
    await expect(check).toBeVisible();
    await importer(page, "second-slot").click();
    expect(await calls(page)).toHaveLength(1);
    await check.click();
    await expect.poll(async () => (await calls(page)).length).toBe(2);
    await expect(check).toBeFocused();
    await check.press("Enter");
    await check.press("Enter");
    expect(await calls(page)).toHaveLength(2);
    await expect(check).toBeFocused();
    expect((await calls(page))[1]).toEqual((await calls(page))[0]);
    await finish(
      page,
      "not-attached",
      "This attachment is settled; the changed canvas was preserved.",
    );
    await expect(check).toHaveCount(0);
    await importer(page, "second-slot").click();
    await expect.poll(async () => (await calls(page)).length).toBe(3);
    await finish(page, "cancelled", "Image attachment cancelled.");
  }
});
