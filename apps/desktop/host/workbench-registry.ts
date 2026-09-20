import path from 'node:path';

/** Supplied by the trusted host after canonical, no-follow filesystem inspection.
 * rootIdentity is a stable directory identity (for example device/inode), not a path alias. */
export interface WorkbenchIdentity { projectId: string; canonicalRoot: string; rootIdentity: { readonly device: string; readonly inode: string } }
export interface WorkbenchEntry<T> { readonly identity: Readonly<WorkbenchIdentity>; readonly generation: number; readonly value: T }
export interface WorkbenchResource<T> {
  value: T;
  /** Remove event listeners/views and finish owned-process cleanup before resolving. */
  dispose(): Promise<void>;
}
export interface WorkbenchClosePermit {
  /** The host holds editor input/commands after resolving Save/Discard and before disposal. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
export interface RegistryWriterLease extends WorkbenchClosePermit { readonly signal?: AbortSignal }
export interface WorkbenchRegistryEvent<E> { readonly identity: Readonly<WorkbenchIdentity>; readonly generation: number; readonly event: E }
export interface WorkbenchRegistryOptions<T, E = unknown> {
  maxEntries: number;
  /** Must clean partially allocated resources before rejecting. No default/fake factory exists. */
  create(context: { identity: Readonly<WorkbenchIdentity>; generation: number; signal: AbortSignal; publish(event: E): void }): Promise<WorkbenchResource<T>>;
  /** Return null for Cancel; a permit keeps the dirty-work decision valid through disposal. */
  prepareClose(entry: WorkbenchEntry<T>, context: { reason: string; signal?: AbortSignal }): Promise<WorkbenchClosePermit | null>;
  onObserverError?(error: unknown): void;
}
export interface RegistryFreezeLease extends RegistryWriterLease {
  readonly signal: AbortSignal;
  /** Includes identities/generations that were still starting/closing at admission. */
  readonly admitted: readonly { identity: Readonly<WorkbenchIdentity>; generation: number }[];
  readonly entries: readonly { identity: Readonly<WorkbenchIdentity>; generation: number }[];
}
export class WorkbenchRegistryError extends Error {
  constructor(readonly code: 'INVALID_IDENTITY' | 'IDENTITY_CHANGED' | 'ROOT_IN_USE' | 'CAPACITY' | 'MAINTENANCE' | 'DISPOSED' | 'CLOSING' | 'LEASE_LOST', message: string) { super(message); this.name = 'WorkbenchRegistryError'; }
}
interface Slot<T> {
  identity: Readonly<WorkbenchIdentity>;
  generation: number;
  controller: AbortController;
  promise: Promise<WorkbenchEntry<T>>;
  resource?: WorkbenchResource<T>;
  entry?: WorkbenchEntry<T>;
  closing?: Promise<{ closed: boolean }>;
  disposeFailed?: unknown;
}
function identity(value: WorkbenchIdentity): Readonly<WorkbenchIdentity> {
  if (!value || typeof value.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.projectId) || typeof value.canonicalRoot !== 'string' || !path.isAbsolute(value.canonicalRoot) || path.normalize(value.canonicalRoot) !== value.canonicalRoot || /[\u0000-\u001f\u007f]/.test(value.canonicalRoot) || value.canonicalRoot.length > 4096 || !value.rootIdentity || typeof value.rootIdentity.device !== 'string' || typeof value.rootIdentity.inode !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(value.rootIdentity.device) || !/^(?:0|[1-9][0-9]{0,39})$/.test(value.rootIdentity.inode)) throw new WorkbenchRegistryError('INVALID_IDENTITY', 'A workbench needs a host-verified project and canonical directory identity.');
  return Object.freeze({ projectId: value.projectId, canonicalRoot: value.canonicalRoot, rootIdentity: Object.freeze({ device: value.rootIdentity.device, inode: value.rootIdentity.inode }) });
}
const sameDirectory = (left: WorkbenchIdentity, right: WorkbenchIdentity) => left.rootIdentity.device === right.rootIdentity.device && left.rootIdentity.inode === right.rootIdentity.inode;
const descriptor = <T>(slot: Slot<T>) => Object.freeze({ identity: slot.identity, generation: slot.generation });

/** Retained lifecycle ownership only: no Electron calls, trust grants, filesystem scanning,
 * editor imitation, automatic eviction, or project command execution. */
