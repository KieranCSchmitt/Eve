import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  lstat,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeEditor,
  type WorkspaceRuntimeSession,
} from "../../apps/desktop/host/workspace-runtime";
import { planWorkspaceEdit } from "../../apps/desktop/host/workspace-plan";
import type {
  DocumentState,
  WorkbenchContext,
} from "../../extensions/eve-workbench/src/protocol";

let root: string;
let file: string;
let context: WorkbenchContext;
let document: DocumentState & { text: string };
let session: WorkspaceRuntimeSession | null;
let editor: WorkspaceRuntimeEditor;
let runtime: WorkspaceRuntime;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "eve-workspace-runtime-")),
  );
  await mkdir(path.join(root, "src"));
  file = path.join(root, "src/app.ts");
  const text = "private prefix; const speed = 1; private suffix";
  await writeFile(file, text);
  document = {
    uri: pathToFileURL(file).href,
    version: 4,
    hash: digest(text),
    text,
    bytes: Buffer.byteLength(text),
    languageId: "typescript",
    eol: "lf",
    dirty: true,
    untitled: false,
  };
  context = {
    workspace: [{ uri: pathToFileURL(root).href, name: "test" }],
    active: {
      ...document,
      text: undefined,
      selections: [
        {
          anchor: { line: 0, character: 16 },
          active: { line: 0, character: 32 },
        },
      ],
      selectedText: text.slice(16, 32),
      selectionTruncated: false,
      visibleRanges: [],
    },
    documents: [{ ...document, text: undefined }],
    diagnostics: [],
  };
  const stat = await lstat(root, { bigint: true });
  editor = {
    connected: true,
    context: vi.fn(async () => structuredClone(context)),
    inspect: vi.fn(async () => structuredClone(document)),
    apply: vi.fn(async () => ({ applied: true })),
  };
  session = {
    owner: {
      taskId: "task",
      taskEpoch: 1,
      taskRevision: 1,
      policyRevision: 0,
      processing: "hybrid",
      project: {
        id: "project",
        revision: 1,
        canonicalRoot: root,
        rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
        kind: "external",
        adapter: "generic",
        preview: { kind: "none" },
        verification: "verified",
        createdAt: 0,
        updatedAt: 0,
      },
      serviceInstanceId: "instance",
      serviceGeneration: 1,
    },
    editor,
  };
  runtime = new WorkspaceRuntime(async () => session);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const capture = () => runtime.capture("task", structuredClone(context));
function plan(value: NonNullable<Awaited<ReturnType<typeof capture>>>) {
  return planWorkspaceEdit(value, {
    type: "ProposeWorkspaceEdit",
    targetId: value.target.id,
    expectedRevision: value.target.revision,
    edits: [{ path: "src/app.ts", before: "speed = 1", after: "speed = 2" }],
  });
}

