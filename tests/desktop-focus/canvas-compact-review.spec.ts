import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileCanvasSuggestion,
  type CanvasBlock,
  type CanvasDocument,
} from "@eve/contracts";
import type { IntentProposal } from "../../apps/desktop/shared/bridge";
import { compactCanvasChange } from "../../apps/desktop/renderer/src/components/compactCanvasChange";

test.use({ timezoneId: "America/New_York", locale: "en-US" });

const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const writing: CanvasBlock = {
  ...base,
  id: "writing",
  kind: "text",
  title: "Workshop notes",
  body: "Leave space for another thought.",
};
const design: Extract<CanvasBlock, { kind: "design" }> = {
  ...base,
  id: "invitation",
  kind: "design",
  title: "Studio gathering",
  width: 800,
  height: 360,
  background: "#F2EDE3",
  layers: [
    {
      id: "title",
      kind: "text",
      name: "Words",
      x: 52,
      y: 44,
      width: 690,
      height: 100,
      text: "Clay, conversation,\nand a little time.",
      fontFamily: "serif",
      fontSize: 43,
      fontWeight: "regular",
      color: "#304644",
      align: "left",
    },
    {
      id: "time",
      kind: "text",
      name: "Words",
      x: 56,
      y: 245,
      width: 600,
      height: 60,
      text: "10:30 AM",
      fontFamily: "sans",
      fontSize: 24,
      fontWeight: "regular",
      color: "#304644",
      align: "left",
    },
  ],
};
const changedDesign: typeof design = {
  ...design,
  layers: design.layers.map((layer) =>
    layer.id === "time" && layer.kind === "text"
      ? { ...layer, text: "11:15 AM" }
      : layer,
  ),
};
const table: Extract<CanvasBlock, { kind: "table" }> = {
  ...base,
  id: "table",
  kind: "table",
  title: "Supplies",
  columns: ["Material", "Cost"],
  rows: [
    { id: "clay", cells: ["Clay", "$18"] },
    { id: "glaze", cells: ["Glaze", "$12"] },
  ],
};
const timer: Extract<CanvasBlock, { kind: "timer" }> = {
  ...base,
  id: "timer",
  kind: "timer",
  title: "Let it rest",
  durationSeconds: 480,
  remainingSeconds: 480,
  endsAt: null,
};
const deadline: Extract<CanvasBlock, { kind: "deadline" }> = {
  ...base,
  id: "due",
  kind: "deadline",
  title: "Send invitation",
  dueAt: 1790000000123,
};
function proposalFor(
  previous: CanvasBlock,
  next: CanvasBlock,
  extra: CanvasBlock[] = [writing],
): IntentProposal {
  const suggestion = {
    id: "prepared-small-change",
    label: "A revised detail",
    description: "Review a small change in context.",
    request: "Review the exact prepared change.",
    targetBlockId: previous.id,
    prepared: {
      before: [previous],
      edits: [{ type: "replace" as const, block: next }],
    },
  };
  const before: CanvasDocument = {
    version: 1,
    title: "An open afternoon",
    subtitle: "A little room to make things together.",
    layout: "focus",
    blocks: [...extra.filter((block) => block.id !== previous.id), previous],
    suggestions: [suggestion],
  };
  return {
    id: "compact-review",
    kind: "canvas",
    label: "Model-authored label does not describe the actual values",
    summary: "This prose is not a field diff.",
    status: "ready",
    expiresAt: 4102444800000,
    preparedSuggestionId: suggestion.id,
    beforeCanvas: before,
    canvas: {
      ...before,
      blocks: before.blocks.map((block) =>
        block.id === previous.id ? next : block,
      ),
      suggestions: [],
    },
  };
}
const initial = proposalFor(design, changedDesign);

test("compact eligibility derives complete values for supported exact replacements", () => {
  expect(
    compactCanvasChange(writing, { ...writing, body: "An extra thought." }),
  ).toEqual({
    field: "Writing",
    before: writing.body,
    after: "An extra thought.",
  });
  const note: CanvasBlock = {
    ...base,
    kind: "note",
    id: "note",
    title: "Note",
    description: "First line\nSecond line",
  };
  expect(
    compactCanvasChange(note, {
      ...note,
      description: "First line\nAnother line",
    }),
  ).toMatchObject({
    before: "First line\nSecond line",
    after: "First line\nAnother line",
  });
  expect(
    compactCanvasChange(table, {
      ...table,
      rows: [{ id: "clay", cells: ["Clay", "$24.50"] }, table.rows[1]!],
    }),
  ).toEqual({ field: "Cell B1 · Cost", before: "$18", after: "$24.50" });
  expect(
    compactCanvasChange(timer, {
      ...timer,
      durationSeconds: 615,
      remainingSeconds: 615,
    }),
  ).toEqual({
    field: "Duration and time remaining",
    before: "8 min",
    after: "10 min 15 sec",
    note: "Timer stays stopped.",
  });
  const preciseDeadline = compactCanvasChange(deadline, {
    ...deadline,
    dueAt: deadline.dueAt! + 1,
  })!;
  expect(preciseDeadline.field).toBe("Deadline");
  expect(preciseDeadline.before).toMatch(/20\.123.*GMT/);
  expect(preciseDeadline.after).toMatch(/20\.124.*GMT/);
  expect(compactCanvasChange(design, changedDesign)).toEqual({
    field: "Text layer 2 · Words",
    before: "10:30 AM",
    after: "11:15 AM",
  });
  expect(compactCanvasChange(writing, { ...writing, body: "" })).toMatchObject({
    after: "",
  });
});

