import { openInitialSpace } from "./home-helpers";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyBackup } from '../../packages/backup/src/index';
import { inspectRestoredProjectTrust } from '../../apps/desktop/host/restored-project-trust';

interface NativeObservation {
  destination: string;
  selectedBackup: string;
  restoreDestination: string;
  messages: { type?: string; message: string; detail?: string }[];
  events: { type: string; instanceId: string; sender: string }[];
}
type ObservedGlobal = typeof globalThis & { __eveBackupAcceptance: NativeObservation };
let app: ElectronApplication;
let page: Page;
let overlay: Page;
let fixtureRoot: string;
let profile: string;
let destination: string;

test.beforeEach(async () => {
  // Keep disposable payloads outside repository/indexer watchers. Canonicalize
  // macOS's temporary-directory symlink; production path guards stay enabled.
  fixtureRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'eve-native-backup-'));
  profile = path.join(fixtureRoot, 'profile');
  destination = path.join(fixtureRoot, 'verified.evebackup');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')),
    EVE_PROFILE_PATH: profile,
  };
  app = await electron.launch({ args: ['.', '--app'], env });
  page = await app.firstWindow();
  await openInitialSpace(page);
  await expect(page.getByRole('heading', { name: 'Make room for focus.' })).toBeVisible();
  await page.getByRole('button', { name: 'Find anything', exact: true }).click();
  await expect.poll(() => app.context().pages().some(item => item.url().endsWith('#overlay'))).toBe(true);
  overlay = app.context().pages().find(item => item.url().endsWith('#overlay'))!;
  await overlay.getByRole('combobox', { name: 'Search tasks' }).fill('Backup continuity');
  await overlay.getByRole('option', { name: /Make a space for/ }).click();
  await expect(page.locator('[data-testid=note-editor]:visible')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.eve.status())).toMatchObject({ workbench: 'unconfigured' });
  await configureNativeDialogs(destination);
});

async function configureNativeDialogs(destination: string, trustProjects = false) {
  await app.evaluate(({ dialog, ipcMain }, { destination, trustProjects }) => {
    const observation: NativeObservation = { destination, selectedBackup: destination, restoreDestination: destination + '-restored', messages: [], events: [] };
    (globalThis as ObservedGlobal).__eveBackupAcceptance = observation;
    const save = dialog.showSaveDialog.bind(dialog);
    const open = dialog.showOpenDialog.bind(dialog);
    const message = dialog.showMessageBox.bind(dialog);
    dialog.showSaveDialog = ((...args: Parameters<typeof dialog.showSaveDialog>) => {
      const options = args.at(-1) as Electron.SaveDialogOptions;
      if (options.title === 'Export Eve backup') return Promise.resolve({ canceled: false, filePath: observation.destination });
      if (options.title === 'Restore into a new workspace') return Promise.resolve({ canceled: false, filePath: observation.restoreDestination });
      return Reflect.apply(save, dialog, args);
    }) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = ((...args: Parameters<typeof dialog.showOpenDialog>) => {
      const options = args.at(-1) as Electron.OpenDialogOptions;
      if (options.title === 'Choose an Eve backup') return Promise.resolve({ canceled: false, filePaths: [observation.selectedBackup] });
      return Reflect.apply(open, dialog, args);
    }) as typeof dialog.showOpenDialog;
    dialog.showMessageBox = ((...args: Parameters<typeof dialog.showMessageBox>) => {
      const options = args.at(-1) as Electron.MessageBoxOptions;
      observation.messages.push({ type: options.type, message: options.message, detail: options.detail });
      if (trustProjects && options.message === 'Open the restored projects?') return Promise.resolve({ response: 0, checkboxChecked: false });
      if (options.message === 'Your Eve backup is saved.') return Promise.resolve({ response: 0, checkboxChecked: false });
      if (options.message === 'Your restored workspace is ready.') return Promise.resolve({ response: 1, checkboxChecked: false });
      if (options.message === 'The workspace could not be restored.') return Promise.resolve({ response: 0, checkboxChecked: false });
      return Reflect.apply(message, dialog, args);
    }) as typeof dialog.showMessageBox;
    // Observation only: the genuine host validation/ready/cancel handlers remain installed.
    ipcMain.on('eve:overlay-event', (event, action: { type?: string; instanceId?: string }) => {
      if (action.type?.startsWith('maintenance-')) observation.events.push({ type: action.type, instanceId: action.instanceId ?? '', sender: event.sender.getURL() });
    });
  }, { destination, trustProjects });
}

