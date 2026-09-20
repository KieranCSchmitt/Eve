import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  Columns2,
  ChartNoAxesCombined,
  Hash,
  LayoutGrid,
  MoreHorizontal,
  Check,
  Clock3,
  FileText,
  Image as ImageIcon,
  Pencil,
  Pin,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  calculateCell,
  canvasDataEqual,
  canvasSuggestionUnavailableReason,
  type CanvasBlock,
  type CanvasDocument,
  type CanvasSuggestion,
  type SourceRecord,
} from "@eve/contracts";
import type { TaskAsset } from "../../../shared/bridge";
import { resolveYouTubeSource } from "../../../../../packages/media/src/youtube";
import "./Canvas.css";
import "./CanvasTools.css";
import { DeadlineBlock } from "./DeadlineBlock";
import { CanvasLayout } from "./CanvasLayout";
import {
  CanvasToolShelf,
  createCanvasTool,
  type AddCanvasTool,
} from "./CanvasToolShelf";
import type { CanvasNextStepsState } from "./CanvasNextSteps";
import { ChartBlock, MetricBlock } from "./CanvasDataViews";
import { DesignSurface } from "./DesignSurface";
import { CanvasImage } from "./CanvasImage";
import type { CanvasContextSteps } from "./CanvasContextAction";
import "./CanvasContextAction.css";
import {
  useCanvasTextSelection,
  type CanvasSuggestionRefreshScope,
} from "./useCanvasTextSelection";
import { useCanvasReviewExpiration } from "./useCanvasReviewExpiration";

export interface CanvasProps {
  document: CanvasDocument;
  assets: TaskAsset[];
  sources?: SourceRecord[];
  onChange(document: CanvasDocument): void;
  onOpenSource?(sourceId: string): void;
  onOpenNote?(): void;
  onAddMaterial?(): void;
  onAttachImage?(blockId: string, assetId?: string): void;
  imageAttachments?: Record<
    string,
    { pending: boolean; message?: string; needsCheck?: boolean }
  >;
  onCancelImageAttachment?(blockId: string): void;
  onCheckImageAttachment?(blockId: string): void;
  onAddSource?(): void;
  onRequestOutline?(blockId: string): void;
  onRequestSuggestion?(suggestion: CanvasSuggestion): void;
  onRequestNextSteps?(): void;
  onRequestContextSteps?(scope: CanvasSuggestionRefreshScope): void;
  onLearnAboutSelection?(scope: CanvasSuggestionRefreshScope): void;
  onAskAboutSelection?(text: string, scope: CanvasSuggestionRefreshScope): void;
  selectionInsight?: {
    scope: CanvasSuggestionRefreshScope;
    content: ReactNode;
  };
  contextSteps?: CanvasContextSteps;
  onCancelContextSteps?(): void;
  nextStepsState?: CanvasNextStepsState;
  nextStepsMessage?: string;
  onCancelNextSteps?(): void;
  suggestionPreview?: {
    targetBlockId: string | null;
    content: ReactNode;
    readyChoice?: { suggestion: CanvasSuggestion; expiresAt: number };
  };
  requestPending?: boolean;
  saveState?: "saved" | "saving" | "error";
  saveMessage?: string;
  onUndo?(): void;
  canUndo?: boolean;
  disabled?: boolean;
}

