import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntentService, type IntentResponse } from '../../apps/desktop/host/intents';
import { CoreStore } from "../../packages/core/src/index";
import {
  ALL_CAPABILITIES,
  type AuthenticatedContext,
  type WorkspaceEditRecord,
  type WorkspaceEditDispatch,
  type WorkspaceEditReceipt,
} from "../../packages/contracts/src/index";
import type {
  DocumentState,
  EditRequest,
} from "../../extensions/eve-workbench/src/protocol";
import {
  captureWorkspace,
  planWorkspaceEdit,
  type WorkspaceOwner,
} from "../../apps/desktop/host/workspace-plan";
import {
  WorkspaceEdits,
  type WorkspaceEditReview,
} from "../../apps/desktop/host/workspace-edits";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const auth: AuthenticatedContext = {
  actorId: "desktop",
  origin: "trusted-ui",
  capabilities: [...ALL_CAPABILITIES],
};
const must = <T extends { ok: boolean }>(
  value: T,
): Extract<T, { ok: true }> => {
  expect(value.ok, JSON.stringify(value)).toBe(true);
  return value as Extract<T, { ok: true }>;
};
let directory: string,
  core: CoreStore,
  owner: WorkspaceOwner,
  documents: DocumentState[],
  nativeCalls: number;
let hook:
  ((method: string, payload: unknown, value: unknown) => void) | undefined;
let nativeMode:
  "normal" | "lost-after-apply" | "changed-after-apply" | "wrong-receipt";
