import { createHash } from 'node:crypto';
import type { RecoveryDocument, WorkbenchMethod } from '../../../extensions/eve-workbench/src/protocol';
import type { WorkbenchRecoveryBatch } from './workbench';

export interface RecoveryWorkbench {
  readonly connected: boolean;
  loadRecoveryBatch(): Promise<WorkbenchRecoveryBatch>;
  captureDurableRecovery(options?: { signal?: AbortSignal }): Promise<RecoveryDocument[]>;
  acknowledgeRecovery(batch: WorkbenchRecoveryBatch): Promise<void>;
  call<T = unknown>(method: WorkbenchMethod, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}
export interface RecoveredDraft {
  /** These are provenance only. None is asserted to be a live original buffer. */
  originalUris: string[];
  recoveredUri: string;
  hash: string;
  languageId: string;
}
export interface WorkbenchRecoveryResult {
  status: 'empty' | 'later' | 'recovered' | 'partial' | 'cancelled' | 'pending';
  restored: number;
  pending: number;
  unknownFiles: readonly string[];
  recovered: RecoveredDraft[];
  /** Reconciliation must still inspect the actual original file/buffer; recovered URIs prove nothing about it. */
  canReconcileOriginals: boolean;
  message?: string;
}
export interface WorkbenchRecoveryOptions {
  workbench: RecoveryWorkbench;
  chooseRecovery(drafts: readonly RecoveryDocument[]): Promise<'recover' | 'later'>;
  /** Host ownership/attention check immediately before each buffer or journal mutation. */
  assertActive?(): Promise<void>;
  notify?(result: WorkbenchRecoveryResult): void;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const groupKey = (document: RecoveryDocument) => JSON.stringify([document.hash, document.languageId]);
function groups(documents: readonly RecoveryDocument[]): Map<string, RecoveryDocument[]> {
  const result = new Map<string, RecoveryDocument[]>();
  for (const document of documents) {
    if (typeof document.text !== 'string' || document.hash !== hash(document.text) || typeof document.uri !== 'string' || !document.uri || typeof document.languageId !== 'string') throw new Error('A recovery draft is invalid; its journal was preserved.');
    const key = groupKey(document);
    const existing = result.get(key);
    if (existing && existing[0].text !== document.text) throw new Error('Recovery content identity is ambiguous; its journal was preserved.');
    existing ? existing.push(document) : result.set(key, [document]);
  }
  return result;
}
function guard(workbench: RecoveryWorkbench, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!workbench.connected) throw new Error('The workbench disconnected. Pending drafts remain available for recovery.');
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Recovery cancelled.'));
  return new Promise((resolve, reject) => {
    const cancel = () => { reject(signal.reason ?? new Error('Recovery cancelled.')); };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

/** One instance per newly connected workbench. Recovery never writes an original or replays a project edit. */
export class WorkbenchRecoveryCoordinator {
  private running?: Promise<WorkbenchRecoveryResult>;
  private approved?: WorkbenchRecoveryBatch;
  private restored = new Map<string, { uri: string; text: string; hash: string; languageId: string }>();
  constructor(private readonly options: WorkbenchRecoveryOptions) {}

  /** Reuse for explicit retry after a partial result; successful known restores are not repeated. */
  run(options: { signal?: AbortSignal } = {}): Promise<WorkbenchRecoveryResult> {
    if (this.running) return this.running;
    const result = this.runOnce(options.signal);
    this.running = result;
    void result.finally(() => { if (this.running === result) this.running = undefined; }).catch(() => {});
    return result;
  }

  private report(result: WorkbenchRecoveryResult): WorkbenchRecoveryResult {
    try { this.options.notify?.(structuredClone(result)); } catch { /* Observers cannot change recovery authority. */ }
    return result;
  }

  private async runOnce(signal?: AbortSignal): Promise<WorkbenchRecoveryResult> {
    const workbench = this.options.workbench;
    let batch = this.approved;
    let recovered: RecoveredDraft[] = [];
    const base = () => ({ restored: recovered.length, pending: batch?.documents.length ?? 0, unknownFiles: batch?.unrecognizedFiles ?? [], recovered: structuredClone(recovered), canReconcileOriginals: false });
    try {
      guard(workbench, signal);
      batch ??= await workbench.loadRecoveryBatch();
      const draftGroups = groups(batch.documents);
      if (!batch.documents.length) return this.report({ ...base(), status: batch.unrecognizedFiles.length ? 'pending' : 'empty', canReconcileOriginals: !batch.unrecognizedFiles.length, ...(batch.unrecognizedFiles.length ? { message: 'Additional recovery files need review. They were preserved.' } : {}) });
      if (!this.approved) {
        const choice = await abortable(this.options.chooseRecovery(batch.documents), signal);
        guard(workbench, signal);
        if (choice === 'later') return this.report({ ...base(), status: 'later', message: 'Your drafts are still available to recover later.' });
        if (choice !== 'recover') throw new Error('An explicit Recover choice is required.');
        this.approved = batch;
      }
      // This is an actual extension capture followed by fsync, never the optimistic dirtyDocuments getter.
      await this.options.assertActive?.();
      const before = await workbench.captureDurableRecovery({ signal });
      guard(workbench, signal);
      for (const [key, originals] of draftGroups) {
        const known = this.restored.get(key);
        if (known) {
          const current = before.find(document => document.uri === known.uri);
          if (!current || !current.untitled || !current.dirty || current.text !== known.text || current.hash !== known.hash) throw new Error('A recovered draft changed or closed. The original recovery copy is still available for review.');
          recovered.push({ originalUris: [...new Set(originals.map(document => document.uri))], recoveredUri: known.uri, hash: known.hash, languageId: known.languageId });
          continue;
        }
        guard(workbench, signal);
        await this.options.assertActive?.();
        const original = originals[0];
        const response = await workbench.call<{ recoveredUri: string; originalUri: string; savedToDisk: boolean }>('recovery.restore', structuredClone(original), { signal });
        if (!response || typeof response.recoveredUri !== 'string' || !response.recoveredUri.startsWith('untitled:') || response.savedToDisk !== false || response.originalUri !== original.uri) throw new Error('Eve could not confirm that the recovered draft opened. Its recovery copy is still available.');
        const restored = { uri: response.recoveredUri, text: original.text, hash: original.hash, languageId: original.languageId };
        this.restored.set(key, restored);
        recovered.push({ originalUris: [...new Set(originals.map(document => document.uri))], recoveredUri: restored.uri, hash: restored.hash, languageId: restored.languageId });
      }
      guard(workbench, signal);
      await this.options.assertActive?.();
      const durable = await workbench.captureDurableRecovery({ signal });
      guard(workbench, signal);
      for (const [key] of draftGroups) {
        const expected = this.restored.get(key)!;
        const document = durable.find(document => document.uri === expected.uri);
        if (!document || !document.untitled || !document.dirty || document.text !== expected.text || document.hash !== expected.hash || document.languageId !== expected.languageId) throw new Error('Eve could not confirm that the recovered draft was saved. All original recovery copies are still available.');
      }
      await this.options.assertActive?.();
      await workbench.acknowledgeRecovery(batch);
      this.approved = undefined;
      const remaining = await workbench.loadRecoveryBatch();
      return this.report({ status: remaining.documents.length || remaining.unrecognizedFiles.length ? 'pending' : 'recovered', restored: recovered.length,
        pending: remaining.documents.length, unknownFiles: remaining.unrecognizedFiles, recovered,
        canReconcileOriginals: remaining.documents.length === 0 && remaining.unrecognizedFiles.length === 0,
        message: remaining.documents.length || remaining.unrecognizedFiles.length ? 'Your chosen drafts were recovered. More drafts are available to review.' : 'Your recovered drafts are open in new tabs. Save them when you are ready; your original files are unchanged.',
      });
    } catch (error) {
      return this.report({ ...base(), status: signal?.aborted ? 'cancelled' : recovered.length ? 'partial' : 'pending', message: error instanceof Error ? error.message : 'Recovery could not finish. Your recovery copies are still available.' });
    }
  }
}
