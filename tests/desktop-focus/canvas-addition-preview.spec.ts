import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasBlock, CanvasDocument } from "@eve/contracts";
import type {
  IntentProposal,
  IntentResponse,
} from "../../apps/desktop/shared/bridge";

const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const writing: Extract<CanvasBlock, { kind: "text" }> = {
  ...base,
  id: "writing",
  kind: "text",
  title: "Working draft",
  body: "Leave room for a new thought.",
};
const reference: CanvasBlock = {
  ...base,
  id: "reference",
  kind: "note",
  title: "Source notes",
  description: "Distinguish an observation from an inference.",
  placement: "aside",
};
const checklist: CanvasBlock = {
  ...base,
  id: "checklist",
  kind: "checklist",
  title: "Questions to explore",
  items: [
    { id: "observation", label: "Record the observation", checked: false },
    { id: "inference", label: "State what remains uncertain", checked: true },
  ],
};
const design: CanvasBlock = {
  ...base,
  id: "design",
  kind: "design",
  title: "Observation and inference",
  placement: "full",
  width: 900,
  height: 360,
  background: "#F0EEE8",
  layers: [
    {
      id: "heading",
      kind: "text",
      name: "Heading",
      x: 48,
      y: 64,
      width: 804,
      height: 110,
      text: "Observed sleep.\nUncertain dream content.",
      fontFamily: "serif",
      fontSize: 40,
      fontWeight: "regular",
      color: "#263D3C",
      align: "left",
    },
    {
      id: "rule",
      kind: "shape",
      name: "Divider",
      x: 48,
      y: 220,
      width: 804,
      height: 4,
      shape: "rectangle",
      fill: "#607B79",
    },
  ],
};
const table: CanvasBlock = {
  ...base,
  id: "table",
  kind: "table",
  title: "Recorded observations",
  columns: ["Session", "Minutes"],
  rows: [
    { id: "morning", cells: ["Morning", "12"] },
    { id: "afternoon", cells: ["Afternoon", "=B1+6"] },
  ],
};
const chart: CanvasBlock = {
  ...base,
  id: "chart",
  kind: "chart",
  title: "Observed duration",
  placement: "aside",
  tableId: "table",
  chartType: "bar",
  labelColumn: 0,
  valueColumns: [1],
};
const before: CanvasDocument = {
  version: 1,
  title: "Notes on dreaming",
  subtitle: "",
  layout: "focus",
  blocks: [writing, reference],
};
const proposal: IntentProposal = {
  id: "additions",
  kind: "canvas",
  label: "Proposed change",
  summary: "Add supporting material to the working draft.",
  status: "ready",
  expiresAt: 4102444800000,
  beforeCanvas: before,
  canvas: {
    ...before,
    layout: "split",
    blocks: [writing, reference, checklist, design, table, chart],
  },
};
type FixtureWindow = Window & {
  mountAdditionReview(
    document: CanvasDocument,
    proposal: IntentProposal | null,
  ): void;
  setAdditionReview(proposal: IntentProposal | null): void;
  completeAdditionReview(): void;
  additionDocument: CanvasDocument;
  additionChanges: CanvasDocument[];
  keepCalls: number;
  dismissCalls: number;
};
let script: string, styles: string;

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {Canvas} from './apps/desktop/renderer/src/components/Canvas';
        window.keepCalls=0; window.dismissCalls=0; window.additionChanges=[];
        function Fixture({initial,review}) {
          const [document,setDocument]=useState(initial);
          const [proposal,setProposal]=useState(review);
          window.additionDocument=document;
          window.setAdditionReview=setProposal;
          window.completeAdditionReview=()=>{if(proposal?.canvas){setDocument(proposal.canvas);setProposal(null);}};
          return <main className="fixture"><Canvas document={document} assets={[]} sources={[]}
            onChange={next=>{window.additionChanges.push(structuredClone(next));setDocument(next);}}
            proposedChange={proposal ? {proposal,onKeep:()=>window.keepCalls++,onDismiss:()=>window.dismissCalls++} : undefined}
          /></main>;
        }
        window.mountAdditionReview=(document,proposal)=>createRoot(window.document.getElementById('root')).render(<Fixture initial={document} review={proposal}/>);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
      sourcefile: "canvas-addition-review-fixture.tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-addition-review-fixture.js",
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
    .fixture{max-width:1120px;margin:0 auto;padding:24px}
    @media(max-width:540px){.fixture{padding:16px}}
  `;
});

async function mount(
  page: Page,
  review: IntentProposal | null = proposal,
  document = before,
) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ document, review }) => {
      (window as unknown as FixtureWindow).mountAdditionReview(
        document,
        review,
      );
    },
    { document, review },
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    document.title,
  );
  await page.evaluate(() => window.document.fonts.ready);
}

const live = (page: Page, id: string) =>
  page.locator(
    `.canvas-layout [data-canvas-block-id="${id}"]:not([data-proposed="true"])`,
  );
const added = (page: Page, id: string) =>
  page.locator(
    `.canvas-layout [data-canvas-block-id="${id}"][data-proposed="true"]`,
  );
const setReview = (page: Page, review: IntentProposal | null) =>
  page.evaluate(
    (review) => (window as unknown as FixtureWindow).setAdditionReview(review),
    review,
  );
const calls = (page: Page) =>
  page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    return {
      keep: fixture.keepCalls,
      dismiss: fixture.dismissCalls,
      changes: fixture.additionChanges,
    };
  });
async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  for (const block of await page
    .locator(".canvas-layout > .canvas-layout-slot")
    .all()) {
    const box = await block.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
  }
}
async function cannotKeep(control: Locator) {
  if (await control.count()) await expect(control).toBeDisabled();
}

for (const width of [1280, 390]) {
  test(`new items occupy the candidate canvas with their normal content at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page);
    await expect(
      page.locator('.canvas-layout [data-proposed="true"]'),
    ).toHaveCount(4);
    await expect(page.locator(".canvas-suggestion-preview")).toHaveCount(0);
    await expect(page.getByText("Arrangement", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Before", { exact: true })).toHaveCount(0);
    await expect(page.getByText("After", { exact: true })).toHaveCount(0);
    await expect(
      added(page, "checklist").getByRole("checkbox", {
        name: "Record the observation",
      }),
    ).toBeVisible();
    await expect(
      added(page, "checklist").getByRole("checkbox", {
        name: "State what remains uncertain",
      }),
    ).toBeChecked();
    await expect(added(page, "design").locator(".design-stage")).toBeVisible();
    await expect(
      added(page, "design").locator(".design-text-preview"),
    ).toHaveText(/Observed sleep\.\s*Uncertain dream content\./);
    await expect(added(page, "table").locator(".canvas-table")).toBeVisible();
    await expect(
      added(page, "table").getByRole("textbox", {
        name: "A1: Session",
        exact: true,
      }),
    ).toHaveValue("Morning");
    await expect(
      added(page, "chart").locator(".canvas-chart-graphic"),
    ).toBeVisible();
    await expect(
      added(page, "chart").getByRole("button", { name: /Afternoon.*18/ }),
    ).toBeVisible();
    for (const id of ["checklist", "design", "table", "chart"]) {
      await expect(
        added(page, id).getByRole("heading", { level: 2 }),
      ).toHaveCSS("color", "rgb(49, 91, 201)");
      await expect(
        added(page, id).getByRole("button", {
          name: /^Keep(?: all changes)?$/,
        }),
      ).toBeVisible();
      await expect(
        added(page, id).getByRole("button", {
          name: /^Dismiss(?: all changes)?$/,
        }),
      ).toBeVisible();
    }
    await expect(
      live(page, "writing").getByRole("button", {
        name: /^Keep(?: all changes)?$/,
      }),
    ).toHaveCount(0);
    const writingBox = (await live(page, "writing").boundingBox())!;
    const checklistBox = (await added(page, "checklist").boundingBox())!;
    const designBox = (await added(page, "design").boundingBox())!;
    const tableBox = (await added(page, "table").boundingBox())!;
    const chartBox = (await added(page, "chart").boundingBox())!;
    expect(checklistBox.y).toBeGreaterThan(writingBox.y);
    expect(designBox.y).toBeGreaterThan(checklistBox.y);
    expect(tableBox.y).toBeGreaterThan(designBox.y);
    if (width > 740) {
      expect(designBox.width).toBeGreaterThan(tableBox.width * 1.5);
      expect(Math.abs(tableBox.y - chartBox.y)).toBeLessThan(2);
      expect(chartBox.x).toBeGreaterThan(tableBox.x + tableBox.width);
    } else {
      expect(chartBox.y).toBeGreaterThan(tableBox.y);
      expect(Math.abs(chartBox.x - tableBox.x)).toBeLessThan(2);
    }
    await noHorizontalOverflow(page);
    expect(await calls(page)).toEqual({ keep: 0, dismiss: 0, changes: [] });
    await page.screenshot({
      path: info.outputPath(`canvas-additions-${width}.png`),
      fullPage: true,
    });
    await mkdir(".runtime/canvas-input-inline-preview", { recursive: true });
    await page.screenshot({
      path: resolve(
        `.runtime/canvas-input-inline-preview/canvas-additions-${width}.png`,
      ),
      fullPage: true,
    });
  });
}

