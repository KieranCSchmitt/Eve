import { test, expect, type Page, type Locator } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CanvasBlock,
  CanvasDocument,
  CanvasDesignLayer,
} from "@eve/contracts";

type Design = Extract<CanvasBlock, { kind: "design" }>;
const base = { placement: "main" as const, pinned: false, sourceIds: [] };
// This arbitrary editorial composition is a synthetic browser fixture. The
// repository photograph remains a separate, unmodified attached image asset.
const poster: Design = {
  ...base,
  id: "print",
  kind: "design",
  title: "A field note, in colour",
  width: 900,
  height: 1050,
  background: "#F4F0E7",
  layers: [
    {
      id: "photo",
      kind: "image",
      name: "River photograph",
      x: 330,
      y: 50,
      width: 520,
      height: 760,
      assetId: "river-original",
      fit: "cover",
    },
    {
      id: "title-paper",
      kind: "shape",
      name: "Title paper",
      x: 40,
      y: 135,
      width: 500,
      height: 440,
      shape: "rectangle",
      fill: "#F4F0E7",
    },
    {
      id: "title",
      kind: "text",
      name: "Poster title",
      x: 62,
      y: 180,
      width: 440,
      height: 350,
      text: "After\nthe rain.",
      fontFamily: "serif",
      fontSize: 116,
      fontWeight: "regular",
      color: "#263B3C",
      align: "left",
    },
    {
      id: "edition",
      kind: "text",
      name: "Edition",
      x: 65,
      y: 84,
      width: 220,
      height: 40,
      text: "FIELD NOTES / 04",
      fontFamily: "sans",
      fontSize: 19,
      fontWeight: "medium",
      color: "#263B3C",
      align: "left",
    },
    {
      id: "circle",
      kind: "shape",
      name: "Ochre circle",
      x: 70,
      y: 655,
      width: 150,
      height: 150,
      shape: "ellipse",
      fill: "#C37B43",
    },
    {
      id: "footer",
      kind: "shape",
      name: "Deep green band",
      x: 0,
      y: 865,
      width: 900,
      height: 185,
      shape: "rectangle",
      fill: "#263B3C",
    },
    {
      id: "caption",
      kind: "text",
      name: "Poster caption",
      x: 65,
      y: 904,
      width: 610,
      height: 102,
      text: "A river, a slow afternoon,\nand a new way of looking.",
      fontFamily: "serif",
      fontSize: 35,
      fontWeight: "regular",
      color: "#F4F0E7",
      align: "left",
    },
    {
      id: "folio",
      kind: "text",
      name: "Folio",
      x: 740,
      y: 923,
      width: 100,
      height: 52,
      text: "04",
      fontFamily: "sans",
      fontSize: 31,
      fontWeight: "medium",
      color: "#F4F0E7",
      align: "right",
    },
  ],
};
const composition: CanvasDocument = {
  version: 1,
  title: "Make something worth keeping.",
  subtitle:
    "A small printed field note · illustrative design for browser testing.",
  layout: "split",
  blocks: [
    poster,
    {
      ...base,
      id: "notes",
      kind: "text",
      placement: "aside",
      title: "A little direction",
      body: "Leave the river in the frame. Let the type sit partly on paper, partly in the afternoon.\n\nTry a warm circle against the deep green. Keep the original photograph untouched.",
    },
  ],
};
type FixtureWindow = Window & {
  mountDesign(
    document: CanvasDocument,
    assetMode: "attached" | "missing" | "broken",
  ): void;
  designDocument: CanvasDocument;
  designChanges: CanvasDocument[];
  setDesignDocument(document: CanvasDocument): void;
  setDesignDisabled(disabled: boolean): void;
  designAddMaterialCalls: number;
};
let script: string;
let styles: string;
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(
    runtimeErrors.get(page),
    "The real Canvas must not throw, including strict validation on every edit",
  ).toEqual([]);
});
test.beforeAll(async () => {
  const photograph = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const output = await build({
    stdin: {
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Search } from 'lucide-react';
        import { Canvas } from './apps/desktop/renderer/src/components/Canvas';
        import { Logo } from './apps/desktop/renderer/src/Logo';
        import { canvasDocumentSchema } from './packages/contracts/src/canvas';
        const attached = [{id:'river-original',taskId:'design-fixture',title:'River original',mediaType:'image/png',byteLength:${photograph.length},url:'data:image/png;base64,${photograph.toString("base64")}',provenance:{kind:'user-import',attribution:'Repository photograph used for browser testing.',rights:'Test fixture.'}},
          {id:'document-only',taskId:'design-fixture',title:'Private notes',mediaType:'text/plain',byteLength:12,url:'data:text/plain,fixture-only',provenance:{kind:'user-import',attribution:'Test fixture.',rights:'Test fixture.'}}];
        window.designChanges = []; window.designAddMaterialCalls = 0;
        function Fixture({initial,assetMode}) {
          const [document,setDocument] = useState(initial);
          const [disabled,setDisabled] = useState(false);
          window.designDocument = document;
          window.setDesignDocument = next => {canvasDocumentSchema.parse(next);setDocument(next)};
          window.setDesignDisabled = setDisabled;
          return <div className="design-fixture">
            <header className="shell-header"><button className="brand-button" aria-label="Fixture home"><Logo/><span className="brand-dot"/></button><div className="purpose"><span className="purpose-name">A field note</span></div></header>
            <main className="workspace canvas-workspace"><Canvas document={document} disabled={disabled} assets={assetMode==='missing'?[]:assetMode==='broken'?attached.map(asset=>asset.id==='river-original'?{...asset,url:'http://localhost/broken.png'}:asset):attached} sources={[]}
              onAddMaterial={()=>window.designAddMaterialCalls++}
              onChange={next=>{canvasDocumentSchema.parse(next);window.designChanges.push(next);setDocument(next)}} /></main>
            <footer className="design-fixture-footer"><Search size={16}/>Find anything</footer>
          </div>;
        }
        window.mountDesign = (initial,assetMode) => {canvasDocumentSchema.parse(initial);createRoot(document.getElementById('root')).render(<Fixture initial={initial} assetMode={assetMode}/>)};
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-design-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const [globalStyles, serif, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${globalStyles}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}
    @font-face{font-family:'Newsreader Variable';font-style:normal;font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}
    @font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}
    body{background:var(--paper)}.design-fixture{min-height:100vh}.design-fixture-footer{display:flex;align-items:center;gap:12px;padding:20px 38px;color:var(--muted);font-size:12px}
    @media(max-width:540px){.design-fixture .purpose{display:none}}
  `;
});

async function mount(
  page: Page,
  document = composition,
  assetMode: "attached" | "missing" | "broken" = "attached",
) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ document, assetMode }) =>
      (window as unknown as FixtureWindow).mountDesign(document, assetMode),
    { document, assetMode },
  );
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.evaluate(async () => {
    await window.document.fonts.ready;
    await Promise.all(
      [...window.document.images].map((image) =>
        image.decode().catch(() => {}),
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
const data = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).designDocument);
const changes = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).designChanges);
const design = async (page: Page) =>
  (await data(page)).blocks.find(
    (block): block is Design => block.kind === "design",
  )!;
const layer = async (page: Page, id: string) =>
  (await design(page)).layers.find((layer) => layer.id === id)!;
const block = (page: Page, id = "print") =>
  page.locator(`.canvas-layout-slot[data-block-id="${id}"]`);

async function expectClearGeometry(page: Page) {
  await expect
    .poll(() =>
      page.locator(".canvas-block").evaluateAll((nodes) => {
        const boxes = nodes.map((node) => node.getBoundingClientRect());
        const overlaps: number[][] = [];
        for (let a = 0; a < boxes.length; a++)
          for (let b = a + 1; b < boxes.length; b++) {
            const first = boxes[a]!,
              second = boxes[b]!;
            if (
              Math.min(first.right, second.right) -
                Math.max(first.left, second.left) >
                1 &&
              Math.min(first.bottom, second.bottom) -
                Math.max(first.top, second.top) >
                1
            )
              overlaps.push([a, b]);
          }
        return overlaps;
      }),
    )
    .toEqual([]);
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.scrollWidth > window.innerWidth,
      workspace: [...document.querySelectorAll<HTMLElement>(".workspace")].some(
        (node) => node.scrollWidth > node.clientWidth + 1,
      ),
    })),
  ).toEqual({ viewport: false, workspace: false });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const shelf = document
            .querySelector<HTMLElement>(".canvas-tool-shelf")!
            .getBoundingClientRect();
          return [
            ...document.querySelectorAll<HTMLElement>(
              ".design-inspector:not([hidden])",
            ),
          ]
            .map((node) => {
              const panel = node.getBoundingClientRect();
              const block = node
                .closest<HTMLElement>(".canvas-layout-slot")!
                .getBoundingClientRect();
              return {
                panelBottom: panel.bottom,
                blockBottom: block.bottom,
                shelfTop: shelf.top,
              };
            })
            .filter(
              (box) =>
                box.panelBottom > box.blockBottom + 1 ||
                box.panelBottom > shelf.top - 1,
            );
        }),
      "Visible inspector must be inside its measured block and end before the tool shelf",
    )
    .toEqual([]);
}

/** Full-page CDP capture can transiently resize installed Chrome to 1x1 and
 * snapshot stale ResizeObserver geometry. Capture an explicitly sized surface
 * after layout settles, then restore and inspect the real requested viewport. */
async function stableDesignFrames(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const samples: unknown[] = [];
    let previous = "",
      stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const geometry = {
        width: innerWidth,
        height: innerHeight,
        nodes: [
          ...document.querySelectorAll<HTMLElement>(
            ".canvas-layout,.canvas-layout-slot,.design-surface,.design-sidebar,.design-inspector:not([hidden]),.canvas-tool-shelf",
          ),
        ].map((node) => {
          const box = node.getBoundingClientRect();
          return {
            className: node.className,
            width: box.width,
            height: box.height,
            documentTop: box.top + scrollY,
            gridRow: getComputedStyle(node).gridRow,
          };
        }),
      };
      samples.push(geometry);
      const signature = JSON.stringify(geometry);
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return samples.slice(-4);
    }
    throw new Error(
      "Design layout did not stabilize across consecutive animation frames.",
    );
  });
}
async function captureTallDesign(
  page: Page,
  path: string,
  viewport: { width: number; height: number },
) {
  const original = await stableDesignFrames(page);
  await expectClearGeometry(page);
  const height = await page.evaluate(() =>
    Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      innerHeight,
    ),
  );
  const captureViewport = { width: viewport.width, height: Math.ceil(height) };
  await page.setViewportSize(captureViewport);
  const before = await stableDesignFrames(page);
  await expectClearGeometry(page);
  await page.screenshot({ path, fullPage: false });
  const after = await stableDesignFrames(page);
  expect(after.at(-1)).toEqual(before.at(-1));
  await expectClearGeometry(page);
  await page.setViewportSize(viewport);
  const restored = await stableDesignFrames(page);
  await expectClearGeometry(page);
  expect(restored.at(-1) as { width: number; height: number }).toMatchObject(
    viewport,
  );
  return { captureViewport, original, before, after, restored };
}

const selectedLayer = (page: Page, name: string) =>
  block(page).getByRole("button", {
    name: `Select ${name} layer`,
    exact: true,
  });
async function chooseLayer(page: Page, name: string) {
  const toggle = block(page).getByRole("button", {
    name: "Layers",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await selectedLayer(page, name).click();
}
const inspector = (page: Page, id: string) =>
  block(page).locator(`[data-design-inspector="${id}"]`);
async function editNumber(field: Locator, value: string) {
  await field.fill(value);
  await field.press("Tab");
}

test("Layers starts collapsed, stays keyboard accessible and opens without changing artwork scale or writing", async ({
  page,
}) => {
  await mount(page);
  const local = block(page),
    toggle = local.getByRole("button", { name: "Layers", exact: true });
  const sidebar = local.getByRole("complementary", {
    name: "Design layers and properties",
    includeHidden: true,
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toBeHidden();
  expect(await toggle.getAttribute("aria-controls")).toBe(
    await sidebar.getAttribute("id"),
  );
  await expect(local.locator(".design-inspector textarea")).toHaveCount(4);
  const before = await local.locator("[data-design-stage]").boundingBox();
  await toggle.focus();
  await toggle.press("Enter");
  await expect(sidebar).toBeVisible();
  await stableDesignFrames(page);
  expect(await local.locator("[data-design-stage]").boundingBox()).toEqual(
    before,
  );
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await expect(sidebar).toBeHidden();
  await page.evaluate(
    (document) =>
      (window as unknown as FixtureWindow).setDesignDocument(document),
    { ...composition, subtitle: "A separate background detail changed." },
  );
  await expect(sidebar).toBeHidden();
  await expect(toggle).toBeFocused();
  expect(await changes(page)).toHaveLength(0);
});

test("collapsed layer tools preserve the same native text editor, backward selection and Undo through reopening", async ({
  page,
}) => {
  await mount(page);
  await chooseLayer(page, "Poster title");
  const editor = inspector(page, "title").getByRole("textbox", {
    name: "Poster title text",
    exact: true,
    includeHidden: true,
  });
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" A new observation.");
  await editor.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(2, 9, "backward"),
  );
  const toggle = block(page).getByRole("button", {
    name: "Layers",
    exact: true,
  });
  await toggle.click();
  await expect(editor).toBeHidden();
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  expect(
    await editor.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ];
    }),
  ).toEqual([2, 9, "backward"]);
  const changed = await data(page);
  await page.evaluate(
    (document) =>
      (window as unknown as FixtureWindow).setDesignDocument(document),
    { ...changed, subtitle: "A quiet background update." },
  );
  await expect(editor).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(editor).toBeVisible();
  await expect(toggle).toBeFocused();
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await editor.focus();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("After\nthe rain.");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await expect(toggle).toBeFocused();
});

for (const width of [1280, 390])
  test(`selecting and dragging artwork opens tools without rescaling the gesture at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page);
    const local = block(page),
      mark = local.locator('[data-design-layer-id="circle"]');
    await mark.scrollIntoViewIfNeeded();
    await stableDesignFrames(page);
    const stage = local.locator("[data-design-stage]"),
      oldStage = (await stage.boundingBox())!,
      box = (await mark.boundingBox())!,
      old = await layer(page, "circle");
    const scale = oldStage.width / poster.width;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(
      local.getByRole("button", { name: "Layers", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await stableDesignFrames(page);
    expect((await stage.boundingBox())!.width).toBe(oldStage.width);
    await page.mouse.move(
      box.x + box.width / 2 + 24,
      box.y + box.height / 2 + 12,
      { steps: 4 },
    );
    expect(await changes(page)).toHaveLength(0);
    await page.mouse.up();
    expect(await changes(page)).toHaveLength(1);
    expect(await layer(page, "circle")).toMatchObject({
      x: old.x + Math.round(24 / scale),
      y: old.y + Math.round(12 / scale),
    });
    await expectClearGeometry(page);
  });

test("the local design tool begins blank and adds editable text, a shape, and only attached images", async ({
  page,
}) => {
  await mount(page, { ...composition, blocks: [composition.blocks[1]!] });
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("button", { name: "Add design", exact: true }).click();
  const created = await design(page);
  expect(created.layers).toEqual([]);
  const local = block(page, created.id);
  await local.getByRole("button", { name: "Add text", exact: true }).click();
  const text = (await design(page)).layers[0]!;
  expect(text).toMatchObject({ kind: "text", text: "" });
  await local
    .getByRole("textbox", { name: `${text.name} text`, exact: true })
    .fill("One afternoon");
  await local.getByRole("button", { name: "Add shape", exact: true }).click();
  expect(
    (await design(page)).layers.filter((layer) => layer.kind === "shape"),
  ).toHaveLength(1);
  await local.getByRole("button", { name: "Add image", exact: true }).click();
  const picker = local.getByRole("region", {
    name: "Choose a design image",
    exact: true,
  });
  await expect(
    picker.getByRole("button", { name: "Use River original", exact: true }),
  ).toBeVisible();
  await expect(picker.getByText("Private notes", { exact: true })).toHaveCount(
    0,
  );
  await picker
    .getByRole("button", { name: "Use River original", exact: true })
    .click();
  expect((await design(page)).layers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "One afternoon" }),
      expect.objectContaining({ kind: "image", assetId: "river-original" }),
    ]),
  );
  await expect(local.locator("[data-design-stage] img")).toBeVisible();
});

