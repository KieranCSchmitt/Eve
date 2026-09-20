import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { CanvasDocument, CoreCommandInput } from "@eve/contracts";

// Browser qualification of the actual draft hook with deliberately controlled
// persistence timing/failures. Real Electron/SQLite acceptance is separate.
type SaveMode = "ok" | "hold" | "fail" | "lost-ack";
type CanvasCommand = Extract<CoreCommandInput, { type: "UpdateCanvas" }>;
type DraftWindow = Window & {
  mountDrafts(): void;
  saveMode: SaveMode;
  canvasWrites: CanvasCommand[];
  releaseSave(index: number): void;
  replaceSaved(body: string, revision: number): void;
  replaceEpoch(epoch: number): void;
  resolveDraft(choice: "saved" | "draft", revision: number): void;
  savedCanvas: { document: CanvasDocument; revision: number };
  dirtyCanvas: boolean;
};
let script: string;
test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import { useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { useCanvasDrafts } from './apps/desktop/renderer/src/hooks/useCanvasDrafts';
        import { canvasDocumentSchema } from './packages/contracts/src/canvas';
        const document = body => ({version:1,title:'A working thought',subtitle:'',layout:'focus',blocks:[{id:'text',kind:'text',title:'Thought',placement:'main',pinned:false,sourceIds:[],body}]});
        const initial = {id:'task',epoch:1,canvas:{document:document('Original thought'),revision:1,updatedAt:1}};
        window.saveMode = 'ok'; window.canvasWrites = [];
        const waiting = [], receipts = new Map();
        window.releaseSave = index => { const resolve = waiting[index]; if (!resolve) throw new Error('No held save at '+index); resolve(); };
        function Fixture() {
          const [task,setTask] = useState(initial);
          const current = useRef(task); current.current = task;
          const tail = useRef(Promise.resolve());
          const [home,setHome] = useState(false);
          const [navigationError,setNavigationError] = useState('');
          const enqueue = operation => { const result = tail.current.then(operation); tail.current = result.catch(() => {}); return result; };
          const snapshot = () => ({version:1,activeTaskId:'task',tasks:[current.current],recentActions:[]});
          const dispatch = async command => {
            window.canvasWrites.push(structuredClone(command));
            const mode = window.saveMode;
            if (mode === 'hold') await new Promise(resolve => waiting.push(resolve));
            const oldReceipt = receipts.get(command.requestId);
            if (oldReceipt) {
              if (JSON.stringify(oldReceipt.command) !== JSON.stringify(command)) throw new Error('The same request was retried with different content.');
              return {...oldReceipt.result,snapshot:snapshot(),idempotent:true};
            }
            if (!canvasDocumentSchema.safeParse(command.document).success) return {ok:false,snapshot:snapshot(),error:{code:'INVALID_COMMAND',message:'The canvas is outside its supported limits.'}};
            if (command.expectedEpoch !== current.current.epoch) return {ok:false,snapshot:snapshot(),error:{code:'STALE_EPOCH',message:'The task epoch changed.'}};
            if (mode === 'fail') return {ok:false,snapshot:snapshot(),error:{code:'STORAGE_ERROR',message:'The disk could not save this change.'}};
            if (command.expectedRevision !== current.current.canvas.revision) return {ok:false,snapshot:snapshot(),error:{code:'REVISION_CONFLICT',message:'Changed remotely.'}};
            const next = {...current.current,canvas:{document:structuredClone(command.document),revision:current.current.canvas.revision+1,updatedAt:Date.now()}};
            current.current = next; setTask(next);
            const result = {ok:true,snapshot:snapshot(),operation:{id:command.requestId,requestId:command.requestId,taskId:'task',type:'UpdateCanvas',label:'Updated canvas',createdAt:Date.now(),undoable:true,undone:false},idempotent:false};
            receipts.set(command.requestId,{command:structuredClone(command),result});
            if (mode === 'lost-ack') { window.saveMode = 'ok'; throw new Error('The save acknowledgement was lost.'); }
            return result;
          };
          const draft = useCanvasDrafts({getTask:id => id === 'task' ? current.current : undefined,dispatch,enqueue,onDirty:value => {window.dirtyCanvas=value;}});
          window.savedCanvas = task.canvas;
          window.replaceSaved = (body,revision) => { const next = {...current.current,canvas:{document:document(body),revision,updatedAt:Date.now()}}; current.current=next; setTask(next); };
          window.replaceEpoch = epoch => { const next = {...current.current,epoch}; current.current=next; setTask(next); };
          window.resolveDraft = (choice,revision) => draft.resolve('task',choice,revision);
          const value = draft.document(task);
          return <main>
            {home ? <h1>Home</h1> : <>
              <label>Your thought<textarea aria-label="Your thought" value={value.blocks[0].body} onChange={event => draft.queue('task',document(event.target.value))} /></label>
              <p role="status">{draft.errors.task || (draft.hasDraft('task') ? 'Saving…' : 'Saved')}</p>
              <button onClick={() => void enqueue(() => draft.flush('task')).catch(() => {})}>Retry save</button>
              <button onClick={() => void enqueue(async () => {await draft.flush();setHome(true);}).catch(error => setNavigationError(error.message))}>Go Home</button>
              {navigationError && <p role="alert">{navigationError}</p>}
            </>}
          </main>;
        }
        window.mountDrafts = () => createRoot(globalThis.document.getElementById('root')).render(<Fixture />);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
      sourcefile: "canvas-drafts-fixture.tsx",
    },
    bundle: true,
    write: false,
    outfile: "canvas-drafts-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles[0].text;
});
async function mount(page: Page, mode: SaveMode = "ok") {
  // Use a trustworthy local origin, as the real Eve renderer does, so native
  // crypto.randomUUID is available without replacing its identity generator.
  await page.route("http://127.0.0.1:37771/canvas-drafts", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://127.0.0.1:37771/canvas-drafts");
  await page.addScriptTag({ content: script });
  await page.evaluate((mode) => {
    const fixture = window as unknown as DraftWindow;
    fixture.saveMode = mode;
    fixture.mountDrafts();
  }, mode);
  await expect(page.getByRole("textbox", { name: "Your thought" })).toHaveValue(
    "Original thought",
  );
}
const writes = (page: Page) =>
  page.evaluate(() => (window as unknown as DraftWindow).canvasWrites);
const saved = (page: Page) =>
  page.evaluate(() => (window as unknown as DraftWindow).savedCanvas);

test("keeps typing immediate through slow saves and serializes the latest draft after the acknowledged revision", async ({
  page,
}) => {
  await mount(page, "hold");
  const field = page.getByRole("textbox", { name: "Your thought" });
  await field.fill("First thought");
  await expect.poll(async () => (await writes(page)).length).toBe(1);
  await field.fill("A newer thought while the first is saving");
  await field.press("ArrowLeft");
  await expect(field).toHaveValue("A newer thought while the first is saving");
  await expect(field).toBeFocused();
  expect((await saved(page)).revision).toBe(1);
  await page.evaluate(() => (window as unknown as DraftWindow).releaseSave(0));
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  expect((await writes(page))[1]).toMatchObject({
    expectedRevision: 2,
    document: {
      blocks: [{ body: "A newer thought while the first is saving" }],
    },
  });
  await expect(field).toHaveValue("A newer thought while the first is saving");
  await expect(field).toBeFocused();
  await page.evaluate(() => (window as unknown as DraftWindow).releaseSave(1));
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await saved(page)).revision).toBe(3);
  expect(
    await page.evaluate(() => (window as unknown as DraftWindow).dirtyCanvas),
  ).toBe(false);
  expect(await writes(page)).toHaveLength(2);
});