test("compact eligibility rejects extra fields, collection drift, formulas, long values and opaque whitespace", () => {
  for (const override of [
    { id: "different" },
    { title: "Changed too" },
    { pinned: true },
    { sourceIds: ["source"] },
    { placement: "aside" as const },
  ]) {
    expect(
      compactCanvasChange(writing, {
        ...writing,
        body: "Changed",
        ...override,
      }),
    ).toBeNull();
  }
  for (const body of [
    "x".repeat(161),
    "x\nx\nx\nx",
    " trailing ",
    "\tindent",
    "line\r\nbreak",
  ])
    expect(compactCanvasChange(writing, { ...writing, body })).toBeNull();
  expect(
    compactCanvasChange(writing, {
      ...writing,
      body: writing.body.replace("space ", "space\n"),
    }),
  ).toBeNull();
  expect(
    compactCanvasChange(timer, { ...timer, durationSeconds: 615 }),
  ).toBeNull();
  expect(
    compactCanvasChange(timer, { ...timer, endsAt: 1790000000000 }),
  ).toBeNull();
  expect(
    compactCanvasChange(table, {
      ...table,
      rows: [{ id: "clay", cells: ["New material", "$24"] }, table.rows[1]!],
    }),
  ).toBeNull();
  expect(
    compactCanvasChange(table, { ...table, rows: [...table.rows].reverse() }),
  ).toBeNull();
  const formula = {
    ...table,
    rows: [table.rows[0]!, { id: "formula", cells: ["Total", "=B1"] }],
  };
  expect(
    compactCanvasChange(formula, {
      ...formula,
      rows: [{ id: "clay", cells: ["Clay", "$24"] }, formula.rows[1]!],
    }),
  ).toBeNull();
  expect(
    compactCanvasChange(design, {
      ...changedDesign,
      layers: changedDesign.layers.map((layer) =>
        layer.id === "time" ? { ...layer, x: 80 } : layer,
      ),
    }),
  ).toBeNull();
  expect(
    compactCanvasChange(design, {
      ...changedDesign,
      layers: [...changedDesign.layers].reverse(),
    }),
  ).toBeNull();
  expect(
    compactCanvasChange(design, { ...changedDesign, background: "#ffffff" }),
  ).toBeNull();
});