test("selection, keyboard movement, geometry, text style, image fit, and layer order edit the canonical document", async ({
  page,
}) => {
  await mount(page);
  await chooseLayer(page, "Poster title");
  const title = selectedLayer(page, "Poster title");
  const stageTitle = block(page).getByRole("group", {
    name: "Poster title layer on artboard",
    exact: true,
  });
  await stageTitle.focus();
  await stageTitle.press("ArrowRight");
  await stageTitle.press("Shift+ArrowDown");
  expect(await layer(page, "title")).toMatchObject({ x: 63, y: 190 });
  await title.focus();
  await title.press("ArrowLeft");
  expect(await layer(page, "title")).toMatchObject({ x: 62, y: 190 });
  const settings = inspector(page, "title");
  await editNumber(settings.getByLabel("X position", { exact: true }), "96");
  await editNumber(settings.getByLabel("Y position", { exact: true }), "205");
  await editNumber(settings.getByLabel("Layer width", { exact: true }), "490");
  await editNumber(settings.getByLabel("Layer height", { exact: true }), "365");
  await editNumber(settings.getByLabel("Text size", { exact: true }), "94");
  await settings.getByLabel("Typeface", { exact: true }).selectOption("sans");
  await settings
    .getByLabel("Text weight", { exact: true })
    .selectOption("bold");
  await settings.getByLabel("Text color", { exact: true }).fill("#20324f");
  await settings
    .getByRole("button", { name: "Align text center", exact: true })
    .click();
  expect(await layer(page, "title")).toMatchObject({
    x: 96,
    y: 205,
    width: 490,
    height: 365,
    fontSize: 94,
    fontFamily: "sans",
    fontWeight: "bold",
    color: "#20324f",
    align: "center",
  });
  const oldIndex = (await design(page)).layers.findIndex(
    (layer) => layer.id === "title",
  );
  await settings
    .getByRole("button", { name: "Bring forward", exact: true })
    .click();
  expect(
    (await design(page)).layers.findIndex((layer) => layer.id === "title"),
  ).toBe(oldIndex + 1);
  await settings
    .getByRole("button", { name: "Send backward", exact: true })
    .click();
  expect(
    (await design(page)).layers.findIndex((layer) => layer.id === "title"),
  ).toBe(oldIndex);
  await chooseLayer(page, "River photograph");
  await inspector(page, "photo")
    .getByLabel("Image fit", { exact: true })
    .selectOption("contain");
  expect(await layer(page, "photo")).toMatchObject({
    fit: "contain",
    assetId: "river-original",
  });
  await chooseLayer(page, "Ochre circle");
  await inspector(page, "circle")
    .getByLabel("Fill color", { exact: true })
    .fill("#678e9b");
  expect(await layer(page, "circle")).toMatchObject({ fill: "#678e9b" });
  await inspector(page, "circle")
    .getByRole("button", { name: "Remove layer", exact: true })
    .click();
  expect(
    (await design(page)).layers.some((layer) => layer.id === "circle"),
  ).toBe(false);
});

