import { describe, expect, it } from 'vitest';
import { acquireWorkbenchPause, type PauseControl, type WorkbenchPauseHooks } from '../../apps/desktop/host/workbench-pause';

function fixture() {
  const calls: string[] = []; let active: string | undefined; let listener: ((event: { leaseId?: string; reason: string }) => void) | undefined;
  const hooks: WorkbenchPauseHooks = {
    platform: 'linux',
    blockCommands: () => { calls.push('block'); return () => { calls.push('unblock'); }; },
    drain: async () => { calls.push('drain'); },
    capture: async () => { calls.push('durable-capture'); return []; },
    control: async (type, params) => {
      calls.push(type);
      if (type === 'pause-status') return { supported: true, active: active ? { leaseId: active } : null };
      if (type === 'pause-acquire') { active = String(params!.leaseId); return { leaseId: active, remainingMs: 30000 }; }
      if (params?.leaseId !== active) throw new Error('stale lease');
      if (type === 'pause-release') { active = undefined; return { released: true }; }
      return { leaseId: active, remainingMs: 30000 };
    },
    subscribeInvalidation: callback => { listener = callback; return () => { listener = undefined; }; },
  };
  const holdInput = async () => { calls.push('hold-input'); return { release: async () => { calls.push('release-input'); } }; };
  return { calls, hooks, holdInput, invalidate: (reason: string) => listener?.({ reason }), expire: () => { active = undefined; } };
}

describe('acknowledged workbench pause lease', () => {
  it('captures durable documents before any stop, then checks the supervisor and releases exactly once', async () => {
    const value = fixture(); const lease = await acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput });
    expect(value.calls).toEqual(['pause-status', 'block', 'hold-input', 'drain', 'durable-capture', 'pause-acquire']);
    expect(lease.qualification).toMatchObject({ ownedWriters: 'paused', externalWriters: 'not-controlled', hardwareQualified: false });
    await lease.assertHeld(); await lease.renew(); await lease.release(); await lease.release();
    expect(value.calls.filter(call => call === 'pause-release')).toHaveLength(1);
    expect(value.calls.slice(-3)).toEqual(['pause-release', 'release-input', 'unblock']);
    expect(lease.signal.aborted).toBe(true); await expect(lease.assertHeld()).rejects.toThrow(/released/);
  });
  it('refuses Mac before sending control or holding input', async () => {
    const value = fixture(); value.hooks.platform = 'darwin';
    await expect(acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput })).rejects.toThrow(/UNSUPPORTED/);
    expect(value.calls).toEqual([]);
  });
  it('does not suspend anything after a failed durable capture', async () => {
    const value = fixture(); value.hooks.capture = async () => { throw new Error('fsync failed'); };
    await expect(acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput })).rejects.toThrow(/fsync failed/);
    expect(value.calls).not.toContain('pause-acquire'); expect(value.calls.slice(-2)).toEqual(['release-input', 'unblock']);
  });
  it('releases an input hold that finishes after caller cancellation', async () => {
    const value = fixture(); const controller = new AbortController(); let ready!: () => void;
    const pending = acquireWorkbenchPause(value.hooks, { signal: controller.signal, holdInput: async () => { await new Promise<void>(resolve => { ready = resolve; }); return value.holdInput(); } });
    await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('cancelled')); ready();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(value.calls).not.toContain('pause-acquire'); expect(value.calls.slice(-2)).toEqual(['release-input', 'unblock']);
  });
  it('invalidates on supervisor expiry and refuses a later completion even if the caller retained the lease', async () => {
    const value = fixture(); const lease = await acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput });
    value.expire(); value.invalidate('expired');
    expect(lease.signal.aborted).toBe(true); await expect(lease.assertHeld()).rejects.toThrow(/expired/);
    await lease.release(); expect(value.calls).toContain('release-input');
  });
  it('uses a fresh assertion, not local cached state, to catch lost supervisor ownership', async () => {
    const value = fixture(); const lease = await acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput }); value.expire();
    await expect(lease.assertHeld()).rejects.toThrow(/stale/); expect(lease.signal.aborted).toBe(true); await lease.release();
  });
  it('attempts release after an uncertain acquisition response', async () => {
    const value = fixture(); const original = value.hooks.control;
    value.hooks.control = async (type, params) => { const result = await original(type, params); if (type === 'pause-acquire') throw new Error('response lost'); return result; };
    await expect(acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput })).rejects.toThrow(/response lost/);
    expect(value.calls.slice(-3)).toEqual(['pause-release', 'release-input', 'unblock']);
  });
  it('reports an uncertain release and aborts the lease if both supervisor control and status are unavailable', async () => {
    const value = fixture(); const lease = await acquireWorkbenchPause(value.hooks, { holdInput: value.holdInput });
    value.hooks.control = async (_type: PauseControl) => { throw new Error('supervisor died'); };
    await expect(lease.release()).rejects.toThrow(/RELEASE_UNCERTAIN/); expect(lease.signal.aborted).toBe(true);
    expect(value.calls.slice(-2)).toEqual(['release-input', 'unblock']);
  });
});
