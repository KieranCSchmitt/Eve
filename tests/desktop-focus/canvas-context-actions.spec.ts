import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CanvasDocument,
  CanvasSuggestionRefreshScope,
} from "@eve/contracts";
import type { CanvasContextSteps } from "../../apps/desktop/renderer/src/components/CanvasContextAction";

const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const text =
  "Follow the river 🌿 before the market opens. Stop where the light meets the old stone bridge. Leave the final turn open until we have walked it.";
const doc: CanvasDocument = {
  version: 1,
  title: "A morning on foot",
  subtitle: "Notice the quiet details along the way.",
  layout: "split",
  blocks: [
    { ...base, id: "route", kind: "text", title: "Walking route", body: text },
    {
      ...base,
      id: "notes",
      kind: "text",
      title: "Things to notice",
      placement: "aside",
      body: "Look for reflections, soft edges, and somewhere to pause.",
    },
    {
      ...base,
      id: "table",
      kind: "table",
      title: "Stops",
      columns: ["Place", "Minutes"],
      rows: [
        { id: "bridge", cells: ["Stone bridge", "10"] },
        { id: "market", cells: ["Market", "=B1+5"] },
      ],
    },
    {
      ...base,
      id: "pin",
      kind: "note",
      title: "A detail to preserve",
      placement: "aside",
      pinned: true,
      description: "The route stays step-free.",
    },
  ],
};
type Win = Window & {
  mountContext(document: CanvasDocument): void;
  setContext(value: CanvasContextSteps | undefined): void;
  setPending(value: boolean): void;
  setDisabled(value: boolean): void;
  setCanvas(document: CanvasDocument): void;
  setPreview(
    choice: NonNullable<CanvasDocument["suggestions"]>[number] | undefined,
  ): void;
  calls: CanvasSuggestionRefreshScope[];
  writes: number;
  cancels: number;
  globals: number;
  choices: number;
  learns: CanvasSuggestionRefreshScope[];
  asks: Array<{ text: string; scope: CanvasSuggestionRefreshScope }>;
  setInsight(
    value: { scope: CanvasSuggestionRefreshScope; message: string } | undefined,
  ): void;
};
let script: string, styles: string;
test.beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `
 import{useState}from'react';import{createRoot}from'react-dom/client';import{Canvas}from'./apps/desktop/renderer/src/components/Canvas';
 window.asks=[];window.calls=[];window.writes=0;window.cancels=0;window.globals=0;window.choices=0;window.learns=[];
 function Fixture({initial}){const[document,setDocument]=useState(initial),[context,setContext]=useState(),[pending,setPending]=useState(false),[disabled,setDisabled]=useState(false),[insight,setInsight]=useState(),[preview,setPreview]=useState();window.setPreview=choice=>setPreview(choice?{suggestion:choice,expiresAt:Date.now()+60000}:undefined);window.setInsight=setInsight;window.setContext=setContext;window.setPending=setPending;window.setDisabled=setDisabled;window.setCanvas=setDocument;return <main className="context-fixture"><Canvas document={document} assets={[]} sources={[]} disabled={disabled} requestPending={pending} onChange={value=>{window.writes++;setDocument(value)}} onAskAboutSelection={(text,scope)=>{window.asks.push({text,scope});setInsight({scope,message:"Considering this passage…"});setPending(true)}} selectionInsight={insight?{scope:insight.scope,content:<section aria-label="About this passage"><p>{insight.message}</p><button onClick={()=>{setInsight(undefined);setPending(false)}}>Close explanation</button></section>}:undefined} onRequestContextSteps={scope=>{window.calls.push(scope);setContext({scope,state:'loading'});setPending(true)}} contextSteps={context} onCancelContextSteps={()=>{window.cancels++;setContext(undefined);setPending(false)}} suggestionPreview={preview?{targetBlockId:preview.suggestion.targetBlockId,readyChoice:preview,content:<section className="canvas-suggestion-preview" aria-label="Suggestion preview">An existing exact change is being reviewed.</section>}:undefined} onRequestSuggestion={()=>window.choices++} onRequestNextSteps={()=>window.globals++} nextStepsState={context?.state} nextStepsMessage={context?.message}/></main>};window.mountContext=document=>createRoot(window.document.getElementById('root')).render(<Fixture initial={document}/>);
 `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    outfile: "context-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const [global, serif, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${global}\n${out.outputFiles.find((f) => f.path.endsWith(".css"))!.text}\n@font-face{font-family:'Newsreader Variable';font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}.context-fixture{max-width:1220px;margin:0 auto;padding:32px}@media(max-width:540px){.context-fixture{padding:20px}}`;
});
async function mount(page: Page, document = doc) {
  await page.route("http://localhost/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (document) => (window as unknown as Win).mountContext(document),
    document,
  );
  await expect(
    page.getByRole("heading", { name: document.title, exact: true }),
  ).toBeVisible();
  await settle(page);
}
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((r) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
    );
  });
}
const writer = (page: Page, name = "Walking route") =>
  page.getByRole("textbox", { name: `${name} text`, exact: true });