test("a live native text buffer survives geometry, layer order, canvas layout, and unrelated background updates", async ({
  page,
}) => {
  await mount(page);
  await chooseLayer(page, "Poster title");
  const input = inspector(page, "title").getByRole("textbox", {
    name: "Poster title text",
    exact: true,
  });
  const original = await input.elementHandle();
  await input.focus();
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" Again.");
  await expect(input).toHaveValue("After\nthe rain. Again.");
  const selection = await input.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart,
    element.selectionEnd,
  ]);
  // An accepted update elsewhere in the document may change geometry and order;
  // it must not replace this editor or take its active selection.
  await page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    const next = structuredClone(fixture.designDocument);
    next.layout = "gallery";
    const print = next.blocks.find(
      (block): block is Design => block.kind === "design",
    )!;
    const title = print.layers.find((layer) => layer.id === "title")!;
    title.x = 100;
    title.width = 460;
    print.layers = print.layers
      .filter((layer) => layer.id !== title.id)
      .concat(title);
    next.subtitle = "Updated without interrupting the edit.";
    fixture.setDesignDocument(next);
  });
  expect(
    await input.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual(selection);
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveValue("After\nthe rain.");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue("After\nthe rain. Again.");
  // User-driven controls must preserve that same native undo buffer too.
  await inspector(page, "title")
    .getByRole("button", { name: "Send backward", exact: true })
    .click();
  const stageTitle = block(page).getByRole("group", {
    name: "Poster title layer on artboard",
    exact: true,
  });
  await stageTitle.focus();
  await stageTitle.press("ArrowRight");
  expect(
    await input.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await input.focus();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveValue("After\nthe rain.");
});

