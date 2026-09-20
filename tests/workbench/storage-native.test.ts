import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DocumentState, RecoveryDocument } from '../../extensions/eve-workbench/src/protocol';
import type { WorkbenchRecoveryBatch } from '../../apps/desktop/host/workbench';

function host() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/workbench/crash-host.ts'], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  child.on('message', (message: any) => { const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); } });
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('Test host exited.')); pending.clear(); });
  child.stdout!.resume(); child.stderr!.resume();
  return { child, rpc: <T = any>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); child.send({ id, method, params }); }) };
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
async function view(browser: Browser, runtime: any) {
  // Cookies are host-scoped, not port-scoped: distinct contexts are essential.
  const context = await browser.newContext();
  await context.addCookies([{ name: runtime.cookie.name, value: runtime.cookie.value, url: runtime.cookie.url, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); await page.goto(runtime.url); return { page, context };
}

it.skipIf(process.env.EVE_RUN_WORKBENCH_NATIVE !== '1')('keeps two real project editors isolated and recovers one killed host without changing the other editor or undo history', async () => {
  const directory = await realpath(await mkdtemp('/tmp/eve-multi-workbench-'));
  const hosts: ReturnType<typeof host>[] = [];
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  async function project(id: string) {
    const projectRoot = path.join(directory, 'projects', id); await cp(path.resolve('examples/orbit'), projectRoot, { recursive: true });
    const file = path.join(projectRoot, 'eve.project.json'); const original = await readFile(file, 'utf8');
    const options = { codeServerExecutable: process.env.EVE_CODE_SERVER ?? path.resolve(`.runtime/code-server/code-server-4.138.0-${process.platform === 'darwin' ? 'macos' : 'linux'}-arm64/bin/code-server`), extensionDirectory: path.resolve('extensions/eve-workbench'), profileDirectory: path.join(directory, 'instances', id), recoveryDirectory: path.join(directory, 'recovery', id), projectRoot, trustedProject: true };
    const owner = host(); hosts.push(owner); const runtime = await owner.rpc('start', options); const visible = await view(browser, runtime); await owner.rpc('connected');
    const checkpoint = { uri: pathToFileURL(file).href, selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }], visibleRanges: [], viewColumn: 1, version: 0 };
    await owner.rpc('checkpoint.restore', checkpoint);
    const before = await owner.rpc<DocumentState>('document.inspect', { uri: checkpoint.uri });
    const changed = JSON.stringify({ ...JSON.parse(original), name: `${id} independent project` }, null, 2) + '\n';
    await owner.rpc('edit.apply', { operationId: `${id}-edit`, documents: [{ uri: checkpoint.uri, expectedVersion: before.version, expectedHash: before.hash, text: changed }] });
    await owner.rpc('recovery.restore', { uri: 'untitled:matching-original-uri', languageId: 'plaintext', text: `${id} independent unsaved thought` });
    const durable = await owner.rpc<RecoveryDocument[]>('durable-recovery'); expect(durable.map(item => item.text)).toEqual(expect.arrayContaining([changed, `${id} independent unsaved thought`]));
    return { owner, options, runtime, visible, checkpoint, file, original, changed };
  }
  try {
    const alpha = await project('alpha'), beta = await project('beta');
    expect(alpha.runtime.url).not.toBe(beta.runtime.url); expect(alpha.runtime.cookie.value).not.toBe(beta.runtime.cookie.value);
    expect(alpha.runtime.recoveryDirectory).toBe(alpha.options.recoveryDirectory); expect(beta.runtime.recoveryDirectory).toBe(beta.options.recoveryDirectory);
    const alphaJournal = await readFile(path.join(alpha.options.recoveryDirectory, 'current.json'), 'utf8');
    const competitor = host(); hosts.push(competitor);
    await expect(competitor.rpc('start', { ...beta.options, profileDirectory: path.join(directory, 'instances', 'collision'), recoveryDirectory: alpha.options.recoveryDirectory })).rejects.toThrow(/recovery directory is already owned/);
    expect(await readFile(path.join(alpha.options.recoveryDirectory, 'current.json'), 'utf8')).toBe(alphaJournal);
    competitor.child.kill('SIGTERM'); await exited(competitor.child);

    alpha.owner.child.kill('SIGKILL'); await exited(alpha.owner.child);
    const restarted = host(); hosts.push(restarted); const fresh = await restarted.rpc('start', alpha.options);
    const batch = await restarted.rpc<WorkbenchRecoveryBatch>('recovery-batch');
    expect(batch.documents.map(item => item.text)).toEqual(expect.arrayContaining([alpha.changed, 'alpha independent unsaved thought']));
    expect(batch.documents.some(item => item.text.includes('beta independent'))).toBe(false);
    await expect(beta.owner.rpc('acknowledge-recovery', batch)).rejects.toThrow(/not captured/);
    await view(browser, fresh); await restarted.rpc('connected');
    for (const document of batch.documents) await restarted.rpc('recovery.restore', document);
    const restored = await restarted.rpc<RecoveryDocument[]>('durable-recovery');
    expect(batch.documents.every(document => restored.some(item => item.untitled && item.dirty && item.text === document.text))).toBe(true);
    await restarted.rpc('acknowledge-recovery', batch);
    expect(await readFile(alpha.file, 'utf8')).toBe(alpha.original);
    expect((await beta.owner.rpc<DocumentState>('document.inspect', { uri: beta.checkpoint.uri })).text).toBe(beta.changed);
    expect((await beta.owner.rpc<DocumentState[]>('dirty.list')).some(item => item.untitled && item.text === 'beta independent unsaved thought')).toBe(true);
    expect((await readdir(beta.options.recoveryDirectory))).not.toContain('acknowledged.json');

    await restarted.rpc('close'); await exited(restarted.child);
    await beta.owner.rpc('checkpoint.restore', beta.checkpoint);
    await beta.visible.page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect.poll(async () => (await beta.owner.rpc<DocumentState>('document.inspect', { uri: beta.checkpoint.uri })).text).toBe(beta.original);
    expect(await readFile(beta.file, 'utf8')).toBe(beta.original);
    expect((await beta.owner.rpc<DocumentState[]>('dirty.list')).some(item => item.text === 'beta independent unsaved thought')).toBe(true);
  } finally {
    await browser.close();
    for (const owner of hosts) if (owner.child.exitCode === null && owner.child.signalCode === null) {
      try { await owner.rpc('close'); } catch { /* Owned supervisor evidence remains available if shutdown failed. */ }
      if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGTERM');
      await exited(owner.child);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