test("review controls invoke only the host callback and proposed data stays read-only", async ({
  page,
}) => {
  await mount(page);
  await expect(
    added(page, "checklist").getByRole("checkbox").first(),
  ).toBeDisabled();
  await expect(
    added(page, "table").getByRole("textbox", {
      name: "B1: Minutes",
      exact: true,
    }),
  ).not.toBeEditable();
  await expect(
    added(page, "design").getByRole("button", {
      name: "Add text",
      exact: true,
    }),
  ).toBeDisabled();
  await added(page, "checklist")
    .getByRole("button", { name: /^Keep(?: all changes)?$/ })
    .click();
  expect(await calls(page)).toEqual({ keep: 1, dismiss: 0, changes: [] });
  await added(page, "design")
    .getByRole("button", { name: /^Dismiss(?: all changes)?$/ })
    .click();
  expect(await calls(page)).toEqual({ keep: 1, dismiss: 1, changes: [] });
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).additionDocument,
    ),
  ).toEqual(before);
});

test("review arrival and removal retain a live editor's focus, selection, and native Undo", async ({
  page,
}) => {
  await mount(page, null);
  const editor = live(page, "writing").getByRole("textbox", {
    name: "Working draft text",
  });
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(6, 10),
  );
  await setReview(page, proposal);
  await expect(added(page, "design")).toBeVisible();
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual([6, 10]);
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" Still here.");
  await expect(editor).toHaveValue(`${writing.body} Still here.`);
  await cannotKeep(
    page.getByRole("button", { name: /^Keep(?: all changes)?$/ }).first(),
  );
  await expect(editor).toBeFocused();
  await setReview(page, null);
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue(writing.body);
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveValue(`${writing.body} Still here.`);
  expect((await calls(page)).keep).toBe(0);
});