const passage = (page: Page) =>
  page.getByRole("textbox", { name: "Ask about selection", exact: true });
async function select(
  page: Page,
  start: number,
  end: number,
  direction: "forward" | "backward" = "forward",
  name = "Walking route",
) {
  const input = writer(page, name);
  await input.focus();
  await input.evaluate(
    (el, { start, end, direction }) => {
      const editor = el as HTMLTextAreaElement;
      editor.setSelectionRange(start, end, direction);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
    },
    { start, end, direction },
  );
  await input.press("Shift");
  await expect(passage(page)).toBeVisible();
  await settle(page);
}
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).calls);

const learns = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).asks);
const group = (page: Page) =>
  page.getByRole("group", { name: "Selected passage actions" });
const scopeFor = (
  body = text,
  start = 0,
  end = 6,
): CanvasSuggestionRefreshScope => ({
  blockId: "route",
  selection: { field: "body", start, end, text: body.slice(start, end) },
});
function withChoice(
  document: CanvasDocument,
  scope = scopeFor(),
): CanvasDocument {
  const original = document.blocks.find((block) => block.id === scope.blockId)!;
  if (original.kind !== "text" || !scope.selection)
    throw new Error("A real text selection is required.");
  return {
    ...document,
    suggestions: [
      {
        id: "selected-choice",
        label: "Review the selected words",
        description: "Consider an alternative for this passage.",
        request: "Review an alternative.",
        targetBlockId: original.id,
        textSelection: scope.selection,
        prepared: {
          before: [original],
          edits: [
            {
              type: "replace",
              block: {
                ...original,
                body:
                  original.body.slice(0, scope.selection.start) +
                  "Notice" +
                  original.body.slice(scope.selection.end),
              },
            },
          ],
        },
      },
      {
        id: "global",
        label: "An unrelated saved direction",
        description: "A broader idea.",
        request: "Review the whole canvas.",
        targetBlockId: null,
      },
    ],
  };
}

const send = (page: Page) =>
  page.getByRole("button", { name: "Send selection request", exact: true });
async function ask(page: Page, question = "What does this mean?") {
  await passage(page).fill(question);
  await send(page).click();
}
async function respond(page: Page, message: string) {
  await page.evaluate((message) => {
    const w = window as unknown as Win;
    w.setInsight({ scope: w.asks.at(-1)!.scope, message });
    w.setPending(false);
  }, message);
  await expect(group(page)).toContainText(message);
}

test("selection immediately offers only a quiet text prompt without inference, preset menus or permanent cards", async ({
  page,
}) => {
  await mount(page, withChoice(doc));
  await expect(passage(page)).toHaveCount(0);
  await select(page, 0, 6);
  await expect(passage(page)).toHaveValue("");
  await expect(writer(page)).toBeFocused();
  await expect(send(page)).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /Learn more|Improve writing|Review writing|Suggest next steps|Generate suggestions/,
    }),
  ).toHaveCount(0);
  await expect(
    page.locator(".canvas-suggestions,.canvas-next-steps"),
  ).toHaveCount(0);
  expect(await learns(page)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Win).writes)).toBe(0);
});

