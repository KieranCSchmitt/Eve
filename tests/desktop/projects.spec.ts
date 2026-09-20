import { openInitialSpace } from "./home-helpers";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface ProjectDialogs {
  folders: string[];
  closeChoices: number[];
  messages: { message: string; detail?: string; buttons?: string[] }[];
  backup: string;
  saveChooserCalls: number;
  maintenanceEvents: string[];
}
type ObservedGlobal = typeof globalThis & {
  __eveProjectAcceptance: ProjectDialogs;
};
let app: ElectronApplication;
let page: Page;
let directory: string;
let profile: string;
const mod = process.platform === "darwin" ? "Meta" : "Control";
test.setTimeout(180_000);

test.beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "eve-native-projects-")),
  );
  profile = path.join(directory, "profile");
  app = await electron.launch({
    args: [".", "--app"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
        ),
      ),
      EVE_PROFILE_PATH: profile,
    },
  });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await expect(
    page.getByRole("heading", { name: "Make room for focus.", exact: true }),
  ).toBeVisible();
  await app.evaluate(
    ({ dialog, ipcMain }, backup) => {
      const observed: ProjectDialogs = {
        folders: [],
        closeChoices: [],
        messages: [],
        backup,
        saveChooserCalls: 0,
        maintenanceEvents: [],
      };
      (globalThis as ObservedGlobal).__eveProjectAcceptance = observed;
      const open = dialog.showOpenDialog.bind(dialog),
        save = dialog.showSaveDialog.bind(dialog),
        message = dialog.showMessageBox.bind(dialog);
      dialog.showOpenDialog = ((
        ...args: Parameters<typeof dialog.showOpenDialog>
      ) => {
        const options = args.at(-1) as Electron.OpenDialogOptions;
        if (options.title === "Choose a project folder") {
          const selected = observed.folders.shift();
          if (!selected) throw new Error("No native test folder was queued.");
          return Promise.resolve({ canceled: false, filePaths: [selected] });
        }
        return Reflect.apply(open, dialog, args);
      }) as typeof dialog.showOpenDialog;
      dialog.showSaveDialog = ((
        ...args: Parameters<typeof dialog.showSaveDialog>
      ) => {
        const options = args.at(-1) as Electron.SaveDialogOptions;
        if (options.title === "Export Eve backup") {
          observed.saveChooserCalls++;
          return Promise.resolve({
            canceled: false,
            filePath: observed.backup,
          });
        }
        return Reflect.apply(save, dialog, args);
      }) as typeof dialog.showSaveDialog;
      dialog.showMessageBox = ((
        ...args: Parameters<typeof dialog.showMessageBox>
      ) => {
        const options = args.at(-1) as Electron.MessageBoxOptions;
        observed.messages.push({
          message: options.message,
          detail: options.detail,
          buttons: options.buttons,
        });
        if (options.buttons?.[0] === "Trust and open project")
          return Promise.resolve({ response: 0, checkboxChecked: false });
        // Do not leave an unexpected OS modal blocking diagnostics. The test
        // asserts below that clean scoped close never offers recovery at all.
        if (options.buttons?.[0] === "Recover drafts")
          return Promise.resolve({ response: 1, checkboxChecked: false });
        if (options.message === "Keep your changes before leaving?") {
          const response = observed.closeChoices.shift();
          if (response === undefined)
            throw new Error(
              "An unexpected dirty-editor decision was requested.",
            );
          return Promise.resolve({ response, checkboxChecked: false });
        }
        if (options.message === "The backup could not finish.")
          return Promise.resolve({ response: 0, checkboxChecked: false });
        return Reflect.apply(message, dialog, args);
      }) as typeof dialog.showMessageBox;
      ipcMain.on("eve:overlay-event", (_event, action: { type?: string }) => {
        if (action.type?.startsWith("maintenance-"))
          observed.maintenanceEvents.push(action.type);
      });
    },
    path.join(directory, "refused-backup"),
  );
});

