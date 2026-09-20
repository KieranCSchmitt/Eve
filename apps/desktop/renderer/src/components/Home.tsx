import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Code2,
  LayoutGrid,
  FileText,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { TaskRecord } from "@eve/contracts";
import "./Home.css";

const startingPoints = [
  {
    id: "writing",
    title: "A place to write",
    description: "Give your next thought room to grow.",
    action: "Start writing",
    request: "Start a blank document",
  },
  {
    id: "research",
    title: "Bring ideas together",
    description: "Keep your notes and sources side by side.",
    action: "Organize research",
    request:
      "Create a research workspace with a blank writing area and a place for my sources. Leave it ready for my own material.",
  },
  {
    id: "comparison",
    title: "See the possibilities",
    description: "Make a little space for a better decision.",
    action: "Compare options",
    request:
      "Create a blank comparison workspace with an editable table for options and a place for my decision notes. Leave the options for me to enter.",
  },
  {
    id: "planning",
    title: "Make room for your day",
    description: "Put your priorities into perspective.",
    action: "Start a day plan",
    request:
      "Create a day planning workspace with an empty daily timeline and a checklist for my priorities. Leave the times and tasks for me to fill in.",
  },
] as const;

/** Abstract previews describe a direction, never made-up user content. */
function IntentionPreview({
  kind,
}: {
  kind: (typeof startingPoints)[number]["id"];
}) {
  return (
    <span className={`home-intention-preview ${kind}`} aria-hidden="true">
      {kind === "writing" && (
        <span className="home-preview-page">
          <i />
          <i />
          <i />
          <i />
          <b />
        </span>
      )}
      {kind === "research" && (
        <>
          <span className="home-preview-source back">
            <i />
            <i />
          </span>
          <span className="home-preview-source front">
            <i />
            <i />
            <i />
          </span>
          <span className="home-preview-connection" />
        </>
      )}
      {kind === "comparison" && (
        <>
          <span className="home-preview-option">
            <i />
            <b />
            <b />
            <b />
          </span>
          <span className="home-preview-option selected">
            <i />
            <b />
            <b />
            <b />
          </span>
          <span className="home-preview-choice">
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path
                d="m2 5 2 2 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </span>
        </>
      )}
      {kind === "planning" && (
        <span className="home-preview-schedule">
          <i />
          <i />
          <i />
          <i />
          <b />
          <b />
          <b />
        </span>
      )}
    </span>
  );
}

export interface HomeProps {
  tasks: TaskRecord[];
  busy: boolean;
  onOpenTask(taskId: string): void;
  onCreate(title: string): void;
  onFind(): void;
  onCompose?(request: string): void;
}