type FixtureWindow = Window & {
  mountCompact(proposal: IntentProposal): void;
  updateProposal(proposal: IntentProposal): void;
  updateDocument(document: CanvasDocument): void;
  setPreviewVisible(value: boolean): void;
  setReviewDisabled(value: boolean): void;
  setCanvasDisabled(value: boolean): void;
  setRequestPending(value: boolean): void;
  keepCalls: number;
  dismissCalls: number;
  canvasWrites: number;
  requestCalls: number;
};
let script: string, styles: string;
test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
    import {useState} from 'react';import{createRoot}from'react-dom/client';
    import{Canvas}from'./apps/desktop/renderer/src/components/Canvas';
    import{CanvasSuggestionPreview}from'./apps/desktop/renderer/src/components/CanvasSuggestionPreview';
    window.keepCalls=0;window.dismissCalls=0;window.canvasWrites=0;window.requestCalls=0;
    function Fixture({initial}){const [proposal,setProposal]=useState(initial),[document,setDocument]=useState(initial.beforeCanvas),[visible,setVisible]=useState(true),[disabled,setDisabled]=useState(false),[canvasDisabled,setCanvasDisabled]=useState(false),[pending,setPending]=useState(false);window.updateProposal=setProposal;window.updateDocument=setDocument;window.setPreviewVisible=setVisible;window.setReviewDisabled=setDisabled;window.setCanvasDisabled=setCanvasDisabled;window.setRequestPending=setPending;const selected=proposal.beforeCanvas?.suggestions?.find(choice=>choice.id===proposal.preparedSuggestionId);return <main className="compact-fixture"><Canvas document={document} assets={[]} sources={[]} disabled={canvasDisabled} requestPending={pending} onChange={next=>{window.canvasWrites++;setDocument(next)}} onRequestSuggestion={()=>{window.requestCalls++;setVisible(true)}} suggestionPreview={visible?{targetBlockId:initial.beforeCanvas.blocks.at(-1).id,readyChoice:proposal.status==='ready'&&selected?{suggestion:selected,expiresAt:proposal.expiresAt}:undefined,content:<CanvasSuggestionPreview proposal={proposal} assets={[]} sources={[]} disabled={disabled} onKeep={()=>window.keepCalls++} onDismiss={()=>window.dismissCalls++}/>} : undefined}/></main>}
    window.mountCompact=proposal=>createRoot(document.getElementById('root')).render(<Fixture initial={proposal}/>);
  `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "compact-review.js",
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
  styles = `${global}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}\n@font-face{font-family:'Newsreader Variable';font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}.compact-fixture{max-width:1220px;margin:0 auto;padding:28px 36px}@media(max-width:540px){.compact-fixture{padding:20px}}`;
});
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
  });
  await expect
    .poll(() =>
      page
        .locator('[data-testid="canvas-suggestion-preview"]')
        .evaluate((node) => {
          const box = node.getBoundingClientRect(),
            slot = node.closest(".canvas-layout-slot")!.getBoundingClientRect();
          return box.bottom <= slot.bottom + 1;
        }),
    )
    .toBe(true);
}
async function mount(page: Page, proposal = initial) {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (proposal) => (window as unknown as FixtureWindow).mountCompact(proposal),
    proposal,
  );
  await expect(review(page)).toBeVisible();
  await settle(page);
}
const review = (page: Page) =>
  page.getByRole("region", { name: "Suggestion preview", exact: true });
const update = (page: Page, proposal: IntentProposal) =>
  page.evaluate(
    (proposal) => (window as unknown as FixtureWindow).updateProposal(proposal),
    proposal,
  );

const passagePrefix = "My opening stays in my own words. ".repeat(12);
const passageSuffix =
  " The rest of this essay stays exactly where I left it.".repeat(12);
const passageBefore: Extract<CanvasBlock, { kind: "text" }> = {
  ...writing,
  kind: "text",
  body: `${passagePrefix}Let ideas find their way.${passageSuffix}`,
};
const passageAfter = {
  ...passageBefore,
  body: `${passagePrefix}Give ideas room to grow.${passageSuffix}`,
};
const selectedPassage = {
  field: "body" as const,
  start: passagePrefix.length,
  end: passagePrefix.length + "Let ideas find their way.".length,
  text: "Let ideas find their way.",
};

function retiringPassageProposal(): IntentProposal {
  const foreign: Extract<CanvasBlock, { kind: "text" }> = {
    ...base,
    kind: "text",
    id: "other-writing",
    title: "Other observations",
    body: "My later observation stays here.",
  };
  const proposal = proposalFor(passageBefore, passageAfter, [foreign]);
  const before = proposal.beforeCanvas!;
  const chosen = before.suggestions![0]!;
  chosen.textSelection = selectedPassage;
  const previousForeign = { ...foreign, body: "My earlier observation." };
  before.suggestions!.push(
    ...["Find a quieter phrase", "Try another ending"].map((label, index) => ({
      ...structuredClone(chosen),
      id: `alternative-${index}`,
      label,
      prepared: {
        before: [passageBefore],
        edits: [
          {
            type: "replace" as const,
            block: {
              ...passageBefore,
              body: `${passagePrefix}Another direction ${index}.${passageSuffix}`,
            },
          },
        ],
      },
    })),
    {
      id: "outdated-foreign",
      label: "Revisit the earlier observation",
      description: "Review the old wording.",
      request: "Change the earlier observation.",
      targetBlockId: foreign.id,
      prepared: {
        before: [previousForeign],
        edits: [
          {
            type: "replace",
            block: { ...previousForeign, body: "A proposed earlier wording." },
          },
        ],
      },
    },
    {
      id: "keep-general",
      label: "Explore this space",
      description: "An unrelated saved direction.",
      request: "Suggest a direction later.",
      targetBlockId: null,
    },
    {
      id: "keep-valid-foreign",
      label: "Retitle the other observations",
      description: "Review a different title.",
      request: "Change that title.",
      targetBlockId: foreign.id,
      prepared: {
        before: [foreign],
        edits: [
          {
            type: "replace",
            block: { ...foreign, title: "Later observations" },
          },
        ],
      },
    },
  );
  proposal.canvas = compileCanvasSuggestion(before, chosen.id);
  return proposal;
}

for (const width of [1280, 390])
  test(`compact passage review discloses every retired choice without repeating the whole essay at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const proposal = retiringPassageProposal();
    await mount(page, proposal);
    const panel = review(page);
    await expect(panel).toHaveAttribute("data-review-mode", "compact");
    await expect(panel.locator(".suggestion-compact-values del")).toHaveText(
      selectedPassage.text,
    );
    await expect(panel.locator(".suggestion-compact-values ins")).toHaveText(
      "Give ideas room to grow.",
    );
    const disclosure = panel.locator(".suggestion-compact-retirements");
    await expect(disclosure.locator("summary")).toHaveText(
      "Also removes 3 outdated suggestions",
    );
    await panel.scrollIntoViewIfNeeded();
    await expect(
      panel.getByRole("button", { name: "Keep", exact: true }),
    ).toBeInViewport();
    await expect(disclosure.locator("summary")).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`compact-retired-choices-${width}.png`),
      fullPage: false,
    });
    const editor = page.getByRole("textbox", {
      name: "Workshop notes text",
      exact: true,
    });
    const identity = await editor.elementHandle();
    await disclosure.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.locator("li")).toHaveCount(3);
    await expect(disclosure).toContainText("Find a quieter phrase");
    await expect(disclosure).toContainText("Try another ending");
    await expect(disclosure).toContainText("Revisit the earlier observation");
    await expect(disclosure).toContainText("Other observations · Writing");
    await expect(disclosure).not.toContainText(
      "Retitle the other observations",
    );
    await expect(disclosure).not.toContainText("Explore this space");
    await panel
      .getByRole("button", { name: "Inspect full item", exact: true })
      .click();
    await expect(panel.locator(".suggestion-preview-changes")).toContainText(
      "My opening stays in my own words.",
    );
    await panel.locator(".suggestion-preview-next-steps summary").click();
    await expect(panel.locator(".suggestion-preview-next-steps")).toContainText(
      "Explore this space",
    );
    await expect(editor).toHaveValue(passageBefore.body);
    expect(
      await editor.evaluate((node, original) => node === original, identity),
    ).toBe(true);
    await panel
      .getByRole("button", { name: "Close full inspection", exact: true })
      .click();
    await panel.getByRole("button", { name: "Keep", exact: true }).click();
    expect(
      await page.evaluate(() => ({
        keeps: (window as unknown as FixtureWindow).keepCalls,
        writes: (window as unknown as FixtureWindow).canvasWrites,
      })),
    ).toEqual({ keeps: 1, writes: 0 });
  });

