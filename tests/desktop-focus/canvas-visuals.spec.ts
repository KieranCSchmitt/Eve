import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasDocument } from "@eve/contracts";

// These compositions are visual test inputs only. They never populate a user's profile.
const base = { placement: "main" as const, pinned: false, sourceIds: [] };
const trip: CanvasDocument = {
  version: 1,
  title: "Take the slower way.",
  subtitle: "A riverside afternoon, a few good photographs, and room to wander.",
  layout: "split",
  blocks: [
    { ...base, id: "river", kind: "image", title: "Along the river", assetId: "riverside-photo", caption: "Your saved riverside reference. An afternoon worth leaving open." },
    { ...base, id: "bring", kind: "checklist", placement: "aside", title: "Before you head out", items: [
      { id: "camera", label: "Charge the camera", checked: true },
      { id: "water", label: "Bring water and a light layer", checked: false },
      { id: "map", label: "Save the route for later", checked: false },
    ] },
    { ...base, id: "notes", kind: "text", title: "Let the afternoon unfold", body: "Start where the trees meet the water. Follow the path until a view makes you want to pause.\n\nKeep the plan light: one place to begin, a little time to explore, and something to remember it by." },
    { ...base, id: "references", kind: "sources", placement: "aside", title: "From your notes", description: "A few details to keep close.", sourceIds: ["river-notes"] },
  ],
  suggestions: [
    { id: "route", targetBlockId: "bring", label: "Make a gentle walking plan", description: "A starting point, a photo stop, and a little breathing room.", request: "Use my saved river notes to make a tentative afternoon walking timeline. Keep my original notes and checklist." },
    { id: "compare", targetBlockId: null, label: "Compare a shorter route", description: "See a relaxed option beside the longer walk.", request: "Compare two walking options based only on my saved notes. Clearly mark details that need checking." },
    { id: "journal", targetBlockId: null, label: "Make room for a travel journal", description: "Keep the moments you’ll want to remember.", request: "Add a blank writing area for a travel journal, with a short opening prompt. Preserve everything already here." },
  ],
};
const day: CanvasDocument = {
  version: 1,
  title: "Tuesday, with room to think.",
  subtitle: "A local plan for your work. Keep the parts that feel right.",
  layout: "split",
  blocks: [
    { ...base, id: "day", kind: "timeline", placement: "full", title: "The shape of your day", date: "Tuesday, September 22", startHour: 9, endHour: 18, items: [
      { id: "review", title: "Design review", startMinutes: 570, endMinutes: 630, status: "planned", detail: "Bring the first sketches." },
      { id: "read", title: "Read & collect", startMinutes: 660, endMinutes: 720, status: "planned", detail: "Gather the references for your essay." },
      { id: "lunch", title: "Lunch", startMinutes: 750, endMinutes: 780, status: "planned", detail: "Step away from the desk." },
      { id: "focus", title: "A little writing time", startMinutes: 780, endMinutes: 870, status: "suggested", detail: "An uninterrupted stretch for the next section." },
      { id: "finish", title: "Read it through", startMinutes: 930, endMinutes: 990, status: "planned", detail: "Leave the draft in a good place." },
    ] },
    { ...base, id: "draft", kind: "text", title: "The places between", body: "Good ideas need somewhere to land. A page, a pause, or a conversation can give a thought enough room to become something more.\n\nThe space between tasks is part of the work. It lets us notice the detail we passed over, make an unexpected connection, and return with a clearer sense of what matters." },
    { ...base, id: "prepare", kind: "checklist", placement: "aside", title: "For the next draft", items: [
      { id: "opening", label: "Read the opening aloud", checked: true },
      { id: "example", label: "Add one concrete example", checked: false },
      { id: "ending", label: "Leave a note for the ending", checked: false },
    ] },
    { ...base, id: "timer", kind: "timer", placement: "aside", title: "A quiet stretch", durationSeconds: 1500, remainingSeconds: 1500, endsAt: null },
  ],
  suggestions: [
    { id: "outline", targetBlockId: "draft", label: "Find the next paragraph", description: "Build an outline around the ideas already on your page.", request: "Suggest an outline for the next section alongside my draft. Preserve every word I have written." },
    { id: "space", targetBlockId: null, label: "Leave a longer break", description: "Give the afternoon a little more breathing room.", request: "Adjust the local plan to leave a 30-minute break after the writing time. Keep the existing draft and completed items unchanged." },
  ],
};

