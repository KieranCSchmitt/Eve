import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, Copy, RefreshCw } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { TaskRecord } from "@eve/contracts";

export interface NoteConflictRecord {
  saved: TaskRecord["note"];
  message?: string;
  copyPending?: boolean;
}

function Version({
  title,
  body,
  detail,
}: {
  title: string;
  body: string;
  detail: string;
}) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(
        body.startsWith("<") ? body : marked.parse(body, { async: false }),
        {
          ALLOWED_TAGS: [
            "p",
            "br",
            "strong",
            "b",
            "em",
            "i",
            "s",
            "h1",
            "h2",
            "h3",
            "ul",
            "ol",
            "li",
            "blockquote",
            "pre",
            "code",
          ],
          ALLOWED_ATTR: [],
        },
      ),
    [body],
  );
  return (
    <section className="note-conflict-version" aria-label={title}>
      <h4>
        {title}
        <span>{detail}</span>
      </h4>
      <div
        className="note-conflict-body"
        tabIndex={0}
        aria-label={`${title} text`}
        dangerouslySetInnerHTML={{ __html: html || "<p>Empty note</p>" }}
      />
    </section>
  );
}

/** A local review, never a modal: the draft stays editable beneath it. */
export function NoteConflict({
  conflict,
  task,
  draft,
  busy,
  onReview,
  onResolve,
}: {
  conflict: NoteConflictRecord;
  task: TaskRecord;
  draft: string;
  busy: boolean;
  onReview: () => void;
  onResolve: (
    choice: "saved" | "copy" | "replace",
    displayedDraft: string,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stale =
    task.note.id !== conflict.saved.id ||
    task.note.revision !== conflict.saved.revision;
  return (
    <aside className="note-conflict" aria-label="Review note conflict">
      <div className="note-conflict-heading">
        <div>
          <span className="eyebrow">TWO VERSIONS, BOTH KEPT</span>
          <h3>This note changed elsewhere.</h3>
          <p>Your draft is still here. Choose how to keep the thought.</p>
        </div>
        <button
          className="quiet-button"
          aria-expanded={expanded}
          onClick={() => {
            if (!expanded) onReview();
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Hide review" : "Review versions"}
          <ChevronDown size={16} />
        </button>
      </div>
      {expanded && (
        <>
          <div className="note-conflict-versions">
            <Version
              title="Saved version"
              body={conflict.saved.body}
              detail={`Version ${conflict.saved.revision}`}
            />
            <Version
              title="Your draft"
              body={draft}
              detail="Only in this window"
            />
          </div>
          {stale && (
            <div className="note-conflict-update" role="status">
              <span>
                The saved version changed again. Review it before replacing or
                discarding.
              </span>
              <button
                className="quiet-button"
                disabled={busy}
                onClick={onReview}
              >
                <RefreshCw size={14} />
                Review latest saved version
              </button>
            </div>
          )}
          {conflict.message && (
            <p className="note-conflict-message" role="status">
              {conflict.message}
            </p>
          )}
          <div className="note-conflict-actions">
            <button
              className="quiet-button"
              disabled={busy || stale}
              onClick={() => onResolve("saved", draft)}
            >
              Discard draft · keep saved
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => onResolve("copy", draft)}
            >
              <Copy size={15} />
              {conflict.copyPending
                ? "Retry saving copy"
                : "Save draft as new space"}
            </button>
            <button
              className="primary-button"
              disabled={busy || stale}
              onClick={() => onResolve("replace", draft)}
            >
              Replace saved with draft
              <ArrowRight size={15} />
            </button>
          </div>
          <p className="note-conflict-footnote">
            This replaces the saved version shown above. Keep Eve open until
            your draft finishes saving.
          </p>
        </>
      )}
    </aside>
  );
}