test("compact retirement disclosure never hides arbitrary suggestion mutations or valid-choice deletion", async ({
  page,
}) => {
  const original = retiringPassageProposal();
  await mount(page, original);
  const variants: IntentProposal[] = [];
  for (const id of ["keep-general", "keep-valid-foreign"]) {
    const next = structuredClone(original);
    next.canvas!.suggestions = next.canvas!.suggestions!.filter(
      (choice) => choice.id !== id,
    );
    variants.push(next);
  }
  const changed = structuredClone(original);
  changed.canvas!.suggestions![0]!.label = "Undisclosed metadata change";
  variants.push(changed);
  const reordered = structuredClone(original);
  reordered.canvas!.suggestions!.reverse();
  variants.push(reordered);
  const added = structuredClone(original);
  added.canvas!.suggestions!.push({
    id: "new",
    label: "New choice",
    description: "Added",
    request: "New request",
    targetBlockId: null,
  });
  variants.push(added);
  const retainedChosen = structuredClone(original);
  retainedChosen.canvas!.suggestions!.push(
    retainedChosen.beforeCanvas!.suggestions![0]!,
  );
  variants.push(retainedChosen);
  const absentChosen = structuredClone(original);
  absentChosen.beforeCanvas!.suggestions =
    absentChosen.beforeCanvas!.suggestions!.slice(1);
  variants.push(absentChosen);
  const changedOutside = structuredClone(original);
  const block = changedOutside.canvas!.blocks.find(
    (block) => block.id === passageBefore.id,
  )!;
  if (block.kind === "text") block.body += "Undisclosed other text.";
  variants.push(changedOutside);
  for (const variant of variants) {
    await update(page, variant);
    await expect(review(page)).toHaveAttribute("data-review-mode", "full");
    await expect(
      review(page).locator(".suggestion-compact-retirements"),
    ).toHaveCount(0);
    await expect(
      review(page).locator(".suggestion-preview-next-steps"),
    ).toBeVisible();
  }
});

test("a trusted selected-passage diff is lossless inside long writing and falls back for every off-range effect", () => {
  expect(
    compactCanvasChange(passageBefore, passageAfter, selectedPassage),
  ).toEqual({
    field: "Selected passage",
    before: selectedPassage.text,
    after: "Give ideas room to grow.",
  });
  expect(compactCanvasChange(passageBefore, passageAfter)).toBeNull();
  for (const changed of [
    { ...passageAfter, body: `Changed prefix.${passageAfter.body}` },
    { ...passageAfter, body: `${passageAfter.body} Changed suffix.` },
    { ...passageAfter, title: "Another title" },
    { ...passageAfter, sourceIds: ["a-source"] },
    {
      ...passageAfter,
      body: `${passagePrefix}${"Long replacement. ".repeat(20)}${passageSuffix}`,
    },
  ])
    expect(
      compactCanvasChange(passageBefore, changed, selectedPassage),
    ).toBeNull();
  expect(
    compactCanvasChange(passageBefore, passageAfter, {
      ...selectedPassage,
      start: 0,
    }),
  ).toBeNull();
});