let script: string;
let styles: string;
test.beforeAll(async () => {
  const photograph = await readFile("apps/desktop/renderer/public/assets/photo-walk.png");
  const output = await build({
    stdin: {
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ArrowLeft, Search, Volume2, Wifi } from 'lucide-react';
        import { Canvas } from './apps/desktop/renderer/src/components/Canvas';
        import { Logo } from './apps/desktop/renderer/src/Logo';
        import { canvasDocumentSchema } from './packages/contracts/src/canvas';
        const assets = [{id:'riverside-photo',taskId:'visual-fixture',title:'Riverside reference',mediaType:'image/png',byteLength:${photograph.length},url:'data:image/png;base64,${photograph.toString("base64")}',provenance:{kind:'user-import',attribution:'Repository image used for visual testing only.',rights:'Test fixture.'}}];
        const sources = [{id:'river-notes',taskId:'visual-fixture',title:'Riverside observations',assetId:'saved-notes',excerpt:'Start near the old bridge. Follow the water and leave time to stop.',createdAt:1,retrievedAt:1,provenance:{kind:'user-import',attribution:'Test fixture notes.',rights:'Test fixture.'}}];
        function Fixture({initial}) {
          const [document,setDocument] = useState(initial);
          return <div className="canvas-visual-shell">
            <header className="shell-header"><div className="brand-button"><Logo/><span className="brand-dot"/></div>
              <div className="purpose"><ArrowLeft size={15}/><span className="header-divider"/><span className="purpose-name">Your space</span></div>
              <div className="system-bar" aria-label="Illustrative shell"><time>9:12 AM</time><Wifi size={17}/><Volume2 size={17}/></div>
            </header>
            <main className="workspace canvas-workspace"><Canvas document={document} assets={assets} sources={sources} onChange={next=>{canvasDocumentSchema.parse(next);setDocument(next)}} onRequestSuggestion={()=>{}} onOpenSource={()=>{}} onUndo={()=>{}} canUndo/></main>
            <footer className="canvas-visual-find"><Search size={16}/>Find anything</footer>
          </div>;
        }
        window.mountCanvasVisual = initial => {canvasDocumentSchema.parse(initial);createRoot(document.getElementById('root')).render(<Fixture initial={initial}/>)};
      `,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, outfile: "canvas-visual-fixture.js", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const [globalStyles, serif, italic, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile("node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2"),
    readFile("node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-italic.woff2"),
    readFile("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  ]);
  styles = `${globalStyles}\n${output.outputFiles.find(file => file.path.endsWith(".css"))!.text}
    @font-face{font-family:'Newsreader Variable';font-style:normal;font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}
    @font-face{font-family:'Newsreader Variable';font-style:italic;font-weight:200 800;src:url(data:font/woff2;base64,${italic.toString("base64")})}
    @font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}
    body{background:var(--paper)}.canvas-visual-shell{min-height:100vh}.canvas-visual-find{display:flex;align-items:center;gap:12px;padding:18px 38px;color:var(--muted);font-size:12px}
    @media(max-width:540px){.canvas-visual-shell .purpose{display:none}.canvas-visual-shell .system-bar time{display:none}}
  `;
  await mkdir("test-results/canvas-visuals", { recursive: true });
});

async function mount(page: Page, document: CanvasDocument) {
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(document => (window as unknown as { mountCanvasVisual(document: CanvasDocument): void }).mountCanvasVisual(document), document);
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map(image => image.decode()));
    // Let ResizeObserver-driven composition settle after images and fonts acquire size.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

for (const [name, composition] of [["riverside", trip], ["day", day]] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`${name} composition at ${viewport.width}px stays legible without overlap`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await mount(page, composition);
      const layout = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll<HTMLElement>(".canvas-block")].map(element => {
          const box = element.getBoundingClientRect();
          return { name: element.getAttribute("aria-label"), left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        });
        const overlaps: string[] = [];
        for (let first = 0; first < blocks.length; first++) for (let second = first + 1; second < blocks.length; second++) {
          const a = blocks[first], b = blocks[second];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(`${a.name} / ${b.name}`);
        }
        const textAreas = [...document.querySelectorAll<HTMLTextAreaElement>(".canvas-editable-copy")].map(element => {
          const rendered = element.getBoundingClientRect().height;
          const previous = element.style.height;
          element.style.height = "auto";
          const natural = element.scrollHeight + 2;
          element.style.height = previous;
          return { name: element.getAttribute("aria-label"), rendered, natural };
        });
        return { overflow: document.documentElement.scrollWidth > window.innerWidth, overlaps, textAreas, font: getComputedStyle(document.querySelector(".canvas-heading h1")!).fontFamily };
      });
      const filename = resolve(`test-results/canvas-visuals/${name}-${viewport.width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      await testInfo.attach(`${name}-${viewport.width}`, { path: filename, contentType: "image/png" });
      if (viewport.width === 1280) await page.screenshot({ path: resolve(`test-results/canvas-visuals/${name}-viewport-1280.png`) });
      expect(layout.overlaps, "Canvas blocks must not overlap each other").toEqual([]);
      expect(layout.overflow, "Canvas must not overflow the viewport horizontally").toBe(false);
      expect(layout.font).toContain("Newsreader Variable");
      for (const area of layout.textAreas) expect(area.rendered, `${area.name} should size to its content (${area.natural}px), without a large empty tail`).toBeLessThanOrEqual(Math.max(280, area.natural * 1.15));
      if (name === "day") {
        await expect(page.getByLabel("Day at a glance")).toBeVisible();
        await expect(page.getByRole("button", { name: "Keep A little writing time", exact: true })).toBeVisible();
        const lunch = await page.getByRole("button", { name: "Show Lunch", exact: true }).boundingBox();
        const writing = await page.getByRole("button", { name: "Show A little writing time", exact: true }).boundingBox();
        if (viewport.width >= 1280) expect(lunch!.y, "Adjacent timeline events with enough room for their labels should share a row").toBe(writing!.y);
      } else {
        await expect(page.locator(".canvas-image img")).toBeVisible();
        await expect(page.getByRole("button", { name: "Make a gentle walking plan", exact: true })).toBeVisible();
      }
    });
  }
}
