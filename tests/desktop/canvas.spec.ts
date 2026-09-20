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
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizedImageAdjustments, type CanvasDocument, type CoreSnapshot } from "@eve/contracts";
import type { IntentResponse } from "../../apps/desktop/shared/bridge";
import { expectHome } from "./home-helpers";

// Actual Electron/utility-process/core acceptance with a controlled loopback
// provider. This is contract and persistence evidence, never live model quality
// or real OS credential-store qualification.
test.setTimeout(120_000);
test.skip(
  process.platform !== "darwin",
  "This no-secret setup matches Playwright's macOS mock-keychain backend; Linux keyring qualification is separate.",
);

const requestText = "Make a reading plan with a checklist and a small budget.";
const blockBase = { placement: "main" as const, pinned: false, sourceIds: [] };
const composition: CanvasDocument = {
  version: 1,
  title: "A little room to read",
  subtitle:
    "A draft to shape around your afternoon. The budget values are editable examples.",
  layout: "split",
  blocks: [
    {
      ...blockBase,
      id: "reading-note",
      kind: "text",
      title: "A place to begin",
      body: "Choose a chapter and leave yourself a little time to think.",
    },
    {
      ...blockBase,
      id: "reading-checklist",
      kind: "checklist",
      title: "Before you begin",
      placement: "aside",
      items: [
        { id: "choose-book", label: "Choose a book", checked: false },
        { id: "quiet-place", label: "Find a quiet place", checked: false },
      ],
    },
    {
      ...blockBase,
      id: "reading-budget",
      kind: "table",
      title: "An example budget",
      placement: "full",
      columns: ["Item", "Amount"],
      rows: [
        { id: "budget", cells: ["Budget", "50"] },
        { id: "book", cells: ["Book", "12"] },
        { id: "remaining", cells: ["Remaining", "=B1-B2"] },
      ],
    },
  ],
};
interface CapturedRequest {
  request: string;
  canvasSuggestionRefresh?: {
    targetId: string;
    canvasRevision: number;
    scope?: {
      blockId: string;
      selection?: { field: "body"; start: number; end: number; text: string };
    };
  };
  canvasSuggestion?: {
    id: string;
    canvasRevision: number;
    targetBlockId: string | null;
  };
  targets: Array<{
    id: string;
    kind: string;
    revision: number;
    canvas?: CanvasDocument;
  }>;
}
let app: ElectronApplication | undefined;
let page: Page;
let directory: string;
let profile: string;
let server: Server;
let requests: CapturedRequest[];
let providerErrors: string[];
let deferred: Array<() => void>;
let holdResponses: boolean;
let setupOutput: string;
let replyDocument: (
  data: CapturedRequest,
  target: CapturedRequest["targets"][number],
) => unknown;

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
    ["--use-mock-keychain", ".", "--configure-provider"],
    { env: environment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  setupOutput = "";
  child.stdout.on("data", (data) => {
    setupOutput += data.toString();
  });
  child.stderr.on("data", (data) => {
    setupOutput += data.toString();
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
        id: "canvas-contract-provider",
        kind: "nemotron",
        endpoint,
        protocol: "openai-chat-completions",
        outputMode: "json-schema",
        authentication: "none",
        cancellationMode: "verified-disconnect",
        model: "controlled-canvas-contract",
        enabled: true,
        roles: ["route", "explain", "prepare"],
      },
    }),
  );
  try {
    expect(await finished, setupOutput).toBe(0);
  } finally {
    clearTimeout(timeout);
  }
}
async function launch() {
  app = await electron.launch({ args: [".", "--app"], env: environment() });
  page = await app.firstWindow();
  await expectHome(page);
  await expect
    .poll(() => page.evaluate(() => window.eve.intelligenceSettings()))
    .toMatchObject({
      state: "ready",
      providers: [
        expect.objectContaining({
          id: "canvas-contract-provider",
          enabled: true,
          quarantined: false,
        }),
      ],
    });
}
async function closeApplication(failed = false) {
  const closing = app;
  if (!closing) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closing.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            closing.process().kill("SIGKILL");
            reject(
              new Error(
                "The disposable canvas acceptance app did not close cleanly.",
              ),
            );
          },
          failed ? 4000 : 15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    app = undefined;
  }
}
function sendComposition(
  response: ServerResponse,
  target: CapturedRequest["targets"][number],
  data: CapturedRequest,
) {
  if (response.destroyed) return;
  const proposal = JSON.stringify({
    version: 1,
    message: "Here is a reading space with editable examples.",
    basis: "general",
    citations: [],
    actions: data.canvasSuggestionRefresh ? [{
      type: "PatchCanvas", targetId: target.id, expectedRevision: target.revision, edits: [],
      suggestions: (replyDocument(data, target) as CanvasDocument).suggestions ?? [],
    }] : [
      {
        type: "ComposeCanvas",
        targetId: target.id,
        expectedRevision: target.revision,
        document: replyDocument(data, target),
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
}

test.beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "eve-native-canvas-")),
  );
  profile = path.join(directory, "profile");
  requests = [];
  providerErrors = [];
  deferred = [];
  holdResponses = false;
  replyDocument = () => composition;
  server = createServer(async (incoming, response) => {
    try {
      let body = "";
      for await (const chunk of incoming) body += chunk.toString();
      const envelope = JSON.parse(body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const data = JSON.parse(
        envelope.messages.find((message) => message.role === "user")!.content,
      ) as CapturedRequest;
      requests.push(data);
      const targets = data.targets.filter((target) => target.kind === "canvas");
      if (targets.length !== 1)
        throw new Error(
          "The real model request did not contain exactly one canvas target.",
        );
      if (holdResponses)
        deferred.push(() => sendComposition(response, targets[0], data));
      else sendComposition(response, targets[0], data);
    } catch (error) {
      providerErrors.push(String(error));
      response.writeHead(500);
      response.end("Controlled canvas provider could not read its target.");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No controlled provider endpoint.");
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
  await launch();
});

test("fresh next steps preserve native writing and continue by clicking after choices are consumed", async ({}, info) => {
  await submitFromHome();
  const writer = page.getByRole('textbox', { name: 'A place to begin text', exact: true });
  const retainedWriter = await writer.elementHandle();
  if (!retainedWriter) throw new Error('The live writer is unavailable.');
  await writer.focus();
  await writer.evaluate(element => { const field = element as HTMLTextAreaElement; field.setSelectionRange(field.value.length, field.value.length); });
  await page.keyboard.insertText(' My next thought.');
  const authored = await writer.inputValue();
  const added = { id: 'reading-observations', kind: 'checklist' as const, title: 'My observations', placement: 'aside' as const, pinned: false, sourceIds: [], items: [] };
  const choice = { id: 'collect-observations', label: 'Collect observations', description: 'Add a blank checklist beside the reading notes.', request: 'Add a blank checklist for my reading observations beside the notes.', targetBlockId: null,
    prepared: { edits: [{ type: 'add', block: added }], arrangement: null } };
  replyDocument = (_data, target) => ({ ...target.canvas!, suggestions: [choice] });
  holdResponses = true;
  const nextSteps = page.getByRole('region', { name: 'Next steps', exact: true });
  await nextSteps.getByRole('button', { name: 'Suggest next steps', exact: true }).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect.poll(() => requests.length).toBe(2);
  const before = await current();
  expect(requests[1]!.canvasSuggestionRefresh).toEqual({ targetId: `${before.id}:canvas`, canvasRevision: before.canvas!.revision });
  expect(requests[1]!.targets[0]!.canvas!.blocks[0]).toMatchObject({ body: authored });
  expect(requests[1]!.targets.every(target => target.kind === 'canvas')).toBe(true);
  await expect(nextSteps).toContainText('Finding next steps');
  expect(before.canvas!.document!.suggestions ?? []).toEqual([]);
  await writer.focus();
  await writer.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(4, 12, 'backward'));
  holdResponses = false; deferred.splice(0).forEach(release => release());
  const card = page.getByRole('button', { name: choice.label, exact: true });
  await expect(card).toBeVisible();
  await expect.poll(async () => (await current()).canvas!.revision).toBe(before.canvas!.revision + 1);
  expect((await current()).canvas!.document!.blocks).toEqual(before.canvas!.document!.blocks);
  await expect(writer).toBeFocused();
  expect(await writer.evaluate(element => { const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd, field.selectionDirection]; })).toEqual([4, 12, 'backward']);
  expect(await writer.evaluate((element, previous) => element === previous, retainedWriter)).toBe(true);
  await card.click();
  const review = page.getByRole('region', { name: 'Suggestion preview', exact: true });
  await expect(review).toBeVisible(); expect(requests).toHaveLength(2);
  await review.getByRole('button', { name: 'Keep', exact: true }).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.locator('[data-canvas-block-id="reading-observations"]')).toBeVisible();
  await expect.poll(async () => (await current()).canvas!.revision).toBe(before.canvas!.revision + 2);
  expect(requests).toHaveLength(2); await expect(writer).toHaveValue(authored);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-canvas-block-id="reading-observations"]')).toHaveCount(0);
  await card.click(); await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(page.locator('[data-canvas-block-id="reading-observations"]')).toBeVisible();
  await writer.focus(); await writer.press('ControlOrMeta+z');
  await expect(writer).toHaveValue(composition.blocks[0]!.kind === 'text' ? composition.blocks[0]!.body : '');
  await writer.press('ControlOrMeta+Shift+z'); await expect(writer).toHaveValue(authored);
  await expect(page.locator('.canvas-status')).toContainText('Saved');
  const afterKeep = await current();
  replyDocument = (_data, target) => ({ ...target.canvas!, suggestions: [] });
  await nextSteps.getByRole('button', { name: 'Suggest next steps', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(nextSteps).toContainText('No useful next step');
  await expect.poll(async () => (await current()).canvas!.revision).toBe(afterKeep.canvas!.revision + 1);
  expect((await current()).canvas!.document!.blocks).toEqual(afterKeep.canvas!.document!.blocks);
  expect(requests[2]!.targets[0]!.canvas!.blocks).toEqual(afterKeep.canvas!.document!.blocks);
  expect(await writer.evaluate((element, previous) => element === previous, retainedWriter)).toBe(true);
  await nextSteps.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('next-steps-native-empty.png') });
  const kept = await current();
  await nativeHome(); await closeApplication();
  const database = new DatabaseSync(path.join(profile, 'eve.db'), { readOnly: true });
  try {
    const row = database.prepare('SELECT value,revision FROM canvases WHERE task_id=?').get(kept.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document); expect(row.revision).toBe(kept.canvas!.revision);
    await writeFile(info.outputPath('next-steps-durable-evidence.json'), JSON.stringify({ document: JSON.parse(row.value), revision: row.revision, providerRequests: requests.length, authored }, null, 2));
  } finally { database.close(); }
  await launch();
  await page.getByTestId('home').getByRole('button', { name: `Open ${requestText}`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'A place to begin text', exact: true })).toHaveValue(authored);
  expect((await current()).canvas!.document).toEqual(kept.canvas!.document);
  await expect(page.getByRole('region', { name: 'Next steps', exact: true }).getByRole('button', { name: 'Suggest next steps', exact: true })).toBeVisible();
  expect(requests).toHaveLength(3); expect(providerErrors).toEqual([]);
});

