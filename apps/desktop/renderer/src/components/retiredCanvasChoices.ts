import {
  canvasDataEqual,
  canvasSuggestionUnavailableReason,
  type CanvasBlock,
  type CanvasDocument,
  type CanvasSuggestion,
} from "@eve/contracts";

export interface RetiredCanvasChoice {
  suggestion: CanvasSuggestion;
  reason: string;
  target: Pick<CanvasBlock, "id" | "title" | "kind"> | null;
}

function uniqueIdentities(values: readonly { id: unknown }[]): boolean {
  return (
    Array.isArray(values) &&
    values.every(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        typeof value.id === "string" &&
        value.id.length > 0 &&
        value.id.length <= 128,
    ) &&
    new Set(values.map((value) => value.id)).size === values.length
  );
}

/**
 * Classifies only suggestion metadata for an already host-prepared preview.
 * [] means the chosen card alone was consumed; null means a full metadata
 * review is needed. Authored content, layout, linked effects and compact field
 * eligibility remain the caller's separate checks.
 *
 * A known prerequisite conflict guarantees that the compiler would retire that
 * prepared choice. This does not prove any surviving choice executable. Opaque
 * formula/resource failures stay unexplained here and require the full review.
 * No formula evaluation, plan compilation or mutation occurs in this helper.
 */
export function retiredCanvasChoices(
  before: CanvasDocument,
  after: CanvasDocument,
  chosenId: string,
): RetiredCanvasChoice[] | null {
  const previous = before.suggestions === undefined ? [] : before.suggestions;
  const next = after.suggestions === undefined ? [] : after.suggestions;
  if (
    !uniqueIdentities(previous) ||
    !uniqueIdentities(next) ||
    !uniqueIdentities(before.blocks) ||
    !uniqueIdentities(after.blocks) ||
    typeof chosenId !== "string" ||
    !previous.find((choice) => choice.id === chosenId)?.prepared ||
    next.some((choice) => choice.id === chosenId)
  )
    return null;

  const candidates = previous.filter((choice) => choice.id !== chosenId);
  const nextIds = new Set(next.map((choice) => choice.id));
  const retained = candidates.filter((choice) => nextIds.has(choice.id));
  // Reject additions, edits and reordering, including changes hidden inside a
  // saved plan or its historical scope. Property order itself is immaterial.
  if (!canvasDataEqual(retained, next)) return null;

  const retired: RetiredCanvasChoice[] = [];
  for (const suggestion of candidates.filter((choice) => !nextIds.has(choice.id))) {
    if (!suggestion.prepared) return null;
    let reason: string | undefined;
    try {
      reason = canvasSuggestionUnavailableReason(after, suggestion);
    } catch {
      return null;
    }
    if (!reason) return null;
    const target =
      suggestion.targetBlockId === null
        ? null
        : after.blocks.find((block) => block.id === suggestion.targetBlockId) ??
          before.blocks.find((block) => block.id === suggestion.targetBlockId);
    if (target === undefined) return null;
    retired.push({
      suggestion,
      reason,
      target: target
        ? { id: target.id, title: target.title, kind: target.kind }
        : null,
    });
  }
  return retired;
}
