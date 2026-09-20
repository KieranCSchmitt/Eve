import { randomUUID } from 'node:crypto';
import { CoreMaintenanceError, type CoreBackupReceipt } from '@eve/core';

export type CoreMaintenanceClient = <T>(method: string, payload?: unknown) => Promise<T>;

/** The host's backup-database request must remain pending until worker completion
 * or worker exit. An ordinary IPC response timeout is unsafe for this method:
 * releasing quiescence early would race a still-writing SQLite backup. */
export async function backupCoreDatabase(core: CoreMaintenanceClient, destination: string, signal?: AbortSignal): Promise<CoreBackupReceipt> {
  if (signal?.aborted) throw new CoreMaintenanceError('CANCELLED', 'The database snapshot was cancelled.');
  const backupId = randomUUID();
  // The injected IPC client must preserve invocation order (including requests
  // waiting for coreReady), so cancellation follows this backup registration.
  const completion = core<CoreBackupReceipt>('backup-database', { backupId, destination });
  const cancel = () => { void core('cancel-backup', { backupId }).catch(() => { /* Completion or worker exit remains authoritative. */ }); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try { return await completion; }
  finally { signal?.removeEventListener('abort', cancel); }
}