test("pointer movement and resize preview locally and each commit only once on release", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mount(page);
  await chooseLayer(page, "Ochre circle");
  await block(page)
    .getByRole("button", { name: "Move Ochre circle layer", exact: true })
    .scrollIntoViewIfNeeded();
  const stage = await block(page).locator("[data-design-stage]").boundingBox();
  const scale = stage!.width / poster.width;
  const initial = await layer(page, "circle");
  const movingLayer = block(page).locator('[data-design-layer-id="circle"]');
  const beforePreview = await movingLayer.boundingBox();
  const count = (await changes(page)).length;
  const move = await block(page)
    .getByRole("button", { name: "Move Ochre circle layer", exact: true })
    .boundingBox();
  await page.mouse.move(move!.x + move!.width / 2, move!.y + move!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    move!.x + move!.width / 2 + 40 * scale,
    move!.y + move!.height / 2 + 25 * scale,
    { steps: 4 },
  );
  expect(await layer(page, "circle")).toEqual(initial);
  expect(await changes(page)).toHaveLength(count);
  const preview = await movingLayer.boundingBox();
  expect(preview!.x - beforePreview!.x).toBeCloseTo(40 * scale, 0);
  expect(preview!.y - beforePreview!.y).toBeCloseTo(25 * scale, 0);
  await page.mouse.up();
  await expect
    .poll(async () => [
      (await layer(page, "circle")).x,
      (await layer(page, "circle")).y,
    ])
    .toEqual([110, 680]);
  expect(await changes(page)).toHaveLength(count + 1);
  const resize = await block(page)
    .getByRole("button", { name: "Resize Ochre circle layer", exact: true })
    .boundingBox();
  await page.mouse.move(
    resize!.x + resize!.width / 2,
    resize!.y + resize!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    resize!.x + resize!.width / 2 + 30 * scale,
    resize!.y + resize!.height / 2 + 20 * scale,
    { steps: 4 },
  );
  expect(await changes(page)).toHaveLength(count + 1);
  await page.mouse.up();
  expect(await changes(page)).toHaveLength(count + 2);
  expect(await layer(page, "circle")).toMatchObject({
    x: 110,
    y: 680,
    width: 180,
    height: 170,
  });
});

