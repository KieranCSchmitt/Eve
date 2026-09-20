import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { CanvasSuggestion } from "../../apps/desktop/renderer/src/components/CanvasSuggestions";

type SuggestionWindow = Window & {
  mountSuggestions(suggestions: CanvasSuggestion[], compact: boolean): void;
  updateSuggestions(suggestions: CanvasSuggestion[]): void;
  disableSuggestions(disabled: boolean): void;
  chosenSuggestions: CanvasSuggestion[];
};

const first: CanvasSuggestion = {
  id: "compare",
  label: "Compare the two routes",
  description: "Put travel time and distance side by side.",
  request: "Create a comparison of the two routes using the saved source material.",
  targetBlockId: null,
};
const second: CanvasSuggestion = {
  id: "list",
  label: "Make a packing list",
  description: "Bring the things you’ll need for this walk.",
  request: "Add a packing checklist for this walk.",
  targetBlockId: "walk",
};
let script: string;
let styles: string;

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import { StrictMode, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { CanvasSuggestions } from './apps/desktop/renderer/src/components/CanvasSuggestions';
        window.chosenSuggestions = [];
        function Fixture({initial,compact}) {
          const [suggestions,setSuggestions] = useState(initial);
          const [disabled,setDisabled] = useState(false);
          window.updateSuggestions = setSuggestions;
          window.disableSuggestions = setDisabled;
          return <><textarea aria-label="Your draft" defaultValue="Keep this thought." />
            <CanvasSuggestions suggestions={suggestions} compact={compact} disabled={disabled}
              onChoose={suggestion => window.chosenSuggestions.push(suggestion)} /></>;
        }
        window.mountSuggestions = (initial,compact) => createRoot(document.getElementById('root')).render(
          <StrictMode><Fixture initial={initial} compact={compact}/></StrictMode>);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "suggestion-fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = output.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  styles = await readFile("apps/desktop/renderer/src/styles.css", "utf8") +
    output.outputFiles.find(file => file.path.endsWith(".css"))!.text;
});

async function mount(page: Page, compact = false, suggestions = [first, second]) {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent('<div id="root" style="padding:32px;max-width:900px"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(({ suggestions, compact }) => {
    (window as unknown as SuggestionWindow).mountSuggestions(suggestions, compact);
  }, { suggestions, compact });
  await expect(page.getByRole("textbox", { name: "Your draft" })).toBeVisible();
}

test("suggestions send the complete request only after explicit pointer or keyboard activation", async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => (window as unknown as SuggestionWindow).chosenSuggestions)).toEqual([]);
  const compare = page.getByRole("button", { name: first.label, exact: true });
  await expect(compare).toHaveAccessibleDescription(first.description);
  await compare.click();
  const packing = page.getByRole("button", { name: second.label, exact: true });
  await packing.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as unknown as SuggestionWindow).chosenSuggestions)).toEqual([first, second]);
});

test("dismissal persists across identical refreshes but revised suggestions resurface", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: `Dismiss suggestion: ${first.label}`, exact: true }).click();
  await expect(page.getByRole("button", { name: first.label, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: second.label, exact: true })).toBeFocused();
  await page.evaluate(suggestions => (window as unknown as SuggestionWindow).updateSuggestions(suggestions), [first, second]);
  await expect(page.getByRole("button", { name: first.label, exact: true })).toHaveCount(0);
  const revised = { ...first, request: "Compare the routes and include their accessibility details." };
  await page.evaluate(suggestions => (window as unknown as SuggestionWindow).updateSuggestions(suggestions), [revised, second]);
  await expect(page.getByRole("button", { name: first.label, exact: true })).toBeVisible();
  await page.getByRole("button", { name: first.label, exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as SuggestionWindow).chosenSuggestions)).toEqual([revised]);
});

test("dismissing the last suggestion preserves keyboard continuity and can be undone", async ({ page }) => {
  await mount(page, true, [first]);
  const dismiss = page.getByRole("button", { name: `Dismiss suggestion: ${first.label}`, exact: true });
  await dismiss.focus();
  await page.keyboard.press("Space");
  const restore = page.getByRole("button", { name: "Show hidden suggestion", exact: true });
  await expect(restore).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: first.label, exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as SuggestionWindow).chosenSuggestions)).toEqual([]);
});

test("updates do not steal editing focus or selection and pending suggestions are disabled", async ({ page }) => {
  await mount(page);
  const draft = page.getByRole("textbox", { name: "Your draft" });
  await draft.focus();
  await draft.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 9, "backward"));
  const revised = { ...first, description: "Compare distance, travel time, and access." };
  await page.evaluate(suggestions => (window as unknown as SuggestionWindow).updateSuggestions(suggestions), [revised]);
  await expect(draft).toBeFocused();
  expect(await draft.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([5, 9, "backward"]);
  await page.evaluate(() => (window as unknown as SuggestionWindow).disableSuggestions(true));
  await expect(page.getByRole("button", { name: first.label, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: `Dismiss suggestion: ${first.label}`, exact: true })).toBeDisabled();
  await expect(page.getByText("Available when this space is ready.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as SuggestionWindow).chosenSuggestions)).toEqual([]);
});

test("compact callouts fit narrow sidebars and respect reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, true, [{ ...first, label: "Compare the accessibility and distance of both routes through the riverside", description: "Use the saved references to show how each route differs, with a clear source for every detail." }]);
  await page.setViewportSize({ width: 330, height: 700 });
  const region = page.getByRole("region", { name: "Suggested next steps" });
  await expect(region).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".canvas-suggestion").evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(.001);
  await expect(page.getByRole("button", { name: /Dismiss suggestion:/ })).toBeVisible();
});
