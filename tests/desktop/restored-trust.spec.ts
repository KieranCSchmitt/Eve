import { openInitialSpace } from "./home-helpers";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface TrustObservation { choices: number[]; messages: { message: string; buttons?: string[]; defaultId?: number; cancelId?: number; response: number }[] }
type ObservedGlobal = typeof globalThis & { __eveTrustAcceptance: TrustObservation };
const run = promisify(execFile);
let app: ElectronApplication | undefined;
let page: Page;
let fixtureRoot: string;
let profile: string;
let receiptBytes: Buffer;

// Run fixture creation in the normal Node runtime, independently of Electron's
// SQLite utility process. This uses the real sole writer, backup foundation and
// production relocation composer; no handwritten "restored" flag or DB fixture.
const createFixture = `
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CoreStore} from './packages/core/src/index.ts';
import {ALL_CAPABILITIES} from './packages/contracts/src/index.ts';
import {exportProfileBackup,restoreProfileBackup} from './packages/backup/src/index.ts';
import {relocateEveProfile} from './apps/desktop/host/profile-relocation.ts';
import {ORBIT_STARTER_FILES} from './packages/imports/src/index.ts';
const root=process.env.EVE_TRUST_FIXTURE_ROOT;
const original=path.join(root,'original'), project=path.join(original,'workspaces/orbit');
await mkdir(path.join(project,'src'),{recursive:true,mode:0o700});
// Write the actual reviewed starter bytes before the backup barrier. Do not
// substitute a fixture manifest or relax production metadata/content guards.
for(const relative of ORBIT_STARTER_FILES)await writeFile(path.join(project,relative),await readFile(path.resolve('examples/orbit',relative)),{mode:0o600});
const html=path.join(project,'index.html');
await writeFile(html,(await readFile(html,'utf8')).replace('A little space<br />to focus.','Restored space<br />to focus.'));
const core=new CoreStore({dbPath:path.join(original,'eve.db'),orbitProjectPath:project});
try {
 const photo=core.snapshot().tasks.find(t=>t.id==='photo-walk');
 const saved=core.dispatch({type:'UpdateNote',requestId:'fixture-note',taskId:photo.id,expectedEpoch:photo.epoch,expectedRevision:photo.note.revision,body:'<p>A saved thought from the restored profile.</p>'},{actorId:'fixture-author',origin:'trusted-ui',capabilities:[...ALL_CAPABILITIES]});
 if(!saved.ok)throw new Error('Fixture note was not committed');
 await exportProfileBackup({profileRoot:original,destination:path.join(root,'backup'),versions:{app:'0.1.0',schema:core.diagnostics().schemaVersion},entries:[{path:'workspaces',kind:'project'}],quiesce:async()=>({assertHeld:async()=>{},release:async()=>{}}),backupDatabase:async(file,signal)=>{await core.backupDatabase(file,{signal});}});
 await restoreProfileBackup({backupDirectory:path.join(root,'backup'),destination:path.join(root,'restored'),validateVersions:async v=>v.app==='0.1.0'&&v.schema===core.diagnostics().schemaVersion,relocate:relocateEveProfile});
} finally {core.close();}
`;

test.beforeEach(async () => {
  app = undefined;
  // Keep the source outside the developing repository: workspace file watchers
  // can change file metadata, which the real exporter correctly rejects.
  fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-desktop-restored-trust-')));
  profile = path.join(fixtureRoot, 'restored');
  await run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', createFixture], {
    cwd: process.cwd(), env: { ...process.env, EVE_TRUST_FIXTURE_ROOT: fixtureRoot }, timeout: 30_000,
  });
  receiptBytes = await readFile(path.join(profile, 'restore-receipt.json'));
});

test.afterEach(async ({}, info) => {
  const failed = info.status !== info.expectedStatus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (app) await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { app?.process().kill('SIGKILL'); reject(new Error('Electron restored-profile test did not close cleanly.')); }, failed ? 5_000 : 15_000); }),
    ]);
  } catch (error) { if (!failed) throw error; }
  finally { clearTimeout(timer); await rm(fixtureRoot, { recursive: true, force: true }); }
});

