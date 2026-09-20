import { openInitialSpace } from "./home-helpers";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IntentResponse } from '../../apps/desktop/shared/bridge';

let app: ElectronApplication;
let page: Page;
let profile: string;

test.beforeEach(async () => {
  await mkdir('.runtime', { recursive: true });
  profile = await mkdtemp(path.resolve('.runtime/desktop-intelligence-'));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')),
    EVE_PROFILE_PATH: profile,
  };
  app = await electron.launch({ args: ['.', '--app'], env });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await page.getByRole('heading', { name: 'Make room for focus.' }).waitFor();
  // A fresh profile starts the actual utility process without configuring a model,
  // injecting an answer, or inheriting credentials from the developer's profile.
  await expect.poll(() => page.evaluate(() => window.eve.intelligenceSettings())).toMatchObject({ state: 'ready', providers: [] });
});

test.afterEach(async ({}, testInfo) => {
  if (!app) return;
  const alreadyFailed = testInfo.status !== testInfo.expectedStatus;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      // Killing only after a shutdown timeout is failure cleanup, never a way
      // for a successful test to bypass the actual close/save lifecycle.
      app.process().kill('SIGKILL');
      reject(new Error('Electron did not shut down cleanly within 15 seconds.'));
    }, alreadyFailed ? 5_000 : 15_000);
  });
  try { await Promise.race([app.close(), deadline]); }
  catch (error) { if (!alreadyFailed) throw error; }
  finally { clearTimeout(timeout); }
});

async function observeIntents() {
  return page.evaluateHandle(() => {
    const responses: IntentResponse[] = [];
    const attention: { taskId: string; activity: string }[] = [];
    const offIntent = window.eve.onIntelligence(event => { if (event.type === 'intent') responses.push(event.response); });
    const offAttention = window.eve.onAttention(target => attention.push(target));
    return { responses, attention, stop() { offIntent(); offAttention(); } };
  });
}

async function openQuestion() {
  await page.getByRole('button', { name: /^(Ask Eve|View response)$/ }).click();
  await expect.poll(() => app.context().pages().some(item => item.url().endsWith('#overlay'))).toBe(true);
  const overlay = app.context().pages().find(item => item.url().endsWith('#overlay'))!;
  await expect(overlay.getByRole('textbox', { name: 'Ask Eve', exact: true })).toBeVisible();
  return overlay;
}

test('a host lock event clears private question UI and a fresh question can be opened after return', async () => {
  const overlay = await openQuestion();
  await overlay.getByRole('textbox', { name: 'Ask Eve', exact: true }).fill('Private unfinished question');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect(overlay.getByRole('textbox', { name: 'Ask Eve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask Eve', exact: true })).toBeVisible();
  await openQuestion();
  await expect(overlay.getByRole('textbox', { name: 'Ask Eve', exact: true })).toHaveValue('');
});

test('the exact show code request opens the real editor without a model provider', async () => {
  const observed = await observeIntents();
  const overlay = await openQuestion();
  await overlay.getByRole('textbox', { name: 'Ask Eve', exact: true }).fill('show code');
  await overlay.getByRole('button', { name: 'Submit question', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.eve.status()), { timeout: 45_000 }).toMatchObject({ workbench: 'ready' });
  await expect.poll(() => app.context().pages().some(item => item.url().includes('?folder='))).toBe(true);
  const editor = app.context().pages().find(item => item.url().includes('?folder='))!;
  await expect(editor.locator('.view-lines').first()).toContainText('transitionMs');
  await expect.poll(() => observed.evaluate(value => value.responses.at(-1))).toMatchObject({ taskId: 'orbit', status: 'complete', message: 'Done.', citations: [], proposals: [] });
  const state = await page.evaluate(() => window.eve.snapshot());
  expect(state.tasks.find(task => task.id === 'orbit')?.checkpoint?.selectedActivity).toBe('code');
  expect(await observed.evaluate(value => value.attention)).toContainEqual(expect.objectContaining({ taskId: 'orbit', activity: 'code' }));
  expect(await observed.evaluate(value => value.responses.some(response => response.provider !== undefined))).toBe(false);
});

test('a novel question reports unavailable honestly and leaves the real artifacts unchanged', async () => {
  const observed = await observeIntents();
  const before = await page.evaluate(() => window.eve.snapshot());
  const projectFile = path.join(profile, 'workspaces/orbit/eve.project.json');
  const original = await readFile(projectFile, 'utf8');
  const overlay = await openQuestion();
  await expect(overlay.getByText(/AI is not set up yet/)).toBeVisible();
  await overlay.getByRole('textbox', { name: 'Ask Eve', exact: true }).fill('Why might a slower transition help someone regain their concentration?');
  await overlay.getByRole('button', { name: 'Submit question', exact: true }).click();

  const response = overlay.getByRole('region', { name: 'Eve response', exact: true });
  await expect(response).toContainText('Unavailable');
  await expect(response).toContainText('AI is unavailable for this space right now. You can keep editing.');
  await expect(response.getByRole('button', { name: 'Apply change', exact: true })).toHaveCount(0);
  await expect.poll(() => observed.evaluate(value => value.responses.at(-1))).toMatchObject({ status: 'unavailable', proposals: [], citations: [] });
  expect(await observed.evaluate(value => value.responses.at(-1)?.provider)).toBeUndefined();
  const after = await page.evaluate(() => window.eve.snapshot());
  expect(after.tasks.find(task => task.id === 'orbit')?.note).toEqual(before.tasks.find(task => task.id === 'orbit')?.note);
  expect(after.tasks.find(task => task.id === 'orbit')?.parameters).toEqual(before.tasks.find(task => task.id === 'orbit')?.parameters);
  expect(await readFile(projectFile, 'utf8')).toBe(original);
  expect(await observed.evaluate(value => value.attention)).toEqual([]);
});

