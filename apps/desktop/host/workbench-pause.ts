import { randomUUID } from 'node:crypto';
import type { RecoveryDocument } from '../../../extensions/eve-workbench/src/protocol';

export interface WorkbenchPauseOptions {
  /** Host must block editor renderer input and drain previously accepted input before resolving. */
  holdInput(): Promise<{ release(): Promise<void> }>;
  signal?: AbortSignal;
  /** Safety lease, renewed while the host is responsive. This is not a workload deadline. */
  ttlMs?: number;
}
export interface WorkbenchPauseLease {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly documents: readonly RecoveryDocument[];
  readonly qualification: { ownedWriters: 'paused'; externalWriters: 'not-controlled'; platform: 'linux'; hardwareQualified: false };
  assertHeld(): Promise<void>;
  renew(): Promise<void>;
  release(): Promise<void>;
}
export type PauseControl = 'pause-status' | 'pause-acquire' | 'pause-assert' | 'pause-renew' | 'pause-release';
/** Internal host hooks. The public workbench service owns the command gate and authenticated transport. */
export interface WorkbenchPauseHooks {
  platform: NodeJS.Platform;
  blockCommands(): () => void;
  drain(signal?: AbortSignal): Promise<void>;
  capture(signal?: AbortSignal): Promise<RecoveryDocument[]>;
  control(type: PauseControl, params?: Record<string, unknown>): Promise<unknown>;
  subscribeInvalidation(listener: (event: { leaseId?: string; reason: string }) => void): () => void;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function ensure(signal: AbortSignal) { signal.throwIfAborted(); }

export async function acquireWorkbenchPause(hooks: WorkbenchPauseHooks, options: WorkbenchPauseOptions): Promise<WorkbenchPauseLease> {
  if (hooks.platform !== 'linux') throw new Error('WORKBENCH_PAUSE_UNSUPPORTED: Safe writer pause requires Linux pidfds and an independent watchdog.');
  options.signal?.throwIfAborted();
  const ttlMs = options.ttlMs ?? 30_000;
  if (!Number.isInteger(ttlMs) || ttlMs < 5000 || ttlMs > 120_000 || typeof options.holdInput !== 'function') throw new Error('A bounded pause TTL and an editor input hold are required.');
  const capability = await hooks.control('pause-status');
  if (!object(capability) || capability.supported !== true) throw new Error('WORKBENCH_PAUSE_UNSUPPORTED: The running supervisor cannot safely pause owned writers on this kernel.');
  if (capability.active) throw new Error('The workbench already has an active pause lease.');
  const unblock = hooks.blockCommands();
  const controller = new AbortController();
  const id = randomUUID();
  let input: { release(): Promise<void> } | undefined;
  let pauseRequested = false;
  let releasing: Promise<void> | undefined;
  let ended = false;
  let acquiring = true;
  let timer: NodeJS.Timeout | undefined;
  let lastAcknowledged = 0;
  let renewing: Promise<void> | undefined;
  const detach = hooks.subscribeInvalidation(event => { if (!event.leaseId || event.leaseId === id) invalidate(new Error(`WORKBENCH_PAUSE_ENDED: ${event.reason}`)); });
  const cancelled = () => invalidate(options.signal?.reason ?? new Error('Workbench pause cancelled.'));
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  function invalidate(reason: unknown) {
    if (!controller.signal.aborted) controller.abort(reason);
    if (!acquiring) void release().catch(() => { /* Explicit release/assertHeld still reports an uncertain resume. */ });
  }
  async function checkControl(type: 'pause-acquire' | 'pause-assert' | 'pause-renew') {
    ensure(controller.signal);
    const started = performance.now();
    const reply = await hooks.control(type, { leaseId: id, ...(type === 'pause-acquire' ? { ttlMs } : {}) });
    ensure(controller.signal);
    if (!object(reply) || reply.leaseId !== id || typeof reply.remainingMs !== 'number' || reply.remainingMs <= 0 || reply.remainingMs > ttlMs) throw new Error('The supervisor did not confirm a live pause lease.');
    lastAcknowledged = started + reply.remainingMs;
  }
  function release(): Promise<void> {
    if (releasing) return releasing;
    ended = true;
    if (timer) clearInterval(timer);
    options.signal?.removeEventListener('abort', cancelled);
    detach();
    if (!controller.signal.aborted) controller.abort(new Error('WORKBENCH_PAUSE_ENDED: The pause lease was released.'));
    releasing = (async () => {
      let failure: unknown;
      if (pauseRequested) {
        try { await hooks.control('pause-release', { leaseId: id }); }
        catch (error) {
          try {
            const status = await hooks.control('pause-status');
            if (!object(status) || status.active) failure = error;
          } catch { failure = error; }
        }
      }
      try { await input?.release(); } catch (error) { failure ??= error; }
      finally { unblock(); }
      if (failure) throw new Error('WORKBENCH_PAUSE_RELEASE_UNCERTAIN: The independent watchdog remains the resume fallback. No backup may be published.', { cause: failure });
    })();
    return releasing;
  }
  try {
    ensure(controller.signal);
    input = await options.holdInput();
    if (!input || typeof input.release !== 'function') throw new Error('The editor input hold did not provide a release callback.');
    ensure(controller.signal);
    await hooks.drain(controller.signal);
    const documents = await hooks.capture(controller.signal); // Actual capture + fsync precedes every stop.
    ensure(controller.signal);
    pauseRequested = true;
    await checkControl('pause-acquire');
    acquiring = false;
    const renew = async () => {
      ensure(controller.signal);
      if (ended || performance.now() >= lastAcknowledged) { const error = new Error('WORKBENCH_PAUSE_EXPIRED: The lease was not renewed before its deadline.'); invalidate(error); throw error; }
      if (!renewing) {
        renewing = checkControl('pause-renew').catch(error => { invalidate(error); throw error; }).finally(() => { renewing = undefined; });
      }
      await renewing;
    };
    timer = setInterval(() => { void renew().catch(() => {}); }, Math.max(1000, Math.floor(ttlMs / 3)));
    timer.unref();
    return Object.freeze({ id, signal: controller.signal,
      documents: Object.freeze(structuredClone(documents).map(document => Object.freeze(document))),
      qualification: Object.freeze({ ownedWriters: 'paused' as const, externalWriters: 'not-controlled' as const, platform: 'linux' as const, hardwareQualified: false as const }),
      assertHeld: async () => {
        ensure(controller.signal);
        if (ended || performance.now() >= lastAcknowledged) { const error = new Error('WORKBENCH_PAUSE_EXPIRED: The workbench lease is stale.'); invalidate(error); throw error; }
        try { await checkControl('pause-assert'); } catch (error) { invalidate(error); throw error; }
      }, renew, release,
    });
  } catch (error) {
    acquiring = false;
    // A lost acquire acknowledgment is uncertain: release uses the chosen lease ID regardless.
    await release();
    throw error;
  }
}
