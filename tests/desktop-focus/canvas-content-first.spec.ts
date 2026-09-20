import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasDocument } from "@eve/contracts";

const base = { placement: "main" as const, pinned: false, sourceIds: [] };
// Synthetic inputs exercise the actual canvas, not a replacement screen.
const compositions: Record<string, CanvasDocument> = {
  photograph: {
    version: 1,
    title: "An afternoon beside the river",
    subtitle: "Your original photograph and the notes that belong with it.",
    layout: "split",
    blocks: [
      {
        ...base,
        id: "photo",
        kind: "image",
        title: "Along the water",
        assetId: "river-original",
        caption: "A saved reference for this browser fixture.",
      },
      {
        ...base,
        id: "notes",
        kind: "text",
        placement: "aside",
        title: "Things to notice",
        body: "Look for reflections, the changing light, and the shapes between branches.",
      },
    ],
  },
  design: {
    version: 1,
    title: "An evening in print",
    subtitle: "An editable composition with a note beside it.",
    layout: "split",
    blocks: [
      {
        ...base,
        id: "print",
        kind: "design",
        title: "Evening edition",
        width: 840,
        height: 680,
        background: "#F4F0E7",
        layers: [
          {
            id: "photo",
            kind: "image",
            name: "River",
            x: 390,
            y: 0,
            width: 450,
            height: 680,
            assetId: "river-original",
            fit: "cover",
          },
          {
            id: "headline",
            kind: "text",
            name: "Headline",
            x: 35,
            y: 80,
            width: 340,
            height: 290,
            text: "An evening\nworth keeping.",
            fontFamily: "serif",
            fontSize: 70,
            fontWeight: "regular",
            color: "#263B3C",
            align: "left",
          },
          {
            id: "caption",
            kind: "text",
            name: "Caption",
            x: 35,
            y: 510,
            width: 320,
            height: 100,
            text: "A study in colour and space.",
            fontFamily: "sans",
            fontSize: 23,
            fontWeight: "regular",
            color: "#263B3C",
            align: "left",
          },
        ],
      },
      {
        ...base,
        id: "notes",
        kind: "text",
        placement: "aside",
        pinned: true,
        title: "My note",
        body: "Keep my own words and the image original.",
      },
    ],
  },
  table: {
    version: 1,
    title: "Materials for the next edition",
    subtitle: "A working table with an exact total beside it.",
    layout: "split",
    blocks: [
      {
        ...base,
        id: "materials",
        kind: "table",
        title: "Print materials",
        columns: ["Material", "Cost"],
        rows: [
          { id: "paper", cells: ["Paper", "24"] },
          { id: "ink", cells: ["Ink", "18"] },
          { id: "total", cells: ["Total", "=B1+B2"] },
        ],
      },
      {
        ...base,
        id: "total",
        kind: "metric",
        placement: "aside",
        title: "Materials total",
        tableId: "materials",
        rowId: "total",
        column: 1,
        prefix: "$",
        suffix: "",
        decimals: 0,
      },
    ],
  },
  writing: {
    version: 1,
    title: "The places between",
    subtitle: "Room to follow a thought.",
    layout: "split",
    blocks: [
      {
        ...base,
        id: "draft",
        kind: "text",
        title: "A page in progress",
        body: "Good ideas need somewhere to land. A page, a pause, or a conversation can give a thought enough room to become something more.\n\nThe space between tasks is part of the work. It lets us notice the detail we passed over and return with a clearer sense of what matters.",
      },
      {
        ...base,
        id: "check",
        kind: "checklist",
        placement: "aside",
        title: "For the next draft",
        items: [
          { id: "read", label: "Read the opening aloud", checked: false },
        ],
      },
    ],
  },
};

