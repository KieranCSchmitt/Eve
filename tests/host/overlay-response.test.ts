import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  ipcMain: {},
  session: {},
  WebContentsView: class {},
  webContents: {},
}));
import { responseSchema } from "../../apps/desktop/host/overlay";

const change = () => ({
  startLine: 1,
  startColumn: 3,
  endLine: 2,
  endColumn: 1,
  before: '"<h1>Hello</h1>"',
  after: '"<h1>Welcome</h1>"',
});
const response = () => ({
  requestId: "request",
  taskId: "task",
  status: "complete",
  message: "Review the selected change.",
  citations: [],
  proposals: [
    {
      id: "proposal",
      kind: "workspace",
      label: "Change selected code",
      summary: "Two literal passages.",
      files: [
        {
          path: "src/message.ts",
          changes: [change(), { ...change(), startLine: 4, endLine: 5 }],
        },
      ],
      expiresAt: 100,
      status: "ready",
    },
  ],
});

describe("trusted overlay workspace response boundary", () => {
  it("preserves literal passages and uncertain settlement state without stripping fields", () => {
    const value = response();
    value.proposals[0].status = "uncertain";
    expect(responseSchema.parse(value)).toEqual(value);
  });
  it("admits exactly eight full-size passages across eight files", () => {
    const value = response();
    value.proposals[0].files = Array.from({ length: 8 }, (_, index) => ({
      path: `src/${index}.ts`,
      changes: [
        { ...change(), before: "a".repeat(8000), after: "b".repeat(8000) },
      ],
    }));
    expect(responseSchema.parse(value)).toEqual(value);
  });
  it.each([
    "files",
    "total passages",
    "fragment",
    "range",
    "duplicate path",
    "unknown field",
  ])("refuses invalid %s without silently truncating the review", (invalid) => {
    const value = response();
    if (invalid === "files")
      value.proposals[0].files = Array.from({ length: 9 }, (_, index) => ({
        path: `${index}.ts`,
        changes: [change()],
      }));
    if (invalid === "total passages")
      value.proposals[0].files = [
        { path: "a.ts", changes: Array.from({ length: 5 }, change) },
        { path: "b.ts", changes: Array.from({ length: 4 }, change) },
      ];
    if (invalid === "fragment")
      value.proposals[0].files[0].changes[0].after = "x".repeat(8001);
    if (invalid === "range") value.proposals[0].files[0].changes[0].endLine = 0;
    if (invalid === "duplicate path")
      value.proposals[0].files.push({
        path: "src/message.ts",
        changes: [change()],
      });
    if (invalid === "unknown field")
      Object.assign(value.proposals[0].files[0].changes[0], {
        html: "<script>execute()</script>",
      });
    expect(responseSchema.safeParse(value).success).toBe(false);
  });
  it("continues to admit ordinary note proposals and refuses invented kinds", () => {
    const value = response();
    const note = {
      ...value,
      proposals: [
        {
          id: "note-proposal",
          kind: "note",
          label: "Replace task note",
          summary: "Review the note.",
          before: "<p>Before</p>",
          after: "<p>After</p>",
          expiresAt: 100,
          status: "ready",
        },
      ],
    };
    expect(responseSchema.parse(note)).toEqual(note);
    note.proposals[0].kind = "execute-code";
    expect(responseSchema.safeParse(note).success).toBe(false);
  });
});
