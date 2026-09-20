import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DocumentState, RecoveryDocument } from '../../extensions/eve-workbench/src/protocol';

function host() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/workbench/crash-host.ts'], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  child.on('message', (message: any) => { const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); } });
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('Test host exited.')); pending.clear(); });
  let logs = ''; child.stdout!.on('data', data => { logs += String(data); }); child.stderr!.on('data', data => { logs += String(data); });
  return { child, logs: () => logs, rpc: <T = any>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); child.send({ id, method, params }); }) };
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));

it.skipIf(process.env.EVE_RUN_WORKBENCH_NATIVE !== '1')('recovers after actual host SIGKILL and code-server SIGKILL without deleting a lock or losing dirty/untitled snapshots', async () => {
  const directory = await mkdtemp('/tmp/eve-crash-test-');
  const project = path.join(directory, 'orbit'); await cp(path.resolve('examples/orbit'), project, { recursive: true });
  const root = await realpath(project);
  const profile = path.join(directory, 'profile');
  const file = path.join(root, 'eve.project.json');
  const original = await readFile(file, 'utf8');
  const options = { codeServerExecutable: process.env.EVE_CODE_SERVER ?? path.resolve('.runtime/code-server/code-server-4.138.0-macos-arm64/bin/code-server'), extensionDirectory: path.resolve('extensions/eve-workbench'), profileDirectory: profile, projectRoot: root, trustedProject: true };
  const hosts: ReturnType<typeof host>[] = [];
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  try {
    const first = host(); hosts.push(first);
    const firstRuntime = await first.rpc('start', options);
    const context = await browser.newContext();
    async function view(runtime: any) {
      await context.addCookies([{ name: runtime.cookie.name, value: runtime.cookie.value, url: runtime.cookie.url, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage(); await page.goto(runtime.url); return page;
    }
    await view(firstRuntime); await first.rpc('connected');
    const uri = pathToFileURL(file).toString();
    await first.rpc('checkpoint.restore', { uri, selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }], visibleRanges: [], viewColumn: 1, version: 0 });
    const before = await first.rpc<DocumentState>('document.inspect', { uri });
    const changed = original.replace('"#5677FF"', '"#447755"');
    await first.rpc('edit.apply', { operationId: 'before-host-crash', documents: [{ uri, expectedVersion: before.version, expectedHash: before.hash, text: changed }] });
    await first.rpc('recovery.restore', { uri: 'untitled:crash-thought', languageId: 'plaintext', text: 'This untitled thought survives a killed host.' });
    await expect.poll(async () => (await first.rpc<RecoveryDocument[]>('recovery')).filter(d => d.text === changed || d.text.includes('This untitled thought')).length).toBe(2);
    const firstOwner = JSON.parse(await readFile(path.join(profile, 'workbench-owner.json'), 'utf8'));
    const journal = JSON.parse(await readFile(path.join(profile, 'recovery', `orphan-${firstOwner.instance}.json`), 'utf8'));
    expect(journal.documents).toHaveLength(2);
    expect(firstOwner.owner.pid).toBe(first.child.pid);
    expect(firstOwner.guardian.pgid).toBe(firstOwner.guardian.pid);
    expect(firstOwner.owner.start).toMatch(/^(darwin|linux):/);
    const competing = host(); hosts.push(competing);
    await expect(competing.rpc('start', options)).rejects.toThrow('already owned by a live host');
    competing.child.kill('SIGTERM'); await exited(competing.child);

    first.child.kill('SIGKILL'); await exited(first.child);
    const second = host(); hosts.push(second);
    const secondRuntime = await second.rpc('start', options);
    const secondOwner = JSON.parse(await readFile(path.join(profile, 'workbench-owner.json'), 'utf8'));
    expect(secondOwner.instance).not.toBe(firstOwner.instance);
    expect((await readFile(path.join(profile, 'workbench.lock'), 'utf8'))).toBe('eve-workbench-supervisor-v1\n');
    const recovered = await second.rpc<RecoveryDocument[]>('recovery');
    expect(recovered.some(d => d.uri === uri && d.text === changed)).toBe(true);
    expect(recovered.some(d => d.untitled && d.text.includes('This untitled thought'))).toBe(true);
    await view(secondRuntime); await second.rpc('connected');
    for (const document of recovered) await second.rpc('recovery.restore', document);
    const dirty = await second.rpc<DocumentState[]>('dirty.list');
    expect(dirty.some(d => d.text === changed)).toBe(true);
    expect(dirty.some(d => d.text?.includes('This untitled thought'))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect((await readdir(path.join(profile, 'recovery'))).some(name => name === `orphan-${firstOwner.instance}.json`)).toBe(true);
    // Also crash the actual service child. Its own guardian terminates the remaining owned group.
    process.kill(secondOwner.child.pid, 'SIGKILL');
    await expect.poll(async () => JSON.parse(await readFile(path.join(profile, 'workbench-owner.json'), 'utf8')).status).toBe('stopped');
    second.child.kill('SIGKILL'); await exited(second.child);
    const third = host(); hosts.push(third);
    await third.rpc('start', options);
    const afterServiceCrash = await third.rpc<RecoveryDocument[]>('recovery');
    expect(afterServiceCrash.some(d => d.text === changed)).toBe(true);
    expect(afterServiceCrash.some(d => d.text.includes('This untitled thought'))).toBe(true);
    await third.rpc('close'); await exited(third.child);
  } finally {
    await browser.close();
    for (const entry of hosts) if (entry.child.exitCode === null && entry.child.signalCode === null) {
      try { await entry.rpc('close'); } catch { /* Preserve ownership evidence on failure. */ }
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
      await exited(entry.child);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