type BlockOf<K extends CanvasBlock["kind"]> = Extract<CanvasBlock, { kind: K }>;
type ContextualChoices = {
  suggestions: CanvasSuggestion[];
  onChoose(suggestion: CanvasSuggestion): void;
  previewedSuggestionId?: string;
  unavailable: Record<string, string>;
};
const newIdentity = () => crypto.randomUUID();
const durationLabel = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const minutesLabel = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const parseMinutes = (text: string): number | null => {
  if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(text) && text !== "24:00")
    return null;
  const [hour, minute] = text.split(":").map(Number);
  return hour * 60 + minute;
};
const timeLabel = (minutes: number) => {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}${minutes % 60 ? `:${String(minutes % 60).padStart(2, "0")}` : ""} ${hour >= 12 && hour < 24 ? "PM" : "AM"}`;
};

function TextBlock({
  block,
  disabled,
  requestPending,
  onChange,
  onRequestOutline,
  onRequestContextSteps,
  onLearnAboutSelection,
  onAskAboutSelection,
  selectionInsight,
  choices,
  contextSteps,
  onCancelContextSteps,
}: {
  block: BlockOf<"text">;
  disabled: boolean;
  requestPending: boolean;
  onChange(block: CanvasBlock): void;
  onRequestOutline?: CanvasProps["onRequestOutline"];
  onRequestContextSteps?: CanvasProps["onRequestContextSteps"];
  onLearnAboutSelection?: CanvasProps["onLearnAboutSelection"];
  onAskAboutSelection?: CanvasProps["onAskAboutSelection"];
  selectionInsight?: CanvasProps["selectionInsight"];
  choices?: ContextualChoices;
  contextSteps?: CanvasContextSteps;
  onCancelContextSteps?: CanvasProps["onCancelContextSteps"];
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const passage = useCanvasTextSelection({
    input,
    host,
    blockId: block.id,
    value: block.body,
    enabled: !!onAskAboutSelection && !disabled,
    insightScope: selectionInsight?.scope,
  });
  const insight =
    passage.insightVisible && selectionInsight
      ? selectionInsight.content
      : null;
  const [question, setQuestion] = useState("");
  const composingQuestion = useRef(false);
  const submittingQuestion = useRef(false);
  const scopeIdentity = JSON.stringify(passage.anchor?.scope ?? null);
  useLayoutEffect(() => setQuestion(""), [scopeIdentity]);
  const [dismissedHelp, setDismissedHelp] = useState(false);
  const [startedBlank] = useState(() => !block.body.trim());
  const blank = !block.body.trim();
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    let active = true;
    let width = element.getBoundingClientRect().width;
    const fit = () => {
      if (!active) return;
      element.style.height = "auto";
      element.style.height = `${Math.max(blank || startedBlank ? 280 : 90, element.scrollHeight + 2)}px`;
    };
    fit();
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      // Height-only changes include the user's resize handle; leave them alone.
      if (nextWidth !== width) {
        width = nextWidth;
        fit();
      }
    });
    observer.observe(element);
    void window.document.fonts.ready.then(fit);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [block.body, blank, startedBlank]);
  return (
    <div
      ref={host}
      className="canvas-body-copy canvas-context-selection-host"
      data-empty={blank}
      style={{ paddingBottom: passage.reservedHeight || undefined }}
    >
      <textarea
        ref={input}
        className="canvas-editable-copy"
        aria-label={block.title ? `${block.title} text` : "Canvas text"}
        value={block.body}
        placeholder="Start writing…"
        maxLength={20_000}
        disabled={disabled}
        spellCheck
        onChange={(event) => onChange({ ...block, body: event.target.value })}
        {...passage.events}
      />
      {passage.anchor && (
        <div
          ref={passage.action}
          className="canvas-context-selection"
          style={passage.position}
          role="group"
          aria-label="Selected passage actions"
          onBlur={passage.events.onBlur}
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !event.nativeEvent.isComposing &&
              !composingQuestion.current
            ) {
              event.preventDefault();
              event.stopPropagation();
              passage.dismiss(true);
            }
          }}
        >
          <form
            className="canvas-context-selection-tools canvas-context-question"
            aria-label="Ask about selected text"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                disabled ||
                requestPending ||
                composingQuestion.current ||
                submittingQuestion.current ||
                !question.trim()
              )
                return;
              const scope = passage.currentScope();
              if (!scope || !onAskAboutSelection) return;
              submittingQuestion.current = true;
              try {
                passage.retain();
                onAskAboutSelection(question, scope);
              } finally {
                queueMicrotask(() => {
                  submittingQuestion.current = false;
                });
              }
            }}
          >
            <input
              className="canvas-context-question-input"
              aria-label="Ask about selection"
              placeholder="Ask about this…"
              value={question}
              maxLength={16000}
              onChange={(event) => setQuestion(event.target.value)}
              onCompositionStart={() => {
                composingQuestion.current = true;
              }}
              onCompositionEnd={() => {
                composingQuestion.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.nativeEvent.isComposing || composingQuestion.current)
                )
                  event.preventDefault();
              }}
            />
            <button
              type="submit"
              className="canvas-context-question-send"
              aria-label="Send selection request"
              title="Send selection request"
              aria-disabled={disabled || requestPending || !question.trim()}
              onPointerDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="canvas-context-dismiss"
              aria-label="Dismiss passage actions"
              onPointerDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
              onClick={() => passage.dismiss(true)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </form>
          {insight && <div className="canvas-context-insight">{insight}</div>}
        </div>
      )}
      {blank && !dismissedHelp && onRequestOutline && (
        <div
          className="canvas-writing-help"
          role="group"
          aria-label="Writing help"
        >
          <Sparkles size={15} aria-hidden="true" />
          <span>Need a starting point?</span>
          <button
            type="button"
            className="canvas-writing-help-action"
            aria-disabled={disabled || requestPending}
            onClick={() => {
              if (!disabled && !requestPending) onRequestOutline(block.id);
            }}
          >
            Make an outline
          </button>
          <button
            type="button"
            className="canvas-icon-button"
            aria-label="Dismiss writing help"
            onClick={() => setDismissedHelp(true)}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function ChecklistBlock({
  block,
  disabled,
  onChange,
}: {
  block: BlockOf<"checklist">;
  disabled: boolean;
  onChange(block: CanvasBlock): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const prefix = useId();
  return (
    <>
      <ul className="canvas-checklist">
        {block.items.map((item, index) => (
          <li key={item.id} data-checked={item.checked}>
            <div className="canvas-check">
              <input
                id={`${prefix}-${item.id}`}
                type="checkbox"
                checked={item.checked}
                disabled={disabled}
                aria-label={item.label || `Item ${index + 1}`}
                onChange={(event) =>
                  onChange({
                    ...block,
                    items: block.items.map((candidate) =>
                      candidate.id === item.id
                        ? { ...candidate, checked: event.target.checked }
                        : candidate,
                    ),
                  })
                }
              />
              {editing === item.id ? (
                <input
                  autoFocus
                  className="canvas-check-label-input"
                  aria-label={`Edit item ${index + 1}`}
                  value={item.label}
                  maxLength={1000}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      items: block.items.map((candidate) =>
                        candidate.id === item.id
                          ? { ...candidate, label: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                  onBlur={() => setEditing(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape")
                      setEditing(null);
                  }}
                />
              ) : (
                <label
                  htmlFor={`${prefix}-${item.id}`}
                  className="canvas-check-copy"
                >
                  <span className="canvas-check-label">
                    {item.label || "Untitled item"}
                  </span>
                </label>
              )}
            </div>
            <div className="canvas-item-actions">
              <button
                className="canvas-icon-button"
                aria-label={`Edit ${item.label || `item ${index + 1}`}`}
                disabled={disabled}
                onClick={() => setEditing(item.id)}
              >
                <Pencil size={13} />
              </button>
              <button
                className="canvas-icon-button"
                aria-label={`Remove ${item.label || `item ${index + 1}`}`}
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...block,
                    items: block.items.filter(
                      (candidate) => candidate.id !== item.id,
                    ),
                  })
                }
              >
                <X size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        className="canvas-add-button"
        disabled={disabled || block.items.length >= 60}
        onClick={() => {
          const id = newIdentity();
          onChange({
            ...block,
            items: [...block.items, { id, label: "", checked: false }],
          });
          setEditing(id);
        }}
      >
        <Plus size={14} />
        Add item
      </button>
    </>
  );
}

function TableBlock({
  block,
  disabled,
  onChange,
  onCreateDataView,
}: {
  block: BlockOf<"table">;
  disabled: boolean;
  onChange(block: CanvasBlock): void;
  onCreateDataView?(tableId: string, kind: "chart" | "metric"): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [formula, setFormula] = useState("");
  return (
    <>
      <div
        className="canvas-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${block.title || "Table"} — scroll to see all columns`}
      >
        <table className="canvas-table">
          <thead>
            <tr>
              {block.columns.map((column, index) => (
                <th key={index} scope="col">
                  <input
                    className="canvas-cell-input"
                    aria-label={`Column ${String.fromCharCode(65 + index)} heading`}
                    value={column}
                    maxLength={80}
                    disabled={disabled}
                    onChange={(event) => {
                      if (event.target.value.trim())
                        onChange({
                          ...block,
                          columns: block.columns.map((value, candidate) =>
                            candidate === index ? event.target.value : value,
                          ),
                        });
                    }}
                  />
                </th>
              ))}
              <th className="canvas-table-actions">
                <span className="canvas-sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={row.id}>
                {row.cells.map((cell, columnIndex) => {
                  const reference = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
                  const key = `${row.id}:${columnIndex}`;
                  const calculated = calculateCell(
                    block.rows,
                    rowIndex,
                    columnIndex,
                  );
                  const invalid =
                    typeof calculated === "string" &&
                    calculated.startsWith("#") &&
                    cell.startsWith("=");
                  return (
                    <td
                      key={columnIndex}
                      data-calculated={cell.startsWith("=")}
                    >
                      <input
                        data-table-cell-row={row.id}
                        data-table-cell-column={columnIndex}
                        className={`canvas-cell-input${invalid ? " canvas-calculation-error" : ""}`}
                        aria-label={`${reference}: ${block.columns[columnIndex]}`}
                        aria-invalid={invalid || undefined}
                        title={cell.startsWith("=") ? cell : undefined}
                        value={editing === key ? cell : String(calculated)}
                        maxLength={1000}
                        disabled={disabled}
                        onFocus={() => {
                          setEditing(key);
                          setFormula(
                            cell.startsWith("=") ? `${reference} ${cell}` : "",
                          );
                        }}
                        onBlur={() => {
                          setEditing(null);
                          setFormula("");
                        }}
                        onChange={(event) => {
                          const value = event.target.value;
                          setFormula(
                            value.startsWith("=")
                              ? `${reference} ${value}`
                              : "",
                          );
                          onChange({
                            ...block,
                            rows: block.rows.map((candidate) =>
                              candidate.id === row.id
                                ? {
                                    ...candidate,
                                    cells: candidate.cells.map(
                                      (value, index) =>
                                        index === columnIndex
                                          ? event.target.value
                                          : value,
                                    ),
                                  }
                                : candidate,
                            ),
                          });
                        }}
                      />
                    </td>
                  );
                })}
                <td className="canvas-table-actions">
                  <button
                    className="canvas-icon-button"
                    disabled={disabled}
                    aria-label={`Remove row ${rowIndex + 1}`}
                    onClick={() =>
                      onChange({
                        ...block,
                        rows: block.rows.filter(
                          (candidate) => candidate.id !== row.id,
                        ),
                      })
                    }
                  >
                    <X size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="canvas-calculation-note" aria-live="polite">
        {formula ||
          "Edit a value to update the table. Formulas use cells such as =B1-B2."}
      </p>
      <div className="canvas-table-followups">
        <button
          className="canvas-add-button"
          disabled={disabled || block.rows.length >= 80}
          onClick={() =>
            onChange({
              ...block,
              rows: [
                ...block.rows,
                { id: newIdentity(), cells: block.columns.map(() => "") },
              ],
            })
          }
        >
          <Plus size={14} />
          Add row
        </button>
        {onCreateDataView && (
          <>
            <button
              className="canvas-add-button"
              disabled={disabled}
              onClick={() => onCreateDataView(block.id, "chart")}
            >
              <ChartNoAxesCombined size={14} />
              Visualize table
            </button>
            <button
              className="canvas-add-button"
              disabled={disabled}
              onClick={() => onCreateDataView(block.id, "metric")}
            >
              <Hash size={14} />
              Highlight a value
            </button>
          </>
        )}
      </div>
    </>
  );
}

