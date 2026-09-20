import type { DocumentState, RecoveryDocument } from './protocol';

type Identity = Pick<DocumentState, 'uri' | 'version' | 'hash'>;
export interface PreparedDurableEdit {
  /** Recheck preconditions immediately before dispatching the one native edit. */
  apply(): Promise<boolean>;
  inspect(): DocumentState[];
  intended: ReadonlyArray<{ uri: string; hash: string }>;
  /** Upper bound for retained post-edit snapshots (UTF-16 text plus document metadata). */
  maximumRecoveryBytes: number;
  /** Uses the shared serialized recovery writer; resolves only after its fsyncs. */
  recover(fallback: readonly DocumentState[]): Promise<RecoveryDocument[]>;
}
export interface DurableEditResult {
  operationId: string;
  applied: true;
  documents: RecoveryDocument[];
  synchronized: boolean;
}
interface Attempt {
  fingerprint: string;
  accepted: boolean;
  payload?: AttemptPayload;
}
interface AttemptPayload {
  edit: Omit<PreparedDurableEdit, 'apply' | 'maximumRecoveryBytes'>;
  post: Identity[];
  fallback: DocumentState[];
  cost: number;
  durable: boolean;
}
const same = (left: Identity, right: Identity) => left.uri === right.uri && left.version === right.version && left.hash === right.hash;
const identityBytes = (documents: ReadonlyArray<{ uri: string; hash: string }>) => documents.reduce((bytes, document) => bytes + 256 + 2 * (document.uri.length + document.hash.length), 0);
const snapshotBytes = (documents: readonly DocumentState[]) => documents.reduce((bytes, document) => bytes + 256 + 2 * (document.uri.length + document.hash.length + document.languageId.length + (document.text?.length ?? 0)), 0);

/** Session-local duplicate suppression, not a durable generic transaction receipt. */
export class DurableEditAcknowledgements {
  private readonly attempts = new Map<string, Attempt>();
  private queue: Promise<void> = Promise.resolve();
  private retainedBytes = 0;
  constructor(private readonly maximumAttempts = 4096, private readonly maximumRetainedBytes = 96 * 1024 * 1024) {}

  private reserve(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maximumRetainedBytes) throw new Error('The editor recovery byte limit would be exceeded. No edit was dispatched.');
    for (const attempt of this.attempts.values()) {
      if (this.retainedBytes + bytes <= this.maximumRetainedBytes) break;
      // Only discard already-durable payloads. The small operation-ID tombstone remains permanently.
      if (attempt.payload?.durable) {
        this.retainedBytes -= attempt.payload.cost;
        attempt.payload = undefined;
      }
    }
    if (this.retainedBytes + bytes > this.maximumRetainedBytes) throw new Error('The editor recovery byte limit is occupied by unconfirmed edits. Reconcile them before another edit.');
    this.retainedBytes += bytes;
  }

  private resize(payload: AttemptPayload, bytes: number) {
    this.retainedBytes += bytes - payload.cost;
    payload.cost = bytes;
  }

  run(operationId: string, fingerprint: string, prepare: () => Promise<PreparedDurableEdit>): Promise<DurableEditResult> {
    const pending = this.queue.then(() => this.perform(operationId, fingerprint, prepare));
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }

  private async perform(operationId: string, fingerprint: string, prepare: () => Promise<PreparedDurableEdit>): Promise<DurableEditResult> {
    let attempt = this.attempts.get(operationId);
    if (attempt && attempt.fingerprint !== fingerprint) throw new Error('An operation ID cannot be reused with another edit.');
    if (!attempt) {
      // Never evict an uncertain receipt and make its operation ID executable again.
      if (this.attempts.size >= this.maximumAttempts) throw new Error('The editor edit receipt limit was reached. Reconcile pending edits before restarting the workbench.');
      let prepared: PreparedDurableEdit | undefined = await prepare();
      const maximumRecoveryBytes = prepared.maximumRecoveryBytes;
      if (!Number.isSafeInteger(maximumRecoveryBytes) || maximumRecoveryBytes < 0) throw new Error('Invalid editor recovery byte bound.');
      const metadataBytes = identityBytes(prepared.intended) * 2;
      const cost = maximumRecoveryBytes + metadataBytes;
      this.reserve(cost);
      const payload: AttemptPayload = {
        // Do not cache the apply closure: it contains the complete requested replacement texts.
        edit: { inspect: prepared.inspect, recover: prepared.recover, intended: prepared.intended.map(document => ({ ...document })) },
        post: [], fallback: [], cost, durable: false,
      };
      attempt = { fingerprint, payload, accepted: false };
      // Reserve before native dispatch: rejection, exceptions and failed persistence cannot cause a second apply.
      this.attempts.set(operationId, attempt);
      let applied: Promise<boolean> | undefined;
      try { applied = prepared.apply(); }
      catch { /* A transport/editor exception cannot establish that no edit occurred. */ }
      finally { prepared = undefined; }
      try { attempt.accepted = applied ? await applied : false; }
      catch { /* Do not dispatch again after an asynchronous native failure either. */ }
      try {
        const captured = payload.edit.inspect();
        payload.post = captured.map(({ uri, version, hash }) => ({ uri, version, hash }));
        // A violated adapter bound cannot expand the retained cache. Fresh capture still runs below;
        // no successful acknowledgement is possible without matching durable/current identities.
        if (snapshotBytes(captured) <= maximumRecoveryBytes) payload.fallback = captured.map(document => ({ ...document }));
      } catch { /* Recovery below remains required even when inspection fails. */ }
      this.resize(payload, identityBytes(payload.edit.intended) + identityBytes(payload.post) + snapshotBytes(payload.fallback));
    }
    const payload = attempt.payload;
    if (!payload) throw new Error('EDIT_RECEIPT_COMPACTED: This operation was already dispatched. Reconcile its current document state; it will not be applied again.');

    let recovered: RecoveryDocument[];
    try {
      recovered = await payload.edit.recover(payload.fallback);
      // The exact captured text now has durable recovery; future retries capture current documents afresh.
      payload.fallback = [];
      payload.durable = true;
      this.resize(payload, identityBytes(payload.edit.intended) + identityBytes(payload.post));
    } catch {
      throw new Error(attempt.accepted
        ? 'EDIT_APPLIED_RECOVERY_FAILED: The editor accepted the change, but durable recovery was not confirmed. Reconcile or save the buffer; retrying this operation will not apply it again.'
        : 'EDIT_OUTCOME_UNCERTAIN: The editor did not acknowledge the change and durable recovery was not confirmed. Reconcile the buffer before another edit.');
    }
    if (!attempt.accepted) throw new Error('EDIT_OUTCOME_UNCERTAIN: The editor did not acknowledge the change. Its available buffers were durably captured; this operation will not be applied again.');

    let current: DocumentState[] = [];
    try { current = payload.edit.inspect(); } catch { /* Closed/unavailable documents are not synchronized. */ }
    const targets = new Set(payload.edit.intended.map(document => document.uri));
    const documents = payload.edit.intended.flatMap(intended => recovered.filter(document => document.uri === intended.uri));
    const synchronized = payload.post.length === targets.size && payload.edit.intended.every(intended => {
      const post = payload.post.find(document => document.uri === intended.uri);
      return post?.hash === intended.hash
        && documents.some(document => same(document, post))
        && current.some(document => same(document, post));
    });
    return { operationId, applied: true, documents, synchronized };
  }
}
