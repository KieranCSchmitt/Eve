import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  idSchema,
  projectRecordSchema,
  projectRootIdentitySchema,
  type ProjectRecord,
} from "@eve/contracts";
import {
  registeredActionSchema,
  type EditableTarget,
  type RegisteredAction,
} from "../../../packages/agent/src/contracts";
import type {
  DocumentState,
  Point,
  Selection,
} from "../../../extensions/eve-workbench/src/protocol";

export const WORKSPACE_PLAN_LIMITS = Object.freeze({
  documents: 8,
  documentBytes: 1_048_576,
  totalBytes: 4_194_304,
  excerptBytes: 4_000,
});
export class WorkspacePlanError extends Error {
  constructor(
    readonly code:
      "INVALID_CAPTURE" | "CONTEXT_LIMIT" | "STALE_CONTEXT" | "INVALID_EDIT",
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePlanError";
  }
}
export interface WorkspaceOwner {
  taskId: string;
  taskEpoch: number;
  taskRevision: number;
  policyRevision: number;
  processing: "hybrid" | "local-only";
  project: ProjectRecord;
  serviceInstanceId: string;
  serviceGeneration: number;
}
export interface WorkspaceDocumentCapture {
  uri: string;
  relativePath: string;
  version: number;
  hash: string;
  text: string;
  /** UTF-16 offsets in the complete local document. Only these bytes may enter the model request. */
  admitted: { start: number; end: number };
  fileIdentity?: WorkspaceFileIdentity;
  eol?: 'lf' | 'crlf';
}
/** Private host evidence; absent only in pure planner fixtures, never admissible for native Apply. */
export interface WorkspaceFileIdentity {
  device: string;
  inode: string;
  ancestors: Array<{ relativePath: string; device: string; inode: string }>;
}
export interface WorkspaceCapture {
  owner: WorkspaceOwner;
  target: EditableTarget & {
    kind: "workspace";
    files: NonNullable<EditableTarget["files"]>;
  };
  documents: WorkspaceDocumentCapture[];
}
export interface WorkspacePlannedDocument {
  uri: string;
  relativePath: string;
  beforeVersion: number;
  beforeHash: string;
  afterHash: string;
  beforeText: string;
  afterText: string;
  fileIdentity?: WorkspaceFileIdentity;
  changes: Array<{ start: number; end: number; before: string; after: string }>;
}
export interface WorkspacePlan {
  owner: WorkspaceOwner;
  targetId: string;
  targetRevision: number;
  documents: WorkspacePlannedDocument[];
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const revision = (value: number) => Number.isSafeInteger(value) && value >= 0;
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function reject(code: WorkspacePlanError["code"], message: string): never {
  throw new WorkspacePlanError(code, message);
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function checkedPath(root: string, relativePath: string): string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length > 500 ||
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativePath) ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    reject(
      "INVALID_CAPTURE",
      "A selected document needs its exact relative project path.",
    );
  // Both adapters use one coordinator for this registered configuration.
  if (relativePath.toLowerCase() === "eve.project.json")
    reject(
      "INVALID_CAPTURE",
      "Use the project controls to change its registered configuration.",
    );
  return pathToFileURL(path.join(root, ...relativePath.split("/"))).href;
}
function checkedOwner(owner: WorkspaceOwner): WorkspaceOwner {
  const project = projectRecordSchema.safeParse(owner.project);
  if (
    !idSchema.safeParse(owner.taskId).success ||
    !idSchema.safeParse(owner.serviceInstanceId).success ||
    ![
      owner.taskEpoch,
      owner.taskRevision,
      owner.policyRevision,
      owner.serviceGeneration,
    ].every(revision) ||
    !["hybrid", "local-only"].includes(owner.processing) ||
    !project.success ||
    project.data.verification !== "verified"
  )
    reject(
      "INVALID_CAPTURE",
      "A code proposal needs its current verified project and editor.",
    );
  const root = project.data.canonicalRoot;
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    root.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(root)
  )
    reject("INVALID_CAPTURE", "The project root is not canonical.");
  return structuredClone(owner);
}

/** VS Code columns use UTF-16; CRLF contributes two units between lines, never to a line's columns. */
export function workspaceOffset(text: string, point: Point): number {
  if (!point || !revision(point.line) || !revision(point.character))
    reject("INVALID_CAPTURE", "The selected text range is invalid.");
  let start = 0;
  for (let line = 0; line < point.line; line++) {
    const newline = text.indexOf("\n", start);
    if (newline < 0)
      reject("INVALID_CAPTURE", "The selected line no longer exists.");
    start = newline + 1;
  }
  const newline = text.indexOf("\n", start);
  let end = newline < 0 ? text.length : newline;
  if (newline >= 0 && end > start && text[end - 1] === "\r") end--;
  if (point.character > end - start)
    reject("INVALID_CAPTURE", "The selected column no longer exists.");
  const offset = start + point.character;
  // Do not expose invalid Unicode or split a surrogate pair in a replacement.
  const previous = text.charCodeAt(offset - 1),
    next = text.charCodeAt(offset);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    reject("INVALID_CAPTURE", "The selected range splits a text character.");
  return offset;
}