test.afterEach(async ({}, info) => {
  if (!app) return;
  const failed = info.status !== info.expectedStatus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { app.process().kill('SIGKILL'); reject(new Error('Electron backup test did not settle and close.')); }, failed ? 5_000 : 15_000); }),
    ]);
  } catch (error) { if (!failed) throw error; }
  finally { clearTimeout(timer); await rm(fixtureRoot, { recursive: true, force: true }); }
});

async function nativeMenu(label: string) {
  await app.evaluate(({ Menu }, label) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.items.flatMap(item => item.submenu?.items ?? []).find(item => item.label === label);
    if (!item) throw new Error(`The native ${label} menu is missing.`);
    item.click();
  }, label);
}
const startExport = () => nativeMenu('Export workspace backup…');

async function realProjectFixture(bytes: number) {
  const file = path.join(profile, 'workspaces/orbit/backup-acceptance.bin');
  const handle = await open(file, 'wx');
  try { await handle.truncate(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return file;
}

async function observeShield() {
  return overlay.evaluateHandle(() => {
    const events: { present: boolean; focused: boolean; coversViewport: boolean }[] = [];
    const record = () => {
      const shield = document.querySelector<HTMLElement>('.maintenance-shield');
      const dialog = shield?.querySelector('[role=dialog]');
      const bounds = shield?.getBoundingClientRect();
      const next = { present: !!shield, focused: !!dialog?.contains(document.activeElement), coversViewport: !!bounds && bounds.x === 0 && bounds.y === 0 && bounds.width === innerWidth && bounds.height === innerHeight };
      if (JSON.stringify(events.at(-1)) !== JSON.stringify(next)) events.push(next);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    record();
    return { events, stop() { observer.disconnect(); } };
  });
}

test('native export publishes a verified profile with real core data and returns input to the note', async ({}, info) => {
  const forge = await page.evaluate(async () => {
    const snapshot = await window.eve.snapshot();
    try {
      await window.eve.setOverlay({ kind: 'maintenance', instanceId: crypto.randomUUID(), taskId: snapshot.activeTaskId!, title: 'Forged maintenance', detail: 'Renderer-created panel', phase: 'working' });
      return 'accepted';
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  expect(forge).toContain('This panel cannot be opened here.');
  await expect(overlay.getByRole('dialog', { name: 'Forged maintenance' })).toHaveCount(0);
  const source = await realProjectFixture(128 * 1024 * 1024);
  await writeFile(path.join(profile, 'workspaces/orbit/.env'), 'ACCEPTANCE_FIXTURE=excluded-not-a-real-secret\n');
  const shield = await observeShield();
  await page.locator('[data-testid=note-editor]:visible').fill('This thought must be in the verified backup.');
  await startExport();
  await expect.poll(() => shield.evaluate(value => value.events.some(event => event.present && event.focused && event.coversViewport))).toBe(true);
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages), { timeout: 60_000 }).toContainEqual({ type: 'info', message: 'Your Eve backup is saved.', detail: destination });
  await expect(overlay.locator('.maintenance-shield')).toHaveCount(0);
  const trace = await app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance);
  expect(trace.events.filter(event => event.type === 'maintenance-ready')).toHaveLength(1);
  expect(trace.events.every(event => event.sender.endsWith('#overlay'))).toBe(true);
  expect(trace.events.some(event => event.type === 'maintenance-cancel')).toBe(false);
  expect((await shield.evaluate(value => value.events)).at(-1)?.present).toBe(false);
  await shield.evaluate(value => value.stop());

  const manifest = await verifyBackup(destination);
  expect(manifest).toMatchObject({ format: 'eve-profile-backup', formatVersion: 1, originalProfileRoot: profile, database: 'eve.db', requiresRelocation: true, credentialsIncluded: false });
  expect(manifest.versions.schema).toBeGreaterThan(0);
  expect(manifest.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'eve.db' }),
    expect.objectContaining({ path: 'workspaces/orbit/backup-acceptance.bin', bytes: 128 * 1024 * 1024 }),
    expect.objectContaining({ path: 'workspaces/orbit/eve.project.json' }),
  ]));
  expect(manifest.files.some(file => file.path.startsWith('storage/assets/'))).toBe(true);
  expect(manifest.exclusions).toContainEqual({ path: 'workspaces/orbit/.env', reason: 'credentials' });
  expect((await readdir(path.join(destination, 'profile'))).filter(name => ['eve.db-wal', 'eve.db-shm', 'intelligence'].includes(name))).toEqual([]);
  const inspectionCopy = path.join(fixtureRoot, 'inspect-backup.db');
  await writeFile(inspectionCopy, await readFile(path.join(destination, 'profile/eve.db')), { mode: 0o600 });
  const database = new DatabaseSync(inspectionCopy, { readOnly: true });
  try {
    expect(database.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    const note = database.prepare('SELECT n.body FROM notes n JOIN tasks t ON t.id=n.task_id WHERE t.title=?').get('Backup continuity');
    expect(note?.body).toBe('<p>This thought must be in the verified backup.</p>');
  } finally { database.close(); }
  expect((await stat(source)).size).toBe(128 * 1024 * 1024);
  await page.locator('[data-testid=note-editor]:visible').fill('Editing works after the genuine backup completes.');
  await expect.poll(() => page.evaluate(async () => { const state = await window.eve.snapshot(); return state.tasks.find(task => task.id === state.activeTaskId)?.note.body; })).toBe('<p>Editing works after the genuine backup completes.</p>');
  const manifestEvidence = info.outputPath('verified-backup-manifest.json');
  const lifecycleEvidence = info.outputPath('native-maintenance-lifecycle.json');
  await writeFile(manifestEvidence, await readFile(path.join(destination, 'manifest.json')));
  await writeFile(lifecycleEvidence, JSON.stringify({ dom: await shield.evaluate(value => value.events), ipc: trace.events }, null, 2));
  await info.attach('verified-backup-manifest.json', { path: manifestEvidence, contentType: 'application/json' });
  await info.attach('native-maintenance-lifecycle.json', { path: lifecycleEvidence, contentType: 'application/json' });
});

