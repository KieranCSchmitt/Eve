import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CanvasBlock,
  CanvasDocument,
  CanvasSuggestion,
} from "@eve/contracts";
import type { IntentProposal } from "../../apps/desktop/shared/bridge";

const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const table: Extract<CanvasBlock, { kind: "table" }> = {
  ...base,
  id: "table",
  kind: "table",
  title: "Materials",
  columns: ["Material", "Cost"],
  rows: [
    { id: "r1", cells: ["Clay", "20"] },
    { id: "r2", cells: ["Glaze", "0"] },
    { id: "r3", cells: ["Not quoted", ""] },
    { id: "r4", cells: ["Estimate", "=B1+5"] },
  ],
};
const design: Extract<CanvasBlock, { kind: "design" }> = {
  ...base,
  id: "design",
  kind: "design",
  title: "An afternoon invitation",
  width: 800,
  height: 720,
  background: "#F1EBDF",
  layers: [
    {
      id: "photo",
      kind: "image",
      name: "River",
      x: 0,
      y: 0,
      width: 480,
      height: 720,
      assetId: "river",
      fit: "cover",
    },
    {
      id: "paper",
      kind: "shape",
      name: "Quiet paper",
      x: 365,
      y: 0,
      width: 435,
      height: 720,
      shape: "rectangle",
      fill: "#F1EBDF",
    },
    {
      id: "circle",
      kind: "shape",
      name: "Ochre circle",
      x: 310,
      y: 62,
      width: 190,
      height: 190,
      shape: "ellipse",
      fill: "#D7BD93",
    },
    {
      id: "heading",
      kind: "text",
      name: "Title",
      x: 410,
      y: 310,
      width: 345,
      height: 200,
      text: "A slower\nafternoon.",
      fontFamily: "serif",
      fontSize: 55,
      fontWeight: "regular",
      color: "#2A4140",
      align: "left",
    },
    {
      id: "time",
      kind: "text",
      name: "Time",
      x: 410,
      y: 565,
      width: 345,
      height: 90,
      text: "Saturday · 11 AM",
      fontFamily: "sans",
      fontSize: 23,
      fontWeight: "medium",
      color: "#2A4140",
      align: "left",
    },
  ],
};
const before: CanvasDocument = {
  version: 1,
  title: "An afternoon in the studio",
  subtitle: "A browser fixture with real registered content.",
  layout: "split",
  blocks: [
    {
      ...base,
      id: "text",
      kind: "text",
      title: "Invitation copy",
      body: "Meet at eleven for a quiet afternoon by the river.",
    },
    {
      ...base,
      id: "checklist",
      kind: "checklist",
      title: "Bring along",
      items: [{ id: "c1", label: "A sketchbook", checked: false }],
    },
    table,
    {
      ...base,
      id: "chart",
      kind: "chart",
      title: "Material costs",
      tableId: "table",
      chartType: "line",
      labelColumn: 0,
      valueColumns: [1],
    },
    {
      ...base,
      id: "metric",
      kind: "metric",
      title: "Clay cost",
      tableId: "table",
      rowId: "r1",
      column: 1,
      prefix: "$",
      suffix: "",
      decimals: 1,
    },
    {
      ...base,
      id: "timeline",
      kind: "timeline",
      title: "The afternoon",
      date: "Saturday",
      startHour: 9,
      endHour: 17,
      items: [
        {
          id: "event",
          title: "Meet by the river",
          startMinutes: 660,
          endMinutes: 690,
          detail: "Bring your sketchbook.",
          status: "planned",
        },
      ],
    },
    {
      ...base,
      id: "image",
      kind: "image",
      title: "River photograph",
      assetId: "river",
      caption: "Original photograph, kept intact.",
    },
    design,
    {
      ...base,
      id: "timer",
      kind: "timer",
      title: "Sketching time",
      durationSeconds: 480,
      remainingSeconds: 480,
      endsAt: null,
    },
    {
      ...base,
      id: "deadline",
      kind: "deadline",
      title: "Print by",
      dueAt: 4090978800000,
    },
    {
      ...base,
      id: "sources",
      kind: "sources",
      title: "References",
      description: "Notes from the studio.",
      sourceIds: ["reference"],
    },
    {
      ...base,
      id: "note",
      kind: "note",
      title: "A note",
      description: "Leave room to think.",
    },
  ],
};
const after: CanvasDocument = {
  ...before,
  blocks: before.blocks.map((block) => {
    switch (block.kind) {
      case "text":
        return {
          ...block,
          body: "Meet at ten for a quiet afternoon by the river.",
        };
      case "checklist":
        return {
          ...block,
          items: [
            ...block.items,
            { id: "c2", label: "Your favourite pencil", checked: false },
          ],
        };
      case "table":
        return {
          ...block,
          rows: block.rows.map((row) =>
            row.id === "r1" ? { ...row, cells: ["Clay", "30"] } : row,
          ),
        };
      case "chart":
      case "metric":
        return block;
      case "timeline":
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            startMinutes: 600,
            endMinutes: 630,
          })),
        };
      case "image":
        return {
          ...block,
          adjustments: {
            brightness: 1.18,
            contrast: 1.06,
            saturation: 0.85,
            straighten: 3,
            crop: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.95 },
          },
          caption:
            "River light for the invitation. Original photograph kept intact.",
        };
      case "design":
        return {
          ...block,
          layers: block.layers.map((layer) =>
            layer.kind === "text" && layer.id === "time"
              ? { ...layer, text: "Saturday · 10 AM" }
              : layer,
          ),
        };
      case "timer":
        return { ...block, durationSeconds: 600, remainingSeconds: 600 };
      case "deadline":
        return { ...block, dueAt: 4090975200000 };
      case "sources":
        return {
          ...block,
          description: "Notes and material costs from the studio.",
        };
      case "note":
        return {
          ...block,
          description: "Leave room to think, and room to begin.",
        };
    }
  }),
};
const proposal: IntentProposal = {
  id: "prepared",
  kind: "canvas",
  label: "A little earlier, with room to sketch",
  summary: "Review the invitation, schedule, and studio details together.",
  status: "ready",
  expiresAt: 4102444800000,
  beforeCanvas: before,
  canvas: after,
  preparedSuggestionId: "time-change",
};
const prepared: CanvasSuggestion = {
  id: "time-change",
  label: "Start a little earlier",
  description: "Update the invitation to 10 AM.",
  request: "Move the invitation time to 10 AM.",
  targetBlockId: "design",
  prepared: {
    before: [design],
    edits: [
      {
        type: "replace",
        block: after.blocks.find((block) => block.id === "design")!,
      },
    ],
  },
};
type FixtureWindow = Window & {
  mountPreview(
    proposal: IntentProposal,
    suggestion: CanvasSuggestion,
    aside?: boolean,
  ): void;
  setPreview(proposal: IntentProposal): void;
  setDisabled(disabled: boolean): void;
  setSuggestion(suggestion: CanvasSuggestion): void;
  setUnavailable(value: Record<string, string>): void;
  keepCalls: number;
  dismissCalls: number;
  chooseCalls: number;
  intervalCalls: number;
};
let script: string, styles: string;
test.beforeAll(async () => {
  const photograph = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const output = await build({
    stdin: {
      contents: `
    import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {CanvasSuggestionPreview} from './apps/desktop/renderer/src/components/CanvasSuggestionPreview';
    import {CanvasSuggestions} from './apps/desktop/renderer/src/components/CanvasSuggestions';
    import {Canvas} from './apps/desktop/renderer/src/components/Canvas';
    const assets=[{id:'river',title:'River original',taskId:'fixture',mediaType:'image/png',byteLength:${photograph.length},url:'data:image/png;base64,${photograph.toString("base64")}',provenance:{kind:'user-import',attribution:'Repository test photograph',rights:'Test fixture'}}];
    const sources=[{id:'reference',taskId:'fixture',title:'Studio material notes',assetId:'river',excerpt:'Quoted material prices',retrievedAt:1,createdAt:1,provenance:{kind:'user-authored',attribution:'Fixture',rights:'Fixture'}}];
    window.keepCalls=0;window.dismissCalls=0;window.chooseCalls=0;window.intervalCalls=0;
    const interval=window.setInterval;window.setInterval=(...args)=>{window.intervalCalls++;return interval(...args)};
    function Fixture({initial,suggestion,aside}){const [proposal,setProposal]=useState(initial);const [current,setCurrent]=useState(suggestion);const [disabled,setDisabled]=useState(false);const [unavailable,setUnavailable]=useState({});window.setPreview=setProposal;window.setSuggestion=setCurrent;window.setDisabled=setDisabled;window.setUnavailable=setUnavailable;
      if(aside) return <main className='fixture aside-fixture'><Canvas document={{...initial.beforeCanvas,layout:'split',blocks:[initial.beforeCanvas.blocks.find(block=>block.kind==='text'),{id:'anchor',kind:'note',title:'Invitation details',description:'A change worth considering.',placement:'aside',pinned:false,sourceIds:[]}]}} assets={assets} sources={sources} onChange={()=>{}} suggestionPreview={{targetBlockId:'anchor',content:<CanvasSuggestionPreview proposal={proposal} assets={assets} sources={sources} disabled={disabled} onKeep={()=>window.keepCalls++} onDismiss={()=>window.dismissCalls++}/>}}/></main>;
      return <main className='fixture'><label className='live-label'>Your working draft<textarea aria-label='Your working draft' defaultValue='Keep this thought.'/></label>
      <CanvasSuggestions suggestions={[current]} onChoose={()=>window.chooseCalls++} unavailable={unavailable} disabled={disabled}/>
      <CanvasSuggestionPreview proposal={proposal} assets={assets} sources={sources} disabled={disabled} onKeep={()=>window.keepCalls++} onDismiss={()=>window.dismissCalls++}/></main>}
    window.mountPreview=(initial,suggestion,aside)=>createRoot(document.getElementById('root')).render(<Fixture initial={initial} suggestion={suggestion} aside={aside}/>);
  `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "suggestion-preview-fixture.js",
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
    .fixture{max-width:1100px;margin:0 auto;padding:28px}.live-label{display:grid;gap:8px;font-size:12px;color:var(--muted)}.live-label textarea{padding:12px;border:1px solid var(--rule);border-radius:8px;background:white;color:var(--ink);font:17px var(--serif);min-height:75px}
    @media(max-width:540px){.fixture{padding:18px}}
  `;
});
async function mount(page: Page, initial = proposal, aside = false) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ proposal, suggestion, aside }) =>
      (window as unknown as FixtureWindow).mountPreview(
        proposal,
        suggestion,
        aside,
      ),
    {
      proposal: initial,
      suggestion:
        initial.id === "arrangement"
          ? {
              id: "arrange-work",
              label: initial.label,
              description: initial.summary,
              request:
                "Review and keep the item arrangement and changes shown here.",
              targetBlockId: null,
              prepared: null,
            }
          : prepared,
      aside,
    },
  );
  await expect(
    page.getByRole("region", { name: "Suggestion preview", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) => image.decode().catch(() => {})),
    );
  });
}
const review = (page: Page) =>
  page.getByRole("region", { name: "Suggestion preview", exact: true });
const update = (page: Page, value: IntentProposal) =>
  page.evaluate(
    (value) => (window as unknown as FixtureWindow).setPreview(value),
    value,
  );
const calls = (page: Page) =>
  page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    return {
      keep: fixture.keepCalls,
      dismiss: fixture.dismissCalls,
      choose: fixture.chooseCalls,
      intervals: fixture.intervalCalls,
    };
  });

test("all registered kinds have concrete read-only previews, including derived linked values and formula results", async ({
  page,
}) => {
  await mount(page);
  await expect(review(page).locator("[data-preview-block-id]")).toHaveCount(12);
  await expect(
    review(page).locator("input,textarea,select,[contenteditable=true]"),
  ).toHaveCount(0);
  await expect(
    review(page).locator('[data-preview-block-id="text"] ins'),
  ).toHaveText("ten");
  await expect(
    review(page).locator('[data-preview-block-id="table"] .is-after'),
  ).toContainText("35");
  await expect(
    review(page).locator('[data-preview-block-id="metric"] .is-after'),
  ).toContainText("30.0");
  await expect(
    review(page).locator('[data-preview-block-id="chart"]'),
  ).toContainText("Linked values update");
  const chart = review(page).locator(
    '[data-preview-block-id="chart"] .is-after',
  );
  await chart.getByText("Chart data", { exact: true }).click();
  await expect(
    chart.getByRole("row", { name: "Glaze 0", exact: true }),
  ).toBeVisible();
  await expect(
    chart.getByRole("row", {
      name: "Not quoted No numeric value",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    review(page).locator('[data-preview-block-id="sources"] .is-after'),
  ).toContainText("Studio material notes");
  await expect(
    review(page).locator('[data-preview-block-id="timer"] .is-after'),
  ).toContainText("10:00");
  expect(await calls(page)).toEqual({
    keep: 0,
    dismiss: 0,
    choose: 0,
    intervals: 0,
  });
});

test("photo proposals render the actual original and adjusted settings without fetching another file or mutating work", async ({
  page,
}) => {
  await mount(page);
  const card = review(page).locator('[data-preview-block-id="image"]');
  const first = card.locator(".is-before [data-adjusted-image]"),
    second = card.locator(".is-after [data-adjusted-image]");
  await expect(first).toHaveAttribute("data-status", "ready");
  await expect(second).toHaveAttribute("data-status", "ready");
  expect(await first.locator("img").getAttribute("src")).toEqual(
    await second.locator("img").getAttribute("src"),
  );
  await expect(first.locator("img")).toHaveCSS(
    "filter",
    "brightness(1) contrast(1) saturate(1)",
  );
  await expect(second.locator("img")).toHaveCSS(
    "filter",
    "brightness(1.18) contrast(1.06) saturate(0.85)",
  );
  expect(
    await second
      .locator(".adjusted-image-transform")
      .evaluate((node) => getComputedStyle(node).transform),
  ).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  const beforeRatio = await first.evaluate(
    (node) => node.clientWidth / node.clientHeight,
  );
  const afterRatio = await second.evaluate(
    (node) => node.clientWidth / node.clientHeight,
  );
  expect(afterRatio / beforeRatio).toBeCloseTo(0.8 / 0.9, 1);
  await card
    .locator(".is-after")
    .getByText("Photo settings", { exact: true })
    .click();
  await expect(card.locator(".is-after")).toContainText("118%");
  await expect(card.locator(".is-after")).toContainText("Left 10%");
  await expect(card.locator(".is-after")).toContainText("Right 90%");
  expect(await calls(page)).toEqual({
    keep: 0,
    dismiss: 0,
    choose: 0,
    intervals: 0,
  });
});

test("Keep and Dismiss require explicit activation and pending status preserves focused controls", async ({
  page,
}) => {
  await mount(page);
  const keep = review(page).getByRole("button", { name: "Keep", exact: true });
  const original = await keep.elementHandle();
  await keep.focus();
  await keep.press("Enter");
  expect((await calls(page)).keep).toBe(1);
  await update(page, { ...proposal, status: "applying" });
  const keeping = review(page).getByRole("button", {
    name: "Keeping…",
    exact: true,
  });
  expect(await keeping.evaluate((node, old) => node === old, original)).toBe(
    true,
  );
  await expect(keeping).toBeFocused();
  await expect(keeping).toBeDisabled();
  await keeping.press("Enter");
  expect((await calls(page)).keep).toBe(1);
  await expect(
    review(page).getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeDisabled();
  await update(page, { ...proposal, status: "stale" });
  await expect(
    review(page).getByRole("button", { name: "Keep", exact: true }),
  ).toBeDisabled();
  await review(page)
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  expect((await calls(page)).dismiss).toBe(1);
});

test("background preview changes retain a live editor's identity, focus, selection, and native undo", async ({
  page,
}) => {
  await mount(page);
  const editor = page.getByRole("textbox", { name: "Your working draft" });
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" Still here.");
  const caret = await editor.evaluate((node: HTMLTextAreaElement) => [
    node.selectionStart,
    node.selectionEnd,
  ]);
  await update(page, {
    ...proposal,
    label: "A refreshed review",
    status: "stale",
  });
  await page.evaluate(
    (value) => (window as unknown as FixtureWindow).setSuggestion(value),
    { ...prepared, description: "Updated without interrupting writing." },
  );
  expect(await editor.evaluate((node, old) => node === old, original)).toBe(
    true,
  );
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual(caret);
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("Keep this thought.");
  expect(await calls(page)).toEqual({
    keep: 0,
    dismiss: 0,
    choose: 0,
    intervals: 0,
  });
});

test("missing, unchanged, stale, expired and uncertain previews cannot be kept", async ({
  page,
}) => {
  await mount(page, { ...proposal, beforeCanvas: undefined });
  await expect(review(page)).toContainText(
    "complete before-and-after preview is unavailable",
  );
  const keep = review(page).getByRole("button", { name: "Keep", exact: true });
  await expect(keep).toBeDisabled();
  await update(page, { ...proposal, canvas: before });
  await expect(review(page)).toContainText("does not change your space");
  await expect(keep).toBeDisabled();
  await update(page, {
    ...proposal,
    beforeCanvas: { ...before, suggestions: [prepared] },
    canvas: { ...before, suggestions: [] },
  });
  await expect(review(page)).toContainText("does not change your space");
  await expect(keep).toBeDisabled();
  await expect(
    review(page).getByText("Suggested next steps update", { exact: true }),
  ).toHaveCount(0);
  for (const status of [
    "stale",
    "expired",
    "uncertain",
    "error",
    "discarded",
  ] as const) {
    await update(page, { ...proposal, status });
    await expect(keep).toBeDisabled();
    await keep.press("Enter");
  }
  await update(page, { ...proposal, expiresAt: 1 });
  await expect(keep).toBeDisabled();
  await expect(review(page)).toContainText("preview has expired");
  expect((await calls(page)).keep).toBe(0);
});

test("prepared plan changes resurface dismissed cards, keep stable focused card identity, and explain unavailable previews", async ({
  page,
}) => {
  await mount(page);
  const card = page.getByRole("button", { name: prepared.label, exact: true });
  await expect(card).toContainText("Preview");
  const original = await card.elementHandle();
  await card.focus();
  const changed = {
    ...prepared,
    prepared: {
      ...prepared.prepared!,
      edits: [
        {
          type: "replace" as const,
          block: { ...design, background: "#FFFFFF" },
        },
      ],
    },
  };
  await page.evaluate(
    (value) => (window as unknown as FixtureWindow).setSuggestion(value),
    changed,
  );
  expect(await card.evaluate((node, old) => node === old, original)).toBe(true);
  await expect(card).toBeFocused();
  await page
    .getByRole("button", {
      name: `Dismiss suggestion: ${prepared.label}`,
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
  await page.evaluate(
    (value) => (window as unknown as FixtureWindow).setSuggestion(value),
    prepared,
  );
  await expect(card).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setUnavailable({
      "time-change": "The invitation changed. Ask for a fresh suggestion.",
    }),
  );
  await expect(card).toBeDisabled();
  await expect(card).toContainText("invitation changed");
  await card.focus();
  await card.press("Enter");
  expect((await calls(page)).choose).toBe(0);
  await expect(
    page.getByRole("button", {
      name: `Dismiss suggestion: ${prepared.label}`,
      exact: true,
    }),
  ).toBeEnabled();
});

test("unattached image references remain data, never fetches, and have readable unavailable content", async ({
  page,
}) => {
  const image = {
    ...base,
    id: "missing",
    kind: "image" as const,
    title: "Unavailable photograph",
    assetId: "https://outside.invalid/private.jpg",
    caption: "An image reference",
  };
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await mount(page, {
    ...proposal,
    beforeCanvas: { ...before, blocks: [before.blocks[0]!] },
    canvas: { ...before, blocks: [before.blocks[0]!, image] },
  });
  await expect(review(page)).toContainText("Image unavailable");
  expect(requested.some((url) => url.includes("outside.invalid"))).toBe(false);
  await expect(review(page).locator("img")).toHaveCount(0);
});

for (const width of [1280, 390])
  test(`the before/after invitation fits and remains inspectable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const old = { ...before, blocks: [before.blocks[0]!, design] };
    const next = {
      ...before,
      blocks: [
        after.blocks[0]!,
        after.blocks.find((block) => block.id === "design")!,
      ],
    };
    await mount(page, { ...proposal, beforeCanvas: old, canvas: next });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    const outside = await review(page).evaluate((node) => {
      const outer = node.getBoundingClientRect();
      return [
        ...node.querySelectorAll<HTMLElement>(
          ".suggestion-preview-side,button,summary",
        ),
      ]
        .filter((element) => element.getClientRects().length)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < outer.left || box.right > outer.right;
        })
        .map((element) => element.textContent);
    });
    expect(outside).toEqual([]);
    await expect(
      review(page).getByRole("img", {
        name: "An afternoon invitation, 5 layers",
      }),
    ).toHaveCount(width === 1280 ? 2 : 1);
    if (width === 390) {
      const comparison = review(page).getByRole("group", {
        name: "Compare An afternoon invitation",
        exact: true,
      });
      await comparison
        .getByRole("button", { name: "Before", exact: true })
        .click();
      await expect(
        review(page).locator(
          '[data-preview-block-id="design"] .is-before .suggestion-preview-design-change',
        ),
      ).toContainText("Saturday · 11 AM");
      await comparison
        .getByRole("button", { name: "After", exact: true })
        .click();
      await expect(
        review(page).locator(
          '[data-preview-block-id="design"] .is-after .suggestion-preview-design-change',
        ),
      ).toContainText("Saturday · 10 AM");
    }
    await review(page)
      .locator(".is-after")
      .filter({ has: page.locator(".suggestion-preview-design") })
      .getByText("Layer contents", { exact: true })
      .click();
    await expect(
      review(page).locator(".is-after .suggestion-preview-layer-details"),
    ).toContainText("Saturday · 10 AM");
    await review(page)
      .locator(".is-after")
      .filter({ has: page.locator(".suggestion-preview-design") })
      .getByText("Layer contents", { exact: true })
      .click();
    const directory = resolve(".runtime/canvas-suggestion-preview");
    await mkdir(directory, { recursive: true });
    const height = await page.evaluate(() =>
      Math.ceil(document.documentElement.scrollHeight),
    );
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const path = resolve(directory, `invitation-${width}.png`);
    await page.screenshot({ path, fullPage: false });
    await testInfo.attach(`invitation-${width}`, {
      path,
      contentType: "image/png",
    });
    await page.setViewportSize({ width, height: 900 });
    await review(page)
      .getByRole("button", { name: "Keep", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(directory, `invitation-controls-${width}.png`),
      fullPage: false,
    });
  });

test("a preview attached inside the actual narrow Canvas aside stays contained and comparisons remain readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const old = {
    ...before,
    blocks: [before.blocks[0]!, design],
    suggestions: [prepared],
  };
  const next = {
    ...old,
    suggestions: [],
    blocks: [
      old.blocks[0]!,
      after.blocks.find((block) => block.id === "design")!,
    ],
  };
  await mount(page, { ...proposal, beforeCanvas: old, canvas: next }, true);
  const preview = review(page);
  expect((await preview.boundingBox())!.width).toBeLessThan(370);
  await preview.getByRole("button", { name: "Inspect full item" }).click();
  await expect(
    preview.getByRole("group", {
      name: "Compare An afternoon invitation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    preview.locator(".is-after .suggestion-preview-design-change"),
  ).toContainText("Saturday · 10 AM");
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const outer = element.getBoundingClientRect();
        const slot = element
          .closest(".canvas-layout-slot")!
          .getBoundingClientRect();
        const shelf = document
          .querySelector(".canvas-tool-shelf")!
          .getBoundingClientRect();
        return (
          outer.bottom <= slot.bottom + 1 &&
          outer.bottom < shelf.top &&
          [
            ...element.querySelectorAll(
              "button,summary,.suggestion-preview-side",
            ),
          ]
            .filter((node) => node.getClientRects().length)
            .every((node) => {
              const rect = node.getBoundingClientRect();
              return rect.left >= outer.left && rect.right <= outer.right;
            })
        );
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await preview
    .getByRole("button", { name: "Keep", exact: true })
    .scrollIntoViewIfNeeded();
  const directory = resolve(".runtime/canvas-suggestion-preview");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, "actual-aside-1280.png"),
    fullPage: false,
  });
});

