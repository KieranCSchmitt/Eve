import type { CanvasBlock, CanvasTextSelection } from "@eve/contracts";

export interface CompactCanvasChange {
  field: string;
  before: string;
  after: string;
  note?: string;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const short = (value: string) =>
  value.length <= 160 &&
  value.split("\n").length <= 3 &&
  value.trim() === value &&
  !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
const textChange = (field: string, before: string, after: string) =>
  before !== after &&
  short(before) &&
  short(after) &&
  before.replace(/\s+/gu, " ") !== after.replace(/\s+/gu, " ")
    ? { field, before, after }
    : null;
const duration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [
    hours ? `${hours} hr` : "",
    minutes ? `${minutes} min` : "",
    remainder || (!hours && !minutes) ? `${remainder} sec` : "",
  ]
    .filter(Boolean)
    .join(" ");
};
const timestamp = (value: number | null) =>
  value === null
    ? "No deadline set"
    : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        ...(value % 1000 ? { fractionalSecondDigits: 3 as const } : {}),
        timeZoneName: "shortOffset",
      }).format(value);

/**
 * A deliberately narrow, lossless review vocabulary. Reconstructing the whole
 * candidate with only the displayed values ensures an unhandled field never
 * silently becomes a compact summary. Document/linked effects are gated by
 * the caller before reaching this helper.
 */
export function compactCanvasChange(
  before: CanvasBlock,
  after: CanvasBlock,
  selected?: CanvasTextSelection,
): CompactCanvasChange | null {
  if (before.kind !== after.kind || before.title.length > 100) return null;
  switch (before.kind) {
    case "text": {
      if (selected) {
        if (selected.field !== "body" || !Number.isSafeInteger(selected.start) || !Number.isSafeInteger(selected.end) || after.kind !== "text" || !same({ ...before, body: after.body }, after) ||
            selected.start < 0 || selected.end <= selected.start || selected.end > before.body.length ||
            before.body.slice(selected.start, selected.end) !== selected.text) return null;
        const prefix = before.body.slice(0, selected.start), suffix = before.body.slice(selected.end);
        if (after.body.length < prefix.length + suffix.length || !after.body.startsWith(prefix) || !after.body.endsWith(suffix)) return null;
        return textChange("Selected passage", selected.text, after.body.slice(prefix.length, after.body.length - suffix.length));
      }
      return after.kind === "text" &&
        same({ ...before, body: after.body }, after)
        ? textChange("Writing", before.body, after.body)
        : null;
    }
    case "note":
      return after.kind === "note" &&
        same({ ...before, description: after.description }, after)
        ? textChange("Note", before.description, after.description)
        : null;
    case "deadline":
      return after.kind === "deadline" &&
        before.dueAt !== after.dueAt &&
        same({ ...before, dueAt: after.dueAt }, after)
        ? {
            field: "Deadline",
            before: timestamp(before.dueAt),
            after: timestamp(after.dueAt),
          }
        : null;
    case "timer":
      // Display both coupled values. Running/partly elapsed timers require the
      // full snapshot, including their absolute end time and remaining time.
      return after.kind === "timer" &&
        before.endsAt === null &&
        after.endsAt === null &&
        before.remainingSeconds === before.durationSeconds &&
        after.remainingSeconds === after.durationSeconds &&
        before.durationSeconds !== after.durationSeconds &&
        same(
          {
            ...before,
            durationSeconds: after.durationSeconds,
            remainingSeconds: after.remainingSeconds,
          },
          after,
        )
        ? {
            field: "Duration and time remaining",
            before: duration(before.durationSeconds),
            after: duration(after.durationSeconds),
            note: "Timer stays stopped.",
          }
        : null;
    case "table": {
      if (
        after.kind !== "table" ||
        !same({ ...before, rows: after.rows }, after) ||
        before.rows.length !== after.rows.length
      )
        return null;
      // A changed plain value can recalculate formulas elsewhere. Keep the
      // full table review whenever formulas are present, even unchanged ones.
      if (
        [...before.rows, ...after.rows].some((row) =>
          row.cells.some((cell) => cell.trimStart().startsWith("=")),
        )
      )
        return null;
      const cells: Array<{ row: number; column: number }> = [];
      for (let row = 0; row < before.rows.length; row++) {
        const oldRow = before.rows[row]!,
          newRow = after.rows[row]!;
        if (
          oldRow.id !== newRow.id ||
          oldRow.cells.length !== newRow.cells.length
        )
          return null;
        for (let column = 0; column < oldRow.cells.length; column++) {
          if (oldRow.cells[column] !== newRow.cells[column])
            cells.push({ row, column });
        }
      }
      if (cells.length !== 1) return null;
      const { row, column } = cells[0]!;
      return textChange(
        `Cell ${String.fromCharCode(65 + column)}${row + 1} · ${before.columns[column]}`,
        before.rows[row]!.cells[column]!,
        after.rows[row]!.cells[column]!,
      );
    }
    case "design": {
      if (
        after.kind !== "design" ||
        before.layers.length !== after.layers.length ||
        !same({ ...before, layers: after.layers }, after)
      )
        return null;
      const changed = before.layers.flatMap((layer, index) =>
        !same(layer, after.layers[index]) ? [index] : [],
      );
      if (changed.length !== 1) return null;
      const index = changed[0]!,
        oldLayer = before.layers[index]!,
        newLayer = after.layers[index]!;
      return oldLayer.kind === "text" &&
        newLayer.kind === "text" &&
        same({ ...oldLayer, text: newLayer.text }, newLayer)
        ? textChange(
            `Text layer ${index + 1} · ${oldLayer.name}`,
            oldLayer.text,
            newLayer.text,
          )
        : null;
    }
    default:
      return null;
  }
}
