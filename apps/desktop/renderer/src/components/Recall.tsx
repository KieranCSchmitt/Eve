import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Code2, FileText, Plus, Search } from "lucide-react";
import type { RecallTaskSummary } from "../../../shared/bridge";
import { useTransientFocus } from "../hooks/useTransientFocus";

export function Recall({
  tasks,
  current,
  onClose,
  onSelect,
  onCreate,
  search,
  busy,
  message,
}: {
  tasks: RecallTaskSummary[];
  current: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
  search: (query: string) => Promise<string[]>;
  busy?: boolean;
  message?: string;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<{ query: string; ids: string[] } | null>(
    null,
  );
  const [searchError, setSearchError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const listId = useId();
  const resultId = (position: number) => `${listId}-${position}`;
  const text = query.trim();
  const searching = Boolean(text && result?.query !== text && !searchError);
  useTransientFocus({
    active: true,
    containerRef: dialog,
    initialFocusRef: input,
    onEscape: onClose,
    restoreFocus: false,
  });
  useEffect(() => {
    let cancelled = false;
    if (!text) return;
    const timer = setTimeout(() => {
      void search(text)
        .then((ids) => {
          if (!cancelled) setResult({ query: text, ids });
        })
        .catch(() => {
          if (!cancelled)
            setSearchError(
              "Search could not finish. Your work is still here; try again.",
            );
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, search]);
  const filtered = text
    ? result?.query === text
      ? result.ids
          .map((id) => tasks.find((task) => task.id === id))
          .filter((task): task is RecallTaskSummary => Boolean(task))
      : []
    : tasks;
  const count = filtered.length + (text ? 1 : 0);
  const selected = Math.min(index, Math.max(0, count - 1));
  useEffect(() => {
    document
      .getElementById(resultId(selected))
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, result, text]);
  const choose = (position: number) => {
    if (busy || searching) return;
    if (filtered[position]) onSelect(filtered[position].id);
    else if (text) onCreate(text);
  };
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="recall"
        role="dialog"
        aria-modal="true"
        aria-label="Find your work"
      >
        <div className="recall-input">
          <Search size={23} aria-hidden="true" />
          <input
            ref={input}
            value={query}
            maxLength={120}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={count ? resultId(selected) : undefined}
            aria-label="Search tasks"
            placeholder="Where would you like to pick up?"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
              setSearchError("");
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                event.defaultPrevented
              )
                return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex(
                  Math.min(
                    Math.max(
                      0,
                      selected + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                    Math.max(0, count - 1),
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(selected);
              }
            }}
          />
          <button
            onClick={onClose}
            className="keycap"
            aria-label="Close search"
          >
            esc
          </button>
        </div>
        <div className="recall-label">
          {text ? "IN YOUR WORKSPACE" : "PICK UP WHERE YOU LEFT OFF"}
        </div>
        <div
          id={listId}
          className="recall-results"
          role="listbox"
          aria-label="Your spaces"
          aria-busy={searching || Boolean(busy)}
        >
          {filtered.map((task, position) => (
            <div
              key={task.id}
              id={resultId(position)}
              role="option"
              aria-selected={selected === position}
              aria-disabled={busy || undefined}
              className={`recall-result ${selected === position ? "selected" : ""}`}
              onMouseEnter={() => setIndex(position)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(position)}
            >
              <span className={`task-icon ${task.kind}`} aria-hidden="true">
                {task.kind === "project" ? (
                  <Code2 size={21} />
                ) : (
                  <FileText size={21} />
                )}
              </span>
              <span className="task-copy">
                <strong>{task.title}</strong>
                <small>
                  {task.description || "Your thoughts, all in one place"}
                </small>
              </span>
              {current === task.id ? (
                <span className="current-label">Here now</span>
              ) : (
                <ArrowUpRight size={19} aria-hidden="true" />
              )}
            </div>
          ))}
          {text && (
            <div
              id={resultId(filtered.length)}
              role="option"
              aria-selected={selected === filtered.length}
              aria-disabled={busy || searching || undefined}
              className={`new-task ${selected === filtered.length ? "selected" : ""}`}
              onMouseEnter={() => setIndex(filtered.length)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(filtered.length)}
            >
              <Plus size={20} aria-hidden="true" />
              <span>
                Make a space for <strong>“{text}”</strong>
              </span>
              <span className="keycap" aria-hidden="true">
                ↵
              </span>
            </div>
          )}
        </div>
        {(message || searchError) && (
          <p className="overlay-message" role="alert">
            {message || searchError}
          </p>
        )}
        <span className="sr-only" role="status">
          {searching
            ? "Searching your work"
            : `${filtered.length} ${filtered.length === 1 ? "space" : "spaces"} found`}
        </span>
        <div className="recall-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to explore
          </span>
          <span>
            <kbd>↵</kbd> to continue
          </span>
          <button disabled={busy} onClick={() => onCreate("Untitled space")}>
            <Plus size={15} /> New space
          </button>
        </div>
      </section>
    </div>
  );
}