test("typed selection requests preserve exact backward emoji scope and send once while pending", async ({
  page,
}) => {
  await mount(page);
  const editor = await writer(page).elementHandle();
  await select(page, 11, 19, "backward");
  await ask(page, "Explain this 🌿 phrase in one sentence.");
  expect(await learns(page)).toEqual([
    {
      text: "Explain this 🌿 phrase in one sentence.",
      scope: scopeFor(text, 11, 19),
    },
  ]);
  await expect(passage(page)).toBeFocused();
  await expect(send(page)).toBeDisabled();
  await passage(page).press("Enter");
  await send(page).press("Enter");
  expect(await learns(page)).toHaveLength(1);
  await passage(page).fill("A follow-up still in draft");
  await expect(passage(page)).toHaveValue("A follow-up still in draft");
  expect(await writer(page).evaluate((node, old) => node === old, editor)).toBe(
    true,
  );
  expect(
    await writer(page).evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual([11, 19, "backward"]);
  await expect(writer(page)).toHaveValue(text);
  expect(await page.evaluate(() => (window as unknown as Win).writes)).toBe(0);
});

test("keyboard prompt entry, background answer and Escape retain the writer and its native Undo", async ({
  page,
}) => {
  await mount(page);
  const identity = await writer(page).elementHandle();
  await writer(page).focus();
  await writer(page).press("ControlOrMeta+End");
  await page.keyboard.insertText(" One more observation.");
  await select(page, 0, 6, "backward");
  await page.keyboard.press("Tab");
  await expect(passage(page)).toBeFocused();
  await page.keyboard.insertText("Why choose this verb?");
  await passage(page).press("Enter");
  await respond(page, "It invites the reader to follow the route.");
  await expect(passage(page)).toBeFocused();
  await passage(page).press("Escape");
  await expect(writer(page)).toBeFocused();
  await expect(group(page)).toHaveCount(0);
  expect(
    await writer(page).evaluate((node, old) => node === old, identity),
  ).toBe(true);
  expect(
    await writer(page).evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual([0, 6, "backward"]);
  await writer(page).press("ControlOrMeta+z");
  await expect(writer(page)).toHaveValue(text);
});

test("pinned writing still accepts a typed informational question without editing it", async ({
  page,
}) => {
  await mount(page, {
    ...doc,
    blocks: doc.blocks.map((block) =>
      block.id === "route" ? { ...block, pinned: true } : block,
    ),
  });
  await select(page, 0, 6);
  await ask(page, "What is the meaning of this word?");
  expect(await learns(page)).toEqual([
    { text: "What is the meaning of this word?", scope: scopeFor() },
  ]);
  await expect(writer(page)).toHaveValue(text);
  expect(await page.evaluate(() => (window as unknown as Win).writes)).toBe(0);
});

test("IME composition in the prompt does not submit early; composing in the writer retires its old selection", async ({
  page,
}) => {
  await mount(page);
  await select(page, 0, 6);
  await passage(page).fill("Explain this");
  await passage(page).dispatchEvent("compositionstart");
  await passage(page).press("Enter");
  expect(await learns(page)).toEqual([]);
  await passage(page).dispatchEvent("compositionend");
  await passage(page).press("Enter");
  expect(await learns(page)).toHaveLength(1);
  await writer(page).focus();
  await writer(page).dispatchEvent("compositionstart");
  await expect(group(page)).toHaveCount(0);
});

test("Escape cancels IME composition without dismissing the question or losing its captured passage", async ({
  page,
}) => {
  await mount(page);
  await select(page, 11, 19, "backward");
  const editor = await writer(page).elementHandle();
  await passage(page).fill("Explain this phrase");
  const prompt = await passage(page).elementHandle();
  await passage(page).dispatchEvent("compositionstart");
  await passage(page).press("Escape");
  await expect(passage(page)).toBeFocused();
  await expect(passage(page)).toHaveValue("Explain this phrase");
  await passage(page).dispatchEvent("compositionend");
  const defaultPrevented = await passage(page).evaluate((node) => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(defaultPrevented).toBe(false);
  await expect(passage(page)).toHaveValue("Explain this phrase");
  expect(await passage(page).evaluate((node, old) => node === old, prompt)).toBe(
    true,
  );
  expect(await learns(page)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Win).writes)).toBe(0);
  await passage(page).press("Escape");
  await expect(group(page)).toHaveCount(0);
  await expect(writer(page)).toBeFocused();
  expect(await writer(page).evaluate((node, old) => node === old, editor)).toBe(
    true,
  );
  expect(
    await writer(page).evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual([11, 19, "backward"]);
});

test("a changed body invalidates the captured prompt even when its selected substring still exists", async ({
  page,
}) => {
  await mount(page);
  await select(page, 0, 6);
  await passage(page).fill("Explain the opening");
  await page.evaluate(
    (document) => (window as unknown as Win).setCanvas(document),
    {
      ...doc,
      blocks: doc.blocks.map((block) =>
        block.id === "route" && block.kind === "text"
          ? { ...block, body: block.body + " Later revision." }
          : block,
      ),
    },
  );
  await expect(group(page)).toHaveCount(0);
  expect(await learns(page)).toEqual([]);
  await select(page, 0, 6);
  await expect(passage(page)).toHaveValue("");
});

test("unrelated background changes preserve a draft question, captured selection and native input identity", async ({
  page,
}) => {
  await mount(page);
  await select(page, 0, 6);
  await passage(page).fill("Explain this word");
  const nativeInput = await passage(page).elementHandle();
  await page.evaluate(
    (document) => (window as unknown as Win).setCanvas(document),
    { ...doc, subtitle: "An unrelated updated subtitle" },
  );
  await expect(passage(page)).toBeFocused();
  await expect(passage(page)).toHaveValue("Explain this word");
  expect(
    await passage(page).evaluate((node, old) => node === old, nativeInput),
  ).toBe(true);
  await passage(page).press("Enter");
  expect(await learns(page)).toEqual([
    { text: "Explain this word", scope: scopeFor() },
  ]);
});

test("an answer remains at the captured passage after blur without moving another editor or reviving after a new selection", async ({
  page,
}) => {
  await mount(page);
  await select(page, 0, 6);
  await ask(page);
  await writer(page, "Things to notice").focus();
  const scroll = await page.evaluate(() => scrollY);
  await respond(page, "This word describes moving along the route.");
  await expect(writer(page, "Things to notice")).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await expect(group(page)).toContainText("moving along");
  await select(page, 11, 16);
  await expect(group(page)).not.toContainText("moving along");
  await select(page, 0, 6);
  await expect(group(page)).not.toContainText("moving along");
  expect(await learns(page)).toHaveLength(1);
});

test("selection request controls stay truthful during unrelated pending work and read-only changes", async ({
  page,
}) => {
  await mount(page);
  await select(page, 0, 6);
  await passage(page).fill("Explain");
  await page.evaluate(() => (window as unknown as Win).setPending(true));
  await expect(send(page)).toBeDisabled();
  await passage(page).press("Enter");
  expect(await learns(page)).toEqual([]);
  await page.evaluate(() => (window as unknown as Win).setDisabled(true));
  await expect(group(page)).toHaveCount(0);
});

test("table-cell selection does not advertise unsupported passage authority", async ({
  page,
}) => {
  await mount(page);
  const cell = page.locator(".canvas-table input").first();
  await cell.focus();
  await cell.selectText();
  await expect(passage(page)).toHaveCount(0);
  expect(await learns(page)).toEqual([]);
});

test("the answer fits the workspace boundary and a short answer lets wheel input reach its workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await page.addStyleTag({
    content: ".context-fixture{height:500px;overflow:auto}",
  });
  await select(page, 0, 6);
  await ask(page);
  const workspace = page.locator(".context-fixture");
  const before = await workspace.evaluate((node) => node.scrollTop);
  await respond(
    page,
    "A close reading leaves room for uncertainty. ".repeat(24),
  );
  const insight = page.locator(".canvas-context-insight");
  await expect
    .poll(() =>
      insight.evaluate(
        (node) =>
          node.getBoundingClientRect().bottom <=
            node.closest(".context-fixture")!.getBoundingClientRect().bottom -
              7 && node.scrollHeight > node.clientHeight,
      ),
    )
    .toBe(true);
  expect(await workspace.evaluate((node) => node.scrollTop)).toBe(before);
  await insight.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => insight.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await respond(page, "A short answer.");
  await expect
    .poll(() =>
      insight.evaluate((node) => node.scrollHeight <= node.clientHeight),
    )
    .toBe(true);
  const current = await workspace.evaluate((node) => node.scrollTop);
  await insight.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => workspace.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(current);
});

