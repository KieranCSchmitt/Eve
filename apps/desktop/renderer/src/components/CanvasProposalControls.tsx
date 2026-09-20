import { Check, LoaderCircle, X } from "lucide-react";
import type { IntentProposal } from "../../../shared/bridge";

export interface CanvasProposedChange {
  proposal: IntentProposal;
  onKeep(): void;
  onDismiss(): void;
}

export function CanvasProposalControls({
  change,
  canKeep,
  disabled,
  multiple = false,
}: {
  change: CanvasProposedChange;
  canKeep: boolean;
  disabled: boolean;
  multiple?: boolean;
}) {
  const applying = change.proposal.status === "applying";
  const keepLabel = applying
    ? "Keeping…"
    : multiple
      ? "Keep all changes"
      : "Keep";
  const dismissLabel = multiple ? "Dismiss all changes" : "Dismiss";
  return (
    <div
      className="canvas-proposal-actions"
      role="group"
      aria-label={
        multiple ? "Review all proposed changes" : "Review this addition"
      }
    >
      <button
        type="button"
        aria-label={keepLabel}
        title={keepLabel}
        aria-disabled={!canKeep}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          if (canKeep && change.proposal.expiresAt > Date.now())
            change.onKeep();
        }}
      >
        {applying ? (
          <LoaderCircle
            size={17}
            className="canvas-proposal-spinner"
            aria-hidden="true"
          />
        ) : (
          <Check size={17} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        aria-label={dismissLabel}
        title={dismissLabel}
        aria-disabled={disabled || applying}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          if (!disabled && !applying) change.onDismiss();
        }}
      >
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
