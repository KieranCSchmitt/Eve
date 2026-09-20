import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasDocument } from "@eve/contracts";

// Invented ceramic-studio measurements are browser fixtures only. These are
// arbitrary compositions of shared primitives, never production templates.
const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const studio: CanvasDocument = {
  version: 1,
  title: "A little science. A little alchemy.",
  subtitle: "Studio firing notebook · illustrative measurements for this test.",
  layout: "split",
  blocks: [
    {
      ...base,
      id: "heat-curve",
      kind: "chart",
      title: "Inside the kiln",
      tableId: "heat",
      chartType: "line",
      labelColumn: 0,
      valueColumns: [1, 2],
    },
    {
      ...base,
      id: "yield",
      kind: "metric",
      title: "Ash wash · first quality",
      placement: "aside",
      tableId: "batches",
      rowId: "ash",
      column: 3,
      prefix: "",
      suffix: "%",
      decimals: 1,
    },
    {
      ...base,
      id: "notes",
      kind: "text",
      title: "Notes from the firing",
      placement: "aside",
      body: "A soft satin surface, with a little movement at the rim. Keep one piece from each batch for the studio shelf.\n\nNext time, compare the same glaze on a thinner body.",
    },
    {
      ...base,
      id: "batch-chart",
      kind: "chart",
      title: "Pieces kept by glaze",
      tableId: "batches",
      chartType: "bar",
      labelColumn: 0,
      valueColumns: [2],
    },
    {
      ...base,
      id: "heat",
      kind: "table",
      title: "Firing measurements",
      placement: "full",
      columns: ["Stage", "Target °C", "Measured °C"],
      rows: [
        { id: "room", cells: ["Room", "20", "22"] },
        { id: "drying", cells: ["Drying", "120", "118"] },
        { id: "quartz", cells: ["Quartz", "573", "569"] },
        { id: "ramp", cells: ["Ramp", "960", "952"] },
        { id: "peak", cells: ["Peak", "1240", "1236"] },
        { id: "hold", cells: ["Hold", "1240", "1242"] },
      ],
    },
    {
      ...base,
      id: "batches",
      kind: "table",
      title: "Glaze batches",
      placement: "full",
      columns: ["Glaze", "Fired", "Kept", "Yield %"],
      rows: [
        { id: "cloud", cells: ["Cloud glaze", "24", "22", "=C1/B1*100"] },
        { id: "iron", cells: ["Iron slip", "18", "15", "=C2/B2*100"] },
        { id: "ash", cells: ["Ash wash", "30", "28", "=C3/B3*100"] },
        { id: "cobalt", cells: ["Cobalt rim", "16", "16", "=C4/B4*100"] },
      ],
    },
  ],
};
type FixtureWindow = Window & {
  mountDataViews(document: CanvasDocument): void;
  dataDocument: CanvasDocument;
  dataChanges: CanvasDocument[];
  setDataDocument(document: CanvasDocument): void;
  setDataDisabled(disabled: boolean): void;
};
let script: string;
let styles: string;

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Search } from 'lucide-react';
      import { Canvas } from './apps/desktop/renderer/src/components/Canvas';
      import { Logo } from './apps/desktop/renderer/src/Logo';
      import { canvasDocumentSchema } from './packages/contracts/src/canvas';
      window.dataChanges = [];
      function Fixture({initial}) {
        const [document,setDocument] = useState(initial);
        const [disabled,setDisabled] = useState(false);
        window.dataDocument = document;
        window.setDataDocument = next => {canvasDocumentSchema.parse(next);setDocument(next)};
        window.setDataDisabled = setDisabled;
        return <div className="data-views-fixture">
          <header className="shell-header"><button className="brand-button" aria-label="Fixture home"><Logo/><span className="brand-dot"/></button><div className="purpose"><span className="purpose-name">Studio notes</span></div></header>
          <main className="workspace canvas-workspace"><Canvas document={document} disabled={disabled} assets={[]} sources={[]}
            onChange={next=>{canvasDocumentSchema.parse(next);window.dataChanges.push(next);setDocument(next)}} /></main>
          <footer className="data-views-fixture-footer"><Search size={16}/>Find anything</footer>
        </div>;
      }
      window.mountDataViews = initial => {canvasDocumentSchema.parse(initial);createRoot(document.getElementById('root')).render(<Fixture initial={initial}/>)};
    `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-data-views-fixture.js",
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
    body{background:var(--paper)}.data-views-fixture{min-height:100vh}.data-views-fixture-footer{display:flex;align-items:center;gap:12px;padding:20px 38px;color:var(--muted);font-size:12px}
    @media(max-width:540px){.data-views-fixture .purpose{display:none}}
  `;
});

