import type { CanvasBlock, CanvasDocument } from "@eve/contracts";

/** Shared placement rules. Callers supply their own measured content heights. */
export function canvasLayoutPositions(
  blocks: readonly Pick<CanvasBlock, "id" | "placement">[],
  layout: CanvasDocument["layout"],
  heights: Readonly<Record<string, number>>,
  gap = 36,
) {
  const columns = [1, 1];
  return new Map(
    blocks.map((block) => {
      const full = layout === "focus" || block.placement === "full";
      const column = full
        ? 0
        : layout === "split"
          ? block.placement === "aside"
            ? 1
            : 0
          : columns[0] <= columns[1]
            ? 0
            : 1;
      const start = full ? Math.max(...columns) : columns[column];
      const height = heights[block.id] ?? 120;
      if (full) columns.fill(start + height + gap);
      else columns[column] = start + height + gap;
      return [
        block.id,
        {
          supporting: layout === "split" && !full && column === 1,
          full,
          start,
          column,
          style: {
            gridColumn: full ? "1 / -1" : column + 1,
            gridRow: `${start} / span ${Math.max(1, height)}`,
          },
        },
      ] as const;
    }),
  );
}