/** Home owns only the new-space draft. Navigation and durable creation belong to App. */
export function Home({
  tasks,
  busy,
  onOpenTask,
  onCreate,
  onFind,
  onCompose,
}: HomeProps) {
  const [request, setRequest] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();
  const recent = [...tasks]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  useLayoutEffect(() => {
    if (creating) input.current?.focus({ preventScroll: true });
  }, [creating]);

  const cancel = () => {
    if (busy) return;
    setCreating(false);
    // The opener stays mounted, so returning focus never depends on a timer.
    opener.current?.focus({ preventScroll: true });
  };

  return (
    <section
      className="home"
      data-testid="home"
      aria-labelledby={`${id}-heading`}
    >
      <div className="home-introduction">
        <p className="home-eyebrow">
          <span aria-hidden="true" /> A place to think
        </p>
        <h1 id={`${id}-heading`}>
          A little room for
          <br />
          <em>what’s next.</em>
        </h1>
        <p className="home-invitation">
          {tasks.length
            ? "Pick up where you left off, or begin somewhere new."
            : "Your next idea can start here."}
        </p>
        {onCompose && (
          <form
            className="home-compose"
            aria-label="Create with Eve"
            onSubmit={(event) => {
              event.preventDefault();
              if (request.trim() && !busy) onCompose(request.trim());
            }}
          >
            <Search
              className="home-compose-symbol"
              size={20}
              strokeWidth={1.6}
              aria-hidden="true"
            />
            <input
              aria-label="What would you like to make?"
              placeholder="What would you like to work on?"
              value={request}
              readOnly={busy}
              maxLength={16000}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.nativeEvent.isComposing || event.keyCode === 229)
                )
                  event.preventDefault();
              }}
            />
            <button
              type="submit"
              aria-label="Create with Eve"
              disabled={busy || !request.trim()}
            >
              <ArrowRight size={20} />
            </button>
          </form>
        )}
        <div className="home-actions">
          <button className="home-find" onClick={onFind} disabled={busy}>
            <Search size={17} strokeWidth={1.7} aria-hidden="true" />
            Find your work
            <ArrowRight size={16} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            ref={opener}
            className="home-new"
            aria-expanded={creating}
            aria-controls={creating ? `${id}-create` : undefined}
            disabled={busy}
            onClick={() => {
              if (creating) input.current?.focus({ preventScroll: true });
              else setCreating(true);
            }}
          >
            <Plus size={17} strokeWidth={1.6} aria-hidden="true" /> New space
          </button>
        </div>
        {creating && (
          <form
            id={`${id}-create`}
            className="home-create"
            aria-label="New space"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && title.trim()) onCreate(title.trim());
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                if (event.key === "Enter") event.preventDefault();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }
            }}
          >
            <label htmlFor={`${id}-title`}>Give it a name</label>
            <div className="home-create-row">
              <input
                ref={input}
                id={`${id}-title`}
                aria-label="Space title"
                placeholder="What are you thinking about?"
                autoComplete="off"
                maxLength={120}
                value={title}
                readOnly={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
              <button
                type="submit"
                className="home-create-submit"
                disabled={busy || !title.trim()}
              >
                Create space
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="home-create-cancel"
                aria-label="Cancel new space"
                disabled={busy}
                onClick={cancel}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
          </form>
        )}
      </div>

      {onCompose && (
        <section
          className="home-directions"
          aria-labelledby={`${id}-directions`}
        >
          <div className="home-directions-heading">
            <h2 id={`${id}-directions`}>Or start with a direction</h2>
            <span>A click is a beginning.</span>
          </div>
          <ul className="home-intentions">
            {startingPoints.map((point) => (
              <li key={point.id}>
                <button
                  className="home-intention"
                  aria-label={point.action}
                  disabled={busy}
                  onClick={() => onCompose(point.request)}
                >
                  <IntentionPreview kind={point.id} />
                  <span className="home-intention-title">{point.title}</span>
                  <span className="home-intention-description">
                    {point.description}
                  </span>
                  <span className="home-intention-action">
                    {point.action}
                    <ArrowRight
                      size={14}
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="home-recents" aria-labelledby={`${id}-recent`}>
          <div className="home-recents-heading">
            <h2 id={`${id}-recent`}>Your recent spaces</h2>
            <button className="home-all" onClick={onFind} disabled={busy}>
              Find a space <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </div>
          <ul className="home-spaces">
            {recent.map((task) => (
              <li key={task.id}>
                <button
                  className="home-space"
                  aria-label={`Open ${task.title}`}
                  data-task-id={task.id}
                  disabled={busy}
                  onClick={() => onOpenTask(task.id)}
                >
                  <span
                    className={`home-space-symbol ${task.kind}`}
                    aria-hidden="true"
                  >
                    {task.canvas?.document ? (
                      <LayoutGrid size={20} strokeWidth={1.4} />
                    ) : task.kind === "project" ? (
                      <Code2 size={20} strokeWidth={1.4} />
                    ) : (
                      <FileText size={20} strokeWidth={1.4} />
                    )}
                  </span>
                  <span className="home-space-copy">
                    <span className="home-space-kind">
                      {task.canvas?.document
                        ? "Canvas"
                        : task.kind === "project"
                          ? "Project"
                          : "Notebook"}
                    </span>
                    <span className="home-space-title" title={task.title}>
                      {task.title}
                    </span>
                    {task.description && (
                      <span className="home-space-description">
                        {task.description}
                      </span>
                    )}
                  </span>
                  <ArrowUpRight
                    className="home-space-arrow"
                    size={18}
                    strokeWidth={1.4}
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