async function mount(page: Page, document: CanvasDocument = studio) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (document) => (window as unknown as FixtureWindow).mountDataViews(document),
    document,
  );
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.evaluate(async () => {
    await window.document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
const data = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).dataDocument);
const block = (page: Page, id: string) =>
  page.locator(`.canvas-layout-slot[data-block-id="${id}"]`);

async function expectClearGeometry(page: Page) {
  await expect
    .poll(() =>
      page.locator(".canvas-block").evaluateAll((nodes) => {
        const boxes = nodes.map((node) => ({
          name: node.getAttribute("aria-label"),
          box: node.getBoundingClientRect(),
        }));
        const collisions: string[] = [];
        for (let a = 0; a < boxes.length; a++)
          for (let b = a + 1; b < boxes.length; b++) {
            const first = boxes[a]!,
              second = boxes[b]!;
            if (
              Math.min(first.box.right, second.box.right) -
                Math.max(first.box.left, second.box.left) >
                1 &&
              Math.min(first.box.bottom, second.box.bottom) -
                Math.max(first.box.top, second.box.top) >
                1
            )
              collisions.push(`${first.name}/${second.name}`);
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

test("a five-column table scrolls locally at 390px without leaking its accessible row-actions header into the workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, {
    version: 1,
    title: "Printing notes",
    subtitle: "Synthetic narrow-table boundary check.",
    layout: "focus",
    blocks: [
      {
        ...base,
        id: "quotes",
        kind: "table",
        title: "Quotes to compare",
        columns: [
          "Supplier",
          "Copies",
          "Print cost",
          "Display sheets",
          "Notes",
        ],
        rows: [
          { id: "q1", cells: ["Workshop", "60", "", "", "Confirm stock"] },
        ],
      },
    ],
  });
  const table = block(page, "quotes");
  const scroller = table.locator(".canvas-table-scroll");
  const last = table.getByRole("textbox", { name: "E1: Notes", exact: true });
  const original = await last.elementHandle();
  await expect(
    table.getByRole("columnheader", { name: "Row actions", exact: true }),
  ).toHaveCount(1);
  const initial = await page
    .locator(".workspace")
    .evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  expect(initial.scrollWidth).toBeLessThanOrEqual(initial.width + 1);
  expect(
    await scroller.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const bounds = await scroller.boundingBox();
  const cell = await last.boundingBox();
  expect(cell!.x).toBeGreaterThanOrEqual(bounds!.x);
  expect(cell!.x + cell!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  await last.click();
  await last.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText(" later");
  await expect(last).toHaveValue("Confirm stock later");
  await expect(last).toBeFocused();
  expect(
    await last.evaluate((element, previous) => element === previous, original),
  ).toBe(true);
  await last.press("ControlOrMeta+z");
  await expect(last).toHaveValue("Confirm stock");
  expect(
    await page
      .locator(".workspace")
      .evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth + 1 &&
          element.scrollLeft === 0,
      ),
  ).toBe(true);
  expect((await data(page)).blocks[0]).toMatchObject({
    rows: [{ id: "q1", cells: ["Workshop", "60", "", "", "Confirm stock"] }],
  });
});

test("editing a source recalculates the plotted values and formula metric while preserving input identity, caret, and native Undo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  const source = block(page, "batches").getByRole("textbox", {
    name: "C3: Kept",
    exact: true,
  });
  const original = await source.elementHandle();
  await expect(block(page, "yield")).toContainText("93.3%");
  await source.focus();
  await source.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.insertText("0");
  await expect(source).toHaveValue("280");
  await expect(block(page, "yield")).toContainText("933.3%");
  await expect(
    block(page, "batch-chart").getByRole("button", { name: /Ash wash.*280/ }),
  ).toBeVisible();
  expect(
    await source.evaluate(
      (element, previous) => element === previous,
      original,
    ),
  ).toBe(true);
  await expect(source).toBeFocused();
  expect(
    await source.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([3, 3]);
  await source.press("ControlOrMeta+z");
  await expect(source).toHaveValue("28");
  await expect(block(page, "yield")).toContainText("93.3%");
  await expect(
    block(page, "batch-chart").getByRole("button", { name: /Ash wash.*28/ }),
  ).toBeVisible();
  await source.press("ControlOrMeta+Shift+z");
  await expect(source).toHaveValue("280");
  expect(
    (await data(page)).blocks.find((item) => item.id === "batches"),
  ).toMatchObject({
    rows: [
      expect.anything(),
      expect.anything(),
      { id: "ash", cells: ["Ash wash", "30", "280", "=C3/B3*100"] },
      expect.anything(),
    ],
  });
});

test("charts and key figures start unbound and become useful through local controls without authored example values", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, {
    ...studio,
    blocks: studio.blocks.filter(
      (item) => item.id === "notes" || item.id === "batches",
    ),
  });
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("button", { name: "Add chart", exact: true }).click();
  await page
    .getByRole("button", { name: "Add key figure", exact: true })
    .click();
  const afterAdd = await data(page);
  expect(afterAdd.blocks.slice(-2)).toMatchObject([
    { kind: "chart", tableId: null, valueColumns: [] },
    { kind: "metric", tableId: null, rowId: null },
  ]);
  const chart = block(page, afterAdd.blocks.at(-2)!.id);
  const metric = block(page, afterAdd.blocks.at(-1)!.id);
  await chart
    .getByLabel("Chart table", { exact: true })
    .selectOption("batches");
  await chart.getByLabel("Label column", { exact: true }).selectOption("0");
  await chart.getByRole("checkbox", { name: "Plot Kept", exact: true }).check();
  await chart.getByRole("button", { name: "Line", exact: true }).click();
  expect((await data(page)).blocks.at(-2)).toMatchObject({
    kind: "chart",
    tableId: "batches",
    labelColumn: 0,
    valueColumns: [2],
    chartType: "line",
  });
  await metric
    .getByLabel("Metric table", { exact: true })
    .selectOption("batches");
  await metric.getByLabel("Metric row", { exact: true }).selectOption("ash");
  await metric.getByLabel("Metric column", { exact: true }).selectOption("3");
  await metric.getByLabel("Suffix", { exact: true }).fill("%");
  await metric.getByLabel("Decimal places", { exact: true }).selectOption("1");
  await expect(metric).toContainText("93.3%");
  expect((await data(page)).blocks.at(-1)).toMatchObject({
    tableId: "batches",
    rowId: "ash",
    column: 3,
    suffix: "%",
    decimals: 1,
  });
  expect(afterAdd.blocks.filter((item) => item.kind === "table")).toEqual(
    studio.blocks.filter((item) => item.id === "batches"),
  );
});