for (const width of [1280, 390])
  test(`selected passage review shows the exact local change and optional full context at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const proposal = proposalFor(passageBefore, passageAfter);
    proposal.beforeCanvas!.suggestions![0]!.textSelection = selectedPassage;
    await mount(page, proposal);
    await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
    await expect(review(page).locator(".suggestion-compact-field")).toHaveText(
      "Selected passage",
    );
    await expect(
      review(page).locator(".suggestion-compact-values del"),
    ).toHaveText(selectedPassage.text);
    await expect(
      review(page).locator(".suggestion-compact-values ins"),
    ).toHaveText("Give ideas room to grow.");
    await review(page).scrollIntoViewIfNeeded();
    await expect(
      review(page).getByRole("button", { name: "Keep", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`selected-passage-review-${width}.png`),
      fullPage: false,
    });
    await review(page)
      .getByRole("button", { name: "Inspect full item", exact: true })
      .click();
    await expect(
      review(page).locator(".suggestion-preview-changes"),
    ).toBeVisible();
    await expect(
      review(page).locator(".suggestion-preview-changes"),
    ).toContainText("My opening stays in my own words.");
    await expect(
      review(page).locator(".suggestion-preview-changes"),
    ).toContainText("The rest of this essay stays exactly where I left it.");
    await expect(
      page.getByRole("textbox", { name: "Workshop notes text", exact: true }),
    ).toHaveValue(passageBefore.body);
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).canvasWrites,
      ),
    ).toBe(0);
  });

for (const [name, previous, next] of [
  ["writing", writing, { ...writing, body: "An extra thought." }],
  [
    "table",
    table,
    {
      ...table,
      rows: [{ id: "clay", cells: ["Clay", "$24.50"] }, table.rows[1]!],
    },
  ],
  ["timer", timer, { ...timer, durationSeconds: 615, remainingSeconds: 615 }],
  ["deadline", deadline, { ...deadline, dueAt: deadline.dueAt! + 1 }],
] satisfies Array<[string, CanvasBlock, CanvasBlock]>)
  test(`${name} compact review exposes every exact changed value without editable controls`, async ({
    page,
  }) => {
    const proposal = proposalFor(previous, next);
    const values = compactCanvasChange(previous, next)!;
    await mount(page, proposal);
    await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
    await expect(
      review(page).locator(".suggestion-compact-values del"),
    ).toHaveText(
      name === "deadline"
        ? "Sep 21, 2026, 10:13:20.123 AM GMT-4"
        : values.before,
    );
    await expect(
      review(page).locator(".suggestion-compact-values ins"),
    ).toHaveText(
      name === "deadline"
        ? "Sep 21, 2026, 10:13:20.124 AM GMT-4"
        : values.after,
    );
    await expect(
      review(page).locator("input,textarea,select,[contenteditable=true]"),
    ).toHaveCount(0);
    await expect(
      review(page).getByRole("button", { name: "Keep", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).canvasWrites,
      ),
    ).toBe(0);
  });

test("local deadline review distinguishes repeated daylight-saving hours and exact milliseconds", async ({
  page,
}) => {
  const prior = { ...deadline, dueAt: Date.UTC(2026, 10, 1, 5, 30, 0, 125) };
  await mount(
    page,
    proposalFor(prior, {
      ...prior,
      dueAt: Date.UTC(2026, 10, 1, 6, 30, 0, 125),
    }),
  );
  await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
  await expect(
    review(page).locator(".suggestion-compact-values del"),
  ).toHaveText("Nov 1, 2026, 1:30:00.125 AM GMT-4");
  await expect(
    review(page).locator(".suggestion-compact-values ins"),
  ).toHaveText("Nov 1, 2026, 1:30:00.125 AM GMT-5");
});

test("whitespace-only edits retain full review while complete short multiline values preserve line breaks", async ({
  page,
}) => {
  const before = { ...writing, body: "First line\nSecond line" };
  await mount(
    page,
    proposalFor(before, { ...before, body: "First line Second line" }),
  );
  await expect(review(page)).toHaveAttribute("data-review-mode", "full");
  expect(
    await review(page)
      .locator(".is-before .suggestion-preview-prose")
      .textContent(),
  ).toBe("First line\nSecond line");
  await update(
    page,
    proposalFor(before, { ...before, body: "First line\nAnother line" }),
  );
  await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
  expect(
    await review(page).locator(".suggestion-compact-values del").textContent(),
  ).toBe("First line\nSecond line");
  expect(
    await review(page).locator(".suggestion-compact-values ins").textContent(),
  ).toBe("First line\nAnother line");
  await expect(
    review(page).locator(".suggestion-compact-values ins"),
  ).toHaveCSS("white-space", "pre-wrap");
});

test("document, linked, metadata and unsupported effects retain the complete review", async ({
  page,
}) => {
  await mount(page);
  const variants: IntentProposal[] = [
    { ...initial, canvas: { ...initial.canvas!, title: "Changed space" } },
    {
      ...initial,
      canvas: { ...initial.canvas!, subtitle: "Changed subtitle" },
    },
    { ...initial, canvas: { ...initial.canvas!, layout: "split" } },
    {
      ...initial,
      canvas: {
        ...initial.canvas!,
        blocks: [...initial.canvas!.blocks].reverse(),
      },
    },
    {
      ...initial,
      canvas: {
        ...initial.canvas!,
        suggestions: [
          {
            id: "different",
            label: "Another choice",
            description: "New metadata",
            request: "Change something",
            targetBlockId: null,
          },
        ],
      },
    },
    {
      ...initial,
      canvas: {
        ...initial.canvas!,
        blocks: initial.canvas!.blocks.map((block) =>
          block.id === writing.id && block.kind === "text"
            ? { ...block, body: "Also changed" }
            : block,
        ),
      },
    },
    proposalFor(design, { ...changedDesign, pinned: true }),
    proposalFor(design, { ...changedDesign, placement: "aside" }),
    proposalFor(design, { ...changedDesign, sourceIds: ["source"] }),
    proposalFor(design, { ...changedDesign, title: "New title" }),
    {
      ...initial,
      canvas: {
        ...initial.canvas!,
        blocks: [
          ...initial.canvas!.blocks,
          {
            ...base,
            id: "added",
            kind: "note",
            title: "Added",
            description: "New content",
          },
        ],
      },
    },
    {
      ...initial,
      canvas: {
        ...initial.canvas!,
        blocks: initial.canvas!.blocks.filter(
          (block) => block.id !== writing.id,
        ),
      },
    },
  ];
  const linked: CanvasBlock = {
    ...base,
    kind: "metric",
    id: "value",
    title: "Clay cost",
    tableId: table.id,
    rowId: "clay",
    column: 1,
    prefix: "$",
    suffix: "",
    decimals: 0,
  };
  variants.push(
    proposalFor(
      table,
      {
        ...table,
        rows: [{ id: "clay", cells: ["Clay", "$24"] }, table.rows[1]!],
      },
      [writing, linked],
    ),
  );
  for (const candidate of variants) {
    await update(page, candidate);
    await expect(review(page)).toHaveAttribute("data-review-mode", "full");
    await expect(
      review(page).locator(".suggestion-preview-changes"),
    ).toBeVisible();
    await expect(
      review(page).getByRole("button", { name: "Inspect full item" }),
    ).toHaveCount(0);
  }
  await expect(
    review(page).getByText("Linked values update", { exact: true }),
  ).toBeVisible();
  const invalid = {
    ...initial,
    canvas: {
      ...initial.canvas!,
      blocks: initial.canvas!.blocks.map((block) =>
        block.id === design.id
          ? { ...block, unknownField: "must not disappear" }
          : block,
      ),
    },
  };
  await update(page, invalid);
  await expect(review(page).getByRole("status")).toContainText(
    "complete before-and-after preview is unavailable",
  );
  await expect(
    review(page).getByRole("button", { name: "Keep", exact: true }),
  ).toBeDisabled();
});

test("compact arrival and full inspection preserve actual writing identity, selection and native Undo", async ({
  page,
}) => {
  await mount(page);
  const editor = page.getByRole("textbox", {
    name: "Workshop notes text",
    exact: true,
  });
  const original = await editor.elementHandle();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setPreviewVisible(false),
  );
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" Still here.");
  const value = await editor.inputValue();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(4, 12, "backward"),
  );
  const selection = await editor.evaluate((node: HTMLTextAreaElement) => [
    node.selectionStart,
    node.selectionEnd,
    node.selectionDirection,
  ]);
  expect(selection).toEqual([4, 12, "backward"]);
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setPreviewVisible(true),
  );
  await expect(review(page)).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
  await update(page, { ...initial, status: "stale" });
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((node, original) => node === original, original),
  ).toBe(true);
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual(selection);
  await review(page).getByRole("button", { name: "Inspect full item" }).click();
  await expect(
    review(page).locator(".suggestion-preview-changes"),
  ).toBeVisible();
  await expect(
    review(page)
      .getByRole("img", { name: "Studio gathering, 2 layers" })
      .first(),
  ).toBeVisible();
  await review(page)
    .getByRole("button", { name: "Close full inspection" })
    .click();
  expect(
    await editor.evaluate((node, original) => node === original, original),
  ).toBe(true);
  await expect(editor).toHaveValue(value);
  await editor.focus();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue(writing.body);
});

test("compact stale, expired, disabled and applying controls are guarded without losing action focus", async ({
  page,
}) => {
  await mount(page);
  const keep = review(page).getByRole("button", { name: "Keep", exact: true });
  const original = await keep.elementHandle();
  await keep.focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).keepCalls),
  ).toBe(1);
  await update(page, { ...initial, status: "applying" });
  await expect(
    review(page).getByRole("button", { name: "Keeping…", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  for (const proposal of [
    { ...initial, status: "stale" as const },
    { ...initial, expiresAt: 1 },
  ]) {
    await update(page, proposal);
    await expect(keep).toBeDisabled();
    await keep.press("Enter");
    expect(
      await keep.evaluate((node, original) => node === original, original),
    ).toBe(true);
  }
  await update(page, initial);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setReviewDisabled(true),
  );
  await expect(keep).toBeFocused();
  await keep.press("Enter");
  const dismiss = review(page).getByRole("button", {
    name: "Dismiss",
    exact: true,
  });
  await dismiss.press("Enter");
  expect(
    await page.evaluate(() => ({
      keep: (window as unknown as FixtureWindow).keepCalls,
      dismiss: (window as unknown as FixtureWindow).dismissCalls,
    })),
  ).toEqual({ keep: 1, dismiss: 0 });
});

test("a delayed inline review arrives without taking editor focus, selection or scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const longWriting = {
    ...writing,
    body: "A thought worth returning to.\n".repeat(55),
  };
  const proposal = proposalFor(design, changedDesign, [longWriting]);
  await mount(page, proposal);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setPreviewVisible(false),
  );
  const editor = page.getByRole("textbox", {
    name: "Workshop notes text",
    exact: true,
  });
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(4, 12, "backward"),
  );
  await page.evaluate(() => scrollTo(0, 160));
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).setPreviewVisible(true),
  );
  await settle(page);
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
  expect(
    await editor.evaluate(
      (node: HTMLTextAreaElement, identity) => ({
        same: node === identity,
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      }),
      original,
    ),
  ).toEqual({ same: true, start: 4, end: 12, direction: "backward" });
  expect((await review(page).boundingBox())!.y).toBeGreaterThan(800);
  expect(
    await page.evaluate(() => ({
      requests: (window as unknown as FixtureWindow).requestCalls,
      keeps: (window as unknown as FixtureWindow).keepCalls,
      writes: (window as unknown as FixtureWindow).canvasWrites,
    })),
  ).toEqual({ requests: 0, keeps: 0, writes: 0 });
});

test("an inline review expires without attention changes and never approves a stale or discarded change", async ({
  page,
}) => {
  const now = new Date("2026-09-20T12:00:00Z");
  await page.clock.install({ time: now });
  await mount(page, { ...initial, expiresAt: now.getTime() + 10_000 });
  const keep = review(page).getByRole("button", { name: "Keep", exact: true });
  const original = await keep.elementHandle();
  await keep.focus();
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.clock.fastForward(10_001);
  await expect(keep).toBeDisabled();
  await expect(review(page)).toContainText(
    "This preview has expired. Open the suggestion again.",
  );
  await expect(keep).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
  await keep.press("Enter");
  for (const status of ["stale", "discarded"] as const) {
    await update(page, { ...initial, status });
    await expect(keep).toBeDisabled();
    await keep.press("Enter");
    await expect(keep).toBeFocused();
    expect(
      await keep.evaluate((node, identity) => node === identity, original),
    ).toBe(true);
  }
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).keepCalls),
  ).toBe(0);
});

for (const [width, aside] of [
  [1280, false],
  [390, false],
  [1280, true],
] as const)
  test(`compact change and actions fit together at ${width}px${aside ? " in a real aside" : ""}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const proposal = aside
      ? proposalFor(
          { ...design, placement: "aside" },
          { ...changedDesign, placement: "aside" },
        )
      : initial;
    if (aside) {
      proposal.beforeCanvas!.layout = "split";
      proposal.canvas!.layout = "split";
    }
    await mount(page, proposal);
    await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
    await expect(review(page).locator(".suggestion-compact-field")).toHaveText(
      "Text layer 2 · Words",
    );
    await expect(
      review(page).locator(".suggestion-compact-values del"),
    ).toHaveText("10:30 AM");
    await expect(
      review(page).locator(".suggestion-compact-values ins"),
    ).toHaveText("11:15 AM");
    const initialTop = (await review(page).boundingBox())!.y;
    // This component fixture isolates inline review geometry. The old card
    // navigation was removed from the product; selection workflow tests cover
    // its replacement separately. Scrolling here is only capture setup.
    await review(page).scrollIntoViewIfNeeded();
    await settle(page);
    const reviewScroll = await page.evaluate(() => scrollY);
    const geometry = await review(page).evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        height: box.height,
        width: box.width,
        top: box.top,
        bottom: box.bottom,
        keepBottom: node
          .querySelector(".suggestion-preview-keep")!
          .getBoundingClientRect().bottom,
        overflow: document.documentElement.scrollWidth > innerWidth,
        outside: [
          ...node.querySelectorAll(
            "button,.suggestion-compact-values>div,.suggestion-compact-field",
          ),
        ]
          .filter((el) => el.getClientRects().length)
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.left < box.left ||
              rect.right > box.right ||
              rect.bottom > box.bottom
            );
          })
          .map((el) => el.textContent),
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.outside).toEqual([]);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.keepBottom).toBeLessThanOrEqual(800);
    expect(geometry.height).toBeLessThan(aside || width === 390 ? 310 : 210);
    if (aside) expect(geometry.width).toBeLessThan(370);
    else if (width === 1280) expect(geometry.width).toBeLessThanOrEqual(760);
    const directory = resolve(".runtime/canvas-compact-review");
    await mkdir(directory, { recursive: true });
    const label = `${width}${aside ? "-aside" : ""}`;
    await page.screenshot({
      path: resolve(directory, `compact-${label}-viewport.png`),
      fullPage: false,
    });
    if (width === 1280 && !aside) {
      await review(page)
        .getByRole("button", { name: "Inspect full item" })
        .click();
      await settle(page);
      expect((await review(page).boundingBox())!.width).toBeGreaterThan(760);
      await review(page)
        .getByRole("button", { name: "Close full inspection" })
        .click();
      await settle(page);
    }
    await review(page)
      .getByRole("button", { name: "Inspect full item", exact: true })
      .click();
    await settle(page);
    await page.evaluate((value) => scrollTo(0, value), reviewScroll);
    const fullHeight = (await review(page).boundingBox())!.height;
    const fullKeepBottom = await review(page)
      .locator(".suggestion-preview-keep")
      .evaluate((node) => node.getBoundingClientRect().bottom);
    expect(geometry.height).toBeLessThan(fullHeight * 0.65);
    await page.screenshot({
      path: resolve(directory, `full-${label}-viewport.png`),
      fullPage: false,
    });
    await review(page)
      .getByRole("button", { name: "Close full inspection", exact: true })
      .click();
    await settle(page);
    // Avoid captureBeyondViewport: its temporary viewport can race measured Canvas rows.
    const height = await page.evaluate(() =>
      Math.max(800, Math.ceil(document.documentElement.scrollHeight)),
    );
    await page.setViewportSize({ width, height });
    await settle(page);
    const capture = resolve(directory, `compact-${label}.png`);
    await page.screenshot({ path: capture, fullPage: false });
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    await writeFile(
      resolve(directory, `geometry-${label}.json`),
      JSON.stringify(
        {
          compact: geometry,
          initialPageReviewTop: initialTop,
          captureScroll: reviewScroll,
          fullHeight,
          fullKeepBottom,
          reduction: 1 - geometry.height / fullHeight,
          captureViewport: { width, height },
          note: "Identical before/after data; full control uses explicit full inspection. Explicit tall viewport capture, then restored800px.",
        },
        null,
        2,
      ),
    );
    await info.attach("compact review", {
      path: capture,
      contentType: "image/png",
    });
  });