const review: WorkspaceEditReview = {
  requestId: "reviewed-code",
  intentRequestId: "intent-code",
  proposalId: "proposal-code",
  contextSnapshotId: "context-code",
  contextHash: hash("frozen-review"),
  label: "Soften the card transition",
};
beforeEach(() => {
  directory = mkdtempSync(
    path.join(realpathSync(tmpdir()), "eve-workspace-coordinator-"),
  );
  const root = path.join(directory, "project");
  mkdirSync(root);
  const stat = statSync(root);
  core = new CoreStore({ dbPath: path.join(directory, "eve.db"), seed: false });
  const created = must(
    core.dispatch(
      {
        type: "CreateTask",
        requestId: "create-space",
        title: "My timer",
        kind: "project",
      },
      auth,
    ),
  );
  const task = created.snapshot.tasks.find(
    (task) => task.id === created.snapshot.activeTaskId,
  )!;
  const registered = must(
    core.registerProject(
      {
        requestId: "register",
        taskId: task.id,
        expectedEpoch: task.epoch,
        expectedTaskRevision: task.revision,
        project: {
          id: "project",
          canonicalRoot: root,
          rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
          kind: "external",
          adapter: "generic",
          preview: { kind: "none" },
        },
      },
      auth,
    ),
  );
  const current = registered.snapshot.tasks.find(
    (task) => task.id === registered.snapshot.activeTaskId,
  )!;
  owner = {
    taskId: current.id,
    taskEpoch: current.epoch,
    taskRevision: current.revision,
    policyRevision: current.policy.revision,
    processing: current.policy.processing,
    project: registered.project,
    serviceInstanceId: "host-instance",
    serviceGeneration: 1,
  };
  documents = ["const duration = 100;", 'const easing = "linear";'].map(
    (text, index) => ({
      uri: pathToFileURL(path.join(root, index ? "motion.ts" : "timer.ts"))
        .href,
      text,
      version: 1,
      hash: hash(text),
      bytes: Buffer.byteLength(text),
      dirty: true,
      untitled: false,
      languageId: "typescript",
    }),
  );
  nativeCalls = 0;
  hook = undefined;
  nativeMode = "normal";
});
afterEach(() => {
  core.close();
  rmSync(directory, { recursive: true, force: true });
});
function plan() {
  const capture = captureWorkspace({
    owner,
    documents: documents.map((document, index) => ({
      document: { ...document, text: document.text! },
      relativePath: index ? "motion.ts" : "timer.ts",
      selection: {
        anchor: { line: 0, character: 0 },
        active: { line: 0, character: document.text!.length },
      },
      selectedText: document.text!,
    })),
  });
  return planWorkspaceEdit(capture, {
    type: "ProposeWorkspaceEdit",
    targetId: capture.target.id,
    expectedRevision: capture.target.revision,
    edits: [
      { path: "timer.ts", before: "duration = 100", after: "duration = 280" },
      { path: "motion.ts", before: '"linear"', after: '"ease-out"' },
    ],
  });
}
async function callCore<T>(method: string, payload?: unknown): Promise<T> {
  let value: unknown;
  if (method === "lookup-workspace-edit")
    value = core.lookupWorkspaceEdit(payload, auth);
  else if (method === 'read-workspace-edit-request') value = core.readWorkspaceEditRequest(String(payload), auth);
  else if (method === 'cancel-prepared-workspace-edit') {
    const p = payload as { editId: string; dispatch: WorkspaceEditDispatch };
    value = core.cancelPreparedWorkspaceEdit(p.editId, p.dispatch, auth);
  }
  else if (method === "prepare-workspace-edit")
    value = core.prepareWorkspaceEdit(payload, auth);
  else if (method === "dispatch-workspace-edit") {
    const p = payload as { editId: string; dispatch: WorkspaceEditDispatch };
    value = core.markWorkspaceEditDispatched(p.editId, p.dispatch, auth);
  } else if (method === "record-workspace-receipt") {
    const p = payload as { editId: string; receipt: WorkspaceEditReceipt };
    value = core.recordWorkspaceEditReceipt(p.editId, p.receipt, auth);
  } else if (method === "finalize-workspace-edit")
    value = core.finalizeWorkspaceEdit(String(payload), auth);
  else throw new Error("Unexpected coordinator method");
  hook?.(method, payload, value);
  return value as T;
}
function coordinator(client = callCore, reviewCheck?: ConstructorParameters<typeof WorkspaceEdits>[0]['assertReview']) {
  return new WorkspaceEdits({
    core: client,
    assertReview: async (plan, review) => {
      const current = core
        .snapshot()
        .tasks.find((task) => task.id === owner.taskId)!;
      if (
        current.revision !== owner.taskRevision ||
        current.epoch !== owner.taskEpoch ||
        current.policy.revision !== owner.policyRevision
      )
        throw new Error("Stale review");
      await reviewCheck?.(plan, review);
    },
    editor: async () => ({
      owner,
      assertCurrent: async () => {},
      inspect: async (uri) =>
        structuredClone(
          documents.find((document) => document.uri === uri) ?? null,
        ),
      apply: async (request: EditRequest) => {
        nativeCalls++;
        for (const replacement of request.documents) {
          const document = documents.find(
            (document) => document.uri === replacement.uri,
          )!;
          if (
            !document ||
            document.version !== replacement.expectedVersion ||
            document.hash !== replacement.expectedHash
          )
            throw new Error("Native version conflict");
        }
        for (const replacement of request.documents) {
          const document = documents.find(
            (document) => document.uri === replacement.uri,
          )!;
          Object.assign(document, {
            text: replacement.text,
            hash: hash(replacement.text),
            bytes: Buffer.byteLength(replacement.text),
            version: document.version + 1,
          });
        }
        if (nativeMode === "lost-after-apply")
          throw new Error("Reply lost after actual buffer mutation");
        return {
          operationId:
            nativeMode === "wrong-receipt"
              ? "another-operation"
              : request.operationId,
          applied: true,
          synchronized: nativeMode !== "changed-after-apply",
          documents: structuredClone(documents.filter(document => request.documents.some(replacement => replacement.uri === document.uri))),
        };
      },
    }),
  });
}
function pending(): WorkspaceEditRecord[] {
  return must(core.listPendingWorkspaceEdits(auth)).value;
}