test("a metric follows row identity through reordering, clears a deleted row, and table deletion detaches linked views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, {
    ...studio,
    blocks: studio.blocks.map((item) =>
      item.kind === "metric"
        ? { ...item, column: 2, suffix: " pieces", decimals: 0 }
        : item,
    ),
  });
  const metric = block(page, "yield");
  await expect(metric).toContainText("28 pieces");
  const previous = await data(page);
  await page.evaluate(
    (next) => (window as unknown as FixtureWindow).setDataDocument(next),
    {
      ...previous,
      blocks: previous.blocks.map((item) =>
        item.kind === "table" && item.id === "batches"
          ? {
              ...item,
              rows: [
                item.rows[2]!,
                item.rows[0]!,
                item.rows[1]!,
                item.rows[3]!,
              ],
            }
          : item,
      ),
    },
  );
  await expect(metric).toContainText("28 pieces");
  await block(page, "batches")
    .getByRole("button", { name: "Remove row 1", exact: true })
    .click();
  expect(
    (await data(page)).blocks.find((item) => item.id === "yield"),
  ).toMatchObject({ tableId: "batches", rowId: null });
  await expect(metric).not.toContainText("28 pieces");
  await page
    .getByRole("button", { name: "Remove Glaze batches block", exact: true })
    .click();
  expect(
    (await data(page)).blocks.find((item) => item.id === "yield"),
  ).toMatchObject({ tableId: null, rowId: null });
  expect(
    (await data(page)).blocks.find((item) => item.id === "batch-chart"),
  ).toMatchObject({ tableId: null });
  await metric
    .getByLabel("Configure Ash wash · first quality", { exact: true })
    .click();
  await metric.getByLabel("Metric table", { exact: true }).selectOption("heat");
  await metric.getByLabel("Metric row", { exact: true }).selectOption("peak");
  await metric.getByLabel("Metric column", { exact: true }).selectOption("2");
  await metric.getByLabel("Suffix", { exact: true }).fill(" °C");
  await expect(metric).toContainText("1,236 °C");
  await expectClearGeometry(page);
});