function genericProposal(
  previous: CanvasBlock,
  next: CanvasBlock,
): IntentProposal {
  const proposal = proposalFor(previous, next);
  delete proposal.preparedSuggestionId;
  proposal.beforeCanvas!.suggestions = [];
  proposal.canvas!.suggestions = [];
  return proposal;
}

test("generic exact single-field proposals show blue inline values and adjacent accessible icon controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const proposals = [
    genericProposal(design, changedDesign),
    genericProposal(writing, {
      ...writing,
      body: "Give the idea room to grow.",
    }),
    genericProposal(table, {
      ...table,
      rows: [{ id: "clay", cells: ["Clay", "$24.50"] }, table.rows[1]!],
    }),
    genericProposal(timer, {
      ...timer,
      durationSeconds: 615,
      remainingSeconds: 615,
    }),
    genericProposal(deadline, { ...deadline, dueAt: deadline.dueAt! + 1000 }),
  ];
  await mount(page, proposals[0]);
  for (const proposal of proposals) {
    await update(page, proposal);
    await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
    const values = review(page).locator(".suggestion-compact-values");
    await expect(values.locator("ins")).toHaveCSS("color", "rgb(49, 91, 201)");
    await expect(
      values.getByRole("button", { name: "Keep", exact: true }),
    ).toBeEnabled();
    await expect(
      values.getByRole("button", { name: "Dismiss", exact: true }),
    ).toBeEnabled();
    expect(
      await values
        .getByRole("button", { name: "Keep", exact: true })
        .innerText(),
    ).toBe("");
    const geometry = await values.evaluate((node) => {
      const proposed = node.querySelector("ins")!.getBoundingClientRect();
      const keep = node.querySelector("button")!.getBoundingClientRect();
      return {
        gap: Math.max(0, keep.top - proposed.bottom),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.gap).toBeLessThanOrEqual(16);
    await review(page)
      .getByRole("button", { name: "Inspect full item", exact: true })
      .click();
    await expect(
      review(page).locator(".suggestion-preview-changes"),
    ).toBeVisible();
    await review(page)
      .getByRole("button", { name: "Close full inspection", exact: true })
      .click();
  }
  expect(
    await page.evaluate(() => ({
      writes: (window as unknown as FixtureWindow).canvasWrites,
      keeps: (window as unknown as FixtureWindow).keepCalls,
    })),
  ).toEqual({ writes: 0, keeps: 0 });
});

