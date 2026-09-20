import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Sparkles, Undo2, X } from "lucide-react";
import type { CanvasSuggestion } from "@eve/contracts";
import "./CanvasSuggestions.css";

export type { CanvasSuggestion } from "@eve/contracts";

export interface CanvasSuggestionsProps {
  suggestions: readonly CanvasSuggestion[];
  onChoose(suggestion: CanvasSuggestion): void;
  disabled?: boolean;
  compact?: boolean;
  unavailable?: Record<string, string>;
  previewedSuggestionId?: string;
}

const identity = (suggestion: CanvasSuggestion) =>
  JSON.stringify([
    suggestion.id,
    suggestion.label,
    suggestion.description,
    suggestion.request,
    suggestion.targetBlockId,
    suggestion.prepared ?? null,
    suggestion.textSelection ?? null,
  ]);

function SuggestionCard({
  suggestion,
  disabled,
  onChoose,
  onDismiss,
  unavailable,
  previewAvailable,
}: {
  suggestion: CanvasSuggestion;
  disabled: boolean;
  onChoose(): void;
  onDismiss(): void;
  unavailable?: string;
  previewAvailable: boolean;
}) {
  const descriptionId = useId();
  return (
    <li className="canvas-suggestion">
      <button
        type="button"
        className="canvas-suggestion-action"
        data-suggestion-action
        aria-label={suggestion.label}
        aria-describedby={descriptionId}
        title={previewAvailable ? `View change: ${suggestion.label}` : suggestion.request}
        aria-disabled={disabled || !!unavailable}
        onClick={() => {
          if (!disabled && !unavailable) onChoose();
        }}
      >
        <span className="canvas-suggestion-symbol" aria-hidden="true">
          <Sparkles size={17} strokeWidth={1.6} />
        </span>
        <span className="canvas-suggestion-copy">
          <span className="canvas-suggestion-title">{suggestion.label}</span>
          <span id={descriptionId} className="canvas-suggestion-description">
            {suggestion.description}
            {previewAvailable && <span className="canvas-suggestion-review-available">Review ready · Choose to view the change</span>}
            {unavailable && (
              <span className="canvas-suggestion-unavailable">
                {unavailable}
              </span>
            )}
          </span>
        </span>
        <span className="canvas-suggestion-forward" aria-hidden="true">
          {suggestion.prepared && (
            <span className="canvas-suggestion-preview-label">{previewAvailable ? "View change" : "Preview"}</span>
          )}
          <ArrowUpRight size={17} />
        </span>
      </button>
      <button
        type="button"
        className="canvas-suggestion-dismiss"
        aria-label={`Dismiss suggestion: ${suggestion.label}`}
        title="Dismiss suggestion"
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) onDismiss();
        }}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </li>
  );
}

/** Mount one region per canvas or block, using a stable task-specific React key. */
export function CanvasSuggestions({
  suggestions,
  onChoose,
  disabled = false,
  compact = false,
  unavailable = {},
  previewedSuggestionId,
}: CanvasSuggestionsProps) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const region = useRef<HTMLElement>(null);
  const focusAfterDismiss = useRef<number | null>(null);
  const visible = suggestions.filter(
    (suggestion) => !dismissed.has(identity(suggestion)),
  );
  const hiddenCount = suggestions.length - visible.length;

  // Focus moves only after the user's own dismissal, never when model content arrives.
  useLayoutEffect(() => {
    if (focusAfterDismiss.current === null) return;
    const actions = region.current?.querySelectorAll<HTMLButtonElement>(
      "[data-suggestion-action]",
    );
    const target = actions?.length
      ? actions[Math.min(focusAfterDismiss.current, actions.length - 1)]
      : region.current?.querySelector<HTMLButtonElement>(
          "[data-suggestion-restore]",
        );
    focusAfterDismiss.current = null;
    target?.focus({ preventScroll: true });
  }, [dismissed]);

  if (!suggestions.length) return null;

  return (
    <section
      ref={region}
      className={`canvas-suggestions${compact ? " is-compact" : ""}${!visible.length ? " is-dismissed" : ""}`}
      aria-label="Suggested next steps"
      data-disabled={disabled}
    >
      {visible.length > 0 && (
        <>
          {!compact && (
            <div className="canvas-suggestions-heading">
              <span>
                <Sparkles size={13} aria-hidden="true" /> A next step, if you
                like
              </span>
              <span className="canvas-suggestions-hint">
                Choose a direction
              </span>
            </div>
          )}
          <ul className="canvas-suggestions-list">
            {visible.map((suggestion, index) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                disabled={disabled}
                unavailable={unavailable[suggestion.id]}
                previewAvailable={previewedSuggestionId === suggestion.id}
                onChoose={() => onChoose(suggestion)}
                onDismiss={() => {
                  focusAfterDismiss.current = index;
                  setDismissed(
                    (previous) => new Set([...previous, identity(suggestion)]),
                  );
                }}
              />
            ))}
          </ul>
        </>
      )}
      {(hiddenCount > 0 || disabled) && (
        <div className="canvas-suggestions-footnote">
          {disabled && <span>Available when this space is ready.</span>}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="canvas-suggestions-restore"
              data-suggestion-restore
              aria-disabled={disabled}
              onClick={() => {
                if (disabled) return;
                focusAfterDismiss.current = 0;
                setDismissed(new Set());
              }}
            >
              <Undo2 size={12} aria-hidden="true" /> Show{" "}
              {hiddenCount === 1 ? "hidden suggestion" : "hidden suggestions"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