test("disabled data views expose their exact values but cannot edit bindings or data", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  await block(page, "batch-chart")
    .getByLabel("Configure Pieces kept by glaze", { exact: true })
    .click();
  await block(page, "yield")
    .getByLabel("Configure Ash wash · first quality", { exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setDataDisabled(true),
  );
  for (const control of await page
    .locator(".canvas-block input, .canvas-block select")
    .all()) {
    if ((await control.getAttribute("readonly")) !== null)
      await expect(control).not.toBeEditable();
    else await expect(control).toBeDisabled();
  }
  await expect(block(page, "yield")).toContainText("93.3%");
  await expect(
    block(page, "batch-chart").getByRole("button", {
      name: "Line",
      exact: true,
    }),
  ).toBeDisabled();
  await block(page, "batch-chart")
    .getByRole("button", { name: "Line", exact: true })
    .click({ force: true });
  const suffix = block(page, "yield").getByLabel("Suffix", { exact: true });
  await suffix.focus();
  await page.keyboard.insertText("changed");
  await expect(suffix).toHaveValue("%");
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).dataChanges),
  ).toEqual([]);
});

test("table actions create linked views of existing data without copying values", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, {
    ...studio,
    blocks: studio.blocks.filter((item) => item.id === "batches"),
  });
  const source = block(page, "batches");
  await source
    .getByRole("button", { name: "Visualize table", exact: true })
    .click();
  await source
    .getByRole("button", { name: "Highlight a value", exact: true })
    .click();
  const document = await data(page);
  expect(document.blocks).toHaveLength(3);
  expect(document.blocks[0]).toEqual(
    studio.blocks.find((item) => item.id === "batches"),
  );
  expect(document.blocks[1]).toMatchObject({
    kind: "chart",
    tableId: "batches",
    valueColumns: [1],
  });
  expect(document.blocks[2]).toMatchObject({
    kind: "metric",
    tableId: "batches",
    rowId: null,
  });
  const metric = block(page, document.blocks[2]!.id);
  await metric.getByLabel("Metric row", { exact: true }).selectOption("cloud");
  await expect(metric.locator(".canvas-metric-value")).toHaveText("24");
  await source
    .getByRole("textbox", { name: "B1: Fired", exact: true })
    .fill("25");
  await expect(metric.locator(".canvas-metric-value")).toHaveText("25");
  await expect(
    block(page, document.blocks[1]!.id).getByRole("button", {
      name: /Cloud glaze.*25/,
    }),
  ).toBeVisible();
});