test("generic compact proposals never hide suggestion metadata, removal, arrangement, sources, pins or a second change", async ({
  page,
}) => {
  const proposal = genericProposal(design, changedDesign);
  await mount(page, proposal);
  const variants: IntentProposal[] = [];
  for (const canvas of [
    { ...proposal.canvas!, title: "A different space title" },
    { ...proposal.canvas!, subtitle: "Another description" },
    { ...proposal.canvas!, layout: "split" as const },
    { ...proposal.canvas!, blocks: [...proposal.canvas!.blocks].reverse() },
    { ...proposal.canvas!, blocks: [changedDesign] },
    {
      ...proposal.canvas!,
      blocks: [writing, { ...changedDesign, pinned: true }],
    },
    {
      ...proposal.canvas!,
      blocks: [writing, { ...changedDesign, sourceIds: ["source"] }],
    },
    {
      ...proposal.canvas!,
      blocks: [{ ...writing, body: "A second edit" }, changedDesign],
    },
    { ...proposal.canvas!, suggestions: initial.beforeCanvas!.suggestions },
  ])
    variants.push({ ...proposal, canvas });
  const removedChoice = structuredClone(proposal);
  removedChoice.beforeCanvas!.suggestions = initial.beforeCanvas!.suggestions;
  variants.push(removedChoice);
  const longWriting = genericProposal(passageBefore, passageAfter);
  variants.push(longWriting);
  for (const variant of variants) {
    await update(page, variant);
    await expect(review(page)).toHaveAttribute("data-review-mode", "full");
    await expect(
      review(page).locator(".suggestion-preview-changes"),
    ).toBeVisible();
    await expect(
      review(page).getByRole("button", { name: "Keep", exact: true }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).canvasWrites,
    ),
  ).toBe(0);
});