test("Escape and a disabled transition cancel active pointer previews without committing or disturbing other work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mount(page);
  await chooseLayer(page, "Ochre circle");
  const initial = await data(page);
  const count = (await changes(page)).length;
  const handle = block(page).getByRole("button", {
    name: "Move Ochre circle layer",
    exact: true,
  });
  for (const reason of ["escape", "disabled"]) {
    await handle.scrollIntoViewIfNeeded();
    const position = () =>
      block(page)
        .locator('[data-design-layer-id="circle"]')
        .evaluate((node: HTMLElement) => [node.style.left, node.style.top]);
    const before = await position();
    const box = await handle.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + box!.width / 2 + 25,
      box!.y + box!.height / 2 + 10,
      { steps: 3 },
    );
    if (reason === "escape") await page.keyboard.press("Escape");
    else
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).setDesignDisabled(true),
      );
    await page.mouse.up();
    expect(await changes(page)).toHaveLength(count);
    expect(await data(page)).toEqual(initial);
    expect(await position()).toEqual(before);
  }
  await expect(
    block(page).getByRole("button", { name: "Add text", exact: true }),
  ).toBeDisabled();
  await expect(
    inspector(page, "circle").getByLabel("X position", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(
    inspector(page, "circle").getByRole("button", {
      name: "Remove layer",
      exact: true,
    }),
  ).toBeDisabled();
});