const arranged: CanvasDocument = {
  version: 1,
  title: "A place for the next idea",
  subtitle: "",
  layout: "focus",
  suggestions: [],
  blocks: [
    {
      ...base,
      id: "reference-photo",
      kind: "image",
      title: "River reference",
      assetId: "river",
      caption: "Keep the path and the afternoon light.",
      sourceIds: ["reference"],
    },
    {
      ...base,
      id: "packing",
      kind: "checklist",
      title: "Bring along",
      placement: "aside",
      items: [
        { id: "paper", label: "Loose paper", checked: false },
        { id: "pencil", label: "Soft pencil", checked: true },
      ],
    },
    {
      ...base,
      id: "divider",
      kind: "text",
      title: "An afternoon without a rush",
      placement: "full",
      body: "Leave room for an unexpected turn.",
    },
    {
      ...base,
      id: "writing",
      kind: "text",
      title: "Notes to return to",
      body: "Follow the river. Write down the first detail that catches your attention.",
    },
    {
      ...base,
      id: "references",
      kind: "sources",
      title: "Where the details came from",
      placement: "aside",
      description: "The original material notes.",
      sourceIds: ["reference", "unavailable-source"],
    },
  ],
};
const arrangementProposal = (
  before: CanvasDocument,
  after: CanvasDocument,
): IntentProposal => ({
  ...proposal,
  id: "arrangement",
  label: "Give the work a little room",
  summary: "Review the arrangement before keeping it.",
  beforeCanvas: before,
  canvas: after,
  preparedSuggestionId: undefined,
});
const arrangement = (page: Page, side: "before" | "after") =>
  review(page).getByRole("region", {
    name: side === "before" ? "Before arrangement" : "After arrangement",
    exact: true,
  });
