import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type {
  DocumentState,
  WorkbenchContext,
  EditRequest,
} from "../../../extensions/eve-workbench/src/protocol";
import {
  captureWorkspace,
  WORKSPACE_PLAN_LIMITS,
  type WorkspaceCapture,
  type WorkspaceOwner,
  type WorkspacePlan,
  type WorkspaceFileIdentity,
} from "./workspace-plan";
import type { WorkspaceEditorLease } from "./workspace-edits";

export interface WorkspaceRuntimeEditor {
  readonly connected: boolean;
  context(): Promise<WorkbenchContext>;
  inspect(uri: string): Promise<DocumentState | null>;
  apply(input: EditRequest): Promise<unknown>;
}
export interface WorkspaceRuntimeSession {
  owner: WorkspaceOwner;
  editor: WorkspaceRuntimeEditor;
}
interface PathProof {
  file: string;
  chain: { path: string; device: string; inode: string }[];
  fileState: {
    device: string;
    inode: string;
    size: string;
    modified: string;
    changed: string;
  };
}
function fail(): never {
  throw new Error(
    "The selected project file or editor changed. Select its current passage and ask again.",
  );
}
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
const selectionIdentity = (context: WorkbenchContext | null | undefined) => {
  const active = context?.active;
  return (
    active && {
      uri: active.uri,
      version: active.version,
      hash: active.hash,
      bytes: active.bytes,
      untitled: active.untitled,
      selections: active.selections,
      selectedText: active.selectedText,
      selectionTruncated: active.selectionTruncated,
    }
  );
};
function selectedPath(
  owner: WorkspaceOwner,
  context: WorkbenchContext,
): { file: string; relativePath: string } | null {
  const active = context.active;
  if (
    !active ||
    active.untitled ||
    active.selections.length !== 1 ||
    !active.selectedText ||
    active.selectionTruncated ||
    active.bytes > WORKSPACE_PLAN_LIMITS.documentBytes ||
    Buffer.byteLength(active.selectedText) > WORKSPACE_PLAN_LIMITS.excerptBytes
  )
    return null;
  let file: string;
  try {
    file = fileURLToPath(active.uri);
  } catch {
    return null;
  }
  if (pathToFileURL(file).href !== active.uri) return null;
  const relativePath = path.relative(owner.project.canonicalRoot, file);
  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === ".." ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.toLowerCase() === "eve.project.json"
  )
    return null;
  return { file, relativePath: relativePath.split(path.sep).join("/") };
}
async function inspectFile(
  file: string,
  owner: WorkspaceOwner,
): Promise<PathProof> {
  if (
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    (await realpath(file)) !== file
  )
    fail();
  const chain: PathProof["chain"] = [];
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (current === file ? !stat.isFile() : !stat.isDirectory())
    )
      fail();
    chain.push({
      path: current,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    });
  }
  const root = chain.find((item) => item.path === owner.project.canonicalRoot);
  if (
    !root ||
    !same(
      { device: root.device, inode: root.inode },
      owner.project.rootIdentity,
    )
  )
    fail();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    const last = chain.at(-1)!;
    if (
      !stat.isFile() ||
      stat.dev.toString() !== last.device ||
      stat.ino.toString() !== last.inode
    )
      fail();
    for (const item of chain) {
      const now = await lstat(item.path, { bigint: true });
      if (
        now.isSymbolicLink() ||
        now.dev.toString() !== item.device ||
        now.ino.toString() !== item.inode
      )
        fail();
    }
    const after = await handle.stat({ bigint: true });
    if (
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.ctimeNs !== after.ctimeNs
    )
      fail();
    return {
      file,
      chain,
      fileState: {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        size: stat.size.toString(),
        modified: stat.mtimeNs.toString(),
        changed: stat.ctimeNs.toString(),
      },
    };
  } finally {
    await handle.close();
  }
}

function fileIdentity(
  proof: PathProof,
  owner: WorkspaceOwner,
): WorkspaceFileIdentity {
  const root = owner.project.canonicalRoot;
  return {
    device: proof.fileState.device,
    inode: proof.fileState.inode,
    ancestors: proof.chain
      .filter(
        (item) =>
          item.path !== proof.file &&
          (item.path === root || item.path.startsWith(`${root}${path.sep}`)),
      )
      .map((item) => ({
        relativePath: path.relative(root, item.path).split(path.sep).join("/"),
        device: item.device,
        inode: item.inode,
      })),
  };
}