for (const [width, aside] of [
  [1280, false],
  [390, false],
  [1280, true],
] as const)
  test(`a prompt anchors beside the selected upper line in a tall visible editor at ${width}${aside ? " aside" : ""}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    const id = aside ? "notes" : "route",
      name = aside ? "Things to notice" : "Walking route";
    await mount(page, {
      ...doc,
      blocks: doc.blocks.map((block) =>
        block.id === id && block.kind === "text"
          ? { ...block, body: "" }
          : block,
      ),
    });
    await writer(page, name).focus();
    await page.keyboard.insertText(
      "A small detail remains uncertain.\n\nI will return to the path tomorrow.",
    );
    await select(page, 0, 7, "forward", name);
    const editor = (await writer(page, name).boundingBox())!,
      prompt = (await group(page).boundingBox())!;
    expect(editor.height).toBeGreaterThanOrEqual(280);
    expect(prompt.y).toBeGreaterThan(editor.y + 15);
    expect(prompt.y - editor.y).toBeLessThan(65);
    expect(prompt.y + prompt.height).toBeLessThan(
      editor.y + editor.height - 80,
    );
    expect(prompt.x).toBeGreaterThanOrEqual(editor.x - 1);
    expect(prompt.x + prompt.width).toBeLessThanOrEqual(
      editor.x + editor.width + 1,
    );
    await expect(writer(page, name)).toBeFocused();
    expect(await learns(page)).toEqual([]);
    const folder = resolve(".runtime/canvas-selection-prompt");
    await mkdir(folder, { recursive: true });
    const label = `${width}${aside ? "-aside" : ""}`;
    await page.screenshot({
      path: resolve(folder, `prompt-${label}.png`),
      fullPage: false,
    });
    const scroll = await page.evaluate(() => scrollY);
    await passage(page).fill("What does this phrase suggest?");
    await settle(page);
    const focused = (await group(page).boundingBox())!;
    expect(focused.x).toBe(prompt.x);
    expect(focused.y).toBe(prompt.y);
    expect(await writer(page, name).boundingBox()).toEqual(editor);
    await ask(page, "What does this phrase suggest?");
    await respond(
      page,
      "It presents the detail as tentative, without pretending that its meaning is settled.",
    );
    await settle(page);
    await expect(passage(page)).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    const expanded = (await group(page).boundingBox())!;
    expect(expanded.y).toBeGreaterThan(editor.y + 15);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(842);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: resolve(folder, `answer-${label}.png`),
      fullPage: false,
    });
    await writeFile(
      resolve(folder, `geometry-${label}.json`),
      JSON.stringify(
        { editor, prompt, expanded, asks: await learns(page) },
        null,
        2,
      ) + "\n",
    );
    await info.attach(label, {
      path: resolve(folder, `answer-${label}.png`),
      contentType: "image/png",
    });
  });
const pointerBody = "A line above.\nAnother line.\nFinal line.";
const shortDocument: CanvasDocument = {
  ...doc,
  blocks: [
    {
      ...base,
      id: "route",
      kind: "text",
      title: "Walking route",
      body: pointerBody,
    },
  ],
};
const following = (page: Page) =>
  page.getByRole("button", { name: "All tools", exact: true });
const padding = (page: Page) =>
  writer(page).evaluate((node) =>
    parseFloat(getComputedStyle(node.parentElement!).paddingBottom),
  );

test("clicking a following control retains its pointer target through selection-bubble blur", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mount(page, shortDocument);
  await select(page, pointerBody.length - 5, pointerBody.length);
  const control = following(page),
    before = (await control.boundingBox())!;
  expect(await padding(page)).toBeGreaterThan(0);
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  expect((await control.boundingBox())!.y).toBe(before.y);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Fewer tools", exact: true }),
  ).toBeVisible();
  await expect.poll(() => padding(page)).toBe(0);
  expect(await learns(page)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Win).writes)).toBe(0);
});

for (const end of ["cancel", "outside"] as const)
  test(`selection reservation releases on pointer ${end} without activating the following control`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await mount(page, shortDocument);
    await select(page, pointerBody.length - 5, pointerBody.length);
    const control = following(page),
      before = (await control.boundingBox())!;
    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    expect((await control.boundingBox())!.y).toBe(before.y);
    await page.mouse.move(10, 10);
    if (end === "cancel")
      await page.evaluate(() =>
        window.dispatchEvent(
          new PointerEvent("pointercancel", {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
          }),
        ),
      );
    await page.mouse.up();
    await expect.poll(() => padding(page)).toBe(0);
    await expect(control).toBeVisible();
    expect(await learns(page)).toEqual([]);
  });

test.describe("touch selection actions", () => {
  test.use({ hasTouch: true });
  test("a touch tap on a following control survives dismissal of the selection bubble", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await mount(page, shortDocument);
    await select(page, pointerBody.length - 5, pointerBody.length);
    await following(page).tap();
    await expect(
      page.getByRole("button", { name: "Fewer tools", exact: true }),
    ).toBeVisible();
    await expect.poll(() => padding(page)).toBe(0);
    expect(await learns(page)).toEqual([]);
  });
});

test("delayed touch compatibility clicks retain geometry across event-loop turns and nested hit targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mount(page, shortDocument);
  await select(page, pointerBody.length - 5, pointerBody.length);
  const control = following(page),
    before = (await control.boundingBox())!;
  await control.evaluate(async (node) => {
    const button = node as HTMLButtonElement,
      box = button.getBoundingClientRect(),
      init = {
        bubbles: true,
        pointerId: 71,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      };
    button
      .querySelector("svg")!
      .dispatchEvent(new PointerEvent("pointerdown", init));
    button.dispatchEvent(new PointerEvent("pointerup", init));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    button.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    button.focus();
  });
  await expect(group(page)).toHaveCount(0);
  expect((await control.boundingBox())!.y).toBe(before.y);
  await control.evaluate(async (node) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    node.dispatchEvent(
      new PointerEvent("click", {
        bubbles: true,
        pointerId: 71,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
      }),
    );
  });
  await expect(
    page.getByRole("button", { name: "Fewer tools", exact: true }),
  ).toBeVisible();
  await expect.poll(() => padding(page)).toBe(0);
});

test("an absent compatibility click releases reservation on the next keyboard interaction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mount(page, shortDocument);
  await select(page, pointerBody.length - 5, pointerBody.length);
  await following(page).evaluate((node) => {
    const button = node as HTMLButtonElement,
      box = button.getBoundingClientRect(),
      init = {
        bubbles: true,
        pointerId: 72,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      };
    button.dispatchEvent(new PointerEvent("pointerdown", init));
    button.dispatchEvent(new PointerEvent("pointerup", init));
    button.focus();
  });
  await expect(group(page)).toHaveCount(0);
  expect(await padding(page)).toBeGreaterThan(0);
  await page.keyboard.press("Tab");
  await expect.poll(() => padding(page)).toBe(0);
  await expect(following(page)).toBeVisible();
});