function TimelineBlock({
  block,
  disabled,
  onChange,
}: {
  block: BlockOf<"timeline">;
  disabled: boolean;
  onChange(block: CanvasBlock): void;
}) {
  const [selected, setSelected] = useState<string | null>(
    () =>
      block.items.find((item) => item.status === "suggested")?.id ??
      block.items[0]?.id ??
      null,
  );
  const panoramic = block.placement === "full";
  const rail = useRef<HTMLDivElement>(null);
  const [railWidth, setRailWidth] = useState(650);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    const measure = () =>
      setRailWidth(element.getBoundingClientRect().width || 650);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [panoramic]);
  const sorted = [...block.items].sort(
    (a, b) => a.startMinutes - b.startMinutes,
  );
  const active = sorted.find((item) => item.id === selected) ?? sorted[0];
  const totalMinutes = (block.endHour - block.startHour) * 60;
  const lanes: number[] = [];
  const positions = sorted.map((item) => {
    const actualLeft =
      ((item.startMinutes - block.startHour * 60) / totalMinutes) * 100;
    const width = Math.min(
      100,
      Math.max(
        (64 / railWidth) * 100,
        ((item.endMinutes - item.startMinutes) / totalMinutes) * 100,
      ),
    );
    const left = Math.min(actualLeft, 100 - width);
    let lane = lanes.findIndex((end) => end <= left + 0.000001);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = left + width;
    return { item, left, width, lane };
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    start: "09:00",
    end: "10:00",
    detail: "",
  });
  const [error, setError] = useState("");
  const beginEdit = (item: BlockOf<"timeline">["items"][number]) => {
    setEditing(item.id);
    setDraft({
      title: item.title,
      start: minutesLabel(item.startMinutes),
      end: minutesLabel(item.endMinutes),
      detail: item.detail,
    });
    setError("");
  };
  const commit = (item: BlockOf<"timeline">["items"][number]) => {
    const start = parseMinutes(draft.start),
      end = parseMinutes(draft.end);
    if (start === null || end === null || start >= 1440 || end <= start) {
      setError("Use times such as 09:00, with an end time after the start.");
      return;
    }
    onChange({
      ...block,
      startHour: Math.min(block.startHour, Math.floor(start / 60)),
      endHour: Math.max(block.endHour, Math.ceil(end / 60)),
      items: block.items.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              title: draft.title,
              detail: draft.detail,
              startMinutes: start,
              endMinutes: end,
            }
          : candidate,
      ),
    });
    setEditing(null);
    setError("");
  };
  return (
    <>
      <div className="canvas-timeline-caption">
        <span>{block.date}</span>
        <span>Local plan</span>
      </div>
      {panoramic && (
        <div className="canvas-day-scroll">
          <div
            className="canvas-day"
            ref={rail}
            aria-label="Day at a glance"
            style={{ minHeight: 48 + Math.max(1, lanes.length) * 84 }}
          >
            <div className="canvas-day-hours" aria-hidden="true">
              {Array.from(
                { length: block.endHour - block.startHour },
                (_, index) => (
                  <div
                    key={index}
                    style={{
                      left: `${(index / (block.endHour - block.startHour)) * 100}%`,
                    }}
                  >
                    <span>{timeLabel((block.startHour + index) * 60)}</span>
                  </div>
                ),
              )}
            </div>
            {positions.map(({ item, left, width, lane }) => (
              <button
                key={item.id}
                type="button"
                className="canvas-day-event"
                aria-label={`Show ${item.title || "plan item"}`}
                aria-pressed={active?.id === item.id}
                data-suggested={item.status === "suggested"}
                data-done={item.status === "done"}
                data-short={width < 9}
                style={{
                  left: `${left}%`,
                  width: `calc(${width}% - 4px)`,
                  top: 39 + lane * 84,
                }}
                onClick={() => setSelected(item.id)}
              >
                <span>{timeLabel(item.startMinutes)}</span>
                <strong>{item.title || "Untitled item"}</strong>
                {item.status === "suggested" && <small>Suggested</small>}
                {item.status === "done" && <small>Complete</small>}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="canvas-timeline" data-panoramic={panoramic}>
        {(panoramic ? (active ? [active] : []) : sorted).map((item) => (
          <div
            className="canvas-timeline-item"
            key={item.id}
            data-suggested={item.status === "suggested"}
            data-done={item.status === "done"}
          >
            <div className="canvas-timeline-time">
              {timeLabel(item.startMinutes)}
            </div>
            <article
              className="canvas-timeline-card"
              aria-label={item.title || "Plan item"}
            >
              {item.status === "suggested" && (
                <div className="canvas-suggestion-label">
                  <Sparkles size={11} />
                  Suggested · not kept yet
                </div>
              )}
              {item.status === "done" && (
                <div className="canvas-suggestion-label">
                  <Check size={11} />
                  Done
                </div>
              )}
              <div className="canvas-timeline-title">
                {item.title || "Untitled item"}
              </div>
              <p className="canvas-timeline-detail">
                {timeLabel(item.startMinutes)} – {timeLabel(item.endMinutes)}
                {item.detail ? ` · ${item.detail}` : ""}
              </p>
              {editing === item.id ? (
                <form
                  className="canvas-timeline-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    commit(item);
                  }}
                >
                  <label>
                    Title
                    <input
                      autoFocus
                      aria-label="Plan item title"
                      value={draft.title}
                      maxLength={160}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({ ...draft, title: event.target.value })
                      }
                    />
                  </label>
                  <div className="canvas-time-inputs">
                    <label>
                      Start
                      <input
                        aria-label="Start time"
                        value={draft.start}
                        placeholder="09:00"
                        maxLength={5}
                        disabled={disabled}
                        onChange={(event) =>
                          setDraft({ ...draft, start: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      End
                      <input
                        aria-label="End time"
                        value={draft.end}
                        placeholder="10:00"
                        maxLength={5}
                        disabled={disabled}
                        onChange={(event) =>
                          setDraft({ ...draft, end: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Details
                    <input
                      aria-label="Plan item details"
                      value={draft.detail}
                      maxLength={1000}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({ ...draft, detail: event.target.value })
                      }
                    />
                  </label>
                  {error && (
                    <p className="canvas-calculation-error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="canvas-timeline-actions">
                    <button
                      className="canvas-primary-button"
                      type="submit"
                      disabled={disabled}
                    >
                      Save item
                    </button>
                    <button
                      className="canvas-secondary-button"
                      type="button"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="canvas-timeline-actions">
                  {item.status === "suggested" ? (
                    <button
                      className="canvas-primary-button"
                      disabled={disabled}
                      aria-label={`Keep ${item.title}`}
                      onClick={() =>
                        onChange({
                          ...block,
                          items: block.items.map((candidate) =>
                            candidate.id === item.id
                              ? { ...candidate, status: "planned" as const }
                              : candidate,
                          ),
                        })
                      }
                    >
                      Keep
                    </button>
                  ) : (
                    <button
                      className="canvas-secondary-button"
                      disabled={disabled}
                      aria-label={`${item.status === "done" ? "Reopen" : "Complete"} ${item.title}`}
                      onClick={() =>
                        onChange({
                          ...block,
                          items: block.items.map((candidate) =>
                            candidate.id === item.id
                              ? {
                                  ...candidate,
                                  status:
                                    candidate.status === "done"
                                      ? ("planned" as const)
                                      : ("done" as const),
                                }
                              : candidate,
                          ),
                        })
                      }
                    >
                      {item.status === "done" ? "Reopen" : "Done"}
                    </button>
                  )}
                  <button
                    className="canvas-secondary-button"
                    disabled={disabled}
                    aria-label={`Adjust ${item.title}`}
                    onClick={() => beginEdit(item)}
                  >
                    Adjust
                  </button>
                  <button
                    className="canvas-icon-button"
                    disabled={disabled}
                    aria-label={`${item.status === "suggested" ? "Dismiss" : "Remove"} ${item.title}`}
                    onClick={() =>
                      onChange({
                        ...block,
                        items: block.items.filter(
                          (candidate) => candidate.id !== item.id,
                        ),
                      })
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </article>
          </div>
        ))}
      </div>
      <button
        className="canvas-add-button"
        disabled={disabled || block.items.length >= 40}
        onClick={() => {
          const item = {
            id: newIdentity(),
            title: "New plan item",
            startMinutes: block.startHour * 60,
            endMinutes: Math.min(1440, (block.startHour + 1) * 60),
            status: "planned" as const,
            detail: "",
          };
          onChange({ ...block, items: [...block.items, item] });
          setSelected(item.id);
          beginEdit(item);
        }}
      >
        <Plus size={14} />
        Add to plan
      </button>
    </>
  );
}

function TimerBlock({
  block,
  disabled,
  onChange,
}: {
  block: BlockOf<"timer">;
  disabled: boolean;
  onChange(block: CanvasBlock): void;
}) {
  const [now, setNow] = useState(Date.now);
  const [duration, setDuration] = useState(
    durationLabel(block.durationSeconds),
  );
  useEffect(
    () => setDuration(durationLabel(block.durationSeconds)),
    [block.durationSeconds],
  );
  useEffect(() => {
    setNow(Date.now());
    if (block.endsAt === null) return;
    const deadline = block.endsAt;
    if (deadline <= Date.now()) return;
    const interval = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) clearInterval(interval);
    }, 250);
    return () => clearInterval(interval);
  }, [block.endsAt]);
  const remaining =
    block.endsAt === null
      ? block.remainingSeconds
      : Math.max(
          0,
          Math.min(
            block.durationSeconds,
            Math.ceil((block.endsAt - now) / 1000),
          ),
        );
  const running = block.endsAt !== null && remaining > 0;
  const display = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  const commitDuration = () => {
    if (disabled) return;
    const valid = /^\d{1,4}:[0-5]\d$/.test(duration);
    const [minutes, remainder] = duration.split(":").map(Number);
    const seconds = minutes * 60 + remainder;
    if (
      !valid ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 86400
    ) {
      setDuration(durationLabel(block.durationSeconds));
      return;
    }
    if (seconds !== block.durationSeconds)
      onChange({
        ...block,
        durationSeconds: seconds,
        remainingSeconds: seconds,
        endsAt: null,
      });
  };
  return (
    <>
      <div className="canvas-countdown-card">
        <div className="canvas-countdown-face">
          <Clock3 size={27} strokeWidth={1.4} />
          <span
            className="canvas-countdown-time"
            role="timer"
            aria-label={`${remaining} seconds remaining`}
          >
            {display}
          </span>
        </div>
        <div className="canvas-countdown-actions">
          <button
            className="canvas-primary-button"
            disabled={disabled}
            aria-label={`${running ? "Pause" : remaining === 0 ? "Restart" : "Start"} ${block.title || "timer"}`}
            onClick={() => {
              const current = Date.now();
              setNow(current);
              if (running)
                onChange({
                  ...block,
                  remainingSeconds: Math.max(
                    0,
                    Math.min(
                      block.durationSeconds,
                      Math.ceil((block.endsAt! - current) / 1000),
                    ),
                  ),
                  endsAt: null,
                });
              else {
                const seconds =
                  remaining === 0 ? block.durationSeconds : remaining;
                onChange({
                  ...block,
                  remainingSeconds: seconds,
                  endsAt: current + seconds * 1000,
                });
              }
            }}
          >
            {running ? "Pause" : remaining === 0 ? "Restart" : "Start"}
          </button>
          <button
            className="canvas-icon-button"
            disabled={disabled}
            aria-label={`Reset ${block.title || "timer"}`}
            onClick={() =>
              onChange({
                ...block,
                remainingSeconds: block.durationSeconds,
                endsAt: null,
              })
            }
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
      <div className="canvas-countdown-meta">
        {remaining === 0 ? (
          <p role="status">Time is up.</p>
        ) : running ? (
          <p>Timer running</p>
        ) : (
          <label>
            Duration{" "}
            <input
              className="canvas-countdown-input"
              aria-label={`${block.title || "Timer"} duration, minutes and seconds`}
              type="text"
              inputMode="numeric"
              maxLength={7}
              placeholder="08:00"
              disabled={disabled}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              onBlur={commitDuration}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDuration();
              }}
            />{" "}
            min:sec
          </label>
        )}
      </div>
    </>
  );
}

function SourceLinks({
  ids,
  sources,
  onOpen,
}: {
  ids: string[];
  sources: SourceRecord[];
  onOpen?: (id: string) => void;
}) {
  return ids.length ? (
    <div className="canvas-sources">
      {ids.map((id) => {
        const source = sources.find((candidate) => candidate.id === id);
        return (
          <button
            key={id}
            className="canvas-source-link"
            disabled={!source || !onOpen}
            onClick={() => source && onOpen?.(source.id)}
          >
            {source?.title || "Source unavailable"}
            <ArrowUpRight size={12} />
          </button>
        );
      })}
    </div>
  ) : null;
}

function Block({
  block,
  tables,
  assets,
  sources,
  disabled,
  requestPending,
  onChange,
  onOpenSource,
  onOpenNote,
  onAddMaterial,
  onAttachImage,
  imageAttachment,
  onCancelImageAttachment,
  onCheckImageAttachment,
  onAddSource,
  onRequestOutline,
  onRequestContextSteps,
  onLearnAboutSelection,
  onAskAboutSelection,
  selectionInsight,
  choices,
  contextSteps,
  onCancelContextSteps,
  onRevealTable,
  onCreateDataView,
}: {
  block: CanvasBlock;
  tables: BlockOf<"table">[];
  assets: TaskAsset[];
  sources: SourceRecord[];
  disabled: boolean;
  requestPending: boolean;
  onChange(block: CanvasBlock): void;
  onOpenSource?: CanvasProps["onOpenSource"];
  onOpenNote?: CanvasProps["onOpenNote"];
  onAddMaterial?: CanvasProps["onAddMaterial"];
  onAttachImage?: CanvasProps["onAttachImage"];
  imageAttachment?: NonNullable<CanvasProps["imageAttachments"]>[string];
  onCancelImageAttachment?: CanvasProps["onCancelImageAttachment"];
  onCheckImageAttachment?: CanvasProps["onCheckImageAttachment"];
  onAddSource?: CanvasProps["onAddSource"];
  onRequestOutline?: CanvasProps["onRequestOutline"];
  onRequestContextSteps?: CanvasProps["onRequestContextSteps"];
  onLearnAboutSelection?: CanvasProps["onLearnAboutSelection"];
  onAskAboutSelection?: CanvasProps["onAskAboutSelection"];
  selectionInsight?: CanvasProps["selectionInsight"];
  choices?: ContextualChoices;
  contextSteps?: CanvasContextSteps;
  onCancelContextSteps?: CanvasProps["onCancelContextSteps"];
  onRevealTable(tableId: string, rowId?: string, column?: number): void;
  onCreateDataView?(tableId: string, kind: "chart" | "metric"): void;
}) {
  switch (block.kind) {
    case "text":
      return (
        <TextBlock
          block={block}
          disabled={disabled}
          requestPending={requestPending}
          onChange={onChange}
          onRequestOutline={onRequestOutline}
          onRequestContextSteps={onRequestContextSteps}
          onLearnAboutSelection={onLearnAboutSelection}
          onAskAboutSelection={onAskAboutSelection}
          selectionInsight={selectionInsight}
          choices={choices}
          contextSteps={contextSteps}
          onCancelContextSteps={onCancelContextSteps}
        />
      );
    case "checklist":
      return (
        <ChecklistBlock block={block} disabled={disabled} onChange={onChange} />
      );
    case "table":
      return (
        <TableBlock
          block={block}
          disabled={disabled}
          onChange={onChange}
          onCreateDataView={onCreateDataView}
        />
      );
    case "chart":
      return (
        <ChartBlock
          block={block}
          tables={tables}
          disabled={disabled}
          onChange={onChange}
          onRevealTable={onRevealTable}
        />
      );
    case "metric":
      return (
        <MetricBlock
          block={block}
          tables={tables}
          disabled={disabled}
          onChange={onChange}
          onRevealTable={onRevealTable}
        />
      );
    case "timeline":
      return (
        <TimelineBlock block={block} disabled={disabled} onChange={onChange} />
      );
    case "timer":
      return (
        <TimerBlock block={block} disabled={disabled} onChange={onChange} />
      );
    case "deadline":
      return (
        <DeadlineBlock block={block} disabled={disabled} onChange={onChange} />
      );
    case "image":
      return (
        <CanvasImage
          block={block}
          assets={assets}
          disabled={disabled}
          onChange={onChange}
          onAddMaterial={disabled ? undefined : onAddMaterial}
          onAttachImage={onAttachImage}
          attachment={imageAttachment}
          onCancelImageAttachment={onCancelImageAttachment}
          onCheckImageAttachment={onCheckImageAttachment}
        />
      );
    case "design":
      return (
        <DesignSurface
          block={block}
          assets={assets}
          disabled={disabled}
          onChange={onChange}
          onAddMaterial={disabled ? undefined : onAddMaterial}
        />
      );
    case "note":
      return (
        <div className="canvas-reference-card">
          <div className="canvas-reference-heading">
            <FileText size={17} />
            Your notebook
          </div>
          <p className="canvas-reference-excerpt">
            {block.description || "Pick up your writing where you left it."}
          </p>
          <button
            className="canvas-add-button"
            disabled={!onOpenNote}
            onClick={onOpenNote}
          >
            Open notebook
            <ArrowUpRight size={14} />
          </button>
        </div>
      );
    case "sources":
      return (
        <div className="canvas-reference-list">
          {block.description && (
            <p className="canvas-reference-excerpt">{block.description}</p>
          )}
          {block.sourceIds.map((id) => {
            const source = sources.find((candidate) => candidate.id === id);
            const video = Boolean(
              source?.url && resolveYouTubeSource(source.url).supported,
            );
            return (
              <article
                className="canvas-reference-card"
                key={id}
                data-media={video ? "video" : "article"}
              >
                {video && (
                  <button
                    type="button"
                    className="canvas-video-preview"
                    disabled={!onOpenSource || disabled}
                    aria-label={`Watch ${source!.title}`}
                    onClick={() => onOpenSource?.(id)}
                  >
                    <span className="canvas-video-play">
                      <Play size={22} fill="currentColor" />
                    </span>
                    <span>
                      Watch video <ArrowUpRight size={13} />
                    </span>
                  </button>
                )}
                <div className="canvas-reference-heading">
                  {video ? <Play size={17} /> : <FileText size={17} />}
                  {source?.title || "Source unavailable"}
                </div>
                {source && (
                  <>
                    <p className="canvas-reference-excerpt">
                      {source.excerpt.length > 700
                        ? `${source.excerpt.slice(0, 700)}…`
                        : source.excerpt}
                    </p>
                    <p className="canvas-reference-meta">
                      {source.provenance.attribution}
                    </p>
                  </>
                )}
                <SourceLinks
                  ids={[id]}
                  sources={sources}
                  onOpen={onOpenSource}
                />
              </article>
            );
          })}
          {block.sourceIds.length === 0 && (
            <p className="canvas-reference-meta">
              Keep a useful article or video beside your work.
            </p>
          )}
          {onAddSource && (
            <button
              type="button"
              className="canvas-add-button"
              disabled={disabled}
              onClick={onAddSource}
            >
              <Plus size={14} />
              Find or add a source
            </button>
          )}
        </div>
      );
  }
}

export function Canvas({
  document,
  assets,
  sources = [],
  onChange,
  onOpenSource,
  onOpenNote,
  onAddMaterial,
  onAttachImage,
  imageAttachments,
  onCancelImageAttachment,
  onCheckImageAttachment,
  onAddSource,
  onRequestOutline,
  onRequestSuggestion,
  onRequestNextSteps,
  onRequestContextSteps,
  onLearnAboutSelection,
  onAskAboutSelection,
  selectionInsight,
  contextSteps,
  onCancelContextSteps,
  nextStepsState,
  nextStepsMessage,
  onCancelNextSteps,
  suggestionPreview,
  requestPending = false,
  saveState = "saved",
  saveMessage,
  onUndo,
  canUndo = false,
  disabled = false,
}: CanvasProps) {
  const headingId = useId();
  const unavailableSuggestions = useMemo(
    () =>
      Object.fromEntries(
        (document.suggestions ?? []).flatMap((suggestion) => {
          const reason = canvasSuggestionUnavailableReason(
            document,
            suggestion,
          );
          return reason ? [[suggestion.id, reason]] : [];
        }),
      ),
    [document],
  );
  const canvasElement = useRef<HTMLElement>(null);
  const readyChoice = suggestionPreview?.readyChoice;
  const reviewExpired = useCanvasReviewExpiration(readyChoice?.expiresAt);
  const previewedSuggestion =
    readyChoice && Number.isFinite(readyChoice.expiresAt) && !reviewExpired
      ? document.suggestions?.find(
          (choice) =>
            choice.prepared &&
            !unavailableSuggestions[choice.id] &&
            canvasDataEqual(choice, readyChoice.suggestion),
        )
      : undefined;
  const chooseSuggestion = (suggestion: CanvasSuggestion) => {
    if (disabled || requestPending || unavailableSuggestions[suggestion.id])
      return;
    if (
      previewedSuggestion &&
      canvasDataEqual(suggestion, previewedSuggestion) &&
      readyChoice!.expiresAt > Date.now()
    ) {
      const review = canvasElement.current?.querySelector<HTMLElement>(
        ".canvas-suggestion-preview",
      );
      if (review) {
        // Only this deliberate activation moves attention. Arrival is passive,
        // and focusing a region instead of Keep cannot approve on repeated Enter.
        review.tabIndex = -1;
        review.focus({ preventScroll: true });
        review.scrollIntoView({ block: "nearest", behavior: "instant" });
        return;
      }
    }
    onRequestSuggestion?.(suggestion);
  };
  const [choosingImage, setChoosingImage] = useState(false);
  const imageChooserWasOpen = useRef(false);
  useLayoutEffect(() => {
    if (
      imageChooserWasOpen.current &&
      !choosingImage &&
      window.document.activeElement === window.document.body
    ) {
      const target =
        canvasElement.current?.querySelector<HTMLButtonElement>(
          '.canvas-tool-option[aria-label="Add image"]',
        ) ??
        canvasElement.current?.querySelector<HTMLButtonElement>(
          ".canvas-tools-toggle",
        );
      target?.focus({ preventScroll: true });
    }
    imageChooserWasOpen.current = choosingImage;
  }, [choosingImage]);
  const addTool = (kind: AddCanvasTool) => {
    if (disabled || document.blocks.length >= 24) return;
    if (kind === "image") {
      setChoosingImage(true);
      return;
    }
    const placement =
      kind === "text" || kind === "chart" || kind === "design"
        ? "main"
        : kind === "timeline"
          ? "full"
          : "aside";
    onChange({
      ...document,
      layout:
        placement === "aside" && document.layout === "focus"
          ? "split"
          : document.layout,
      blocks: [...document.blocks, createCanvasTool(kind, placement)],
    });
  };
  const createDataView = (tableId: string, kind: "chart" | "metric") => {
    if (disabled || document.blocks.length >= 24) return;
    const table = document.blocks.find(
      (block) => block.kind === "table" && block.id === tableId,
    );
    if (!table || table.kind !== "table") return;
    const block = createCanvasTool(kind, kind === "chart" ? "main" : "aside");
    const linked =
      block.kind === "chart"
        ? {
            ...block,
            tableId,
            title: table.title || "Your chart",
            valueColumns: [table.columns.length > 1 ? 1 : 0],
          }
        : block.kind === "metric"
          ? { ...block, tableId, column: table.columns.length > 1 ? 1 : 0 }
          : block;
    onChange({
      ...document,
      layout: document.layout === "focus" ? "split" : document.layout,
      blocks: [...document.blocks, linked],
    });
  };
  // Only explicit local deletion repairs links. Model documents must satisfy
  // the complete contract before they reach this component.
  const withAvailableData = (next: CanvasDocument): CanvasDocument => ({
    ...next,
    blocks: next.blocks.map((block) => {
      if (block.kind !== "chart" && block.kind !== "metric") return block;
      const table = next.blocks.find(
        (candidate) =>
          candidate.id === block.tableId && candidate.kind === "table",
      );
      if (!table || table.kind !== "table") {
        if (block.tableId === null) return block;
        return block.kind === "chart"
          ? { ...block, tableId: null }
          : { ...block, tableId: null, rowId: null };
      }
      if (
        block.kind === "metric" &&
        block.rowId !== null &&
        !table.rows.some((row) => row.id === block.rowId)
      )
        return { ...block, rowId: null };
      return block;
    }),
  });
  const revealTable = (tableId: string, rowId?: string, column?: number) => {
    // A user-chosen Edit data action is allowed to focus its actual retained
    // editor. Rendering a changed value never invokes this path.
    const section = [
      ...(canvasElement.current?.querySelectorAll<HTMLElement>(
        "[data-canvas-block-id]",
      ) ?? []),
    ].find((element) => element.dataset.canvasBlockId === tableId);
    if (!section) return;
    const cell = [
      ...section.querySelectorAll<HTMLInputElement>("[data-table-cell-row]"),
    ].find(
      (element) =>
        (rowId === undefined || element.dataset.tableCellRow === rowId) &&
        (column === undefined ||
          element.dataset.tableCellColumn === String(column)),
    );
    const target =
      cell ?? section.querySelector<HTMLElement>(".canvas-table-scroll");
    target?.scrollIntoView({ block: "center", behavior: "auto" });
    target?.focus({ preventScroll: true });
  };
  const moveBlock = (id: string, offset: number) => {
    const blocks = [...document.blocks];
    const index = blocks.findIndex((block) => block.id === id);
    if (disabled || index + offset < 0 || index + offset >= blocks.length)
      return;
    [blocks[index], blocks[index + offset]] = [
      blocks[index + offset],
      blocks[index],
    ];
    onChange({ ...document, blocks });
  };
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const replace = (next: CanvasBlock) =>
    onChange(
      withAvailableData({
        ...document,
        blocks: document.blocks.map((block) =>
          block.id === next.id ? next : block,
        ),
      }),
    );
  const renderBlock = (block: CanvasBlock) => (
    <section
      key={block.id}
      className="canvas-block"
      data-kind={block.kind}
      data-canvas-block-id={block.id}
      data-placement={block.placement}
      data-pinned={block.pinned}
      aria-label={block.title || `${block.kind} item`}
    >
      <div className="canvas-block-heading">
        {editingTitle === block.id ? (
          <input
            className="canvas-block-title-input"
            autoFocus
            aria-label="Item heading"
            value={block.title}
            maxLength={160}
            disabled={disabled}
            onChange={(event) =>
              replace({ ...block, title: event.target.value })
            }
            onBlur={() => setEditingTitle(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape")
                setEditingTitle(null);
            }}
          />
        ) : (
          <h2>{block.title}</h2>
        )}
        <div className="canvas-block-actions">
          <details className="canvas-arrange">
            <summary
              className="canvas-icon-button"
              aria-label={`Arrange ${block.title || block.kind}`}
            >
              <MoreHorizontal size={17} />
            </summary>
            <div className="canvas-arrange-panel">
              <label>
                Position
                <select
                  aria-label={`Position of ${block.title || block.kind}`}
                  value={block.placement}
                  disabled={disabled}
                  onChange={(event) =>
                    replace({
                      ...block,
                      placement: event.target.value as CanvasBlock["placement"],
                    })
                  }
                >
                  <option value="main">Main content</option>
                  <option value="aside">Beside your work</option>
                  <option value="full">Full width</option>
                </select>
              </label>
              <div>
                <button
                  type="button"
                  disabled={disabled || document.blocks[0].id === block.id}
                  onClick={() => moveBlock(block.id, -1)}
                >
                  <ArrowUp size={14} />
                  Move earlier
                </button>
                <button
                  type="button"
                  disabled={disabled || document.blocks.at(-1)!.id === block.id}
                  onClick={() => moveBlock(block.id, 1)}
                >
                  <ArrowDown size={14} />
                  Move later
                </button>
              </div>
            </div>
          </details>
          <button
            className="canvas-icon-button"
            aria-label={`Edit ${block.title || block.kind} heading`}
            disabled={disabled}
            onClick={() => setEditingTitle(block.id)}
          >
            <Pencil size={13} />
          </button>
          <button
            className="canvas-icon-button"
            aria-label={`${block.pinned ? "Unpin" : "Pin"} ${block.title || block.kind}`}
            aria-pressed={block.pinned}
            disabled={disabled}
            onClick={() => replace({ ...block, pinned: !block.pinned })}
          >
            <Pin size={15} strokeWidth={1.6} />
          </button>
          <button
            className="canvas-icon-button"
            aria-label={`Remove ${block.title || block.kind} block`}
            disabled={disabled || document.blocks.length <= 1}
            onClick={() =>
              onChange(
                withAvailableData({
                  ...document,
                  ...(document.suggestions
                    ? {
                        suggestions: document.suggestions.filter(
                          (suggestion) => suggestion.targetBlockId !== block.id,
                        ),
                      }
                    : {}),
                  blocks: document.blocks.filter(
                    (candidate) => candidate.id !== block.id,
                  ),
                }),
              )
            }
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <Block
        block={block}
        tables={document.blocks.filter(
          (candidate): candidate is BlockOf<"table"> =>
            candidate.kind === "table",
        )}
        assets={assets}
        sources={sources}
        disabled={disabled}
        requestPending={requestPending}
        onChange={replace}
        onOpenSource={onOpenSource}
        onOpenNote={onOpenNote}
        onAddMaterial={onAddMaterial}
        onAttachImage={onAttachImage}
        imageAttachment={imageAttachments?.[block.id]}
        onCancelImageAttachment={onCancelImageAttachment}
        onCheckImageAttachment={onCheckImageAttachment}
        onAddSource={onAddSource}
        onRequestOutline={onRequestOutline}
        onRequestContextSteps={onRequestContextSteps}
        onLearnAboutSelection={onLearnAboutSelection}
        onAskAboutSelection={onAskAboutSelection}
        selectionInsight={
          selectionInsight?.scope.blockId === block.id
            ? selectionInsight
            : undefined
        }
        choices={
          onRequestSuggestion
            ? {
                suggestions: document.suggestions ?? [],
                onChoose: chooseSuggestion,
                previewedSuggestionId: previewedSuggestion?.id,
                unavailable: unavailableSuggestions,
              }
            : undefined
        }
        contextSteps={contextSteps}
        onCancelContextSteps={onCancelContextSteps}
        onRevealTable={revealTable}
        onCreateDataView={
          document.blocks.length < 24 ? createDataView : undefined
        }
      />
      {suggestionPreview?.targetBlockId === block.id &&
        suggestionPreview.content}
      {block.kind !== "sources" && (
        <SourceLinks
          ids={block.sourceIds}
          sources={sources}
          onOpen={onOpenSource}
        />
      )}
    </section>
  );
  return (
    <section
      className="eve-canvas"
      ref={canvasElement}
      data-testid="canvas"
      aria-labelledby={headingId}
    >
      <header className="canvas-heading">
        <div className="canvas-heading-copy">
          <h1 id={headingId}>{document.title}</h1>
          {document.subtitle && (
            <p className="canvas-subtitle">{document.subtitle}</p>
          )}
        </div>
        <div
          className="canvas-status"
          data-state={saveState}
          role="status"
          aria-live="polite"
        >
          <span className="canvas-status-dot" />
          {saveMessage ||
            (saveState === "saving"
              ? "Saving…"
              : saveState === "error"
                ? "Changes need saving"
                : "Saved")}
        </div>
      </header>
      <CanvasLayout document={document}>{renderBlock}</CanvasLayout>
      {suggestionPreview &&
        (suggestionPreview.targetBlockId === null ||
          !document.blocks.some(
            (block) => block.id === suggestionPreview.targetBlockId,
          )) &&
        suggestionPreview.content}
      {!disabled && (
        <CanvasToolShelf
          document={document}
          disabled={disabled}
          onAdd={addTool}
        />
      )}
      {choosingImage && (
        <section className="canvas-image-chooser" aria-label="Choose an image">
          <div className="canvas-tool-shelf-heading">
            <span>Your images</span>
            <button
              className="canvas-icon-button"
              aria-label="Close image chooser"
              onClick={() => setChoosingImage(false)}
            >
              <X size={15} />
            </button>
          </div>
          <button
            type="button"
            className="canvas-add-button canvas-blank-image"
            disabled={disabled || document.blocks.length >= 24}
            onClick={() => {
              if (disabled || document.blocks.length >= 24) return;
              onChange({
                ...document,
                blocks: [...document.blocks, createCanvasTool("image", "main")],
              });
              setChoosingImage(false);
            }}
          >
            <ImageIcon size={16} aria-hidden="true" />
            Add blank image
          </button>
          <div className="canvas-image-options">
            {assets
              .filter((asset) => asset.mediaType.startsWith("image/"))
              .map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  disabled={disabled || document.blocks.length >= 24}
                  onClick={() => {
                    onChange({
                      ...document,
                      blocks: [
                        ...document.blocks,
                        {
                          id: newIdentity(),
                          kind: "image",
                          title: asset.title.slice(0, 160),
                          placement: "main",
                          pinned: false,
                          sourceIds: [],
                          assetId: asset.id,
                          caption: "",
                        },
                      ],
                    });
                    setChoosingImage(false);
                  }}
                >
                  <img src={asset.url} alt="" />
                  <span>{asset.title}</span>
                </button>
              ))}
          </div>
          {onAddMaterial && (
            <button className="canvas-add-button" onClick={onAddMaterial}>
              <Plus size={14} />
              Import an image
            </button>
          )}
          {!assets.some((asset) => asset.mediaType.startsWith("image/")) && (
            <p className="canvas-reference-meta">
              Start with an empty image area, or import a picture from your
              computer.
            </p>
          )}
        </section>
      )}
      <footer className="canvas-footer">
        <div
          className="canvas-layout-options"
          role="group"
          aria-label="Canvas layout"
        >
          {(
            [
              ["focus", "Page", FileText],
              ["split", "Beside", Columns2],
              ["gallery", "Gallery", LayoutGrid],
            ] as const
          ).map(([layout, label, Icon]) => (
            <button
              key={layout}
              type="button"
              disabled={disabled}
              aria-pressed={document.layout === layout}
              aria-label={`Use ${label.toLowerCase()} layout`}
              onClick={() => onChange({ ...document, layout })}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        {onUndo && (
          <button
            className="canvas-secondary-button"
            disabled={disabled || !canUndo}
            onClick={onUndo}
          >
            <RotateCcw size={14} />
            Undo
          </button>
        )}
      </footer>
    </section>
  );
}