describe("reviewed workspace coordinator with actual core transactions", () => {
  it('finishes a lost core receipt through the real intent status check after cancellation and task navigation, without native replay', async () => {
    const capturedDocument = { ...documents[0], text: documents[0].text! };
    const selection = { anchor: { line: 0, character: 0 }, active: { line: 0, character: capturedDocument.text.length } };
    const capture = captureWorkspace({ owner, documents: [{ relativePath: 'timer.ts', document: capturedDocument, selection, selectedText: capturedDocument.text }] });
    const responses: IntentResponse[] = []; let captures = 0, refused = false;
    let service!: IntentService;
    const edits = coordinator(async <T>(method: string, payload?: unknown): Promise<T> => {
      if (method === 'record-workspace-receipt' && !refused) { refused = true; throw new Error('Receipt transport failed before write'); }
      return callCore<T>(method, payload);
    }, (plan, review) => service.assertWorkspaceReview(plan, review));
    service = new IntentService({
      captureContext: async () => {
        captures++; return { snapshot: core.snapshot(), workspace: capture,
          workbenchContext: { workspace: [{ uri: pathToFileURL(owner.project.canonicalRoot).href, name: 'Project' }], documents: structuredClone(documents),
            active: { ...documents[0], selectedText: documents[0].text!, selectionTruncated: false, selections: [selection], visibleRanges: [] }, diagnostics: [] }, sources: [], selectedSourceId: null };
      },
      intelligence: { cancel: () => {}, syncCanonical: () => {}, request: async request => {
        const target = request.targets.find(target => target.kind === 'workspace')!;
        return { status: 'complete', requestId: request.intent.id, context: request.context, message: 'A reviewed code change.', basis: 'selection', citations: [], needsClarification: false,
          requiresUserAction: true, focusPolicy: 'preserve', origin: 'model-proposal', provider: null, usage: {},
          actions: [{ type: 'ProposeWorkspaceEdit', targetId: target.id, expectedRevision: target.revision, edits: [{ path: 'timer.ts', before: 'duration = 100', after: 'duration = 280' }] }] };
      } },
      dispatch: async input => core.dispatch(input, auth), executeRegistered: async () => {}, openSource: async () => {},
      applyWorkspace: (plan, review) => edits.apply(plan, review), settleWorkspace: requestId => edits.settleOnly(requestId), onEvent: event => responses.push(event.response),
    });
    try {
      const { requestId } = service.ask({ taskId: owner.taskId, text: 'Make this code slower.' });
      await vi.waitFor(() => expect(responses.at(-1)?.status).toBe('complete'));
      const proposalId = responses.at(-1)!.proposals[0].id;
      expect((await service.applyProposal({ requestId, proposalId })).proposals[0].status).toBe('uncertain');
      expect(nativeCalls).toBe(1); expect(pending()[0].status).toBe('dispatched');
      service.cancel(requestId);
      must(core.dispatch({ type: 'CreateTask', requestId: 'other-space', title: 'Another space' }, auth));
      const beforeCheck = captures, versions = documents.map(document => document.version);
      const settled = await service.applyProposal({ requestId, proposalId });
      expect(settled.proposals[0].status).toBe('applied'); expect(settled.status).toBe('cancelled');
      expect(captures).toBe(beforeCheck); expect(nativeCalls).toBe(1); expect(documents.map(document => document.version)).toEqual(versions);
      expect(pending()).toEqual([]); expect(core.snapshot().activeTaskId).not.toBe(owner.taskId);
    } finally { service.dispose(); }
  });
  it("journals both documents, applies once and settles one history receipt without retargeting on repeat", async () => {
    const planned = plan(),
      edits = coordinator();
    const result = await edits.apply(planned, review);
    expect(result.status).toBe("applied");
    expect(result.edit.status).toBe("finalized");
    expect(documents.map((document) => document.text)).toEqual([
      "const duration = 280;",
      'const easing = "ease-out";',
    ]);
    expect(nativeCalls).toBe(1);
    expect(pending()).toEqual([]);
    const replay = await edits.apply(planned, review);
    expect(replay.edit.id).toBe(result.edit.id);
    expect(replay.status).toBe("applied");
    expect(nativeCalls).toBe(1);
    expect(
      core
        .snapshot()
        .recentActions.filter(
          (operation) => operation.requestId === review.requestId,
        ),
    ).toHaveLength(1);
  });
  it("coalesces identical concurrent approvals and refuses a changed request under the same identity", async () => {
    const planned = plan(),
      edits = coordinator();
    const first = edits.apply(planned, review);
    const second = edits.apply(planned, review);
    await expect(
      edits.apply(planned, { ...review, label: "A different change" }),
    ).rejects.toThrow("identity");
    expect(first).toBe(second);
    expect((await first).status).toBe("applied");
    expect(nativeCalls).toBe(1);
  });
  it("retries a locally retained durable native acknowledgement after a core receipt write fails, without applying again", async () => {
    const planned = plan();
    let refused = false;
    // A transport failure leaves core dispatched; retry can record the retained acknowledgement.
    const edits = coordinator(
      async <T>(method: string, payload?: unknown): Promise<T> => {
        if (method === "record-workspace-receipt" && !refused) {
          refused = true;
          throw new Error("Core transport failed before receipt");
        }
        return callCore<T>(method, payload);
      },
    );
    expect((await edits.apply(planned, review)).status).toBe("uncertain");
    expect(pending()[0].status).toBe("dispatched");
    const versions = documents.map((document) => document.version);
    expect((await edits.settleOnly(review.requestId))?.status).toBe("applied");
    expect(documents.map((document) => document.version)).toEqual(versions);
    expect(nativeCalls).toBe(1);
  });
  it("resumes receipt/finalization after a lost committed receipt reply and a real core restart", async () => {
    const planned = plan(),
      edits = coordinator();
    hook = (method) => {
      if (method === "record-workspace-receipt")
        throw new Error("Committed reply lost");
    };
    expect((await edits.apply(planned, review)).status).toBe("uncertain");
    expect(pending()[0].status).toBe("receipt-recorded");
    core.close();
    core = new CoreStore({ dbPath: path.join(directory, "eve.db") });
    hook = undefined;
    expect((await coordinator().apply(planned, review)).status).toBe("applied");
    expect(nativeCalls).toBe(1);
  });
  it("does not replay when the native edit happened but its acknowledgement was lost, even after core restart", async () => {
    const planned = plan();
    nativeMode = "lost-after-apply";
    expect((await coordinator().apply(planned, review)).status).toBe(
      "uncertain",
    );
    expect(documents[0].text).toContain("280");
    expect(pending()[0].status).toBe("dispatched");
    core.close();
    core = new CoreStore({ dbPath: path.join(directory, "eve.db") });
    nativeMode = "normal";
    expect((await coordinator().apply(planned, review)).status).toBe(
      "uncertain",
    );
    expect(nativeCalls).toBe(1);
  });
  it("never dispatches after a lost durable dispatch reply, and does not guess that an unchanged buffer permits retry", async () => {
    const planned = plan(),
      edits = coordinator();
    hook = (method) => {
      if (method === "dispatch-workspace-edit")
        throw new Error("Dispatch committed but reply lost");
    };
    await expect(edits.apply(planned, review)).rejects.toThrow("reply lost");
    expect(nativeCalls).toBe(0);
    expect(pending()[0].status).toBe("dispatched");
    hook = undefined;
    expect((await edits.apply(planned, review)).status).toBe("uncertain");
    expect(nativeCalls).toBe(0);
  });
  it("refuses newer buffer versions before preparation and leaves newer text untouched", async () => {
    const planned = plan();
    documents[0].version++;
    await expect(coordinator().apply(planned, review)).rejects.toThrow(
      "changed",
    );
    expect(nativeCalls).toBe(0);
    expect(pending()).toEqual([]);
  });
  it('cancels its undispatched journal when typing makes the second validation stale', async () => {
    const planned = plan();
    hook = method => { if (method === 'prepare-workspace-edit') documents[0].version++; };
    expect((await coordinator().apply(planned, review)).status).toBe('blocked');
    expect(nativeCalls).toBe(0); expect(pending()).toEqual([]);
    expect(documents[0].text).toContain('100');
  });
  it('settles a lost preparation reply without retaining the full plan or ever calling native Apply', async () => {
    const planned = plan(), edits = coordinator();
    hook = method => { if (method === 'prepare-workspace-edit') throw new Error('Preparation committed but reply lost'); };
    await expect(edits.apply(planned, review)).rejects.toThrow('reply lost');
    expect(pending()[0].status).toBe('prepared'); hook = undefined;
    expect((await edits.settleOnly(review.requestId))?.status).toBe('blocked');
    expect(nativeCalls).toBe(0); expect(pending()).toEqual([]);
  });
  it('honours the unique durable dispatch owner when another caller already claimed that transition', async () => {
    const planned = plan();
    const edits = coordinator(async <T>(method: string, payload?: unknown): Promise<T> => {
      if (method === 'dispatch-workspace-edit') await callCore(method, payload);
      return callCore<T>(method, payload);
    });
    expect((await edits.apply(planned, review)).status).toBe('uncertain');
    expect(nativeCalls).toBe(0); expect(pending()[0].status).toBe('dispatched');
  });
  it.each(["changed-after-apply", "wrong-receipt"] as const)(
    "preserves uncertainty for %s instead of recording successful history",
    async (mode) => {
      const planned = plan();
      nativeMode = mode;
      expect((await coordinator().apply(planned, review)).status).toBe(
        "uncertain",
      );
      expect(pending()[0].status).toBe("dispatched");
      expect(
        core
          .snapshot()
          .recentActions.some(
            (operation) => operation.requestId === review.requestId,
          ),
      ).toBe(false);
    },
  );
});
