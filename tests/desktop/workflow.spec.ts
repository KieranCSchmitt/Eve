import { openInitialSpace } from "./home-helpers";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

let app: ElectronApplication;
let page: Page;
let profile: string;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
async function recall() {
  await page.getByRole('button', { name: 'Find anything', exact: true }).click();
  await expect.poll(() => app.context().pages().some(item => item.url().endsWith('#overlay'))).toBe(true);
  const overlay = app.context().pages().find(item => item.url().endsWith('#overlay'))!;
  await expect(overlay.getByRole('combobox', { name: 'Search tasks' })).toBeVisible();
  return overlay;
}
const launchEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')), EVE_PROFILE_PATH: profile });

test.beforeEach(async () => {
  await mkdir('.runtime', { recursive: true });
  profile = await mkdtemp(path.resolve('.runtime/desktop-test-'));
  const env = launchEnvironment();
  app = await electron.launch({ args: ['.', '--app'], env });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await page.getByRole('heading', { name: 'Make room for focus.' }).waitFor();
});
test.afterEach(async () => { await app?.close(); });

test('real editor, parameter undo, task recall, and durable note preserve the workflow', async ({}, info) => {
  const projectFile = path.join(profile, 'workspaces/orbit/eve.project.json');
  const original = await readFile(projectFile, 'utf8');
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  const projectNote = page.locator('[data-note-task="orbit"]');
  await expect(projectNote).toBeFocused();
  await projectNote.fill('A calmer ending for each focus session.');
  await expect(page.getByText('Saved on this computer', { exact: true })).toBeVisible();
  const savedProjectNote = await page.evaluate(async () => (await window.eve.snapshot()).tasks.find(task => task.id === 'orbit')!.note.body);
  await projectNote.evaluate(element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.setBaseAndExtent(text, 15, text, 3);
  });
  const notebookImage = info.outputPath('native-orbit-notebook.png');
  await writeFile(notebookImage, Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')), 'base64'));
  await info.attach('native-orbit-notebook.png', { path: notebookImage, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.eve.status()), { timeout: 45000 }).toMatchObject({ workbench: 'ready' });
  const code = app.context().pages().find(item => item.url().includes('?folder='))!;
  expect(code).toBeTruthy();
  await expect(code.locator('.view-lines').first()).toContainText('transitionMs');

  await page.getByRole('button', { name: 'Set theme #56836F', exact: true }).click();
  await expect(code.locator('.view-lines').first()).toContainText('#56836F');
  // The host edited the actual buffer; it did not overwrite the user's on-disk file.
  expect(await readFile(projectFile, 'utf8')).toBe(original);
  await page.locator('.change-status').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(code.locator('.view-lines').first()).toContainText('#5677FF');

  await page.getByRole('button', { name: 'Shape the movement', exact: false }).click();
  await page.getByRole('button', { name: 'Balanced', exact: true }).click();
  await page.getByRole('button', { name: 'Use this in Orbit', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveClass(/active/);
  await expect(code.locator('.view-lines').first()).toContainText('0.65');
  await code.locator('.monaco-editor textarea').first().focus();
  await code.keyboard.press(`${mod}+s`);
  await expect.poll(async () => JSON.parse(await readFile(projectFile, 'utf8')).easing).toEqual([0.65, 0, 0.35, 1]);

  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(projectNote).toBeFocused();
  await expect(projectNote).toHaveText('A calmer ending for each focus session.');
  await expect.poll(() => page.evaluate(() => ({ anchor: document.getSelection()?.anchorOffset, head: document.getSelection()?.focusOffset }))).toEqual({ anchor: 15, head: 3 });
  await page.getByRole('button', { name: 'Code', exact: true }).click();

  const overlay = await recall();
  await overlay.getByRole('combobox', { name: 'Search tasks' }).fill('A fresh idea');
  await overlay.getByRole('option', { name: /Make a space for/ }).click();
  const note = page.locator('[data-testid=note-editor]:visible');
  await note.fill('A thought worth keeping across tasks.');
  await page.getByRole('button', { name: 'Rename space', exact: true }).click();
  await page.getByRole('textbox', { name: 'Space title', exact: true }).fill('A brighter idea');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A brighter idea', exact: true })).toBeVisible();
  await expect(note).toBeFocused();
  await expect(note).toHaveText('A thought worth keeping across tasks.');
  await recall();
  await overlay.getByRole('option', { name: /Orbit.*A study timer/ }).click();
  await expect(code.locator('.view-lines').first()).toContainText('0.65');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveClass(/active/);
  await recall();
  await overlay.getByRole('option', { name: /^A brighter idea/ }).click();
  await expect(page.locator('[data-testid=note-editor]:visible')).toHaveText('A thought worth keeping across tasks.');
  await app.close();

  const env = launchEnvironment();
  app = await electron.launch({ args: ['.', '--app'], env });
  page = await app.firstWindow();
  await openInitialSpace(page, "A brighter idea");
  await expect(page.getByRole('heading', { name: 'A brighter idea', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid=note-editor]:visible')).toHaveText('A thought worth keeping across tasks.');
  expect(await page.evaluate(async () => (await window.eve.snapshot()).tasks.find(task => task.id === 'orbit')?.note.body)).toBe(savedProjectNote);
});

test('rapid parameter choices serialize and failed application keeps the learning activity open', async () => {
  await page.getByRole('button', { name: 'Set theme #56836F', exact: true }).click();
  await page.getByRole('button', { name: 'Set theme #C17B5B', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(path.join(profile, 'workspaces/orbit/eve.project.json'), 'utf8')).theme).toBe('#C17B5B');
  await page.getByRole('button', { name: 'Shape the movement', exact: false }).click();
  // Corrupt the project using a test fixture while the UI is preparing a bounded edit.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(profile, 'workspaces/orbit/eve.project.json'), '{ invalid JSON');
  await page.getByRole('button', { name: 'Use this in Orbit', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'A feeling, in motion.' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
});
