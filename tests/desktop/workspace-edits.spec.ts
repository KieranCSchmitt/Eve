import { openInitialSpace } from "./home-helpers";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import electronPath from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IntentResponse } from "../../apps/desktop/shared/bridge";

// Contract acceptance with an explicitly controlled local HTTP provider. This
// qualifies real capture/review/apply/undo, not live Nemotron or model quality.
const original =
  'export const greeting = "<h1>Hello</h1>";\nexport const detail = "Keep going.";\nexport const message = () => greeting + detail;\n';
const edits = [
  {
    path: "message.ts",
    before: '"<h1>Hello</h1>"',
    after: '"<h1>Welcome, makers.</h1>"',
  },
  {
    path: "message.ts",
    before: '"Keep going."',
    after: '"Make room for your next idea."',
  },
];
const changed = edits.reduce(
  (text, edit) => text.replace(edit.before, edit.after),
  original,
);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const mod = process.platform === "darwin" ? "Meta" : "Control";
let app: ElectronApplication | undefined;
let page: Page;
let directory: string;
let profile: string;
let project: string;
let server: Server;
let requests: Array<{
  request: string;
  targets: Array<{
    id: string;
    revision: number;
    kind: string;
    files?: Array<{ path: string; content: string }>;
  }>;
}>;
let providerErrors: string[];
let setupOutput = "";
let journalRequest: string | undefined;
test.setTimeout(150_000);
test.skip(
  process.platform !== "darwin",
  "This native provider fixture currently matches Playwright's macOS mock-keychain backend; Linux keyring qualification is separate.",
);

function environment() {
  return {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && key !== "ELECTRON_RUN_AS_NODE",
      ),
    ) as Record<string, string>),
    EVE_PROFILE_PATH: profile,
  };
}

async function configureProvider(endpoint: string) {
  const child = spawn(
    electronPath as unknown as string,
    // Playwright's Electron loader adds this switch on launch. Match that
    // no-secret test backend during setup; do not claim OS keychain qualification.
    ["--use-mock-keychain", ".", "--configure-provider"],
    { env: environment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  child.stdin.end(
    JSON.stringify({
      storage: "secure",
      confirmedLocalIdle: true,
      provider: {
        id: "native-contract-provider",
        kind: "nemotron",
        endpoint,
        protocol: "openai-chat-completions",
        outputMode: "json-schema",
        authentication: "none",
        cancellationMode: "verified-disconnect",
        model: "controlled-contract-fixture",
        enabled: true,
        roles: ["explain", "code"],
      },
    }),
  );
  try {
    const code = await finished;
    setupOutput = output;
    expect(code, output).toBe(0);
  } finally {
    clearTimeout(timeout);
  }
}

test.beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "eve-shell-workspace-")),
  );
  profile = path.join(directory, "profile");
  project = path.join(directory, "Welcome project");
  await mkdir(project);
  await writeFile(path.join(project, "message.ts"), original);
  requests = [];
  providerErrors = [];
  journalRequest = undefined;
  server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const data = JSON.parse(
        input.messages.find((message) => message.role === "user")!.content,
      ) as (typeof requests)[number];
      requests.push(data);
      const target = data.targets.find((target) => target.kind === "workspace");
      if (
        !target ||
        target.files?.length !== 1 ||
        target.files[0].path !== "message.ts"
      )
        throw new Error("The real selection did not admit exactly message.ts.");
      const proposal = JSON.stringify({
        version: 1,
        message:
          "The controlled contract provider proposes two wording changes.",
        basis: "selection",
        citations: [],
        actions: [
          {
            type: "ProposeWorkspaceEdit",
            targetId: target.id,
            expectedRevision: target.revision,
            edits,
          },
        ],
        needsClarification: false,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: proposal }, finish_reason: null }] })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      providerErrors.push(String(error));
      response.writeHead(500);
      response.end("Contract fixture could not read the captured selection.");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture endpoint");
  await configureProvider(
    `http://127.0.0.1:${address.port}/v1/chat/completions`,
  );
  expect(
    JSON.parse(
      await readFile(
        path.join(profile, "intelligence/local-safety.json"),
        "utf8",
      ),
    ),
  ).toEqual({ version: 2, uncertain: [], origins: [] });
  app = await electron.launch({ args: [".", "--app"], env: environment() });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await expect(
    page.getByRole("heading", { name: "Make room for focus.", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.eve.intelligenceSettings()))
    .toMatchObject({
      state: "ready",
      localRecoveryRequired: false,
      providers: [
        expect.objectContaining({
          id: "native-contract-provider",
          model: "controlled-contract-fixture",
          kind: "local",
          enabled: true,
          quarantined: false,
        }),
      ],
    });
  await app.evaluate(({ dialog, app, BrowserWindow }, folder) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
    const open = dialog.showOpenDialog.bind(dialog),
      message = dialog.showMessageBox.bind(dialog);
    dialog.showOpenDialog = ((
      ...args: Parameters<typeof dialog.showOpenDialog>
    ) => {
      const options = args.at(-1) as Electron.OpenDialogOptions;
      return options.title === "Choose a project folder"
        ? Promise.resolve({ canceled: false, filePaths: [folder] })
        : Reflect.apply(open, dialog, args);
    }) as typeof dialog.showOpenDialog;
    dialog.showMessageBox = ((
      ...args: Parameters<typeof dialog.showMessageBox>
    ) => {
      const options = args.at(-1) as Electron.MessageBoxOptions;
      if (options.buttons?.[0] === "Trust and open project")
        return Promise.resolve({ response: 0, checkboxChecked: false });
      return Reflect.apply(message, dialog, args);
    }) as typeof dialog.showMessageBox;
  }, project);
});

