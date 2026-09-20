import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, LayoutGrid, Link2, Pin } from "lucide-react";
import {
  numericCanvasCell,
  type CanvasBlock,
  type CanvasDocument,
  type SourceRecord,
} from "@eve/contracts";
import type { TaskAsset } from "../../../shared/bridge";
import { AdjustedImage } from "./AdjustedImage";
import { EmptyCanvasImage } from "./CanvasImage";
import { canvasLayoutPositions } from "./canvasLayoutPositions";
import "./CanvasArrangementPreview.css";

const kinds: Record<CanvasBlock["kind"], string> = {
  text: "Writing",
  checklist: "Checklist",
  table: "Table",
  chart: "Chart",
  metric: "Value",
  timeline: "Schedule",
  image: "Image",
  design: "Design",
  timer: "Timer",
  deadline: "Deadline",
  sources: "Sources",
  note: "Note",
};
const layouts = { focus: "Page", split: "Beside", gallery: "Gallery" };
const placements = { main: "Main", aside: "Beside", full: "Full width" };
const excerpt = (value: string, limit = 130) =>
  value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function CardContent({
  block,
  document,
  assets,
}: {
  block: CanvasBlock;
  document: CanvasDocument;
  assets: TaskAsset[];
}) {
  switch (block.kind) {
    case "image":
      return (
        <>
          <div className="arrangement-thumbnail">
            {block.assetId === null ? (
              <EmptyCanvasImage compact />
            ) : (
              <AdjustedImage
                asset={assets.find(
                  (asset) =>
                    asset.id === block.assetId &&
                    asset.mediaType.startsWith("image/"),
                )}
                adjustments={block.adjustments}
                alt={block.caption || block.title || "Attached image"}
                maxHeight={90}
              />
            )}
          </div>
          {block.caption && <p>{excerpt(block.caption, 95)}</p>}
        </>
      );
    case "text":
      return (
        <p data-empty={!block.body}>
          {block.body ? excerpt(block.body) : "Blank writing space"}
        </p>
      );
    case "note":
    case "sources":
      return block.description ? <p>{excerpt(block.description)}</p> : null;
    case "checklist":
      return block.items.length ? (
        <>
          <ul className="arrangement-checklist">
            {block.items.slice(0, 2).map((item) => (
              <li key={item.id}>
                <span aria-label={item.checked ? "Done" : "Not done"}>
                  {item.checked && <Check size={9} />}
                </span>
                {excerpt(item.label, 75) || "Untitled item"}
              </li>
            ))}
          </ul>
          {block.items.length > 2 && (
            <small>{block.items.length - 2} more items</small>
          )}
        </>
      ) : (
        <p data-empty>Empty checklist</p>
      );
    case "table":
      return (
        <>
          <p className="arrangement-table-columns">
            {block.columns.join(" · ")}
          </p>
          {block.rows.slice(0, 2).map((row) => (
            <p key={row.id}>{excerpt(row.cells.join(" · "), 85)}</p>
          ))}
          <small>{block.rows.length} rows</small>
        </>
      );
    case "chart": {
      const table = document.blocks.find(
        (table) => table.kind === "table" && table.id === block.tableId,
      );
      return (
        <p>
          {block.chartType === "bar" ? "Bar chart" : "Line chart"}
          {table?.kind === "table"
            ? ` · ${table.title || "Untitled table"} · ${block.valueColumns.map((column) => table.columns[column]).join(", ")}`
            : " · No table selected"}
        </p>
      );
    }
    case "metric": {
      const table = document.blocks.find(
        (table) => table.kind === "table" && table.id === block.tableId,
      );
      const row =
        table?.kind === "table"
          ? table.rows.findIndex((row) => row.id === block.rowId)
          : -1;
      const value =
        table?.kind === "table" && row >= 0
          ? numericCanvasCell(table.rows, row, block.column)
          : null;
      return (
        <>
          <p className="arrangement-value">
            {value === null
              ? "No value selected"
              : `${block.prefix}${value.toLocaleString(undefined, { minimumFractionDigits: block.decimals, maximumFractionDigits: block.decimals })}${block.suffix}`}
          </p>
          {table && <small>{table.title || "Untitled table"}</small>}
        </>
      );
    }
    case "timeline":
      return (
        <>
          <p>{block.date || "No date set"}</p>
          {block.items.slice(0, 2).map((item) => (
            <p key={item.id}>
              {clock(item.startMinutes)} · {excerpt(item.title, 65)}
            </p>
          ))}
          {block.items.length > 2 && (
            <small>{block.items.length - 2} more events</small>
          )}
        </>
      );
    case "design":
      return (
        <>
          <p>
            {excerpt(
              block.layers
                .filter((layer) => layer.kind === "text")
                .map((layer) => layer.text)
                .filter(Boolean)
                .join(" · "),
            ) || "Layered design surface"}
          </p>
          <small>
            {block.width} × {block.height} · {block.layers.length} layers
          </small>
        </>
      );
    case "timer":
      return (
        <p>
          {duration(block.remainingSeconds)} remaining ·{" "}
          {duration(block.durationSeconds)} duration
        </p>
      );
    case "deadline":
      return (
        <p>
          {block.dueAt === null
            ? "No date set"
            : new Date(block.dueAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
        </p>
      );
  }
}

function ArrangementMap({
  document,
  other,
  assets,
  sources,
  side,
}: {
  document: CanvasDocument;
  other: CanvasDocument;
  assets: TaskAsset[];
  sources: SourceRecord[];
  side: "before" | "after";
}) {
  const root = useRef<HTMLOListElement>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const identities = JSON.stringify(document.blocks.map((block) => block.id));
  useLayoutEffect(() => {
    const element = root.current!;
    const measure = () => {
      const next: Record<string, number> = {};
      for (const child of Array.from(element.children) as HTMLElement[])
        next[child.dataset.arrangementBlockId!] = Math.ceil(
          child.getBoundingClientRect().height,
        );
      setHeights((previous) =>
        Object.keys(next).length === Object.keys(previous).length &&
        Object.entries(next).every(([id, height]) => previous[id] === height)
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [identities]);
  const positions = canvasLayoutPositions(
    document.blocks,
    document.layout,
    heights,
    10,
  );
  return (
    <>
      <div className="arrangement-layout-label">
        <strong>{layouts[document.layout]}</strong>
        <span>{document.blocks.length} items</span>
      </div>
      {document.layout !== "focus" && (
        <div className="arrangement-column-labels" aria-hidden="true">
          <span>{document.layout === "split" ? "Main" : "Column 1"}</span>
          <span>{document.layout === "split" ? "Beside" : "Column 2"}</span>
        </div>
      )}
      <ol
        ref={root}
        className="arrangement-map"
        data-arrangement-map={side}
        data-layout={document.layout}
        aria-label={
          side === "before" ? "Current item order" : "Proposed item order"
        }
      >
        {document.blocks.map((block, index) => {
          const previousIndex = other.blocks.findIndex(
            (item) => item.id === block.id,
          );
          const previous = other.blocks[previousIndex];
          const changedPlacement =
            previous && previous.placement !== block.placement;
          const changedOrder = previousIndex >= 0 && previousIndex !== index;
          const state =
            previousIndex < 0
              ? side === "after"
                ? "added"
                : "removed"
              : changedOrder || changedPlacement
                ? "moved"
                : "unchanged";
          const position = positions.get(block.id)!;
          return (
            <li
              key={block.id}
              data-arrangement-block-id={block.id}
              data-order={index + 1}
              data-placement={block.placement}
              data-change={state}
              data-column={position.column}
              data-full={position.full}
              style={position.style}
            >
              <div className="arrangement-card-heading">
                <span
                  className="arrangement-rank"
                  aria-label={`Item ${index + 1}`}
                >
                  {index + 1}
                </span>
                <div>
                  <h5>{block.title || kinds[block.kind]}</h5>
                  <span>
                    {kinds[block.kind]} · {placements[block.placement]}
                    {block.pinned && (
                      <>
                        <Pin size={10} aria-label="Pinned" />
                      </>
                    )}
                  </span>
                </div>
              </div>
              {state !== "unchanged" && (
                <div className="arrangement-card-change">
                  {state === "added" ? (
                    "Added"
                  ) : state === "removed" ? (
                    "Removed"
                  ) : (
                    <>
                      {changedOrder &&
                        `${side === "after" ? previousIndex + 1 : index + 1} → ${side === "after" ? index + 1 : previousIndex + 1}`}
                      {changedOrder && changedPlacement ? " · " : ""}
                      {changedPlacement &&
                        `${placements[side === "after" ? previous.placement : block.placement]} → ${placements[side === "after" ? block.placement : previous.placement]}`}
                    </>
                  )}
                </div>
              )}
              <CardContent block={block} document={document} assets={assets} />
              {block.sourceIds.length > 0 && (
                <ul
                  className="arrangement-sources"
                  aria-label="Attached sources"
                >
                  {block.sourceIds.map((id) => (
                    <li key={id} data-source-id={id}>
                      <Link2 size={10} aria-hidden="true" />
                      <span>
                        {sources.find((source) => source.id === id)?.title ||
                          "Source unavailable"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Compact content cards use the real placement algorithm, not editor instances. */
export function CanvasArrangementPreview({
  before,
  after,
  assets,
  sources,
}: {
  before: CanvasDocument;
  after: CanvasDocument;
  assets: TaskAsset[];
  sources: SourceRecord[];
}) {
  const id = useId();
  const [side, setSide] = useState<"before" | "after">("after");
  const gallery = before.layout === "gallery" || after.layout === "gallery";
  return (
    <section
      className="canvas-arrangement-preview"
      aria-label="Arrangement overview"
    >
      <header>
        <div>
          <LayoutGrid size={16} aria-hidden="true" />
          <h3>Arrangement</h3>
        </div>
        <span>Before → After</span>
      </header>
      <p className="arrangement-explanation">
        Compact cards show every item; numbers show item order.
        {gallery
          ? " Gallery columns balance by content height, so their exact positions may differ in your space."
          : " Main, beside and full-width placements show how the items fit together."}{" "}
        On narrow screens, the canvas stacks.
      </p>
      <div
        className="suggestion-preview-comparison"
        role="group"
        aria-label="Compare arrangement"
      >
        {(["before", "after"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={side === value}
            aria-controls={`${id}-${value}`}
            onClick={() => setSide(value)}
          >
            {value === "before" ? "Before" : "After"}
          </button>
        ))}
      </div>
      <div
        className="suggestion-preview-pair arrangement-pair"
        data-narrow-side={side}
      >
        {(["before", "after"] as const).map((value) => (
          <section
            key={value}
            id={`${id}-${value}`}
            className={`arrangement-side is-${value}`}
            aria-label={`${value === "before" ? "Before" : "After"} arrangement`}
          >
            <h4>{value === "before" ? "Before" : "After"}</h4>
            <ArrangementMap
              document={value === "before" ? before : after}
              other={value === "before" ? after : before}
              assets={assets}
              sources={sources}
              side={value}
            />
          </section>
        ))}
      </div>
    </section>
  );
}
