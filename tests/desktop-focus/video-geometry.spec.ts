import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { generatePlayerDocument } from '../../packages/media/src/document';
import { resolveYouTubeSource } from '../../packages/media/src/youtube';

let script: string;
let styles: string;
type VideoFixtureWindow = Window & { mountVideo(pane: boolean): void; videoBounds: Array<{ width: number; height: number }> };
test.beforeAll(async () => {
  const output = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'video-geometry-fixture.tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import './apps/desktop/renderer/src/components/Canvas.css';
      import { LearningActivity } from './apps/desktop/renderer/src/components/LearningActivity';
      // Match main.tsx: global CSS is loaded after the component styles.
      import './apps/desktop/renderer/src/styles.css';
      const source={id:'video',taskId:'reading',title:'Official video',url:'https://www.youtube.com/watch?v=lVLzkleL_CE',excerpt:'',retrievedAt:1,createdAt:1,provenance:{kind:'web-source',attribution:'User URL',rights:'Original source'}};
      window.videoBounds=[];
      window.eve={lesson:async()=>({sources:[source],sourceId:'video',availability:'ready',checkpoint:null}),surface:async request=>{window.videoBounds.push(request.bounds);return {ready:true}},hideSurfaces:async()=>{},searchSources:async()=>[]};
      window.mountVideo = pane => createRoot(document.getElementById('root')).render(<aside className={pane?'canvas-source-pane':'standalone-video'} style={{width:pane?440:700,maxWidth:'100%',height:pane?'auto':450,display:'flex',flexDirection:'column'}}><LearningActivity taskId="reading" onBack={()=>{}} beforeAttach={async()=>{}} runMutation={operation=>operation()} onSourceContext={()=>{}} /></aside>);
    ` }, bundle: true, write: false, outfile: 'video-geometry.js', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  });
  script = output.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  styles = output.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});

for (const width of [1440, 1024, 800]) for (const pane of [true, false]) {
  test(`video ${pane ? 'source pane' : 'standalone'} at ${width}px reserves an official player and its footer`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 940 });
    await page.setContent('<main id="root"></main>'); await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: script });
    await page.evaluate(value => (window as unknown as VideoFixtureWindow).mountVideo(value), pane);
    const surface = page.getByTestId('video-surface'); await expect(surface).toBeVisible();
    const bounds = await surface.boundingBox();
    expect(bounds).not.toBeNull();
    await expect.poll(() => page.evaluate(() => (window as unknown as VideoFixtureWindow).videoBounds.length)).toBeGreaterThan(0);
    const delivered = await page.evaluate(() => (window as unknown as VideoFixtureWindow).videoBounds.at(-1));
    await info.attach('geometry.json', { body: JSON.stringify({ width, pane, bounds, delivered }), contentType: 'application/json' });
    expect(bounds!.height).toBeGreaterThanOrEqual(280);
    expect(bounds!.width).toBeGreaterThanOrEqual(200);
    expect(delivered!.height).toBeGreaterThanOrEqual(280);

    // Use the actual generated document's CSS, with network/script execution
    // disabled. This qualifies geometry only, never YouTube playback.
    const source = resolveYouTubeSource('https://www.youtube.com/watch?v=lVLzkleL_CE');
    if (!source.supported) throw new Error(source.reason);
    const document = generatePlayerDocument({ source: source.source, scope: { taskId: 'reading', taskEpoch: 1, sourceId: 'video', generation: 1 }, title: 'Official video', appId: 'org.eve.Shell', url: `http://127.0.0.1:1234/${'a'.repeat(48)}/` });
    await page.route('**/*', route => route.abort());
    await page.setViewportSize({ width: Math.floor(bounds!.width), height: Math.floor(bounds!.height) });
    await page.setContent(document.html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));
    await page.locator('#status').evaluate(element => { element.textContent = 'Connection to Eve was lost. Playback is paused.'; });
    const iframe = await page.locator('iframe').boundingBox(); const footer = await page.locator('footer').boundingBox();
    expect(iframe!.height).toBeGreaterThanOrEqual(200); expect(iframe!.width).toBeGreaterThanOrEqual(200);
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(Math.floor(bounds!.height));
  });
}
