import { describe, expect, it } from "vitest";
import {
  compileCanvasSuggestion,
  type CanvasBlock,
  type CanvasDocument,
  type CanvasSuggestion,
} from "../../packages/contracts/src/index";
import {
  prepareContext,
  validateProposal,
  type AgentRequest,
} from "../../packages/agent/src/index";
import { proposal, request } from "./fixtures";

const base = {
  placement: "main" as const,
  pinned: false,
  sourceIds: [] as string[],
};
const writing = (
  body = "My own observations.",
): Extract<CanvasBlock, { kind: "text" }> => ({
  ...base,
  id: "writing",
  kind: "text",
  title: "Observations",
  body,
});
const checklist = (): CanvasBlock => ({
  ...base,
  id: "next",
  kind: "checklist",
  title: "Preparation",
  items: [],
});
const document = (
  blocks: CanvasBlock[] = [writing()],
  suggestions: CanvasSuggestion[] = [],
): CanvasDocument => ({
  version: 1,
  title: "A little room to think",
  subtitle: "",
  layout: "split",
  blocks,
  suggestions,
});
const captured = (canvas = document()): AgentRequest => {
  const input = request({ role: "prepare", sources: [] });
  input.intent.text = "Organize this space";
  input.targets = [
    { id: "orbit:canvas", kind: "canvas", revision: 7, canvas, assets: [] },
  ];
  return input;
};
const suggestion = (edits: unknown[], targetBlockId: string | null = null) => ({
  id: "continue",
  label: "Prepare the next step",
  description: "Review a concrete change.",
  request: "Prepare the next step while preserving unrelated work.",
  targetBlockId,
  prepared: { edits },
});
const output = (canvas: unknown) => ({
  ...proposal({ basis: "general", citations: [] }),
  actions: [
    {
      type: "ComposeCanvas",
      targetId: "orbit:canvas",
      expectedRevision: 7,
      document: canvas,
    },
  ],
});
const validate = (canvas: unknown, input = captured()) =>
  validateProposal(output(canvas), input, prepareContext(input, "local"));
const composed = (canvas: unknown, input = captured()): CanvasDocument => {
  const action = validate(canvas, input).actions[0]!;
  if (action.type !== "ComposeCanvas") throw new Error("Expected a canvas");
  return action.document;
};
const wireSuggestion = (saved: CanvasSuggestion) => ({
  ...saved,
  prepared: saved.prepared ? { edits: saved.prepared.edits } : null,
});
const branches = (input: AgentRequest) => {
  const schema = prepareContext(input, "local").input.schema as any;
  const doc = schema.properties.actions.items.anyOf.find(
    (branch: any) => branch.properties.type.const === "ComposeCanvas",
  ).properties.document;
  const choice = doc.properties.suggestions.items;
  const plan = choice.properties.prepared.anyOf.find(
    (branch: any) => branch.properties?.edits,
  );
  return {
    schema,
    doc,
    choice,
    plan,
    nestedBlocks: plan.properties.edits.items.anyOf.find((branch: any) => branch.properties?.block).properties.block.anyOf,
  };
};

