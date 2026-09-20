import {
  canvasDataEqual,
  canvasDocumentSchema,
  type CanvasDocument,
} from "@eve/contracts";
import type { IntentProposal } from "../../../shared/bridge";

/** Project host-validated data without ever substituting a live editor's value. */
export function canvasProposalProjection(
  document: CanvasDocument,
  proposal?: IntentProposal,
) {
  if (
    !proposal ||
    proposal.kind !== "canvas" ||
    proposal.status === "applied" ||
    proposal.status === "discarded"
  )
    return null;
  const original = canvasDocumentSchema.safeParse(proposal.beforeCanvas);
  const candidate = canvasDocumentSchema.safeParse(proposal.canvas);
  if (!original.success || !candidate.success) return null;
  const before = original.data;
  const after = candidate.data;
  const additions = after.blocks.filter(
    (block) => !before.blocks.some((original) => original.id === block.id),
  );
  if (!additions.length) return null;
  const fresh = canvasDataEqual(document, before);
  const changed = new Set(
    after.blocks
      .filter((block) => {
        const original = before.blocks.find((item) => item.id === block.id);
        const linked = block.kind === "chart" || block.kind === "metric";
        return (
          !canvasDataEqual(original, block) ||
          (linked &&
            !canvasDataEqual(
              before.blocks.find((item) => item.id === block.tableId),
              after.blocks.find((item) => item.id === block.tableId),
            ))
        );
      })
      .map((block) => block.id),
  );
  const removed = before.blocks.filter(
    (block) => !after.blocks.some((item) => item.id === block.id),
  );
  // Removed originals remain visible until Keep; surviving originals retain
  // their mount positions in CanvasLayout even when their geometry changes.
  const layout = { ...after, blocks: [...after.blocks, ...removed] };
  const arrangementChanged =
    before.layout !== after.layout ||
    !canvasDataEqual(
      before.blocks.map(({ id, placement }) => ({ id, placement })),
      after.blocks
        .filter((block) =>
          before.blocks.some((original) => original.id === block.id),
        )
        .map(({ id, placement }) => ({ id, placement })),
    );
  const headingChanged =
    before.title !== after.title || before.subtitle !== after.subtitle;
  const choicesChanged = !canvasDataEqual(
    before.suggestions ?? [],
    after.suggestions ?? [],
  );
  const multiple =
    changed.size + removed.length > 1 ||
    arrangementChanged ||
    headingChanged ||
    choicesChanged;
  return {
    before,
    after,
    layout,
    additions,
    changed,
    removed,
    fresh,
    arrangementChanged,
    headingChanged,
    choicesChanged,
    multiple,
  };
}
