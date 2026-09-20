import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChartNoAxesCombined,
  CalendarDays,
  CheckSquare,
  Clock3,
  FileText,
  Image,
  Hash,
  Shapes,
  Plus,
  Table2,
  Timer,
  X,
} from "lucide-react";
import type { CanvasBlock, CanvasDocument } from "@eve/contracts";
import "./CanvasToolShelf.css";

const tools = [
  {
    kind: "text",
    label: "Writing",
    description: "Room for a new thought",
    icon: FileText,
  },
  {
    kind: "checklist",
    label: "Checklist",
    description: "Turn intentions into steps",
    icon: CheckSquare,
  },
  {
    kind: "table",
    label: "Table",
    description: "Compare, collect, calculate",
    icon: Table2,
  },
  {
    kind: "chart",
    label: "Chart",
    description: "See the story in your table",
    icon: ChartNoAxesCombined,
  },
  {
    kind: "metric",
    label: "Key figure",
    description: "Keep a changing value in view",
    icon: Hash,
  },
  {
    kind: "timeline",
    label: "Day plan",
    description: "Make time for what matters",
    icon: CalendarDays,
  },
  {
    kind: "timer",
    label: "Focus timer",
    description: "A little uninterrupted time",
    icon: Timer,
  },
  {
    kind: "deadline",
    label: "Countdown",
    description: "Keep a date in sight",
    icon: Clock3,
  },
  {
    kind: "sources",
    label: "Sources",
    description: "Keep useful material close",
    icon: BookOpen,
  },
  {
    kind: "design",
    label: "Design",
    description: "Arrange images, words and shapes",
    icon: Shapes,
  },
  {
    kind: "image",
    label: "Image",
    description: "Bring your own pictures",
    icon: Image,
  },
] as const;

export type AddCanvasTool = (typeof tools)[number]["kind"];

/** Registered data defaults, never authored content or model-generated UI. */
export function createCanvasTool(
  kind: AddCanvasTool,
  placement: CanvasBlock["placement"],
): CanvasBlock {
  const base = {
    id: crypto.randomUUID(),
    title: "",
    placement,
    pinned: false,
    sourceIds: [],
  };
  switch (kind) {
    case "image":
      return { ...base, kind, title: "Your image", assetId: null, caption: "" };
    case "text":
      return { ...base, kind, title: "New thought", body: "" };
    case "checklist":
      return { ...base, kind, title: "Next steps", items: [] };
    case "table":
      return {
        ...base,
        kind,
        title: "Comparison",
        columns: ["Item", "Details"],
        rows: [],
      };
    case "chart":
      return {
        ...base,
        kind,
        title: "A different perspective",
        tableId: null,
        chartType: "bar",
        labelColumn: 0,
        valueColumns: [],
      };
    case "metric":
      return {
        ...base,
        kind,
        title: "At a glance",
        tableId: null,
        rowId: null,
        column: 0,
        prefix: "",
        suffix: "",
        decimals: 0,
      };
    case "timeline":
      return {
        ...base,
        kind,
        title: "Your day",
        date: "",
        startHour: 9,
        endHour: 18,
        items: [],
      };
    case "timer":
      return {
        ...base,
        kind,
        title: "Time to focus",
        durationSeconds: 1500,
        remainingSeconds: 1500,
        endsAt: null,
      };
    case "deadline":
      return { ...base, kind, title: "Looking ahead", dueAt: null };
    case "sources":
      return { ...base, kind, title: "Related material", description: "" };
    case "design":
      return {
        ...base,
        kind,
        title: "Room to create",
        width: 960,
        height: 640,
        background: "#fbfbf8",
        layers: [],
      };
  }
}

export function CanvasToolShelf({
  document,
  disabled,
  onAdd,
}: {
  document: CanvasDocument;
  disabled: boolean;
  onAdd(kind: AddCanvasTool): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shelf = useRef<HTMLElement>(null);
  const focusAfterAdd = useRef<{
    button: HTMLButtonElement;
    index: number;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = focusAfterAdd.current;
    focusAfterAdd.current = null;
    if (
      !pending ||
      (pending.button.isConnected && !pending.button.disabled) ||
      window.document.activeElement !== window.document.body
    )
      return;
    const options = shelf.current?.querySelectorAll<HTMLButtonElement>(
      ".canvas-tool-option:not(:disabled)",
    );
    const next = options?.length
      ? options[Math.min(pending.index, options.length - 1)]
      : shelf.current?.querySelector<HTMLButtonElement>(".canvas-tools-toggle");
    next?.focus({ preventScroll: true });
  });
  const id = useId();
  return (
    <section
      ref={shelf}
      className="canvas-tool-shelf"
      data-expanded={expanded}
      aria-label="Add to your space"
    >
      <div className="canvas-tool-shelf-heading">
        <button
          type="button"
          className="canvas-tools-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={expanded ? "Fewer tools" : "All tools"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <X size={14} /> : <Plus size={14} />}
          {expanded ? "Close tools" : "Add tools"}
        </button>
      </div>
      {expanded && (
        <div id={id} className="canvas-tool-options" data-expanded="true">
          {tools.map(({ kind, label, description, icon: Icon }, index) => (
            <button
              type="button"
              key={kind}
              className="canvas-tool-option"
              disabled={disabled || document.blocks.length >= 24}
              onClick={(event) => {
                focusAfterAdd.current = { button: event.currentTarget, index };
                onAdd(kind);
              }}
              aria-label={`Add ${label.toLowerCase()}`}
            >
              <span className="canvas-tool-symbol">
                <Icon size={19} strokeWidth={1.5} />
              </span>
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <Plus size={14} className="canvas-tool-plus" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