test.afterEach(async ({}, info) => {
  const failed = info.status !== info.expectedStatus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observations = info.outputPath("native-project-observations.json");
    await writeFile(
      observations,
      JSON.stringify(
        await app.evaluate(({ BrowserWindow }) => ({
          observed: (globalThis as ObservedGlobal).__eveProjectAcceptance,
          views: BrowserWindow.getAllWindows()[0].contentView.children.map(
            (view) => ({
              visible: view.getVisible(),
              bounds: view.getBounds(),
              url: (view as Electron.WebContentsView).webContents?.getURL(),
            }),
          ),
        })),
        null,
        2,
      ),
    );
    await info.attach("native-project-observations.json", {
      path: observations,
      contentType: "application/json",
    });
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            app.process().kill("SIGKILL");
            reject(
              new Error("The disposable project test could not close cleanly."),
            );
          },
          failed ? 5_000 : 15_000,
        );
      }),
    ]);
  } catch (error) {
    if (!failed) throw error;
  } finally {
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
});

async function recall(title?: string) {
  await page
    .getByRole("button", { name: "Find anything", exact: true })
    .click();
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((candidate) => candidate.url().endsWith("#overlay")),
    )
    .toBe(true);
  const overlay = app
    .context()
    .pages()
    .find((candidate) => candidate.url().endsWith("#overlay"))!;
  await expect(
    overlay.getByRole("combobox", { name: "Search tasks" }),
  ).toBeVisible();
  if (title) {
    await overlay.getByRole("combobox", { name: "Search tasks" }).fill(title);
    await overlay
      .getByRole("option", {
        name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      })
      .first()
      .click();
  }
  return overlay;
}
async function attach(title: string, folder: string, preview = false) {
  const overlay = await recall();
  await overlay.getByRole("combobox", { name: "Search tasks" }).fill(title);
  await overlay.getByRole("option", { name: /Make a space for/ }).click();
  const note = page.locator("[data-testid=note-editor]:visible");
  await note.fill(`The idea behind ${title}.`);
  await app.evaluate(({}, folder) => {
    (globalThis as ObservedGlobal).__eveProjectAcceptance.folders.push(folder);
  }, folder);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const review = page.getByRole("region", {
    name: "Project setup",
    exact: true,
  });
  await expect(review).toContainText(folder);
  await expect(
    review.getByRole("radio", { name: /Code and notebook/ }),
  ).toBeChecked();
  await expect(
    review.getByRole("radio", { name: /Orbit controls/ }),
  ).toHaveCount(0);
  if (preview) {
    await review.getByText("Add a preview", { exact: false }).click();
    await review
      .getByLabel("Preview source", { exact: true })
      .selectOption("static");
  }
  await review
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await expect(
    review.getByRole("button", { name: "Review and open code", exact: true }),
  ).toBeVisible();
  await expect(note).toHaveText(`The idea behind ${title}.`);
  const task = await page.evaluate(async () => {
    const snapshot = await window.eve.snapshot();
    return snapshot.tasks.find((task) => task.id === snapshot.activeTaskId)!;
  });
  expect(task.project).toMatchObject({
    canonicalRoot: folder,
    adapter: "generic",
    preview: preview
      ? { kind: "static", entry: "index.html" }
      : { kind: "none" },
  });
  expect(
    app
      .context()
      .pages()
      .some((candidate) => {
        try {
          return new URL(candidate.url()).searchParams.get("folder") === folder;
        } catch {
          return false;
        }
      }),
  ).toBe(false);
  await review
    .getByRole("button", { name: "Review and open code", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .some((candidate) => {
            try {
              return (
                new URL(candidate.url()).searchParams.get("folder") === folder
              );
            } catch {
              return false;
            }
          }),
      { timeout: 45_000 },
    )
    .toBe(true);
  const code = app
    .context()
    .pages()
    .find((candidate) => {
      try {
        return new URL(candidate.url()).searchParams.get("folder") === folder;
      } catch {
        return false;
      }
    })!;
  await expect(code.locator(".monaco-workbench")).toBeVisible({
    timeout: 45_000,
  });
  return { code, taskId: task.id };
}
async function openFile(code: Page, name: string, restoredDocument = false) {
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow }, url) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some(
            (view) =>
              view.getVisible() &&
              (view as Electron.WebContentsView).webContents?.getURL() === url,
          ),
        code.url(),
      ),
    )
    .toBe(true);
  // A reopened workbench paints its outer shell before restoring the initial
  // document. Wait for the actual editor before sending a command into it.
  if (restoredDocument)
    await expect(code.locator(".view-lines").first()).toBeVisible({
      timeout: 45_000,
    });
  const existing = code.getByRole("tab").filter({ hasText: name });
  if (await existing.count()) {
    await existing.first().click();
    return;
  }
  await code.keyboard.press(`${mod}+p`);
  const input = code.locator(".quick-input-widget input");
  await expect(input).toBeVisible();
  await input.click();
  await code.keyboard.press(`${mod}+a`);
  await code.keyboard.insertText(name);
  await code.getByRole("option").filter({ hasText: name }).first().click();
  await expect(code.locator(".quick-input-widget")).toBeHidden();
  await expect(code.locator(".view-lines").first()).toBeVisible();
}
async function replaceText(code: Page, text: string) {
  await code.locator(".view-lines").first().click();
  await code.keyboard.press(`${mod}+a`);
  await code.keyboard.insertText(text);
  await expect(code.locator(".view-lines").first()).toContainText(text.trim());
}
async function closeDecision(response: number, quit = false) {
  const before = await app.evaluate(
    () =>
      (globalThis as ObservedGlobal).__eveProjectAcceptance.messages.filter(
        (item) => item.message === "Keep your changes before leaving?",
      ).length,
  );
  await app.evaluate(({}, response) => {
    (globalThis as ObservedGlobal).__eveProjectAcceptance.closeChoices.push(
      response,
    );
  }, response);
  if (quit) await app.evaluate(({ app }) => app.quit());
  else
    await page
      .getByRole("button", { name: "Close code and preview", exact: true })
      .click();
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as ObservedGlobal).__eveProjectAcceptance.messages.filter(
            (item) => item.message === "Keep your changes before leaving?",
          ).length,
      ),
    )
    .toBe(before + 1);
  if (quit)
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some(
            (view) =>
              view.getVisible() &&
              (view as Electron.WebContentsView).webContents
                ?.getURL()
                .includes("?folder="),
          ),
        ),
      )
      .toBe(true);
}