describe("prepared suggestions at the model boundary", () => {
  it("hydrates replacement snapshots from the resulting composition after keep expansion, without mutating provider output", () => {
    const current = writing("An explicitly updated observation.");
    const next = writing("A proposed second version.");
    const input = captured(document([writing(), checklist()]));
    const wire = {
      ...document(),
      blocks: [current, { kind: "keep", id: "next" }],
      suggestions: [suggestion([{ type: "replace", block: next }], "writing")],
    };
    const untouched = structuredClone(wire);
    const result = composed(wire, input);
    expect(result.suggestions![0]!.prepared).toEqual({
      edits: [{ type: "replace", block: next }],
      before: [current],
    });
    expect(compileCanvasSuggestion(result, "continue").blocks).toEqual([
      next,
      checklist(),
    ]);
    expect(wire).toEqual(untouched);
    expect(input.targets[0]!.canvas!.blocks[0]).toEqual(writing());
  });

  it("prepares deterministic add-only plans and accepts legacy prose or explicit null", () => {
    const result = composed({
      ...document(),
      suggestions: [
        suggestion([{ type: "add", block: checklist() }]),
        {
          id: "later",
          label: "Discuss next steps",
          description: "",
          request: "Discuss my next steps.",
          targetBlockId: null,
          prepared: null,
        },
        {
          id: "legacy",
          label: "Explore",
          description: "",
          request: "Explore options.",
          targetBlockId: null,
        },
      ],
    });
    expect(result.suggestions![0]!.prepared!.before).toEqual([]);
    expect(compileCanvasSuggestion(result, "continue").blocks).toEqual([
      writing(),
      checklist(),
    ]);
    expect(result.suggestions![1]!.prepared).toBeNull();
    expect(result.suggestions![2]).not.toHaveProperty("prepared");
  });

  it.each([false, true])(
    "retains stale originals for unchanged plan identity/target/edits (metadata changed: %s)",
    (metadataChanged) => {
      const old = writing("An earlier draft.");
      const current = writing("A user edited this after the suggestion.");
      const next = writing("Proposed wording.");
      const saved: CanvasSuggestion = {
        ...suggestion([{ type: "replace", block: next }], "writing"),
        prepared: { edits: [{ type: "replace", block: next }], before: [old] },
      };
      const input = captured(document([current], [saved]));
      const wire = wireSuggestion(saved);
      if (metadataChanged) {
        wire.label = "Review the prepared wording";
        wire.description = "A clearer label for the same plan.";
      }
      const result = composed(
        {
          ...document(),
          blocks: [{ kind: "keep", id: "writing" }],
          suggestions: [wire],
        },
        input,
      );
      expect(result.suggestions![0]!.prepared!.before).toEqual([old]);
      expect(() => compileCanvasSuggestion(result, "continue")).toThrow(
        /changed/i,
      );
    },
  );

  it("captures a fresh original for a genuinely changed plan instead of keeping an obsolete snapshot", () => {
    const old = writing("Old."),
      current = writing("New authored text."),
      next = writing("A different proposed edit.");
    const saved: CanvasSuggestion = {
      ...suggestion(
        [{ type: "replace", block: writing("First proposal.") }],
        "writing",
      ),
      prepared: {
        edits: [{ type: "replace", block: writing("First proposal.") }],
        before: [old],
      },
    };
    const result = composed(
      {
        ...document([current]),
        suggestions: [
          suggestion([{ type: "replace", block: next }], "writing"),
        ],
      },
      captured(document([current], [saved])),
    );
    expect(result.suggestions![0]!.prepared!.before).toEqual([current]);
    expect(compileCanvasSuggestion(result, "continue").blocks[0]).toEqual(next);
  });

  it("keeps stale host snapshots out of model context while retaining current material and proposed edits", () => {
    const historical = writing(
      "Historical-only material held for the local precondition.",
    );
    const current = writing("Current authored material.");
    const proposed = writing("Prepared future material.");
    const saved: CanvasSuggestion = {
      ...suggestion([{ type: "replace", block: proposed }], "writing"),
      prepared: {
        edits: [{ type: "replace", block: proposed }],
        before: [historical],
      },
    };
    const input = captured(document([current], [saved]));
    const context = prepareContext(input, "local");
    expect(context.input.data).not.toContain(historical.body);
    expect(context.input.data).toContain(current.body);
    expect(context.input.data).toContain(proposed.body);
    expect(
      context.targets[0]!.canvas!.suggestions![0]!.prepared!.before,
    ).toEqual([historical]);
    expect(input.targets[0]!.canvas!.suggestions![0]!.prepared!.before).toEqual(
      [historical],
    );
  });

  it("discards model-authored before snapshots and rejects keep references inside proposed edits", () => {
    const forged = {
      ...suggestion([{ type: "replace", block: writing("Next.") }], "writing"),
      prepared: {
        edits: [{ type: "replace", block: writing("Next.") }],
        before: [writing("Fabricated original.")],
      },
    };
    expect(
      composed({ ...document(), suggestions: [forged] }).suggestions![0]!
        .prepared!.before,
    ).toEqual([writing()]);
    expect(() =>
      validate({
        ...document(),
        suggestions: [
          suggestion([{ type: "add", block: { kind: "keep", id: "writing" } }]),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_OUTPUT" }));
  });

  it.each([
    ["no-op", writing(), "writing"],
    ["wrong target", { ...checklist(), title: "Changed" }, "writing"],
    ["missing replacement", { ...writing("New"), id: "unknown" }, null],
  ] as const)(
    "rejects a new %s plan through the shared compiler",
    (_name, block, target) => {
      expect(() =>
        validate(
          {
            ...document([writing(), checklist()]),
            suggestions: [suggestion([{ type: "replace", block }], target)],
          },
          captured(document([writing(), checklist()])),
        ),
      ).toThrow(expect.objectContaining({ code: "INVALID_OUTPUT" }));
    },
  );

  it("rejects pinned replacement and running timers even when the current composition itself is unchanged", () => {
    const pinned = { ...writing(), pinned: true };
    expect(() =>
      validate(
        {
          ...document([pinned]),
          suggestions: [
            suggestion(
              [{ type: "replace", block: { ...pinned, body: "Changed" } }],
              "writing",
            ),
          ],
        },
        captured(document([pinned])),
      ),
    ).toThrow(/pinned/i);
    const timer: CanvasBlock = {
      ...base,
      id: "timer",
      kind: "timer",
      title: "Timer",
      durationSeconds: 60,
      remainingSeconds: 30,
      endsAt: Date.now() + 30000,
    };
    expect(() =>
      validate({
        ...document(),
        suggestions: [suggestion([{ type: "add", block: timer }])],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_OUTPUT" }));
  });

  it("requires nullable prepared wire plans but excludes host snapshots and nested keep references", () => {
    const { choice, plan, nestedBlocks, doc } = branches(captured());
    expect(choice.required).toContain("prepared");
    expect(
      choice.properties.prepared.anyOf.some(
        (branch: any) => branch.type === "null",
      ),
    ).toBe(true);
    expect(plan.required).toEqual(["edits", "arrangement"]);
    expect(plan.properties).not.toHaveProperty("before");
    expect(plan.properties).not.toHaveProperty("beforeArrangement");
    expect(
      nestedBlocks.some((block: any) => block.properties.kind.const === "keep"),
    ).toBe(false);
    expect(
      doc.properties.blocks.items.anyOf.some(
        (block: any) => block.properties.kind.const === "keep",
      ),
    ).toBe(true);
    const timeline = nestedBlocks.find(
      (block: any) => block.properties.kind.const === "timeline",
    );
    expect(timeline.properties.items.items.properties).toHaveProperty(
      "startTime",
    );
    expect(timeline.properties.items.items.properties).not.toHaveProperty(
      "startMinutes",
    );
    const deadline = nestedBlocks.find(
      (block: any) => block.properties.kind.const === "deadline",
    );
    expect(deadline.properties).toHaveProperty("dueDate");
    expect(deadline.properties).not.toHaveProperty("dueAt");
  });

  it("scopes assets and source IDs inside prepared blocks and nested design layers", () => {
    const input = captured();
    input.targets[0]!.assets = [
      { id: "photo", title: "Photo", mediaType: "image/png" },
      { id: "video", title: "Video", mediaType: "video/mp4" },
    ];
    input.sources = request().sources;
    const { nestedBlocks } = branches(input);
    expect(
      nestedBlocks.find((block: any) => block.properties.kind.const === "image")
        .properties.assetId.anyOf,
    ).toEqual([{ type: "string", enum: ["photo"] }, { type: "null" }]);
    expect(
      nestedBlocks.every(
        (block: any) =>
          JSON.stringify(block.properties.sourceIds.items.enum) ===
          '["source-1"]',
      ),
    ).toBe(true);
    const design = nestedBlocks.find(
      (block: any) => block.properties.kind.const === "design",
    );
    expect(
      design.properties.layers.items.anyOf.find(
        (layer: any) => layer.properties.kind.const === "image",
      ).properties.assetId.enum,
    ).toEqual(["photo"]);
    const empty = branches(captured()).nestedBlocks;
    expect(
      empty.find((block: any) => block.properties.kind.const === "image").properties.assetId,
    ).toEqual({ type: "null" });
    expect(
      empty
        .find((block: any) => block.properties.kind.const === "design")
        .properties.layers.items.anyOf.some(
          (layer: any) => layer.properties.kind.const === "image",
        ),
    ).toBe(false);
    const image: CanvasBlock = {
      ...base,
      id: "image",
      kind: "image",
      title: "Image",
      assetId: "photo",
      caption: "",
    };
    expect(() =>
      validate(
        {
          ...document(),
          suggestions: [suggestion([{ type: "add", block: image }])],
        },
        input,
      ),
    ).not.toThrow();
    expect(() =>
      validate(
        {
          ...document(),
          suggestions: [
            suggestion([
              { type: "add", block: { ...image, assetId: "video" } },
            ]),
          ],
        },
        input,
      ),
    ).toThrow(/cannot be applied/i);
    expect(() =>
      validate(
        {
          ...document(),
          suggestions: [
            suggestion([
              {
                type: "add",
                block: { ...checklist(), sourceIds: ["unknown"] },
              },
            ]),
          ],
        },
        input,
      ),
    ).toThrow(/cannot be applied/i);
  });

  it("normalizes proposed clocks and strips host snapshots while converting proposed context clocks", () => {
    const timeline = {
      ...base,
      id: "day",
      kind: "timeline",
      title: "A day",
      date: "Today",
      startHour: 9,
      endHour: 18,
      items: [
        {
          id: "focus",
          title: "Focus",
          startTime: "13:05",
          endTime: "14:10",
          status: "suggested",
          detail: "",
        },
      ],
    };
    const deadline = {
      ...base,
      id: "due",
      kind: "deadline",
      title: "Deadline",
      dueDate: "2026-10-02T15:30",
    };
    const result = composed({
      ...document(),
      suggestions: [
        suggestion([
          { type: "add", block: timeline },
          { type: "add", block: deadline },
        ]),
      ],
    });
    expect(result.suggestions![0]!.prepared!.edits.flatMap(edit => edit.type === 'remove' ? [] : [edit.block])[0]).toMatchObject({
      items: [{ startMinutes: 785, endMinutes: 850 }],
    });
    expect(result.suggestions![0]!.prepared!.edits.flatMap(edit => edit.type === 'remove' ? [] : [edit.block])[1]).toMatchObject({
      dueAt: new Date("2026-10-02T15:30").getTime(),
    });
    const context = prepareContext(captured(result), "local");
    const model = JSON.parse(context.input.data).targets[0].canvas
      .suggestions[0].prepared;
    expect(model).not.toHaveProperty("before");
    expect(model.edits[0].block.items[0]).toMatchObject({
      startTime: "13:05",
      endTime: "14:10",
    });
    expect(model.edits[1].block).toMatchObject({ dueDate: "2026-10-02T15:30" });
    expect(
      context.targets[0]!.canvas!.suggestions![0]!.prepared,
    ).toHaveProperty("before");
    for (const invalid of ["25:00", "9:00", "13:05:01"])
      expect(() =>
        validate({
          ...document(),
          suggestions: [
            suggestion([
              {
                type: "add",
                block: {
                  ...timeline,
                  items: [{ ...timeline.items[0], startTime: invalid }],
                },
              },
            ]),
          ],
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_OUTPUT" }));
  });

  it("validates links against the complete projected next canvas, including a table and chart added together", () => {
    const table: CanvasBlock = {
      ...base,
      id: "table",
      kind: "table",
      title: "Measurements",
      columns: ["Label", "Value"],
      rows: [{ id: "a", cells: ["First", "3"] }],
    };
    const chart: CanvasBlock = {
      ...base,
      id: "chart",
      kind: "chart",
      title: "Values",
      tableId: "table",
      chartType: "bar",
      labelColumn: 0,
      valueColumns: [1],
    };
    const result = composed({
      ...document(),
      suggestions: [
        suggestion([
          { type: "add", block: table },
          { type: "add", block: chart },
        ]),
      ],
    });
    expect(compileCanvasSuggestion(result, "continue").blocks).toEqual([
      writing(),
      table,
      chart,
    ]);
    expect(() =>
      validate({
        ...document(),
        suggestions: [suggestion([{ type: "add", block: chart }])],
      }),
    ).toThrow(/cannot be applied/i);
  });
});