test("a failed save retains the visible draft and blocks navigation until the same request is retried", async ({
  page,
}) => {
  await mount(page, "fail");
  const field = page.getByRole("textbox", { name: "Your thought" });
  await field.fill("Keep this if the disk refuses the save");
  await expect(page.getByRole("status")).toContainText(
    "The disk could not save",
  );
  await page.getByRole("button", { name: "Go Home" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The disk could not save",
  );
  await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
  await expect(field).toHaveValue("Keep this if the disk refuses the save");
  expect((await saved(page)).document.blocks[0]).toMatchObject({
    body: "Original thought",
  });
  expect(
    await page.evaluate(() => (window as unknown as DraftWindow).dirtyCanvas),
  ).toBe(true);
  await page.evaluate(() => {
    (window as unknown as DraftWindow).saveMode = "ok";
  });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const commands = await writes(page);
  expect(commands).toHaveLength(3);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[1]).toEqual(commands[2]);
  await page.getByRole("button", { name: "Go Home" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("lost acknowledgement retries the identical submitted document before committing newer typing", async ({
  page,
}) => {
  await mount(page, "lost-ack");
  const field = page.getByRole("textbox", { name: "Your thought" });
  await field.fill("The committed but unacknowledged thought");
  await expect(page.getByRole("status")).toContainText(
    "acknowledgement was lost",
  );
  expect((await saved(page)).revision).toBe(2);
  await field.fill("The thought I added after the lost reply");
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const commands = await writes(page);
  expect(commands).toHaveLength(3);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[2].requestId).not.toBe(commands[0].requestId);
  expect(commands[2]).toMatchObject({
    expectedRevision: 2,
    document: {
      blocks: [{ body: "The thought I added after the lost reply" }],
    },
  });
  expect((await saved(page)).revision).toBe(3);
  await expect(field).toHaveValue("The thought I added after the lost reply");
});

test("a definitive invalid-command rejection lets corrected input save with a new request identity", async ({
  page,
}) => {
  await mount(page);
  const field = page.getByRole("textbox", { name: "Your thought" });
  const oversized = "x".repeat(20_001);
  await field.fill(oversized);
  await expect(page.getByRole("status")).toContainText(
    "outside its supported limits",
  );
  await expect(field).toHaveValue(oversized);
  expect((await saved(page)).revision).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as DraftWindow).dirtyCanvas),
  ).toBe(true);
  await field.fill("A corrected thought within the supported limits");
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const commands = await writes(page);
  expect(commands).toHaveLength(2);
  expect(commands[1].requestId).not.toBe(commands[0].requestId);
  expect(commands[1]).toMatchObject({
    expectedRevision: 1,
    document: {
      blocks: [{ body: "A corrected thought within the supported limits" }],
    },
  });
  expect((await saved(page)).revision).toBe(2);
  expect(
    await page.evaluate(() => (window as unknown as DraftWindow).dirtyCanvas),
  ).toBe(false);
});