let script: string;
let styles: string;
test.beforeAll(async () => {
  const photo = await readFile(
    "apps/desktop/renderer/public/assets/photo-walk.png",
  );
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Home,FileText,BookOpen,Search,SlidersHorizontal} from 'lucide-react';
      import {Canvas} from './apps/desktop/renderer/src/components/Canvas';
      import {Logo} from './apps/desktop/renderer/src/Logo';
      import {canvasDocumentSchema} from './packages/contracts/src/canvas';
      const assets=[{id:'river-original',taskId:'visual-fixture',title:'River photograph',mediaType:'image/png',byteLength:${photo.length},url:'data:image/png;base64,${photo.toString("base64")}',provenance:{kind:'user-import',attribution:'Repository photograph; browser fixture only.',rights:'Test fixture.'}}];
      function Fixture({initial}) {
        const [value,setValue]=useState(initial);
        return <div className="eve-app">
          <header className="shell-header"><div className="brand-button"><Logo/></div><div className="purpose"><Home size={16}/><span className="header-divider"/><span className="purpose-name">A place to work</span></div><div className="system-bar"><time>9:12 AM</time><SlidersHorizontal size={17}/></div></header>
          <main className="workspace canvas-workspace"><section className="canvas-space">
            <div className="canvas-space-navigation"><button className="quiet-button"><FileText size={15}/>Notebook</button><button className="quiet-button"><BookOpen size={15}/>Sources</button></div>
            <div className="canvas-space-body"><div className="canvas-primary"><Canvas document={value} assets={assets} sources={[]} onChange={next=>{canvasDocumentSchema.parse(next);setValue(next)}} onRequestSuggestion={()=>{}} onUndo={()=>{}} canUndo/></div></div>
          </section></main><footer className="content-first-find"><Search size={16}/>Find anything</footer>
        </div>;
      }
      window.mountContentFirst=initial=>{canvasDocumentSchema.parse(initial);createRoot(document.getElementById('root')).render(<Fixture initial={initial}/>)};
    `,
    },
    bundle: true,
    write: false,
    outfile: "fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const [globalStyles, serif, sans] = await Promise.all([
    readFile("apps/desktop/renderer/src/styles.css", "utf8"),
    readFile(
      "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-standard-normal.woff2",
    ),
    readFile(
      "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    ),
  ]);
  styles = `${globalStyles}\n${output.outputFiles.find((file) => file.path.endsWith(".css"))!.text}
    @font-face{font-family:'Newsreader Variable';font-style:normal;font-weight:200 800;src:url(data:font/woff2;base64,${serif.toString("base64")})}
    @font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${sans.toString("base64")})}
    .content-first-find{display:flex;align-items:center;gap:12px;min-height:50px;padding:12px 38px;color:var(--muted);font-size:12px}
    @media(max-width:540px){.purpose{display:none}.system-bar time{display:none}}
  `;
});

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) => image.decode().catch(() => {})),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

for (const [name, composition] of Object.entries(compositions)) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${name} keeps the work visible and readable at ${viewport.width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ content: styles });
      await page.addScriptTag({ content: script });
      await page.evaluate(
        (value) =>
          (
            window as unknown as {
              mountContentFirst(value: CanvasDocument): void;
            }
          ).mountContentFirst(value),
        composition,
      );
      await expect(page.getByTestId("canvas")).toBeVisible();
      await settle(page);
      const selector =
        name === "design"
          ? "[data-design-stage]"
          : name === "photograph"
            ? ".canvas-photo-mat"
            : name === "table"
              ? ".canvas-table"
              : ".canvas-editable-copy";
      const metrics = await page.evaluate((selector) => {
        const work = document.querySelector<HTMLElement>(selector)!;
        const box = work.getBoundingClientRect();
        const heading =
          document.querySelector<HTMLElement>(".canvas-heading h1")!;
        const blocks = [
          ...document.querySelectorAll<HTMLElement>(".canvas-block"),
        ].map((element) => element.getBoundingClientRect());
        const overlaps = blocks.some((a, index) =>
          blocks
            .slice(index + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
            ),
        );
        return {
          workTop: box.top,
          workHeight: box.height,
          visibleWorkHeight: Math.max(
            0,
            Math.min(box.bottom, innerHeight - 50) - box.top,
          ),
          headingSize: getComputedStyle(heading).fontSize,
          headingFont: getComputedStyle(heading).fontFamily,
          workFontSize: getComputedStyle(work).fontSize,
          overflow: document.documentElement.scrollWidth > innerWidth,
          overlaps,
        };
      }, selector);
      expect(metrics.overflow).toBe(false);
      expect(metrics.overlaps).toBe(false);
      expect(metrics.headingFont).toContain("Newsreader Variable");
      expect(metrics.visibleWorkHeight).toBeGreaterThan(
        name === "table" ? 90 : 100,
      );
      if (name === "writing") {
        expect(parseFloat(metrics.headingSize)).toBeGreaterThanOrEqual(42);
        expect(parseFloat(metrics.workFontSize)).toBeGreaterThanOrEqual(20);
        const input = page.getByRole("textbox", {
          name: "A page in progress text",
        });
        await expect(input).toHaveValue(
          composition.blocks[0]!.kind === "text"
            ? composition.blocks[0]!.body
            : "",
        );
      } else {
        expect(parseFloat(metrics.headingSize)).toBeGreaterThanOrEqual(30);
        expect(parseFloat(metrics.headingSize)).toBeLessThanOrEqual(40);
        expect(metrics.workTop).toBeLessThan(
          viewport.width === 1280 ? 375 : 400,
        );
      }
      const directory = resolve(
        process.env.EVE_CONTENT_FIRST_CAPTURE ?? info.outputDir,
      );
      await mkdir(directory, { recursive: true });
      const path = resolve(directory, `${name}-${viewport.width}.png`);
      await page.screenshot({ path, fullPage: false });
      await writeFile(
        resolve(directory, `${name}-${viewport.width}.json`),
        JSON.stringify(metrics, null, 2),
      );
      await info.attach(`${name}-${viewport.width}`, {
        path,
        contentType: "image/png",
      });
      if (name === "design")
        await expect(
          page.getByRole("button", { name: "Add text", exact: true }),
        ).toBeVisible();
      if (name === "photograph")
        await expect(
          page.getByRole("button", { name: "Adjust photo", exact: true }),
        ).toBeVisible();
    });
  }
}