test('native cancellation retires its host-issued request and cannot authorize a change', async () => {
  const observed = await observeIntents();
  const before = await page.evaluate(() => window.eve.snapshot());
  const receipt = await page.evaluate(async () => {
    const receipt = await window.eve.ask({ taskId: 'orbit', text: 'Suggest a clearer structure for this timer project.' });
    await window.eve.cancelIntent(receipt.requestId);
    return receipt;
  });
  await expect.poll(() => observed.evaluate((value, id) => value.responses.filter(response => response.requestId === id).at(-1), receipt.requestId)).toMatchObject({ status: 'cancelled', proposals: [] });
  // Read back host/core state after cancellation without injecting a completion
  // or substituting a fake provider for the native IPC path.
  await page.evaluate(async () => { await window.eve.snapshot(); await window.eve.intelligenceSettings(); });
  expect(await observed.evaluate((value, id) => value.responses.filter(response => response.requestId === id).at(-1)?.status, receipt.requestId)).toBe('cancelled');
  const attemptedApply = await page.evaluate(async requestId => {
    try { await window.eve.applyProposal({ requestId, proposalId: 'never-issued-proposal' }); return 'applied'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, receipt.requestId);
  expect(attemptedApply).toContain('This proposal is not available.');
  const after = await page.evaluate(() => window.eve.snapshot());
  expect(after.tasks.map(task => ({ id: task.id, note: task.note, parameters: task.parameters }))).toEqual(before.tasks.map(task => ({ id: task.id, note: task.note, parameters: task.parameters })));
});

test('a real task switch during capture retires navigation before it can change attention', async () => {
  const observed = await observeIntents();
  const before = await page.evaluate(() => window.eve.snapshot());
  // Send both native IPC requests from one renderer turn. The host's actual
  // mutation queue, core worker, and context capture resolve the race.
  const race = await page.evaluate(async () => {
    const asking = window.eve.ask({ taskId: 'orbit', text: 'show code' }).then(
      receipt => ({ receipt, error: undefined }),
      error => ({ receipt: undefined, error: error instanceof Error ? error.message : String(error) }),
    );
    const changing = window.eve.dispatch({ type: 'RecallTask', taskId: 'photo-walk', requestId: crypto.randomUUID() });
    return { asked: await asking, changed: await changing };
  });
  expect(race.changed.ok).toBe(true);
  if (race.asked.receipt) {
    await expect.poll(() => observed.evaluate((value, id) => value.responses.filter(response => response.requestId === id).at(-1)?.status, race.asked.receipt!.requestId)).toBe('stale');
  } else {
    expect(race.asked.error).toContain('The open space changed.');
  }
  const after = await page.evaluate(() => window.eve.snapshot());
  expect(after.activeTaskId).toBe('photo-walk');
  expect(after.tasks.find(task => task.id === 'orbit')?.checkpoint).toEqual(before.tasks.find(task => task.id === 'orbit')?.checkpoint);
  expect(await observed.evaluate(value => value.attention)).toEqual([]);
});

test('task changes reject stale task input and retired or invented proposal identities', async () => {
  const observed = await observeIntents();
  const old = await page.evaluate(() => window.eve.ask({ taskId: 'orbit', text: 'Explain the relationship between contrast and visual attention.' }));
  await expect.poll(() => observed.evaluate((value, id) => value.responses.filter(response => response.requestId === id).at(-1)?.status, old.requestId)).toBe('unavailable');

  await page.getByRole('button', { name: 'Find anything', exact: true }).click();
  await expect.poll(() => app.context().pages().some(item => item.url().endsWith('#overlay'))).toBe(true);
  const overlay = app.context().pages().find(item => item.url().endsWith('#overlay'))!;
  await overlay.getByRole('option', { name: /Photo walk/ }).click();
  await expect(page.getByRole('heading', { name: 'Photo walk', exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.eve.snapshot());

  const rejected = await page.evaluate(async requestId => {
    const attempt = async (operation: () => Promise<unknown>) => {
      try { await operation(); return 'accepted'; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    return {
      staleQuestion: await attempt(() => window.eve.ask({ taskId: 'orbit', text: 'show code' })),
      oldProposal: await attempt(() => window.eve.applyProposal({ requestId, proposalId: 'never-issued-proposal' })),
      inventedProposal: await attempt(() => window.eve.applyProposal({ requestId: 'never-issued-request', proposalId: 'never-issued-proposal' })),
      staleSource: await attempt(() => window.eve.setSourceContext('orbit', 'never-attached-source')),
    };
  }, old.requestId);
  expect(rejected.staleQuestion).toContain('The open space changed.');
  expect(rejected.oldProposal).toContain('This proposal is not available.');
  expect(rejected.inventedProposal).toContain('This proposal is not available.');
  expect(rejected.staleSource).toContain('Choose a source from this space.');
  const after = await page.evaluate(() => window.eve.snapshot());
  expect(after.activeTaskId).toBe('photo-walk');
  expect(after.tasks.map(task => ({ id: task.id, note: task.note, parameters: task.parameters }))).toEqual(before.tasks.map(task => ({ id: task.id, note: task.note, parameters: task.parameters })));
  expect(await observed.evaluate(value => value.attention)).toEqual([]);
  // No provider means no genuine model proposal can be produced here. Actual
  // issued-proposal revision/expiry races are covered in tests/host/intents.test.ts.
});
