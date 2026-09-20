import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import type { SurfaceRequest } from '../../apps/desktop/shared/bridge';

let script: string;
type FixtureWindow = Window & { mountSurface(options: { defer?: boolean; deferHide?: boolean; kind?: string }): void; requests: SurfaceRequest[]; releaseShow(): void; releaseHide(): void };
test.beforeAll(async () => {
  const output = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'video-scroll-fixture.tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { ActivitySurface } from './apps/desktop/renderer/src/components/ActivitySurface';
      window.requests=[];
      window.mountSurface = options => {
        let deferred=false, deferredHide=false;
        window.eve={surface:async request=>{window.requests.push(request);if(options.defer&&request.visible&&!deferred){deferred=true;return new Promise(resolve=>window.releaseShow=()=>resolve({ready:true}));}if(options.deferHide&&!request.visible&&!deferredHide){deferredHide=true;return new Promise(resolve=>window.releaseHide=()=>resolve({ready:true}));}return {ready:true}},hideSurfaces:async()=>{}};
        createRoot(document.getElementById('slot')).render(<ActivitySurface kind={options.kind||'video'} taskId="writing" sourceId="source"/>);
      };
    ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  }); script = output.outputFiles[0]!.text;
});
async function mount(page: Page, options: { defer?: boolean; deferHide?: boolean; kind?: string } = {}) {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.setContent(`<style>body{margin:0;height:1600px}header{height:80px;background:#eee}footer{position:fixed;bottom:0;height:60px;background:#eee;width:100%}#workspace{position:relative;top:0;height:600px;overflow:hidden}#scroller{margin:20px;width:600px;height:500px;overflow:auto;border:2px solid #ddd}#spacer{height:40px}#after{height:1000px}.activity-surface{height:280px;width:400px;background:#def}#draft{position:fixed;right:20px;top:10px}</style><header>Header<input id="draft" aria-label="Draft" value="My writing"/></header><main id="workspace"><div id="scroller"><div id="spacer"></div><div id="slot"></div><div id="after"></div></div></main><footer>Footer</footer>`);
  await page.addScriptTag({ content: script }); await page.getByLabel('Draft').focus();
  await page.evaluate(value => (window as unknown as FixtureWindow).mountSurface(value), options);
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).requests.length)).toBeGreaterThan(0);
}
const requests = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).requests);

test('hides a clipped video through the pause path and restores only the complete slot without stealing focus', async ({ page }) => {
  await mount(page);
  expect((await requests(page)).at(-1)?.visible).toBe(true);
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 80; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(false);
  // Its top is still inside the browser viewport, but the scroll ancestor/header
  // clips it. A viewport-only visibility check would incorrectly keep it open.
  expect((await page.getByTestId('video-surface').boundingBox())!.y).toBeGreaterThan(0);
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 400; });
  expect((await page.getByTestId('video-surface').boundingBox())!.y).toBeLessThan(0);
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 0; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(true);
  expect((await requests(page)).map(request => request.visible)).toEqual([true, false, true]);
  for (const request of await requests(page)) for (const value of Object.values(request.bounds)) expect(value).toBeGreaterThanOrEqual(0);
  await expect(page.getByLabel('Draft')).toBeFocused();
});

test('overflow-ancestor resizing hides the video before it can cover the footer', async ({ page }) => {
  await mount(page);
  await page.locator('#workspace').evaluate(element => { element.style.height = '220px'; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(false);
  await page.locator('#workspace').evaluate(element => { element.style.height = '600px'; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(true);
});

test('keeps a completely visible video at fractional container edges', async ({ page }) => {
  await mount(page);
  await page.addStyleTag({ content: '#scroller{width:600.25px;overflow:hidden}.activity-surface{width:600.25px}' });
  await expect.poll(async () => (await requests(page)).at(-1)?.bounds.width).toBe(600.25);
  expect((await requests(page)).at(-1)?.visible).toBe(true);
  expect((await requests(page)).every(request => request.bounds.x >= 0 && request.bounds.y >= 0)).toBe(true);
});

test('hiding preempts an in-flight native show and its late completion cannot reopen a clipped video', async ({ page }) => {
  await mount(page, { defer: true });
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 80; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(false);
  await page.evaluate(() => (window as unknown as FixtureWindow).releaseShow());
  await expect(page.getByRole('status')).toContainText('Bring the whole video into view');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect((await requests(page)).map(request => request.visible)).toEqual([true, false]);
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 0; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(true);
});

test('leaves preview navigation behavior unchanged', async ({ page }) => {
  await mount(page, { kind: 'preview' });
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 80; });
  await expect.poll(async () => (await requests(page)).length).toBeGreaterThan(1);
  expect((await requests(page)).every(request => request.visible)).toBe(true);
  await expect(page.getByLabel('Draft')).toBeFocused();
});

test('waits for the hide and pause acknowledgement before restoring a quickly returned slot', async ({ page }) => {
  await mount(page, { deferHide: true });
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 80; });
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(false);
  await page.locator('#scroller').evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect((await requests(page)).map(request => request.visible)).toEqual([true, false]);
  await page.evaluate(() => (window as unknown as FixtureWindow).releaseHide());
  await expect.poll(async () => (await requests(page)).at(-1)?.visible).toBe(true);
});
