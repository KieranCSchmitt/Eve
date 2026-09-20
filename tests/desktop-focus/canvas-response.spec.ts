import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { IntentResponse as Response } from "../../apps/desktop/shared/bridge";

type ResponseWindow = Window & {
  mountResponse(response: Response): void;
  responseEvents: Array<{ type: string; id: string }>;
};
let script: string;
let styles: string;
const response: Response = {
  requestId: "ordinary-question",
  taskId: "reading",
  status: "complete",
  basis: "general",
  message:
    "Here is a proposed reading space. Review it before applying the change.",
  provider: {
    id: "local-provider",
    kind: "local",
    model: "controlled-preview-model",
  },
  citations: [],
  proposals: [
    {
      id: "canvas-proposal",
      kind: "canvas",
      label: "Shape your canvas",
      summary: "A reading plan and an editable example budget.",
      status: "ready",
      expiresAt: 9_999_999_999_999,
      canvas: {
        version: 1,
        title: "A little room to read",
        subtitle: "A draft for your afternoon.",
        layout: "split",
        blocks: [
          {
            id: "thought",
            kind: "text",
            title: "Start here",
            placement: "main",
            pinned: false,
            sourceIds: [],
            body: "Choose a chapter, then write down one question it leaves with you.",
          },
          {
            id: "items",
            kind: "checklist",
            title: "Before you begin",
            placement: "aside",
            pinned: false,
            sourceIds: [],
            items: [
              { id: "book", label: "Choose a book", checked: false },
              { id: "space", label: "Find a quiet place", checked: true },
            ],
          },
          {
            id: "budget",
            kind: "table",
            title: "Example budget",
            placement: "full",
            pinned: false,
            sourceIds: [],
            columns: ["Item", "Amount"],
            rows: [
              { id: "total", cells: ["Budget", "50"] },
              { id: "book-cost", cells: ["Book", "12"] },
              { id: "remaining", cells: ["Remaining", "=B1-B2"] },
            ],
          },
        ],
      },
    },
  ],
};

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import { createRoot } from 'react-dom/client';
        import { IntentResponse } from './apps/desktop/renderer/src/components/IntentResponse';
        window.responseEvents = [];
        window.mountResponse = response => createRoot(document.getElementById('root')).render(
          <IntentResponse response={response}
            onApply={id => window.responseEvents.push({type:'apply',id})}
            onDiscard={id => window.responseEvents.push({type:'discard',id})}
            onOpenSource={id => window.responseEvents.push({type:'source',id})} />
        );
      `,
      resolveDir: process.cwd(),
      sourcefile: "canvas-response-fixture.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-response-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  styles = `${await readFile("apps/desktop/renderer/src/styles.css", "utf8")}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}\n#root{padding:28px;max-width:1100px;margin:auto}body{background:#fbfbf8}`;
});
async function mount(page: Page, value = response) {
  await page.setContent('<main id="root"></main>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    (value) => (window as unknown as ResponseWindow).mountResponse(value),
    value,
  );
  await expect(
    page.getByRole("region", { name: "Eve response", exact: true }),
  ).toBeVisible();
}

test("an ordinary Ask canvas proposal requires a complete disabled preview before Apply", async ({
  page,
}) => {
  await mount(page);
  const proposal = page.getByRole("article", {
    name: "Shape your canvas",
    exact: true,
  });
  const apply = proposal.getByRole("button", {
    name: "Apply change",
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await expect(proposal.getByTestId("canvas")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as ResponseWindow).responseEvents,
    ),
  ).toEqual([]);
  await proposal
    .getByRole("button", { name: "Preview change", exact: true })
    .click();
  const preview = proposal.getByTestId("canvas");
  await expect(
    preview.getByRole("heading", {
      name: "A little room to read",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    preview.getByRole("textbox", { name: "Start here text", exact: true }),
  ).toHaveValue(
    "Choose a chapter, then write down one question it leaves with you.",
  );
  await expect(
    preview.getByRole("checkbox", { name: "Choose a book", exact: true }),
  ).not.toBeChecked();
  await expect(
    preview.getByRole("checkbox", { name: "Find a quiet place", exact: true }),
  ).toBeChecked();
  await expect(
    preview.getByRole("textbox", { name: "B3: Amount", exact: true }),
  ).toHaveValue("38");
  await expect(
    preview.getByRole("textbox", { name: "A3: Item", exact: true }),
  ).toHaveValue("Remaining");
  for (const control of await preview.locator("input, textarea, button").all())
    await expect(control).toBeDisabled();
  await expect(apply).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as unknown as ResponseWindow).responseEvents,
    ),
  ).toEqual([]);
  await proposal
    .getByRole("button", { name: "Hide preview", exact: true })
    .click();
  await expect(apply).toBeDisabled();
  await proposal
    .getByRole("button", { name: "Preview change", exact: true })
    .click();
  await apply.click();
  expect(
    await page.evaluate(
      () => (window as unknown as ResponseWindow).responseEvents,
    ),
  ).toEqual([{ type: "apply", id: "canvas-proposal" }]);
});

test("the provider badge uses plain location language and model identity appears only inside response details", async ({
  page,
}) => {
  await mount(page);
  const region = page.getByRole("region", {
    name: "Eve response",
    exact: true,
  });
  const badge = region.locator(".intent-response-meta");
  await expect(badge).toContainText("On this computer");
  await expect(badge).not.toContainText("controlled-preview-model");
  await expect(badge).not.toContainText("local-provider");
  const details = region.locator("details");
  await expect(details.locator("summary")).toHaveText("About this response");
  await expect(details).not.toHaveAttribute("open", "");
  const model = region.getByText("AI model: controlled-preview-model", {
    exact: true,
  });
  await expect(model).toHaveCount(1);
  await expect(model).toBeHidden();
  await details.locator("summary").click();
  await expect(model).toBeVisible();
  await expect(details).toContainText("AI model: controlled-preview-model");
  await details.locator("summary").click();
  await expect(model).toBeHidden();
});

test("a canvas proposal with no inspectable document cannot be applied", async ({
  page,
}) => {
  const { canvas: _canvas, ...proposal } = response.proposals[0];
  await mount(page, { ...response, proposals: [proposal] });
  await expect(
    page.getByRole("button", { name: "Preview change", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply change", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as unknown as ResponseWindow).responseEvents,
    ),
  ).toEqual([]);
});
