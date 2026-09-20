import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoreStore } from "@eve/core";
import { ALL_CAPABILITIES } from "@eve/contracts";
import type { WorkbenchContext } from "../../extensions/eve-workbench/src/protocol";
import {
  IntentService,
  type CapturedIntentContext,
  type IntentResponse,
} from "../../apps/desktop/host/intents";
import {
  captureWorkspace,
  type WorkspacePlan,
} from "../../apps/desktop/host/workspace-plan";
import {
  buildCanonicalInput,
  buildIntentRequest,
} from "../../apps/desktop/host/intent-context";
import {
  canonicalBinding,
  canonicalState,
} from "../../apps/desktop/host/model-worker";
import type { AgentRequest } from "../../packages/agent/src/contracts";
import { prepareContext } from "../../packages/agent/src/context";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const auth = {
  actorId: "desktop",
  origin: "trusted-ui" as const,
  capabilities: [...ALL_CAPABILITIES],
};
let store: CoreStore, service: IntentService, captured: CapturedIntentContext;
let responses: IntentResponse[],
  requests: AgentRequest[],
  applied: WorkspacePlan[];
beforeEach(() => {
  store = new CoreStore({
    dbPath: ":memory:",
    orbitProjectPath: "/projects/orbit",
  });
  const initial = store.snapshot().tasks.find((task) => task.id === "orbit")!;
  expect(
    store.verifyProject(
      {
        requestId: "verify",
        taskId: "orbit",
        expectedEpoch: initial.epoch,
        expectedTaskRevision: initial.revision,
        projectId: initial.project!.id,
        expectedProjectRevision: initial.project!.revision,
        rootIdentity: { device: "1", inode: "99" },
        kind: "managed",
        adapter: "orbit",
        preview: { kind: "static", entry: "index.html" },
      },
      auth,
    ).ok,
  ).toBe(true);
  const task = store.snapshot().tasks.find((task) => task.id === "orbit")!;
  const text = "PRIVATE_PREFIX const speed = 1; PRIVATE_SUFFIX",
    selectedText = "const speed = 1;";
  const selection = {
    anchor: { line: 0, character: 15 },
    active: { line: 0, character: 31 },
  };
  const document = {
    uri: "file:///projects/orbit/src/app.ts",
    version: 12,
    text,
    hash: hash(text),
    bytes: Buffer.byteLength(text),
    languageId: "typescript",
    dirty: true,
    untitled: false,
  };
  const workbenchContext: WorkbenchContext = {
    workspace: [{ uri: "file:///projects/orbit", name: "Orbit" }],
    documents: [document],
    active: {
      ...document,
      selectedText,
      selectionTruncated: false,
      selections: [selection],
      visibleRanges: [],
    },
    diagnostics: [],
  };
  const workspace = captureWorkspace({
    owner: {
      taskId: task.id,
      taskEpoch: task.epoch,
      taskRevision: task.revision,
      policyRevision: task.policy.revision,
      processing: task.policy.processing,
      project: task.project!,
      serviceInstanceId: "host-instance",
      serviceGeneration: 1,
    },
    documents: [
      { relativePath: "src/app.ts", document, selection, selectedText },
    ],
  });
  captured = {
    snapshot: store.snapshot(),
    workbenchContext,
    workspace,
    sources: [],
    selectedSourceId: null,
  };
  responses = [];
  requests = [];
  applied = [];
  service = new IntentService({
    captureContext: async () => ({
      ...structuredClone(captured),
      snapshot: store.snapshot(),
    }),
    intelligence: {
      cancel: () => {},
      syncCanonical: () => {},
      request: async (request) => {
        requests.push(request);
        const target = request.targets.find(
          (target) => target.kind === "workspace",
        )!;
        return {
          requestId: request.intent.id,
          status: "complete",
          origin: "model-proposal",
          context: request.context,
          message: "A bounded selected-code proposal.",
          basis: "selection",
          citations: [],
          needsClarification: false,
          requiresUserAction: true,
          focusPolicy: "preserve",
          usage: {},
          provider: null,
          actions: [
            {
              type: "ProposeWorkspaceEdit",
              targetId: target.id,
              expectedRevision: target.revision,
              edits: [
                { path: "src/app.ts", before: "speed = 1", after: "speed = 2" },
              ],
            },
          ],
        };
      },
    },
    dispatch: async (command) => store.dispatch(command, auth),
    executeRegistered: async () => {},
    openSource: async () => {},
    applyWorkspace: async (plan, review) => {
      await service.assertWorkspaceReview(plan, review);
      applied.push(plan);
      throw new Error(
        "Injected acknowledgement loss at the coordinator boundary",
      );
    },
    onEvent: (event) => responses.push(event.response),
  });
});
afterEach(() => {
  service.dispose();
  store.close();
});
async function ask() {
  const { requestId } = service.ask({
    taskId: "orbit",
    text: "Make the selected code slower.",
  });
  await vi.waitFor(() =>
    expect(
      responses.find(
        (response) =>
          response.requestId === requestId && response.status === "complete",
      ),
    ).toBeTruthy(),
  );
  return responses
    .filter((response) => response.requestId === requestId)
    .at(-1)!;
}

