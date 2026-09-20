import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { startWorkbench, type WorkbenchService } from '../../apps/desktop/host/workbench';
import type { DocumentState } from '../../extensions/eve-workbench/src/protocol';

it.skipIf(process.env.EVE_RUN_WORKBENCH_NATIVE !== '1')('requires real orphan recovery before acknowledging an edit, retries persistence without editing twice, and preserves one native undo', async () => {
  const temporary = await realpath(await mkdtemp('/tmp/eve-durable-native-'));
  const project = path.join(temporary, 'orbit');
  await cp(path.resolve('examples/orbit'), project, { recursive: true });
  const profile = path.join(temporary, 'profile');
  const recoveryDirectory = path.join(profile, 'recovery');
  const file = path.join(project, 'eve.project.json');
  const original = await readFile(file, 'utf8');
  let service: WorkbenchService | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const options = {
    codeServerExecutable: process.env.EVE_CODE_SERVER ?? path.resolve(`.runtime/code-server/code-server-4.138.0-${process.platform === 'darwin' ? 'macos' : 'linux'}-arm64/bin/code-server`),
    extensionDirectory: path.resolve('extensions/eve-workbench'), profileDirectory: profile, projectRoot: project, trustedProject: true,
  };
  try {
    service = await startWorkbench(options);
    browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext();
    await service.authenticate({ cookies: { set: async cookie => { await context.addCookies([{ name: cookie.name, value: cookie.value, url: cookie.url, httpOnly: true, sameSite: 'Lax' }]); } } });
    const page = await context.newPage(); await page.goto(service.url); await service.waitUntilConnected();
    const uri = pathToFileURL(file).href;
    await service.restoreCheckpoint({ uri, selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }], visibleRanges: [], viewColumn: 1, version: 0 });
    const before = (await service.inspect(file))!;
    const changed = original.replace('"#5677FF"', '"#446688"');
    expect(changed).not.toBe(original);
    // The real extension's private-path validation makes persistence fail after native application.
    await chmod(recoveryDirectory, 0o755);
    await expect(service.replace(before, changed, 'durable-native-edit')).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    const applied = (await service.inspect(file))!;
    expect(applied.text).toBe(changed);
    expect(applied.version).toBeGreaterThan(before.version);
    expect(await readFile(file, 'utf8')).toBe(original);

    await chmod(recoveryDirectory, 0o700);
    const retried = await service.replace(before, changed, 'durable-native-edit');
    expect(retried).toEqual(applied);
    const owner = JSON.parse(await readFile(path.join(profile, 'workbench-owner.json'), 'utf8'));
    // No polling or extra capture request: this must exist when edit.apply acknowledges.
    const durable = JSON.parse(await readFile(path.join(recoveryDirectory, `orphan-${owner.instance}.json`), 'utf8'));
    expect(durable.documents).toEqual(expect.arrayContaining([expect.objectContaining({ uri, text: changed, version: applied.version, hash: applied.hash })]));

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect.poll(async () => (await service!.inspect(file))?.text).toBe(original);
    const undo = (await service.inspect(file))!;
    const duplicate = await service.call<{ synchronized: boolean; documents: DocumentState[] }>('edit.apply', {
      operationId: 'durable-native-edit', documents: [{ uri, expectedVersion: before.version, expectedHash: before.hash, text: changed }],
    });
    expect(duplicate.synchronized).toBe(false);
    expect((await service.inspect(file))!).toEqual(undo);

    const olderText = 'An older pending draft is still awaiting review.';
    const older = JSON.stringify({ version: 1, capturedAt: Date.now(), projectRoot: project, documents: [{ uri: 'untitled:older', version: 1, text: olderText, hash: createHash('sha256').update(olderText).digest('hex'), languageId: 'plaintext', dirty: true, untitled: true, bytes: Buffer.byteLength(olderText), diskHash: null }] });
    await writeFile(path.join(recoveryDirectory, 'pending-123-abcd.json'), older, { mode: 0o600 });
    await writeFile(path.join(recoveryDirectory, 'unknown.snapshot'), 'Unreviewed original', { mode: 0o600 });
    await service.replace(undo, changed, 'saved-before-close');
    expect((await service.saveAll()).saved).toBe(true);
    expect(await service.captureDurableRecovery()).toEqual([]);
    // No timer wait: the explicit capture must replace this run's own dirty orphan before stop.
    expect(JSON.parse(await readFile(path.join(recoveryDirectory, `orphan-${owner.instance}.json`), 'utf8')).documents).toEqual([]);
    await service.close();
    expect(await readFile(file, 'utf8')).toBe(changed);
    service = await startWorkbench(options);
    const reopened = await service.loadRecoveryBatch();
    expect(reopened.documents.map(document => document.text)).toEqual([olderText]);
    expect(reopened.unrecognizedFiles).toContain('unknown.snapshot');
    expect(await readFile(path.join(recoveryDirectory, 'pending-123-abcd.json'), 'utf8')).toBe(older);
    expect(await readFile(path.join(recoveryDirectory, 'unknown.snapshot'), 'utf8')).toBe('Unreviewed original');
  } finally {
    await chmod(recoveryDirectory, 0o700).catch(() => {});
    await browser?.close(); await service?.close(); await rm(temporary, { recursive: true, force: true });
  }
}, 60000);
