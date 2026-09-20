import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceCurrent,
  captureWorkspace,
  planWorkspaceEdit,
  workspaceOffset,
  type WorkspaceOwner,
} from "../../apps/desktop/host/workspace-plan";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const owner: WorkspaceOwner = {
  taskId: "task",
  taskEpoch: 2,
  taskRevision: 3,
  policyRevision: 1,
  processing: "hybrid",
  serviceInstanceId: "host-session",
  serviceGeneration: 1,
  project: {
    id: "project",
    revision: 4,
    canonicalRoot: "/project",
    verification: "verified",
    rootIdentity: { device: "1", inode: "42" },
    kind: "external",
    adapter: "generic",
    preview: { kind: "none" },
    createdAt: 0,
    updatedAt: 0,
  },
};
function selected(
  text: string,
  start = 0,
  end = text.length,
  relativePath = "app.ts",
) {
  return {
    relativePath,
    document: {
      uri: pathToFileURL(`/project/${relativePath}`).href,
      text,
      hash: hash(text),
      bytes: Buffer.byteLength(text),
      version: 7,
      languageId: "typescript",
      dirty: true,
      untitled: false,
    },
    selection: {
      anchor: { line: 0, character: start },
      active: { line: 0, character: end },
    },
    selectedText: text.slice(start, end),
  };
}
function proposal(
  capture: ReturnType<typeof captureWorkspace>,
  edits: Array<{ path: string; before: string; after: string }>,
) {
  return {
    type: "ProposeWorkspaceEdit" as const,
    targetId: capture.target.id,
    expectedRevision: capture.target.revision,
    edits,
  };
}