test('native backup cancellation during real file IO removes staging and restores editing', async () => {
  const source = await realProjectFixture(512 * 1024 * 1024);
  const shield = await observeShield();
  await page.locator('[data-testid=note-editor]:visible').fill('Cancellation keeps this original thought.');
  await startExport();
  const panel = overlay.getByRole('dialog', { name: 'Keeping your work safe.' });
  await expect(panel).toBeVisible();
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.events.some(event => event.type === 'maintenance-ready'))).toBe(true);
  // Wait for actual staging bytes, not an injected delay or a replaced copier.
  await expect.poll(async () => {
    const stages = (await readdir(fixtureRoot)).filter(name => name.startsWith('.eve-backup-'));
    for (const stage of stages) {
      const copied = await stat(path.join(fixtureRoot, stage, 'profile/workspaces/orbit/backup-acceptance.bin')).catch(() => undefined);
      if (copied && copied.size > 0) return true;
    }
    return false;
  }, { intervals: [20] }).toBe(true);
  // Even trusted presentation code cannot dismiss a host-owned input hold.
  await page.evaluate(() => window.eve.setOverlay(null));
  const instanceId = await app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.events.find(event => event.type === 'maintenance-ready')!.instanceId);
  await overlay.evaluate(instanceId => window.eveOverlay.action({ type: 'close', instanceId }), instanceId);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.events.filter(event => event.type === 'maintenance-cancel').length)).toBe(1);
  expect(await stat(destination).catch(() => undefined)).toBeUndefined();
  await expect.poll(async () => (await readdir(fixtureRoot)).filter(name => name.startsWith('.eve-backup-'))).toEqual([]);
  expect((await stat(source)).size).toBe(512 * 1024 * 1024);
  expect(await app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages)).toEqual([]);
  await page.locator('[data-testid=note-editor]:visible').fill('The original workspace resumes after cancellation.');
  await expect.poll(() => page.evaluate(async () => { const state = await window.eve.snapshot(); return state.tasks.find(task => task.id === state.activeTaskId)?.note.body; })).toBe('<p>The original workspace resumes after cancellation.</p>');
  expect(await shield.evaluate(value => value.events.some(event => event.present && event.focused))).toBe(true);
  await shield.evaluate(value => value.stop());
});