const arrangementCard = (page: Page, side: "before" | "after", id: string) =>
  arrangement(page, side).locator(`[data-arrangement-block-id="${id}"]`);
async function settleArrangement(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      let previous = "",
        stable = 0;
      const frame = () => {
        const next = JSON.stringify(
          [...document.querySelectorAll("[data-arrangement-block-id]")].map(
            (node) => {
              const box = node.getBoundingClientRect();
              return [box.x, box.y, box.width, box.height];
            },
          ),
        );
        stable = next === previous ? stable + 1 : 0;
        previous = next;
        if (stable >= 4) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  });
}
async function arrangementGeometry(page: Page, side: "before" | "after") {
  return arrangement(page, side)
    .locator("[data-arrangement-block-id]")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: (node as HTMLElement).dataset.arrangementBlockId!,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      }),
    );
}

async function captureArrangement(page: Page, name: string) {
  const viewport = page.viewportSize()!;
  const directory = resolve(".runtime/canvas-arrangement");
  await mkdir(directory, { recursive: true });
  const height = await page.evaluate(() =>
    Math.ceil(document.documentElement.scrollHeight),
  );
  await page.setViewportSize({
    ...viewport,
    height: Math.max(viewport.height, height),
  });
  await settleArrangement(page);
  await verifyArrangementContrast(page, directory, name);
  await page.screenshot({
    path: resolve(directory, `${name}.png`),
    fullPage: false,
  });
  await page.setViewportSize(viewport);
  await settleArrangement(page);
}

