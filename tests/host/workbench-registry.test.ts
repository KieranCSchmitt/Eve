import { describe, expect, it, vi } from 'vitest';
import { WorkbenchRegistry, type WorkbenchClosePermit, type WorkbenchIdentity, type WorkbenchRegistryOptions, type WorkbenchResource } from '../../apps/desktop/host/workbench-registry';

type Editor = { id: string; dirty: string; undo: string[] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const project = (id: string): WorkbenchIdentity => ({ projectId: id, canonicalRoot: `/projects/${id}`, rootIdentity: { device: '1', inode: String([...id].reduce((value, char) => value * 31 + char.charCodeAt(0), 0)) } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(maxEntries = 3) {
  const events: string[] = [], publishers = new Map<string, (event: string) => void>(), resources = new Map<string, WorkbenchResource<Editor>>();
  const options: WorkbenchRegistryOptions<Editor, string> = {
    maxEntries,
    create: async context => {
      const key = `${context.identity.projectId}:${context.generation}`; events.push(`create:${key}`); publishers.set(key, context.publish);
      const resource = { value: { id: context.identity.projectId, dirty: '', undo: [] as string[] }, dispose: vi.fn(async () => { events.push(`dispose:${key}`); }) };
      resources.set(key, resource); return resource;
    },
    prepareClose: async entry => {
      const key = entry.identity.projectId; events.push(`prepare:${key}`); let held = true;
      return { assertHeld: async () => { if (!held) throw new Error('close permit lost'); }, release: async () => { events.push(`release-close:${key}`); held = false; } };
    },
  };
  const registry = new WorkbenchRegistry(options);
  const pause = async (entry: { identity: Readonly<WorkbenchIdentity> }) => {
    const id = entry.identity.projectId; events.push(`pause:${id}`); const ended = new AbortController();
    return { signal: ended.signal, assertHeld: async () => { ended.signal.throwIfAborted(); }, release: async () => { events.push(`resume:${id}`); ended.abort(); } };
  };
  return { registry, options, events, publishers, resources, pause };
}

describe('retained project workbench registry', () => {
  it('deduplicates lazy starts and keeps independent native resource identities, dirty state and undo', async () => {
    const value = fixture(); const first = value.registry.ensure(project('alpha')); const repeated = value.registry.ensure(project('alpha'));
    expect(repeated).toBe(first); const a = await first; const b = await value.registry.ensure(project('beta'));
    a.value.dirty = 'unfinished alpha'; a.value.undo.push('alpha edit'); b.value.dirty = 'unfinished beta';
    expect((await value.registry.ensure(project('alpha'))).value).toBe(a.value);
    expect(value.registry.get('beta')?.value.dirty).toBe('unfinished beta'); expect(a.value.undo).toEqual(['alpha edit']);
    expect(value.events).toEqual(['create:alpha:1', 'create:beta:1']); expect(Object.isFrozen(a.identity)).toBe(true);
  });
  it('reserves capacity for pending starts, refuses eviction, and excludes aliases or changed identities', async () => {
    const value = fixture(1); const start = deferred<WorkbenchResource<Editor>>(); value.options.create = () => start.promise;
    const first = value.registry.ensure(project('alpha')); expect(value.registry.size).toBe(1);
    await expect(value.registry.ensure(project('beta'))).rejects.toMatchObject({ code: 'CAPACITY' });
    await expect(value.registry.ensure({ ...project('beta'), canonicalRoot: project('alpha').canonicalRoot })).rejects.toMatchObject({ code: 'ROOT_IN_USE' });
    await expect(value.registry.ensure({ ...project('beta'), rootIdentity: project('alpha').rootIdentity })).rejects.toMatchObject({ code: 'ROOT_IN_USE' });
    await expect(value.registry.ensure({ ...project('alpha'), rootIdentity: { device: '1', inode: '999' } })).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    start.resolve({ value: { id: 'alpha', dirty: 'preserved', undo: [] }, dispose: async () => {} }); await first;
    expect(value.registry.get('alpha')?.value.dirty).toBe('preserved'); expect(value.events).toEqual([]);
  });
  it('retries a failed startup with a new generation only after factory cleanup finishes', async () => {
    const value = fixture(); const cleanup = deferred<void>(); const create = value.options.create;
    value.options.create = async context => { await cleanup.promise; value.events.push('failed-start-cleaned'); throw new Error('startup failed'); };
    const first = value.registry.ensure(project('alpha')); const rejected = expect(first).rejects.toThrow(/startup failed/);
    expect(value.registry.size).toBe(1); cleanup.resolve(); await rejected; expect(value.registry.size).toBe(0);
    value.options.create = create; const retried = await value.registry.ensure(project('alpha'));
    expect(retried.generation).toBe(2); expect(value.events).toEqual(['failed-start-cleaned', 'create:alpha:2']);
  });
  it('routes events by immutable owner/generation, ignores stale publishers, and contains observer exceptions', async () => {
    const value = fixture(); const seen: string[] = []; const observerError = vi.fn(() => { throw new Error('observer reporter also failed'); }); value.options.onObserverError = observerError;
    value.registry.subscribe(() => { throw new Error('bad observer'); });
    value.registry.subscribe(event => { seen.push(`${event.identity.projectId}:${event.generation}:${event.event}`); });
    await value.registry.ensure(project('alpha')); await value.registry.ensure(project('beta'));
    value.publishers.get('alpha:1')!('dirty'); value.publishers.get('beta:1')!('context');
    await value.registry.close('alpha', { reason: 'Explicit close' }); await value.registry.ensure(project('alpha'));
    value.publishers.get('alpha:1')!('stale'); value.publishers.get('alpha:2')!('new');
    expect(seen).toEqual(['alpha:1:dirty', 'beta:1:context', 'alpha:2:new']); expect(observerError).toHaveBeenCalledTimes(3);
    expect(value.registry.size).toBe(2);
  });
  it('waits for every admitted startup terminal result even when one fails', async () => {
    const value = fixture(); const pending = deferred<WorkbenchResource<Editor>>();
    value.options.create = context => context.identity.projectId === 'alpha' ? Promise.reject(new Error('alpha failed')) : pending.promise;
    void value.registry.ensure(project('alpha')); void value.registry.ensure(project('beta'));
    let settled = false; const result = value.registry.settledStarts().finally(() => { settled = true; }); const rejected = expect(result).rejects.toThrow(/startups failed/);
    await tick(); expect(settled).toBe(false);
    pending.resolve({ value: { id: 'beta', dirty: '', undo: [] }, dispose: async () => {} }); await rejected;
    expect(value.registry.get('beta')).toBeDefined();
  });
  it('keeps an explicitly cancelled dirty close open, then allows controlled replacement after approved close', async () => {
    const value = fixture(); const a = await value.registry.ensure(project('alpha')); a.value.dirty = 'unsaved';
    const prepare = value.options.prepareClose; value.options.prepareClose = async () => null;
    expect(await value.registry.close('alpha', { reason: 'Close editor' })).toEqual({ closed: false }); expect(value.registry.get('alpha')).toBe(a);
    expect(value.resources.get('alpha:1')!.dispose).not.toHaveBeenCalled(); value.options.prepareClose = prepare;
    await value.registry.close('alpha', { reason: 'Close editor' }); const next = await value.registry.ensure({ ...project('alpha'), rootIdentity: { device: '1', inode: '999' } });
    expect(next.generation).toBe(2); expect(value.events.slice(1, 4)).toEqual(['prepare:alpha', 'dispose:alpha:1', 'release-close:alpha']);
  });
  it('freezes sorted entries after pending starts finish and holds admission until reverse-order release', async () => {
    const value = fixture(); const pending = deferred<WorkbenchResource<Editor>>(); const create = value.options.create;
    value.options.create = context => context.identity.projectId === 'beta' ? pending.promise : create(context);
    await value.registry.ensure(project('alpha')); const start = value.registry.ensure(project('beta'));
    const freezing = value.registry.freeze({ pause: value.pause }); await tick(); expect(value.events).not.toContain('pause:alpha');
    await expect(value.registry.ensure(project('gamma'))).rejects.toMatchObject({ code: 'MAINTENANCE' });
    await expect(value.registry.close('alpha', { reason: 'Close' })).rejects.toMatchObject({ code: 'MAINTENANCE' });
    pending.resolve({ value: { id: 'beta', dirty: '', undo: [] }, dispose: async () => {} }); await start; const lease = await freezing;
    expect(lease.admitted.map(item => [item.identity.projectId, item.generation])).toEqual([['alpha', 1], ['beta', 1]]);
    expect(lease.entries).toEqual(lease.admitted); expect(value.events.slice(-2)).toEqual(['pause:alpha', 'pause:beta']);
    await lease.assertHeld(); await lease.release(); await lease.release(); expect(value.events.slice(-2)).toEqual(['resume:beta', 'resume:alpha']);
    await expect(lease.assertHeld()).rejects.toThrow(/hold ended/); expect(value.registry.size).toBe(2);
  });
  it('waits for an already admitted close prompt and disposal before capturing the paused set', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha')); await value.registry.ensure(project('beta'));
    const prepared = deferred<WorkbenchClosePermit>(); const prepare = value.options.prepareClose;
    value.options.prepareClose = entry => entry.identity.projectId === 'alpha' ? prepared.promise : prepare(entry, { reason: 'close' });
    const closing = value.registry.close('alpha', { reason: 'close' }); const freezing = value.registry.freeze({ pause: value.pause });
    await tick(); expect(value.events).not.toContain('pause:beta');
    prepared.resolve({ assertHeld: async () => {}, release: async () => {} }); await closing; const lease = await freezing;
    expect(lease.admitted.map(item => item.identity.projectId)).toEqual(['alpha', 'beta']); expect(lease.entries.map(item => item.identity.projectId)).toEqual(['beta']);
    expect(value.events.indexOf('dispose:alpha:1')).toBeLessThan(value.events.indexOf('pause:beta')); await lease.release();
  });
  it('retains an unfinished factory during cancelled freeze until its cleanup/result settles', async () => {
    const value = fixture(); const pending = deferred<WorkbenchResource<Editor>>(); value.options.create = () => pending.promise;
    const starting = value.registry.ensure(project('alpha')); const controller = new AbortController();
    let settled = false; const freezing = value.registry.freeze({ pause: value.pause, signal: controller.signal }).finally(() => { settled = true; }); const rejected = expect(freezing).rejects.toThrow(/cancelled/);
    controller.abort(new Error('cancelled')); await tick(); expect(settled).toBe(false);
    await expect(value.registry.ensure(project('beta'))).rejects.toMatchObject({ code: 'MAINTENANCE' });
    pending.resolve({ value: { id: 'alpha', dirty: 'retained startup', undo: [] }, dispose: async () => {} }); await starting; await rejected;
    expect(value.registry.get('alpha')?.value.dirty).toBe('retained startup'); expect(value.events).not.toContain('pause:alpha');
  });
  it('unwinds partial lease acquisition on cancellation in reverse order, after the pending acquire settles', async () => {
    const value = fixture(); for (const id of ['alpha', 'beta', 'gamma']) await value.registry.ensure(project(id));
    const pending = deferred<Awaited<ReturnType<typeof value.pause>>>(); const controller = new AbortController(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const freezing = value.registry.freeze({ signal: controller.signal, pause: async entry => { if (entry.identity.projectId === 'gamma') { entered(); return pending.promise; } return value.pause(entry); } });
    const rejected = expect(freezing).rejects.toThrow(/cancelled/); await ready; controller.abort(new Error('cancelled'));
    await tick(); expect(value.events).not.toContain('resume:beta'); pending.resolve(await value.pause(value.registry.get('gamma')!)); await rejected;
    expect(value.events.slice(-3)).toEqual(['resume:gamma', 'resume:beta', 'resume:alpha']);
  });
  it('invalidates on a lost child lease and still attempts every release when one resume fails', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha')); await value.registry.ensure(project('beta')); const expired = new AbortController();
    const lease = await value.registry.freeze({ pause: async entry => {
      const hold = await value.pause(entry);
      return entry.identity.projectId === 'beta' ? { ...hold, signal: expired.signal, release: async () => { value.events.push('resume-failed:beta'); throw new Error('resume failed'); } } : hold;
    } });
    expired.abort(new Error('watchdog expired')); expect(lease.signal.aborted).toBe(true); await expect(lease.assertHeld()).rejects.toThrow(/expired/);
    await expect(lease.release()).rejects.toThrow(/failed to release/); expect(value.events.slice(-2)).toEqual(['resume-failed:beta', 'resume:alpha']);
    await value.registry.ensure(project('gamma'));
  });
  it('collects every dirty-safe permit before deterministic disposal and preserves all entries on Cancel', async () => {
    const value = fixture(); for (const id of ['beta', 'alpha']) await value.registry.ensure(project(id)); const prepare = value.options.prepareClose;
    value.options.prepareClose = async (entry, options) => entry.identity.projectId === 'beta' ? null : prepare(entry, options);
    expect(await value.registry.dispose()).toEqual({ disposed: false }); expect(value.registry.size).toBe(2); expect(value.events).not.toContain('dispose:alpha:1');
    expect(value.events.at(-1)).toBe('release-close:alpha'); value.options.prepareClose = prepare;
    expect(await value.registry.dispose()).toEqual({ disposed: true });
    expect(value.events.slice(-6)).toEqual(['prepare:alpha', 'prepare:beta', 'dispose:beta:1', 'dispose:alpha:1', 'release-close:beta', 'release-close:alpha']);
    expect(await value.registry.dispose()).toEqual({ disposed: true }); await expect(value.registry.ensure(project('alpha'))).rejects.toMatchObject({ code: 'DISPOSED' });
  });
  it('retains failed-disposal ownership for an explicit retry and never auto-evicts its slot', async () => {
    const value = fixture(1); await value.registry.ensure(project('alpha')); const resource = value.resources.get('alpha:1')!; const dispose = resource.dispose;
    resource.dispose = async () => { throw new Error('owned child still running'); };
    await expect(value.registry.close('alpha', { reason: 'Close' })).rejects.toThrow(/still running/); expect(value.registry.size).toBe(1);
    await expect(value.registry.ensure(project('alpha'))).rejects.toMatchObject({ code: 'CLOSING' }); await expect(value.registry.ensure(project('beta'))).rejects.toMatchObject({ code: 'CAPACITY' });
    resource.dispose = dispose; await value.registry.close('alpha', { reason: 'Retry owned cleanup' }); expect(value.registry.size).toBe(0);
  });
  it('cannot forget an in-progress disposer when a concurrent freeze is cancelled', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha')); const done = deferred<void>(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    value.resources.get('alpha:1')!.dispose = async () => { entered(); await done.promise; };
    const closing = value.registry.close('alpha', { reason: 'Close' }); await ready; const controller = new AbortController();
    let settled = false; const freezing = value.registry.freeze({ pause: value.pause, signal: controller.signal }).finally(() => { settled = true; }); const rejected = expect(freezing).rejects.toThrow(/cancelled/);
    controller.abort(new Error('cancelled')); await tick(); expect(settled).toBe(false); expect(value.registry.size).toBe(1);
    done.resolve(); await closing; await rejected; expect(value.registry.size).toBe(0);
  });
  it('refuses disposal after a lost close permit and releases the hold without discarding the entry', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha')); const released = vi.fn(async () => {});
    value.options.prepareClose = async () => ({ assertHeld: async () => { throw new Error('Input changed after Save'); }, release: released });
    await expect(value.registry.close('alpha', { reason: 'Close' })).rejects.toThrow(/Input changed/);
    expect(value.resources.get('alpha:1')!.dispose).not.toHaveBeenCalled(); expect(value.registry.size).toBe(1); expect(released).toHaveBeenCalledOnce();
  });
  it('reports permit release failure after a completed close without pretending the disposed resource is still alive', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha'));
    value.options.prepareClose = async () => ({ assertHeld: async () => {}, release: async () => { throw new Error('Input shield could not clear'); } });
    await expect(value.registry.close('alpha', { reason: 'Close' })).rejects.toThrow(/permit failed to release/);
    expect(value.resources.get('alpha:1')!.dispose).toHaveBeenCalledOnce(); expect(value.registry.size).toBe(0);
    const reopened = await value.registry.ensure(project('alpha')); expect(reopened.generation).toBe(2);
  });
  it('releases every permit and retains every editor when shutdown is cancelled during a pending prompt', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha')); await value.registry.ensure(project('beta'));
    const pending = deferred<WorkbenchClosePermit>(); const prepare = value.options.prepareClose; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    value.options.prepareClose = async (entry, options) => { if (entry.identity.projectId === 'beta') { entered(); return pending.promise; } return prepare(entry, options); };
    const controller = new AbortController(); const disposing = value.registry.dispose({ signal: controller.signal }); const rejected = expect(disposing).rejects.toThrow(/cancelled/);
    await ready; controller.abort(new Error('cancelled')); await tick();
    await expect(value.registry.ensure(project('gamma'))).rejects.toMatchObject({ code: 'MAINTENANCE' });
    pending.resolve({ assertHeld: async () => {}, release: async () => { value.events.push('release-close:beta'); } }); await rejected;
    expect(value.events.slice(-2)).toEqual(['release-close:beta', 'release-close:alpha']); expect(value.registry.size).toBe(2);
    expect(value.resources.get('alpha:1')!.dispose).not.toHaveBeenCalled(); expect(value.resources.get('beta:1')!.dispose).not.toHaveBeenCalled();
  });
  it('continues deterministic shutdown cleanup after a disposer failure while retaining only the failed ownership', async () => {
    const value = fixture(); await value.registry.ensure(project('alpha')); await value.registry.ensure(project('beta'));
    value.resources.get('beta:1')!.dispose = async () => { value.events.push('dispose-failed:beta'); throw new Error('child still running'); };
    await expect(value.registry.dispose()).rejects.toThrow(/handles remain registered/);
    expect(value.events.slice(-4)).toEqual(['dispose-failed:beta', 'dispose:alpha:1', 'release-close:beta', 'release-close:alpha']);
    expect(value.registry.get('alpha')).toBeUndefined(); expect(value.registry.get('beta')).toBeDefined(); expect(value.registry.size).toBe(1);
  });
});