test.afterEach(async ({}, info) => {
  const failed = info.status !== info.expectedStatus;
  try {
    await writeFile(
      info.outputPath("canvas-provider-evidence.json"),
      JSON.stringify(
        {
          credentialBackend:
            "Playwright mock-keychain; no real secrets or OS keychain qualification",
          setupOutput,
          requests,
          providerErrors,
        },
        null,
        2,
      ),
    );
    await closeApplication(failed);
  } catch (error) {
    if (!failed) throw error;
  } finally {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function submitFromHome() {
  await page
    .getByRole("textbox", { name: "What would you like to make?", exact: true })
    .fill(requestText);
  await page
    .getByRole("button", { name: "Create with Eve", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(1);
}
async function nativeHome() {
  await app!.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!
      .items.find((item) => item.label === "View")!
      .submenu!.items.find((item) => item.label === "Home");
    if (!item) throw new Error("The native Home action is missing.");
    item.click(undefined, undefined, undefined as never);
  });
  await expectHome(page);
}
const current = () =>
  page.evaluate(async () => {
    const snapshot = await window.eve.snapshot();
    return snapshot.tasks.find((task) => task.id === snapshot.activeTaskId)!;
  });

test("Home intent composes through the actual model worker and core; edits, Undo, Home flush and restart retain the canvas", async ({}, info) => {
  const observed = await page.evaluateHandle(() => {
    const values: IntentResponse[] = [];
    window.eve.onIntelligence((event) => {
      if (event.type === "intent") values.push(event.response);
    });
    return values;
  });
  await submitFromHome();
  await expect(
    page.getByRole("heading", { name: composition.title, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect(providerErrors).toEqual([]);
  expect(requests[0].request).toBe(requestText);
  const initial = await current();
  expect(initial.canvas).toMatchObject({ revision: 1, document: composition });
  expect(
    requests[0].targets.find((target) => target.kind === "canvas"),
  ).toMatchObject({ id: `${initial.id}:canvas`, revision: 0 });
  await expect
    .poll(() => observed.evaluate((values) => values.at(-1)))
    .toMatchObject({
      status: "complete",
      proposals: [
        expect.objectContaining({ kind: "canvas", status: "applied" }),
      ],
    });
  await expect(
    page.locator('.canvas-table input[aria-label="B3: Amount"]'),
  ).toHaveValue("38");
  const text = page.getByRole("textbox", {
    name: "A place to begin text",
    exact: true,
  });
  const revised = "Read the opening chapter and write down one question.";
  await text.fill(revised);
  await expect
    .poll(async () =>
      (await current()).canvas?.document?.blocks.find(
        (block) => block.id === "reading-note",
      ),
    )
    .toMatchObject({ body: revised });
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await page
    .getByRole("checkbox", { name: "Choose a book", exact: true })
    .check();
  await expect
    .poll(async () =>
      (await current()).canvas?.document?.blocks.find(
        (block) => block.id === "reading-checklist",
      ),
    )
    .toMatchObject({
      items: [
        expect.objectContaining({ id: "choose-book", checked: true }),
        expect.anything(),
      ],
    });
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await page
    .locator(".canvas-footer")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Choose a book", exact: true }),
  ).not.toBeChecked();
  await expect
    .poll(async () =>
      (await current()).canvas?.document?.blocks.find(
        (block) => block.id === "reading-checklist",
      ),
    )
    .toMatchObject({
      items: [
        expect.objectContaining({ id: "choose-book", checked: false }),
        expect.anything(),
      ],
    });
  await expect(text).toHaveValue(revised);

  // Trigger native Home before the debounce can complete. The navigation owns
  // the real save flush; no IPC, database writer or renderer bridge is replaced.
  const finalText = "Keep this last thought, even when I leave immediately.";
  await text.fill(finalText);
  await nativeHome();
  const saved = await page.evaluate(
    async (id) =>
      (await window.eve.snapshot()).tasks.find((task) => task.id === id)!,
    initial.id,
  );
  expect(
    saved.canvas?.document?.blocks.find((block) => block.id === "reading-note"),
  ).toMatchObject({ body: finalText });
  expect(saved.checkpoint?.selectedActivity).toBe("canvas");
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "A place to begin text", exact: true }),
  ).toHaveValue(finalText);
  const finalDocument = (await current()).canvas!.document;
  await info.attach("native-canvas.png", {
    body: Buffer.from(
      await app!.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      ),
      "base64",
    ),
    contentType: "image/png",
  });
  await closeApplication();

  // Read canonical SQLite bytes after the actual writer relinquishes its lock.
  const database = new DatabaseSync(path.join(profile, "eve.db"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value,revision FROM canvases WHERE task_id=?")
      .get(initial.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(finalDocument);
    expect(row.revision).toBeGreaterThanOrEqual(5);
    const history = database
      .prepare(
        "SELECT type,undone FROM operations WHERE task_id=? ORDER BY rowid",
      )
      .all(initial.id);
    expect(history).toContainEqual(
      expect.objectContaining({ type: "UpdateCanvas", undone: 1 }),
    );
    expect(history).toContainEqual(expect.objectContaining({ type: "Undo" }));
    await writeFile(
      info.outputPath("canvas-durable-evidence.json"),
      JSON.stringify(
        {
          taskId: initial.id,
          revision: row.revision,
          document: JSON.parse(row.value),
          history,
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
  await launch();
  expect(
    (await page.evaluate(() => window.eve.snapshot())).activeTaskId,
  ).toBeNull();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: composition.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "A place to begin text", exact: true }),
  ).toHaveValue(finalText);
  await expect(
    page.getByRole("checkbox", { name: "Choose a book", exact: true }),
  ).not.toBeChecked();
  expect((await current()).canvas?.document).toEqual(finalDocument);
  expect(requests).toHaveLength(1);
});

test("Home retires a slow real provider request before its prepared canvas can become durable or reclaim attention", async () => {
  holdResponses = true;
  const observed = await page.evaluateHandle(() => {
    const values: IntentResponse[] = [];
    window.eve.onIntelligence((event) => {
      if (event.type === "intent") values.push(event.response);
    });
    return values;
  });
  await submitFromHome();
  const task = await current();
  expect(task.canvas).toBeNull();
  await expect.poll(() => deferred.length).toBe(1);
  await nativeHome();
  deferred.splice(0).forEach((send) => send());
  // Wait for the host's real invalidation event rather than substituting a
  // late renderer event or replacing the core's durable state.
  await expect
    .poll(() => observed.evaluate((values) => values.at(-1)?.status))
    .toBe("stale");
  const after: CoreSnapshot = await page.evaluate(() => window.eve.snapshot());
  expect(after.activeTaskId).toBeNull();
  expect(
    after.tasks.find((candidate) => candidate.id === task.id)?.canvas,
  ).toBeNull();
  expect(
    after.recentActions.filter(
      (action) => action.taskId === task.id && action.type === "UpdateCanvas",
    ),
  ).toEqual([]);
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("canvas")).toHaveCount(0);
  expect(providerErrors).toEqual([]);
});

test("writing opens blank without inference and a requested deadline is immediately editable and durable", async ({}, info) => {
  const prompt = "I need to write an essay about dogs dreaming";
  await page
    .getByRole("textbox", { name: "What would you like to make?", exact: true })
    .fill(prompt);
  const started = performance.now();
  await page
    .getByRole("button", { name: "Create with Eve", exact: true })
    .click();
  const writer = page.getByRole("textbox", {
    name: "Canvas text",
    exact: true,
  });
  await expect(writer).toBeVisible({ timeout: 5000 });
  const blankReadyMs = Math.round(performance.now() - started);
  await expect(writer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Make an outline", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await writer.fill("This is my own first sentence.");
  await page
    .getByRole("textbox", { name: "Ask Eve", exact: true })
    .fill("Add a due date countdown");
  const toolStarted = performance.now();
  await page
    .getByRole("button", { name: "Send request to Eve", exact: true })
    .click();
  const date = page.getByLabel("Due date and time", { exact: true });
  await expect(date).toBeVisible({ timeout: 5000 });
  const deadlineReadyMs = Math.round(performance.now() - toolStarted);
  await expect(date).toHaveValue("");
  await expect(writer).toHaveValue("This is my own first sentence.");
  expect(requests).toHaveLength(0);
  await date.fill("2030-06-01T15:00");
  await page.getByRole("button", { name: "Set date", exact: true }).click();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const before = (await current()).canvas!.document!;
  expect(
    before.blocks.find((block) => block.kind === "deadline"),
  ).toMatchObject({ dueAt: expect.any(Number) });
  await page.screenshot({
    path: info.outputPath("native-blank-writing-deadline.png"),
  });
  await writeFile(
    info.outputPath("direct-interaction-timing.json"),
    JSON.stringify(
      { blankReadyMs, deadlineReadyMs, modelRequests: requests.length },
      null,
      2,
    ),
  );
  await nativeHome();
  await closeApplication();
  await launch();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${prompt}`, exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Canvas text", exact: true }),
  ).toHaveValue("This is my own first sentence.");
  expect((await current()).canvas!.document).toEqual(before);
  expect(requests).toHaveLength(0);
});

test("a suggestion click flushes the current revision, dispatches once with trusted scope, and retains local tools and edits after restart", async ({}, info) => {
  const suggestion = {
    id: "prepare-reading-steps",
    label: "Shape a reading plan",
    description: "Turn these intentions into three practical steps.",
    request:
      "Help me turn this reading checklist into a practical three-step plan.",
    targetBlockId: "reading-checklist",
  };
  const unrelated = {
    id: "reflect-later",
    label: "Make room for reflection",
    description: "Add a place to keep a question after reading.",
    request: "Add a blank place for reflection after reading.",
    targetBlockId: null,
  };
  const seed: CanvasDocument = {
    ...composition,
    suggestions: [suggestion, unrelated],
  };
  const plannedSteps = [
    { id: "choose-book", label: "Choose a chapter to read", checked: false },
    {
      id: "quiet-place",
      label: "Find a quiet place for the chapter",
      checked: false,
    },
    {
      id: "one-question",
      label: "Write down one question afterward",
      checked: false,
    },
  ];
  replyDocument = (request, target) =>
    request.canvasSuggestion
      ? {
          ...target.canvas!,
          blocks: target.canvas!.blocks.map((block) =>
            block.id === suggestion.targetBlockId && block.kind === "checklist"
              ? { ...block, items: plannedSteps }
              : block,
          ),
          suggestions: [unrelated],
        }
      : seed;
  const observed = await page.evaluateHandle(() => {
    const values: IntentResponse[] = [];
    window.eve.onIntelligence((event) => {
      if (event.type === "intent") values.push(event.response);
    });
    return values;
  });
  await submitFromHome();
  const choose = page.getByRole("button", {
    name: suggestion.label,
    exact: true,
  });
  await expect(choose).toBeVisible({ timeout: 30_000 });
  expect(
    await page.evaluate(() => CSS.supports("reading-flow", "grid-rows")),
  ).toBe(true);
  await expect(page.locator(".canvas-layout")).toHaveCSS(
    "reading-flow",
    "grid-rows",
  );
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const seeded = await current();
  expect(seeded.canvas).toMatchObject({ revision: 1, document: seed });
  expect(requests[0].canvasSuggestion).toBeUndefined();
  await page.screenshot({
    path: info.outputPath("native-suggestion-ready.png"),
  });

  // Ordinary tool creation must reach the real core without provider work.
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("button", { name: "Add sources", exact: true }).click();
  await expect.poll(async () => (await current()).canvas?.revision).toBe(2);
  const locallyEdited = await current();
  const localTool = locallyEdited.canvas!.document!.blocks.at(-1)!;
  expect(localTool).toMatchObject({
    kind: "sources",
    title: "Related material",
    description: "",
    sourceIds: [],
  });
  expect(requests).toHaveLength(1);

  holdResponses = true;
  const text = page.getByRole("textbox", {
    name: "A place to begin text",
    exact: true,
  });
  const ownWords =
    "My own plan is to read slowly and keep one useful question.";
  await text.fill(ownWords);
  // Both physical clicks happen before the held provider can answer. The first
  // click must flush this unsaved edit and the pending gate must stop the second.
  await choose.click({ clickCount: 2, delay: 25 });
  await expect(choose).toBeDisabled();
  await expect(
    page.getByRole("button", { name: unrelated.label, exact: true }),
  ).toBeDisabled();
  await expect.poll(() => requests.length).toBe(2);
  await expect.poll(() => deferred.length).toBe(1);
  const captured = requests[1];
  const afterFlush = await current();
  expect(afterFlush.canvas?.revision).toBe(3);
  expect(captured.request).toBe(suggestion.request);
  expect(captured.canvasSuggestion).toEqual({
    id: suggestion.id,
    canvasRevision: 3,
    targetBlockId: suggestion.targetBlockId,
  });
  expect(captured.targets).toHaveLength(1);
  expect(captured.targets[0]).toMatchObject({
    id: `${seeded.id}:canvas`,
    kind: "canvas",
    revision: 3,
    canvas: afterFlush.canvas!.document,
  });
  expect(
    captured.targets[0].canvas?.blocks.find(
      (block) => block.id === "reading-note",
    ),
  ).toMatchObject({ body: ownWords });
  expect(captured.targets[0].canvas?.blocks.at(-1)).toEqual(localTool);
  expect(
    await observed.evaluate(
      (values) => [...new Set(values.map((value) => value.requestId))].length,
    ),
  ).toBe(2);

  deferred.splice(0).forEach((send) => send());
  await expect(
    page.getByRole("checkbox", {
      name: "Write down one question afterward",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(choose).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: unrelated.label, exact: true }),
  ).toBeEnabled();
  await expect(text).toHaveValue(ownWords);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await expect
    .poll(() => observed.evaluate((values) => values.at(-1)))
    .toMatchObject({
      status: "complete",
      proposals: [
        expect.objectContaining({ kind: "canvas", status: "applied" }),
      ],
    });
  const final = await current();
  const finalDocument = final.canvas!.document!;
  expect(final.canvas?.revision).toBe(4);
  expect(
    finalDocument.blocks.find((block) => block.id === suggestion.targetBlockId),
  ).toMatchObject({ items: plannedSteps });
  expect(
    finalDocument.blocks.filter(
      (block) => block.id !== suggestion.targetBlockId,
    ),
  ).toEqual(
    afterFlush.canvas!.document!.blocks.filter(
      (block) => block.id !== suggestion.targetBlockId,
    ),
  );
  expect(finalDocument.suggestions).toEqual([unrelated]);
  expect(providerErrors).toEqual([]);
  expect(requests).toHaveLength(2);
  await page.locator(".workspace").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: info.outputPath("native-suggestion-applied.png"),
  });
  await nativeHome();
  await closeApplication();

  const database = new DatabaseSync(path.join(profile, "eve.db"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value,revision FROM canvases WHERE task_id=?")
      .get(seeded.id) as { value: string; revision: number };
    expect(row.revision).toBe(4);
    expect(JSON.parse(row.value)).toEqual(finalDocument);
    await writeFile(
      info.outputPath("suggestion-durable-evidence.json"),
      JSON.stringify(
        {
          taskId: seeded.id,
          selectedSuggestion: captured.canvasSuggestion,
          capturedRevision: captured.targets[0].revision,
          durableRevision: row.revision,
          document: JSON.parse(row.value),
          providerRequests: requests.length,
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
  await launch();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "A place to begin text", exact: true }),
  ).toHaveValue(ownWords);
  await expect(
    page.getByRole("button", { name: unrelated.label, exact: true }),
  ).toBeVisible();
  expect((await current()).canvas).toMatchObject({
    revision: 4,
    document: finalDocument,
  });
  expect(requests).toHaveLength(2);
});

test("linked chart and metric follow source edits without inference and retain exact bindings through native Home and restart", async ({}, info) => {
  const seed: CanvasDocument = {
    version: 1,
    title: "A budget in perspective",
    subtitle: "Editable example figures, with two views of the same table.",
    layout: "split",
    blocks: [
      {
        ...blockBase,
        id: "reading-chart",
        kind: "chart",
        title: "The shape of the budget",
        tableId: "reading-budget",
        chartType: "bar",
        labelColumn: 0,
        valueColumns: [1],
      },
      {
        ...blockBase,
        id: "reading-remaining",
        kind: "metric",
        title: "Remaining",
        placement: "aside",
        tableId: "reading-budget",
        rowId: "remaining",
        column: 1,
        prefix: "$",
        suffix: "",
        decimals: 0,
      },
      structuredClone(
        composition.blocks.find((block) => block.id === "reading-budget")!,
      ),
    ],
  };
  replyDocument = () => seed;
  await submitFromHome();
  await expect(
    page.getByRole("heading", { name: seed.title, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const initial = await current();
  expect(initial.canvas).toMatchObject({ revision: 1, document: seed });
  const metric = page
    .getByRole("group", { name: "Remaining value", exact: true })
    .locator(".canvas-metric-number");
  const chart = page.locator(".canvas-chart");
  const formula = page.locator('.canvas-table input[aria-label="B3: Amount"]');
  await expect(metric).toHaveText("$38");
  await expect(
    chart.getByRole("button", { name: "Remaining. Amount: 38", exact: true }),
  ).toBeVisible();
  await expect(formula).toHaveValue("38");

  // The source table stays the sole data owner. Derived views must update while
  // the actual core saves the edit, without remounting or blurring the input.
  const source = page.locator('.canvas-table input[aria-label="B2: Amount"]');
  await source.fill("20");
  await expect(metric).toHaveText("$30");
  await expect(formula).toHaveValue("30");
  const remainingRow = chart.getByRole("button", {
    name: "Remaining. Amount: 30",
    exact: true,
  });
  await expect(remainingRow.locator('rect[data-value="30"]')).toBeVisible();
  await expect.poll(async () => (await current()).canvas?.revision).toBe(2);
  await expect(source).toBeFocused();
  const edited = await current();
  expect(
    edited.canvas?.document?.blocks.find(
      (block) => block.id === "reading-budget",
    ),
  ).toMatchObject({
    rows: [
      { id: "budget", cells: ["Budget", "50"] },
      { id: "book", cells: ["Book", "20"] },
      { id: "remaining", cells: ["Remaining", "=B1-B2"] },
    ],
  });
  expect(requests).toHaveLength(1);

  // Leave immediately after a local view change. Native Home owns the save
  // flush; this is the real bridge and core, with no substituted persistence.
  await chart.getByRole("button", { name: "Line", exact: true }).click();
  await nativeHome();
  const saved = await page.evaluate(
    async (id) =>
      (await window.eve.snapshot()).tasks.find((task) => task.id === id)!,
    initial.id,
  );
  const expected: CanvasDocument = {
    ...edited.canvas!.document!,
    blocks: edited.canvas!.document!.blocks.map((block) =>
      block.kind === "chart" ? { ...block, chartType: "line" } : block,
    ),
  };
  expect(saved.canvas).toMatchObject({ revision: 3, document: expected });
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    chart.getByRole("button", { name: "Line", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(remainingRow.locator('circle[data-value="30"]')).toBeVisible();
  await expect(metric).toHaveText("$30");
  await page.locator(".workspace").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const nativeImage = info.outputPath("native-linked-data.png");
  await writeFile(
    nativeImage,
    Buffer.from(
      await app!.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      ),
      "base64",
    ),
  );
  await info.attach("native-linked-data.png", {
    path: nativeImage,
    contentType: "image/png",
  });
  await closeApplication();

  const database = new DatabaseSync(path.join(profile, "eve.db"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value,revision FROM canvases WHERE task_id=?")
      .get(initial.id) as { value: string; revision: number };
    expect(row.revision).toBe(3);
    expect(JSON.parse(row.value)).toEqual(expected);
    await writeFile(
      info.outputPath("linked-data-durable-evidence.json"),
      JSON.stringify(
        {
          taskId: initial.id,
          durableRevision: row.revision,
          document: JSON.parse(row.value),
          providerRequests: requests.length,
          qualification:
            "Controlled loopback provider; native rendering, local edits and real core persistence only.",
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
  await launch();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: seed.title, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Remaining value", exact: true })
      .locator(".canvas-metric-number"),
  ).toHaveText("$30");
  await expect(page.locator(".canvas-chart")).toHaveAttribute(
    "data-chart-type",
    "line",
  );
  await expect(
    page
      .locator(".canvas-chart")
      .getByRole("button", { name: "Remaining. Amount: 30", exact: true })
      .locator('circle[data-value="30"]'),
  ).toBeVisible();
  expect((await current()).canvas).toMatchObject({
    revision: 3,
    document: expected,
  });
  expect(providerErrors).toEqual([]);
  expect(requests).toHaveLength(1);
});

test("layered design edits and managed image originals survive native Home, SQLite and restart without extra inference", async ({}, info) => {
  const seed: CanvasDocument = {
    version: 1,
    title: "An evening in print",
    subtitle: "Synthetic editable composition for native acceptance.",
    layout: "split",
    blocks: [
      {
        ...blockBase,
        id: "print",
        kind: "design",
        title: "Evening edition",
        width: 840,
        height: 680,
        background: "#F4F0E7",
        layers: [
          {
            id: "band",
            name: "Evening band",
            kind: "shape",
            x: 0,
            y: 475,
            width: 840,
            height: 205,
            shape: "rectangle",
            fill: "#263B3C",
          },
          {
            id: "headline",
            name: "Headline",
            kind: "text",
            x: 50,
            y: 80,
            width: 730,
            height: 250,
            text: "An evening\nworth keeping.",
            fontFamily: "serif",
            fontSize: 90,
            fontWeight: "regular",
            color: "#263B3C",
            align: "left",
          },
          {
            id: "caption",
            name: "Caption",
            kind: "text",
            x: 50,
            y: 525,
            width: 720,
            height: 90,
            text: "A study in colour and space.",
            fontFamily: "sans",
            fontSize: 25,
            fontWeight: "regular",
            color: "#F4F0E7",
            align: "left",
          },
        ],
      },
      {
        ...blockBase,
        id: "note",
        kind: "text",
        placement: "aside",
        title: "My note",
        pinned: true,
        body: "Keep my own words and the image original.",
      },
    ],
  };
  replyDocument = () => seed;
  await submitFromHome();
  await expect(
    page.getByRole("heading", { name: seed.title, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const initial = await current();
  expect(initial.canvas).toMatchObject({ revision: 1, document: seed });
  let surface = page.locator('.canvas-layout-slot[data-block-id="print"]');
  const layers = surface.getByRole("button", { name: "Layers", exact: true });
  if (await layers.getAttribute("aria-expanded") !== "true") await layers.click();
  await surface
    .getByRole("button", { name: "Select Headline layer", exact: true })
    .click();
  const input = surface.getByRole("textbox", {
    name: "Headline text",
    exact: true,
  });
  const identity = await input.elementHandle();
  await input.focus();
  await input.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await page.keyboard.insertText(" Again.");
  await expect(input).toHaveValue("An evening\nworth keeping. Again.");
  await expect
    .poll(async () =>
      (await current()).canvas?.document?.blocks.find(
        (block) => block.id === "print",
      ),
    )
    .toMatchObject({
      layers: expect.arrayContaining([
        expect.objectContaining({
          id: "headline",
          text: "An evening\nworth keeping. Again.",
        }),
      ]),
    });
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((node, retained) => node === retained, identity),
  ).toBe(true);
  await surface
    .locator('[data-design-inspector="headline"]')
    .getByRole("button", { name: "Bring forward", exact: true })
    .click();
  await input.focus();
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveValue("An evening\nworth keeping.");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue("An evening\nworth keeping. Again.");
  await surface
    .getByRole("button", { name: "Select Headline layer", exact: true })
    .click();
  await surface
    .getByRole("button", { name: "Select Headline layer", exact: true })
    .press("Shift+ArrowRight");
  await expect
    .poll(async () =>
      (await current()).canvas?.document?.blocks.find(
        (block) => block.id === "print",
      ),
    )
    .toMatchObject({
      layers: expect.arrayContaining([
        expect.objectContaining({ id: "headline", x: 60 }),
      ]),
    });
  expect(requests).toHaveLength(1);

  // Only replace the native file picker. Actual host admission, copying, hashing,
  // core registration and eve-asset image delivery remain in use.
  const sourcePath = path.resolve(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const originalHash = createHash("sha256")
    .update(await readFile(sourcePath))
    .digest("hex");
  await app!.evaluate(({ dialog }, filePath) => {
    const original = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = ((
      ...args: Parameters<typeof dialog.showOpenDialog>
    ) => {
      const options = args.at(-1) as Electron.OpenDialogOptions;
      if (options.title === "Add material to this space")
        return Promise.resolve({ canceled: false, filePaths: [filePath] });
      return Reflect.apply(original, dialog, args);
    }) as typeof dialog.showOpenDialog;
  }, sourcePath);
  const imported = await page.evaluate(
    (id) => window.eve.importAssets(id),
    initial.id,
  );
  expect(imported.errors).toEqual([]);
  expect(imported.assets).toHaveLength(1);
  const asset = imported.assets[0]!;
  await nativeHome();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await surface.getByRole("button", { name: "Add image", exact: true }).click();
  await surface
    .getByRole("region", { name: "Choose a design image", exact: true })
    .getByRole("button", { name: `Use ${asset.title}`, exact: true })
    .click();
  const image = surface.locator("[data-design-stage] img");
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(
        (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(image).toHaveAttribute("src", /^eve-asset:/);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const beforeZoom = (await current()).canvas;
  await surface.getByRole("button", { name: "View at 100%", exact: true }).click();
  await expect(surface.locator("[data-design-zoom]")).toHaveText("100%");
  await surface.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(surface.locator("[data-design-zoom]")).toHaveText("125%");
  expect((await current()).canvas).toEqual(beforeZoom);
  await surface.getByRole("button", { name: "Fit artboard", exact: true }).click();
  // A native menu event does not blur the numeric editor. Its valid new value
  // must already be in the same draft queue that Home flushes.
  if (await layers.getAttribute("aria-expanded") !== "true") await layers.click();
  await surface
    .getByRole("button", { name: "Select Headline layer", exact: true })
    .click();
  const xPosition = surface
    .locator('[data-design-inspector="headline"]')
    .getByLabel("X position", { exact: true });
  await xPosition.fill("80");
  await expect(xPosition).toBeFocused();
  await nativeHome();
  const saved = await page.evaluate(
    async (id) =>
      (await window.eve.snapshot()).tasks.find((task) => task.id === id)!,
    initial.id,
  );
  const expected = saved.canvas!.document!;
  expect(expected.blocks.find((block) => block.id === "print")).toMatchObject({
    layers: expect.arrayContaining([
      expect.objectContaining({
        id: "headline",
        x: 80,
        text: "An evening\nworth keeping. Again.",
      }),
      expect.objectContaining({ kind: "image", assetId: asset.id }),
    ]),
  });
  expect(expected.blocks.find((block) => block.id === "note")).toEqual(
    seed.blocks[1],
  );
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await page.locator(".workspace").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await writeFile(
    info.outputPath("native-layered-design.png"),
    Buffer.from(
      await app!.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      ),
      "base64",
    ),
  );
  await closeApplication();
  const database = new DatabaseSync(path.join(profile, "eve.db"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value,revision FROM canvases WHERE task_id=?")
      .get(initial.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(expected);
    expect(row.revision).toBe(saved.canvas!.revision);
    const stored = database
      .prepare("SELECT data FROM assets WHERE id=?")
      .get(asset.id) as { data: string };
    const managed = JSON.parse(stored.data) as {
      managedPath: string;
      sha256: string;
    };
    expect(managed.sha256).toBe(originalHash);
    expect(
      createHash("sha256")
        .update(await readFile(managed.managedPath))
        .digest("hex"),
    ).toBe(originalHash);
    await writeFile(
      info.outputPath("design-durable-evidence.json"),
      JSON.stringify(
        {
          taskId: initial.id,
          durableRevision: row.revision,
          document: expected,
          originalHash,
          managedHash: managed.sha256,
          providerRequests: requests.length,
          qualification:
            "Controlled provider and replaced native picker; actual host assets, core SQLite, native editing and cold restart.",
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
  expect(
    createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex"),
  ).toBe(originalHash);
  await launch();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  surface = page.locator('.canvas-layout-slot[data-block-id="print"]');
  await expect(surface.locator("[data-design-stage] img")).toBeVisible();
  await expect
    .poll(() =>
      surface
        .locator("[data-design-stage] img")
        .evaluate(
          (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
        ),
    )
    .toBe(true);
  expect((await current()).canvas).toMatchObject({
    revision: saved.canvas!.revision,
    document: expected,
  });
  expect(providerErrors).toEqual([]);
  expect(requests).toHaveLength(1);
});

test("prepared wire patches preview and Keep without further inference, preserve drafts, support Undo and survive cold restart", async ({}, info) => {
  const before = structuredClone(composition.blocks.find(block => block.kind === "checklist")!);
  if (before.kind !== "checklist") throw new Error("Missing checklist fixture");
  const after = { ...before, items: [...before.items, { id: "one-question", label: "Write down one question afterward", checked: false }] };
  const seed: CanvasDocument = { ...composition, suggestions: [{
    id: "reading-reflection", label: "Leave room for a question", description: "Add a final reflection step to your checklist.",
    request: "Add a final step to write down one question afterward.", targetBlockId: before.id,
    prepared: { edits: [{ type: "replace", block: after }], before: [before] },
  }] };
  // The provider transmits one registered insertion, not copied user content or
  // an authoritative before snapshot. The actual model worker expands it.
  replyDocument = () => ({ ...seed, suggestions: [{ ...seed.suggestions![0], prepared: { edits: [{
    type: "patch", id: before.id, changes: [{ type: "insert", collection: "items", afterId: before.items.at(-1)!.id, item: after.items.at(-1) }],
  }] } }] });
  await submitFromHome();
  let writer = page.getByRole("textbox", { name: "A place to begin text", exact: true });
  await expect(writer).toHaveValue("Choose a chapter and leave yourself a little time to think.");
  const first = await current();
  expect(first.canvas!.document).toEqual(seed);
  expect(requests).toHaveLength(1);
  const card = () => page.getByRole("button", { name: "Leave room for a question", exact: true });
  const review = () => page.getByRole("region", { name: "Suggestion preview", exact: true });
  const observed = await page.evaluateHandle(() => {
    const values: IntentResponse[] = [];
    window.eve.onIntelligence(event => { if (event.type === "intent") values.push(event.response); });
    return values;
  });
  await card().click();
  await expect(review()).toBeVisible();
  await expect(review()).toContainText("Write down one question afterward");
  expect((await current()).canvas).toEqual(first.canvas);
  expect(requests).toHaveLength(1);
  await review().getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(review()).toHaveCount(0);
  await expect(card()).toBeFocused();
  expect((await current()).canvas).toEqual(first.canvas);

  await card().click();
  await expect(review()).toBeVisible();
  const myText = "My own thought, saved while the suggestion stays open.";
  await writer.fill(myText);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  // Any change after preview invalidates the exact reviewed revision.
  await expect.poll(() => observed.evaluate(values => values.at(-1)?.proposals[0]?.status)).toBe("stale").catch(async error => {
    await writeFile(info.outputPath("prepared-events-failure.json"), JSON.stringify(await observed.evaluate(values => values), null, 2));
    throw error;
  });
  await expect(review().getByRole("button", { name: "Keep", exact: true })).toBeDisabled();
  await review().getByRole("button", { name: "Dismiss", exact: true }).click();
  await card().click();
  await expect(review()).toBeVisible();
  const previewRevision = (await current()).canvas!.revision;
  await review().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("prepared-suggestion-native-preview.png") });
  const keep = review().getByRole("button", { name: "Keep", exact: true });
  await keep.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.getByRole("checkbox", { name: "Write down one question afterward", exact: true })).toBeVisible();
  await expect(writer).toHaveValue(myText);
  await expect.poll(async () => (await current()).canvas!.revision).toBe(previewRevision + 1);
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Write down one question afterward", exact: true })).toHaveCount(0);
  await expect(writer).toHaveValue(myText);
  await card().click();
  await expect(review()).toBeVisible();
  await review().getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Write down one question afterward", exact: true })).toBeVisible();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const kept = await current();
  await nativeHome();
  await closeApplication();
  const db = new DatabaseSync(path.join(profile, "eve.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value,revision FROM canvases WHERE task_id = ?").get(kept.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document); expect(row.revision).toBe(kept.canvas!.revision);
    await writeFile(info.outputPath("prepared-suggestion-durable-evidence.json"), JSON.stringify({ modelRequests: requests.length, previewRevision,
      keptRevision: kept.canvas!.revision, originalText: composition.blocks[0], savedText: myText, document: JSON.parse(row.value) }, null, 2));
  } finally { db.close(); }
  await launch();
  await page.getByTestId("home").getByRole("button", { name: `Open ${requestText}`, exact: true }).click();
  writer = page.getByRole("textbox", { name: "A place to begin text", exact: true });
  await expect(writer).toHaveValue(myText);
  await expect(page.getByRole("checkbox", { name: "Write down one question afterward", exact: true })).toBeVisible();
  expect((await current()).canvas!.document).toEqual(kept.canvas!.document);
  expect(requests).toHaveLength(1);
  expect(providerErrors).toEqual([]);
});

test("photo previews preserve original bytes and persist reviewed adjustments through native Undo and restart", async ({}, info) => {
  await submitFromHome();
  await expect(page.getByRole("textbox", {name:"A place to begin text",exact:true})).toBeVisible();
  const owner = await current();
  const sourcePath = path.resolve("apps/desktop/renderer/public/assets/photo-walk.png");
  const originalHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  await app!.evaluate(({dialog}, filePath) => {
    const original = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = ((...args: Parameters<typeof dialog.showOpenDialog>) => {
      const options=args.at(-1) as Electron.OpenDialogOptions;
      return options.title === "Add material to this space" ? Promise.resolve({canceled:false,filePaths:[filePath]}) : Reflect.apply(original,dialog,args);
    }) as typeof dialog.showOpenDialog;
  }, sourcePath);
  const imported = await page.evaluate(id=>window.eve.importAssets(id),owner.id);
  expect(imported.errors).toEqual([]); expect(imported.assets).toHaveLength(1);
  const asset=imported.assets[0]!;
  await nativeHome();
  await page.getByTestId("home").getByRole("button",{name:`Open ${requestText}`,exact:true}).click();
  const shelf=page.getByRole("region",{name:"Add to your space",exact:true});
  await shelf.getByRole("button",{name:"All tools",exact:true}).click();
  await shelf.getByRole("button",{name:"Add image",exact:true}).click();
  await page.getByRole("region",{name:"Choose an image",exact:true}).getByRole("button",{name:asset.title,exact:true}).click();
  let photo=page.locator("[data-canvas-image]");
  await expect(photo.locator('[data-adjusted-image][data-status="ready"]').first()).toBeVisible();
  const caption=photo.getByRole("textbox",{name:`${asset.title} caption`,exact:true});
  await caption.fill("My own caption stays with the original.");
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const before=(await current()).canvas!;
  const originalBlock=before.document!.blocks.find(block=>block.kind==='image')!;
  await photo.getByRole("button",{name:"Adjust photo",exact:true}).click();
  const brightness=photo.getByRole("slider",{name:"Brightness",exact:true});
  await brightness.focus(); await brightness.press("ArrowRight");
  await expect(brightness).toHaveValue("1.01");
  expect((await current()).canvas).toEqual(before);
  await photo.getByRole("button",{name:"Dismiss photo adjustments",exact:true}).click();
  expect((await current()).canvas).toEqual(before);
  await photo.getByRole("button",{name:"Adjust photo",exact:true}).click();
  await brightness.focus(); await brightness.press("ArrowRight");
  await photo.getByRole("button",{name:"Keep photo adjustments",exact:true}).click();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await expect.poll(async()=>(await current()).canvas!.document!.blocks.find(block=>block.id===originalBlock.id)).toEqual({...originalBlock,adjustments:{...normalizedImageAdjustments(),brightness:1.01}});
  expect((await current()).canvas!.revision).toBe(before.revision+1);
  await page.locator(".canvas-footer").getByRole("button",{name:"Undo",exact:true}).click();
  await expect.poll(async()=>(await current()).canvas!.document!.blocks.find(block=>block.id===originalBlock.id)).toEqual(originalBlock);
  expect(requests).toHaveLength(1);

  const settings={...normalizedImageAdjustments(),brightness:1.18,contrast:1.03,saturation:0.95,straighten:1.4,crop:{left:0.06,top:0.04,right:0.94,bottom:0.96}};
  replyDocument=(_data,target)=>({...target.canvas!,blocks:target.canvas!.blocks.map(block=>({kind:'keep',id:block.id})),suggestions:[{
    id:'photo-trial',label:'Try a lighter photo',description:'Review brightness and crop settings; keep the original.',request:'Review the prepared photo settings.',targetBlockId:originalBlock.id,
    prepared:{edits:[{type:'patch',id:originalBlock.id,changes:[{type:'adjust-image',adjustments:settings}]}]},
  }]});
  await page.getByRole("textbox",{name:"Ask Eve",exact:true}).fill("Offer a reversible photo variation to review while preserving my current work.");
  await page.getByRole("button",{name:"Send request to Eve",exact:true}).click();
  const suggestion=page.getByRole("button",{name:"Try a lighter photo",exact:true});
  await expect(suggestion).toBeVisible(); expect(requests).toHaveLength(2);
  const prepared=(await current()).canvas!;
  expect(prepared.document!.blocks).toEqual(before.document!.blocks);
  await suggestion.click();
  const review=page.getByRole("region",{name:"Suggestion preview",exact:true});
  await expect(review).toBeVisible();
  await expect(review.locator('[data-adjusted-image][data-status="ready"]').first()).toBeVisible();
  expect((await current()).canvas).toEqual(prepared);
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("native-photo-suggestion-preview.png")});
  await review.getByRole("button",{name:"Keep",exact:true}).click();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await expect.poll(async()=>(await current()).canvas!.document!.blocks.find(block=>block.id===originalBlock.id)).toEqual({...originalBlock,adjustments:settings});
  expect(requests).toHaveLength(2);
  const kept=await current();
  await nativeHome(); await closeApplication();
  const database=new DatabaseSync(path.join(profile,"eve.db"),{readOnly:true});
  try {
    const row=database.prepare("SELECT value,revision FROM canvases WHERE task_id=?").get(owner.id) as {value:string;revision:number};
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document);
    const stored=database.prepare("SELECT data FROM assets WHERE id=?").get(asset.id) as {data:string};
    const managed=JSON.parse(stored.data) as {managedPath:string;sha256:string};
    expect(managed.sha256).toBe(originalHash);
    expect(createHash("sha256").update(await readFile(managed.managedPath)).digest("hex")).toBe(originalHash);
    expect(createHash("sha256").update(await readFile(sourcePath)).digest("hex")).toBe(originalHash);
    await writeFile(info.outputPath("photo-adjustments-durable-evidence.json"),JSON.stringify({document:JSON.parse(row.value),revision:row.revision,originalHash,managedHash:managed.sha256,providerRequests:requests.length},null,2));
  } finally { database.close(); }
  await launch();
  await page.getByTestId("home").getByRole("button",{name:`Open ${requestText}`,exact:true}).click();
  photo=page.locator("[data-canvas-image]");
  await expect(photo.locator('[data-adjusted-image][data-status="ready"]').first()).toBeVisible();
  expect((await current()).canvas!.document).toEqual(kept.canvas!.document);
  await expect(photo.getByRole("textbox",{name:`${asset.title} caption`,exact:true})).toHaveValue("My own caption stays with the original.");
  expect(requests).toHaveLength(2); expect(providerErrors).toEqual([]);
});

test("prepared removal and arrangement show a review, retain surviving editors and persist through Undo and restart", async ({}, info) => {
  const blocks = composition.blocks.map(block => block.id === 'reading-checklist' ? { ...block, pinned: true } : block);
  const budget = blocks.find(block => block.id === 'reading-budget')!;
  const choice = { id: 'arrange-reading', label: 'Compare notes and checklist', description: 'Remove the budget card and put the checklist first in a gallery.', request: 'Remove the budget card and show the checklist before the notes in a gallery.', targetBlockId: null };
  const arrangement = { layout: 'gallery' as const, order: ['reading-checklist', 'reading-note'] };
  const seed: CanvasDocument = { ...composition, blocks, suggestions: [{ ...choice, prepared: {
    edits: [{ type: 'remove', id: budget.id }], before: [budget], arrangement,
    beforeArrangement: { layout: composition.layout, blocks: blocks.map(({ id, placement }) => ({ id, placement })) },
  } }] };
  // The actual model worker must capture both kinds of before snapshot locally.
  replyDocument = () => ({ ...composition, blocks, suggestions: [{ ...choice, prepared: { edits: [{ type: 'remove', id: budget.id }], arrangement } }] });
  await submitFromHome();
  let writer = page.getByRole('textbox', { name: 'A place to begin text', exact: true });
  await expect(writer).toBeVisible();
  expect((await current()).canvas!.document).toEqual(seed);
  const retainedWriter = await writer.elementHandle();
  if (!retainedWriter) throw new Error('The live writer is unavailable.');
  await writer.focus();
  await writer.evaluate(element => { const input = element as HTMLTextAreaElement; input.setSelectionRange(input.value.length, input.value.length); });
  // One native insertion gives the history check a stable undo unit; character
  // typing can create several platform-dependent groups around punctuation.
  await page.keyboard.insertText(' My own question.');
  const authored = await writer.inputValue();
  await expect(page.locator('.canvas-status')).toContainText('Saved');
  const before = await current();
  const card = () => page.getByRole('button', { name: choice.label, exact: true });
  const review = () => page.getByRole('region', { name: 'Suggestion preview', exact: true });
  await card().click(); await expect(review()).toBeVisible();
  await expect(review()).toContainText('Removed');
  await expect(review()).toContainText('Gallery');
  expect((await current()).canvas).toEqual(before.canvas); expect(requests).toHaveLength(1);
  await review().getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(card()).toBeFocused();
  expect((await current()).canvas).toEqual(before.canvas);
  await card().click(); await expect(review()).toBeVisible();
  await review().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('arrangement-native-preview.png') });
  await review().getByRole('button', { name: 'Keep', exact: true }).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.locator('.canvas-layout[data-layout="gallery"]')).toBeVisible();
  await expect(page.locator('.canvas-layout-slot[data-block-id="reading-budget"]')).toHaveCount(0);
  await expect.poll(async () => (await current()).canvas!.revision).toBe(before.canvas!.revision + 1);
  expect(await writer.evaluate((element, saved) => element === saved, retainedWriter)).toBe(true);
  await expect(writer).toHaveValue(authored);
  const geometry = await page.locator('.canvas-layout-slot').evaluateAll(elements => elements.map(element => ({ id: (element as HTMLElement).dataset.blockId, x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: element.getBoundingClientRect().width })));
  const checklistPosition = geometry.find(item => item.id === 'reading-checklist')!;
  const writingPosition = geometry.find(item => item.id === 'reading-note')!;
  expect(checklistPosition.x).toBeLessThan(writingPosition.x);
  expect(Math.abs(checklistPosition.y - writingPosition.y)).toBeLessThan(3);
  expect((await current()).canvas!.document!.blocks.map(block => block.id)).toEqual(arrangement.order);
  expect((await current()).canvas!.document!.blocks[0]).toEqual(blocks[1]);
  // A fresh review after core Undo must restore the removed block and its choice.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.canvas-layout-slot[data-block-id="reading-budget"]')).toBeVisible();
  await expect(writer).toHaveValue(authored);
  await card().click(); await expect(review()).toBeVisible();
  await review().getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(page.locator('.canvas-layout-slot[data-block-id="reading-budget"]')).toHaveCount(0);
  // Reordering keeps the surviving native buffer and its typing history.
  expect(await writer.evaluate((element, saved) => element === saved, retainedWriter)).toBe(true);
  await writer.focus(); await writer.press('ControlOrMeta+z');
  await expect(writer).toHaveValue('Choose a chapter and leave yourself a little time to think.');
  await writer.press('ControlOrMeta+Shift+z'); await expect(writer).toHaveValue(authored);
  await expect(page.locator('.canvas-status')).toContainText('Saved');
  const kept = await current(); expect(requests).toHaveLength(1);
  await nativeHome(); await closeApplication();
  const database = new DatabaseSync(path.join(profile, 'eve.db'), { readOnly: true });
  try {
    const row = database.prepare('SELECT value,revision FROM canvases WHERE task_id=?').get(kept.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document); expect(row.revision).toBe(kept.canvas!.revision);
    await writeFile(info.outputPath('arrangement-durable-evidence.json'), JSON.stringify({ document: JSON.parse(row.value), revision: row.revision, providerRequests: requests.length, geometry, authored }, null, 2));
  } finally { database.close(); }
  await launch();
  await page.getByTestId('home').getByRole('button', { name: `Open ${requestText}`, exact: true }).click();
  writer = page.getByRole('textbox', { name: 'A place to begin text', exact: true });
  await expect(writer).toHaveValue(authored);
  await expect(page.locator('.canvas-layout[data-layout="gallery"]')).toBeVisible();
  expect((await current()).canvas!.document).toEqual(kept.canvas!.document);
  expect(requests).toHaveLength(1); expect(providerErrors).toEqual([]);
});

test("a prepared empty image slot attaches admitted pixels in place, retains native editors and survives Undo and restart", async ({}, info) => {
  const slot = {
    ...blockBase,
    id: "reading-photo-slot",
    kind: "image" as const,
    title: "A photograph to add",
    assetId: null,
    caption: "",
    adjustments: null,
  };
  const choice = {
    id: "leave-room-for-photo",
    label: "Leave room for my photograph",
    description:
      "Add an empty image slot. Choose your photograph after keeping it.",
    request:
      "Add an empty image slot without selecting or importing a photograph.",
    targetBlockId: null,
    prepared: { edits: [{ type: "add", block: slot }], arrangement: null },
  };
  replyDocument = () => ({ ...composition, suggestions: [choice] });

  // Substitute only the native picker result. The actual host still validates,
  // copies and hashes the fixture image, and the real core owns every write.
  const sourcePath = path.resolve(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const originalHash = createHash("sha256")
    .update(await readFile(sourcePath))
    .digest("hex");
  await app!.evaluate(({ dialog }, filePath) => {
    const scope = globalThis as typeof globalThis & {
      canvasImagePicker: {
        mode: "cancel" | "import";
        options: Electron.OpenDialogOptions[];
      };
    };
    scope.canvasImagePicker = { mode: "cancel", options: [] };
    const original = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = ((
      ...args: Parameters<typeof dialog.showOpenDialog>
    ) => {
      const options = args.at(-1) as Electron.OpenDialogOptions;
      if (options.title !== "Choose an image for this canvas")
        return Reflect.apply(original, dialog, args);
      scope.canvasImagePicker.options.push(options);
      const canceled = scope.canvasImagePicker.mode === "cancel";
      return Promise.resolve({
        canceled,
        filePaths: canceled ? [] : [filePath],
      });
    }) as typeof dialog.showOpenDialog;
  }, sourcePath);
  const pickerCount = () =>
    app!.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            canvasImagePicker: { options: Electron.OpenDialogOptions[] };
          }
        ).canvasImagePicker.options.length,
    );

  await submitFromHome();
  const writer = page.getByRole("textbox", {
    name: "A place to begin text",
    exact: true,
  });
  await expect(writer).toBeVisible();
  const writerIdentity = await writer.elementHandle();
  if (!writerIdentity)
    throw new Error("The original writing editor is unavailable.");
  await writer.focus();
  await writer.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.insertText(" My own observation stays here.");
  const authoredWriting = await writer.inputValue();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const beforePreview = await current();
  const card = page.getByRole("button", { name: choice.label, exact: true });
  await card.click();
  const review = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText(slot.title);
  await expect(
    review.getByRole("button", { name: "Import image", exact: true }),
  ).toHaveCount(0);
  expect(await pickerCount()).toBe(0);
  expect(
    await page.evaluate((id) => window.eve.assets(id), beforePreview.id),
  ).toEqual([]);
  expect((await current()).canvas).toEqual(beforePreview.canvas);
  expect(requests).toHaveLength(1);

  await writer.focus();
  await writer.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(4, 12, "backward"),
  );
  await review
    .getByRole("button", { name: "Keep", exact: true })
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  const photo = page.locator(`[data-canvas-image="${slot.id}"]`);
  await expect(photo.locator("[data-empty-image]")).toBeVisible();
  await expect(photo).toContainText("No image attached");
  await expect(
    photo.getByRole("button", { name: "Adjust photo", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(async () => (await current()).canvas!.revision)
    .toBe(beforePreview.canvas!.revision + 1);
  expect((await current()).canvas!.document!.blocks).toEqual([
    ...beforePreview.canvas!.document!.blocks,
    slot,
  ]);
  expect(await pickerCount()).toBe(0);
  expect(requests).toHaveLength(1);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  expect(
    await writer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return [
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection,
      ];
    }),
  ).toEqual([4, 12, "backward"]);

  const caption = photo.getByRole("textbox", {
    name: `${slot.title} caption`,
    exact: true,
  });
  const captionIdentity = await caption.elementHandle();
  if (!captionIdentity)
    throw new Error("The empty slot's caption editor is unavailable.");
  await caption.focus();
  await page.keyboard.insertText(
    "My caption belongs to this place, before a photograph is attached.",
  );
  const authoredCaption = await caption.inputValue();
  await page
    .getByRole("button", { name: `Pin ${slot.title}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `Unpin ${slot.title}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const beforeImport = await current();
  const emptyPinned = beforeImport.canvas!.document!.blocks.find(
    (block) => block.id === slot.id,
  )!;
  expect(emptyPinned).toEqual({
    ...slot,
    caption: authoredCaption,
    pinned: true,
  });

  // Cancelling the real host attachment route must not register material or edit
  // the slot. Pinning only constrains model changes, not this direct user action.
  await photo
    .getByRole("button", { name: "Import image", exact: true })
    .click();
  await expect.poll(pickerCount).toBe(1);
  await expect(
    photo.getByRole("button", { name: "Import image", exact: true }),
  ).toBeEnabled();
  expect((await current()).canvas).toEqual(beforeImport.canvas);
  expect(
    await page.evaluate((id) => window.eve.assets(id), beforeImport.id),
  ).toEqual([]);
  await app!.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        canvasImagePicker: { mode: "cancel" | "import" };
      }
    ).canvasImagePicker.mode = "import";
  });
  await caption.focus();
  await caption.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(3, 14, "backward"),
  );
  await photo
    .getByRole("button", { name: "Import image", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect.poll(pickerCount).toBe(2);
  await expect(
    photo.locator('[data-adjusted-image][data-status="ready"]').first(),
  ).toBeVisible();
  await expect
    .poll(async () => (await current()).canvas!.revision)
    .toBe(beforeImport.canvas!.revision + 1);
  const attached = await current();
  const material = await page.evaluate(
    (id) => window.eve.assets(id),
    attached.id,
  );
  expect(material).toHaveLength(1);
  const asset = material[0]!;
  expect(asset.mediaType).toBe("image/png");
  const attachedBlock = { ...emptyPinned, assetId: asset.id };
  expect(attached.canvas!.document!.blocks).toEqual(
    beforeImport.canvas!.document!.blocks.map((block) =>
      block.id === slot.id ? attachedBlock : block,
    ),
  );
  await expect(photo.locator("img").first()).toHaveAttribute(
    "src",
    /^eve-asset:/,
  );
  await expect(caption).toBeFocused();
  expect(
    await caption.evaluate(
      (element, retained) => element === retained,
      captionIdentity,
    ),
  ).toBe(true);
  expect(
    await caption.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return [
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection,
      ];
    }),
  ).toEqual([3, 14, "backward"]);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  await expect(writer).toHaveValue(authoredWriting);
  expect(requests).toHaveLength(1);

  await page
    .locator(".canvas-footer")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(photo.locator("[data-empty-image]")).toBeVisible();
  await expect
    .poll(async () => (await current()).canvas!.document)
    .toEqual(beforeImport.canvas!.document);
  expect(
    await page.evaluate((id) => window.eve.assets(id), attached.id),
  ).toEqual(material);
  expect(
    await caption.evaluate(
      (element, retained) => element === retained,
      captionIdentity,
    ),
  ).toBe(true);
  const beforeExisting = await current();
  await photo
    .getByRole("button", { name: "Choose existing image", exact: true })
    .click();
  await photo
    .getByRole("button", { name: `Attach ${asset.title}`, exact: true })
    .click();
  await expect(
    photo.locator('[data-adjusted-image][data-status="ready"]').first(),
  ).toBeVisible();
  await expect
    .poll(async () => (await current()).canvas!.revision)
    .toBe(beforeExisting.canvas!.revision + 1);
  expect((await current()).canvas!.document).toEqual(attached.canvas!.document);
  expect(await pickerCount()).toBe(2);
  expect(
    await page.evaluate((id) => window.eve.assets(id), attached.id),
  ).toEqual(material);

  // The original native input buffers remain usable across both attachment
  // paths and the core Undo that temporarily restores an empty image slot.
  await caption.focus();
  await caption.press("ControlOrMeta+z");
  await expect(caption).toHaveValue("");
  // Chromium keeps native edit history across the focused text controls:
  // undo newest caption input, then the earlier writing, before redoing both.
  await writer.focus();
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue(
    composition.blocks[0]!.kind === "text" ? composition.blocks[0]!.body : "",
  );
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue(authoredWriting);
  await caption.focus();
  await caption.press("ControlOrMeta+Shift+z");
  await expect(caption).toHaveValue(authoredCaption);
  expect(
    await caption.evaluate(
      (element, retained) => element === retained,
      captionIdentity,
    ),
  ).toBe(true);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const kept = await current();
  const pickerOptions = await app!.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          canvasImagePicker: { options: Electron.OpenDialogOptions[] };
        }
      ).canvasImagePicker.options,
  );
  for (const options of pickerOptions) {
    expect(options.properties).toContain("openFile");
    expect(options.properties).not.toContain("multiSelections");
    expect(
      options.filters?.flatMap((filter) => filter.extensions).sort(),
    ).toEqual(["jpeg", "jpg", "png", "webp"]);
  }
  await photo.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("empty-image-slot-native-attached.png"),
  });
  await nativeHome();
  await closeApplication();
  const database = new DatabaseSync(path.join(profile, "eve.db"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value,revision FROM canvases WHERE task_id=?")
      .get(kept.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document);
    expect(row.revision).toBe(kept.canvas!.revision);
    const stored = database
      .prepare("SELECT data FROM assets WHERE id=?")
      .get(asset.id) as { data: string };
    const managed = JSON.parse(stored.data) as {
      managedPath: string;
      originalPath: string;
      sha256: string;
    };
    expect(managed.managedPath).not.toBe(sourcePath);
    expect(managed.originalPath).toBe(sourcePath);
    expect(managed.sha256).toBe(originalHash);
    expect(
      createHash("sha256")
        .update(await readFile(managed.managedPath))
        .digest("hex"),
    ).toBe(originalHash);
    expect(
      createHash("sha256")
        .update(await readFile(sourcePath))
        .digest("hex"),
    ).toBe(originalHash);
    await writeFile(
      info.outputPath("empty-image-slot-durable-evidence.json"),
      JSON.stringify(
        {
          document: JSON.parse(row.value),
          revision: row.revision,
          slotId: slot.id,
          assetId: asset.id,
          emptyRevision: beforeImport.canvas!.revision,
          attachmentRevision: attached.canvas!.revision,
          originalHash,
          managedHash: managed.sha256,
          providerRequests: requests.length,
          pickerCalls: pickerOptions.length,
          qualification:
            "Synthetic fixture with controlled provider and substituted native dialog result; actual host asset copy, native editors, core SQLite, Undo and cold restart.",
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
  await launch();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    page
      .locator(
        `[data-canvas-image="${slot.id}"] [data-adjusted-image][data-status="ready"]`,
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: `${slot.title} caption`, exact: true }),
  ).toHaveValue(authoredCaption);
  await expect(
    page.getByRole("textbox", { name: "A place to begin text", exact: true }),
  ).toHaveValue(authoredWriting);
  expect((await current()).canvas).toMatchObject({
    revision: kept.canvas!.revision,
    document: kept.canvas!.document,
  });
  expect(await page.evaluate((id) => window.eve.assets(id), kept.id)).toEqual(
    material,
  );
  expect(requests).toHaveLength(1);
  expect(providerErrors).toEqual([]);
});

test("a meaningful prepared edit survives redundant preservation transport and keeps a compact native review through Undo and restart", async ({}, info) => {
  const writerBlock = composition.blocks[0]!;
  if (writerBlock.kind !== "text") throw new Error("Missing writing fixture.");
  const original = {
    ...blockBase,
    id: "workshop-time",
    kind: "text" as const,
    title: "Workshop details",
    placement: "aside" as const,
    body: "Meet at 11 AM in the courtyard.",
  };
  const replacement = { ...original, body: "Meet at 10 AM in the courtyard." };
  const seed: CanvasDocument = {
    version: 1,
    title: "An afternoon together",
    subtitle: "My writing and one detail to review.",
    layout: "split",
    blocks: [writerBlock, original],
    suggestions: [],
  };
  const choice = {
    id: "workshop-start",
    label: "Start the workshop at 10",
    description: "Change only the workshop start time from 11 AM to 10 AM.",
    request: "Change the workshop start time to 10 AM and preserve my writing.",
    targetBlockId: original.id,
  };
  // The real worker must discard a valid but redundant preservation patch.
  // Otherwise later typing in this unrelated writer could stale the choice or
  // turn a one-field review into a misleading multi-item plan.
  const wireEdits = [
    {
      type: "patch",
      id: original.id,
      changes: [
        { type: "set", target: null, field: "body", value: replacement.body },
      ],
    },
    {
      type: "patch",
      id: writerBlock.id,
      changes: [
        { type: "set", target: null, field: "body", value: writerBlock.body },
      ],
    },
  ];
  replyDocument = () => ({
    ...seed,
    suggestions: [
      { ...choice, prepared: { edits: wireEdits, arrangement: null } },
    ],
  });
  await submitFromHome();
  const writer = page.getByRole("textbox", {
    name: `${writerBlock.title} text`,
    exact: true,
  });
  const detail = page.getByRole("textbox", {
    name: `${original.title} text`,
    exact: true,
  });
  await expect(writer).toHaveValue(writerBlock.body);
  await expect(detail).toHaveValue(original.body);
  const initial = await current();
  const normalized = initial.canvas!.document!.suggestions!.find(
    (suggestion) => suggestion.id === choice.id,
  )!;
  expect(normalized.prepared).toMatchObject({
    edits: [{ type: "replace", block: replacement }],
    before: [original],
  });
  expect(normalized.prepared!.edits).toHaveLength(1);
  expect(initial.canvas!.document!.blocks).toEqual(seed.blocks);
  expect(requests).toHaveLength(1);

  const writerIdentity = await writer.elementHandle();
  if (!writerIdentity)
    throw new Error("The live writing editor is unavailable.");
  await writer.focus();
  await writer.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.insertText(
    " I want to keep this thought in my own words.",
  );
  const authored = await writer.inputValue();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const beforePreview = await current();
  await writer.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(4, 12, "backward"),
  );
  const card = page.getByRole("button", { name: choice.label, exact: true });
  await card.evaluate((element) => (element as HTMLButtonElement).click());
  const review = page.getByRole("region", {
    name: "Suggestion preview",
    exact: true,
  });
  await expect(review).toHaveAttribute("data-review-mode", "compact");
  await expect(review.locator(".suggestion-compact-values del")).toHaveText(
    original.body,
  );
  await expect(review.locator(".suggestion-compact-values ins")).toHaveText(
    replacement.body,
  );
  await expect(review.locator(".suggestion-preview-changes")).toBeHidden();
  await expect(writer).toBeFocused();
  expect((await current()).canvas).toEqual(beforePreview.canvas);
  expect(requests).toHaveLength(1);

  const inspect = review.getByRole("button", {
    name: "Inspect full item",
    exact: true,
  });
  await inspect.click();
  const closeInspection = review.getByRole("button", {
    name: "Close full inspection",
    exact: true,
  });
  await expect(closeInspection).toBeFocused();
  await expect(review.locator(".suggestion-preview-changes")).toBeVisible();
  await expect(
    review.locator(".suggestion-preview-changes .is-after"),
  ).toContainText(replacement.body);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  await closeInspection.click();
  await expect(inspect).toBeFocused();
  await expect(review.locator(".suggestion-preview-changes")).toBeHidden();
  expect((await current()).canvas).toEqual(beforePreview.canvas);
  await writer.focus();
  expect(
    await writer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return [
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection,
      ];
    }),
  ).toEqual([4, 12, "backward"]);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("compact-review-native-context.png"),
  });

  await review
    .getByRole("button", { name: "Keep", exact: true })
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  await expect(detail).toHaveValue(replacement.body);
  await expect
    .poll(async () => (await current()).canvas!.revision)
    .toBe(beforePreview.canvas!.revision + 1);
  const firstKeep = await current();
  expect(firstKeep.canvas!.document!.blocks).toEqual([
    { ...writerBlock, body: authored },
    replacement,
  ]);
  expect(firstKeep.canvas!.document!.suggestions).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  expect(
    await writer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return [
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection,
      ];
    }),
  ).toEqual([4, 12, "backward"]);

  await page
    .locator(".canvas-footer")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(detail).toHaveValue(original.body);
  await expect
    .poll(async () => (await current()).canvas!.document)
    .toEqual(beforePreview.canvas!.document);
  await expect(writer).toHaveValue(authored);
  await writer.focus();
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue(writerBlock.body);
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue(authored);
  expect(
    await writer.evaluate(
      (element, retained) => element === retained,
      writerIdentity,
    ),
  ).toBe(true);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await card.click();
  await expect(review).toHaveAttribute("data-review-mode", "compact");
  await expect(review.locator(".suggestion-compact-values del")).toHaveText(
    original.body,
  );
  await expect(review.locator(".suggestion-compact-values ins")).toHaveText(
    replacement.body,
  );
  await review.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(detail).toHaveValue(replacement.body);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const kept = await current();
  expect(kept.canvas!.document).toEqual(firstKeep.canvas!.document);
  expect(requests).toHaveLength(1);
  await nativeHome();
  await closeApplication();
  const database = new DatabaseSync(path.join(profile, "eve.db"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value,revision FROM canvases WHERE task_id=?")
      .get(kept.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document);
    expect(row.revision).toBe(kept.canvas!.revision);
    await writeFile(
      info.outputPath("compact-review-durable-evidence.json"),
      JSON.stringify(
        {
          document: JSON.parse(row.value),
          revision: row.revision,
          providerWireEdits: wireEdits,
          normalizedPrepared: normalized.prepared,
          previewRevision: beforePreview.canvas!.revision,
          firstKeepRevision: firstKeep.canvas!.revision,
          providerRequests: requests.length,
          authoredWriting: authored,
          qualification:
            "Controlled provider through actual model worker, host review, native editors, core SQLite, Undo and cold restart; not live model quality.",
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
  await launch();
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${requestText}`, exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: `${original.title} text`, exact: true }),
  ).toHaveValue(replacement.body);
  await expect(
    page.getByRole("textbox", {
      name: `${writerBlock.title} text`,
      exact: true,
    }),
  ).toHaveValue(authored);
  expect((await current()).canvas).toMatchObject({
    revision: kept.canvas!.revision,
    document: kept.canvas!.document,
  });
  expect(requests).toHaveLength(1);
  expect(providerErrors).toEqual([]);
});

test("contextual passage choices preserve other saved plans and native editors through preview, Keep, Undo and restart", async ({}, info) => {
  const phrase = "The blue jar.";
  const original = {
    ...blockBase,
    id: "glaze-observation",
    kind: "text" as const,
    title: "Glaze observations",
    body: `${phrase} First note.\n${phrase} Last note.`,
  };
  const writerBlock = composition.blocks[0]!;
  if (writerBlock.kind !== "text") throw new Error("Missing writing fixture.");
  const writerOriginal = { ...writerBlock, placement: "aside" as const };
  const selected = {
    field: "body" as const,
    start: original.body.lastIndexOf(phrase),
    end: original.body.lastIndexOf(phrase) + phrase.length,
    text: phrase,
  };
  const replacement = {
    ...original,
    body: `${phrase} First note.\nThe cobalt jar. Last note.`,
  };
  const foreignChoice = {
    id: "keep-a-question",
    label: "Shorten the opening thought",
    description: "Review a shorter beginning in the other writing item.",
    request: "Shorten the opening thought in my reading notes.",
    targetBlockId: writerOriginal.id,
    prepared: {
      edits: [{ type: "replace" as const, block: { ...writerOriginal, body: "Choose a chapter and take your time." } }],
      before: [writerOriginal],
    },
  };
  const seed: CanvasDocument = {
    version: 1,
    title: "A few studio observations",
    subtitle: "My field notes and an unfinished thought.",
    layout: "split",
    blocks: [original, writerOriginal],
    suggestions: [foreignChoice],
  };
  const newChoice = {
    id: "describe-this-jar",
    label: "Describe this jar as cobalt",
    description: "Change blue to cobalt only in the selected sentence.",
    request: "Change blue to cobalt in the selected sentence and preserve everything outside it.",
    targetBlockId: original.id,
  };
  const wirePrepared = {
    edits: [{
      type: "replace-selection",
      id: original.id,
      text: "The cobalt jar.",
    }],
    arrangement: null,
  };
  replyDocument = data => data.canvasSuggestionRefresh ? {
    // Only the chosen bucket crosses the model transport. The real worker must
    // merge unrelated canonical plans and stamp the trusted selection locally.
    suggestions: [{ ...newChoice, prepared: wirePrepared }],
  } : {
    ...seed,
    suggestions: [{ ...foreignChoice, prepared: {
      edits: [{ type: "patch", id: writerOriginal.id, changes: [{ type: "set", target: null, field: "body", value: "Choose a chapter and take your time." }] }],
    } }],
  };
  await submitFromHome();
  const target = page.getByRole("textbox", { name: `${original.title} text`, exact: true });
  const writer = page.getByRole("textbox", { name: `${writerOriginal.title} text`, exact: true });
  await expect(target).toHaveValue(original.body);
  await expect(writer).toHaveValue(writerOriginal.body);
  expect((await current()).canvas!.document).toEqual(seed);
  const targetIdentity = await target.elementHandle();
  const writerIdentity = await writer.elementHandle();
  if (!targetIdentity || !writerIdentity) throw new Error("The native editors are unavailable.");
  await writer.focus();
  await writer.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.insertText(" My own unfinished thought remains mine.");
  const authored = await writer.inputValue();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const beforeRefresh = await current();
  const foreignBeforeRefresh = structuredClone(beforeRefresh.canvas!.document!.suggestions!);
  expect(foreignBeforeRefresh[0]!.prepared!.before).toEqual([writerOriginal]);
  await expect(page.getByRole("button", { name: foreignChoice.label, exact: true })).toHaveAttribute("aria-disabled", "true");

  await target.focus();
  await target.evaluate((element, range) => {
    (element as HTMLTextAreaElement).setSelectionRange(range.start, range.end, "backward");
  }, selected);
  // Real native keyboard selection observation; no synthetic React select event.
  await target.press("Shift");
  const passageAction = page.getByRole("button", { name: "Suggest for this passage", exact: true });
  await expect(passageAction).toBeVisible();
  holdResponses = true;
  await passageAction.click();
  await expect(target).toBeFocused();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.canvasSuggestionRefresh).toEqual({
    targetId: `${beforeRefresh.id}:canvas`,
    canvasRevision: beforeRefresh.canvas!.revision,
    scope: { blockId: original.id, selection: selected },
  });
  expect(requests[1]!.targets[0]!.canvas!.blocks).toEqual(beforeRefresh.canvas!.document!.blocks);
  await passageAction.evaluate(element => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  expect(requests).toHaveLength(2);
  const contextRegion = page.getByRole("region", { name: `Next steps for ${original.title}`, exact: true });
  await expect(contextRegion).toBeVisible();
  await expect(contextRegion.getByRole("button", { name: `Cancel next steps for ${original.title}`, exact: true })).toBeVisible();
  expect((await current()).canvas).toEqual(beforeRefresh.canvas);

  // A completed background result must respect the editor the user moved to.
  await writer.focus();
  await writer.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(4, 12, "backward"));
  expect(deferred).toHaveLength(1);
  holdResponses = false;
  deferred.splice(0).forEach(release => release());
  const card = page.getByRole("button", { name: newChoice.label, exact: true });
  await expect(card).toBeVisible();
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await expect(writer).toBeFocused();
  await expect.poll(async () => (await current()).canvas!.revision).toBe(beforeRefresh.canvas!.revision + 1);
  const refreshed = await current();
  const savedChoice = refreshed.canvas!.document!.suggestions!.find(value => value.id === newChoice.id)!;
  expect(refreshed.canvas!.document!.blocks).toEqual(beforeRefresh.canvas!.document!.blocks);
  expect(refreshed.canvas!.document!.suggestions!.filter(value => value.targetBlockId !== original.id)).toEqual(foreignBeforeRefresh);
  expect(savedChoice.textSelection).toEqual(selected);
  expect(savedChoice.prepared).toMatchObject({ edits: [{ type: "replace", block: replacement }], before: [original] });
  expect(await target.evaluate((element, retained) => element === retained, targetIdentity)).toBe(true);
  expect(await writer.evaluate((element, retained) => element === retained, writerIdentity)).toBe(true);
  expect(await target.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    return [field.selectionStart, field.selectionEnd, field.selectionDirection];
  })).toEqual([selected.start, selected.end, "backward"]);
  expect(await writer.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    return [field.selectionStart, field.selectionEnd, field.selectionDirection];
  })).toEqual([4, 12, "backward"]);
  expect(requests).toHaveLength(2);

  await card.evaluate(element => (element as HTMLButtonElement).click());
  const review = page.getByRole("region", { name: "Suggestion preview", exact: true });
  // The exact passage stays prominent; automatic retirement of the stale
  // foreign choice is counted and available to inspect before keeping.
  await expect(review).toHaveAttribute("data-review-mode", "compact");
  await expect(review.locator(".suggestion-compact-field")).toHaveText("Selected passage");
  await expect(review.locator(".suggestion-compact-values del")).toHaveText(selected.text);
  await expect(review.locator(".suggestion-compact-values ins")).toHaveText("The cobalt jar.");
  await expect(review.locator(".suggestion-preview-changes")).toBeHidden();
  const retirements = review.locator("details.suggestion-compact-retirements");
  const retirementSummary = retirements.locator(":scope > summary");
  await expect(retirementSummary).toHaveText("Also removes 1 outdated suggestion");
  await expect(writer).toBeFocused();
  expect((await current()).canvas).toEqual(refreshed.canvas);
  expect(requests).toHaveLength(2);

  const canvasWrites = async () => {
    // The core owns an exclusive live database lock. Read its authoritative
    // history through the normal bridge; direct SQLite reads happen after close.
    const snapshot = await page.evaluate(() => window.eve.snapshot());
    expect(snapshot.recentActions.length).toBeLessThan(50);
    return snapshot.recentActions.filter(operation => operation.taskId === refreshed.id && operation.type === "UpdateCanvas");
  };
  const writesBeforeViewing = await canvasWrites();
  await expect(card.getByText("View change", { exact: true })).toBeVisible();
  // Arrival stays passive. Only activating this same ready card reveals the
  // existing review, without submitting a second preview or approving Keep.
  await card.click();
  await expect(review).toBeFocused();
  await expect(review.getByRole("button", { name: "Keep", exact: true })).not.toBeFocused();
  await card.focus();
  await card.press("Enter");
  await expect(review).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(review).toHaveAttribute("data-status", "ready");
  await expect(target).toHaveValue(original.body);
  expect((await current()).canvas).toEqual(refreshed.canvas);
  expect(requests).toHaveLength(2);
  const writesAfterViewing = await canvasWrites();
  expect(writesAfterViewing).toEqual(writesBeforeViewing);
  expect(await target.evaluate((element, retained) => element === retained, targetIdentity)).toBe(true);
  expect(await writer.evaluate((element, retained) => element === retained, writerIdentity)).toBe(true);
  expect(await writer.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    return [field.selectionStart, field.selectionEnd, field.selectionDirection];
  })).toEqual([4, 12, "backward"]);
  const readyViewGeometry = await review.evaluate(element => {
    const region = element.getBoundingClientRect();
    const workspace = element.closest(".workspace")!.getBoundingClientRect();
    const keep = element.querySelector(".suggestion-preview-keep")!.getBoundingClientRect();
    return { top: region.top, keepBottom: keep.bottom, workspaceTop: workspace.top, workspaceBottom: workspace.bottom };
  });
  expect(readyViewGeometry.top).toBeGreaterThanOrEqual(readyViewGeometry.workspaceTop);
  expect(readyViewGeometry.keepBottom).toBeLessThanOrEqual(readyViewGeometry.workspaceBottom);

  await retirementSummary.click();
  const retiredList = retirements.getByRole("list", { name: "Outdated suggestions removed by this change", exact: true });
  await expect(retiredList.getByRole("listitem")).toHaveCount(1);
  await expect(retiredList.locator("strong")).toHaveText(foreignChoice.label);
  await expect(retiredList.locator("span")).toHaveText(`${writerOriginal.title} · Writing`);
  await expect(retiredList.locator("p")).toHaveText("An item in this suggestion changed. Review a new suggestion from your current work.");
  await page.screenshot({ path: info.outputPath("contextual-passage-native-retirements.png") });
  await retirementSummary.click();
  const inspect = review.getByRole("button", { name: "Inspect full item", exact: true });
  await inspect.click();
  const closeInspection = review.getByRole("button", { name: "Close full inspection", exact: true });
  await expect(closeInspection).toBeFocused();
  await expect(review.locator(".suggestion-preview-changes")).toBeVisible();
  await expect(review.locator(".is-before")).toContainText(original.body);
  await expect(review.locator(".is-after")).toContainText(replacement.body);
  await expect(review.getByText("Suggested next steps update", { exact: true })).toBeVisible();
  await closeInspection.click();
  await expect(inspect).toBeFocused();
  await expect(review.locator(".suggestion-preview-changes")).toBeHidden();
  expect(await target.evaluate((element, retained) => element === retained, targetIdentity)).toBe(true);
  expect(await writer.evaluate((element, retained) => element === retained, writerIdentity)).toBe(true);
  await writer.focus();
  expect(await writer.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    return [field.selectionStart, field.selectionEnd, field.selectionDirection];
  })).toEqual([4, 12, "backward"]);
  expect((await current()).canvas).toEqual(refreshed.canvas);
  expect(requests).toHaveLength(2);
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("contextual-passage-native-review.png") });
  await review.getByRole("button", { name: "Keep", exact: true }).evaluate(element => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(target).toHaveValue(replacement.body);
  await expect.poll(async () => (await current()).canvas!.revision).toBe(refreshed.canvas!.revision + 1);
  const firstKeep = await current();
  expect(firstKeep.canvas!.document!.blocks).toEqual([replacement, { ...writerOriginal, body: authored }]);
  expect(requests).toHaveLength(2);
  expect(await writer.evaluate((element, retained) => element === retained, writerIdentity)).toBe(true);
  expect(await writer.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    return [field.selectionStart, field.selectionEnd, field.selectionDirection];
  })).toEqual([4, 12, "backward"]);

  await page.locator(".canvas-footer").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(target).toHaveValue(original.body);
  await expect.poll(async () => (await current()).canvas!.document).toEqual(refreshed.canvas!.document);
  // Applied reviews remain visible after history Undo until explicitly closed.
  await review.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(review).toHaveCount(0);
  await writer.focus();
  await writer.press("ControlOrMeta+z");
  await expect(writer).toHaveValue(writerOriginal.body);
  await writer.press("ControlOrMeta+Shift+z");
  await expect(writer).toHaveValue(authored);
  await expect(page.locator(".canvas-status")).toContainText("Saved");

  // The saved quote remains historical authority. Editing its actual occurrence
  // makes it unavailable; native Undo restores the exact original for review.
  await target.focus();
  await target.evaluate((element, range) => (element as HTMLTextAreaElement).setSelectionRange(range.start, range.end), selected);
  await page.keyboard.insertText("The green jar.");
  await expect(target).toHaveValue(`${phrase} First note.\nThe green jar. Last note.`);
  await expect(card).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await expect.poll(async () => (await current()).canvas!.document!.blocks[0]).toEqual({ ...original, body: `${phrase} First note.\nThe green jar. Last note.` });
  await card.evaluate(element => (element as HTMLButtonElement).click());
  await expect(review).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect((await current()).canvas!.document!.suggestions!.find(value => value.id === newChoice.id)!.textSelection).toEqual(selected);
  await target.press("ControlOrMeta+z");
  await expect(target).toHaveValue(original.body);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  await expect(card).toHaveAttribute("aria-disabled", "false");
  const clickEvidence = await page.evaluateHandle(label => {
    const records: unknown[] = [];
    const selectedCard = () => [...document.querySelectorAll<HTMLButtonElement>('[data-suggestion-action]')].find(button => button.getAttribute('aria-label') === label);
    const record = (type: string, event?: Event) => {
      const button = selectedCard(), rect = button?.getBoundingClientRect();
      const pointer = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined;
      records.push({ type, at: performance.now(), target: event?.target instanceof HTMLElement ? event.target.tagName + ':' + (event.target.getAttribute('aria-label') ?? event.target.className) : null,
        active: document.activeElement?.getAttribute('aria-label'), pointer, card: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        toolbar: !!document.querySelector('.canvas-context-selection'), reserved: document.querySelector('.canvas-context-selection-host')?.getAttribute('style') });
    };
    for (const type of ['pointerdown', 'mousedown', 'focusout', 'focusin', 'pointerup', 'mouseup', 'click']) document.addEventListener(type, event => {
      record(type, event);
      if (type === 'pointerdown') requestAnimationFrame(() => { record('frame-after-down'); requestAnimationFrame(() => record('second-frame-after-down')); });
    }, true);
    window.eve.onIntelligence(event => { if (event.type === 'intent') records.push({ type: 'intent', response: event.response }); });
    record('before-click');
    return records;
  }, newChoice.label);
  await card.click();
  await expect(review).toHaveAttribute("data-review-mode", "compact").catch(async error => {
    await writeFile(info.outputPath("contextual-card-pointer-evidence.json"), JSON.stringify(await clickEvidence.evaluate(records => records), null, 2));
    await page.screenshot({ path: info.outputPath("contextual-card-pointer-failure.png") });
    throw error;
  });
  await writeFile(info.outputPath("contextual-card-pointer-evidence.json"), JSON.stringify(await clickEvidence.evaluate(records => records), null, 2));
  await expect(review.locator(".suggestion-compact-values del")).toHaveText(selected.text);
  await expect(review.locator(".suggestion-compact-values ins")).toHaveText("The cobalt jar.");
  await expect(retirementSummary).toHaveText("Also removes 1 outdated suggestion");
  await review.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(target).toHaveValue(replacement.body);
  await expect(page.locator(".canvas-status")).toContainText("Saved");
  const kept = await current();
  expect(kept.canvas!.document).toEqual(firstKeep.canvas!.document);
  expect(requests).toHaveLength(2);
  await nativeHome();
  await closeApplication();
  const database = new DatabaseSync(path.join(profile, "eve.db"), { readOnly: true });
  try {
    const row = database.prepare("SELECT value,revision FROM canvases WHERE task_id=?").get(kept.id) as { value: string; revision: number };
    expect(JSON.parse(row.value)).toEqual(kept.canvas!.document);
    expect(row.revision).toBe(kept.canvas!.revision);
    const durableCanvasOperations = database.prepare("SELECT id,request_id,undone FROM operations WHERE task_id=? AND type='UpdateCanvas' ORDER BY rowid").all(kept.id) as { id: string; request_id: string; undone: number }[];
    expect(durableCanvasOperations.slice(0, writesBeforeViewing.length).map(operation => operation.id)).toEqual(writesBeforeViewing.map(operation => operation.id).reverse());
    await writeFile(info.outputPath("contextual-passage-durable-evidence.json"), JSON.stringify({
      document: JSON.parse(row.value), revision: row.revision,
      refresh: requests[1]!.canvasSuggestionRefresh,
      providerWirePrepared: wirePrepared,
      savedSelection: savedChoice.textSelection,
      savedPrepared: savedChoice.prepared,
      beforeRefresh: beforeRefresh.canvas,
      afterRefresh: refreshed.canvas,
      firstKeepRevision: firstKeep.canvas!.revision,
      foreignHistoricalChoices: foreignBeforeRefresh,
      compactReview: { field: "Selected passage", before: selected.text, after: "The cobalt jar.", retiredCount: 1, retiredLabel: foreignChoice.label, retiredTarget: writerOriginal.title, fullInspectionRetained: true },
      readyViewNavigation: { pointerAndKeyboardActivated: true, focusedRegionNotKeep: true, repeatedEnterDidNotApply: true, updateCanvasOperationCountBefore: writesBeforeViewing.length, updateCanvasOperationCountAfter: writesAfterViewing.length, updateCanvasOperationsBefore: writesBeforeViewing, updateCanvasOperationsAfter: writesAfterViewing, providerRequests: 2, geometry: readyViewGeometry },
      durableCanvasOperations,
      providerRequests: requests.length,
      qualification: "Controlled provider through actual worker scope validation and local snapshot hydration, host metadata save, native selected editors, review/Keep, core Undo/SQLite and cold restart; not live model quality.",
    }, null, 2));
  } finally { database.close(); }
  await launch();
  await page.getByTestId("home").getByRole("button", { name: `Open ${requestText}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: `${original.title} text`, exact: true })).toHaveValue(replacement.body);
  await expect(page.getByRole("textbox", { name: `${writerOriginal.title} text`, exact: true })).toHaveValue(authored);
  expect((await current()).canvas).toMatchObject({ revision: kept.canvas!.revision, document: kept.canvas!.document });
  expect(requests).toHaveLength(2);
  expect(providerErrors).toEqual([]);
});