test("blank and failed cells remain visibly missing while an actual zero remains a number", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  const input = block(page, "batches").getByRole("textbox", {
    name: "C3: Kept",
    exact: true,
  });
  const metric = block(page, "yield");
  const chart = block(page, "batch-chart");
  for (const value of ["", "=1/0", "not measured"]) {
    await input.fill(value);
    await expect(metric).not.toContainText("0.0%");
    await expect(metric.locator(".canvas-metric-value")).toHaveText("—");
    const missingRow = chart.getByRole("button", {
      name: /Ash wash.*(?:no value|not numeric)/i,
    });
    await expect(missingRow).toBeVisible();
    await expect(missingRow.locator("[data-value]")).toHaveCount(0);
  }
  await input.fill("0");
  await expect(metric).toContainText("0.0%");
  await expect(
    chart.getByRole("button", { name: /Ash wash.*0/ }),
  ).toBeVisible();
  await expect(
    chart
      .getByRole("button", { name: /Ash wash.*0/ })
      .locator('[data-value="0"]'),
  ).toHaveCount(1);
  await expectClearGeometry(page);
});

test("keyboard chart selection reveals the exact values and can open its source table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  const chart = block(page, "heat-curve");
  const peak = chart.getByRole("button", { name: /Peak.*1,?240.*1,?236/ });
  await peak.focus();
  await peak.press("Enter");
  await expect(peak).toHaveAttribute("aria-pressed", "true");
  await chart.getByText("View chart data", { exact: true }).click();
  const row = chart.getByRole("row").filter({ hasText: "Peak" });
  await expect(row).toContainText(/1,?240/);
  await expect(row).toContainText(/1,?236/);
  await chart
    .getByRole("button", { name: "Edit chart data", exact: true })
    .click();
  await expect(
    block(page, "heat").getByRole("textbox", {
      name: "B5: Target °C",
      exact: true,
    }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).dataChanges),
  ).toEqual([]);
});

