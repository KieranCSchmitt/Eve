import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { startMediaPlayer } from '../../packages/media/src/bridge';
import { resolveYouTubeSource } from '../../packages/media/src/youtube';
import { CHROME_ANIMATION_LESSON } from '../../packages/media/src/sources';

const source = resolveYouTubeSource(CHROME_ANIMATION_LESSON.url);
if (!source.supported) throw new Error('Fixture source must be valid');
const scope = { taskId: 'orbit', taskEpoch: 1, generation: 1, sourceId: 'lesson' };
const executablePath = process.env.EVE_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

it.skipIf(process.env.EVE_RUN_MEDIA_BROWSER !== '1')('executes the generated browser controller against a deterministic IFrame API test double', async () => {
  const player = await startMediaPlayer({ source: source.source, scope, title: CHROME_ANIMATION_LESSON.title, appId: 'org.eve.Shell' });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 760, height: 490 } });
    await context.route('https://www.youtube.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>IFrame API test double</h1>' }));
    await context.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'application/javascript', body: `
      window.YT = {Player: class {
        constructor(id, options) { this.options=options; this.time=0; this.state=-1; this.video='lVLzkleL_CE'; window.testPlayer=this; setTimeout(()=>options.events.onReady(),5); }
        getVideoUrl(){return 'https://www.youtube.com/watch?v='+this.video}
        getCurrentTime(){return this.time} getDuration(){return 90} getPlayerState(){return this.state}
        changed(){this.options.events.onStateChange({data:this.state})}
        cueVideoById(value){this.time=value.startSeconds;this.state=5;this.changed()}
        playVideo(){this.state=1;this.time+=5;this.changed()}
        pauseVideo(){setTimeout(()=>{this.state=2;this.changed()},80)}
        seekTo(time){this.time=time;this.changed()} destroy(){}
      }}; window.onYouTubeIframeAPIReady();` }));
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(player.url);
    await expect.poll(() => ({ status: player.availability, errors })).toEqual({ status: 'ready', errors: [] });
    expect(player.checkpoint!.snapshot.playbackState).toBe('cued');
    const playing = await player.send({ type: 'play', intent: 'explicit-user', visible: true });
    expect(playing.snapshot.playbackState).toBe('playing');
    const captured = await player.captureContext({ selection: { artifactId: 'config', revision: 2, text: 'easing' } });
    expect(captured.context.media).toEqual({ videoId: 'lVLzkleL_CE', currentTime: 5, state: 'paused' });
    const sought = await player.send({ type: 'seek', seconds: 23 });
    expect(sought.snapshot.currentTime).toBe(23);
    expect(sought.snapshot.playbackState).toBe('paused');
    await page.evaluate(() => { const test = (window as unknown as { testPlayer: { video: string; changed(): void } }).testPlayer; test.video = '8FuafvJLDpM'; test.changed(); });
    await expect.poll(() => player.availability).toBe('source-changed');
    expect(player.checkpoint!.snapshot.videoId).toBe('lVLzkleL_CE');
    expect(errors).toEqual([]);
  } finally { await browser.close(); await player.close(); }
}, 30000);

/** Live qualification is explicit; a network, authentication or embedding failure fails this gate. */
it.skipIf(process.env.EVE_RUN_MEDIA_NATIVE !== '1')('qualifies actual official playback, paused capture and seek in Chrome', async () => {
  const events: string[] = [];
  const candidate = resolveYouTubeSource(process.env.EVE_MEDIA_QUALIFY_URL ?? CHROME_ANIMATION_LESSON.url);
  if (!candidate.supported) throw new Error(candidate.reason);
  const player = await startMediaPlayer({ source: candidate.source, scope, title: 'Official lesson qualification', appId: 'org.eve.Shell', onEvent: event => { events.push(JSON.stringify(event)); } });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 760, height: 490 } });
    await context.route('https://www.youtube.com/embed/**', route => route.continue({ headers: { ...route.request().headers(), Referer: player.referer } }));
    const page = await context.newPage();
    page.on('pageerror', error => events.push(`pageerror: ${error.message}`));
    await page.goto(player.url);
    await expect.poll(() => player.availability, { timeout: 25000 }).toBe('ready');
    await page.screenshot({ path: '/tmp/eve-media-live.png' });
    const playing = await player.send({ type: 'play', intent: 'explicit-user', visible: true });
    expect(playing.snapshot.playbackState).toBe('playing');
    const captured = await player.captureContext();
    expect(captured.context.media!.state).toBe('paused');
    const sought = await player.send({ type: 'seek', seconds: 15 });
    expect(sought.snapshot.playbackState).toBe('paused');
    expect(Math.abs(sought.snapshot.currentTime - 15)).toBeLessThan(1.5);
  } finally {
    console.info('Official player qualification events:', events.join('\n'));
    await browser.close(); await player.close();
  }
}, 45000);