export class WorkbenchRegistry<T, E = unknown> {
  private readonly slots = new Map<string, Slot<T>>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<(event: WorkbenchRegistryEvent<E>) => void>();
  private maintenance?: symbol;
  private disposed = false;
  private revision = 0;
  constructor(private readonly options: WorkbenchRegistryOptions<T, E>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > 64 || typeof options.create !== 'function' || typeof options.prepareClose !== 'function') throw new Error('A bounded registry, real resource factory, and dirty-safe close coordinator are required.');
  }
  get size() { return this.slots.size; }
  get(projectId: string): WorkbenchEntry<T> | undefined { return this.slots.get(projectId)?.entry; }
  entries(): readonly WorkbenchEntry<T>[] { return Object.freeze(this.ordered().flatMap(slot => slot.entry ? [slot.entry] : [])); }
  subscribe(listener: (event: WorkbenchRegistryEvent<E>) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private ordered() { return [...this.slots.values()].sort((left, right) => left.identity.projectId.localeCompare(right.identity.projectId, 'en')); }
  private admission() {
    if (this.disposed) throw new WorkbenchRegistryError('DISPOSED', 'This workbench registry has been disposed.');
    if (this.maintenance) throw new WorkbenchRegistryError('MAINTENANCE', 'Workbenches are held for a maintenance operation.');
  }
  private publish(slot: Slot<T>, event: E) {
    if (this.slots.get(slot.identity.projectId) !== slot) return;
    const envelope = Object.freeze({ identity: slot.identity, generation: slot.generation, event });
    for (const listener of [...this.listeners]) {
      try { listener(envelope); }
      catch (error) { try { this.options.onObserverError?.(error); } catch { /* Observers cannot change resource ownership or grant authority. */ } }
    }
  }
  ensure(input: WorkbenchIdentity): Promise<WorkbenchEntry<T>> {
    try {
      this.admission(); const selected = identity(input);
      const existing = this.slots.get(selected.projectId);
      if (existing) {
        if (existing.identity.canonicalRoot !== selected.canonicalRoot || !sameDirectory(existing.identity, selected)) throw new WorkbenchRegistryError('IDENTITY_CHANGED', 'This project folder changed. Close it and add the folder again.');
        if (existing.disposeFailed) throw new WorkbenchRegistryError('CLOSING', 'This project could not finish closing. Try closing it again before reopening it.');
        if (existing.closing) throw new WorkbenchRegistryError('CLOSING', 'This project is closing.');
        return existing.promise;
      }
      if ([...this.slots.values()].some(slot => slot.identity.canonicalRoot === selected.canonicalRoot || sameDirectory(slot.identity, selected))) throw new WorkbenchRegistryError('ROOT_IN_USE', 'This folder is already open in another project. Return to that project.');
      if (this.slots.size >= this.options.maxEntries) throw new WorkbenchRegistryError('CAPACITY', 'Close an open project before opening another. Your current work is still available.');
      const generation = (this.generations.get(selected.projectId) ?? 0) + 1;
      this.generations.set(selected.projectId, generation);
      const slot: Slot<T> = { identity: selected, generation, controller: new AbortController(), promise: undefined! };
      this.slots.set(selected.projectId, slot); this.revision++;
      slot.promise = Promise.resolve().then(async () => {
        const resource = await this.options.create({ identity: selected, generation, signal: slot.controller.signal, publish: event => this.publish(slot, event) });
        if (!resource || typeof resource.dispose !== 'function') throw new Error('The workbench factory did not return an owned resource.');
        slot.resource = resource;
        slot.entry = Object.freeze({ identity: selected, generation, value: resource.value });
        this.revision++;
        return slot.entry;
      }).catch(error => {
        // Factory rejection promises that its partial resources finished cleanup.
        if (this.slots.get(selected.projectId) === slot) { this.slots.delete(selected.projectId); this.revision++; }
        throw error;
      });
      // Fire-and-forget callers do not turn a failed owned startup into an unhandled rejection.
      void slot.promise.catch(() => {});
      return slot.promise;
    } catch (error) { return Promise.reject(error); }
  }
  /** Waits for starts admitted at invocation. Cancellation is checked after all terminal replies. */
  async settledStarts(signal?: AbortSignal): Promise<readonly WorkbenchEntry<T>[]> {
    const selected = this.ordered();
    const results = await Promise.allSettled(selected.map(slot => slot.promise));
    signal?.throwIfAborted();
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'One or more workbench startups failed after cleanup.');
    return Object.freeze(selected.flatMap(slot => this.slots.get(slot.identity.projectId) === slot && slot.entry ? [slot.entry] : []));
  }
  close(projectId: string, options: { reason: string; signal?: AbortSignal }): Promise<{ closed: boolean }> {
    try {
      this.admission(); options.signal?.throwIfAborted();
      const slot = this.slots.get(projectId);
      if (!slot) return Promise.resolve({ closed: true });
      if (slot.closing) return slot.closing;
      const operation = (async () => {
        const entry = await slot.promise; options.signal?.throwIfAborted();
        const permit = await this.options.prepareClose(entry, options);
        if (!permit) return { closed: false };
        let failure: unknown;
        try { options.signal?.throwIfAborted(); await permit.assertHeld(); await this.disposeSlot(slot); return { closed: true }; }
        catch (error) { failure = error; throw error; }
        finally {
          try { await permit.release(); }
          catch (releaseError) { throw new AggregateError([...(failure ? [failure] : []), releaseError], 'The workbench close permit failed to release.'); }
        }
      })();
      slot.closing = operation;
      void operation.finally(() => { if (slot.closing === operation) slot.closing = undefined; }).catch(() => {});
      return operation;
    } catch (error) { return Promise.reject(error); }
  }
  private async disposeSlot(slot: Slot<T>) {
    try { await slot.resource!.dispose(); } catch (error) { slot.disposeFailed = error; throw error; }
    if (this.slots.get(slot.identity.projectId) === slot) { this.slots.delete(slot.identity.projectId); this.revision++; }
  }
  private async settleOwnedOperations(selected: Slot<T>[]) {
    // A started close remains authoritative; freezing/disposal waits for its final outcome.
    const results = await Promise.allSettled(selected.flatMap(slot => [slot.promise, ...(slot.closing ? [slot.closing] : [])]));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'An admitted workbench operation failed after its cleanup completed.');
  }
  async freeze(options: { pause(entry: WorkbenchEntry<T>, signal: AbortSignal): Promise<RegistryWriterLease>; signal?: AbortSignal }): Promise<RegistryFreezeLease> {
    this.admission(); options.signal?.throwIfAborted();
    const token = Symbol('freeze'); this.maintenance = token;
    const admitted = this.ordered(); const held: { slot: Slot<T>; lease: RegistryWriterLease }[] = [];
    const ended = new AbortController(); let combined = options.signal ? AbortSignal.any([options.signal, ended.signal]) : ended.signal;
    let releasing: Promise<void> | undefined;
    const release = () => releasing ??= (async () => {
      ended.abort(new WorkbenchRegistryError('LEASE_LOST', 'The registry writer hold ended.'));
      const failures: unknown[] = [];
      for (const item of [...held].reverse()) { try { await item.lease.release(); } catch (error) { failures.push(error); } }
      if (this.maintenance === token) this.maintenance = undefined;
      if (failures.length) throw new AggregateError(failures, 'Some workbench writer leases failed to release.');
    })();
    try {
      await this.settleOwnedOperations(admitted); combined.throwIfAborted();
      const selected = this.ordered(); const revision = this.revision;
      for (const slot of selected) {
        combined.throwIfAborted();
        if (slot.disposeFailed) throw new WorkbenchRegistryError('CLOSING', 'A workbench has unfinished owned-resource cleanup.');
        const lease = await options.pause(slot.entry!, combined);
        if (!lease || typeof lease.release !== 'function' || typeof lease.assertHeld !== 'function') throw new Error('A writer pause did not supply a live lease and release callback.');
        held.push({ slot, lease });
        if (lease.signal) combined = AbortSignal.any([combined, lease.signal]);
        combined.throwIfAborted();
      }
      const assertHeld = async () => {
        try {
          combined.throwIfAborted();
          if (this.maintenance !== token || this.revision !== revision || selected.some(slot => this.slots.get(slot.identity.projectId) !== slot)) throw new WorkbenchRegistryError('LEASE_LOST', 'The retained workbench set changed after writer pause.');
          for (const item of held) { await item.lease.assertHeld(); combined.throwIfAborted(); }
        } catch (error) { ended.abort(error); throw error; }
      };
      await assertHeld();
      return Object.freeze({ signal: combined, admitted: Object.freeze(admitted.map(descriptor)), entries: Object.freeze(selected.map(descriptor)), assertHeld, release });
    } catch (error) {
      try { await release(); } catch (resumeError) { throw new AggregateError([error, resumeError], 'Registry freeze failed and one or more writer leases could not resume.'); }
      throw error;
    }
  }
  /** No force path: every live entry needs a held dirty-safe permit. All permissions are
   * collected before disposal starts, so cancelling a prompt preserves the other editors. */
  async dispose(options: { reason?: string; signal?: AbortSignal } = {}): Promise<{ disposed: boolean }> {
    if (this.disposed) return { disposed: true };
    this.admission(); options.signal?.throwIfAborted();
    const token = Symbol('dispose'); this.maintenance = token;
    const permits: { slot: Slot<T>; permit: WorkbenchClosePermit }[] = [];
    let failure: unknown;
    try {
      const admitted = this.ordered();
      // A factory must settle and clean up. Never drop ownership by racing an abort/timeout.
      await this.settleOwnedOperations(admitted); options.signal?.throwIfAborted();
      for (const slot of this.ordered()) {
        const permit = await this.options.prepareClose(slot.entry!, { reason: options.reason ?? 'Application shutdown', signal: options.signal });
        if (!permit) return { disposed: false };
        permits.push({ slot, permit }); options.signal?.throwIfAborted();
      }
      for (const item of permits) await item.permit.assertHeld();
      options.signal?.throwIfAborted();
      const errors: unknown[] = [];
      for (const item of [...permits].reverse()) {
        try { await item.permit.assertHeld(); await this.disposeSlot(item.slot); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Some retained workbenches could not finish disposal; their handles remain registered.');
      this.disposed = true; this.listeners.clear(); return { disposed: true };
    } catch (error) { failure = error; throw error; }
    finally {
      const errors: unknown[] = [];
      for (const item of [...permits].reverse()) { try { await item.permit.release(); } catch (error) { errors.push(error); } }
      if (this.maintenance === token) this.maintenance = undefined;
      if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'One or more workbench close permits failed to release.');
    }
  }
}