test("mixed additions show changed content and removals without replacing existing buffers", async ({
  page,
}) => {
  await mount(page, null);
  const editor = live(page, "writing").locator("textarea:not(:disabled)");
  const original = await editor.elementHandle();
  const mixed: IntentProposal = {
    ...proposal,
    canvas: {
      ...proposal.canvas!,
      blocks: [
        checklist,
        { ...writing, body: "An observed fact, followed by an open question." },
        design,
      ],
    },
  };
  await setReview(page, mixed);
  await expect(
    added(page, "writing").getByRole("textbox", { name: "Working draft text" }),
  ).toHaveValue("An observed fact, followed by an open question.");
  await expect(
    added(page, "writing").getByRole("textbox", { name: "Working draft text" }),
  ).not.toBeEditable();
  await expect(editor).toHaveValue(writing.body);
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await expect(live(page, "reference")).toContainText(/remov/i);
  const checklistBox = (await added(page, "checklist").boundingBox())!;
  const writingBox = (await live(page, "writing").boundingBox())!;
  expect(checklistBox.y).toBeLessThan(writingBox.y);
  expect(await calls(page)).toEqual({ keep: 0, dismiss: 0, changes: [] });
});

test("the App keeps an addition in place for review and applies it through the host", async ({
  page,
}) => {
  const output = await build({
    entryPoints: ["tests/desktop-focus/renderer-fixture.tsx"],
    bundle: true,
    write: false,
    outfile: "canvas-addition-app-fixture.js",
    format: "iife",
    globalName: "RendererFixture",
    jsx: "automatic",
    loader: { ".woff2": "dataurl", ".woff": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  type Fixtures = typeof import("./renderer-fixture");
  type AppWindow = Window & {
    RendererFixture: Fixtures;
    fixture: ReturnType<Fixtures["mountAppFixture"]>;
    additionResponse: IntentResponse;
    directCanvasWrites: number;
  };
  const appProposal: IntentProposal = {
    ...proposal,
    canvas: { ...before, blocks: [...before.blocks, design] },
  };
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({
    content:
      styles +
      output.outputFiles.find((file) => file.path.endsWith(".css"))!.text,
  });
  await page.addScriptTag({
    content: output.outputFiles.find((file) => file.path.endsWith(".js"))!.text,
  });
  await page.evaluate((document) => {
    const w = window as unknown as AppWindow;
    const fixture = (w.fixture = w.RendererFixture.mountAppFixture(
      window.document.getElementById("root")!,
      "note",
    ));
    fixture.patchTask("note-a", {
      canvas: { document, revision: 3, updatedAt: 1 },
      checkpoint: {
        layout: "work",
        selectedActivity: "canvas",
        returnAnchors: [],
        revision: 0,
        updatedAt: 1,
      },
    });
    w.directCanvasWrites = 0;
    const dispatch = window.eve.dispatch;
    window.eve.dispatch = (command) => {
      if (command.type === "UpdateCanvas") w.directCanvasWrites++;
      return dispatch(command);
    };
    window.eve.applyProposal = async (input) => {
      fixture.proposalCalls.push({ ...input, operation: "apply" });
      const response = w.additionResponse;
      const proposed = response.proposals.find(
        (item) => item.id === input.proposalId,
      )!;
      fixture.patchTask("note-a", {
        canvas: { document: proposed.canvas!, revision: 4, updatedAt: 2 },
      });
      return {
        ...response,
        proposals: response.proposals.map((item) => ({
          ...item,
          status: "applied" as const,
        })),
      };
    };
  }, before);
  const editor = live(page, "writing").getByRole("textbox", {
    name: "Working draft text",
    exact: true,
  });
  await expect(editor).toHaveValue(writing.body);
  const original = await editor.elementHandle();
  const prompt = page.getByRole("textbox", { name: "Ask Eve", exact: true });
  await prompt.fill("Add a graphic for review without applying it.");
  await prompt.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as AppWindow).fixture.asks.length),
    )
    .toBe(1);
  await expect(
    page.getByRole("form", { name: "Ask Eve", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".canvas-response")).toHaveCount(0);
  await page.evaluate((proposal) => {
    const w = window as unknown as AppWindow;
    const response: IntentResponse = {
      ...w.fixture.asks.at(-1)!,
      status: "complete",
      message: "The graphic is ready to review.",
      basis: "general",
      citations: [],
      proposals: [proposal],
    };
    w.additionResponse = response;
    w.fixture.publishIntelligence({ type: "intent", response });
  }, appProposal);
  await expect(added(page, "design").locator(".design-stage")).toBeVisible();
  await expect(page.locator(".canvas-suggestion-preview")).toHaveCount(0);
  await expect(
    page.getByRole("form", { name: "Ask Eve", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      writes: (window as unknown as AppWindow).directCanvasWrites,
      calls: (window as unknown as AppWindow).fixture.proposalCalls,
    })),
  ).toEqual({ writes: 0, calls: [] });
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(2, 7, "backward"),
  );
  await added(page, "design")
    .getByRole("button", { name: "Keep", exact: true })
    .click();
  await expect(live(page, "design").locator(".design-stage")).toBeVisible();
  await expect(added(page, "design")).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual([2, 7, "backward"]);
  expect(
    await page.evaluate(() => ({
      writes: (window as unknown as AppWindow).directCanvasWrites,
      calls: (window as unknown as AppWindow).fixture.proposalCalls,
    })),
  ).toMatchObject({
    writes: 0,
    calls: [{ proposalId: "additions", operation: "apply" }],
  });
});

