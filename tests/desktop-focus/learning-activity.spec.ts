import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let script: string;
let styles: string;
type ReaderWindow = Window & { mountReader(fail?: boolean): void; readerEvents: { type: string; value: string }[] };

test.beforeAll(async () => {
  const output = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'reader-fixture.tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { LearningActivity } from './apps/desktop/renderer/src/components/LearningActivity';
      const source = {id:'article',taskId:'reading',title:'Animal sleep',url:'https://example.com/sleep',excerpt:'',retrievedAt:1,createdAt:1,provenance:{kind:'web-source',attribution:'User supplied URL',rights:'Publisher retains rights'}};
      window.readerEvents=[];
      window.mountReader = fail => {
        window.eve = {
          lesson:async()=>({sources:[source],sourceId:null,availability:'not-open',checkpoint:null}),
          readSource:async()=>{if(fail)throw new Error('This page needs sign-in.');return {url:source.url,title:source.title,text:'Dogs sleep in several stages. Select this passage to understand it.\\n\\n<script>window.injected = true</script>',retrievedAt:1,truncated:false}},
          openSource:async()=>window.readerEvents.push({type:'open',value:source.id}),
          searchSources:async()=>[],
        };
        createRoot(document.getElementById('root')).render(<LearningActivity taskId="reading" onBack={()=>{}} beforeAttach={async()=>{}} runMutation={operation=>operation()} onSourceContext={()=>{}} onAsk={text=>window.readerEvents.push({type:'ask',value:text})} />);
      };
    ` },
    bundle: true, write: false, outfile: 'reader-fixture.js', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  });
  script = output.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  styles = `${await readFile('apps/desktop/renderer/src/styles.css', 'utf8')}\n${output.outputFiles.find(file => file.path.endsWith('.css'))!.text}\n#root{height:700px;padding:20px}#outside{margin:10px}`;
});

async function mount(page: Page, fail = false) {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent('<input id="outside" aria-label="Your draft" value="Keep my place" /><main id="root"></main>');
  await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: script });
  await page.locator('#outside').focus();
  await page.evaluate(value => (window as unknown as ReaderWindow).mountReader(value), fail);
}

test('reads source text safely and offers help beside a preserved selection without taking draft focus', async ({ page }) => {
  await mount(page);
  const paragraph = page.locator('.article-reader > p').first();
  await expect(paragraph).toHaveText('Dogs sleep in several stages. Select this passage to understand it.');
  await expect(page.getByLabel('Your draft')).toBeFocused();
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  await paragraph.evaluate(element => {
    const selection = window.getSelection()!; const range = document.createRange();
    range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const action = page.getByRole('button', { name: 'Explain this passage' });
  await expect(action).toBeVisible();
  await action.click();
  const events = await page.evaluate(() => (window as unknown as ReaderWindow).readerEvents);
  expect(events).toEqual([{ type: 'ask', value: 'Explain this passage from the attached source “Animal sleep”:\n\n> Dogs sleep in several stages. Select this passage to understand it.' }]);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Dogs sleep in several stages. Select this passage to understand it.');
  await expect(paragraph).toBeVisible();
});

test('keeps an unavailable article and its original source actionable', async ({ page }) => {
  await mount(page, true);
  await expect(page.getByText('This page needs sign-in.')).toBeVisible();
  await page.locator('.article-unavailable').getByRole('button', { name: 'Open original' }).click();
  expect(await page.evaluate(() => (window as unknown as ReaderWindow).readerEvents)).toEqual([{ type: 'open', value: 'article' }]);
});