test("unresolved image layers stay unavailable and cannot cause a remote URL lookup", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await mount(
    page,
    {
      ...composition,
      blocks: [
        {
          ...poster,
          layers: [
            {
              ...poster.layers[0]!,
              id: "missing",
              kind: "image",
              name: "Unattached photograph",
              assetId: "https://outside.invalid/a.jpg",
              fit: "cover",
            } as CanvasDesignLayer,
          ],
        },
        composition.blocks[1]!,
      ],
    },
    "missing",
  );
  expect(requested.some((url) => url.includes("outside.invalid"))).toBe(false);
  await expect(block(page).locator("[data-design-stage] img")).toHaveCount(0);
  await chooseLayer(page, "Unattached photograph");
  await expect(block(page)).toContainText(/not attached|unavailable|missing/i);
  await block(page)
    .getByRole("button", { name: "Add image", exact: true })
    .click();
  await expect(
    block(page).getByRole("button", {
      name: "Use River original",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("geometry stays inside a smaller artboard and layer limits leave existing work editable", async ({
  page,
}) => {
  await mount(page);
  await chooseLayer(page, "Ochre circle");
  const settings = inspector(page, "circle");
  const x = settings.getByLabel("X position", { exact: true });
  await x.fill("80");
  await expect(x).toBeFocused();
  expect(await layer(page, "circle")).toMatchObject({ x: 80 });
  await x.fill("");
  await expect(x).toHaveAttribute("aria-invalid", "true");
  expect(await layer(page, "circle")).toMatchObject({ x: 80 });
  await expect(settings).toContainText("Keeping 80 until this is valid.");
  await x.fill("9999");
  await expect(x).toHaveAttribute("aria-invalid", "true");
  expect(await layer(page, "circle")).toMatchObject({ x: 80 });
  await x.press("Escape");
  await expect(x).toHaveValue("80");
  await expect(x).not.toHaveAttribute("aria-invalid", "true");
  await editNumber(settings.getByLabel("X position", { exact: true }), "9999");
  await editNumber(settings.getByLabel("Y position", { exact: true }), "-100");
  await editNumber(settings.getByLabel("Layer width", { exact: true }), "9999");
  await editNumber(
    settings.getByLabel("Layer height", { exact: true }),
    "9999",
  );
  let current = await design(page);
  const circle = current.layers.find((layer) => layer.id === "circle")!;
  expect(circle.x).toBeGreaterThanOrEqual(0);
  expect(circle.y).toBeGreaterThanOrEqual(0);
  expect(circle.x + circle.width).toBeLessThanOrEqual(current.width);
  expect(circle.y + circle.height).toBeLessThanOrEqual(current.height);
  await block(page).getByText("Artboard settings", { exact: true }).click();
  await editNumber(
    block(page).getByLabel("Artboard width", { exact: true }),
    "240",
  );
  await editNumber(
    block(page).getByLabel("Artboard height", { exact: true }),
    "240",
  );
  await block(page)
    .getByLabel("Artboard background", { exact: true })
    .fill("#e8ece2");
  current = await design(page);
  expect(current).toMatchObject({
    width: 240,
    height: 240,
    background: "#e8ece2",
  });
  for (const layer of current.layers) {
    expect(layer.x + layer.width).toBeLessThanOrEqual(240);
    expect(layer.y + layer.height).toBeLessThanOrEqual(240);
  }
  const full = { ...current, layers: [...current.layers] };
  while (full.layers.length < 24)
    full.layers.push({
      id: `extra-${full.layers.length}`,
      name: "Extra shape",
      kind: "shape",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      shape: "rectangle",
      fill: "#203040",
    });
  const document = await data(page);
  await page.evaluate(
    (document) =>
      (window as unknown as FixtureWindow).setDesignDocument(document),
    {
      ...document,
      blocks: document.blocks.map((block) =>
        block.id === full.id ? full : block,
      ),
    },
  );
  await expect(
    block(page).getByRole("button", { name: "Add text", exact: true }),
  ).toBeDisabled();
  await expect(
    block(page).getByRole("button", { name: "Add shape", exact: true }),
  ).toBeDisabled();
  await expect(
    block(page).getByRole("button", { name: "Add image", exact: true }),
  ).toBeDisabled();
  await settings
    .getByRole("button", { name: "Remove layer", exact: true })
    .click();
  expect((await design(page)).layers).toHaveLength(23);
  await expect(
    block(page).getByRole("button", { name: "Add text", exact: true }),
  ).toBeEnabled();
});

test("an attached image that fails to decode has a truthful fallback without disturbing editable text", async ({
  page,
}) => {
  await page.route("http://localhost/broken.png", (route) => route.abort());
  await mount(page, composition, "broken");
  await expect(
    block(page).locator('[data-design-layer-id="photo"]'),
  ).toContainText("Image unavailable");
  await expect(
    block(page).locator('[data-design-layer-id="photo"] img'),
  ).toHaveCount(0);
  await chooseLayer(page, "Poster title");
  const input = inspector(page, "title").getByRole("textbox", {
    name: "Poster title text",
    exact: true,
  });
  await input.fill("The original is still safe.");
  expect(await layer(page, "photo")).toMatchObject({
    assetId: "river-original",
    fit: "cover",
  });
  expect(await layer(page, "title")).toMatchObject({
    text: "The original is still safe.",
  });
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`an arbitrary layered poster and its editing controls remain usable at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await mount(page);
    await expectClearGeometry(page);
    expect(
      await block(page)
        .locator("[data-design-stage] img")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    ).toBe(true);
    expect(
      await page
        .locator(".canvas-heading h1")
        .evaluate((node) => getComputedStyle(node).fontFamily),
    ).toContain("Newsreader Variable");
    const directory = resolve(".runtime/canvas-design");
    await mkdir(directory, { recursive: true });
    const initialCapture = await captureTallDesign(
      page,
      resolve(directory, `field-note-${viewport.width}.png`),
      viewport,
    );
    await page.screenshot({
      path: resolve(directory, `field-note-viewport-${viewport.width}.png`),
    });
    await chooseLayer(page, "Poster title");
    await expect(
      inspector(page, "title").getByRole("textbox", {
        name: "Poster title text",
        exact: true,
      }),
    ).toBeVisible();
    await expectClearGeometry(page);
    const clipped = await block(page).evaluate((element) => {
      const block = element.getBoundingClientRect();
      return [
        ...element.querySelectorAll<HTMLElement>(
          "input,select,textarea,button",
        ),
      ]
        .filter((node) => node.getClientRects().length)
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.left < block.left - 1 || box.right > block.right + 1;
        })
        .map((node) => node.getAttribute("aria-label") || node.textContent);
    });
    expect(
      clipped,
      "Every visible editor control must fit within its block",
    ).toEqual([]);
    const screenshot = resolve(
      directory,
      `field-note-editing-${viewport.width}.png`,
    );
    const editingCapture = await captureTallDesign(page, screenshot, viewport);
    await inspector(page, "title")
      .getByRole("button", { name: "Remove layer", exact: true })
      .scrollIntoViewIfNeeded();
    const ordinaryScrollFrames = await stableDesignFrames(page);
    await expectClearGeometry(page);
    await page.screenshot({
      path: resolve(
        directory,
        `field-note-inspector-viewport-${viewport.width}.png`,
      ),
      fullPage: false,
    });
    const afterViewportFrames = await stableDesignFrames(page);
    await expectClearGeometry(page);
    await writeFile(
      resolve(directory, `field-note-capture-${viewport.width}.json`),
      JSON.stringify(
        {
          requestedViewport: viewport,
          fullPageMethod:
            "Explicit tall viewport; fullPage:false. Original viewport restored for viewport captures.",
          initialCapture,
          editingCapture,
          ordinaryScrollFrames,
          afterViewportFrames,
        },
        null,
        2,
      ),
    );
    await testInfo.attach(`field-note-editing-${viewport.width}`, {
      path: screenshot,
      contentType: "image/png",
    });
  });
}

test("artboard view changes never write, and native text identity, selection and Undo survive zoom and background changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  await chooseLayer(page, "Poster title");
  const editor = inspector(page, "title").getByRole("textbox", {
    name: "Poster title text",
    exact: true,
  });
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" Together.");
  const count = (await changes(page)).length;
  const selection = await editor.evaluate((node: HTMLTextAreaElement) => [
    node.selectionStart,
    node.selectionEnd,
  ]);
  const artboard = block(page).locator("[data-design-stage]");
  const oldStage = await artboard.elementHandle();
  await block(page)
    .getByRole("button", { name: "View at 100%", exact: true })
    .click();
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("100%");
  expect(await artboard.evaluate((node, old) => node === old, oldStage)).toBe(
    true,
  );
  expect(await editor.evaluate((node, old) => node === old, original)).toBe(
    true,
  );
  expect(await changes(page)).toHaveLength(count);
  await editor.focus();
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual(selection);
  const position = await block(page)
    .locator("[data-design-viewport]")
    .evaluate((node: HTMLElement) => [node.scrollLeft, node.scrollTop]);
  await page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    fixture.setDesignDocument({
      ...fixture.designDocument,
      subtitle: "A background update, while the detail remains open.",
    });
  });
  await expect(editor).toBeFocused();
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("100%");
  expect(
    await block(page)
      .locator("[data-design-viewport]")
      .evaluate((node: HTMLElement) => [node.scrollLeft, node.scrollTop]),
  ).toEqual(position);
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("After\nthe rain.");
  const afterUndo = (await changes(page)).length;
  await block(page)
    .getByRole("button", { name: "Zoom in", exact: true })
    .click();
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("125%");
  await block(page)
    .getByRole("button", { name: "Fit artboard", exact: true })
    .click();
  await expect(
    block(page).getByRole("button", { name: "Fit artboard", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await changes(page)).toHaveLength(afterUndo);
  await editor.focus();
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveValue("After\nthe rain. Together.");
});

test("zoomed drag includes viewport scrolling, resize uses actual scale, and Escape cancels without a write", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mount(page);
  await chooseLayer(page, "Ochre circle");
  await block(page)
    .getByRole("button", { name: "View at 100%", exact: true })
    .click();
  const viewport = block(page).locator("[data-design-viewport]");
  const move = block(page).getByRole("button", {
    name: "Move Ochre circle layer",
    exact: true,
  });
  await move.scrollIntoViewIfNeeded();
  const box = (await move.boundingBox())!;
  const scroll = await viewport.evaluate((node: HTMLElement) => node.scrollTop);
  const count = (await changes(page)).length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 40,
    box.y + box.height / 2 + 25,
    { steps: 3 },
  );
  await viewport.evaluate((node: HTMLElement) => {
    node.scrollTop -= 30;
  });
  await expect
    .poll(() => viewport.evaluate((node: HTMLElement) => node.scrollTop))
    .toBe(scroll - 30);
  await expect(
    block(page).locator('[data-design-layer-id="circle"]'),
  ).toHaveCSS("top", "650px");
  expect(await layer(page, "circle")).toMatchObject({ x: 70, y: 655 });
  expect(await changes(page)).toHaveLength(count);
  await page.mouse.up();
  expect(await layer(page, "circle")).toMatchObject({ x: 110, y: 650 });
  expect(await changes(page)).toHaveLength(count + 1);
  for (let step = 0; step < 3; step++)
    await block(page)
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("200%");
  const resize = block(page).getByRole("button", {
    name: "Resize Ochre circle layer",
    exact: true,
  });
  await resize.scrollIntoViewIfNeeded();
  const handle = (await resize.boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 60,
    handle.y + handle.height / 2 + 40,
    { steps: 3 },
  );
  expect(await changes(page)).toHaveLength(count + 1);
  await page.mouse.up();
  expect(await layer(page, "circle")).toMatchObject({
    width: 180,
    height: 170,
  });
  expect(await changes(page)).toHaveLength(count + 2);
  await move.scrollIntoViewIfNeeded();
  const cancel = (await move.boundingBox())!;
  await page.mouse.move(
    cancel.x + cancel.width / 2,
    cancel.y + cancel.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cancel.x + cancel.width / 2 + 32,
    cancel.y + cancel.height / 2 + 20,
    { steps: 3 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await changes(page)).toHaveLength(count + 2);
  expect(await layer(page, "circle")).toMatchObject({ x: 110, y: 650 });
  const circle = block(page).getByRole("group", {
    name: "Ochre circle layer on artboard",
    exact: true,
  });
  await circle.focus();
  await circle.press("ArrowRight");
  expect(await layer(page, "circle")).toMatchObject({ x: 111 });
});

test("read-only artboards can be inspected without enabling edits, and zoom controls stop at their bounds", async ({
  page,
}) => {
  await mount(page);
  await chooseLayer(page, "Edition");
  const original = await data(page);
  const count = (await changes(page)).length;
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setDesignDisabled(true),
  );
  await block(page)
    .getByRole("button", { name: "View at 100%", exact: true })
    .click();
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("100%");
  for (let step = 0; step < 3; step++)
    await block(page)
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
  const plus = block(page).getByRole("button", {
    name: "Zoom in",
    exact: true,
  });
  await expect(plus).toBeDisabled();
  await plus.focus();
  await plus.press("Enter");
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("200%");
  for (let step = 0; step < 6; step++)
    await block(page)
      .getByRole("button", { name: "Zoom out", exact: true })
      .click();
  await expect(
    block(page).getByRole("button", { name: "Zoom out", exact: true }),
  ).toBeDisabled();
  await expect(block(page).locator("[data-design-zoom]")).toHaveText("25%");
  await block(page)
    .getByRole("button", { name: "Fit artboard", exact: true })
    .click();
  const stage = block(page).getByRole("group", {
    name: "Edition layer on artboard",
    exact: true,
  });
  await stage.focus();
  await stage.press("Shift+ArrowRight");
  await expect(
    inspector(page, "edition").getByRole("textbox", {
      name: "Edition text",
      exact: true,
    }),
  ).toHaveAttribute("readonly", "");
  expect(await data(page)).toEqual(original);
  expect(await changes(page)).toHaveLength(count);
});

for (const width of [1280, 390])
  test(`full-size artwork detail scrolls within its own viewport at ${width}px`, async ({
    page,
  }, testInfo) => {
    const viewportSize = { width, height: 900 };
    await page.setViewportSize(viewportSize);
    await mount(page);
    await chooseLayer(page, "Edition");
    await block(page)
      .getByRole("button", { name: "View at 100%", exact: true })
      .click();
    await stableDesignFrames(page);
    const viewport = block(page).locator("[data-design-viewport]");
    const sizes = await viewport.evaluate((node: HTMLElement) => ({
      width: node.clientWidth,
      height: node.clientHeight,
      contentWidth: node.scrollWidth,
      contentHeight: node.scrollHeight,
    }));
    expect(sizes.contentWidth).toBeGreaterThan(sizes.width);
    expect(sizes.contentHeight).toBeGreaterThan(sizes.height);
    expect(sizes.height).toBeLessThanOrEqual(width === 390 ? 480 : 640);
    expect(
      await block(page)
        .locator("[data-design-stage]")
        .evaluate((node: HTMLElement) => node.getBoundingClientRect().width),
    ).toBeCloseTo(poster.width, 0);
    const textHeight = await block(page)
      .locator('[data-design-layer-id="edition"]')
      .evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    expect(textHeight).toBeCloseTo(40, 0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    expect(await changes(page)).toHaveLength(0);
    await expectClearGeometry(page);
    const directory = resolve(".runtime/canvas-design-zoom");
    await mkdir(directory, { recursive: true });
    await captureTallDesign(
      page,
      resolve(directory, `artboard-100-${width}.png`),
      viewportSize,
    );
    await viewport.scrollIntoViewIfNeeded();
    await stableDesignFrames(page);
    const path = resolve(directory, `artboard-detail-${width}.png`);
    await page.screenshot({ path, fullPage: false });
    await testInfo.attach(`artboard-detail-${width}`, {
      path,
      contentType: "image/png",
    });
    await block(page)
      .getByRole("button", { name: "Fit artboard", exact: true })
      .click();
    await stableDesignFrames(page);
    expect(
      await viewport.evaluate((node: HTMLElement) => [
        node.scrollLeft,
        node.scrollTop,
      ]),
    ).toEqual([0, 0]);
    expect(
      await viewport.evaluate(
        (node: HTMLElement) =>
          node.scrollWidth <= node.clientWidth + 1 &&
          node.scrollHeight <= node.clientHeight + 1,
      ),
    ).toBe(true);
    expect(await changes(page)).toHaveLength(0);
  });