test("extreme finite, negative-only, and zero data stay readable and geometrically finite with long labels at 390px", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const enormous = "1" + "0".repeat(308);
  const column =
    "Measured_temperature_at_the_middle_shelf_in_degrees_Celsius_for_this_firing";
  const label =
    "A very long category name for the far edge of the kiln shelf, kept in full for inspection";
  const makeDocument = (values: string[]): CanvasDocument => ({
    version: 1,
    title: "Range and precision",
    subtitle: "Synthetic display boundary checks.",
    layout: "split",
    blocks: [
      {
        ...base,
        id: "edge-chart",
        kind: "chart",
        title: "A range worth inspecting",
        tableId: "edge-table",
        chartType: "line",
        labelColumn: 0,
        valueColumns: [1],
      },
      {
        ...base,
        id: "edge-metric",
        kind: "metric",
        title: "The final exact reading",
        placement: "aside",
        tableId: "edge-table",
        rowId: "r2",
        column: 1,
        prefix: "Long prefix",
        suffix: " units for this reading",
        decimals: 2,
      },
      {
        ...base,
        id: "edge-table",
        kind: "table",
        title: "Raw measurements",
        placement: "full",
        columns: ["Category", column],
        rows: values.map((value, index) => ({
          id: `r${index}`,
          cells: [`${label} ${index + 1}`, value],
        })),
      },
    ],
  });
  await mount(page, makeDocument([`-${enormous}`, "0", enormous]));
  for (const [name, values, exact, formatted] of [
    ["extremes", [`-${enormous}`, "0", enormous], "1e+308", "1.00E308"],
    ["negative-only", ["-31", "-18", "-5"], "-5", "-5.00"],
    ["all-zero", ["0", "0", "0"], "0", "0.00"],
  ] as const) {
    if (name !== "extremes")
      await page.evaluate(
        (next) => (window as unknown as FixtureWindow).setDataDocument(next),
        makeDocument([...values]),
      );
    const chart = block(page, "edge-chart");
    const last = chart.locator('.canvas-chart-row[data-row-id="r2"]');
    await last.focus();
    await last.press("Enter");
    await expect(
      chart.getByRole("group", { name: "Selected chart row", exact: true }),
    ).toContainText(exact);
    expect(
      await chart
        .getByRole("group", { name: "Selected chart row", exact: true })
        .evaluate((element) => {
          const card = element.getBoundingClientRect();
          return [
            ...element.querySelectorAll("strong, div > span > span"),
          ].every((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= card.left && box.right <= card.right;
          });
        }),
      "Exact chart values and their full column labels must stay readable inside the inspector",
    ).toBe(true);
    await expect(
      block(page, "edge-metric").locator(".canvas-metric-value"),
    ).toHaveText(formatted);
    for (const type of ["Bars", "Line"]) {
      await chart.getByRole("button", { name: type, exact: true }).click();
      const invalid = await chart
        .locator(".canvas-chart-graphic *")
        .evaluateAll((nodes) =>
          nodes.flatMap((node) =>
            [...node.attributes].flatMap((attribute) => {
              if (attribute.name === "d")
                return /NaN|Infinity/.test(attribute.value) ||
                  (
                    attribute.value.match(
                      /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi,
                    ) ?? []
                  ).some((value) => !Number.isFinite(Number(value)))
                  ? [attribute.value]
                  : [];
              return [
                "x",
                "y",
                "x1",
                "x2",
                "y1",
                "y2",
                "height",
                "width",
                "cx",
                "cy",
                "r",
              ].includes(attribute.name) &&
                !Number.isFinite(Number(attribute.value))
                ? [`${attribute.name}=${attribute.value}`]
                : [];
            }),
          ),
        );
      expect(invalid).toEqual([]);
      await expectClearGeometry(page);
    }
    const metricBounds = await block(page, "edge-metric").evaluate(
      (element) => {
        const bounds = element.getBoundingClientRect();
        return [
          ...element.querySelectorAll(
            ".canvas-metric-value,.canvas-metric-prefix,.canvas-metric-suffix",
          ),
        ].every((node) => {
          const box = node.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      },
    );
    expect(metricBounds).toBe(true);
    if (name === "extremes")
      await page.screenshot({
        path: info.outputPath("extreme-data-390.png"),
        fullPage: true,
      });
  }
});

for (const width of [1280, 390]) {
  test(`ceramic studio combines linked line, bar, metric, writing, and tables at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page);
    await expect(block(page, "yield")).toContainText("93.3%");
    await expect(
      block(page, "heat-curve").locator(".canvas-chart-graphic"),
    ).toBeVisible();
    await expect(
      block(page, "batch-chart").locator(".canvas-chart-graphic"),
    ).toBeVisible();
    await expectClearGeometry(page);
    expect(
      await page
        .getByRole("heading", { level: 1 })
        .evaluate((node) => getComputedStyle(node).fontFamily),
    ).toContain("Newsreader Variable");
    await mkdir(".runtime/canvas-data-views", { recursive: true });
    const imagePath = resolve(
      `.runtime/canvas-data-views/ceramic-studio-${width}.png`,
    );
    await page.screenshot({ path: imagePath, fullPage: true });
    await info.attach(`ceramic-studio-${width}`, {
      path: imagePath,
      contentType: "image/png",
    });
    await page.screenshot({
      path: resolve(
        `.runtime/canvas-data-views/ceramic-studio-viewport-${width}.png`,
      ),
    });
  });
}
