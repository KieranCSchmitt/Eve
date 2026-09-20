import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasDocument } from "@eve/contracts";

const composition: CanvasDocument = {
  version: 1,
  title: "An invitation taking shape",
  subtitle:
    "A synthetic browser fixture, with a repository image used only for testing.",
  layout: "split",
  blocks: [
    {
      id: "draft",
      kind: "text",
      title: "Words for the invitation",
      placement: "main",
      pinned: false,
      sourceIds: [],
      body: "There is room for a photograph here. Keep the words close while choosing the image.",
    },
    {
      id: "photo-slot",
      kind: "image",
      title: "A photograph to add",
      placement: "aside",
      pinned: true,
      sourceIds: [],
      assetId: null,
      caption: "An afternoon together.",
    },
  ],
};
type Attachment = { pending: boolean; message?: string; needsCheck?: boolean };
type FixtureWindow = Window & {
  mountEmpty(
    document: CanvasDocument,
    mode: "images" | "none" | "broken" | "preview",
  ): void;
  emptyDocument: CanvasDocument;
  emptyChanges: CanvasDocument[];
  attachmentCalls: Array<{ blockId: string; assetId?: string }>;
  cancellationCalls: string[];
  checkCalls: string[];
  setAttachment(value: Attachment): void;
  completeAttachment(): void;
  publishAttachment(): void;
  setEmptyAssetsAvailable(value: boolean): void;
  setEmptyDisabled(value: boolean): void;
};
let script: string, styles: string;
test.beforeAll(async () => {
  const photograph = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import {useState} from 'react';import {createRoot} from 'react-dom/client';
      import {Canvas} from './apps/desktop/renderer/src/components/Canvas';
      import {CanvasSuggestionPreview} from './apps/desktop/renderer/src/components/CanvasSuggestionPreview';
      import {canvasDocumentSchema} from './packages/contracts/src/canvas';
      import {Logo} from './apps/desktop/renderer/src/Logo';
      const asset={id:'photo',taskId:'empty-fixture',title:'River photograph',mediaType:'image/png',byteLength:${photograph.length},url:'data:image/png;base64,${photograph.toString("base64")}',provenance:{kind:'user-import',attribution:'Repository photograph used only as a browser test fixture.',rights:'Test fixture.'}};
      function Fixture({initial,mode}){
        const [document,setDocument]=useState(initial),[attachment,setAttachment]=useState({pending:false}),[disabled,setDisabled]=useState(false),[assetsAvailable,setAssetsAvailable]=useState(mode!=='none');
        window.emptyDocument=document;window.setAttachment=setAttachment;window.setEmptyDisabled=setDisabled;
        const publish=()=>setDocument(current=>{const next={...current,blocks:current.blocks.map(block=>block.id==='photo-slot'?{...block,assetId:'photo',adjustments:null}:block)};canvasDocumentSchema.parse(next);return next});
        const complete=()=>{publish();setAttachment({pending:false})};
        window.completeAttachment=complete;
        window.publishAttachment=publish;window.setEmptyAssetsAvailable=setAssetsAvailable;
        const assets=assetsAvailable?[{...asset,url:mode==='broken'?'http://localhost/broken.png':asset.url}]:[];
        const attach=(blockId,assetId)=>{window.attachmentCalls.push({blockId,assetId});if(assetId)complete();else setAttachment({pending:true,message:'Choosing an image…'})};
        const preview=mode==='preview'?{id:'preview',kind:'canvas',label:'Make room for a photograph',summary:'Add an empty image area.',beforeCanvas:{...initial,blocks:initial.blocks.filter(block=>block.kind!=='image')},canvas:initial,status:'ready',expiresAt:Date.now()+60000}:null;
        return <div className="empty-image-fixture"><header className="shell-header"><button className="brand-button" aria-label="Fixture home"><Logo/><span className="brand-dot"/></button><span className="purpose-name">An invitation</span></header><main className="workspace canvas-workspace">
          <Canvas document={document} assets={assets} disabled={disabled} onChange={next=>{canvasDocumentSchema.parse(next);window.emptyChanges.push(next);setDocument(next)}}
            onAttachImage={attach} imageAttachments={{'photo-slot':attachment}}
            onCancelImageAttachment={id=>{window.cancellationCalls.push(id);setAttachment({pending:false,message:'Attachment cancelled.'})}}
            onCheckImageAttachment={id=>{window.checkCalls.push(id);setAttachment({pending:true,needsCheck:true,message:'Checking the attachment…'})}}
            suggestionPreview={preview?{targetBlockId:null,content:<CanvasSuggestionPreview proposal={preview} assets={assets} sources={[]} onKeep={()=>{throw new Error('Preview must not Keep')}} onDismiss={()=>{}}/>}:undefined}
          /></main></div>
      }
      window.mountEmpty=(initial,mode)=>{canvasDocumentSchema.parse(initial);window.emptyChanges=[];window.attachmentCalls=[];window.cancellationCalls=[];window.checkCalls=[];createRoot(document.getElementById('root')).render(<Fixture initial={initial} mode={mode}/>)};
    `,
    },
    bundle: true,
    write: false,
    outfile: "empty-image-fixture.js",
    format: "iife",
    jsx: "automatic",
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
  styles = `${global}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}\n@font-face{font-family:'Newsreader Variable';font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}body{background:var(--paper)}.empty-image-fixture .purpose-name{margin-left:auto}`;
});
async function mount(
  page: Page,
  mode: "images" | "none" | "broken" | "preview" = "images",
  document = composition,
) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("http://localhost/broken.png", (route) =>
    route.fulfill({ status: 404, body: "Missing" }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ document, mode }) =>
      (window as unknown as FixtureWindow).mountEmpty(document, mode),
    { document, mode },
  );
  await expect(page.getByTestId("canvas")).toBeVisible();
  await settled(page);
}
const slot = (page: Page) => page.locator('[data-canvas-image="photo-slot"]');
const caption = (page: Page) =>
  slot(page).getByRole("textbox", { name: "A photograph to add caption" });
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).attachmentCalls);
async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) => image.decode().catch(() => {})),
    );
    let previous = "",
      stable = 0;
    for (let frame = 0; frame < 100; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const value = JSON.stringify(
        [
          ...document.querySelectorAll(
            ".canvas-layout-slot,.canvas-tool-shelf",
          ),
        ].map((node) => node.getBoundingClientRect().toJSON()),
      );
      stable = value === previous ? stable + 1 : 0;
      previous = value;
      if (stable === 4) return;
    }
    throw new Error("Canvas did not settle");
  });
}

test("an empty image is honest and usable without a provider or any attached image", async ({
  page,
}) => {
  await mount(page, "none");
  await expect(slot(page).locator("[data-empty-image]")).toBeVisible();
  await expect(slot(page)).toContainText("No image attached");
  await expect(slot(page)).not.toContainText("Image unavailable");
  await expect(slot(page).locator("img")).toHaveCount(0);
  await expect(
    slot(page).getByRole("button", { name: "Adjust photo" }),
  ).toHaveCount(0);
  await expect(
    slot(page).getByRole("button", { name: "Import image", exact: true }),
  ).toBeEnabled();
  await expect(
    slot(page).getByRole("button", { name: "Choose existing image" }),
  ).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setEmptyDisabled(true),
  );
  await slot(page)
    .getByRole("button", { name: "Import image", exact: true })
    .press("Enter");
  expect(await calls(page)).toEqual([]);
});

test("a pinned empty slot attaches an existing image without replacing its caption editor or native Undo", async ({
  page,
}) => {
  await mount(page);
  const editor = caption(page),
    original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" Bring a friend.");
  await slot(page)
    .getByRole("button", { name: "Choose existing image" })
    .press("Enter");
  await slot(page)
    .getByRole("button", { name: "Attach River photograph" })
    .click();
  await expect(slot(page).locator("[data-empty-image]")).toHaveCount(0);
  await expect(
    slot(page).locator(".canvas-photo-stage > [data-adjusted-image]"),
  ).toHaveAttribute("data-status", "ready");
  expect(await calls(page)).toEqual([
    { blockId: "photo-slot", assetId: "photo" },
  ]);
  expect(
    await editor.evaluate(
      (element, previous) => element === previous,
      original,
    ),
  ).toBe(true);
  await expect(editor).toHaveValue("An afternoon together. Bring a friend.");
  await editor.focus();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("An afternoon together.");
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).emptyDocument.blocks.find(
        (block) => block.id === "photo-slot",
      ),
    ),
  ).toMatchObject({
    id: "photo-slot",
    pinned: true,
    assetId: "photo",
    caption: "An afternoon together.",
  });
});

test("pending attachment retains its opener, blocks duplicate launches, and leaves writing editable", async ({
  page,
}) => {
  await mount(page);
  const opener = slot(page).getByRole("button", {
    name: "Import image",
    exact: true,
  });
  const original = await opener.elementHandle();
  await opener.focus();
  await opener.press("Enter");
  await opener.press("Enter");
  await expect(opener).toBeFocused();
  await expect(opener).toBeDisabled();
  expect(
    await opener.evaluate((element, prior) => element === prior, original),
  ).toBe(true);
  expect(await calls(page)).toEqual([{ blockId: "photo-slot" }]);
  const writer = page.getByRole("textbox", {
    name: "Words for the invitation text",
  });
  await writer.focus();
  await writer.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" A new detail.");
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).completeAttachment(),
  );
  await expect(writer).toBeFocused();
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue(
    composition.blocks[0].kind === "text" ? composition.blocks[0].body : "",
  );
  await expect(slot(page).locator("[data-empty-image]")).toHaveCount(0);
});

test("a committed attachment awaits managed metadata without flashing a missing-image error and retains receipt checking", async ({
  page,
}) => {
  await mount(page, "none");
  const editor = caption(page),
    original = await editor.elementHandle();
  await slot(page)
    .getByRole("button", { name: "Import image", exact: true })
    .click();
  await editor.focus();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).publishAttachment(),
  );
  await expect(slot(page)).toContainText("Loading your image…");
  await expect(slot(page)).not.toContainText("Image unavailable");
  await expect(slot(page).locator("[data-empty-image]")).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate(
      (element, previous) => element === previous,
      original,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    fixture.setEmptyAssetsAvailable(true);
    fixture.setAttachment({
      pending: false,
      needsCheck: true,
      message: "The image may be saved. Check its result.",
    });
  });
  await expect(
    slot(page).locator(".canvas-photo-stage > [data-adjusted-image]"),
  ).toHaveAttribute("data-status", "ready");
  await expect(
    slot(page).getByRole("button", { name: "Check attachment" }),
  ).toBeVisible();
  await expect(editor).toBeFocused();
  await slot(page).getByRole("button", { name: "Check attachment" }).click();
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).checkCalls),
  ).toEqual(["photo-slot"]);
});

test("cancel and uncertain-receipt checking cannot launch another attachment", async ({
  page,
}) => {
  await mount(page);
  const opener = slot(page).getByRole("button", {
    name: "Import image",
    exact: true,
  });
  await opener.click();
  await slot(page)
    .getByRole("button", { name: "Cancel image attachment" })
    .click();
  await expect(slot(page)).toContainText("Attachment cancelled.");
  await expect(opener).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).cancellationCalls,
    ),
  ).toEqual(["photo-slot"]);
  await opener.focus();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setAttachment({
      pending: false,
      needsCheck: true,
      message: "The attachment may have saved. Check its result.",
    }),
  );
  // This externally supplied receipt commits asynchronously. Existing focus
  // alone cannot prove that the uncertain state is rendered before Enter.
  await expect(slot(page)).toContainText(
    "The attachment may have saved. Check its result.",
  );
  await expect(
    slot(page).getByRole("button", { name: "Check attachment" }),
  ).toBeEnabled();
  await expect(opener).toBeDisabled();
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await slot(page)
    .getByRole("button", { name: "Choose existing image" })
    .press("Enter");
  await expect(
    slot(page).getByRole("group", { name: "Existing images" }),
  ).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
  await slot(page).getByRole("button", { name: "Check attachment" }).click();
  await expect(
    slot(page).getByRole("button", { name: "Check attachment" }),
  ).toBeFocused();
  await expect(
    slot(page).getByRole("button", { name: "Check attachment" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).checkCalls),
  ).toEqual(["photo-slot"]);
  expect(await calls(page)).toHaveLength(1);
});

test("the shelf adds a canonical empty image and still offers existing task images", async ({
  page,
}) => {
  await mount(page, "images", {
    ...composition,
    blocks: composition.blocks.filter((block) => block.kind !== "image"),
  });
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("button", { name: "Add image", exact: true }).click();
  await page
    .getByRole("button", { name: "Add blank image", exact: true })
    .click();
  await expect(page.locator("[data-empty-image]")).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).emptyDocument.blocks.at(-1),
    ),
  ).toMatchObject({
    kind: "image",
    assetId: null,
    caption: "",
    placement: "main",
  });
  expect(await calls(page)).toEqual([]);
  await page.getByRole("button", { name: "Add image", exact: true }).click();
  await page
    .getByRole("region", { name: "Choose an image", exact: true })
    .getByRole("button", { name: "River photograph", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).emptyDocument.blocks.at(-1),
    ),
  ).toMatchObject({ kind: "image", assetId: "photo" });
});

test("empty images in prepared reviews are read-only and distinct from unavailable attachments", async ({
  page,
}) => {
  await mount(page, "preview");
  const preview = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(preview.locator("[data-empty-image]")).not.toHaveCount(0);
  await expect(preview).toContainText("No image attached");
  await expect(preview).not.toContainText("Image unavailable");
  await expect(
    preview.getByRole("button", { name: "Import image" }),
  ).toHaveCount(0);
  await expect(
    preview.getByRole("button", { name: "Adjust photo" }),
  ).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

test("an attached image that fails to load is not presented as an empty slot", async ({
  page,
}) => {
  await mount(page, "broken", {
    ...composition,
    blocks: composition.blocks.map((block) =>
      block.kind === "image" ? { ...block, assetId: "photo" } : block,
    ),
  });
  await expect(slot(page).locator("[data-adjusted-image]")).toHaveAttribute(
    "data-status",
    "unavailable",
  );
  await expect(slot(page).locator("[data-empty-image]")).toHaveCount(0);
  await expect(slot(page)).toContainText("Image unavailable");
});

for (const width of [1280, 390])
  test(`empty and choosing-image compositions remain contained at ${width}px`, async ({
    page,
  }) => {
    const viewport = { width, height: 850 };
    await page.setViewportSize(viewport);
    await mount(page);
    const directory = resolve(".runtime/canvas-empty-image");
    await mkdir(directory, { recursive: true });
    for (const phase of ["empty", "choosing"] as const) {
      if (phase === "choosing")
        await slot(page)
          .getByRole("button", { name: "Choose existing image" })
          .click();
      await settled(page);
      const geometry = await page.evaluate(() => ({
        workspace: [
          ...document.querySelectorAll<HTMLElement>(".workspace"),
        ].every((element) => element.scrollWidth <= element.clientWidth + 1),
        page: document.documentElement.scrollWidth <= innerWidth,
        controls: [
          ...document.querySelectorAll<HTMLElement>(
            "[data-empty-image] button",
          ),
        ].every((button) => {
          const card = button
              .closest("[data-empty-image]")!
              .getBoundingClientRect(),
            rect = button.getBoundingClientRect();
          return rect.left >= card.left && rect.right <= card.right;
        }),
        height: Math.ceil(
          Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          ),
        ),
      }));
      expect(geometry).toMatchObject({
        workspace: true,
        page: true,
        controls: true,
      });
      await page.setViewportSize({
        width,
        height: Math.max(viewport.height, geometry.height),
      });
      await settled(page);
      await page.screenshot({
        path: resolve(directory, `${phase}-${width}.png`),
        fullPage: false,
      });
      await page.setViewportSize(viewport);
      await settled(page);
      await slot(page).scrollIntoViewIfNeeded();
      await settled(page);
      await page.screenshot({
        path: resolve(directory, `${phase}-viewport-${width}.png`),
        fullPage: false,
      });
      await writeFile(
        resolve(directory, `${phase}-${width}-geometry.json`),
        JSON.stringify(
          {
            ...geometry,
            viewport,
            captureMethod:
              "Explicit tall viewport; fullPage:false; restored actual viewport afterward.",
          },
          null,
          2,
        ),
      );
    }
  });
