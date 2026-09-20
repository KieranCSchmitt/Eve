import { describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkbench, type WorkbenchService } from '../../apps/desktop/host/workbench';
import type { DocumentState } from '../../extensions/eve-workbench/src/protocol';

const enabled = process.env.EVE_RUN_WORKBENCH_NATIVE === '1';
describe.skipIf(!enabled)('qualified real code-server workbench', () => {
  it('edits actual dirty buffers with one native undo and preserves inactive/untitled recovery', async () => {
    const temporary = await mkdtemp('/tmp/eve-native-test-');
    const project = path.join(temporary, 'orbit');
    await cp(path.resolve('examples/orbit'), project, { recursive: true });
    const canonicalProject = await realpath(project);
    const file = path.join(canonicalProject, 'eve.project.json');
    const original = await readFile(file, 'utf8');
    let service: WorkbenchService | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      service = await startWorkbench({
        codeServerExecutable: process.env.EVE_CODE_SERVER ?? path.resolve('.runtime/code-server/code-server-4.138.0-macos-arm64/bin/code-server'),
        extensionDirectory: path.resolve('extensions/eve-workbench'), profileDirectory: path.join(temporary, 'profile'), projectRoot: canonicalProject, trustedProject: true,
      });
      browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
      const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
      await service.authenticate({ cookies: { set: async cookie => { await context.addCookies([{ name: cookie.name, value: cookie.value, url: cookie.url, httpOnly: true, sameSite: 'Lax' }]); } } });
      const page = await context.newPage();
      await page.goto(service.url);
      await service.waitUntilConnected();
      const checkpoint = { uri: pathToFileURL(file).toString(), selections: [{ anchor: { line: 2, character: 2 }, active: { line: 2, character: 8 } }], visibleRanges: [{ start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }], viewColumn: 1, version: 0 };
      await service.restoreCheckpoint(checkpoint);
      const before = await service.inspect(file);
      expect(before?.text).toBe(original);
      const changed = original.replace('"#5677FF"', '"#448866"');
      await service.replace(before!, changed, 'native-test-first');
      expect((await service.inspect(file))?.text).toBe(changed);
      expect(await readFile(file, 'utf8')).toBe(original);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      await expect.poll(async () => (await service!.inspect(file))?.text).toBe(original);
      const current = await service.inspect(file);
      await service.replace(current!, changed, 'native-test-second');
      await expect(service.replace(before!, changed, 'native-stale')).rejects.toThrow('STALE_DOCUMENT');
      await service.call('recovery.restore', { uri: 'untitled:previous-note', languageId: 'plaintext', text: 'A recovered unsaved thought.' });
      const dirty = await service.call<DocumentState[]>('dirty.list');
      expect(dirty.some(document => document.uri === checkpoint.uri && document.text === changed)).toBe(true);
      expect(dirty.some(document => document.untitled && document.text === 'A recovered unsaved thought.')).toBe(true);
      await service.restoreCheckpoint(checkpoint);
      expect((await service.inspect(file))?.text).toBe(changed);
      expect((await service.captureCheckpoint())?.selections).toEqual(checkpoint.selections);
      await expect.poll(async () => (await service!.loadRecovery()).length).toBe(2);
      const closeAttempt = service.closeWithPrompt(dirty.map(document => ({ uri: document.uri, version: document.version })));
      await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 10000 });
      expect((await closeAttempt).closed).toBe(false);
      expect((await service.call<DocumentState[]>('dirty.list')).length).toBe(2);
      const saveAttempt = service.saveAll();
      void saveAttempt.catch(() => {});
      await page.locator('.quick-input-widget').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      expect((await saveAttempt).saved).toBe(false);
      expect((await service.call<DocumentState[]>('dirty.list')).some(document => document.untitled)).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(changed);
      const unauthenticated = await fetch(service.url, { redirect: 'manual' });
      expect(unauthenticated.status).toBe(302);
      await page.screenshot({ path: '/tmp/eve-workbench-qualified.png' });
    } finally { await browser?.close(); await service?.close(); await rm(temporary, { recursive: true, force: true }); }
  }, 60000);
});