it("sends only selected file bytes and accurate original offsets through the actual context builder", () => {
  const built = buildIntentRequest({
    ...captured,
    taskId: "orbit",
    text: "Change this code.",
    requestId: "request",
    generation: 1,
  });
  const target = built.request.targets.find(
    (target) => target.kind === "workspace",
  )!;
  expect(target.files).toEqual([
    {
      path: "src/app.ts",
      content: "const speed = 1;",
      contentRange: {
        start: 15,
        end: 31,
        total: captured.workspace!.documents[0].text.length,
      },
    },
  ]);
  const wire = prepareContext(built.request, "cloud").input.data;
  expect(wire).not.toContain("PRIVATE_PREFIX");
  expect(wire).not.toContain("PRIVATE_SUFFIX");
  expect(
    canonicalBinding(built.request, canonicalState(built.canonical, 1)),
  ).not.toBeNull();
  captured.workbenchContext!.active!.selections[0].anchor.character++;
  expect(
    canonicalBinding(
      built.request,
      canonicalState(buildCanonicalInput(captured), 2),
    ),
  ).toBeNull();
});

it("previews every changed passage as literal code and reaches the private coordinator only after Apply", async () => {
  const response = await ask(),
    proposal = response.proposals[0];
  expect(proposal).toMatchObject({
    kind: "workspace",
    status: "ready",
    files: [
      {
        path: "src/app.ts",
        changes: [
          {
            before: "speed = 1",
            after: "speed = 2",
            startLine: 1,
            startColumn: 22,
            endLine: 1,
            endColumn: 31,
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(response)).not.toContain("PRIVATE_PREFIX");
  expect(applied).toEqual([]);
  const input = { requestId: response.requestId, proposalId: proposal.id };
  const result = await service.applyProposal(input);
  expect(result.proposals[0].status).toBe("uncertain");
  expect(applied).toHaveLength(1);
  expect(applied[0].documents[0].afterText).toBe(
    "PRIVATE_PREFIX const speed = 2; PRIVATE_SUFFIX",
  );
  await service.applyProposal(input);
  expect(applied).toHaveLength(1);
});

it("a selection change or forged replacement identity cannot reach the coordinator", async () => {
  const response = await ask();
  expect(() =>
    service.applyProposal({
      requestId: response.requestId,
      proposalId: "forged",
    }),
  ).toThrow("not available");
  captured.workbenchContext!.active!.version++;
  captured.workbenchContext!.documents[0].version++;
  const result = await service.applyProposal({
    requestId: response.requestId,
    proposalId: response.proposals[0].id,
  });
  expect(result.proposals[0].status).toBe("stale");
  expect(applied).toEqual([]);
});

it("discard drops the private plan and never runs a native edit", async () => {
  const response = await ask(),
    input = {
      requestId: response.requestId,
      proposalId: response.proposals[0].id,
    };
  service.discardProposal(input);
  expect((await service.applyProposal(input)).proposals[0].status).toBe(
    "discarded",
  );
  expect(applied).toEqual([]);
});