describe("private workspace capture and exact edit planning", () => {
  it("exposes only admitted selected text while retaining the complete immutable buffer locally", () => {
    const input = selected(
      "privateBefore const speed = 1; privateAfter",
      14,
      30,
    );
    const capture = captureWorkspace({ owner, documents: [input] });
    expect(capture.target.files).toEqual([
      {
        path: "app.ts",
        content: "const speed = 1;",
        contentRange: { start: 14, end: 30, total: input.document.text.length },
      },
    ]);
    expect(JSON.stringify(capture.target)).not.toContain("privateBefore");
    expect(capture.documents[0].text).toBe(input.document.text);
    input.document.text = "changed after capture";
    expect(capture.documents[0].text).not.toBe(input.document.text);
    expect(Object.isFrozen(capture.documents[0].admitted)).toBe(true);
    expect(Object.isFrozen(capture.owner.project.rootIdentity)).toBe(true);
  });
  it("uses UTF-16 positions and preserves CRLF, reverse selections and emoji", () => {
    const input = selected("first\r\n🎨 const speed = 1;\r\nlast");
    input.selection = {
      anchor: { line: 1, character: 19 },
      active: { line: 1, character: 3 },
    };
    input.selectedText = "const speed = 1;";
    const capture = captureWorkspace({ owner, documents: [input] });
    const plan = planWorkspaceEdit(
      capture,
      proposal(capture, [
        { path: "app.ts", before: "speed = 1", after: "speed = 2" },
      ]),
    );
    expect(plan.documents[0].afterText).toBe(
      "first\r\n🎨 const speed = 2;\r\nlast",
    );
    expect(() =>
      workspaceOffset(input.document.text, { line: 1, character: 1 }),
    ).toThrow("splits");
    expect(() =>
      workspaceOffset(input.document.text, { line: 0, character: 6 }),
    ).toThrow("column");
  });
  it("rejects a duplicate full-buffer match outside the admitted excerpt, including overlapping matches", () => {
    const input = selected("const speed = 1; private speed = 1", 0, 16);
    const capture = captureWorkspace({ owner, documents: [input] });
    expect(() =>
      planWorkspaceEdit(
        capture,
        proposal(capture, [
          { path: "app.ts", before: "speed = 1", after: "speed = 2" },
        ]),
      ),
    ).toThrow("repeated");
    const overlap = captureWorkspace({
      owner,
      documents: [selected("aaa", 0, 2)],
    });
    expect(() =>
      planWorkspaceEdit(
        overlap,
        proposal(overlap, [{ path: "app.ts", before: "aa", after: "bb" }]),
      ),
    ).toThrow("repeated");
  });
  it("rejects out-of-selection, absent, overlapping and no-op replacements", () => {
    const capture = captureWorkspace({
      owner,
      documents: [selected("outside alpha beta omega", 8, 18)],
    });
    for (const edits of [
      [{ path: "app.ts", before: "outside", after: "changed" }],
      [{ path: "app.ts", before: "missing", after: "changed" }],
      [{ path: "app.ts", before: "alpha", after: "alpha" }],
      [
        { path: "app.ts", before: "alpha beta", after: "first" },
        { path: "app.ts", before: "beta", after: "second" },
      ],
    ])
      expect(() =>
        planWorkspaceEdit(capture, proposal(capture, edits)),
      ).toThrow();
  });
  it("constructs every changed file and independent same-file replacements without shifting original offsets", () => {
    const capture = captureWorkspace({
      owner,
      documents: [
        selected("alpha beta"),
        selected("gamma delta", 0, 11, "src/other.ts"),
      ],
    });
    const plan = planWorkspaceEdit(
      capture,
      proposal(capture, [
        { path: "app.ts", before: "beta", after: "much longer replacement" },
        { path: "src/other.ts", before: "gamma", after: "new" },
        { path: "app.ts", before: "alpha", after: "x" },
      ]),
    );
    expect(
      plan.documents.map((document) => [
        document.relativePath,
        document.afterText,
      ]),
    ).toEqual([
      ["app.ts", "x much longer replacement"],
      ["src/other.ts", "new delta"],
    ]);
    for (const document of plan.documents)
      expect(document.afterHash).toBe(hash(document.afterText));
    expect(plan.documents[0].changes.map((change) => change.start)).toEqual([
      0, 6,
    ]);
    expect(Object.isFrozen(plan.documents[0].changes)).toBe(true);
  });
  it("binds fresh owner, root identity, service incarnation and document version even when text matches", () => {
    const input = selected("const speed = 1;");
    const capture = captureWorkspace({ owner, documents: [input] });
    const plan = planWorkspaceEdit(
      capture,
      proposal(capture, [
        { path: "app.ts", before: "speed = 1", after: "speed = 2" },
      ]),
    );
    expect(() =>
      assertWorkspaceCurrent(plan, owner, [input.document]),
    ).not.toThrow();
    expect(() =>
      assertWorkspaceCurrent(plan, owner, [{ ...input.document, version: 8 }]),
    ).toThrow("changed");
    expect(() =>
      assertWorkspaceCurrent(plan, owner, [input.document, input.document]),
    ).toThrow("changed");
    for (const change of [
      { taskEpoch: 3 },
      { policyRevision: 2 },
      { taskRevision: 4 },
      { serviceInstanceId: "another-session" },
      { serviceGeneration: 2 },
      {
        project: {
          ...owner.project,
          verification: "verified" as const,
          kind: "external" as const,
          rootIdentity: { device: "1", inode: "43" },
        },
      },
    ])
      expect(() =>
        assertWorkspaceCurrent(plan, { ...owner, ...change }, [input.document]),
      ).toThrow("changed");
  });
  it("never substitutes another file, target or selection silently", () => {
    const capture = captureWorkspace({
      owner,
      documents: [selected("alpha beta")],
    });
    expect(() =>
      planWorkspaceEdit(capture, {
        ...proposal(capture, [{ path: "app.ts", before: "alpha", after: "x" }]),
        targetId: "different",
      }),
    ).toThrow("earlier");
    expect(() =>
      planWorkspaceEdit(
        capture,
        proposal(capture, [{ path: "other.ts", before: "alpha", after: "x" }]),
      ),
    ).toThrow("outside");
    const moved = captureWorkspace({
      owner,
      documents: [selected("alpha beta", 6, 10)],
    });
    expect(moved.target.id).not.toBe(capture.target.id);
  });
  it("refuses alias URIs, duplicate paths, malformed snapshots, untitled and adapter-owned configuration", () => {
    const good = selected("alpha");
    for (const input of [
      {
        ...good,
        document: { ...good.document, uri: "file:///project/%61pp.ts" },
      },
      { ...good, document: { ...good.document, text: "different" } },
      { ...good, document: { ...good.document, untitled: true } },
      { ...good, selectionTruncated: true },
      { ...good, selectedText: "different" },
      selected("alpha", 0, 5, "../outside.ts"),
      selected("alpha", 0, 5, "eve.project.json"),
    ])
      expect(() => captureWorkspace({ owner, documents: [input] })).toThrow();
    expect(() => captureWorkspace({ owner, documents: [good, good] })).toThrow(
      "identity",
    );
  });
  it("enforces UTF-8 byte limits without truncating a selection or private file capture", () => {
    const hugeSelection = selected("🎨".repeat(1001));
    expect(() =>
      captureWorkspace({ owner, documents: [hugeSelection] }),
    ).toThrow("smaller");
    const hugeFile = selected("a".repeat(1_048_577), 0, 10);
    expect(() => captureWorkspace({ owner, documents: [hugeFile] })).toThrow(
      "size",
    );
  });
  it('rejects split Unicode replacement fragments instead of corrupting a complete selected emoji', () => {
    const capture = captureWorkspace({ owner, documents: [selected('const paint = "🎨";')] });
    expect(() => planWorkspaceEdit(capture, proposal(capture, [{ path: 'app.ts', before: '\ud83c', after: 'x' }]))).toThrow('incomplete');
    expect(() => planWorkspaceEdit(capture, proposal(capture, [{ path: 'app.ts', before: '🎨', after: '\udfa8' }]))).toThrow('incomplete');
    expect(() => captureWorkspace({ owner, documents: [selected('const paint = "\udfa8";')] })).toThrow();
  });
  it('binds file and ancestor identities so equal-text atomic replacements need a fresh review', () => {
    const item = { ...selected('const speed = 1;'), fileIdentity: { device: '1', inode: '88', ancestors: [{ relativePath: '', device: '1', inode: '42' }] } };
    const original = captureWorkspace({ owner, documents: [item] });
    const replacement = captureWorkspace({ owner, documents: [{ ...item, fileIdentity: { ...item.fileIdentity, inode: '89' } }] });
    expect(replacement.target.id).not.toBe(original.target.id);
    const plan = planWorkspaceEdit(original, proposal(original, [{ path: 'app.ts', before: 'speed = 1', after: 'speed = 2' }]));
    expect(plan.documents[0].fileIdentity).toEqual(item.fileIdentity);
    expect(Object.isFrozen(plan.documents[0].fileIdentity?.ancestors)).toBe(true);
    expect(() => captureWorkspace({ owner, documents: [{ ...item, relativePath: 'src/app.ts' }] })).toThrow('directory identities');
  });
  it('normalizes multiline replacement passages to the actual editor EOL before computing preview and post hash', () => {
    const input = selected('const speed = 1;');
    const capture = captureWorkspace({ owner, documents: [{ ...input, document: { ...input.document, eol: 'crlf' } }] });
    const planned = planWorkspaceEdit(capture, proposal(capture, [{ path: 'app.ts', before: 'const speed = 1;', after: 'const speed = 2;\nconst easing = "soft";' }]));
    expect(planned.documents[0].afterText).toBe('const speed = 2;\r\nconst easing = "soft";');
    expect(planned.documents[0].changes[0].after).toBe(planned.documents[0].afterText);
    const unknown = captureWorkspace({ owner, documents: [input] });
    expect(() => planWorkspaceEdit(unknown, proposal(unknown, [{ path: 'app.ts', before: 'const speed = 1;', after: 'one\ntwo' }]))).toThrow('line-ending');
  });
});
