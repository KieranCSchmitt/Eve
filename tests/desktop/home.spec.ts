import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectHome, openInitialSpace } from "./home-helpers";

let app: ElectronApplication;
let page: Page;
let directory: string;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const environment = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  ),
  EVE_PROFILE_PATH: path.join(directory, "profile"),
});
async function launch() {
  app = await electron.launch({ args: [".", "--app"], env: environment() });
  page = await app.firstWindow();
  await expectHome(page);
}
async function nativeSurfaces() {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.flatMap((view) => {
      const contents = (view as Electron.WebContentsView).webContents;
      return contents
        ? [
            {
              id: contents.id,
              url: contents.getURL(),
              visible: view.getVisible(),
            },
          ]
        : [];
    }),
  );
}
async function editor() {
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .some((item) => item.url().includes("?folder=")),
      { timeout: 45_000 },
    )
    .toBe(true);
  return app
    .context()
    .pages()
    .find((item) => item.url().includes("?folder="))!;
}
async function menuHome() {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!
      .items.find((item) => item.label === "View")!
      .submenu!.items.find((item) => item.label === "Home");
    if (!item || item.accelerator !== "CommandOrControl+Shift+H")
      throw new Error("The native Home shortcut is missing.");
    item.click(undefined, undefined, undefined as never);
  });
  await expectHome(page);
}

test.beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "eve-native-home-")),
  );
  await launch();
});
test.afterEach(async ({}, info) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            app.process().kill("SIGKILL");
            reject(
              new Error("The disposable Home test did not close cleanly."),
            );
          },
          info.status === info.expectedStatus ? 15_000 : 3000,
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