test.afterEach(async ({}, info) => {
  const failed = info.status !== info.expectedStatus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await writeFile(
      info.outputPath("provider-startup.json"),
      JSON.stringify(
        {
          setupBackend:
            "Playwright mock-keychain; not OS credential qualification",
          setupOutput,
          settings: app
            ? await page
                .evaluate(() => window.eve.intelligenceSettings())
                .catch(() => undefined)
            : undefined,
          files: await readdir(path.join(profile, "intelligence")).catch(
            () => [],
          ),
        },
        null,
        2,
      ),
    );
    await writeFile(
      info.outputPath("provider-contract-observations.json"),
      JSON.stringify({ requests, providerErrors }, null, 2),
    );
    if (app)
      await Promise.race([
        app.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              app?.process().kill("SIGKILL");
              reject(
                new Error("Workspace edit acceptance could not close cleanly."),
              );
            },
            failed ? 5_000 : 15_000,
          );
        }),
      ]);
    if (!failed && journalRequest) {
      // The core holds an exclusive writer lock while running. Inspect the
      // actual durable journal only after its clean close releases ownership.
      const database = new DatabaseSync(path.join(profile, "eve.db"), {
        readOnly: true,
      });
      try {
        const journal = database
          .prepare(
            "SELECT status,input_json,receipt_json FROM workspace_edits WHERE request_id=?",
          )
          .get(journalRequest) as {
          status: string;
          input_json: string;
          receipt_json: string;
        };
        expect(journal.status).toBe("finalized");
        const receipt = JSON.parse(journal.receipt_json);
        const input = JSON.parse(journal.input_json);
        expect(input.documents).toEqual([
          expect.objectContaining({
            relativePath: "message.ts",
            beforeHash: sha(original),
            afterHash: sha(changed),
          }),
        ]);
        expect(receipt.documents).toEqual([
          expect.objectContaining({
            relativePath: "message.ts",
            afterHash: sha(changed),
          }),
        ]);
        await writeFile(
          info.outputPath("durable-workspace-receipt.json"),
          JSON.stringify({ status: journal.status, input, receipt }, null, 2),
        );
      } finally {
        database.close();
      }
    }
  } catch (error) {
    if (!failed) throw error;
  } finally {
    clearTimeout(timer);
    app = undefined;
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function currentOverlay() {
  await expect
    .poll(() =>
      app!
        .context()
        .pages()
        .some((candidate) => candidate.url().endsWith("#overlay")),
    )
    .toBe(true);
  return app!
    .context()
    .pages()
    .find((candidate) => candidate.url().endsWith("#overlay"))!;
}

async function openProject() {
  await page
    .getByRole("button", { name: "Find anything", exact: true })
    .click();
  const recall = await currentOverlay();
  await recall
    .getByRole("combobox", { name: "Search tasks" })
    .fill("Welcome project");
  await recall.getByRole("option", { name: /Make a space for/ }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome project", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const review = page.getByRole("region", {
    name: "Project setup",
    exact: true,
  });
  await expect(
    review.getByRole("radio", { name: /Code and notebook/ }),
  ).toBeChecked();
  await review
    .getByRole("button", { name: "Attach project", exact: true })
    .click();
  await review
    .getByRole("button", { name: "Review and open code", exact: true })
    .click();
  await expect
    .poll(
      () =>
        app!
          .context()
          .pages()
          .some((candidate) => {
            try {
              return (
                new URL(candidate.url()).searchParams.get("folder") === project
              );
            } catch {
              return false;
            }
          }),
      { timeout: 45_000 },
    )
    .toBe(true);
  const code = app!
    .context()
    .pages()
    .find((candidate) => {
      try {
        return new URL(candidate.url()).searchParams.get("folder") === project;
      } catch {
        return false;
      }
    })!;
  await expect(code.locator(".monaco-workbench")).toBeVisible({
    timeout: 45_000,
  });
  await code.keyboard.press(`${mod}+p`);
  const input = code.locator(".quick-input-widget input");
  await expect(input).toBeVisible();
  await input.click();
  await code.keyboard.insertText("message.ts");
  await code
    .getByRole("option")
    .filter({ hasText: "message.ts" })
    .first()
    .click();
  await expect(code.locator(".view-lines").first()).toContainText(
    "Keep going.",
  );
  return code;
}