async function verifyArrangementContrast(
  page: Page,
  directory: string,
  name: string,
) {
  const samples = await page
    .locator(".canvas-arrangement-preview")
    .evaluate((root) => {
      type Color = [number, number, number, number];
      const parse = (value: string): Color => {
        const parts = value.match(/[\d.]+/g)!.map(Number);
        return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
      };
      const over = (front: Color, back: Color): Color => [
        front[0] * front[3] + back[0] * (1 - front[3]),
        front[1] * front[3] + back[1] * (1 - front[3]),
        front[2] * front[3] + back[2] * (1 - front[3]),
        1,
      ];
      const luminance = (color: Color) =>
        color.slice(0, 3).reduce((sum, channel, index) => {
          const linear = channel / 255;
          return (
            sum +
            (linear <= 0.04045
              ? linear / 12.92
              : ((linear + 0.055) / 1.055) ** 2.4) *
              [0.2126, 0.7152, 0.0722][index]!
          );
        }, 0);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const result = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent!.trim();
        const element = walker.currentNode.parentElement!;
        if (
          !text ||
          !element.getClientRects().length ||
          getComputedStyle(element).visibility === "hidden"
        )
          continue;
        const ancestors: Element[] = [];
        for (
          let node: Element | null = element;
          node;
          node = node.parentElement
        )
          ancestors.unshift(node);
        let backgrounds: Color[] = [[255, 255, 255, 1]];
        // Resolve translucent surfaces over the actual ancestor backgrounds. The
        // preview's pale gradient has monotonic RGB stops; testing every endpoint
        // conservatively includes its lowest-contrast background for these colors.
        for (const node of ancestors) {
          const style = getComputedStyle(node);
          backgrounds = backgrounds.map((background) =>
            over(parse(style.backgroundColor), background),
          );
          if (style.backgroundImage !== "none") {
            const stops = style.backgroundImage.match(/rgba?\([^)]+\)/g);
            if (!stops?.length)
              throw new Error(
                `Unsupported contrast background: ${style.backgroundImage}`,
              );
            backgrounds = backgrounds.flatMap((background) =>
              stops.map((stop) => over(parse(stop), background)),
            );
          }
        }
        const style = getComputedStyle(element);
        const foreground = parse(style.color);
        const ratios = backgrounds.map((background) => {
          const a = luminance(over(foreground, background)),
            b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        result.push({
          text,
          element: element.className || element.tagName,
          fontSize: parseFloat(style.fontSize),
          foreground: style.color,
          backgrounds,
          contrast: Math.min(...ratios),
        });
      }
      return result;
    });
  expect(samples.length).toBeGreaterThan(20);
  await writeFile(
    resolve(directory, `${name}-contrast.json`),
    JSON.stringify(
      {
        method:
          "WCAG sRGB relative luminance; computed text colors, alpha-composited ancestor surfaces and preview gradient endpoints; white browser canvas",
        minimum: Math.min(...samples.map((sample) => sample.contrast)),
        samples,
      },
      null,
      2,
    ),
  );
  expect(samples.filter((sample) => sample.contrast < 4.5)).toEqual([]);
  expect(samples.filter((sample) => sample.fontSize < 11)).toEqual([]);
}