test("expired, nonready, and mismatched-baseline proposals cannot be kept", async ({
  page,
}) => {
  await mount(page);
  for (const invalid of [
    { ...proposal, expiresAt: Date.now() - 1 },
    { ...proposal, status: "applying" as const },
    { ...proposal, status: "stale" as const },
    {
      ...proposal,
      beforeCanvas: {
        ...before,
        blocks: [{ ...writing, body: "An older draft." }, reference],
      },
    },
  ]) {
    await setReview(page, invalid);
    await cannotKeep(
      page
        .getByRole("button", { name: /^(Keep(?: all changes)?|Keeping…)$/ })
        .first(),
    );
    expect((await calls(page)).keep).toBe(0);
  }
  expect((await calls(page)).changes).toEqual([]);
});

for (const width of [1280, 390]) {
  test(`a proposed design keeps its exact artboard and heading geometry after approval at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const review: IntentProposal = {
      ...proposal,
      canvas: { ...before, blocks: [...before.blocks, design] },
    };
    await mount(page, review);
    const editor = live(page, "writing").getByRole("textbox", {
      name: "Working draft text",
      exact: true,
    });
    const original = await editor.elementHandle();
    const geometry = (block: Locator) =>
      block.evaluate((node) => {
        return Object.fromEntries(
          [".canvas-block-heading", "h2", ".design-paper", ".design-stage"].map(
            (selector) => {
              const rect = node
                .querySelector(selector)!
                .getBoundingClientRect();
              return [
                selector,
                {
                  x: rect.x + window.scrollX,
                  y: rect.y + window.scrollY,
                  width: rect.width,
                  height: rect.height,
                },
              ];
            },
          ),
        );
      });
    await expect(added(page, "design").locator(".design-stage")).toBeVisible();
    // Settle the shared design renderer's initial fit measurement before comparing.
    await expect
      .poll(() =>
        added(page, "design")
          .locator(".design-stage")
          .evaluate((node) => node.getBoundingClientRect().width),
      )
      .toBeGreaterThan(250);
    const proposedGeometry = await geometry(added(page, "design"));
    await mkdir(".runtime/canvas-input-inline-preview", { recursive: true });
    await page.screenshot({
      path: resolve(
        `.runtime/canvas-input-inline-preview/design-proposed-${width}.png`,
      ),
      fullPage: true,
    });
    await editor.focus();
    await editor.evaluate((node: HTMLTextAreaElement) =>
      node.setSelectionRange(2, 8, "backward"),
    );
    await added(page, "design")
      .getByRole("button", { name: "Keep", exact: true })
      .click();
    expect((await calls(page)).keep).toBe(1);
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).completeAdditionReview(),
    );
    await expect(added(page, "design")).toHaveCount(0);
    await expect
      .poll(() => geometry(live(page, "design")))
      .toEqual(proposedGeometry);
    expect(
      await editor.evaluate((node, previous) => node === previous, original),
    ).toBe(true);
    await expect(editor).toBeFocused();
    expect(
      await editor.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
        node.selectionDirection,
      ]),
    ).toEqual([2, 8, "backward"]);
    expect((await calls(page)).changes).toEqual([]);
    await noHorizontalOverflow(page);
  });
}

test("an addition with a timeline placement change previews the panoramic timeline while retaining the original", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const timeline: Extract<CanvasBlock, { kind: "timeline" }> = {
    ...base,
    id: "schedule",
    kind: "timeline",
    title: "Observation schedule",
    date: "Saturday",
    startHour: 8,
    endHour: 18,
    items: [
      {
        id: "first",
        title: "Morning observation",
        startMinutes: 540,
        endMinutes: 600,
        detail: "Record the first session.",
        status: "planned",
      },
      {
        id: "second",
        title: "Afternoon observation",
        startMinutes: 840,
        endMinutes: 900,
        detail: "Compare both sessions.",
        status: "planned",
      },
    ],
  };
  const baseline: CanvasDocument = {
    ...before,
    layout: "split",
    blocks: [writing, timeline, reference],
  };
  await mount(page, null, baseline);
  const editor = live(page, "writing").getByRole("textbox", {
    name: "Working draft text",
    exact: true,
  });
  const originalEditor = await editor.elementHandle();
  const originalTimeline = live(page, "schedule").locator(
    ":scope > .canvas-timeline",
  );
  const timelineIdentity = await originalTimeline.elementHandle();
  await expect(originalTimeline).toHaveAttribute("data-panoramic", "false");
  await expect(originalTimeline.locator(".canvas-timeline-item")).toHaveCount(
    2,
  );
  await setReview(page, {
    ...proposal,
    beforeCanvas: baseline,
    canvas: {
      ...baseline,
      blocks: [
        writing,
        { ...timeline, placement: "full" },
        reference,
        checklist,
      ],
    },
  });
  await expect(added(page, "checklist")).toBeVisible();
  const projected = added(page, "schedule");
  await expect(projected).toHaveAttribute("data-placement", "full");
  await expect(projected.locator(".canvas-timeline")).toHaveAttribute(
    "data-panoramic",
    "true",
  );
  await expect(
    projected.getByLabel("Day at a glance", { exact: true }),
  ).toBeVisible();
  await expect(
    projected.getByRole("button", {
      name: "Show Afternoon observation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(originalTimeline).toHaveAttribute("data-panoramic", "false");
  await expect(originalTimeline.locator(".canvas-timeline-item")).toHaveCount(
    2,
  );
  expect(
    await originalTimeline.evaluate(
      (node, previous) => node === previous,
      timelineIdentity,
    ),
  ).toBe(true);
  expect(
    await editor.evaluate(
      (node, previous) => node === previous,
      originalEditor,
    ),
  ).toBe(true);
  await expect(
    projected.getByRole("button", { name: "Keep all changes", exact: true }),
  ).toBeVisible();
  expect(await calls(page)).toEqual({ keep: 0, dismiss: 0, changes: [] });
});