async function requestChange(code: Page) {
  // The editor can paint before its authenticated Eve bridge has connected.
  // Only a ready bridge can capture the real selected buffer for this test.
  await expect.poll(() => page.evaluate(() => window.eve.status()), { timeout: 30_000 }).toMatchObject({ workbench: "ready" });
  await code.locator(".view-lines").first().click();
  await code.keyboard.press(`${mod}+a`);
  await page
    .getByRole("button", { name: /^(Ask Eve|View response)$/ })
    .click();
  const question = await currentOverlay();
  await question
    .getByRole("textbox", { name: "Ask Eve", exact: true })
    .fill(
      "Rewrite both selected strings to welcome young makers and invite their next idea.",
    );
  await question
    .getByRole("button", { name: "Submit question", exact: true })
    .click();
  await expect(
    question.getByRole("article", {
      name: "Change selected code",
      exact: true,
    }),
  ).toBeVisible();
  return question;
}

test("controlled-provider shell code review applies two literal passages once, supports native Undo, and refuses a stale selection", async ({}, info) => {
  const code = await openProject();
  const observed = await page.evaluateHandle(() => {
    const responses: IntentResponse[] = [];
    window.eve.onIntelligence((event) => {
      if (event.type === "intent") responses.push(event.response);
    });
    return responses;
  });
  const before = await page.evaluate(() => window.eve.snapshot());
  const task = before.tasks.find((task) => task.id === before.activeTaskId)!;
  expect(task.project?.adapter).toBe("generic");
  const question = await requestChange(code);
  expect(providerErrors).toEqual([]);
  expect(
    requests[0].targets.find((target) => target.kind === "workspace")?.files,
  ).toEqual([
    expect.objectContaining({ path: "message.ts", content: original }),
  ]);
  await expect(
    question.getByRole("button", { name: "Apply change", exact: true }),
  ).toBeDisabled();
  await question
    .getByRole("button", { name: "Preview change", exact: true })
    .click();
  await expect(
    question.getByRole("region", { name: "Changed passages", exact: true }),
  ).toContainText("1 file · 2 passages");
  for (const [index, edit] of edits.entries()) {
    await expect(
      question
        .getByRole("region", {
          name: `Before passage ${index + 1} in message.ts`,
          exact: true,
        })
        .locator("code"),
    ).toHaveText(edit.before);
    await expect(
      question
        .getByRole("region", {
          name: `After passage ${index + 1} in message.ts`,
          exact: true,
        })
        .locator("code"),
    ).toHaveText(edit.after);
  }
  expect(await question.locator(".workspace-changes h1").count()).toBe(0);
  await question.screenshot({
    path: info.outputPath("native-workspace-literal-review.png"),
  });
  await question
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await expect(
    question.getByText("Applied to your work", { exact: true }),
  ).toBeVisible();
  await expect(code.locator(".view-lines").first()).toContainText(
    "Welcome, makers.",
  );
  await expect(code.locator(".view-lines").first()).toContainText(
    "Make room for your next idea.",
  );
  const response = await observed.evaluate((responses) => responses.at(-1)!);
  const proposal = response.proposals.find(
    (proposal) => proposal.kind === "workspace",
  )!;
  expect(proposal.status).toBe("applied");
  const snapshot = await page.evaluate(() => window.eve.snapshot());
  expect(
    snapshot.recentActions.filter(
      (action) =>
        action.taskId === task.id && action.type === "ApplyWorkspaceEdit",
    ),
  ).toEqual([
    expect.objectContaining({ requestId: `proposal:${proposal.id}` }),
  ]);
  journalRequest = `proposal:${proposal.id}`;
  const recovery = path.join(profile, "workbench/recovery", task.project!.id);
  const orphanName = (await readdir(recovery)).find((name) =>
    /^orphan-.*\.json$/.test(name),
  )!;
  const orphan = JSON.parse(
    await readFile(path.join(recovery, orphanName), "utf8"),
  );
  expect(orphan.documents).toEqual([
    expect.objectContaining({ text: changed, hash: sha(changed) }),
  ]);
  expect(await readFile(path.join(project, "message.ts"), "utf8")).toBe(
    original,
  );
  await question
    .getByRole("button", { name: "Close question", exact: true })
    .click();
  await code.locator(".view-lines").first().click();
  await code.keyboard.press(`${mod}+z`);
  await expect(code.locator(".view-lines").first()).toContainText(
    "Keep going.",
  );
  await expect(code.locator(".view-lines").first()).toContainText(
    "<h1>Hello</h1>",
  );
  await expect(code.locator(".view-lines").first()).not.toContainText(
    "Welcome, makers.",
  );
  const settledAgain = await page.evaluate(
    (identity) => window.eve.applyProposal(identity),
    { requestId: response.requestId, proposalId: proposal.id },
  );
  expect(
    settledAgain.proposals.find((item) => item.id === proposal.id)?.status,
  ).toBe("applied");
  await expect(code.locator(".view-lines").first()).toContainText(
    "Keep going.",
  );
  await expect(code.locator(".view-lines").first()).not.toContainText(
    "Welcome, makers.",
  );
  // Reading the completed result after native Undo must never replay the edit.
  // A second review is based on a fresh genuine selection. Moving that
  // selection invalidates it; the host may do so immediately or on Apply.
  const staleQuestion = await requestChange(code);
  await staleQuestion
    .getByRole("button", { name: "Close question", exact: true })
    .click();
  await expect(staleQuestion.getByRole("dialog")).toHaveCount(0);
  // Closing a footer-opened question may restore the shell's focus. Make the
  // changed selection a real editor interaction before checking invalidation.
  await code.locator(".view-lines").first().click();
  await code.keyboard.press("ArrowLeft");
  await page
    .getByRole("button", { name: "View response", exact: true })
    .click();
  const stale = await currentOverlay();
  const apply = stale.getByRole("button", {
    name: "Apply change",
    exact: true,
  });
  const contextChanged = stale.getByText("Your work changed · Ask again", {
    exact: true,
  });
  try {
    if (await apply.count()) {
      await stale
        .getByRole("button", { name: "Preview change", exact: true })
        .click({ timeout: 2000 });
      if (await apply.isEnabled().catch(() => false))
        await apply.click({ timeout: 2000 });
    }
  } catch (error) {
    // An authenticated context event can retire either button between the
    // visibility check and its native click. Only the exact stale outcome
    // satisfies this race; every other failure remains an error.
    if (!(await contextChanged.isVisible())) throw error;
  }
  try {
    await expect(contextChanged).toBeVisible();
  } catch (error) {
    await writeFile(
      info.outputPath("stale-review-state.json"),
      JSON.stringify(
        {
          snapshot: await page.evaluate(() => window.eve.snapshot()),
          responses: await observed.jsonValue(),
          overlay: await stale.locator("body").innerText(),
          editor: await code.locator(".view-lines").first().innerText(),
          native: await app!.evaluate(({ BrowserWindow, webContents }) => ({
            focused: webContents.getFocusedWebContents()?.getURL(),
            surfaces: BrowserWindow.getAllWindows()[0].contentView.children.map(
              (view) => ({ visible: view.getVisible() }),
            ),
          })),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  await expect(apply).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.eve.snapshot())).recentActions.filter(
      (action) =>
        action.taskId === task.id && action.type === "ApplyWorkspaceEdit",
    ),
  ).toHaveLength(1);
  expect(providerErrors).toEqual([]);
  expect(requests).toHaveLength(2);
  expect(await readFile(path.join(project, "message.ts"), "utf8")).toBe(
    original,
  );
  await stale
    .getByRole("button", { name: "Close question", exact: true })
    .click();
  await expect(code.locator(".view-lines").first()).toContainText(
    "Keep going.",
  );
});