test("reorder-only preview shows every real item in exact before and proposed order", async ({
  page,
}) => {
  const next = {
    ...arranged,
    blocks: [
      arranged.blocks[3]!,
      arranged.blocks[0]!,
      arranged.blocks[1]!,
      arranged.blocks[2]!,
      arranged.blocks[4]!,
    ],
  };
  await mount(page, arrangementProposal(arranged, next));
  await settleArrangement(page);
  await expect(
    review(page).getByRole("region", { name: "Arrangement overview" }),
  ).toBeVisible();
  for (const [side, document] of [
    ["before", arranged],
    ["after", next],
  ] as const) {
    expect(
      await arrangement(page, side)
        .locator("[data-arrangement-block-id]")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            id: (node as HTMLElement).dataset.arrangementBlockId,
            rank: Number((node as HTMLElement).dataset.order),
          })),
        ),
    ).toEqual(
      document.blocks.map((block, index) => ({
        id: block.id,
        rank: index + 1,
      })),
    );
    for (const block of document.blocks)
      await expect(arrangementCard(page, side, block.id)).toContainText(
        block.title,
      );
  }
  await expect(arrangementCard(page, "after", "writing")).toHaveAttribute(
    "data-change",
    "moved",
  );
  await expect(arrangementCard(page, "after", "writing")).toContainText(
    "4 → 1",
  );
  await expect(review(page).locator("[data-preview-block-id]")).toHaveCount(0);
  await expect(
    review(page).getByRole("button", { name: "Keep", exact: true }),
  ).toBeEnabled();
  expect(await calls(page)).toEqual({
    keep: 0,
    dismiss: 0,
    choose: 0,
    intervals: 0,
  });
});