/** Caller must own and recheck actual project trust, filesystem identity and service generation.
 * This pure adapter verifies the complete buffer against its admitted selection; it does not grant trust.
 */
export function captureWorkspace(input: {
  owner: WorkspaceOwner;
  documents: Array<{
    relativePath: string;
    document: DocumentState & { text: string };
    selection: Selection;
    selectedText: string;
    selectionTruncated?: boolean;
    fileIdentity?: WorkspaceFileIdentity;
  }>;
}): WorkspaceCapture {
  const owner = checkedOwner(input.owner);
  if (
    !input.documents.length ||
    input.documents.length > WORKSPACE_PLAN_LIMITS.documents
  )
    reject(
      "CONTEXT_LIMIT",
      "Select between one and eight documents for a code proposal.",
    );
  const seen = new Set<string>();
  let total = 0;
  const documents = input.documents.map((item) => {
    const uri = checkedPath(owner.project.canonicalRoot, item.relativePath);
    const document = item.document;
    if (item.fileIdentity) {
      const { ancestors, ...file } = item.fileIdentity;
      const parts = item.relativePath.split("/");
      const directories = [
        "",
        ...parts
          .slice(0, -1)
          .map((_, index) => parts.slice(0, index + 1).join("/")),
      ];
      if (
        !projectRootIdentitySchema.safeParse(file).success ||
        !Array.isArray(ancestors) ||
        ancestors.length !== directories.length ||
        ancestors.some(
          (ancestor, index) =>
            ancestor.relativePath !== directories[index] ||
            !projectRootIdentitySchema.safeParse({
              device: ancestor.device,
              inode: ancestor.inode,
            }).success,
        ) ||
        ancestors[0].device !== owner.project.rootIdentity?.device ||
        ancestors[0].inode !== owner.project.rootIdentity?.inode
      )
        reject(
          "INVALID_CAPTURE",
          "The selected file needs its exact project directory identities.",
        );
    }
    if (
      seen.has(uri) ||
      !document ||
      document.uri !== uri ||
      document.untitled ||
      !revision(document.version) ||
      typeof document.text !== "string" ||
      !wellFormed(document.text) ||
      !/^[a-f0-9]{64}$/.test(document.hash) ||
      hash(document.text) !== document.hash ||
      byteLength(document.text) !== document.bytes
    )
      reject(
        "INVALID_CAPTURE",
        "The selected document identity, version or complete content could not be verified.",
      );
    seen.add(uri);
    const size = byteLength(document.text);
    total += size;
    if (
      size > WORKSPACE_PLAN_LIMITS.documentBytes ||
      total > WORKSPACE_PLAN_LIMITS.totalBytes
    )
      reject(
        "CONTEXT_LIMIT",
        "The selected files exceed the bounded code-review size. Your files are unchanged.",
      );
    const anchor = workspaceOffset(document.text, item.selection?.anchor);
    const active = workspaceOffset(document.text, item.selection?.active);
    const admitted = {
      start: Math.min(anchor, active),
      end: Math.max(anchor, active),
    };
    const excerpt = document.text.slice(admitted.start, admitted.end);
    if (!excerpt || item.selectionTruncated || excerpt !== item.selectedText)
      reject(
        "INVALID_CAPTURE",
        "Select a complete passage before requesting a code change.",
      );
    if (byteLength(excerpt) > WORKSPACE_PLAN_LIMITS.excerptBytes)
      reject(
        "CONTEXT_LIMIT",
        "Select a smaller passage for a code change. No selection was silently shortened.",
      );
    return {
      uri,
      relativePath: item.relativePath,
      version: document.version,
      hash: document.hash,
      text: document.text,
      admitted,
      ...(document.eol ? { eol: document.eol } : {}),
      ...(item.fileIdentity
        ? { fileIdentity: structuredClone(item.fileIdentity) }
        : {}),
    };
  });
  const targetId = `workspace:${hash(JSON.stringify([owner, documents.map(({ uri, version, hash: contentHash, admitted, fileIdentity, eol }) => ({ uri, version, hash: contentHash, admitted, fileIdentity, eol }))]))}`;
  const target: WorkspaceCapture["target"] = {
    id: targetId,
    revision: owner.project.revision,
    kind: "workspace",
    files: documents.map((document) => ({
      path: document.relativePath,
      content: document.text.slice(
        document.admitted.start,
        document.admitted.end,
      ),
      contentRange: { ...document.admitted, total: document.text.length },
    })),
  };
  return immutable({ owner, documents, target });
}

