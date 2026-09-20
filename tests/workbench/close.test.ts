import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../apps/desktop/host/workbench';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('workbench shutdown ownership', () => {
  it('retains runtime authority after failed control and retries without numeric PID signals', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eve-close-retry-')); temporary.push(directory);
    const credential = path.join(directory, 'bridge.token'); await writeFile(credential, 'retained-until-owned-stop', { mode: 0o600 });
    const service = new WorkbenchService({ codeServerExecutable: '/unused', extensionDirectory: '/unused', profileDirectory: directory, projectRoot: directory });
    const child = Object.assign(new EventEmitter(), { pid: 987654321, exitCode: null as number | null, signalCode: null, kill: vi.fn() });
    const stop = vi.fn(async (method: string) => {
      expect(method).toBe('stop');
      if (stop.mock.calls.length === 1) throw new Error('authenticated control unavailable');
      child.exitCode = 0; child.emit('exit', 0, null);
    });
    // Inject only the child/control boundary; lifecycle ownership and cleanup are real.
    Object.assign(service, { process: child, runtimeDirectory: directory, supervisorOwned: true, supervisorControl: stop });
    const statuses: unknown[] = []; service.on('status', status => statuses.push(status));
    const first = service.close(); expect(service.close()).toBe(first);
    await expect(service.call('context')).rejects.toThrow('closing or has stopped');
    await expect(first).rejects.toThrow('authenticated control unavailable');
    await expect(service.start()).rejects.toThrow('closing or has stopped');
    expect(await readFile(credential, 'utf8')).toBe('retained-until-owned-stop');
    expect(statuses).toEqual([]); expect(child.kill).not.toHaveBeenCalled();
    const retry = service.close(); expect(service.close()).toBe(retry); await retry;
    expect(stop).toHaveBeenCalledTimes(2); expect(child.kill).not.toHaveBeenCalled();
    expect(statuses).toEqual([{ state: 'stopped' }]);
    await expect(readFile(credential)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.close(); expect(stop).toHaveBeenCalledTimes(2);
  });
  it('waits for recovery persistence before reporting completed shutdown', async () => {
    const service = new WorkbenchService({ codeServerExecutable: '/unused', extensionDirectory: '/unused', profileDirectory: '/unused', projectRoot: '/unused' });
    let persist!: () => void;
    Object.assign(service, { recoveryQueue: new Promise<void>(resolve => { persist = resolve; }) });
    const statuses: unknown[] = []; service.on('status', status => statuses.push(status));
    const closing = service.close(); await Promise.resolve(); await Promise.resolve();
    expect(statuses).toEqual([]); expect(service.close()).toBe(closing);
    persist(); await closing; expect(statuses).toEqual([{ state: 'stopped' }]);
  });
});