async function launch() {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')), EVE_PROFILE_PATH: profile };
  app = await electron.launch({ args: ['.', '--app'], env });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await expect(page.getByRole('heading', { name: 'Make room for focus.' })).toBeVisible();
  await app.evaluate(({ dialog }) => {
    const observed: TrustObservation = { choices: [1, 0], messages: [] };
    (globalThis as ObservedGlobal).__eveTrustAcceptance = observed;
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = ((...args: Parameters<typeof dialog.showMessageBox>) => {
      const options = args.at(-1) as Electron.MessageBoxOptions;
      // Only the actual user's native choice is substituted. The real menu,
      // receipt inspection, approval write and project launch remain installed.
      if (options.message !== 'Open the restored projects?') return Reflect.apply(original, dialog, args);
      const response = observed.choices.shift();
      if (response === undefined) throw new Error('Unexpected repeated trust decision.');
      observed.messages.push({ message: options.message, buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId, response });
      return Promise.resolve({ response, checkboxChecked: false });
    }) as typeof dialog.showMessageBox;
  });
}

async function reviewProjects() {
  await app!.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items ?? []).find(item => item.label === 'Review restored projects…');
    if (!item) throw new Error('The native restored-project review menu is missing.');
    item.click();
  });
}

async function paused(reason = 'project is paused') {
  await expect.poll(() => page.evaluate(() => window.eve.status())).toMatchObject({ preview: 'error', workbench: 'unconfigured' });
  expect(app!.context().pages().filter(candidate => /^https?:/.test(candidate.url()))).toEqual([]);
  const blocked = await page.evaluate(async () => {
    const bounds = { x: 250, y: 180, width: 640, height: 430 };
    return {
      preview: await window.eve.surface({ kind: 'preview', taskId: 'orbit', visible: true, bounds }),
      workbench: await window.eve.surface({ kind: 'workbench', taskId: 'orbit', visible: true, bounds }),
    };
  });
  expect(blocked.preview).toMatchObject({ ready: false, message: expect.stringContaining(reason) });
  expect(blocked.workbench).toMatchObject({ ready: false, message: expect.stringContaining(reason) });
  expect(await stat(path.join(profile, 'restore-trust.json')).catch(() => undefined)).toBeUndefined();
  expect(await stat(path.join(profile, 'project-trust')).catch(() => undefined)).toBeUndefined();
  expect(await stat(path.join(profile, 'workbench/workbench.lock')).catch(() => undefined)).toBeUndefined();
}

async function recall(name: 'Photo walk' | 'Orbit') {
  await page.getByRole('button', { name: 'Find anything', exact: true }).click();
  await expect.poll(() => app!.context().pages().some(candidate => candidate.url().endsWith('#overlay'))).toBe(true);
  const overlay = app!.context().pages().find(candidate => candidate.url().endsWith('#overlay'))!;
  await overlay.getByRole('option', { name: name === 'Photo walk' ? /Photo walk/ : /Orbit.*A study timer/ }).click();
  await expect(page.getByRole('heading', { name: name === 'Photo walk' ? 'Photo walk' : 'Make room for focus.', exact: true })).toBeVisible();
  await expect(overlay.getByRole('combobox', { name: 'Search tasks' })).toHaveCount(0);
}

async function useNotes(text: string) {
  await recall('Photo walk');
  const note = page.locator('[data-testid=note-editor]:visible');
  await expect(note).toHaveText('A saved thought from the restored profile.');
  await note.fill(text);
  await expect.poll(() => page.evaluate(async () => (await window.eve.snapshot()).tasks.find(task => task.id === 'photo-walk')?.note.body)).toBe(`<p>${text}</p>`);
  // Restored launches must not silently seed the demo picture or mutate source
  // provenance just because this profile differs from a fresh installation.
  expect(await page.evaluate(() => window.eve.assets('photo-walk'))).toEqual([]);
  await recall('Orbit');
}

