import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

type Fixtures = typeof import('./renderer-fixture');
type FixtureWindow = { RendererFixture: Fixtures; fixture: ReturnType<Fixtures['mountAppFixture']> };
let script: string;
let styles: string;
test.beforeAll(async () => {
  const output = await build({ entryPoints: ['tests/desktop-focus/renderer-fixture.tsx'], bundle: true, write: false,
    outfile: 'home-flow.js', format: 'iife', globalName: 'RendererFixture', jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  script = output.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  styles = await readFile('apps/desktop/renderer/src/styles.css', 'utf8') + '\n' + output.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page, initial: 'home' | 'note' | 'project' = 'home', fail = false) {
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(({initial, fail}) => {
    const w = window as unknown as FixtureWindow;
    w.fixture = w.RendererFixture.mountAppFixture(document.getElementById('root')!, initial, fail, 'linux');
  }, {initial, fail});
  await expect(initial === 'home' ? page.getByTestId('home') : initial === 'note' ? page.locator('[data-note-task="note-a"]') : page.getByTestId('preview-surface')).toBeVisible();
}
const active = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot.activeTaskId);

test('Home has no active surface or task AI and supports real recall and creation', async ({page}) => {
  await mount(page);
  expect(await active(page)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.surfaceCalls)).toEqual([]);
  await expect(page.getByRole('button', {name:'Ask Eve', exact:true})).toHaveCount(0);
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.askSelection());
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.overlay)).toBeNull();
  await page.getByRole('button', {name:'Find your work', exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).fixture.overlay)).toMatchObject({kind:'recall', current:null});
  await page.getByRole('button', {name:'Go home', exact:true}).click();
  await page.getByRole('button', {name:'New space', exact:true}).click();
  await page.getByRole('textbox', {name:'Space title'}).fill('  A quiet idea  ');
  await page.getByRole('button', {name:'Create space', exact:true}).click();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(page.getByRole('heading', {name:'A quiet idea', exact:true})).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.createdTasks)).toBe(1);
});

test('returning Home flushes notes and preserves their actual mounted editor through return', async ({page}) => {
  await mount(page, 'note');
  const editor = page.locator('[data-note-task="note-a"]');
  await editor.fill('A thought that should still be here.');
  await editor.evaluate(element => { (window as unknown as {originalEditor:Element}).originalEditor = element; });
  await page.getByRole('button', {name:'Go home', exact:true}).click();
  await expect(page.getByTestId('home')).toBeVisible();
  expect(await active(page)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(task => task.id === 'note-a')!.note.body)).toContain('A thought that should still be here.');
  await expect(editor).toBeHidden();
  await page.getByRole('button', {name:'Open First idea', exact:true}).click();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText('A thought that should still be here.');
  expect(await editor.evaluate(element => element === (window as unknown as {originalEditor:Element}).originalEditor)).toBe(true);
});

test('an early recall snapshot never mounts the previous activity or saves it as the new project checkpoint', async ({page}) => {
  await mount(page);
  await page.evaluate(() => { (window as unknown as FixtureWindow).fixture.recallAckDelayMs = 800; });
  await page.getByRole('button', {name:'Open Orbit', exact:true}).click();
  await expect.poll(() => active(page)).toBe('project');
  await expect(page.getByTestId('preview-surface')).toBeVisible();
  await expect(page.locator('[data-note-task="project"]')).toHaveCount(0);
  await page.getByRole('button', {name:'Go home', exact:true}).click();
  await expect(page.getByTestId('home')).toBeVisible();
  const checkpoint = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot.tasks.find(task => task.id === 'project')!.checkpoint);
  expect(checkpoint?.selectedActivity).not.toBe('notes');
  await page.getByRole('button', {name:'Open Orbit', exact:true}).click();
  await expect(page.getByTestId('preview-surface')).toBeVisible();
});

