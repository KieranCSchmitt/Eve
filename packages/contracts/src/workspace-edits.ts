import { z } from 'zod';
import type { CoreFailure, CoreSnapshot, OperationRecord } from './index';

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rootIdentity = z.object({ device: z.string().regex(/^(0|[1-9]\d{0,19})$/), inode: z.string().regex(/^(0|[1-9]\d{0,19})$/) }).strict()
  .refine(value => { try { return BigInt(value.device) <= 18446744073709551615n && BigInt(value.inode) <= 18446744073709551615n; } catch { return false; } }, 'Filesystem identity exceeds uint64.');
export const workspaceRelativePathSchema = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/[\u0000-\u001f\u007f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'), 'Use a safe relative project path.');
export const WORKSPACE_DOCUMENT_BYTES = 1024 * 1024;
export const WORKSPACE_TOTAL_BYTES = 4 * 1024 * 1024;
function wellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
// UTF-8 encoders replace lone surrogates with U+FFFD. Refuse such strings before
// hashing so two different UTF-16 documents cannot claim the same byte evidence.
const workspaceText = z.string().max(WORKSPACE_DOCUMENT_BYTES).refine(wellFormedText, 'Workspace text must contain complete Unicode characters.');
export const workspaceEditDocumentSchema = z.object({
  relativePath: workspaceRelativePathSchema, expectedDocumentVersion: revision,
  beforeText: workspaceText, beforeHash: hash,
  afterText: workspaceText, afterHash: hash,
}).strict();
export const prepareWorkspaceEditSchema = z.object({
  requestId: id, taskId: id, expectedEpoch: revision, expectedTaskRevision: revision,
  projectId: id, expectedProjectRevision: revision, expectedRootIdentity: rootIdentity, expectedPolicyRevision: revision,
  serviceInstanceId: id, serviceGeneration: revision,
  review: z.object({ intentRequestId: id, proposalId: id, contextSnapshotId: id, contextHash: hash, selection: z.object({ artifactId: id, revision }).strict().optional() }).strict(),
  label: z.string().trim().min(1).max(160), documents: z.array(workspaceEditDocumentSchema).min(1).max(8), undoOf: id.optional(),
}).strict().superRefine((value, context) => {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  if (new Set(value.documents.map(document => document.relativePath)).size !== value.documents.length) context.addIssue({ code: 'custom', message: 'Duplicate workspace document paths.' });
  for (const document of value.documents) if (bytes(document.beforeText) > WORKSPACE_DOCUMENT_BYTES || bytes(document.afterText) > WORKSPACE_DOCUMENT_BYTES || document.beforeText === document.afterText) context.addIssue({ code: 'custom', message: 'Workspace documents must fit the byte limit and contain a change.' });
  if (value.documents.reduce((sum, document) => sum + bytes(document.beforeText), 0) > WORKSPACE_TOTAL_BYTES || value.documents.reduce((sum, document) => sum + bytes(document.afterText), 0) > WORKSPACE_TOTAL_BYTES) context.addIssue({ code: 'custom', message: 'Workspace text exceeds the total before/after byte limit.' });
});
export type PrepareWorkspaceEditInput = z.infer<typeof prepareWorkspaceEditSchema>;
export type WorkspaceEditDocument = z.infer<typeof workspaceEditDocumentSchema>;
export const workspaceEditDispatchSchema = z.object({ planHash: hash, serviceInstanceId: id, serviceGeneration: revision }).strict();
export type WorkspaceEditDispatch = z.infer<typeof workspaceEditDispatchSchema>;
export const workspaceEditReceiptSchema = workspaceEditDispatchSchema.extend({
  operationId: id,
  documents: z.array(z.object({ relativePath: workspaceRelativePathSchema, afterHash: hash, documentVersion: revision }).strict()).min(1).max(8),
  /** Attests a live extension acknowledgement after orphan fsync; not a durable native operation ledger. */
  recovery: z.object({ kind: z.literal('acknowledged-orphan-v1') }).strict(),
}).strict();
export type WorkspaceEditReceipt = z.infer<typeof workspaceEditReceiptSchema>;
export const workspaceEditObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('live-editor'), serviceInstanceId: id, serviceGeneration: revision,
    documents: z.array(z.object({ relativePath: workspaceRelativePathSchema, hash, documentVersion: revision }).strict()).min(1).max(8),
  }).strict(),
]);
export type WorkspaceEditObservation = z.infer<typeof workspaceEditObservationSchema>;
export const workspaceEditStatusSchema = z.enum(['prepared', 'dispatched', 'receipt-recorded', 'finalized', 'conflict', 'aborted']);
export interface WorkspaceEditRecord {
  id: string; requestId: string; taskId: string; projectId: string; projectRoot: string;
  status: z.infer<typeof workspaceEditStatusSchema>; planHash: string; input: PrepareWorkspaceEditInput;
  restored: boolean; receipt: WorkspaceEditReceipt | null; operation: OperationRecord | null;
  createdAt: number; updatedAt: number;
}
export type WorkspaceEditResult = { ok: true; edit: WorkspaceEditRecord } | CoreFailure;
export type DispatchWorkspaceEditResult = { ok: true; edit: WorkspaceEditRecord; dispatched: boolean } | CoreFailure;
export type PrepareWorkspaceEditResult = { ok: true; edit: WorkspaceEditRecord; resumed: boolean } | CoreFailure;
export type LookupWorkspaceEditResult = { ok: true; value: { edit: WorkspaceEditRecord; snapshot: CoreSnapshot } | null } | CoreFailure;
export type ReconcileWorkspaceEditResult = { ok: true; edit: WorkspaceEditRecord; action: 'retry' | 'finalize' | 'review' | 'complete' | 'aborted' } | CoreFailure;