test("page-to-beside overview preserves main, aside and full-width relationships", async ({
  page,
}) => {
  await mount(
    page,
    arrangementProposal(arranged, { ...arranged, layout: "split" }),
  );
  await settleArrangement(page);
  const prior = await arrangementGeometry(page, "before"),
    next = await arrangementGeometry(page, "after");
  expect(
    prior.every(
      (item) =>
        Math.abs(item.left - prior[0]!.left) < 1 &&
        Math.abs(item.right - prior[0]!.right) < 1,
    ),
  ).toBe(true);
  const byId = Object.fromEntries(next.map((item) => [item.id, item]));
  expect(byId.packing.left).toBeGreaterThan(byId["reference-photo"].right);
  expect(byId.divider.left).toBeCloseTo(byId["reference-photo"].left, 0);
  expect(byId.divider.right).toBeCloseTo(byId.packing.right, 0);
  expect(byId.divider.top).toBeGreaterThanOrEqual(
    Math.max(byId["reference-photo"].bottom, byId.packing.bottom) + 9,
  );
  expect(byId.writing.top).toBeGreaterThanOrEqual(byId.divider.bottom + 9);
  expect(byId.references.top).toBeCloseTo(byId.writing.top, 0);
  await expect(arrangementCard(page, "after", "packing")).toContainText(
    "Checklist · Beside",
  );
  await expect(arrangementCard(page, "after", "divider")).toContainText(
    "Writing · Full width",
  );
});

