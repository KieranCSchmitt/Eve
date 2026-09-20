import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { CanvasDocument } from "@eve/contracts";

let script: string;
let styles: string;
type CanvasWindow = Window & {
  mountCanvas(document: CanvasDocument): void;
  canvasDocument: CanvasDocument;
  canvasEvents: Array<{ type: string; value?: unknown }>;
  setCanvasDocument(document: CanvasDocument): void;
  setCanvasStatus(state: "saved" | "saving" | "error", message?: string): void;
  setCanvasRequestPending(value: boolean): void;
};
const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const initial: CanvasDocument = {
  version: 1,
  title: "A little room for the weekend",
  subtitle: "Bring the useful pieces together. Keep your next step close.",
  layout: "split",
  blocks: [
    {
      ...base,
      id: "intro",
      kind: "text",
      title: "The thought",
      body: "A walk by the water, and time for a few photographs.",
    },
    {
      ...base,
      id: "budget",
      kind: "table",
      title: "Budget",
      columns: ["Item", "Amount"],
      rows: [
        { id: "r1", cells: ["Budget", "200"] },
        { id: "r2", cells: ["Headphones", "149"] },
        { id: "r3", cells: ["Case", "20"] },
        { id: "r4", cells: ["Remaining", "=B1-B2-B3"] },
      ],
    },
    {
      ...base,
      id: "list",
      kind: "checklist",
      title: "Bring along",
      placement: "aside",
      items: [{ id: "camera", label: "Camera", checked: false }],
    },
    {
      ...base,
      id: "clock",
      kind: "timer",
      title: "A short pause",
      placement: "aside",
      durationSeconds: 5,
      remainingSeconds: 5,
      endsAt: null,
    },
    {
      ...base,
      id: "plan",
      kind: "timeline",
      title: "Leave a little space",
      placement: "full",
      date: "Saturday",
      startHour: 9,
      endHour: 18,
      items: [
        {
          id: "walk",
          title: "Walk by the water",
          startMinutes: 600,
          endMinutes: 660,
          status: "suggested",
          detail: "A little time outside.",
        },
      ],
    },
    {
      ...base,
      id: "photo",
      kind: "image",
      title: "A place to begin",
      assetId: "saved-image",
      caption: "The light along the water.",
    },
    {
      ...base,
      id: "notes",
      kind: "note",
      title: "Keep the thought",
      placement: "aside",
      description: "Your writing is waiting where you left it.",
    },
    {
      ...base,
      id: "refs",
      kind: "sources",
      title: "From your material",
      placement: "aside",
      sourceIds: ["source-1"],
      description: "A useful reference for later.",
    },
  ],
};

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Canvas } from './apps/desktop/renderer/src/components/Canvas';
        import { canvasDocumentSchema } from './packages/contracts/src/canvas';
        const image = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 460"><rect width="800" height="460" fill="#d9e6f0"/><path d="M0 230 Q200 160 390 230 T800 220V460H0" fill="#98b5c2"/><path d="M0 310 Q180 265 420 360 T800 310V460H0" fill="#77867c"/><path d="M0 390 Q200 300 470 410 T800 385V460H0" fill="#56695c"/></svg>');
        const sources = [{id:'source-1',taskId:'task',title:'The riverside notes',assetId:'saved-text',excerpt:'An early start leaves time to explore.',retrievedAt:1,createdAt:1,provenance:{kind:'user-import',attribution:'Imported from your notes.',rights:'Your material.'}}, {id:'source-video',taskId:'task',title:'Saved video lesson',url:'https://www.youtube.com/watch?v=jfKfPfyJRdk',excerpt:'Your saved video reference.',retrievedAt:1,createdAt:1,provenance:{kind:'web-source',attribution:'Saved from YouTube.',rights:'Reference only.'}}];
        const assets = [{id:'saved-image',taskId:'task',title:'The riverside',mediaType:'image/png',byteLength:100,url:image,provenance:{kind:'user-import',attribution:'Your photograph.',rights:'Your material.'}}];
        window.canvasEvents = [];
        function Fixture({initial}) {
          const [document,setDocument] = useState(initial);
          const [save,setSave] = useState({state:'saved'});
          const [requestPending,setRequestPending] = useState(false);
          window.canvasDocument = document;
          window.setCanvasDocument = setDocument;
          window.setCanvasStatus = (state,message) => setSave({state,message});
          window.setCanvasRequestPending = setRequestPending;
          return <Canvas document={document} assets={assets} sources={sources} saveState={save.state} saveMessage={save.message}
            requestPending={requestPending}
            onRequestSuggestion={value => {window.canvasEvents.push({type:'suggestion',value});setRequestPending(true);}}
            canUndo onUndo={() => window.canvasEvents.push({type:'undo'})}
            onOpenNote={() => window.canvasEvents.push({type:'note'})}
            onOpenSource={value => window.canvasEvents.push({type:'source',value})}
            onAddMaterial={() => window.canvasEvents.push({type:'material'})}
            onAddSource={() => window.canvasEvents.push({type:'add-source'})}
            onRequestOutline={value => window.canvasEvents.push({type:'outline',value})}
            onChange={next => {canvasDocumentSchema.parse(next);window.canvasEvents.push({type:'change',value:next});setDocument(next);}} />;
        }
        window.mountCanvas = initial => createRoot(document.getElementById('root')).render(<Fixture initial={initial} />);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
      sourcefile: "canvas-fixture.tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const [baseStyles, serif, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${baseStyles}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}
    @font-face{font-family:'Newsreader Variable';font-style:normal;font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}
    @font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}
    body{background:#fbfbf8}main{padding:30px 48px}#outside{margin:10px}
  `;
});

async function mount(page: Page, document: CanvasDocument = initial) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("http://localhost/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<button id="outside">Outside canvas</button><main id="root"></main>',
    }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.locator("#outside").focus();
  await page.evaluate(
    (document) => (window as unknown as CanvasWindow).mountCanvas(document),
    document,
  );
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.evaluate(() => globalThis.document.fonts.ready);
}
const data = (page: Page) =>
  page.evaluate(() => (window as unknown as CanvasWindow).canvasDocument);
const changeCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as CanvasWindow).canvasEvents.filter(
        (event) => event.type === "change",
      ).length,
  );

test("renders supplied blocks safely, binds sources and assets, and leaves focus alone", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    title: '<img src=x onerror="window.injected=true">',
  });
  await expect(page.locator("#outside")).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    '<img src=x onerror="window.injected=true">',
  );
  await expect(page.locator(".canvas-block")).toHaveCount(8);
  await expect(page.locator(".eve-canvas img")).toHaveCount(1);
  await expect(page.locator(".eve-canvas img")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml/,
  );
  await page
    .getByRole("button", { name: "The riverside notes", exact: true })
    .click();
  await page.getByRole("button", { name: "Open notebook" }).click();
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toEqual([{ type: "source", value: "source-1" }, { type: "note" }]);
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  const missing: CanvasDocument = {
    ...initial,
    blocks: [
      {
        ...base,
        id: "missing",
        kind: "image",
        title: "Missing image",
        assetId: "https://untrusted.example/image.png",
        caption: "",
      },
      {
        ...base,
        id: "missing-source",
        kind: "sources",
        title: "Missing source",
        sourceIds: ["invented"],
        description: "",
      },
    ],
  };
  await page.evaluate(
    (value) => (window as unknown as CanvasWindow).setCanvasDocument(value),
    missing,
  );
  await expect(page.locator(".eve-canvas img")).toHaveCount(0);
  const missingImage = page.getByRole("region", { name: "Missing image", exact: true });
  await expect(missingImage.getByRole("status")).toHaveText("Image unavailable");
  await expect(missingImage.getByRole("button", { name: "Adjust photo" })).toBeDisabled();
  await expect(missingImage.getByRole("button", { name: "Add material" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Source unavailable" }),
  ).toBeDisabled();
});

test("edits text and checklist without stealing selection, saves pins, and delegates Undo", async ({
  page,
}) => {
  await mount(page);
  const text = page.getByRole("textbox", { name: "The thought text" });
  await text.fill("Bring a camera and leave the afternoon open.");
  await text.press("ArrowLeft");
  await page.evaluate(() =>
    (window as unknown as CanvasWindow).setCanvasStatus("saving"),
  );
  await expect(text).toBeFocused();
  await expect(page.locator(".canvas-status")).toContainText("Saving…");
  await page.getByRole("checkbox", { name: "Camera", exact: true }).check();
  await page.getByRole("button", { name: "Edit Camera", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit item 1" })
    .fill("Camera and spare battery");
  await page.getByRole("textbox", { name: "Edit item 1" }).press("Enter");
  await page
    .getByRole("button", { name: "Pin Bring along", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unpin Bring along", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const document = await data(page);
  expect(document.blocks.find((block) => block.id === "intro")).toMatchObject({
    body: "Bring a camera and leave the afternoon open.",
  });
  expect(document.blocks.find((block) => block.id === "list")).toMatchObject({
    pinned: true,
    items: [{ label: "Camera and spare battery", checked: true }],
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as CanvasWindow).canvasEvents.at(-1),
    ),
  ).toEqual({ type: "undo" });
});

test("recalculates real cell references while preserving formulas and rejects executable expressions", async ({
  page,
}) => {
  await mount(page);
  const remaining = page.getByRole("textbox", {
    name: "B4: Amount",
    exact: true,
  });
  await expect(remaining).toHaveValue("31");
  await page
    .getByRole("textbox", { name: "B2: Amount", exact: true })
    .fill("169");
  await page.getByRole("heading", { name: "Budget", exact: true }).click();
  await expect(remaining).toHaveValue("11");
  await remaining.focus();
  await expect(remaining).toHaveValue("=B1-B2-B3");
  await remaining.fill("=globalThis.injected=1");
  await page.getByRole("heading", { name: "Budget", exact: true }).click();
  await expect(remaining).toHaveValue("#FORMULA");
  await expect(remaining).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("keeps suggestions distinct, validates timeline edits, and only commits deliberate changes", async ({
  page,
}) => {
  await mount(page);
  await expect(page.getByText("Suggested · not kept yet")).toBeVisible();
  await page.getByRole("button", { name: "Adjust Walk by the water" }).click();
  await page
    .getByRole("textbox", { name: "End time", exact: true })
    .fill("08:00");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "end time after the start",
  );
  expect(await changeCount(page)).toBe(0);
  await page
    .getByRole("textbox", { name: "End time", exact: true })
    .fill("12:30");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.getByRole("button", { name: "Keep Walk by the water" }).click();
  await expect(page.getByText("Suggested · not kept yet")).toHaveCount(0);
  expect(
    (await data(page)).blocks.find((block) => block.id === "plan"),
  ).toMatchObject({ items: [{ status: "planned", endMinutes: 750 }] });
  await page
    .getByRole("button", { name: "Complete Walk by the water" })
    .click();
  await expect(
    page.getByRole("button", { name: "Reopen Walk by the water" }),
  ).toBeVisible();
});

test("expands timeline bounds for valid edits before dawn and through midnight", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("button", { name: "Adjust Walk by the water" }).click();
  await page
    .getByRole("textbox", { name: "Start time", exact: true })
    .fill("08:15");
  await page
    .getByRole("textbox", { name: "End time", exact: true })
    .fill("20:45");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Start time", exact: true }),
  ).toHaveCount(0);
  expect(
    (await data(page)).blocks.find((block) => block.id === "plan"),
  ).toMatchObject({
    startHour: 8,
    endHour: 21,
    items: [{ startMinutes: 495, endMinutes: 1245 }],
  });
  await page.getByRole("button", { name: "Adjust Walk by the water" }).click();
  await page
    .getByRole("textbox", { name: "Start time", exact: true })
    .fill("00:00");
  await page
    .getByRole("textbox", { name: "End time", exact: true })
    .fill("24:00");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Start time", exact: true }),
  ).toHaveCount(0);
  expect(
    (await data(page)).blocks.find((block) => block.id === "plan"),
  ).toMatchObject({
    startHour: 0,
    endHour: 24,
    items: [{ startMinutes: 0, endMinutes: 1440 }],
  });
  expect(await changeCount(page)).toBe(2);
});

test("timer ticks without saving or moving focus and persists pause/reset/restart", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-20T12:00:00Z") });
  await mount(page);
  await page
    .getByRole("button", { name: "Start A short pause", exact: true })
    .click();
  expect(await changeCount(page)).toBe(1);
  await page.locator("#outside").focus();
  await page.clock.fastForward(2100);
  await expect(page.getByRole("timer")).toHaveText("00:03");
  await expect(page.locator("#outside")).toBeFocused();
  expect(await changeCount(page)).toBe(1);
  await page
    .getByRole("button", { name: "Pause A short pause", exact: true })
    .click();
  expect(
    (await data(page)).blocks.find((block) => block.id === "clock"),
  ).toMatchObject({ remainingSeconds: 3, endsAt: null });
  await page.clock.fastForward(10000);
  await expect(page.getByRole("timer")).toHaveText("00:03");
  await page
    .getByRole("button", { name: "Start A short pause", exact: true })
    .click();
  await page.clock.fastForward(3100);
  await expect(page.getByText("Time is up.", { exact: true })).toBeVisible();
  expect(await changeCount(page)).toBe(3);
  await page
    .getByRole("button", { name: "Reset A short pause", exact: true })
    .click();
  await expect(page.getByRole("timer")).toHaveText("00:05");
  expect(
    (await data(page)).blocks.find((block) => block.id === "clock"),
  ).toMatchObject({ remainingSeconds: 5, endsAt: null });
});

test("uses independent columns at desktop width and a readable stack on narrow screens", async ({
  page,
}, testInfo) => {
  await mount(page);
  const main = page.getByRole("region", { name: "The thought", exact: true });
  const aside = page.getByRole("region", { name: "Bring along", exact: true });
  await expect(page.locator(".canvas-layout")).toHaveAttribute(
    "data-layout",
    "split",
  );
  const mainBox = (await main.boundingBox())!;
  const asideBox = (await aside.boundingBox())!;
  expect(asideBox.x).toBeGreaterThan(mainBox.x + mainBox.width);
  expect(Math.abs(asideBox.y - mainBox.y)).toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("canvas-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(page.locator(".canvas-layout")).toHaveAttribute(
    "data-layout",
    "focus",
  );
  const stackedMain = (await main.boundingBox())!;
  const stackedAside = (await aside.boundingBox())!;
  expect(stackedAside.y).toBeGreaterThan(stackedMain.y + stackedMain.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("canvas-narrow.png"),
    fullPage: true,
  });
});

test("starts blank writing without inserting content or stealing focus and offers an opt-in outline", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    blocks: [
      { ...base, id: "essay", kind: "text", title: "Your essay", body: "" },
    ],
  });
  const writer = page.getByRole("textbox", { name: "Your essay text" });
  await expect(writer).toHaveValue("");
  await expect(writer).toHaveAttribute("placeholder", "Start writing…");
  expect((await writer.boundingBox())!.height).toBeGreaterThanOrEqual(280);
  await expect(page.locator("#outside")).toBeFocused();
  expect(await changeCount(page)).toBe(0);
  await page.getByRole("button", { name: "Make an outline" }).click();
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toEqual([{ type: "outline", value: "essay" }]);
  await writer.fill("I wonder what dogs dream about.");
  expect((await writer.boundingBox())!.height).toBeGreaterThanOrEqual(280);
  await expect(page.getByRole("group", { name: "Writing help" })).toHaveCount(
    0,
  );
  await expect(writer).toBeFocused();
  expect((await data(page)).blocks[0]).toMatchObject({
    body: "I wonder what dogs dream about.",
  });
});

test("adds a deadline with an anchored date editor, validates it, and ticks without writes or focus changes", async ({
  page,
}, testInfo) => {
  // Freeze at the exact boundary before mounting; wall-clock test work must not
  // consume the last second of the displayed hour before explicit fastForward.
  await page.clock.install({ time: new Date("2026-09-20T11:59:59Z") });
  await page.clock.pauseAt(new Date("2026-09-20T12:00:00Z"));
  await mount(page, {
    ...initial,
    blocks: [
      { ...base, id: "essay", kind: "text", title: "Your essay", body: "" },
      {
        ...base,
        id: "due",
        kind: "deadline",
        title: "Essay due",
        placement: "aside",
        dueAt: null,
      },
    ],
  });
  await expect(
    page.getByRole("form", { name: "Set your deadline" }),
  ).toBeVisible();
  await expect(page.locator("#outside")).toBeFocused();
  await expect(page.getByRole("timer")).toHaveText("Your deadline");
  await page.getByRole("button", { name: "Set date", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Choose a valid date and time.",
  );
  expect(await changeCount(page)).toBe(0);
  const local = await page.evaluate(() => {
    const date = new Date(Date.now() + 2 * 86400000 + 3600000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });
  await page.getByLabel("Due date and time", { exact: true }).fill(local);
  await page.screenshot({
    path: testInfo.outputPath("deadline-date-editor.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Set date", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveText("2d 1h");
  const saved = await data(page);
  expect(saved.blocks[1]).toMatchObject({ dueAt: Date.UTC(2026, 8, 22, 13) });
  expect(await changeCount(page)).toBe(1);
  const writer = page.getByRole("textbox", { name: "Your essay text" });
  await writer.focus();
  await page.clock.fastForward(3601000);
  await expect(page.getByRole("timer")).toHaveText("1d 23h");
  await expect(writer).toBeFocused();
  expect(await changeCount(page)).toBe(1);
  await page
    .getByRole("button", { name: "Change due date", exact: true })
    .click();
  await page.getByRole("button", { name: "Clear date", exact: true }).click();
  expect((await data(page)).blocks[1]).toMatchObject({ dueAt: null });
  await expect(
    page.getByLabel("Due date and time", { exact: true }),
  ).toHaveValue("");
  await page.evaluate(
    (value) => (window as unknown as CanvasWindow).setCanvasDocument(value),
    saved,
  );
  await page.clock.fastForward(2 * 86400000);
  await expect(page.getByRole("timer")).toHaveText("Due now");
  expect(await changeCount(page)).toBe(2);
});

test("opens attached video sources through the in-app source callback and offers adding more material", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    blocks: [
      {
        ...base,
        id: "video",
        kind: "sources",
        title: "Watch alongside",
        description: "",
        sourceIds: ["source-video"],
      },
    ],
  });
  await expect(
    page.locator('.canvas-reference-card[data-media="video"]'),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Watch Saved video lesson", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Find or add a source", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toEqual([
    { type: "source", value: "source-video" },
    { type: "add-source" },
  ]);
  expect(await changeCount(page)).toBe(0);
});

test("adding a deadline preserves the live writing node, selection, and native Undo across focus and split", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    layout: "focus",
    blocks: [
      {
        ...base,
        id: "essay",
        kind: "text",
        title: "My essay",
        body: "My own draft.",
      },
    ],
  });
  const writer = page.getByRole("textbox", { name: "My essay text" });
  const originalEditor = await writer.elementHandle();
  await writer.focus();
  await writer.press("End");
  await page.keyboard.insertText(" More thoughts.");
  await expect(writer).toHaveValue("My own draft. More thoughts.");
  await writer.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(3, 7),
  );
  const before = await data(page);
  const withDeadline: CanvasDocument = {
    ...before,
    layout: "split",
    blocks: [
      ...before.blocks,
      {
        ...base,
        id: "due",
        kind: "deadline",
        title: "Essay due",
        placement: "aside",
        dueAt: null,
      },
    ],
  };
  await page.evaluate(
    (next) => (window as unknown as CanvasWindow).setCanvasDocument(next),
    withDeadline,
  );
  await expect(
    page.getByRole("form", { name: "Set your deadline" }),
  ).toBeVisible();
  expect(
    await writer.evaluate(
      (element, original) => element === original,
      originalEditor,
    ),
  ).toBe(true);
  await expect(writer).toBeFocused();
  expect(
    await writer.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([3, 7]);
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue("My own draft.");
  const afterUndo = await data(page);
  await page.evaluate(
    (next) => (window as unknown as CanvasWindow).setCanvasDocument(next),
    {
      ...afterUndo,
      layout: "focus" as const,
      blocks: afterUndo.blocks.filter((block) => block.id !== "due"),
    },
  );
  expect(
    await writer.evaluate(
      (element, original) => element === original,
      originalEditor,
    ),
  ).toBe(true);
  await expect(writer).toBeFocused();
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue("My own draft. More thoughts.");
});

test("the local tool shelf adds useful empty tools and uses only an attached image", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    layout: "focus",
    blocks: [
      {
        ...base,
        id: "essay",
        kind: "text",
        title: "My essay",
        body: "My own draft.",
      },
    ],
  });
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  for (const name of [
    "Add writing",
    "Add checklist",
    "Add table",
    "Add chart",
    "Add key figure",
    "Add design",
    "Add day plan",
    "Add focus timer",
    "Add countdown",
    "Add sources",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  const document = await data(page);
  expect(document.blocks[0]).toMatchObject({
    id: "essay",
    body: "My own draft.",
  });
  expect(document.blocks.slice(1)).toMatchObject([
    { kind: "text", body: "", placement: "main" },
    { kind: "checklist", items: [], placement: "aside" },
    { kind: "table", rows: [], placement: "aside" },
    { kind: "chart", tableId: null, valueColumns: [], placement: "main" },
    { kind: "metric", tableId: null, rowId: null, placement: "aside" },
    { kind: "design", width: 960, height: 640, layers: [], placement: "main" },
    { kind: "timeline", items: [], date: "", placement: "full" },
    {
      kind: "timer",
      durationSeconds: 1500,
      remainingSeconds: 1500,
      endsAt: null,
    },
    { kind: "deadline", dueAt: null },
    { kind: "sources", sourceIds: [], description: "" },
  ]);
  expect(document.layout).toBe("split");
  expect(new Set(document.blocks.map((block) => block.id)).size).toBe(11);
  expect(await changeCount(page)).toBe(10);
  const addImage = page.getByRole("region", { name: "Add to your space", exact: true }).getByRole("button", { name: "Add image", exact: true });
  await addImage.click();
  const chooser = page.getByRole("region", { name: "Choose an image" });
  await expect(chooser).toBeVisible();
  expect(await changeCount(page)).toBe(10);
  await chooser
    .getByRole("button", { name: "The riverside", exact: true })
    .click();
  await expect(chooser).toHaveCount(0);
  await expect(addImage).toBeFocused();
  expect((await data(page)).blocks.at(-1)).toMatchObject({
    kind: "image",
    assetId: "saved-image",
    caption: "",
  });
  expect(
    await page.evaluate(() =>
      (window as unknown as CanvasWindow).canvasEvents.filter(
        (event) => event.type !== "change",
      ),
    ),
  ).toEqual([]);
});

test("keyboard additions in the explicit tool catalogue retain focus without background focus theft", async ({ page }) => {
  await mount(page, {
    ...initial, layout: "focus", blocks: [{ ...base, id: "draft", kind: "text", title: "My draft", body: "Keep this thought." }],
  });
  await expect(page.getByRole("button", { name: "Add checklist", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("button", { name: "Add checklist", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add checklist", exact: true })).toBeFocused();
  expect((await data(page)).blocks.filter(block => block.kind === "checklist")).toHaveLength(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Add table", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add table", exact: true })).toBeFocused();
  expect((await data(page)).blocks.filter(block => block.kind === "table")).toHaveLength(1);

  const writer = page.getByRole("textbox", { name: "My draft text", exact: true });
  await writer.focus();
  const previous = await data(page);
  await page.evaluate(next => (window as unknown as CanvasWindow).setCanvasDocument(next), {
    ...previous, blocks: [...previous.blocks, { ...base, id: "new-day", kind: "timeline" as const, title: "Plan", placement: "full" as const, date: "", startHour: 9, endHour: 18, items: [] }],
  });
  await expect(page.getByRole("button", { name: "Add day plan", exact: true })).toHaveCount(1);
  await expect(writer).toBeFocused();
});

test("arrange and layout controls preserve the actual writing buffer and native Undo across a full-width boundary", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    layout: "split",
    blocks: [
      {
        ...base,
        id: "essay",
        kind: "text",
        title: "My essay",
        body: "My own draft.",
      },
      {
        ...base,
        id: "boundary",
        kind: "text",
        title: "Across the page",
        body: "A full-width thought.",
        placement: "full",
      },
      {
        ...base,
        id: "aside",
        kind: "checklist",
        title: "Next steps",
        items: [],
        placement: "aside",
      },
    ],
  });
  const slot = page.locator('[data-block-id="essay"]');
  const writer = slot.getByRole("textbox", { name: "My essay text" });
  const original = await writer.elementHandle();
  await writer.focus();
  await writer.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" More thoughts.");
  await writer.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(3, 7),
  );
  await slot.getByLabel("Arrange My essay", { exact: true }).click();
  await slot
    .getByRole("combobox", { name: "Position of My essay" })
    .selectOption("aside");
  await slot.getByRole("button", { name: "Move later", exact: true }).click();
  await slot.getByRole("button", { name: "Move later", exact: true }).click();
  expect((await data(page)).blocks.map((block) => block.id)).toEqual([
    "boundary",
    "aside",
    "essay",
  ]);
  await slot
    .getByRole("combobox", { name: "Position of My essay" })
    .selectOption("full");
  await slot.getByLabel("Arrange My essay", { exact: true }).click();
  for (const layout of ["gallery", "page", "beside"]) {
    await page
      .getByRole("button", { name: `Use ${layout} layout`, exact: true })
      .click();
    expect(
      await writer.evaluate(
        (element, previous) => element === previous,
        original,
      ),
    ).toBe(true);
    expect(
      await writer.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([3, 7]);
  }
  expect((await data(page)).blocks.at(-1)).toMatchObject({
    id: "essay",
    placement: "full",
    body: "My own draft. More thoughts.",
  });
  await writer.focus();
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue("My own draft.");
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue("My own draft. More thoughts.");
  expect(
    await page.evaluate(() =>
      (window as unknown as CanvasWindow).canvasEvents.filter(
        (event) => event.type === "undo",
      ),
    ),
  ).toEqual([]);
});

test("incoming gallery, reorder, and full-width changes retain the focused textarea and its selection", async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    blocks: [
      {
        ...base,
        id: "essay",
        kind: "text",
        title: "My essay",
        body: "My own draft.",
      },
      {
        ...base,
        id: "boundary",
        kind: "text",
        title: "Across the page",
        body: "A full-width thought.",
        placement: "full",
      },
      {
        ...base,
        id: "aside",
        kind: "checklist",
        title: "Next steps",
        items: [],
        placement: "aside",
      },
    ],
  });
  const writer = page.getByRole("textbox", { name: "My essay text" });
  const original = await writer.elementHandle();
  await writer.focus();
  await writer.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" Keep this edit.");
  await writer.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(3, 7),
  );
  for (const [layout, placement] of [
    ["gallery", "aside"],
    ["split", "full"],
    ["focus", "main"],
  ] as const) {
    const previous = await data(page);
    const reordered = [...previous.blocks.slice(1), previous.blocks[0]!];
    await page.evaluate(
      (next) => (window as unknown as CanvasWindow).setCanvasDocument(next),
      {
        ...previous,
        layout,
        blocks: reordered.map((block) =>
          block.id === "essay" ? { ...block, placement } : block,
        ),
      },
    );
    await expect(
      page.getByRole("button", {
        name: `Use ${layout === "focus" ? "page" : layout === "split" ? "beside" : "gallery"} layout`,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await writer.evaluate(
        (element, previous) => element === previous,
        original,
      ),
    ).toBe(true);
    await expect(writer).toBeFocused();
    expect(
      await writer.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([3, 7]);
  }
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue("My own draft.");
});

async function expectUncollidedBlocks(page: Page) {
  await expect
    .poll(() =>
      page.locator(".canvas-layout-slot").evaluateAll((nodes) => {
        const rectangles = nodes.map((node) => ({
          id: node.getAttribute("data-block-id"),
          box: node.getBoundingClientRect(),
        }));
        const collisions: string[] = [];
        for (let a = 0; a < rectangles.length; a++)
          for (let b = a + 1; b < rectangles.length; b++) {
            const first = rectangles[a]!,
              second = rectangles[b]!;
            if (
              Math.min(first.box.right, second.box.right) -
                Math.max(first.box.left, second.box.left) >
                1 &&
              Math.min(first.box.bottom, second.box.bottom) -
                Math.max(first.box.top, second.box.top) >
                1
            )
              collisions.push(`${first.id}/${second.id}`);
          }
        return collisions;
      }),
    )
    .toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("reordered blocks keep native buffers while Tab and Chromium accessibility order follow the visual layout", async ({ page }) => {
  const blocks: CanvasDocument["blocks"] = ["First", "Second", "Third"].map((name, index) => ({
    ...base, id: `note-${index}`, kind: "text", title: `${name} note`, body: `${name} editable thought.`,
  }));
  await mount(page, { ...initial, layout: "focus", blocks });
  const firstWriter = page.getByRole("textbox", { name: "First note text", exact: true });
  const original = await firstWriter.elementHandle();
  const expectedNames = ["Third note text", "First note text", "Second note text"];
  const session = await page.context().newCDPSession(page);

  for (const layout of ["focus", "split", "gallery"] as const) {
    await page.evaluate(next => (window as unknown as CanvasWindow).setCanvasDocument(next), {
      ...initial, layout,
      blocks: [blocks[2]!, { ...blocks[0]!, placement: "aside" as const }, blocks[1]!],
    });
    await expectUncollidedBlocks(page);
    expect(await page.locator(".canvas-layout").evaluate(element => getComputedStyle(element).getPropertyValue("reading-flow"))).toBe("grid-rows");
    expect(await firstWriter.evaluate((element, previous) => element === previous, original)).toBe(true);
    const visualOrder = await page.locator(".canvas-layout-slot").evaluateAll(slots => slots
      .map(slot => ({ box: slot.getBoundingClientRect(), name: slot.querySelector("textarea")!.getAttribute("aria-label") }))
      .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
      .map(slot => slot.name));
    expect(visualOrder).toEqual(expectedNames);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    await page.locator("#outside").focus();
    const tabOrder: string[] = [];
    for (let count = 0; count < 40 && tabOrder.length < 3; count++) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.getAttribute("aria-label") : null);
      if (name) tabOrder.push(name);
    }
    expect.soft(tabOrder, `${layout} keyboard order should follow the presented rows`).toEqual(expectedNames);

    const { nodes } = await session.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const accessibilityOrder: string[] = [];
    const visit = (id: string) => {
      const node = byId.get(id);
      if (!node) return;
      if (node.role?.value === "textbox" && expectedNames.includes(String(node.name?.value))) accessibilityOrder.push(String(node.name?.value));
      for (const child of node.childIds ?? []) visit(child);
    };
    visit(nodes[0]!.nodeId);
    expect.soft(accessibilityOrder, `${layout} Chromium accessibility tree should follow the presented rows`).toEqual(expectedNames);
  }
  await session.detach();
});

test("very short panoramic events retain separate reachable targets, including the end of the day", async ({ page }) => {
  await mount(page, {
    ...initial, layout: "focus", blocks: [{
      ...base, id: "short-plan", title: "A few reminders", kind: "timeline", placement: "full", date: "Today", startHour: 0, endHour: 24,
      items: [
        { id: "first", title: "First reminder", startMinutes: 540, endMinutes: 541, status: "planned", detail: "One minute." },
        { id: "second", title: "Second reminder", startMinutes: 541, endMinutes: 542, status: "planned", detail: "The next minute." },
        { id: "last", title: "Final reminder", startMinutes: 1439, endMinutes: 1440, status: "planned", detail: "Before midnight." },
      ],
    }],
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expectUncollidedBlocks(page);
    for (const title of ["First reminder", "Second reminder", "Final reminder"]) {
      const button = page.getByRole("button", { name: `Show ${title}`, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect.poll(() => button.evaluate(element => {
        const box = element.getBoundingClientRect();
        const rail = element.closest(".canvas-day")!.getBoundingClientRect();
        return { width: box.width >= 44, contained: box.left >= rail.left - 1 && box.right <= rail.right + 1,
          center: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === element };
      }), { message: `${title} must have its own pointer target at ${width}px` }).toEqual({ width: true, contained: true, center: true });
      await button.click();
      await expect(page.getByRole("article", { name: title, exact: true })).toBeVisible();
      await expect(button).toHaveAttribute("aria-pressed", "true");
    }
  }
});

test("content growth and viewport changes keep every block separate in page, beside, and gallery layouts", async ({
  page,
}) => {
  await mount(page);
  const writer = page.getByRole("textbox", { name: "The thought text" });
  for (const layout of ["gallery", "beside", "page"]) {
    await page
      .getByRole("button", { name: `Use ${layout} layout`, exact: true })
      .click();
    for (const width of [1280, 820, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await writer.fill(
        Array.from(
          { length: width === 820 ? 22 : 3 },
          (_, index) =>
            `Paragraph ${index + 1}: A thought with room to grow and change.`,
        ).join("\n\n"),
      );
      await expectUncollidedBlocks(page);
      const full = page.locator('[data-block-id="plan"]');
      await expect
        .poll(async () => {
          const layoutBox = (await page
            .locator(".canvas-layout")
            .boundingBox())!;
          const fullBox = (await full.boundingBox())!;
          return Math.abs(fullBox.width - layoutBox.width);
        })
        .toBeLessThan(2);
    }
  }
});

const nextSteps = [
  {
    id: "polish",
    label: "Polish the thought",
    description: "Refine this paragraph when you are ready.",
    request: "Suggest a clearer version of the current paragraph.",
    targetBlockId: "intro",
  },
  {
    id: "budget-help",
    label: "Review the budget",
    description: "Look at the costs together.",
    request: "Review the budget without changing the entered values.",
    targetBlockId: "budget",
  },
  {
    id: "whole",
    label: "Explore another direction",
    description: "Consider what could come next.",
    request: "Suggest another useful direction for this workspace.",
    targetBlockId: null,
  },
];

test("removing a block removes its targeted suggestions while retaining unrelated next steps", async ({
  page,
}) => {
  await mount(page, { ...initial, suggestions: nextSteps });
  const intro = page.getByRole("region", { name: "The thought", exact: true });
  await expect(
    intro.getByRole("button", { name: "Polish the thought", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove The thought block", exact: true })
    .click();
  expect((await data(page)).suggestions).toEqual(nextSteps.slice(1));
  await expect(
    page.getByRole("button", { name: "Polish the thought", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Budget", exact: true })
      .getByRole("button", { name: "Review the budget", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Explore another direction",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as CanvasWindow).canvasEvents.filter(
        (event) => event.type === "suggestion",
      ),
    ),
  ).toEqual([]);
});

test("one deliberate suggestion click dispatches its exact request and pending work prevents another dispatch", async ({
  page,
}) => {
  await mount(page, { ...initial, suggestions: nextSteps });
  await expect(page.locator("#outside")).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Polish the thought", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toEqual([{ type: "suggestion", value: nextSteps[0] }]);
  for (const suggestion of nextSteps)
    await expect(
      page.getByRole("button", { name: suggestion.label, exact: true }),
    ).toBeDisabled();
  await page
    .getByRole("button", { name: "Explore another direction", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  expect(await changeCount(page)).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toHaveLength(1);
  await page.evaluate(() =>
    (window as unknown as CanvasWindow).setCanvasRequestPending(false),
  );
  await expect(
    page.getByRole("button", { name: "Polish the thought", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", {
      name: "Dismiss suggestion: Review the budget",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as CanvasWindow).canvasEvents),
  ).toHaveLength(1);
});