test('failed save prevents Home and keeps the unsaved note visible until retry', async ({page}) => {
  await mount(page, 'note', true);
  const editor = page.locator('[data-note-task="note-a"]');
  await editor.fill('Keep this unsaved sentence.');
  await page.getByRole('button', {name:'Return home', exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(editor).toHaveText('Keep this unsaved sentence.');
  expect(await active(page)).toBe('note-a');
  await page.evaluate(() => { (window as unknown as FixtureWindow).fixture.failSaves = false; });
  await page.getByRole('button', {name:'Go home', exact:true}).click();
  await expect(page.getByTestId('home')).toBeVisible();
});

test('desktop settings work on Home without attaching policy to a made-up task', async ({page}) => {
  await mount(page);
  await page.getByRole('button', {name:'Workspace settings', exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).fixture.overlay)).toMatchObject({kind:'system', taskId:null, policy:null});
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.sendAction({type:'system-action', instanceId:state.overlay!.instanceId, taskId:null, action:{type:'mute',muted:true}});
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).fixture.systemActions)).toContainEqual({type:'mute',muted:true});
  expect(await active(page)).toBeNull();
});

test('Home ignores late task attention and supports its keyboard return shortcut', async ({page}) => {
  await mount(page, 'project');
  await page.keyboard.press('Control+Shift+H');
  await expect(page.getByTestId('home')).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).fixture;
    state.publishAttention({taskId:'project', activity:'code', focusLeaseId:'late-focus'});
    state.askSelection();
  });
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('workbench-surface')).toHaveCount(0);
  expect(await active(page)).toBeNull();
  await page.getByRole('button', {name:'Open Orbit', exact:true}).click();
  await expect(page.getByTestId('preview-surface')).toBeVisible();
});

test('a new composition shows its request and a cancellable preparation state instead of the empty invitation', async ({page}, info) => {
  await mount(page);
  await page.getByRole('textbox', {name:'What would you like to make?', exact:true}).fill('Plan a weekend at the coast');
  await page.getByRole('button', {name:'Create with Eve', exact:true}).click();
  const preparation = page.getByTestId('canvas-preparation');
  await expect(preparation).toBeVisible();
  await expect(preparation).toContainText('Plan a weekend at the coast');
  await expect(page.getByRole('heading', {name:'What would you like to make?'})).toHaveCount(0);
  await expect(page.getByRole('textbox', {name:'Describe your canvas'})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('canvas-preparation.png'), fullPage:true});
  await preparation.getByRole('button', {name:'Cancel', exact:true}).click();
  await expect(preparation).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Start with a blank page'})).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.cancelled)).toEqual(['request-1']);
});

test('sources open beside a canvas and closing them keeps the same writing buffer', async ({page}, info) => {
  await mount(page, 'project');
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).fixture;
    fixture.patchTask('project', {canvas:{revision:1,updatedAt:1,document:{version:1,title:'How motion feels',subtitle:'',layout:'focus',blocks:[{id:'draft',kind:'text',title:'',body:'My original thought.',placement:'main',pinned:false,sourceIds:[]}]}}});
    fixture.publishAttention({taskId:'project',activity:'canvas'});
  });
  const writer = page.getByRole('textbox', {name:'Canvas text',exact:true});
  await expect(writer).toHaveValue('My original thought.');
  await writer.evaluate(element => { (window as unknown as {originalWriter:Element}).originalWriter = element; });
  await page.getByRole('button', {name:'Sources',exact:true}).click();
  await expect(page.getByRole('complementary', {name:'Sources beside your work'})).toBeVisible();
  await expect(page.getByTestId('video-surface')).toBeVisible();
  await expect(writer).toBeVisible();
  await expect(page.getByText('This video cannot play inside Eve. Open the original source to watch it.')).toBeVisible();
  await page.screenshot({path:info.outputPath('canvas-source-pane.png'),fullPage:true});
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.openedSources)).toEqual([]);
  await page.getByRole('button', {name:'Close sources',exact:true}).click();
  await expect(page.getByRole('complementary', {name:'Sources beside your work'})).toHaveCount(0);
  expect(await writer.evaluate(element => element === (window as unknown as {originalWriter:Element}).originalWriter)).toBe(true);
  await expect(writer).toHaveValue('My original thought.');
});
