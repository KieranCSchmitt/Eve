import { createHash } from "node:crypto";
import {
  prepareWorkspaceEditSchema,
  type LookupWorkspaceEditResult,
  type PrepareWorkspaceEditInput,
  type PrepareWorkspaceEditResult,
  type WorkspaceEditRecord,
  type WorkspaceEditReceipt,
  type WorkspaceEditResult,
  type DispatchWorkspaceEditResult,
  type CoreValueResult,
} from "@eve/contracts";
import type {
  DocumentState,
  EditRequest,
} from "../../../extensions/eve-workbench/src/protocol";
import {
  assertWorkspaceCurrent,
  type WorkspaceOwner,
  type WorkspacePlan,
} from "./workspace-plan";
import type { CoreClient } from "./project-edits";

export interface WorkspaceEditReview {
  requestId: string;
  intentRequestId: string;
  proposalId: string;
  contextSnapshotId: string;
  contextHash: string;
  selection?: { artifactId: string; revision: number };
  label: string;
}
export interface WorkspaceEditorLease {
  owner: WorkspaceOwner;
  inspect(uri: string): Promise<DocumentState | null>;
  apply(input: EditRequest): Promise<unknown>;
  /** Check project trust/filesystem identity and that this exact live instance is still admitted. */
  assertCurrent(): Promise<void>;
}
export interface WorkspaceEditsOptions {
  core: CoreClient;
  /** Never start or retarget an editor here. Return the actual existing captured instance. */
  editor(plan: WorkspacePlan): Promise<WorkspaceEditorLease>;
  /** Check the original intent, selection, sources, policy and explicit review authority. */
  assertReview(plan: WorkspacePlan, review: WorkspaceEditReview): Promise<void>;
}
export type WorkspaceApplyResult = {
  status: "applied" | "uncertain" | "blocked";
  edit: WorkspaceEditRecord;
  message: string;
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function preparation(
  plan: WorkspacePlan,
  review: WorkspaceEditReview,
): PrepareWorkspaceEditInput {
  const owner = plan.owner;
  return prepareWorkspaceEditSchema.parse({
    requestId: review.requestId,
    taskId: owner.taskId,
    expectedEpoch: owner.taskEpoch,
    expectedTaskRevision: owner.taskRevision,
    projectId: owner.project.id,
    expectedProjectRevision: owner.project.revision,
    expectedRootIdentity: owner.project.rootIdentity,
    expectedPolicyRevision: owner.policyRevision,
    serviceInstanceId: owner.serviceInstanceId,
    serviceGeneration: owner.serviceGeneration,
    review: {
      intentRequestId: review.intentRequestId,
      proposalId: review.proposalId,
      contextSnapshotId: review.contextSnapshotId,
      contextHash: review.contextHash,
      ...(review.selection ? { selection: review.selection } : {}),
    },
    label: review.label,
    documents: plan.documents.map((document) => ({
      relativePath: document.relativePath,
      expectedDocumentVersion: document.beforeVersion,
      beforeText: document.beforeText,
      beforeHash: document.beforeHash,
      afterText: document.afterText,
      afterHash: document.afterHash,
    })),
  });
}
function nativeReceipt(
  raw: unknown,
  edit: WorkspaceEditRecord,
  plan: WorkspacePlan,
): WorkspaceEditReceipt {
  if (!raw || typeof raw !== "object")
    throw new Error(
      "The editor did not return a durable edit acknowledgement.",
    );
  const value = raw as {
    operationId?: unknown;
    applied?: unknown;
    synchronized?: unknown;
    documents?: unknown;
  };
  if (
    value.operationId !== edit.id ||
    value.applied !== true ||
    value.synchronized !== true ||
    !Array.isArray(value.documents) ||
    value.documents.length !== plan.documents.length
  )
    throw new Error(
      "The editor result is incomplete or changed after applying.",
    );
  const seen = new Set<string>();
  const documents = plan.documents.map((document) => {
    const matching = (value.documents as DocumentState[]).filter(
      (item) => item?.uri === document.uri,
    );
    const current = matching[0];
    if (
      matching.length !== 1 ||
      seen.has(current.uri) ||
      current.untitled ||
      !Number.isSafeInteger(current.version) ||
      current.version <= document.beforeVersion ||
      current.hash !== document.afterHash ||
      typeof current.text !== "string" ||
      current.text !== document.afterText ||
      digest(current.text) !== document.afterHash
    )
      throw new Error(
        "The editor acknowledgement does not match the complete reviewed change.",
      );
    seen.add(current.uri);
    return {
      relativePath: document.relativePath,
      afterHash: current.hash,
      documentVersion: current.version,
    };
  });
  return {
    operationId: edit.id,
    planHash: edit.planHash,
    serviceInstanceId: plan.owner.serviceInstanceId,
    serviceGeneration: plan.owner.serviceGeneration,
    documents,
    recovery: { kind: "acknowledged-orphan-v1" },
  };
}

/** Serialise through the host mutation gate when integrating. Neither a lost reply nor an unchanged
 * disk file authorises replay: only a preparation that was never dispatched may reach apply().
 */
export class WorkspaceEdits {
  private running = new Map<
    string,
    { fingerprint: string; promise: Promise<WorkspaceApplyResult> }
  >();
  // A confirmed native receipt is small; keep it across a failed core reply so retry only records it.
  private receipts = new Map<
    string,
    { inputFingerprint: string; receipt: WorkspaceEditReceipt }
  >();
  private settlements = new Map<string, string>();
  private settling = new Map<string, Promise<WorkspaceApplyResult | null>>();
  constructor(private readonly options: WorkspaceEditsOptions) {}

  apply(
    plan: WorkspacePlan,
    review: WorkspaceEditReview,
  ): Promise<WorkspaceApplyResult> {
    const input = preparation(plan, review);
    const fingerprint = digest(JSON.stringify(input));
    const existing = this.running.get(input.requestId);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(
            new Error(
              "This reviewed request identity belongs to another change.",
            ),
          );
    if (this.running.size >= 4)
      return Promise.reject(
        new Error(
          "Let the current reviewed changes finish before applying another.",
        ),
      );
    if (this.settlements.size >= 128 && !this.settlements.has(input.requestId))
      return Promise.reject(
        new Error(
          "Reconcile the existing editor acknowledgements before applying another change.",
        ),
      );
    const retained = this.receipts.get(input.requestId);
    if (
      (retained && retained.inputFingerprint !== fingerprint) ||
      (this.settlements.has(input.requestId) &&
        this.settlements.get(input.requestId) !== fingerprint)
    )
      return Promise.reject(
        new Error(
          "This request identity belongs to an acknowledged editor change.",
        ),
      );
    this.settlements.set(input.requestId, fingerprint);
    const promise = this.run(
      structuredClone(plan),
      structuredClone(review),
      input,
      fingerprint,
    ).finally(() => {
      this.running.delete(input.requestId);
    });
    this.running.set(input.requestId, { fingerprint, promise });
    return promise;
  }

  /** An explicit status check can record an already received acknowledgement or finish history.
   * It never acquires an editor, collects new edit authority, or calls native apply. */
  settleOnly(requestId: string): Promise<WorkspaceApplyResult | null> {
    const active = this.running.get(requestId);
    if (active) return active.promise;
    const previous = this.settling.get(requestId);
    if (previous) return previous;
    const fingerprint = this.settlements.get(requestId);
    if (!fingerprint)
      return Promise.reject(
        new Error("This session has no settlement handle for that review."),
      );
    const operation = (async () => {
      const read = await this.options.core<
        CoreValueResult<WorkspaceEditRecord | null>
      >("read-workspace-edit-request", requestId);
      if (!read.ok) throw new Error(read.error.message);
      if (!read.value) {
        this.settlements.delete(requestId);
        return null;
      }
      if (
        digest(
          JSON.stringify(prepareWorkspaceEditSchema.parse(read.value.input)),
        ) !== fingerprint
      )
        throw new Error(
          "The recorded change does not match this approved review.",
        );
      if (read.value.status === "prepared" && !read.value.restored) {
        const cancelled = await this.cancelPrepared(read.value);
        return this.settle(cancelled, requestId, fingerprint);
      }
      return this.settle(read.value, requestId, fingerprint);
    })().finally(() => {
      this.settling.delete(requestId);
    });
    this.settling.set(requestId, operation);
    return operation;
  }

  private async cancelPrepared(
    edit: WorkspaceEditRecord,
  ): Promise<WorkspaceEditRecord> {
    const cancelled = await this.options.core<WorkspaceEditResult>(
      "cancel-prepared-workspace-edit",
      {
        editId: edit.id,
        dispatch: {
          planHash: edit.planHash,
          serviceInstanceId: edit.input.serviceInstanceId,
          serviceGeneration: edit.input.serviceGeneration,
        },
      },
    );
    if (!cancelled.ok) throw new Error(cancelled.error.message);
    return cancelled.edit;
  }

  private result(edit: WorkspaceEditRecord): WorkspaceApplyResult {
    if (edit.status === "finalized")
      return {
        status: "applied",
        edit,
        message: "Applied to the editor.",
      };
    if (edit.status === "aborted")
      return {
        status: "blocked",
        edit,
        message: "This reviewed change was cancelled before application.",
      };
    return {
      status: "uncertain",
      edit,
      message:
        "This change needs review. Eve preserved its evidence and has not repeated it.",
    };
  }
  private async settle(
    edit: WorkspaceEditRecord,
    requestId: string,
    fingerprint: string,
  ): Promise<WorkspaceApplyResult> {
    const retained = this.receipts.get(requestId);
    if (
      retained &&
      retained.inputFingerprint === fingerprint &&
      edit.status === "dispatched"
    ) {
      const recorded = await this.options.core<WorkspaceEditResult>(
        "record-workspace-receipt",
        { editId: edit.id, receipt: retained.receipt },
      );
      if (!recorded.ok) throw new Error(recorded.error.message);
      edit = recorded.edit;
    }
    if (edit.status === "receipt-recorded") {
      const finalized = await this.options.core<WorkspaceEditResult>(
        "finalize-workspace-edit",
        edit.id,
      );
      if (!finalized.ok) throw new Error(finalized.error.message);
      edit = finalized.edit;
    }
    if (edit.status === "finalized" || edit.status === "aborted") {
      this.receipts.delete(requestId);
      this.settlements.delete(requestId);
    }
    return this.result(edit);
  }
  private async validate(
    plan: WorkspacePlan,
    review: WorkspaceEditReview,
    editor: WorkspaceEditorLease,
  ): Promise<void> {
    await editor.assertCurrent();
    await this.options.assertReview(plan, review);
    const documents = await Promise.all(
      plan.documents.map((document) => editor.inspect(document.uri)),
    );
    if (documents.some((document) => !document))
      throw new Error(
        "A selected document is no longer open in its captured editor.",
      );
    assertWorkspaceCurrent(plan, editor.owner, documents as DocumentState[]);
    await editor.assertCurrent();
    await this.options.assertReview(plan, review);
  }
  private async run(
    plan: WorkspacePlan,
    review: WorkspaceEditReview,
    input: PrepareWorkspaceEditInput,
    fingerprint: string,
  ): Promise<WorkspaceApplyResult> {
    // Exact durable lookup comes first, including after task navigation or project relocation.
    const lookup = await this.options.core<LookupWorkspaceEditResult>(
      "lookup-workspace-edit",
      input,
    );
    if (!lookup.ok) throw new Error(lookup.error.message);
    let edit = lookup.value?.edit;
    if (edit && edit.status !== "prepared")
      return this.settle(edit, input.requestId, fingerprint);
    const editor = await this.options.editor(plan);
    try {
      await this.validate(plan, review, editor);
    } catch (error) {
      if (edit?.status === "prepared" && !edit.restored) {
        try {
          return await this.settle(
            await this.cancelPrepared(edit),
            input.requestId,
            fingerprint,
          );
        } catch {
          /* Preserve the unknown cancellation outcome for status reconciliation. */
        }
      }
      throw error;
    }
    const prepared = await this.options.core<PrepareWorkspaceEditResult>(
      "prepare-workspace-edit",
      input,
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    edit = prepared.edit;
    if (edit.status !== "prepared")
      return this.settle(edit, input.requestId, fingerprint);
    try {
      await this.validate(plan, review, editor);
    } catch {
      try {
        return await this.settle(
          await this.cancelPrepared(edit),
          input.requestId,
          fingerprint,
        );
      } catch {
        return this.result(edit);
      }
    }
    const dispatched = await this.options.core<DispatchWorkspaceEditResult>(
      "dispatch-workspace-edit",
      {
        editId: edit.id,
        dispatch: {
          planHash: edit.planHash,
          serviceInstanceId: plan.owner.serviceInstanceId,
          serviceGeneration: plan.owner.serviceGeneration,
        },
      },
    );
    if (!dispatched.ok) throw new Error(dispatched.error.message);
    edit = dispatched.edit;
    if (edit.status !== "dispatched" || !dispatched.dispatched)
      return this.settle(edit, input.requestId, fingerprint);
    try {
      // Core dispatch is durably reserved. No retry crosses this call again; native versions/hashes
      // are the final guard if the user typed while SQLite acknowledged the reservation.
      await editor.assertCurrent();
      await this.options.assertReview(plan, review);
      const raw = await editor.apply({
        operationId: edit.id,
        documents: plan.documents.map((document) => ({
          uri: document.uri,
          expectedVersion: document.beforeVersion,
          expectedHash: document.beforeHash,
          text: document.afterText,
        })),
      });
      const receipt = nativeReceipt(raw, edit, plan);
      this.receipts.set(input.requestId, {
        inputFingerprint: fingerprint,
        receipt,
      });
      return await this.settle(edit, input.requestId, fingerprint);
    } catch {
      // No rollback claim and no automatic replay. Exact retry can finish a locally retained receipt.
      return this.result(edit);
    }
  }
}
