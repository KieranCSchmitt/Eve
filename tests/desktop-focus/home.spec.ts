import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { TaskRecord } from "@eve/contracts";

type HomeTask = Pick<
  TaskRecord,
  "id" | "title" | "description" | "kind" | "updatedAt"
>;
type HomeWindow = Window & {
  mountHome(tasks: HomeTask[], withCompose?: boolean): void;
  setHomeBusy(value: boolean): void;
  homeEvents: Array<{ type: string; value?: string }>;
};
let script: string;
let styles: string;
test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import { createRoot } from 'react-dom/client';
        import { Home } from './apps/desktop/renderer/src/components/Home';
        let root, tasks = [], busy = false, withCompose = false;
        window.homeEvents = [];
        const render = () => root.render(<Home tasks={tasks} busy={busy}
          onOpenTask={value => window.homeEvents.push({type:'open', value})}
          onFind={() => window.homeEvents.push({type:'find'})}
          onCreate={value => { window.homeEvents.push({type:'create', value}); busy = true; render(); }}
          onCompose={withCompose ? value => { window.homeEvents.push({type:'compose', value}); busy = true; render(); } : undefined}
        />);
        window.mountHome = (value, enabled = false) => { tasks = value; withCompose = enabled; root = createRoot(document.getElementById('root')); render(); };
        window.setHomeBusy = value => { busy = value; render(); };
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
      sourcefile: "home-fixture.tsx",
    },
    bundle: true,
    write: false,
    outfile: "home-fixture.js",
    format: "iife",
    loader: { ".woff2": "dataurl", ".woff": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
    jsx: "automatic",
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const base = await readFile("apps/desktop/renderer/src/styles.css", "utf8");
  const [serif, italic, sans] = await Promise.all([
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-italic.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${base}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}
    @font-face{font-family:'Newsreader Variable';font-style:normal;font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}
    @font-face{font-family:'Newsreader Variable';font-style:italic;font-weight:200 800;src:url(data:font/woff2;base64,${italic.toString("base64")})}
    @font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}
  `;
});

const tasks: HomeTask[] = [
  {
    id: "older",
    title: "A very early thought",
    description: "",
    kind: "note",
    updatedAt: 1,
  },
  {
    id: "orbit",
    title: "Orbit",
    description: "A little more focus. A little more you.",
    kind: "project",
    updatedAt: 9,
  },
  {
    id: "weekend",
    title: "A weekend by the sea",
    description: "Places to wander, things to remember.",
    kind: "note",
    updatedAt: 8,
  },
  {
    id: "club",
    title: "Film club",
    description: "An evening together.",
    kind: "note",
    updatedAt: 7,
  },
  {
    id: "portfolio",
    title: "My portfolio",
    description: "A place for the things I make.",
    kind: "project",
    updatedAt: 6,
  },
];

async function mount(
  page: Page,
  data: HomeTask[] = tasks,
  withCompose = false,
) {
  await page.setContent(
    '<div class="eve-app"><main class="workspace home-workspace" id="root"></main></div>',
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ tasks, withCompose }) =>
      (window as unknown as HomeWindow).mountHome(tasks, withCompose),
    { tasks: data, withCompose },
  );
  await expect(page.getByTestId("home")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("shows only recent real spaces, routes exact IDs, and does not focus on arrival", async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator(".home-space")).toHaveCount(4);
  expect(
    await page
      .locator(".home-space")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-task-id")),
      ),
  ).toEqual(["orbit", "weekend", "club", "portfolio"]);
  await expect(
    page.getByRole("button", {
      name: "Open A very early thought",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Open Film club", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Find your work", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual([{ type: "open", value: "club" }, { type: "find" }]);
});

test("empty Home supports keyboard creation, Escape focus return, and failed-operation retry", async ({
  page,
}) => {
  await mount(page, []);
  await expect(
    page.getByRole("heading", { name: "Your recent spaces" }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Find your work", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const title = page.getByRole("textbox", { name: "Space title" });
  await expect(title).toBeFocused();
  await title.fill("  My next idea  ");
  await title.press("Escape");
  await expect(
    page.getByRole("button", { name: "New space", exact: true }),
  ).toBeFocused();
  await expect(title).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("  My next idea  ");
  await title.press("Enter");
  await expect(title).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("button", { name: "Create space", exact: true }),
  ).toBeDisabled();
  await title.press("Enter");
  await title.press("Escape");
  await expect(title).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual([{ type: "create", value: "My next idea" }]);
  // Parent reports a failed attempt; Home retains the draft and becomes usable.
  await page.evaluate(() =>
    (window as unknown as HomeWindow).setHomeBusy(false),
  );
  await expect(title).toBeEditable();
  await expect(title).toHaveValue("  My next idea  ");
  await title.fill("A better name");
  await title.press("Enter");
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual([
    { type: "create", value: "My next idea" },
    { type: "create", value: "A better name" },
  ]);
});

test("composition Enter does not create, blank titles stay inactive, and busy blocks navigation", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Space title" });
  await title.fill("   ");
  await expect(
    page.getByRole("button", { name: "Create space", exact: true }),
  ).toBeDisabled();
  await title.fill("新しい考え");
  const prevented = await title.evaluate(
    (node) =>
      !node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
  );
  expect(prevented).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as HomeWindow).setHomeBusy(true),
  );
  for (const button of await page.locator(".home button").all())
    await expect(button).toBeDisabled();
});

test("intention cards compose directly, leave user content open, and are inactive while preparing", async ({
  page,
}) => {
  await mount(page, [], true);
  await expect(
    page.getByRole("region", { name: "Or start with a direction" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);
  const suggestions = [
    ["Start writing", "Start a blank document"],
    [
      "Organize research",
      "Create a research workspace with a blank writing area and a place for my sources. Leave it ready for my own material.",
    ],
    [
      "Compare options",
      "Create a blank comparison workspace with an editable table for options and a place for my decision notes. Leave the options for me to enter.",
    ],
    [
      "Start a day plan",
      "Create a day planning workspace with an empty daily timeline and a checklist for my priorities. Leave the times and tasks for me to fill in.",
    ],
  ];
  for (const [name] of suggestions) {
    await page.getByRole("button", { name, exact: true }).click();
    for (const button of await page.locator(".home button").all())
      await expect(button).toBeDisabled();
    await page.evaluate(() =>
      (window as unknown as HomeWindow).setHomeBusy(false),
    );
  }
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual(suggestions.map(([, value]) => ({ type: "compose", value })));
  await expect(
    page.getByRole("textbox", { name: "What would you like to make?" }),
  ).toHaveValue("");
});

test("the intent bar supports custom requests, IME, and draft recovery without taking focus", async ({
  page,
}) => {
  await mount(page, [], true);
  await page.keyboard.press("Tab");
  const request = page.getByRole("textbox", {
    name: "What would you like to make?",
  });
  await expect(request).toBeFocused();
  await request.fill("  Help me think through a new idea  ");
  expect(
    await request.evaluate(
      (node) =>
        !node.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual([]);
  await request.press("Enter");
  await expect(request).toHaveAttribute("readonly", "");
  expect(
    await page.evaluate(() => (window as unknown as HomeWindow).homeEvents),
  ).toEqual([{ type: "compose", value: "Help me think through a new idea" }]);
  await page.evaluate(() =>
    (window as unknown as HomeWindow).setHomeBusy(false),
  );
  await expect(request).toBeEditable();
  await expect(request).toHaveValue("  Help me think through a new idea  ");
});

for (const width of [1440, 900, 600, 390]) {
  test(`Home is bounded and readable at ${width}px with real long text`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(
      page,
      tasks.map((task) =>
        task.id === "weekend"
          ? {
              ...task,
              title:
                "A weekend by the sea, with everyone and everything we want to remember",
              description:
                "A long thought with an unusually-long-unbroken-reference-" +
                "a".repeat(140),
            }
          : task,
      ),
      true,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", {
        name: "Open A weekend by the sea, with everyone and everything we want to remember",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`home-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "New space", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Space title" }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`home-create-${width}.png`),
      fullPage: true,
    });
  });
}