test("lost-acknowledgement retries preserve the original epoch before newer typing uses the current epoch", async ({
  page,
}) => {
  await mount(page, "lost-ack");
  const field = page.getByRole("textbox", { name: "Your thought" });
  await field.fill("The thought saved during the original task epoch");
  await expect(page.getByRole("status")).toContainText(
    "acknowledgement was lost",
  );
  expect((await saved(page)).revision).toBe(2);
  await page.evaluate(() => (window as unknown as DraftWindow).replaceEpoch(4));
  await field.fill("A new thought after returning to this task");
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const commands = await writes(page);
  expect(commands).toHaveLength(3);
  expect(commands[0].expectedEpoch).toBe(1);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[2].requestId).not.toBe(commands[0].requestId);
  expect(commands[2]).toMatchObject({
    expectedEpoch: 4,
    expectedRevision: 2,
    document: {
      blocks: [{ body: "A new thought after returning to this task" }],
    },
  });
  expect((await saved(page)).revision).toBe(3);
  await expect(field).toHaveValue("A new thought after returning to this task");
});

test("conflicts require the reviewed revision before keeping a local draft or switching to the saved canvas", async ({
  page,
}) => {
  await mount(page, "hold");
  const field = page.getByRole("textbox", { name: "Your thought" });
  await field.fill("My local thought");
  await expect.poll(async () => (await writes(page)).length).toBe(1);
  await page.evaluate(() =>
    (window as unknown as DraftWindow).replaceSaved(
      "A separately saved thought",
      2,
    ),
  );
  await page.evaluate(() => (window as unknown as DraftWindow).releaseSave(0));
  await expect(page.getByRole("status")).toContainText(
    "A newer canvas was saved",
  );
  await expect(field).toHaveValue("My local thought");
  await page.evaluate(() => {
    const fixture = window as unknown as DraftWindow;
    fixture.replaceSaved("Changed again", 3);
    fixture.resolveDraft("draft", 2);
  });
  await expect(page.getByRole("status")).toContainText(
    "Review its latest version first",
  );
  expect(await writes(page)).toHaveLength(1);
  await page.evaluate(() => {
    const fixture = window as unknown as DraftWindow;
    fixture.saveMode = "ok";
    fixture.resolveDraft("draft", 3);
  });
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await writes(page))[1]).toMatchObject({ expectedRevision: 3 });
  expect((await saved(page)).revision).toBe(4);
  await expect(field).toHaveValue("My local thought");

  await page.evaluate(() => {
    (window as unknown as DraftWindow).saveMode = "fail";
  });
  await field.fill("A draft I may choose to put aside");
  await expect(page.getByRole("status")).toContainText(
    "The disk could not save",
  );
  await page.evaluate(() => {
    const fixture = window as unknown as DraftWindow;
    fixture.replaceSaved("A reviewed saved version", 5);
    fixture.resolveDraft("saved", 4);
  });
  await expect(field).toHaveValue("A draft I may choose to put aside");
  await expect(page.getByRole("status")).toContainText(
    "Review its latest version first",
  );
  const count = (await writes(page)).length;
  await page.evaluate(() =>
    (window as unknown as DraftWindow).resolveDraft("saved", 5),
  );
  await expect(field).toHaveValue("A reviewed saved version");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(
    await page.evaluate(() => (window as unknown as DraftWindow).dirtyCanvas),
  ).toBe(false);
  expect(await writes(page)).toHaveLength(count);
});
