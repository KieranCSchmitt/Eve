import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasBlock, CanvasDocument } from "@eve/contracts";

type ImageBlock = Extract<CanvasBlock, { kind: "image" }>;
const photo: ImageBlock = {
  id: "photo",
  kind: "image",
  title: "An afternoon by the water",
  placement: "full",
  pinned: false,
  sourceIds: [],
  assetId: "original",
  caption: "A moment worth keeping.",
};
const composition: CanvasDocument = {
  version: 1,
  title: "Light, just as you remember it.",
  subtitle: "Make a few small adjustments. Keep the original close.",
  layout: "focus",
  blocks: [photo],
  suggestions: [],
};
type ImageWindow = Window & {
  mountImage(
    document: CanvasDocument,
    mode: "attached" | "missing" | "broken",
  ): void;
  imageDocument: CanvasDocument;
  imageChanges: CanvasDocument[];
  setImageDocument(document: CanvasDocument): void;
  setImageDisabled(value: boolean): void;
  setImageAssetUrl(url: string): void;
  imageMaterialCalls: number;
};
let script: string, styles: string;
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on("pageerror", (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
test.beforeAll(async () => {
  const photograph = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const built = await build({
    stdin: {
      contents: `
    import {useState} from 'react';import {createRoot} from 'react-dom/client';
    import {Canvas} from './apps/desktop/renderer/src/components/Canvas';
    import {Logo} from './apps/desktop/renderer/src/Logo';
    import {canvasDocumentSchema} from './packages/contracts/src/canvas';
    const original='data:image/png;base64,${photograph.toString("base64")}';
    const asset={id:'original',taskId:'photo-fixture',title:'River photograph',mediaType:'image/png',byteLength:${photograph.length},url:original,provenance:{kind:'user-import',attribution:'Repository photograph used only as browser test data.',rights:'Test fixture.'}};
    window.imageChanges=[];window.imageMaterialCalls=0;
    function Fixture({initial,mode}){
      const [document,setDocument]=useState(initial),[disabled,setDisabled]=useState(false),[url,setUrl]=useState(mode==='broken'?'http://localhost/broken.png':original);
      window.imageDocument=document;window.setImageDocument=next=>{canvasDocumentSchema.parse(next);setDocument(next)};window.setImageDisabled=setDisabled;window.setImageAssetUrl=setUrl;
      return <div className="photo-fixture"><header className="shell-header"><button className="brand-button" aria-label="Fixture home"><Logo/><span className="brand-dot"/></button><div className="purpose"><span className="purpose-name">A saved afternoon</span></div></header><main className="workspace canvas-workspace"><Canvas document={document} assets={mode==='missing'?[]:[{...asset,url}]} disabled={disabled} onAddMaterial={()=>window.imageMaterialCalls++} onChange={next=>{canvasDocumentSchema.parse(next);window.imageChanges.push(next);setDocument(next)}}/></main><footer>Find anything</footer></div>;
    }
    window.mountImage=(initial,mode)=>{canvasDocumentSchema.parse(initial);createRoot(document.getElementById('root')).render(<Fixture initial={initial} mode={mode}/>)};
  `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-image-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = built.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const [global, serif, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${global}\n${built.outputFiles.find((file) => file.path.endsWith(".css"))!.text}\n@font-face{font-family:'Newsreader Variable';font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}body{background:var(--paper)}.photo-fixture footer{padding:18px 38px;color:var(--muted);font-size:12px}.photo-fixture .workspace{overflow:visible}@media(max-width:540px){.photo-fixture .purpose{display:none}}`;
});
async function mount(
  page: Page,
  document = composition,
  mode: "attached" | "missing" | "broken" = "attached",
) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("http://localhost/broken.png", (route) =>
    route.fulfill({ status: 404, body: "Unavailable" }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ document, mode }) =>
      (window as unknown as ImageWindow).mountImage(document, mode),
    { document, mode },
  );
  await expect(page.locator("[data-canvas-image]")).toBeVisible();
  await expect(
    page.locator(
      "[data-canvas-image] > .canvas-photo-mat [data-adjusted-image]",
    ),
  ).toHaveAttribute(
    "data-status",
    mode === "attached" ? "ready" : "unavailable",
  );
  await page.evaluate(async () => {
    await window.document.fonts.ready;
  });
}
const changes = (page: Page) =>
  page.evaluate(() => (window as unknown as ImageWindow).imageChanges);
const image = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as ImageWindow).imageDocument))
    .blocks[0] as ImageBlock;
const adjust = (page: Page) =>
  page.getByRole("button", { name: "Adjust photo", exact: true }).click();
const range = async (page: Page, label: string, value: number) =>
  page.getByRole("slider", { name: label, exact: true }).fill(String(value));
const keep = (page: Page) =>
  page.getByRole("button", { name: "Keep photo adjustments" });
const caption = (page: Page) =>
  page.getByRole("textbox", { name: "An afternoon by the water caption" });

test("local light, colour and straighten previews save exactly once and preserve the original asset and caption", async ({
  page,
}) => {
  await mount(page);
  await adjust(page);
  await expect(keep(page)).toBeDisabled();
  await range(page, "Brightness", 1.25);
  await range(page, "Contrast", 1.1);
  await range(page, "Saturation", 0.85);
  await range(page, "Straighten", 2.5);
  expect(await changes(page)).toHaveLength(0);
  await expect(
    page.locator(".canvas-photo-stage > [data-adjusted-image] img"),
  ).toHaveCSS("filter", "brightness(1.25) contrast(1.1) saturate(0.85)");
  await expect(
    page.getByRole("slider", { name: "Original and preview comparison" }),
  ).toBeVisible();
  await keep(page).click();
  expect(await changes(page)).toHaveLength(1);
  expect(await image(page)).toEqual({
    ...photo,
    adjustments: {
      brightness: 1.25,
      contrast: 1.1,
      saturation: 0.85,
      straighten: 2.5,
      crop: { left: 0, top: 0, right: 1, bottom: 1 },
    },
  });
  await expect(
    page.getByRole("group", { name: "Photo adjustments" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Adjust photo", exact: true }),
  ).toBeFocused();
});

test("Dismiss and Escape remove only the local draft, and reset remains reversible until Keep", async ({
  page,
}) => {
  const initial = {
    ...composition,
    blocks: [
      {
        ...photo,
        adjustments: {
          brightness: 1.2,
          contrast: 1,
          saturation: 0.8,
          straighten: 2,
          crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
        },
      },
    ],
  };
  await mount(page, initial);
  await adjust(page);
  await range(page, "Brightness", 1.5);
  await page.getByRole("button", { name: "Dismiss photo adjustments" }).click();
  expect(await changes(page)).toHaveLength(0);
  expect(await image(page)).toEqual(initial.blocks[0]);
  await adjust(page);
  await page.getByRole("button", { name: "Reset adjustments" }).click();
  expect(await changes(page)).toHaveLength(0);
  await keep(page).click();
  expect((await image(page)).adjustments).toBeNull();
  expect(await changes(page)).toHaveLength(1);
  await adjust(page);
  await range(page, "Brightness", 1.4);
  await page
    .getByRole("slider", { name: "Brightness", exact: true })
    .press("Escape");
  expect(await changes(page)).toHaveLength(1);
  await expect(
    page.getByRole("group", { name: "Photo adjustments" }),
  ).toHaveCount(0);
});

test("comparison is keyboard and pointer operable and works read-only without saved writes", async ({
  page,
}) => {
  await mount(page, {
    ...composition,
    blocks: [
      {
        ...photo,
        adjustments: {
          brightness: 1.2,
          contrast: 1,
          saturation: 1,
          straighten: 0,
          crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 },
        },
      },
    ],
  });
  await page.evaluate(() =>
    (window as unknown as ImageWindow).setImageDisabled(true),
  );
  await expect(
    page.getByRole("button", { name: "Adjust photo", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Compare original" }).click();
  const slider = page.getByRole("slider", {
    name: "Original and preview comparison",
  });
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "51");
  await slider.press("Shift+ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuenow", "41");
  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuenow", "100");
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await page.mouse.up();
  await expect(slider).toHaveAttribute("aria-valuenow", "25");
  expect(await changes(page)).toHaveLength(0);
  await expect(caption(page)).toBeDisabled();
});

test("direct crop move, resize and cancelled gestures preserve valid normalized bounds with no writes until Keep", async ({
  page,
}) => {
  await mount(page);
  await adjust(page);
  await page.getByRole("button", { name: "Crop", exact: true }).click();
  await page.getByRole("button", { name: "Square", exact: true }).click();
  const before = await page.locator("[data-photo-crop]").boundingBox(),
    stage = (await page.locator("[data-photo-stage]").boundingBox())!;
  const move = page.getByRole("button", { name: "Move crop area" });
  await move.focus();
  await move.press("ArrowRight");
  expect(
    Number(
      await page
        .getByRole("spinbutton", { name: "Crop left percent" })
        .inputValue(),
    ),
  ).toBeGreaterThan(0);
  const edge = page.getByRole("spinbutton", { name: "Crop right percent" });
  const previous = await edge.inputValue();
  const resize = page.getByRole("button", { name: "Resize crop area" });
  await resize.scrollIntoViewIfNeeded();
  const corner = (await resize.boundingBox())!;
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    corner.x + corner.width / 2 - stage.width * 0.08,
    corner.y + corner.height / 2 - stage.height * 0.08,
  );
  expect(Number(await edge.inputValue())).toBeLessThan(Number(previous));
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(edge).toHaveValue(previous);
  await resize.focus();
  await resize.press("ArrowLeft");
  await resize.press("ArrowUp");
  expect(await changes(page)).toHaveLength(0);
  await page
    .getByRole("spinbutton", { name: "Crop left percent" })
    .fill("-100");
  await page
    .getByRole("spinbutton", { name: "Crop bottom percent" })
    .fill("999");
  await keep(page).click();
  const adjusted = (await image(page)).adjustments!;
  expect(adjusted.crop.left).toBe(0);
  expect(adjusted.crop.bottom).toBe(1);
  expect(adjusted.crop.right - adjusted.crop.left).toBeGreaterThanOrEqual(0.05);
  expect(await changes(page)).toHaveLength(1);
  expect(before?.width).toBeGreaterThan(0);
});

for (const mode of ["Move crop area", "Resize crop area"] as const)
  test(`losing pointer capture cancels ${mode.toLowerCase()} without leaving a hover gesture`, async ({
    page,
  }) => {
    await mount(page);
    await adjust(page);
    await page.getByRole("button", { name: "Crop", exact: true }).click();
    await page.getByRole("button", { name: "Square", exact: true }).click();
    const handle = page.getByRole("button", { name: mode, exact: true });
    await handle.scrollIntoViewIfNeeded();
    await handle.evaluate((element) =>
      element.addEventListener(
        "pointerdown",
        (event) => {
          (window as any).cropPointerId = (event as PointerEvent).pointerId;
        },
        { once: true },
      ),
    );
    const initial = await page
      .locator("[data-photo-crop]")
      .getAttribute("style");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + (mode === "Move crop area" ? 25 : -25),
      box.y + box.height / 2 - 15,
    );
    expect(
      await page.locator("[data-photo-crop]").getAttribute("style"),
    ).not.toBe(initial);
    await handle.evaluate((element) =>
      element.releasePointerCapture((window as any).cropPointerId),
    );
    await page.mouse.move(4, 4);
    await page.mouse.up();
    await expect(page.locator("[data-photo-crop]")).toHaveAttribute(
      "style",
      initial!,
    );
    const restored = (await handle.boundingBox())!;
    await page.mouse.move(
      restored.x + restored.width / 2,
      restored.y + restored.height / 2,
    );
    await expect(page.locator("[data-photo-crop]")).toHaveAttribute(
      "style",
      initial!,
    );
    await page.getByRole("slider", { name: "Brightness", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("group", { name: "Photo adjustments" }),
    ).toHaveCount(0);
    expect(await changes(page)).toHaveLength(0);
  });

test("fractional saved crop edges retain exact minimum spans through numeric and resize clamps", async ({
  page,
}) => {
  const crop = { left: 0.12351, top: 0.234567, right: 0.5, bottom: 0.8 };
  await mount(page, {
    ...composition,
    blocks: [
      {
        ...photo,
        adjustments: {
          brightness: 1,
          contrast: 1,
          saturation: 1,
          straighten: 0,
          crop,
        },
      },
    ],
  });
  await adjust(page);
  await page.getByRole("button", { name: "Crop", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Crop right percent" }).fill("0");
  await page.getByRole("spinbutton", { name: "Crop bottom percent" }).fill("0");
  await expect(
    page.getByRole("group", { name: "Photo adjustments" }),
  ).toBeVisible();
  await expect(
    page.locator(".canvas-photo-stage > [data-adjusted-image]"),
  ).toHaveAttribute("data-status", "ready");
  const handle = page.getByRole("button", { name: "Resize crop area" });
  await handle.focus();
  await handle.press("ArrowLeft");
  await handle.press("ArrowUp");
  expect(await changes(page)).toHaveLength(0);
  await keep(page).click();
  expect((await image(page)).adjustments!.crop).toEqual({
    ...crop,
    right: crop.left + 0.05,
    bottom: crop.top + 0.05,
  });
  expect(await changes(page)).toHaveLength(1);
});

for (const mode of ["block", "asset", "disabled"] as const)
  test(`a ${mode} change invalidates a draft without overwriting newer data or moving focus`, async ({
    page,
  }) => {
    await mount(page);
    await adjust(page);
    await range(page, "Brightness", 1.5);
    await caption(page).focus();
    await page.evaluate((mode) => {
      const win = window as unknown as ImageWindow;
      if (mode === "block")
        win.setImageDocument({
          ...win.imageDocument,
          blocks: win.imageDocument.blocks.map((block) => ({
            ...block,
            title: "Newer title",
          })),
        });
      else if (mode === "asset")
        win.setImageAssetUrl("http://localhost/broken.png");
      else win.setImageDisabled(true);
    }, mode);
    await expect(
      page.getByRole("group", { name: "Photo adjustments" }),
    ).toHaveCount(0);
    expect(await changes(page)).toHaveLength(0);
    expect((await image(page)).adjustments).toBeUndefined();
    await expect(
      page.getByRole("status").filter({ hasText: "unsaved preview" }),
    ).toBeVisible();
    if (mode !== "disabled")
      await expect(
        page.locator(".canvas-photo figcaption textarea"),
      ).toBeFocused();
  });

test("caption editor identity, selection and native Undo survive adjustment view changes and background layout", async ({
  page,
}) => {
  await mount(page);
  const input = caption(page);
  await input.focus();
  await input.evaluate((element) => {
    const editor = element as HTMLTextAreaElement;
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });
  await page.keyboard.insertText(" Remember.");
  await input.evaluate((element) => {
    (window as any).savedCaption = element;
    (element as HTMLTextAreaElement).setSelectionRange(2, 9);
  });
  await adjust(page);
  await range(page, "Contrast", 1.2);
  await page.getByRole("button", { name: "Dismiss photo adjustments" }).click();
  await page.evaluate(() => {
    const win = window as unknown as ImageWindow;
    win.setImageDocument({ ...win.imageDocument, layout: "gallery" });
  });
  expect(
    await input.evaluate((element) => element === (window as any).savedCaption),
  ).toBe(true);
  expect(
    await input.evaluate((element) => {
      const editor = element as HTMLTextAreaElement;
      return [editor.selectionStart, editor.selectionEnd];
    }),
  ).toEqual([2, 9]);
  await input.focus();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveValue(photo.caption);
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue(photo.caption + " Remember.");
});

for (const mode of ["missing", "broken"] as const)
  test(`${mode} managed originals show an honest fallback and cannot be adjusted`, async ({
    page,
  }) => {
    await mount(page, composition, mode);
    await expect(
      page.getByText("Image unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Adjust photo", exact: true }),
    ).toBeDisabled();
    await page
      .locator("[data-canvas-image]")
      .getByRole("button", { name: "Add material", exact: true })
      .click();
    expect(
      await page.evaluate(
        () => (window as unknown as ImageWindow).imageMaterialCalls,
      ),
    ).toBe(1);
    expect(await changes(page)).toHaveLength(0);
  });

async function settled(page: Page) {
  await page.evaluate(async () => {
    await window.document.fonts.ready;
    await new Promise<void>((resolve) => {
      let old = "",
        same = 0;
      const frame = () => {
        const photo = window.document
            .querySelector("[data-canvas-image]")!
            .getBoundingClientRect(),
          slot = window.document
            .querySelector(".canvas-layout-slot")!
            .getBoundingClientRect();
        const next = JSON.stringify([
          innerWidth,
          innerHeight,
          photo.width,
          photo.height,
          slot.height,
        ]);
        same = next === old ? same + 1 : 0;
        old = next;
        if (same >= 5) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  });
}
for (const width of [1280, 390])
  test(`photo preview remains readable and contained at ${width}px`, async ({
    page,
  }) => {
    const viewport = { width, height: 800 };
    await page.setViewportSize(viewport);
    await mount(page);
    await adjust(page);
    await range(page, "Brightness", 1.14);
    await range(page, "Straighten", 1.8);
    await settled(page);
    const geometry = await page
      .locator("[data-canvas-image]")
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const frame = element
          .querySelector(".canvas-photo-mat")!
          .getBoundingClientRect();
        const stage = element
          .querySelector("[data-photo-stage]")!
          .getBoundingClientRect();
        const controls = element
          .querySelector(".canvas-photo-controls")!
          .getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          sideMattes: Math.abs(frame.width - stage.width) > 1,
          misalignedControls:
            Math.abs(controls.left - stage.left) > 1 ||
            Math.abs(controls.right - stage.right) > 1,
          clipped: [...element.querySelectorAll("button,input,textarea")].some(
            (node) => {
              const box = node.getBoundingClientRect();
              return (
                box.width > 0 &&
                (box.left < rect.left - 1 || box.right > rect.right + 1)
              );
            },
          ),
        };
      });
    expect(geometry).toEqual({
      overflow: false,
      clipped: false,
      sideMattes: false,
      misalignedControls: false,
    });
    const folder = resolve(".runtime/canvas-image");
    await mkdir(folder, { recursive: true });
    await page.screenshot({
      path: resolve(folder, `photo-preview-viewport-${width}.png`),
      fullPage: false,
    });
    const height = await page.evaluate(() =>
      Math.ceil(document.documentElement.scrollHeight),
    );
    await page.setViewportSize({ width, height: Math.max(800, height) });
    await settled(page);
    await page.screenshot({
      path: resolve(folder, `photo-preview-${width}.png`),
      fullPage: false,
    });
    await writeFile(
      resolve(folder, `photo-preview-${width}.json`),
      JSON.stringify(
        {
          method: "explicit tall viewport; fullPage:false",
          original: viewport,
          capture: { width, height: Math.max(800, height) },
        },
        null,
        2,
      ),
    );
    await page.setViewportSize(viewport);
    await settled(page);
    expect(await changes(page)).toHaveLength(0);
  });