test("generic text proposals with omitted suggestion keys stay compact without hiding new metadata", async ({
  page,
}) => {
  const original =
    "Dogs enter REM sleep, but what they dream about remains uncertain.\n\nI want to separate observation from inference.";
  const proposed =
    "Dogs experience REM sleep, but the content of their dreams remains uncertain.\n\nI want to separate observation from inference.";
  const before: CanvasDocument = {
    version: 1,
    title: "Dogs dreaming",
    subtitle: "",
    layout: "focus",
    blocks: [
      { ...base, id: "writing", kind: "text", title: "", body: original },
    ],
  };
  const after: CanvasDocument = {
    ...before,
    blocks: [{ ...before.blocks[0]!, kind: "text", body: proposed }],
  };
  const proposal: IntentProposal = {
    id: "omitted-choices",
    kind: "canvas",
    label: "Proposed change",
    summary: "Dogs dreaming",
    beforeCanvas: before,
    canvas: after,
    status: "ready",
    expiresAt: Date.now() + 300000,
  };
  expect(Object.hasOwn(before, "suggestions")).toBe(false);
  expect(Object.hasOwn(after, "suggestions")).toBe(false);
  await mount(page, proposal);
  await expect(review(page)).toHaveAttribute("data-review-mode", "compact");
  await expect(
    review(page).locator(".suggestion-compact-values del"),
  ).toHaveText(original);
  await expect(
    review(page).locator(".suggestion-compact-values ins"),
  ).toHaveText(proposed);
  await expect(
    review(page).getByRole("button", { name: "Keep", exact: true }),
  ).toHaveAttribute("aria-disabled", "false");
  await update(page, {
    ...proposal,
    canvas: {
      ...after,
      suggestions: [
        {
          id: "new-option",
          label: "Undisclosed next step",
          description: "New suggestion metadata",
          request: "Prepare another thought.",
          targetBlockId: "writing",
        },
      ],
    },
  });
  await expect(review(page)).toHaveAttribute("data-review-mode", "full");
  await expect(review(page)).toContainText("Undisclosed next step");
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).keepCalls),
  ).toBe(0);
});

test("pointer approval of a generic inline change keeps the live writer focus, selection and native Undo", async ({
  page,
}) => {
  const proposal = genericProposal(design, changedDesign);
  await mount(page, proposal);
  const editor = page.getByRole("textbox", {
    name: "Workshop notes text",
    exact: true,
  });
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" Keep my working thought.");
  const typed = await editor.inputValue();
  await editor.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(2, 12, "backward"),
  );
  await review(page).getByRole("button", { name: "Keep", exact: true }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(typed);
  expect(
    await editor.evaluate(
      (node: HTMLTextAreaElement, identity) => ({
        same: node === identity,
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      }),
      original,
    ),
  ).toEqual({ same: true, start: 2, end: 12, direction: "backward" });
  expect(
    await page.evaluate(() => (window as unknown as FixtureWindow).keepCalls),
  ).toBe(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toHaveValue(writing.body);
  await review(page)
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(editor).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).dismissCalls,
    ),
  ).toBe(1);
});
