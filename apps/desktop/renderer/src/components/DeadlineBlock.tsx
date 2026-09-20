import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, Check, Clock3, X } from "lucide-react";
import type { CanvasBlock } from "@eve/contracts";

type Deadline = Extract<CanvasBlock, { kind: "deadline" }>;
const localDateTime = (timestamp: number | null): string => {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function remainingLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

/** Keeps an absolute deadline; clock ticks are presentation, never durable writes. */
export function DeadlineBlock({
  block,
  disabled,
  onChange,
}: {
  block: Deadline;
  disabled: boolean;
  onChange(block: CanvasBlock): void;
}) {
  const [now, setNow] = useState(Date.now);
  const [editing, setEditing] = useState(block.dueAt === null);
  const [draft, setDraft] = useState(() => localDateTime(block.dueAt));
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    setDraft(localDateTime(block.dueAt));
    setError("");
    if (block.dueAt === null) setEditing(true);
  }, [block.dueAt]);
  useEffect(() => {
    setNow(Date.now());
    if (block.dueAt === null || block.dueAt <= Date.now()) return;
    const dueAt = block.dueAt;
    const interval = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= dueAt) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [block.dueAt]);
  const due = block.dueAt === null ? null : new Date(block.dueAt);
  const timeLeft = block.dueAt === null ? null : block.dueAt - now;
  const past = timeLeft !== null && timeLeft <= 0;
  const dueLabel = due?.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const closeEditor = () => {
    setEditing(false);
    setDraft(localDateTime(block.dueAt));
    setError("");
    changeButton.current?.focus();
  };
  return (
    <div className="canvas-deadline" data-editing={editing}>
      <div className="canvas-deadline-face" data-overdue={past}>
        <CalendarDays size={25} strokeWidth={1.4} aria-hidden="true" />
        <div className="canvas-deadline-value">
          <span
            className="canvas-deadline-time"
            role="timer"
            aria-live="off"
            aria-label={
              timeLeft === null
                ? "No due date set"
                : past
                  ? "Due date reached"
                  : `${remainingLabel(timeLeft)} remaining`
            }
          >
            {timeLeft === null
              ? "Your deadline"
              : past
                ? "Due now"
                : remainingLabel(timeLeft)}
          </span>
          <span className="canvas-deadline-caption">
            {dueLabel ?? "Add a date to start counting down"}
          </span>
        </div>
        <button
          type="button"
          ref={changeButton}
          className="canvas-icon-button"
          disabled={disabled}
          aria-label={block.dueAt === null ? "Set due date" : "Change due date"}
          aria-expanded={editing}
          aria-controls={`${id}-editor`}
          onClick={() => {
            setDraft(localDateTime(block.dueAt));
            setError("");
            setEditing(true);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          <Clock3 size={17} />
        </button>
      </div>
      {editing && (
        <form
          id={`${id}-editor`}
          className="canvas-deadline-editor"
          aria-label="Set your deadline"
          noValidate
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeEditor();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            const timestamp = new Date(draft).getTime();
            if (
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft) ||
              !Number.isFinite(timestamp) ||
              timestamp < 0 ||
              timestamp > 253402300799999 ||
              localDateTime(timestamp) !== draft
            ) {
              setError("Choose a valid date and time.");
              input.current?.focus();
              return;
            }
            if (timestamp !== block.dueAt)
              onChange({ ...block, dueAt: timestamp });
            setNow(Date.now());
            setEditing(false);
            setError("");
            changeButton.current?.focus();
          }}
        >
          <div className="canvas-deadline-editor-heading">
            <label htmlFor={`${id}-date`}>When is it due?</label>
            <button
              type="button"
              className="canvas-icon-button"
              aria-label="Close date editor"
              onClick={closeEditor}
            >
              <X size={13} />
            </button>
          </div>
          <div className="canvas-deadline-editor-controls">
            <input
              ref={input}
              id={`${id}-date`}
              type="datetime-local"
              aria-label="Due date and time"
              value={draft}
              min="1970-01-01T00:00"
              max="9999-12-31T23:59"
              disabled={disabled}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${id}-error` : `${id}-zone`}
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
            />
            <button
              className="canvas-primary-button"
              disabled={disabled}
              type="submit"
            >
              <Check size={13} />
              Set date
            </button>
          </div>
          {error ? (
            <p
              id={`${id}-error`}
              className="canvas-deadline-error"
              role="alert"
            >
              {error}
            </p>
          ) : (
            <p id={`${id}-zone`} className="canvas-deadline-zone">
              Your local time ·{" "}
              {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>
          )}
          {block.dueAt !== null && (
            <button
              type="button"
              className="canvas-deadline-clear"
              disabled={disabled}
              onClick={() => {
                onChange({ ...block, dueAt: null });
                setDraft("");
                setError("");
                input.current?.focus();
              }}
            >
              Clear date
            </button>
          )}
        </form>
      )}
    </div>
  );
}