test("native generic projects retain independent editors, explicit trust, drafts and undo through cancelled and scoped close", async ({}, info) => {
  const alphaFolder = path.join(directory, "alpha"),
    betaFolder = path.join(directory, "beta");
  await mkdir(alphaFolder);
  await mkdir(betaFolder);
  await writeFile(path.join(alphaFolder, "main.txt"), "Alpha original\n");
  await writeFile(path.join(betaFolder, "main.txt"), "Beta original\n");
  await writeFile(
    path.join(alphaFolder, "index.html"),
    "<!doctype html><title>Alpha preview</title><h1>An actual Alpha preview</h1>",
  );
  const alpha = await attach("Alpha project", alphaFolder, true);
  await openFile(alpha.code, "main.txt");
  await replaceText(alpha.code, "Alpha unsaved change");
  expect(await readFile(path.join(alphaFolder, "main.txt"), "utf8")).toBe(
    "Alpha original\n",
  );
  const beta = await attach("Beta project", betaFolder);
  await openFile(beta.code, "main.txt");
  await replaceText(beta.code, "Beta unsaved change");
  await beta.code.keyboard.press(`${mod}+n`);
  await expect(beta.code.getByRole("tab", { name: /Untitled/ })).toBeVisible();
  await replaceText(beta.code, "Beta untitled thought");
  expect(alpha.code).not.toBe(beta.code);
  const isolated = await app.evaluate(
    ({ webContents }, folders) => {
      const contents = folders.map((folder) =>
        webContents.getAllWebContents().find((contents) => {
          try {
            return (
              new URL(contents.getURL()).searchParams.get("folder") === folder
            );
          } catch {
            return false;
          }
        }),
      );
      return (
        !!contents[0] &&
        !!contents[1] &&
        contents[0].session !== contents[1].session
      );
    },
    [alphaFolder, betaFolder],
  );
  expect(isolated).toBe(true);

  await closeDecision(2, true);
  expect(alpha.code.isClosed()).toBe(false);
  expect(beta.code.isClosed()).toBe(false);
  await closeDecision(1, true);
  const reviewOwner = await app.evaluate(
    () =>
      (globalThis as ObservedGlobal).__eveProjectAcceptance.messages
        .filter((item) => item.message === "Keep your changes before leaving?")
        .at(-1)!.detail!,
  );
  await expect(
    page.getByRole("heading", {
      name: reviewOwner.includes("Alpha project")
        ? "Alpha project"
        : "Beta project",
      exact: true,
    }),
  ).toBeVisible();
  await expect(alpha.code.locator(".view-lines").first()).toContainText(
    "Alpha unsaved change",
  );
  await expect(beta.code.locator(".view-lines").first()).toContainText(
    "Beta untitled thought",
  );
  expect(beta.code.isClosed()).toBe(false);
  await recall("Alpha project");
  await alpha.code.locator(".view-lines").first().click();
  await alpha.code.keyboard.press(`${mod}+z`);
  await expect(alpha.code.locator(".view-lines").first()).not.toContainText(
    "Alpha unsaved change",
  );
  await alpha.code.keyboard.press(`${mod}+Shift+z`);
  await expect(alpha.code.locator(".view-lines").first()).toContainText(
    "Alpha unsaved change",
  );
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await closeDecision(2);
  await expect(
    page.getByText("Your code and preview remain open.", { exact: true }),
  ).toBeVisible();
  expect(alpha.code.isClosed()).toBe(false);
  expect(beta.code.isClosed()).toBe(false);
  await closeDecision(0);
  await expect.poll(() => alpha.code.isClosed()).toBe(true);
  expect(beta.code.isClosed()).toBe(false);
  expect(await readFile(path.join(alphaFolder, "main.txt"), "utf8")).toBe(
    "Alpha unsaved change",
  );
  await page
    .getByRole("button", { name: "Review and open code", exact: true })
    .click();
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .some((candidate) => {
            try {
              return (
                candidate !== alpha.code &&
                new URL(candidate.url()).searchParams.get("folder") ===
                  alphaFolder
              );
            } catch {
              return false;
            }
          }),
      { timeout: 45_000 },
    )
    .toBe(true);
  const reopenedAlpha = app
    .context()
    .pages()
    .find((candidate) => {
      try {
        return (
          candidate !== alpha.code &&
          new URL(candidate.url()).searchParams.get("folder") === alphaFolder
        );
      } catch {
        return false;
      }
    })!;
  await expect(reopenedAlpha.locator(".monaco-workbench")).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some(
          (candidate) =>
            candidate.url().startsWith("http:") &&
            candidate.url().includes("/index.html"),
        ),
    )
    .toBe(true);
  const preview = app
    .context()
    .pages()
    .find(
      (candidate) =>
        candidate.url().startsWith("http:") &&
        candidate.url().includes("/index.html"),
    )!;
  await expect(
    preview.getByRole("heading", {
      name: "An actual Alpha preview",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await openFile(reopenedAlpha, "index.html", true);
  await replaceText(
    reopenedAlpha,
    "<!doctype html><title>Alpha preview</title><h1>Alpha after a real save</h1>",
  );
  await reopenedAlpha.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => readFile(path.join(alphaFolder, "index.html"), "utf8"))
    .toContain("Alpha after a real save");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    preview.getByRole("heading", {
      name: "An actual Alpha preview",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reload preview", exact: true })
    .click();
  await expect(
    preview.getByRole("heading", {
      name: "Alpha after a real save",
      exact: true,
    }),
  ).toBeVisible();
  const screenshot = info.outputPath("native-generic-preview.png");
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow }, url) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some(
            (view) =>
              view.getVisible() &&
              (view as Electron.WebContentsView).webContents?.getURL() === url,
          ),
        preview.url(),
      ),
    )
    .toBe(true);
  await writeFile(
    screenshot,
    Buffer.from(
      await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      ),
      "base64",
    ),
  );
  await info.attach("native-generic-preview.png", {
    path: screenshot,
    contentType: "image/png",
  });
  const previewScreenshot = info.outputPath("native-preview-content.png");
  await preview.screenshot({ path: previewScreenshot });
  await info.attach("native-preview-content.png", {
    path: previewScreenshot,
    contentType: "image/png",
  });

  await recall("Beta project");
  await expect(beta.code.getByRole("tab", { name: /Untitled/ })).toBeVisible();
  await expect(beta.code.locator(".view-lines").first()).toContainText(
    "Beta untitled thought",
  );
  await openFile(beta.code, "main.txt");
  await expect(beta.code.locator(".view-lines").first()).toContainText(
    "Beta unsaved change",
  );
  await beta.code.locator(".view-lines").first().click();
  await beta.code.keyboard.press(`${mod}+z`);
  await expect(beta.code.locator(".view-lines").first()).not.toContainText(
    "Beta unsaved change",
  );
  expect(await readFile(path.join(betaFolder, "main.txt"), "utf8")).toBe(
    "Beta original\n",
  );
  await beta.code.keyboard.press(`${mod}+Shift+z`);
  await expect(beta.code.locator(".view-lines").first()).toContainText(
    "Beta unsaved change",
  );
  await beta.code.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => readFile(path.join(betaFolder, "main.txt"), "utf8"))
    .toBe("Beta unsaved change");
  if (process.platform === "darwin") {
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === "Export workspace backup…")!
        .click(),
    );
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as ObservedGlobal).__eveProjectAcceptance
              .saveChooserCalls,
        ),
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          app.evaluate(() =>
            (globalThis as ObservedGlobal).__eveProjectAcceptance.messages.find(
              (item) => item.message === "The backup could not finish.",
            ),
          ),
        { timeout: 35_000 },
      )
      .toMatchObject({
        detail: expect.stringMatching(/Linux|pause|supported/i),
      });
    expect(
      await stat(path.join(directory, "refused-backup")).catch(() => undefined),
    ).toBeUndefined();
    expect(beta.code.isClosed()).toBe(false);
  }
  await info.attach("native-project-decisions.json", {
    body: JSON.stringify(
      await app.evaluate(
        () => (globalThis as ObservedGlobal).__eveProjectAcceptance.messages,
      ),
      null,
      2,
    ),
    contentType: "application/json",
  });
  // Explicitly discard only this test's untitled fixture through the actual editor.
  expect(
    await app.evaluate(() =>
      (globalThis as ObservedGlobal).__eveProjectAcceptance.messages.filter(
        (item) => item.buttons?.[0] === "Recover drafts",
      ),
    ),
  ).toEqual([]);
  await beta.code.getByRole("tab", { name: /Untitled/ }).click();
  await beta.code.locator(".view-lines").first().click();
  await beta.code.keyboard.press("F1");
  await expect(beta.code.locator(".quick-input-widget input")).toBeVisible();
  await beta.code
    .locator(".quick-input-widget input")
    .fill(">View: Close Editor");
  await beta.code
    .getByRole("option")
    .filter({ hasText: "View: Close Editor" })
    .first()
    .click();
  await beta.code.getByRole("button", { name: /Don.t Save/ }).click();
  await expect(beta.code.getByRole("tab", { name: /Untitled/ })).toHaveCount(0);
});
