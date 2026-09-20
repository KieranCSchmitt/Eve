import { useEffect, useLayoutEffect, useRef } from "react";
import { Check, ChevronDown, Pencil, X } from "lucide-react";
import type { RenameState } from "../hooks/useRenameTask";

export function TaskTitle({
  title,
  state,
  onRecall,
  onBegin,
  onChange,
  onDismiss,
  onReview,
  onSubmit,
}: {
  title: string;
  state?: RenameState;
  onRecall(): void;
  onBegin(): void;
  onChange(value: string): void;
  onDismiss(): void;
  onReview(): void;
  onSubmit(): Promise<boolean>;
}) {
  const form = useRef<HTMLFormElement>(null),
    input = useRef<HTMLInputElement>(null),
    opener = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const bookmark = useRef<
    | {
        element: HTMLElement;
        anchor: Node | null;
        anchorOffset: number;
        head: Node | null;
        headOffset: number;
      }
    | undefined
  >(undefined);
  const open = !!state && !state.hidden;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (open) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [open]);
  const remember = () => {
    const selection = document.getSelection();
    bookmark.current = {
      element: document.activeElement as HTMLElement,
      anchor: selection?.anchorNode ?? null,
      anchorOffset: selection?.anchorOffset ?? 0,
      head: selection?.focusNode ?? null,
      headOffset: selection?.focusOffset ?? 0,
    };
  };
  const restore = () => {
    requestAnimationFrame(() => {
      if (
        !mounted.current ||
        (document.activeElement !== document.body &&
          !form.current?.contains(document.activeElement) &&
          document.activeElement !== opener.current)
      )
        return;
      const saved = bookmark.current;
      const target =
        saved?.element.isConnected && saved.element.getClientRects().length
          ? saved.element
          : opener.current;
      target?.focus({ preventScroll: true });
      if (
        target === saved?.element &&
        saved.anchor?.isConnected &&
        saved.head?.isConnected
      ) {
        try {
          document
            .getSelection()
            ?.setBaseAndExtent(
              saved.anchor,
              saved.anchorOffset,
              saved.head,
              saved.headOffset,
            );
        } catch {
          /* The note changed while the title was pending; keep its current selection. */
        }
      }
    });
  };
  const dismiss = () => {
    onDismiss();
    restore();
  };
  if (!open)
    return (
      <div className="task-title-control">
        <button className="purpose-name" onClick={onRecall}>
          <span>{title}</span>
          <ChevronDown size={14} />
        </button>
        <button
          ref={opener}
          className="icon-button rename-title"
          aria-label={state?.submitted ? "Review title change" : "Rename space"}
          onPointerDown={(event) => {
            remember();
            event.preventDefault();
          }}
          onClick={(event) => {
            if (!event.detail || !bookmark.current) remember();
            onBegin();
          }}
        >
          <Pencil size={14} />
        </button>
      </div>
    );
  const saving = state.phase === "saving",
    uncertain = !!state.submitted;
  return (
    <form
      ref={form}
      className="task-title-form"
      aria-label="Rename space"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit().then((applied) => {
          if (applied) restore();
        });
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!saving) dismiss();
        }
      }}
    >
      <input
        ref={input}
        aria-label="Space title"
        maxLength={120}
        value={state.value}
        readOnly={saving || uncertain}
        aria-describedby={
          state.message || uncertain ? "rename-message" : undefined
        }
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          )
            event.preventDefault();
        }}
      />
      <button
        className="icon-button"
        type="submit"
        aria-label={
          saving
            ? "Saving title"
            : uncertain
              ? "Retry title change"
              : "Save title"
        }
        disabled={saving || !state.value.trim() || state.phase === "conflict"}
      >
        <Check size={17} />
      </button>
      <button
        className="icon-button"
        type="button"
        aria-label={
          uncertain ? "Leave title change for later" : "Cancel title change"
        }
        disabled={saving}
        onClick={dismiss}
      >
        <X size={17} />
      </button>
      {(state.message || uncertain) && (
        <div className="title-message" id="rename-message" role="status">
          <p>{state.message || "Confirming your title change…"}</p>
          {state.phase === "uncertain" && (
            <p>
              Retry checks the same change. Your title updates only when Eve
              confirms it.
            </p>
          )}
          {state.phase === "conflict" && (
            <>
              <p>
                Current title: <strong>{title}</strong>
              </p>
              <button type="button" className="quiet-button" onClick={onReview}>
                Review current title
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