test('native restore relocates a genuine backup into a new untrusted workspace and preserves both originals', async ({}, info) => {
  const originalProject = await readFile(path.join(profile, 'workspaces/orbit/eve.project.json'));
  await page.locator('[data-testid=note-editor]:visible').fill('An original thought for the restored workspace.');
  await startExport();
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages.some(message => message.message === 'Your Eve backup is saved.'))).toBe(true);
  const backup = await verifyBackup(destination);
  const originalManifest = await readFile(path.join(destination, 'manifest.json'));
  const before = await page.evaluate(() => window.eve.snapshot());
  const shield = await observeShield();
  const restored = destination + '-restored';
  await nativeMenu('Restore backup into new workspace…');
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages.some(message => message.message === 'Your restored workspace is ready.')), { timeout: 30_000 }).toBe(true);
  await expect(overlay.locator('.maintenance-shield')).toHaveCount(0);
  expect(await shield.evaluate(value => value.events.some(event => event.present && event.focused && event.coversViewport))).toBe(true);
  await shield.evaluate(value => value.stop());
  const receiptText = await readFile(path.join(restored, 'restore-receipt.json'));
  const receipt = JSON.parse(receiptText.toString('utf8')) as { version: number; backupId: string; versions: unknown; requiresApplicationQualification: boolean; relocation: { validated: boolean; changedFiles: string[]; notes: string[] }; files: { path: string; bytes: number; sha256: string }[] };
  expect(receipt).toMatchObject({ version: 1, backupId: backup.id, versions: backup.versions, requiresApplicationQualification: true, relocation: { validated: true } });
  expect(receipt.relocation.changedFiles).toContain('eve.db');
  for (const file of receipt.files) {
    const bytes = await readFile(path.join(restored, file.path));
    expect(bytes.length).toBe(file.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
  const database = new DatabaseSync(path.join(restored, 'eve.db'), { readOnly: true });
  try {
    expect(database.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    const project = backup.versions.schema >= 4
      ? database.prepare('SELECT p.canonical_root AS project_path FROM projects p JOIN task_projects b ON b.project_id=p.id WHERE b.task_id=?').get('orbit')
      : database.prepare('SELECT project_path FROM tasks WHERE id=?').get('orbit');
    expect(project?.project_path).toBe(path.join(restored, 'workspaces/orbit'));
    expect(database.prepare('SELECT n.body FROM notes n JOIN tasks t ON t.id=n.task_id WHERE t.title=?').get('Backup continuity')?.body).toBe('<p>An original thought for the restored workspace.</p>');
    const assets = database.prepare('SELECT data FROM assets').all().map(row => JSON.parse(String(row.data)) as { managedPath: string; sha256: string });
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(asset.managedPath.startsWith(path.join(restored, 'storage/assets') + path.sep)).toBe(true);
      expect(createHash('sha256').update(await readFile(asset.managedPath)).digest('hex')).toBe(asset.sha256);
    }
  } finally { database.close(); }
  expect(await inspectRestoredProjectTrust(restored)).toMatchObject({ restored: true, trusted: false });
  expect(await stat(path.join(restored, 'restore-trust.json')).catch(() => undefined)).toBeUndefined();
  expect(await readFile(path.join(destination, 'manifest.json'))).toEqual(originalManifest);
  expect(await verifyBackup(destination)).toEqual(backup);
  expect(await readFile(path.join(profile, 'workspaces/orbit/eve.project.json'))).toEqual(originalProject);
  const after = await page.evaluate(() => window.eve.snapshot());
  expect(after.activeTaskId).toBe(before.activeTaskId);
  expect(after.tasks.map(task => ({ id: task.id, note: task.note, projectPath: task.projectPath }))).toEqual(before.tasks.map(task => ({ id: task.id, note: task.note, projectPath: task.projectPath })));
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await page.locator('[data-testid=note-editor]:visible').fill('Still working in the original workspace.');
  await expect.poll(() => page.evaluate(async () => { const state = await window.eve.snapshot(); return state.tasks.find(task => task.id === state.activeTaskId)?.note.body; })).toBe('<p>Still working in the original workspace.</p>');
  const evidence = info.outputPath('native-restore-receipt.json');
  await writeFile(evidence, receiptText);
  await info.attach('native-restore-receipt.json', { path: evidence, contentType: 'application/json' });

  // Corrupt a separate copy of the backup, preserving the original verified one.
  const corrupt = path.join(fixtureRoot, 'corrupt.evebackup');
  const failedRestore = path.join(fixtureRoot, 'refused-restore');
  await cp(destination, corrupt, { recursive: true });
  await writeFile(path.join(corrupt, 'manifest.json'), '{ "tampered": true }\n');
  await app.evaluate(({}, config) => { Object.assign((globalThis as ObservedGlobal).__eveBackupAcceptance, config); }, { selectedBackup: corrupt, restoreDestination: failedRestore });
  await nativeMenu('Restore backup into new workspace…');
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages.find(message => message.message === 'The workspace could not be restored.'))).toMatchObject({ type: 'error', detail: 'Backup manifest checksum mismatch.' });
  await expect(overlay.locator('.maintenance-shield')).toHaveCount(0);
  expect(await stat(failedRestore).catch(() => undefined)).toBeUndefined();
  expect((await readdir(fixtureRoot)).filter(name => name.startsWith('.eve-backup-'))).toEqual([]);
  expect(await readFile(path.join(corrupt, 'manifest.json'), 'utf8')).toBe('{ "tampered": true }\n');
  expect(await verifyBackup(destination)).toEqual(backup);
  await page.locator('[data-testid=note-editor]:visible').fill('A refused restore also leaves editing available.');
  await expect.poll(() => page.evaluate(async () => { const state = await window.eve.snapshot(); return state.tasks.find(task => task.id === state.activeTaskId)?.note.body; })).toBe('<p>A refused restore also leaves editing available.</p>');
});