/** Literal changes are found in the complete private capture, then checked against the admitted excerpt. */
export function planWorkspaceEdit(
  capture: WorkspaceCapture,
  proposed: Extract<RegisteredAction, { type: "ProposeWorkspaceEdit" }>,
): WorkspacePlan {
  const parsed = registeredActionSchema.safeParse(proposed);
  if (!parsed.success || parsed.data.type !== "ProposeWorkspaceEdit")
    reject("INVALID_EDIT", "This code proposal is invalid.");
  const action = parsed.data;
  if (
    action.targetId !== capture.target.id ||
    action.expectedRevision !== capture.target.revision
  )
    reject(
      "STALE_CONTEXT",
      "The code proposal belongs to an earlier selection.",
    );
  const perDocument = new Map<string, WorkspacePlannedDocument>();
  for (const edit of action.edits) {
    if (!wellFormed(edit.before) || !wellFormed(edit.after))
      reject(
        "INVALID_EDIT",
        "The proposed code contains an incomplete text character.",
      );
    const source = capture.documents.find(
      (document) => document.relativePath === edit.path,
    );
    if (!source)
      reject(
        "INVALID_EDIT",
        "The proposal names a file outside the selected documents.",
      );
    if (/[\r\n]/.test(edit.after) && !source.eol) reject('INVALID_EDIT', 'The editor line-ending format must be captured before proposing a multiline change.');
    const replacement = source.eol ? edit.after.replace(/\r\n|\r|\n/g, source.eol === 'crlf' ? '\r\n' : '\n') : edit.after;
    if (replacement.length > 8000) reject('CONTEXT_LIMIT', 'The normalized replacement exceeds the changed-passage review limit.');
    const start = source.text.indexOf(edit.before);
    if (start < 0 || source.text.indexOf(edit.before, start + 1) >= 0)
      reject(
        "INVALID_EDIT",
        "The proposed original text is missing or repeated. Select a more distinctive passage.",
      );
    const end = start + edit.before.length;
    if (start < source.admitted.start || end > source.admitted.end)
      reject(
        "INVALID_EDIT",
        "The proposal reaches beyond the text selected for this request.",
      );
    if (edit.before === replacement)
      reject("INVALID_EDIT", "The proposal contains no change.");
    let document = perDocument.get(source.uri);
    if (!document) {
      document = {
        uri: source.uri,
        relativePath: source.relativePath,
        beforeVersion: source.version,
        beforeHash: source.hash,
        afterHash: "",
        beforeText: source.text,
        afterText: "",
        changes: [],
        ...(source.fileIdentity
          ? { fileIdentity: structuredClone(source.fileIdentity) }
          : {}),
      };
      perDocument.set(source.uri, document);
    }
    if (
      document.changes.some(
        (change) => start < change.end && end > change.start,
      )
    )
      reject("INVALID_EDIT", "The proposal contains overlapping changes.");
    document.changes.push({
      start,
      end,
      before: edit.before,
      after: replacement,
    });
  }
  let total = 0;
  for (const document of perDocument.values()) {
    document.changes.sort((a, b) => a.start - b.start);
    let after = document.beforeText;
    for (const change of [...document.changes].reverse())
      after =
        after.slice(0, change.start) + change.after + after.slice(change.end);
    total += byteLength(after);
    if (
      byteLength(after) > WORKSPACE_PLAN_LIMITS.documentBytes ||
      total > WORKSPACE_PLAN_LIMITS.totalBytes
    )
      reject(
        "CONTEXT_LIMIT",
        "The proposed result exceeds the bounded code-review size.",
      );
    document.afterText = after;
    document.afterHash = hash(after);
  }
  return immutable({
    owner: structuredClone(capture.owner),
    targetId: capture.target.id,
    targetRevision: capture.target.revision,
    documents: [...perDocument.values()],
  });
}

/** Revalidate immediately before preparation and dispatch; same bytes with a newer native version are stale. */
export function assertWorkspaceCurrent(
  plan: WorkspacePlan,
  owner: WorkspaceOwner,
  documents: readonly DocumentState[],
): void {
  checkedOwner(owner);
  const original = plan.owner;
  if (
    owner.taskId !== original.taskId ||
    owner.taskEpoch !== original.taskEpoch ||
    owner.taskRevision !== original.taskRevision ||
    owner.policyRevision !== original.policyRevision ||
    owner.processing !== original.processing ||
    owner.serviceInstanceId !== original.serviceInstanceId ||
    owner.serviceGeneration !== original.serviceGeneration ||
    owner.project.id !== original.project.id ||
    owner.project.revision !== original.project.revision ||
    owner.project.canonicalRoot !== original.project.canonicalRoot ||
    owner.project.rootIdentity?.device !==
      original.project.rootIdentity?.device ||
    owner.project.rootIdentity?.inode !== original.project.rootIdentity?.inode
  )
    reject(
      "STALE_CONTEXT",
      "The project, task or editor changed while the proposal was open.",
    );
  for (const planned of plan.documents) {
    const matches = documents.filter(
      (document) => document.uri === planned.uri,
    );
    if (
      matches.length !== 1 ||
      matches[0].untitled ||
      matches[0].version !== planned.beforeVersion ||
      matches[0].hash !== planned.beforeHash
    )
      reject(
        "STALE_CONTEXT",
        "The selected code changed while the proposal was open.",
      );
  }
}