describe("actual selected workspace runtime authority", () => {
  it("captures one actual passage privately and binds file plus ancestor identities before native apply", async () => {
    const result = (await capture())!;
    expect(result).not.toBeNull();
    expect(result.documents[0].text).toBe(document.text);
    expect(result.documents[0].eol).toBe("lf");
    expect(JSON.stringify(result.target)).not.toContain("private prefix");
    expect(
      result.documents[0].fileIdentity!.ancestors.map(
        (item) => item.relativePath,
      ),
    ).toEqual(["", "src"]);
    const prepared = plan(result),
      lease = await runtime.editor(prepared);
    expect((await lease.inspect(document.uri))?.hash).toBe(document.hash);
    await lease.apply({
      operationId: "reviewed",
      documents: prepared.documents.map((item) => ({
        uri: item.uri,
        expectedVersion: item.beforeVersion,
        expectedHash: item.beforeHash,
        text: item.afterText,
      })),
    });
    expect(editor.apply).toHaveBeenCalledOnce();
  });
  it("refuses a linked file or linked ancestor without inspecting or applying to a different target", async () => {
    await rename(file, file + ".original");
    await symlink(file + ".original", file);
    expect(await capture()).toBeNull();
    expect(editor.inspect).not.toHaveBeenCalled();
    await rm(file);
    await rename(file + ".original", file);
    await rename(path.join(root, "src"), path.join(root, "actual"));
    await symlink(path.join(root, "actual"), path.join(root, "src"));
    expect(await capture()).toBeNull();
  });
  it("invalidates same-text inode replacement while allowing a new capture bound to its new identity", async () => {
    const original = (await capture())!,
      oldPlan = plan(original);
    await writeFile(file + ".replacement", document.text);
    await rename(file + ".replacement", file);
    await expect(runtime.editor(oldPlan)).rejects.toThrow("changed");
    const fresh = (await capture())!;
    expect(fresh.target.id).not.toBe(original.target.id);
    await expect(runtime.editor(oldPlan)).rejects.toThrow("changed");
    await expect(runtime.editor(plan(fresh))).resolves.toBeDefined();
  });
  it("rejects file replacement during actual document inspection", async () => {
    vi.mocked(editor.inspect).mockImplementation(async () => {
      await rename(file, file + ".original");
      await writeFile(file, document.text);
      return document;
    });
    expect(await capture()).toBeNull();
    expect(runtime.current(session!.owner, context)).toBeNull();
  });
  it("rejects selection, policy and instance changes before or during capture", async () => {
    const original = (await capture())!;
    context.active!.selections[0].active.character--;
    expect(runtime.current(session!.owner, context)).toBeNull();
    await expect(runtime.editor(plan(original))).rejects.toThrow("changed");
    context.active!.selections[0].active.character++;
    vi.mocked(editor.inspect).mockImplementation(async () => {
      session!.owner.serviceGeneration++;
      return document;
    });
    expect(await capture()).toBeNull();
    expect(editor.apply).not.toHaveBeenCalled();
  });
  it("refuses unsupported, untitled, truncated, empty, multiple and oversized selections before retrieving full text", async () => {
    for (const change of [
      () => {
        context.active!.untitled = true;
      },
      () => {
        context.active!.selectionTruncated = true;
      },
      () => {
        context.active!.selectedText = "";
      },
      () => {
        context.active!.selections.push(context.active!.selections[0]);
      },
      () => {
        context.active!.bytes = 1_048_577;
      },
      () => {
        context.active!.selectedText = "x".repeat(4001);
      },
      () => {
        context.active!.uri = pathToFileURL(
          path.join(root, "eve.project.json"),
        ).href;
      },
    ]) {
      const previous = structuredClone(context);
      change();
      expect(await capture()).toBeNull();
      context = previous;
    }
    expect(editor.inspect).not.toHaveBeenCalled();
  });
  it("keeps captured authority immutable and refuses reconnects or mismatched planned files", async () => {
    const result = (await capture())!,
      prepared = plan(result);
    const lease = await runtime.editor(prepared);
    await expect(
      lease.apply({ operationId: "wrong", documents: [] }),
    ).rejects.toThrow("changed");
    await expect(
      lease.inspect(pathToFileURL(path.join(root, "other.ts")).href),
    ).rejects.toThrow("changed");
    session = { ...session!, editor: { ...editor } };
    await expect(lease.assertCurrent()).rejects.toThrow("changed");
    expect(editor.apply).not.toHaveBeenCalled();
  });
  it("drops edit capability after policy or trust loss while allowing the caller to keep a general question", async () => {
    const captured = (await capture())!;
    const changed = structuredClone(session!.owner);
    changed.policyRevision++;
    expect(runtime.current(changed, context)).toBeNull();
    await expect(runtime.editor(plan(captured))).rejects.toThrow("changed");
    runtime = new WorkspaceRuntime(async () => {
      throw new Error("Trust revoked");
    });
    expect(await capture()).toBeNull();
  });
});