test('an actual preview load completing during maintenance stays hidden and returns after release', async ({}, info) => {
  // A genuinely restored profile lets the route be installed before any project
  // preview exists. No core, backup, renderer or native-view method is replaced.
  await startExport();
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages.some(message => message.message === 'Your Eve backup is saved.'))).toBe(true);
  await nativeMenu('Restore backup into new workspace…');
  await expect.poll(() => app.evaluate(() => (globalThis as ObservedGlobal).__eveBackupAcceptance.messages.some(message => message.message === 'Your restored workspace is ready.'))).toBe(true);
  await app.close();
  profile = destination + '-restored';
  destination = path.join(fixtureRoot, 'race.evebackup');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')),
    EVE_PROFILE_PATH: profile,
  };
  app = await electron.launch({ args: ['.', '--app'], env });
  page = await app.firstWindow();
  await openInitialSpace(page, "Backup continuity");
  await expect(page.getByRole('heading', { name: 'Backup continuity', exact: true })).toBeVisible();
  await configureNativeDialogs(destination, true);
  await realProjectFixture(512 * 1024 * 1024);
  await page.getByRole('button', { name: 'Find anything', exact: true }).click();
  await expect.poll(() => app.context().pages().some(candidate => candidate.url().endsWith('#overlay'))).toBe(true);
  overlay = app.context().pages().find(candidate => candidate.url().endsWith('#overlay'))!;
  await overlay.getByRole('option', { name: /Orbit.*A study timer/ }).click();
  await expect(page.getByTestId('preview-surface')).toContainText('This project is paused. Review and trust its folder before opening code or preview.');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let capturedUrl: string | undefined;
  let first = true;
  await app.context().route(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/, async route => {
    if (!first) { await route.continue(); return; }
    first = false;
    const actualResponse = await route.fetch();
    capturedUrl = route.request().url();
    await held;
    await route.fulfill({ response: actualResponse });
  });
  try {
    const existingPages = new Set(app.context().pages());
    await nativeMenu('Review restored projects…');
    await expect.poll(() => capturedUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const url = capturedUrl!;
    await startExport();
    const panel = overlay.getByRole('dialog', { name: 'Keeping your work safe.' });
    await expect(panel).toBeVisible();
    await expect.poll(async () => {
      for (const stage of (await readdir(fixtureRoot)).filter(name => name.startsWith('.eve-backup-'))) {
        const copied = await stat(path.join(fixtureRoot, stage, 'profile/workspaces/orbit/backup-acceptance.bin')).catch(() => undefined);
        if (copied && copied.size > 0) return true;
      }
      return false;
    }, { intervals: [20] }).toBe(true);
    release();
    // Electron's page event is delivered only once the held first document can
    // commit; the real native view already exists while its request is held.
    await expect.poll(() => app.context().pages().some(candidate => !existingPages.has(candidate))).toBe(true);
    const preview = app.context().pages().find(candidate => !existingPages.has(candidate))!;
    await preview.waitForLoadState('load');
    await expect(page.getByTestId('preview-surface')).toContainText(/resume/);
    const during = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => ({ visible: view.getVisible(), url: (view as Electron.WebContentsView).webContents?.getURL() ?? '' })));
    expect(during.find(view => view.url === url)?.visible).toBe(false);
    expect(during.find(view => view.url.endsWith('#overlay'))?.visible).toBe(true);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => (view as Electron.WebContentsView).webContents?.getURL() === url && view.getVisible()), url)).toBe(true);
    await expect(preview.getByRole('main', { name: 'Orbit study timer' })).toBeVisible();
    const evidence = info.outputPath('native-surface-maintenance-race.json');
    await writeFile(evidence, JSON.stringify({ during, returnedPreview: true }, null, 2));
    await info.attach('native-surface-maintenance-race.json', { path: evidence, contentType: 'application/json' });
  } finally {
    release();
    await app.context().unrouteAll({ behavior: 'wait' });
  }
});