test("cold launch has no active space or project surface; Home keeps the real dirty editor and native Undo, and reopening starts Home again", async ({}, info) => {
  await expect
    .poll(() => page.evaluate(() => window.eve.status()))
    .toMatchObject({ preview: "idle", workbench: "unconfigured" });
  expect(await nativeSurfaces()).toEqual([]);
  expect(
    app
      .context()
      .pages()
      .filter((item) => item.url().startsWith("http://127.0.0.1:")),
  ).toHaveLength(0);
  await expect(
    access(path.join(directory, "profile/workbench")),
  ).rejects.toThrow();
  await info.attach("native-home.png", {
    body: Buffer.from(
      await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      ),
      "base64",
    ),
    contentType: "image/png",
  });
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((item) => item.url().endsWith("#overlay")),
    )
    .toBe(true);
  const settings = app
    .context()
    .pages()
    .find((item) => item.url().endsWith("#overlay"))!;
  await expect(
    settings.getByRole("dialog", { name: "Workspace settings", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("radio", { name: "On this computer only", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: /background assistance/ }),
  ).toHaveCount(0);
  await expectHome(page);
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(settings.getByRole("dialog")).toHaveCount(0);
  expect((await nativeSurfaces()).filter((view) => view.visible)).toEqual([]);

  await openInitialSpace(page);
  await expect(
    page.getByRole("heading", { name: "Make room for focus.", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((item) =>
          /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/$/.test(item.url()),
        ),
    )
    .toBe(true);
  const preview = app
    .context()
    .pages()
    .find((item) =>
      /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/$/.test(item.url()),
    )!;
  await expect(preview.locator("#duration-label")).toContainText("25 MINUTES");
  const range = page.getByRole("slider", {
    name: "Focus session duration",
    exact: true,
  });
  await range.focus();
  // An unfinished key gesture sends only a transient preview. Home must clear
  // the server draft even after its task has stopped being the active owner.
  await page.keyboard.down("ArrowRight");
  await expect(preview.locator("#duration-label")).toContainText("30 MINUTES");
  expect(
    await page.evaluate(
      async () =>
        (await window.eve.snapshot()).tasks.find((task) => task.id === "orbit")!
          .parameters!.values.durationMinutes,
    ),
  ).toBe(25);
  await menuHome();
  await page.keyboard.up("ArrowRight");
  await openInitialSpace(page);
  await expect(preview.locator("#duration-label")).toContainText("25 MINUTES");
  await expect(range).toHaveValue("25");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const code = await editor();
  await expect(code.locator(".view-lines").first()).toContainText(
    "transitionMs",
  );
  const originalUrl = code.url();
  const codeId = (await nativeSurfaces()).find(
    (view) => view.url === originalUrl,
  )!.id;
  const file = path.join(
    directory,
    "profile/workspaces/orbit/eve.project.json",
  );
  const original = await readFile(file, "utf8");
  await page
    .getByRole("button", { name: "Set theme #56836F", exact: true })
    .click();
  await expect(code.locator(".view-lines").first()).toContainText("#56836F");
  expect(await readFile(file, "utf8")).toBe(original);

  await menuHome();
  const checkpoint = await page.evaluate(
    async () =>
      (await window.eve.snapshot()).tasks.find((task) => task.id === "orbit")!
        .checkpoint,
  );
  expect(checkpoint?.selectedActivity).toBe("code");
  expect(checkpoint?.selectedFile).toContain("eve.project.json");
  expect((await nativeSurfaces()).filter((view) => view.visible)).toEqual([]);
  expect(
    (await nativeSurfaces()).find((view) => view.id === codeId),
  ).toMatchObject({ url: originalUrl, visible: false });
  await expect(code.locator(".view-lines").first()).toContainText("#56836F");
  expect(await readFile(file, "utf8")).toBe(original);

  await openInitialSpace(page);
  await expect(
    page.getByRole("button", { name: "Code", exact: true }),
  ).toHaveClass(/active/);
  await expect
    .poll(
      async () =>
        (await nativeSurfaces()).find((view) => view.id === codeId)?.visible,
    )
    .toBe(true);
  expect((await editor()).url()).toBe(originalUrl);
  // Monaco also has a readonly accessibility textarea. Click its actual text
  // surface before the native shortcut, as a person returning to editing does.
  await code.locator(".view-lines").first().click();
  await code.keyboard.press(`${mod}+z`);
  await expect(code.locator(".view-lines").first()).toContainText("#5677FF");
  await code.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(file, "utf8")).toBe(original);
  // Leave a real project active when quitting. Cold Home must be independent of
  // the last active space, while that space's checkpoint remains intact.
  await app.close();
  await launch();
  expect(await nativeSurfaces()).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => window.eve.status()))
    .toMatchObject({ preview: "idle", workbench: "unconfigured" });
  expect(
    await page.evaluate(
      async () =>
        (await window.eve.snapshot()).tasks.find((task) => task.id === "orbit")!
          .checkpoint?.selectedActivity,
    ),
  ).toBe("code");
});

test("a real editor load completing after Home cannot resurface or reclaim keyboard focus", async () => {
  await openInitialSpace(page);
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
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
    await expect.poll(() => intercepted, { timeout: 45_000 }).toBe(true);
    await page.getByRole("button", { name: "Go home", exact: true }).click();
    await expectHome(page);
    release();
    const code = await editor();
    await code.waitForLoadState("load");
    await expect(code.locator(".monaco-workbench")).toHaveCount(1);
    await expect
      .poll(async () => (await nativeSurfaces()).filter((view) => view.visible))
      .toEqual([]);
    await expectHome(page);
    expect(
      await app.evaluate(({ webContents }) =>
        webContents.getFocusedWebContents()?.getURL(),
      ),
    ).toBe(page.url());
    await expect(
      page.getByRole("button", { name: "Open Orbit", exact: true }),
    ).toBeVisible();
    // Settle the authenticated extension and restore on a deliberate return,
    // after proving its original background completion left Home untouched.
    await openInitialSpace(page);
    await expect(code.locator(".view-lines").first()).toContainText(
      "transitionMs",
    );
  } finally {
    release();
    await app.context().unrouteAll({ behavior: "wait" });
  }
});
