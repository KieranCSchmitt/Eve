import { openInitialSpace } from "./home-helpers";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

let app: ElectronApplication;
let page: Page;
let directory: string;
type NativeModifiers = NonNullable<Electron.KeyboardInputEvent["modifiers"]>;
const modifiers: NativeModifiers =
  process.platform === "darwin" ? ["meta"] : ["control"];

test.beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "eve-native-focus-")),
  );
  app = await electron.launch({
    args: [".", "--app"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
        ),
      ),
      EVE_PROFILE_PATH: path.join(directory, "profile"),
    },
  });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await expect(
    page.getByRole("heading", { name: "Make room for focus.", exact: true }),
  ).toBeVisible();
  // Establish the real foreground-window precondition. CDP mouse dispatch alone
  // can click an inactive macOS window without activating it as a person would.
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFocused(),
      ),
    )
    .toBe(true);
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach("native-focus-state", {
      body: JSON.stringify(
        await app.evaluate(({ BrowserWindow, webContents }) => ({
          windows: BrowserWindow.getAllWindows().map((w) => ({
            focused: w.isFocused(),
            visible: w.isVisible(),
          })),
          contents: webContents
            .getAllWebContents()
            .map((w) => ({ url: w.getURL(), focused: w.isFocused() })),
        })),
      ),
      contentType: "application/json",
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            app.process().kill("SIGKILL");
            reject(
              new Error("The disposable focus test did not shut down cleanly."),
            );
          },
          info.status === info.expectedStatus ? 15000 : 3000,
        );
      }),
    ]);
  } catch (error) {
    if (info.status === info.expectedStatus) throw error;
  } finally {
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
});

