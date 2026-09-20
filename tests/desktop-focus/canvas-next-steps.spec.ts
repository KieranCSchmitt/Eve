import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasDocument } from "@eve/contracts";
import type { CanvasNextStepsState } from "../../apps/desktop/renderer/src/components/CanvasNextSteps";

type State = {
  state: CanvasNextStepsState;
  message: string;
  pending: boolean;
  disabled: boolean;
  available: boolean;
};
type FixtureWindow = {
  mountNextSteps(document: CanvasDocument): void;
  setNextSteps(state: Partial<State>): void;
  setDocument(document: CanvasDocument): void;
  currentDocument: CanvasDocument;
  calls: { requests: number; cancels: number; choices: number; writes: number };
  originalEditor: HTMLTextAreaElement;
  outlineCalls: number;
};
const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const initial: CanvasDocument = {
  version: 1,
  title: "An afternoon in the open",
  subtitle: "A photograph, a few observations, and room to wander.",
  layout: "split",
  blocks: [
    {
      ...base,
      id: "photo",
      kind: "image",
      title: "Along the river",
      assetId: "river",
      caption: "Light coming through the trees.",
    },
    {
      ...base,
      id: "packing",
      kind: "checklist",
      title: "Before heading out",
      placement: "aside",
      items: [
        { id: "notebook", label: "Pocket notebook", checked: true },
        { id: "water", label: "Water bottle", checked: false },
      ],
    },
    {
      ...base,
      id: "notes",
      kind: "text",
      title: "What I noticed",
      body: "The path widens after the bridge. Leave time to sit by the water.",
    },
  ],
  suggestions: [],
};
const choice = {
  id: "outline",
  label: "Give the notes a little structure",
  description: "Prepare a short outline using the observations already here.",
  request:
    "Prepare an outline for these notes without changing the observations.",
  targetBlockId: "notes",
};
let script: string, styles: string;
test.beforeAll(async () => {
  const photo = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const output = await build({
    stdin: {
      contents: `
      import {useState} from 'react';import {createRoot} from 'react-dom/client';
      import {Canvas} from './apps/desktop/renderer/src/components/Canvas';
      import {canvasDocumentSchema} from './packages/contracts/src/canvas';
      const assets=[{id:'river',taskId:'task',title:'River photograph',mediaType:'image/png',byteLength:${photo.length},url:'data:image/png;base64,${photo.toString("base64")}',provenance:{kind:'user-import',attribution:'Your photograph.',rights:'Your material.'}}];
      function Fixture({initial}){
        const [document,setDocument]=useState(initial);
        const [state,setState]=useState({state:'idle',message:'',pending:false,disabled:false,available:true});
        window.currentDocument=document;window.setDocument=setDocument;
        window.setNextSteps=next=>setState(previous=>({...previous,...next}));
        return <main className='fixture'><Canvas document={document} assets={assets}
          onChange={next=>{canvasDocumentSchema.parse(next);window.calls.writes++;setDocument(next)}}
          onRequestSuggestion={()=>window.calls.choices++}
          onRequestOutline={()=>window.outlineCalls++}
          onRequestNextSteps={state.available?()=>{window.calls.requests++;setState(previous=>({...previous,state:'loading',pending:true,message:''}))}:undefined}
          onCancelNextSteps={()=>{window.calls.cancels++;setState(previous=>({...previous,state:'idle',pending:false,message:'Request cancelled. Your work is unchanged.'}))}}
          nextStepsState={state.state} nextStepsMessage={state.message} requestPending={state.pending} disabled={state.disabled}/></main>
      }
      window.mountNextSteps=document=>{canvasDocumentSchema.parse(document);window.calls={requests:0,cancels:0,choices:0,writes:0};window.outlineCalls=0;createRoot(window.document.getElementById('root')).render(<Fixture initial={document}/>)};
    `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "next-steps.js",
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
  styles = `${global}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}
    @font-face{font-family:'Newsreader Variable';font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}
    @font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}
    .fixture{max-width:1160px;margin:0 auto;padding:40px 28px} @media(max-width:540px){.fixture{padding:25px 18px}}
  `;
});
async function mount(page: Page, document = initial) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (document) => (window as unknown as FixtureWindow).mountNextSteps(document),
    document,
  );
  await expect(
    page.getByRole("region", { name: "Next steps", exact: true }),
  ).toBeVisible();
  await settle(page);
}
async function state(page: Page, value: Partial<State>) {
  await page.evaluate(
    (value) => (window as unknown as FixtureWindow).setNextSteps(value),
    value,
  );
}
const region = (page: Page) =>
  page.getByRole("region", { name: "Next steps", exact: true });
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).calls);
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) => image.decode().catch(() => {})),
    );
    await new Promise<void>((resolve) => {
      let last = "",
        stable = 0;
      const frame = () => {
        const current = JSON.stringify(
          [
            ...document.querySelectorAll(
              ".canvas-layout-slot,.canvas-next-steps,.canvas-tool-shelf",
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
        );
        stable = current === last ? stable + 1 : 0;
        last = current;
        if (stable >= 4) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  });
}

test("the whole-canvas continuation remains available with no choices, exhausted choices, and stale choices", async ({
  page,
}) => {
  await mount(page);
  await expect(
    region(page).getByRole("button", {
      name: "Suggest next steps",
      exact: true,
    }),
  ).toBeEnabled();
  await page.evaluate(
    (document) => (window as unknown as FixtureWindow).setDocument(document),
    { ...initial, suggestions: [choice] },
  );
  await expect(
    page.getByRole("button", { name: choice.label, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: `Dismiss suggestion: ${choice.label}`,
      exact: true,
    })
    .click();
  await expect(region(page)).toBeVisible();
  await page.evaluate(
    (document) => (window as unknown as FixtureWindow).setDocument(document),
    initial,
  );
  await expect(
    page.getByRole("button", { name: "Show hidden suggestion", exact: true }),
  ).toHaveCount(0);
  const original = initial.blocks.find((block) => block.id === "notes")!;
  const stale = {
    ...initial,
    suggestions: [
      {
        ...choice,
        id: "stale",
        prepared: {
          edits: [
            {
              type: "replace" as const,
              block: { ...original, title: "Revised notes" },
            },
          ],
          before: [{ ...original, title: "An earlier heading" }],
        },
      },
    ],
  };
  await page.evaluate(
    (document) => (window as unknown as FixtureWindow).setDocument(document),
    stale,
  );
  await expect(
    page.getByRole("button", { name: choice.label, exact: true }),
  ).toBeDisabled();
  await region(page)
    .getByRole("button", { name: "Suggest next steps", exact: true })
    .click();
  expect(await calls(page)).toEqual({
    requests: 1,
    cancels: 0,
    choices: 0,
    writes: 0,
  });
});

test("explicit activation starts once, preserves keyboard focus and offers cancellation", async ({
  page,
}) => {
  await mount(page);
  const action = region(page).locator(".canvas-next-steps-request");
  await action.focus();
  await action.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(action).toBeDisabled();
  await expect(action).toBeFocused();
  await action.press("Enter");
  expect((await calls(page)).requests).toBe(1);
  await region(page)
    .getByRole("button", { name: "Cancel next steps request", exact: true })
    .click();
  await expect(region(page)).toContainText("Request cancelled");
  await expect(action).toBeEnabled();
  await expect(action).toBeFocused();
  expect(await calls(page)).toEqual({
    requests: 1,
    cancels: 1,
    choices: 0,
    writes: 0,
  });
});

test("outline requests stay mounted and preserve focus while pending, without disabling the writer", async ({
  page,
}) => {
  const blank = {
    ...initial,
    blocks: initial.blocks.map((block) =>
      block.kind === "text" ? { ...block, body: "" } : block,
    ),
  };
  await mount(page, blank);
  const outline = page.getByRole("button", {
    name: "Make an outline",
    exact: true,
  });
  const editor = page.getByRole("textbox", {
    name: "What I noticed text",
    exact: true,
  });
  await outline.focus();
  await state(page, { pending: true });
  await expect(outline).toBeDisabled();
  await expect(outline).toBeFocused();
  await expect(editor).toBeEnabled();
  await outline.press("Enter");
  await outline.evaluate((element) => (element as HTMLButtonElement).click());
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).outlineCalls,
    ),
  ).toBe(0);
  await state(page, { pending: false });
  await expect(outline).toBeEnabled();
  await expect(outline).toBeFocused();
  await outline.press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).outlineCalls,
    ),
  ).toBe(1);
  await state(page, { pending: true });
  await editor.fill("My own thought remains editable.");
  await expect(editor).toHaveValue("My own thought remains editable.");
});

