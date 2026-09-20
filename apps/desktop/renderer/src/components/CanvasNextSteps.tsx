import { useId, useLayoutEffect, useRef } from "react";
import { ArrowUpRight, LoaderCircle, Sparkles, X } from "lucide-react";
import "./CanvasNextSteps.css";

export type CanvasNextStepsState =
  "idle" | "loading" | "ready" | "empty" | "error";

interface CanvasNextStepsProps {
  state?: CanvasNextStepsState;
  message?: string;
  disabled?: boolean;
  requestPending?: boolean;
  onRequest(): void;
  onCancel?(): void;
}

const messages: Record<CanvasNextStepsState, string> = {
  idle: "Find a few useful directions for this space. Your work stays as it is.",
  loading: "Looking at this space for useful next steps…",
  ready: "Fresh choices are ready above. Keep only what helps.",
  empty:
    "No useful next steps were found for this space. Your work is unchanged.",
  error: "Next steps could not be prepared. Your work is unchanged.",
};

/** An explicit request affordance. The host owns generation and its metadata-only authority. */
export function CanvasNextSteps({
  state = "idle",
  message,
  disabled = false,
  requestPending = false,
  onRequest,
  onCancel,
}: CanvasNextStepsProps) {
  const headingId = useId();
  const statusId = useId();
  const activated = useRef(false);
  const cancelling = useRef(false);
  const requestButton = useRef<HTMLButtonElement>(null);
  const returnFromCancel = useRef(false);
  const loading = state === "loading";
  const unavailable = disabled || requestPending || loading;
  useLayoutEffect(() => {
    if (loading || !returnFromCancel.current) return;
    returnFromCancel.current = false;
    if (document.activeElement === document.body)
      requestButton.current?.focus({ preventScroll: true });
  }, [loading]);
  // Stop repeated activations in a single event turn before the parent's pending
  // state reaches this component. The request owner guards the full async lifetime.
  const once = (guard: typeof activated, action: () => void) => {
    if (guard.current) return;
    guard.current = true;
    try {
      action();
    } finally {
      queueMicrotask(() => {
        guard.current = false;
      });
    }
  };
  return (
    <section
      className="canvas-next-steps"
      aria-labelledby={headingId}
      data-state={state}
    >
      <div className="canvas-next-steps-copy">
        <h2 id={headingId}>
          <Sparkles size={15} aria-hidden="true" />
          Next steps
        </h2>
        <p id={statusId} role="status" aria-live="polite">
          {message || messages[state]}
        </p>
      </div>
      <div className="canvas-next-steps-actions">
        <button
          ref={requestButton}
          type="button"
          className="canvas-next-steps-request"
          aria-label={
            state === "error"
              ? "Try again: suggest next steps"
              : loading
                ? "Finding next steps"
                : "Suggest next steps"
          }
          aria-describedby={statusId}
          aria-disabled={unavailable}
          aria-busy={loading || undefined}
          onClick={() => {
            if (!unavailable) once(activated, onRequest);
          }}
        >
          {loading ? (
            <LoaderCircle
              className="canvas-next-steps-spinner"
              size={15}
              aria-hidden="true"
            />
          ) : (
            <Sparkles size={15} aria-hidden="true" />
          )}
          {loading
            ? "Finding next steps…"
            : state === "error"
              ? "Try again"
              : "Suggest next steps"}
          {!loading && <ArrowUpRight size={15} aria-hidden="true" />}
        </button>
        {loading && onCancel && (
          <button
            type="button"
            className="canvas-next-steps-cancel"
            aria-label="Cancel next steps request"
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled)
                once(cancelling, () => {
                  returnFromCancel.current = true;
                  onCancel();
                });
            }}
          >
            <X size={13} aria-hidden="true" />
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