async function actualEditor() {
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .some((item) => item.url().includes("?folder=")),
      { timeout: 45000 },
    )
    .toBe(true);
  return app
    .context()
    .pages()
    .find((item) => item.url().includes("?folder="))!;
}
async function focusedUrl() {
  return app.evaluate(
    ({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null,
  );
}
async function nativeKey(keyCode: string, mods: NativeModifiers = []) {
  await app.evaluate(
    ({ webContents }, { keyCode, mods }) => {
      const target = webContents.getFocusedWebContents();
      if (!target) throw new Error("No native contents owns keyboard focus.");
      target.sendInputEvent({ type: "keyDown", keyCode, modifiers: mods });
      target.sendInputEvent({ type: "keyUp", keyCode, modifiers: mods });
    },
    { keyCode, mods },
  );
}
async function typeIntoActualFocus(code: Page, marker: string) {
  await expect.poll(focusedUrl).toBe(code.url());
  // Insert into the actually focused native contents, never a Playwright target
  // that could implicitly focus the editor and hide the product defect.
  await app.evaluate(
    ({ webContents }, marker) =>
      webContents.getFocusedWebContents()!.insertText(marker),
    marker,
  );
  await expect(code.locator(".view-lines").first()).toContainText(marker);
  await nativeKey("Z", modifiers);
  await expect(code.locator(".view-lines").first()).not.toContainText(marker);
}

test("deliberate Code and return navigation transfer native keyboard focus, preserving workbench chords and host recall restoration", async () => {
  const projectFile = path.join(
    directory,
    "profile/workspaces/orbit/eve.project.json",
  );
  const original = await readFile(projectFile, "utf8");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const code = await actualEditor();
  await expect(code.locator(".view-lines").first()).toContainText(
    "transitionMs",
  );
  await typeIntoActualFocus(code, "nativeFocusCode");
  await page.evaluate(async () => {
    await window.eve.setOverlay(null);
    await window.eve.setOverlay(null);
  });
  await typeIntoActualFocus(code, "nativeFocusAfterAbsentOverlay");

  await page.getByRole("button", { name: /Shape the movement/ }).click();
  await expect(
    page.getByRole("heading", { name: "A feeling, in motion.", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to previous activity", exact: true })
    .click();
  await typeIntoActualFocus(code, "nativeFocusReturn");

  await nativeKey("K", modifiers);
  expect(await focusedUrl()).toBe(code.url());
  expect(
    app
      .context()
      .pages()
      .filter((item) => item.url().endsWith("#overlay")),
  ).toHaveLength(0);
  await nativeKey("Escape");
  // Electron's sendInputEvent does not dispatch through the OS menu accelerator
  // route on every platform. Verify the native binding, then invoke that exact
  // menu action while the real editor still owns input.
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!
      .items.find((item) => item.label === "View")!
      .submenu!.items.find((item) => item.label === "Find anything")!;
    if (
      item.accelerator !==
      (process.platform === "darwin" ? "Command+Alt+K" : "Control+Alt+K")
    )
      throw new Error("The reserved host recall chord changed.");
    item.click(undefined, undefined, undefined as never);
  });
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((item) => item.url().endsWith("#overlay")),
    )
    .toBe(true);
  const overlay = app
    .context()
    .pages()
    .find((item) => item.url().endsWith("#overlay"))!;
  await expect(
    overlay.getByRole("combobox", { name: "Search tasks" }),
  ).toBeVisible();
  await expect.poll(focusedUrl).toBe(overlay.url());
  await nativeKey("Escape");
  await expect(
    overlay.getByRole("combobox", { name: "Search tasks" }),
  ).toHaveCount(0);
  await typeIntoActualFocus(code, "nativeFocusRestored");
  expect(await readFile(projectFile, "utf8")).toBe(original);
});

test("an explicit registered show code request focuses the real editor without a model completion or extra click", async () => {
  await page
    .getByRole("button", { name: "Ask Eve", exact: true })
    .click();
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((item) => item.url().endsWith("#overlay")),
    )
    .toBe(true);
  const overlay = app
    .context()
    .pages()
    .find((item) => item.url().endsWith("#overlay"))!;
  await overlay
    .getByRole("textbox", { name: "Ask Eve", exact: true })
    .fill("show code");
  await overlay
    .getByRole("button", { name: "Submit question", exact: true })
    .click();
  const code = await actualEditor();
  await expect(code.locator(".view-lines").first()).toContainText(
    "transitionMs",
  );
  await typeIntoActualFocus(code, "nativeRegisteredFocus");
});

test("an editor finishing its real load after navigation and notebook typing never steals focus", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await app.context().route(
    (url) => url.searchParams.has("folder"),
    async (route) => {
      intercepted = true;
      await held;
      await route.continue();
    },
  );
  try {
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect.poll(() => intercepted, { timeout: 45000 }).toBe(true);
    await page.getByRole("button", { name: "Notebook", exact: true }).click();
    const note = page.locator('[data-note-task="orbit"]');
    await expect(note).toBeFocused();
    await note.fill("I stayed with this thought while the editor opened.");
    await expect.poll(focusedUrl).toBe(page.url());
    release();
    const code = await actualEditor();
    await code.waitForLoadState("load");
    await expect(code.locator(".monaco-workbench")).toHaveCount(1);
    await page.evaluate(() => window.eve.snapshot());
    await expect(note).toBeFocused();
    expect(await focusedUrl()).toBe(page.url());
    const nativeVisibility = await app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter(
            (view) =>
              (view as Electron.WebContentsView).webContents?.getURL() === url,
          )
          .map((view) => view.getVisible()),
      code.url(),
    );
    expect(nativeVisibility).toEqual([false]);
    await app.evaluate(({ webContents }) =>
      webContents.getFocusedWebContents()!.insertText(" Still here."),
    );
    await expect(note).toContainText("Still here.");
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.eve.snapshot()).tasks.find(
              (task) => task.id === "orbit",
            )!.note.body,
        ),
      )
      .toContain("Still here.");
    // Complete a deliberate return after proving the delayed load stayed hidden.
    // This also settles the authenticated extension before normal close review.
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(code.locator(".view-lines").first()).toContainText(
      "transitionMs",
    );
    await typeIntoActualFocus(code, "nativeFocusAfterDelayedLoad");
  } finally {
    release();
    await app.context().unrouteAll({ behavior: "wait" });
  }
});