test("honest empty and error outcomes permit another explicit attempt without fabricating choices", async ({
  page,
}) => {
  await mount(page);
  await state(page, { state: "empty" });
  await expect(region(page)).toContainText("No useful next steps were found");
  await expect(
    page.getByRole("region", { name: "Suggested next steps", exact: true }),
  ).toHaveCount(0);
  await state(page, {
    state: "error",
    message: "No qualified provider is configured. Direct controls still work.",
  });
  await expect(region(page)).toContainText("No qualified provider");
  await region(page)
    .getByRole("button", { name: "Try again: suggest next steps", exact: true })
    .click();
  expect((await calls(page)).requests).toBe(1);
  expect((await calls(page)).writes).toBe(0);
});

test("fresh choices and status updates preserve the live editor, selection, scroll and native Undo", async ({
  page,
}) => {
  await mount(page);
  const editor = page.getByRole("textbox", {
    name: "What I noticed text",
    exact: true,
  });
  await editor.focus();
  await editor.press("End");
  await page.keyboard.type(" Watch for reflected light.");
  const edited = await editor.inputValue();
  await editor.evaluate((element) => {
    (window as unknown as FixtureWindow).originalEditor =
      element as HTMLTextAreaElement;
    (element as HTMLTextAreaElement).setSelectionRange(4, 12, "backward");
  });
  // Let textarea auto-sizing, grid measurements and native selection scrolling
  // settle before attributing any later scroll movement to refreshed choices.
  await settle(page);
  const scroll = await page.evaluate(() => scrollY);
  await state(page, { state: "loading", pending: true });
  await page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    fixture.setDocument({
      ...fixture.currentDocument,
      suggestions: [
        {
          id: "new",
          label: "Make room for observations",
          description: "Prepare an empty observation table beside these notes.",
          request:
            "Prepare an empty observation table without changing the notes.",
          targetBlockId: null,
        },
      ],
    });
  });
  await state(page, { state: "ready", pending: false });
  await settle(page);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((element) => ({
      same: element === (window as unknown as FixtureWindow).originalEditor,
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      direction: (element as HTMLTextAreaElement).selectionDirection,
    })),
  ).toEqual({ same: true, start: 4, end: 12, direction: "backward" });
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toHaveValue(edited);
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveValue(edited);
  expect((await calls(page)).requests).toBe(0);
});