test("gallery balances compact card heights and makes full-width boundaries and source references explicit", async ({
  page,
}) => {
  const gallery = {
    ...arranged,
    layout: "gallery" as const,
    blocks: [
      arranged.blocks[0]!,
      arranged.blocks[1]!,
      arranged.blocks[3]!,
      arranged.blocks[2]!,
      arranged.blocks[4]!,
    ],
  };
  await mount(page, arrangementProposal(arranged, gallery));
  await settleArrangement(page);
  await expect(
    review(page).getByRole("region", { name: "Arrangement overview" }),
  ).toContainText("exact positions may differ");
  await expect(arrangementCard(page, "after", "writing")).toHaveAttribute(
    "data-column",
    "1",
  );
  const geometry = Object.fromEntries(
    (await arrangementGeometry(page, "after")).map((item) => [item.id, item]),
  );
  expect(geometry.divider.top).toBeGreaterThanOrEqual(
    Math.max(geometry["reference-photo"].bottom, geometry.writing.bottom) + 9,
  );
  expect(geometry.divider.width).toBeGreaterThan(
    geometry["reference-photo"].width * 1.9,
  );
  await expect(
    arrangementCard(page, "after", "references").locator(
      '[data-source-id="reference"]',
    ),
  ).toHaveText("Studio material notes");
  await expect(
    arrangementCard(page, "after", "references").locator(
      '[data-source-id="unavailable-source"]',
    ),
  ).toHaveText("Source unavailable");
  await expect(
    arrangement(page, "after").locator("a,input,textarea,select,button"),
  ).toHaveCount(0);
  await captureArrangement(page, "arrangement-gallery-1280");
});

test("remove-and-add arrangement marks both identities and exposes removed content immediately on narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const newItem: CanvasBlock = {
    ...base,
    id: "new-notes",
    kind: "text",
    title: "Room to reflect",
    body: "",
  };
  const next = {
    ...arranged,
    layout: "split" as const,
    blocks: arranged.blocks
      .filter((block) => block.id !== "packing")
      .concat(newItem),
  };
  await mount(page, arrangementProposal(arranged, next));
  await settleArrangement(page);
  await expect(arrangementCard(page, "after", "new-notes")).toHaveAttribute(
    "data-change",
    "added",
  );
  await expect(arrangementCard(page, "after", "packing")).toHaveCount(0);
  await expect(
    review(page).locator('[data-preview-block-id="packing"] .is-before'),
  ).toBeVisible();
  await expect(
    review(page).locator('[data-preview-block-id="packing"] .is-before'),
  ).toContainText("Loose paper");
  await review(page)
    .getByRole("group", { name: "Compare arrangement" })
    .getByRole("button", { name: "Before", exact: true })
    .click();
  await expect(arrangementCard(page, "before", "packing")).toHaveAttribute(
    "data-change",
    "removed",
  );
  await expect(arrangementCard(page, "before", "packing")).toContainText(
    "Removed",
  );
  await expect(arrangementCard(page, "before", "new-notes")).toHaveCount(0);
  expect((await calls(page)).keep).toBe(0);
  await captureArrangement(page, "arrangement-removal-390");
});

