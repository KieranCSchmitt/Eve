import { useRef } from "react";
import { BookOpen, LoaderCircle, Sparkles, X } from "lucide-react";
import type { CanvasNextStepsState } from "./CanvasNextSteps";
import type { CanvasSuggestionRefreshScope } from "./useCanvasTextSelection";
import "./CanvasContextAction.css";

export type CanvasContextSteps = {
  scope: CanvasSuggestionRefreshScope;
  state: CanvasNextStepsState;
  message?: string;
};
export function CanvasContextAction({
  label,
  disabled,
  onRequest,
  passage = false,
  text,
  busy = false,
  purpose,
  hint,
}: {
  label: string;
  disabled: boolean;
  onRequest(): void;
  passage?: boolean;
  text?: string;
  busy?: boolean;
  purpose?: "learn";
  hint?: string;
}) {
  const activating = useRef(false);
  return (
    <button
      type="button"
      className={
        passage
          ? "canvas-context-passage"
          : "canvas-icon-button canvas-context-item"
      }
      aria-label={label}
      title={hint || label}
      aria-description={hint}
      aria-disabled={disabled}
      onPointerDown={(event) => {
        if (event.button === 0) event.preventDefault();
      }}
      onClick={() => {
        if (disabled || activating.current) return;
        activating.current = true;
        try {
          onRequest();
        } finally {
          queueMicrotask(() => {
            activating.current = false;
          });
        }
      }}
    >
      {busy ? (
        <LoaderCircle
          size={14}
          aria-hidden="true"
          className="canvas-context-spinner"
        />
      ) : purpose === "learn" ? (
        <BookOpen size={14} aria-hidden="true" />
      ) : (
        <Sparkles size={14} aria-hidden="true" />
      )}
      {passage && <span>{text || label}</span>}
    </button>
  );
}

export function CanvasContextStatus({
  context,
  title,
  disabled,
  requestPending,
  selectionValid,
  onRequest,
  onCancel,
}: {
  context: CanvasContextSteps;
  title: string;
  disabled: boolean;
  requestPending: boolean;
  selectionValid: boolean;
  onRequest(scope: CanvasSuggestionRefreshScope): void;
  onCancel?(): void;
}) {
  const loading = context.state === "loading";
  const retry = context.state === "error" || context.state === "empty";
  const activated = useRef(false);
  const message =
    context.message ||
    {
      idle: "",
      loading: "Looking at this writing…",
      ready: "Review a choice before keeping it.",
      empty: "No useful change was found for this passage.",
      error: "Writing help is unavailable. Your words are unchanged.",
    }[context.state];
  if (context.state === "idle") return null;
  return (
    <section
      className="canvas-context-status"
      data-state={context.state}
      aria-label={`Writing help for ${title}`}
    >
      <p role="status" aria-live="polite">
        {loading && <LoaderCircle size={13} aria-hidden="true" />}
        <span>
          {message}
          {retry &&
            !selectionValid &&
            " The passage changed. Select it again to ask for fresh choices."}
        </span>
      </p>
      {loading && onCancel && (
        <button
          type="button"
          aria-label={`Cancel writing help for ${title}`}
          aria-disabled={disabled}
          onPointerDown={(event) => {
            if (event.button === 0) event.preventDefault();
          }}
          onClick={(event) => {
            if (disabled) return;
            const trigger = event.currentTarget,
              focused = document.activeElement === trigger;
            const opener = trigger
              .closest(".canvas-block")
              ?.querySelector<HTMLButtonElement>(".canvas-context-passage");
            onCancel();
            if (focused)
              queueMicrotask(() => {
                if (
                  !trigger.isConnected &&
                  document.activeElement === document.body
                )
                  opener?.focus({ preventScroll: true });
              });
          }}
        >
          <X size={12} aria-hidden="true" />
          Cancel
        </button>
      )}
      {retry && (
        <button
          type="button"
          aria-label={`Try writing help again for ${title}`}
          aria-disabled={disabled || requestPending || !selectionValid}
          onPointerDown={(event) => {
            if (event.button === 0) event.preventDefault();
          }}
          onClick={() => {
            if (
              disabled ||
              requestPending ||
              !selectionValid ||
              activated.current
            )
              return;
            activated.current = true;
            try {
              onRequest(context.scope);
            } finally {
              queueMicrotask(() => {
                activated.current = false;
              });
            }
          }}
        >
          Try again
        </button>
      )}
    </section>
  );
}