test("another request or read-only state blocks every launch without removing the existing content", async ({
  page,
}) => {
  await mount(page, { ...initial, suggestions: [choice] });
  await state(page, { pending: true });
  const action = region(page).locator(".canvas-next-steps-request"),
    card = page.getByRole("button", { name: choice.label, exact: true });
  await expect(action).toBeDisabled();
  await expect(card).toBeDisabled();
  await action.evaluate((element) => (element as HTMLButtonElement).click());
  await card.evaluate((element) => (element as HTMLButtonElement).click());
  await state(page, { pending: false, disabled: true });
  await expect(action).toBeDisabled();
  await action.evaluate((element) => (element as HTMLButtonElement).click());
  expect(await calls(page)).toEqual({
    requests: 0,
    cancels: 0,
    choices: 0,
    writes: 0,
  });
  await expect(
    page.getByRole("textbox", { name: "What I noticed text", exact: true }),
  ).toHaveValue((initial.blocks[2] as { body: string }).body);
  await state(page, { disabled: false, available: false });
  await expect(region(page)).toHaveCount(0);
});

for (const width of [1280, 390])
  test(`the complete canvas and continuation remain contained at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await mount(page);
    await expect(page.locator("[data-canvas-block-id]")).toHaveCount(3);
    await expect(
      region(page).getByRole("button", {
        name: "Suggest next steps",
        exact: true,
      }),
    ).toBeVisible();
    const check = async () =>
      expect(
        await page.evaluate(() => {
          const canvas = document
            .querySelector('[data-testid="canvas"]')!
            .getBoundingClientRect();
          return (
            document.documentElement.scrollWidth <= innerWidth + 1 &&
            [
              ...document.querySelectorAll(
                ".canvas-next-steps,.canvas-next-steps button",
              ),
            ].every((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.left >= canvas.left - 1 && rect.right <= canvas.right + 1
              );
            })
          );
        }),
      ).toBe(true);
    await check();
    const directory = resolve(".runtime/canvas-next-steps");
    await mkdir(directory, { recursive: true });
    const height = await page.evaluate(() =>
      Math.ceil(document.documentElement.scrollHeight),
    );
    await page.setViewportSize({ width, height: Math.max(850, height) });
    await settle(page);
    await page.screenshot({
      path: resolve(directory, `next-steps-${width}.png`),
      fullPage: false,
    });
    await page.setViewportSize({ width, height: 850 });
    await settle(page);
    await region(page).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(directory, `next-steps-viewport-${width}.png`),
      fullPage: false,
    });
    await region(page)
      .getByRole("button", { name: "Suggest next steps", exact: true })
      .click();
    await settle(page);
    await check();
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page
        .locator(".canvas-next-steps-spinner")
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    await page.screenshot({
      path: resolve(directory, `next-steps-loading-${width}.png`),
      fullPage: false,
    });
    expect(await calls(page)).toEqual({
      requests: 1,
      cancels: 0,
      choices: 0,
      writes: 0,
    });
  });