test('restored projects stay paused through Keep paused while notes work, then explicit trust opens the real restored preview', async ({}, info) => {
  await launch();
  await expect(page.getByTestId('preview-surface')).toContainText('This project is paused. Review and trust its folder before opening code or preview.');
  await paused();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.getByTestId('workbench-surface')).toContainText('This project is paused. Review and trust its folder before opening code or preview.');
  await paused();
  await useNotes('Notes stay editable while restored projects are paused.');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await reviewProjects();
  await expect.poll(() => app!.evaluate(() => (globalThis as ObservedGlobal).__eveTrustAcceptance.messages.length)).toBe(1);
  await paused();
  const choices = await app!.evaluate(() => (globalThis as ObservedGlobal).__eveTrustAcceptance.messages);
  expect(choices[0]).toMatchObject({ buttons: ['Trust and open projects', 'Keep projects paused'], defaultId: 1, cancelId: 1 });
  await reviewProjects();
  await expect.poll(() => app!.evaluate(() => (globalThis as ObservedGlobal).__eveTrustAcceptance.messages.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.eve.status())).toMatchObject({ preview: 'ready', workbench: 'unconfigured' });
  await expect.poll(() => app!.context().pages().some(candidate => /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/$/.test(candidate.url()))).toBe(true);
  const preview = app!.context().pages().find(candidate => /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/$/.test(candidate.url()))!;
  await expect(preview.getByRole('main', { name: 'Orbit study timer' })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Restored space to focus.' })).toBeVisible();
  await preview.getByRole('button', { name: /Begin session/ }).click();
  await expect(preview.getByRole('button', { name: /Take a breath/ })).toBeVisible();
  expect(await readFile(path.join(profile, 'restore-receipt.json'))).toEqual(receiptBytes);
  const approval = JSON.parse(await readFile(path.join(profile, 'restore-trust.json'), 'utf8'));
  expect(approval).toMatchObject({ profileRoot: profile, kind: 'eve-restored-project-approval', scope: 'restored-project-content' });
  const project = await page.evaluate(async () => (await window.eve.snapshot()).tasks.find(task => task.id === 'orbit')?.project);
  expect(project).toMatchObject({ verification: 'verified', canonicalRoot: path.join(profile, 'workspaces/orbit') });
  if (!project) throw new Error('The restored Orbit project has no canonical core record.');
  const rootIdentity = await stat(project.canonicalRoot, { bigint: true });
  const profileIdentity = await stat(profile, { bigint: true });
  expect(project.rootIdentity).toEqual({ device: String(rootIdentity.dev), inode: String(rootIdentity.ino) });
  const scopedApproval = JSON.parse(await readFile(path.join(profile, 'project-trust', createHash('sha256').update(project.id).digest('hex') + '.json'), 'utf8'));
  expect(scopedApproval).toMatchObject({
    kind: 'eve-project-execution-approval',
    profileRoot: profile,
    profileIdentity: { device: String(profileIdentity.dev), inode: String(profileIdentity.ino) },
    restoreReceiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
    project: { id: project.id, revision: project.revision, canonicalRoot: project.canonicalRoot, verification: 'verified', rootIdentity: project.rootIdentity },
  });
  await info.attach('native-restored-trust-decisions.json', { body: JSON.stringify(await app!.evaluate(() => (globalThis as ObservedGlobal).__eveTrustAcceptance.messages)), contentType: 'application/json' });
});

test('a malformed restore receipt blocks project execution while preserving usable notes', async () => {
  const invalid = '{ invalid restore receipt';
  await writeFile(path.join(profile, 'restore-receipt.json'), invalid);
  await launch();
  await paused('restored profile receipt is invalid');
  await useNotes('This note survives even when restore qualification needs repair.');
  await reviewProjects();
  await expect(page.getByRole('alert')).toContainText('restored profile receipt is invalid or unsupported');
  expect(await app!.evaluate(() => (globalThis as ObservedGlobal).__eveTrustAcceptance.messages)).toEqual([]);
  await paused('restored profile receipt is invalid');
  expect(await readFile(path.join(profile, 'restore-receipt.json'), 'utf8')).toBe(invalid);
});