/** Private host capture/cache. It never opens files in the editor, starts a service,
 * grants project trust, changes a selection, or supplies full buffers to a model. */
export class WorkspaceRuntime {
  private captures = new Map<
    string,
    {
      capture: WorkspaceCapture;
      proof: PathProof;
      selection: ReturnType<typeof selectionIdentity>;
      editor: WorkspaceRuntimeEditor;
    }
  >();
  constructor(
    private readonly session: (
      taskId: string,
    ) => Promise<WorkspaceRuntimeSession | null>,
  ) {}
  clear(taskId?: string): void {
    if (taskId) this.captures.delete(taskId);
    else this.captures.clear();
  }
  current(
    owner: WorkspaceOwner | null,
    context: WorkbenchContext | null | undefined,
  ): WorkspaceCapture | null {
    if (!owner) return null;
    const retained = this.captures.get(owner.taskId);
    if (
      !retained ||
      !same(retained.capture.owner, owner) ||
      !same(retained.selection, selectionIdentity(context))
    ) {
      this.clear(owner.taskId);
      return null;
    }
    return retained.capture;
  }
  async capture(
    taskId: string,
    expected: WorkbenchContext,
  ): Promise<WorkspaceCapture | null> {
    expected = structuredClone(expected);
    try {
      const session = await this.session(taskId);
      if (!session || !session.editor.connected) {
        this.clear(taskId);
        return null;
      }
      const owner = structuredClone(session.owner);
      const selected = selectedPath(owner, expected);
      if (!selected) {
        this.clear(taskId);
        return null;
      }
      const proof = await inspectFile(selected.file, owner);
      const document = await session.editor.inspect(expected.active!.uri);
      const context = await session.editor.context();
      const current = await this.session(taskId);
      if (
        !current ||
        current.editor !== session.editor ||
        !same(current.owner, owner) ||
        !same(selectionIdentity(context), selectionIdentity(expected)) ||
        !document ||
        typeof document.text !== "string" ||
        document.version !== expected.active!.version ||
        document.hash !== expected.active!.hash ||
        !same(await inspectFile(selected.file, owner), proof)
      )
        fail();
      const capture = captureWorkspace({
        owner,
        documents: [
          {
            relativePath: selected.relativePath,
            document: document as DocumentState & { text: string },
            selection: expected.active!.selections[0],
            selectedText: expected.active!.selectedText,
            selectionTruncated: expected.active!.selectionTruncated,
            fileIdentity: fileIdentity(proof, owner),
          },
        ],
      });
      this.captures.set(taskId, {
        capture,
        proof,
        selection: structuredClone(selectionIdentity(context)),
        editor: session.editor,
      });
      return capture;
    } catch {
      this.clear(taskId);
      return null;
    }
  }
  async editor(plan: WorkspacePlan): Promise<WorkspaceEditorLease> {
    const retained = this.captures.get(plan.owner.taskId);
    if (
      !retained ||
      retained.capture.target.id !== plan.targetId ||
      plan.documents.length !== 1 ||
      !plan.documents[0].fileIdentity ||
      !same(
        plan.documents[0].fileIdentity,
        fileIdentity(retained.proof, plan.owner),
      )
    )
      fail();
    const assertCurrent = async () => {
      const current = await this.session(plan.owner.taskId);
      if (
        !current ||
        !current.editor.connected ||
        current.editor !== retained.editor ||
        !same(current.owner, plan.owner)
      )
        fail();
      if (
        !same(
          selectionIdentity(await current.editor.context()),
          retained.selection,
        )
      )
        fail();
      if (
        !same(
          await inspectFile(retained.proof.file, plan.owner),
          retained.proof,
        )
      )
        fail();
    };
    await assertCurrent();
    return {
      owner: structuredClone(plan.owner),
      assertCurrent,
      inspect: async (uri) => {
        if (plan.documents.length !== 1 || plan.documents[0].uri !== uri)
          fail();
        await assertCurrent();
        const document = await retained.editor.inspect(uri);
        await assertCurrent();
        return document;
      },
      apply: async (input) => {
        const expected = plan.documents.map((document) => ({
          uri: document.uri,
          expectedVersion: document.beforeVersion,
          expectedHash: document.beforeHash,
          text: document.afterText,
        }));
        if (!same(input.documents, expected)) fail();
        await assertCurrent();
        return retained.editor.apply(input);
      },
    };
  }
}