test("arrangement updates stay read-only, retain the live editor and show unavailable images without fetching reference IDs", async ({
  page,
}) => {
  const timer: CanvasBlock = {
    ...base,
    id: "timer",
    kind: "timer",
    title: "A running timer snapshot",
    durationSeconds: 120,
    remainingSeconds: 60,
    endsAt: Date.now() + 60000,
  };
  const missing: CanvasBlock = {
    ...base,
    id: "missing-image",
    kind: "image",
    title: "An unavailable original",
    caption: "Retain the original reference.",
    assetId: "https://outside.invalid/not-admitted.jpg",
  };
  const prior = { ...arranged, blocks: [arranged.blocks[3]!, timer, missing] },
    next = {
      ...prior,
      layout: "gallery" as const,
      blocks: [timer, missing, arranged.blocks[3]!],
    };
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await mount(page, arrangementProposal(prior, next));
  const editor = page.getByRole("textbox", { name: "Your working draft" });
  await editor.focus();
  await editor.evaluate((node) => {
    const input = node as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.keyboard.insertText(" Still here.");
  const original = await editor.elementHandle();
  await update(page, {
    ...arrangementProposal(prior, { ...next, layout: "split" }),
    status: "stale",
  });
  await settleArrangement(page);
  expect(await editor.evaluate((node, old) => node === old, original)).toBe(
    true,
  );
  await expect(editor).toBeFocused();
  await expect(arrangementCard(page, "after", "missing-image")).toContainText(
    "Image unavailable",
  );
  await expect(arrangementCard(page, "after", "timer")).toContainText(
    "1:00 remaining",
  );
  await expect(
    review(page).getByRole("button", { name: "Keep", exact: true }),
  ).toBeDisabled();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("Keep this thought.");
  expect(requested.some((url) => url.includes("outside.invalid"))).toBe(false);
  expect(await calls(page)).toEqual({
    keep: 0,
    dismiss: 0,
    choose: 0,
    intervals: 0,
  });
});

for (const [width, aside] of [
  [1280, false],
  [390, false],
  [1280, true],
] as const)
  test(`arrangement overview is contained and legible at ${width}px${aside ? " in the actual aside" : ""}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    // The aside fixture needs a genuine existing writing block, and keeps that editor alive.
    const prior = {
      ...arranged,
      blocks: [
        arranged.blocks[3]!,
        arranged.blocks[0]!,
        arranged.blocks[1]!,
        arranged.blocks[2]!,
        arranged.blocks[4]!,
      ],
    };
    const next = {
      ...prior,
      layout: "split" as const,
      blocks: [
        prior.blocks[1]!,
        prior.blocks[2]!,
        prior.blocks[3]!,
        prior.blocks[0]!,
        prior.blocks[4]!,
      ],
    };
    await mount(page, arrangementProposal(prior, next), aside);
    await settleArrangement(page);
    await expect(
      arrangement(page, "after").locator("[data-arrangement-block-id]"),
    ).toHaveCount(next.blocks.length);
    const geometry = await arrangementGeometry(page, "after");
    for (const box of geometry) {
      expect(box.width).toBeGreaterThan(70);
      expect(box.height).toBeGreaterThan(30);
    }
    for (let a = 0; a < geometry.length; a++)
      for (let b = a + 1; b < geometry.length; b++) {
        const one = geometry[a]!,
          two = geometry[b]!;
        expect(
          Math.min(one.right, two.right) - Math.max(one.left, two.left) > 1 &&
            Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 1,
        ).toBe(false);
      }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
    ).toBe(false);
    expect(
      await review(page).evaluate((node) => {
        const outer = node.getBoundingClientRect();
        return [
          ...node.querySelectorAll(
            "[data-arrangement-block-id],.arrangement-map,button",
          ),
        ]
          .filter((element) => element.getClientRects().length)
          .some((element) => {
            const box = element.getBoundingClientRect();
            return box.left < outer.left - 1 || box.right > outer.right + 1;
          });
      }),
    ).toBe(false);
    const directory = resolve(".runtime/canvas-arrangement");
    await mkdir(directory, { recursive: true });
    const name = `arrangement-${width}${aside ? "-aside" : ""}`;
    await page.screenshot({
      path: resolve(directory, `${name}-viewport.png`),
      fullPage: false,
    });
    const height = await page.evaluate(() =>
      Math.ceil(document.documentElement.scrollHeight),
    );
    await page.setViewportSize({ width, height: Math.max(850, height) });
    await settleArrangement(page);
    await verifyArrangementContrast(page, directory, name);
    await page.screenshot({
      path: resolve(directory, `${name}.png`),
      fullPage: false,
    });
    await page.setViewportSize({ width, height: 850 });
    await settleArrangement(page);
    expect((await calls(page)).keep).toBe(0);
  });
