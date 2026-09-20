import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkbench, type WorkbenchService, type WorkbenchPauseLease } from '../../apps/desktop/host/workbench';

it.skipIf(process.platform !== 'linux' || process.env.EVE_RUN_WORKBENCH_NATIVE !== '1')('pauses an actual code-server terminal writer while preserving live dirty text and native undo', async () => {
  const temporary = await realpath(await mkdtemp('/tmp/eve-pause-service-'));
  const project = path.join(temporary, 'orbit'); await cp(path.resolve('examples/orbit'), project, { recursive: true });
  const file = path.join(project, 'eve.project.json'); const original = await readFile(file, 'utf8');
  let service: WorkbenchService | undefined; let lease: WorkbenchPauseLease | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    service = await startWorkbench({ codeServerExecutable: process.env.EVE_CODE_SERVER ?? path.resolve('.runtime/code-server/code-server-4.138.0-linux-arm64/bin/code-server'), extensionDirectory: path.resolve('extensions/eve-workbench'), profileDirectory: path.join(temporary, 'profile'), projectRoot: project, trustedProject: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await service.authenticate({ cookies: { set: async cookie => { await context.addCookies([{ name: cookie.name, value: cookie.value, url: cookie.url, httpOnly: true, sameSite: 'Lax' }]); } } });
    const page = await context.newPage(); await page.goto(service.url); await service.waitUntilConnected();
    const checkpoint = { uri: pathToFileURL(file).toString(), selections: [{ anchor: { line: 2, character: 2 }, active: { line: 2, character: 8 } }], visibleRanges: [{ start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }], viewColumn: 1, version: 0 };
    await service.restoreCheckpoint(checkpoint);
    const initial = await service.inspect(file); expect(initial).not.toBeNull();
    const changed = original.replace('"#5677FF"', '"#448866"');
    await service.replace(initial!, changed, 'pause-native-edit');
    await page.keyboard.press('F1'); await page.keyboard.insertText('Terminal: Create New Terminal'); await page.keyboard.press('Enter');
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible' });
    await page.keyboard.insertText("node -e 'setInterval(()=>require(\"fs\").appendFileSync(\"heartbeat.txt\",\"x\"),20)'"); await page.keyboard.press('Enter');
    const heartbeat = path.join(project, 'heartbeat.txt');
    await expect.poll(async () => (await readFile(heartbeat).catch(() => Buffer.alloc(0))).length).toBeGreaterThan(2);
    lease = await service.acquireBackupPause({ holdInput: async () => {
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); document.body.inert = true; });
      return { release: async () => { await page.evaluate(() => { document.body.inert = false; }); } };
    } });
    expect(lease.documents.some(document => document.text === changed && document.dirty)).toBe(true);
    const paused = await readFile(heartbeat); await new Promise(resolve => setTimeout(resolve, 150));
    await lease.assertHeld(); expect(await readFile(heartbeat)).toEqual(paused);
    await expect(service.call('files.saveAll')).rejects.toThrow(/WORKBENCH_PAUSED/);
    await lease.renew(); await lease.release(); lease = undefined;
    await expect.poll(async () => (await readFile(heartbeat)).length).toBeGreaterThan(paused.length);
    expect((await service.inspect(file))?.text).toBe(changed);
    await service.restoreCheckpoint(checkpoint); await page.keyboard.press('Control+z');
    await expect.poll(async () => (await service!.inspect(file))?.text).toBe(original);
  } finally {
    await lease?.release().catch(() => {}); await browser.close(); await service?.close(); await rm(temporary, { recursive: true, force: true });
  }
}, 90_000);
