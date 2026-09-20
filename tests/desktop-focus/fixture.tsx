import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTransientFocus } from "../../apps/desktop/renderer/src/hooks/useTransientFocus.js";
export { activateTransientFocus } from "../../apps/desktop/renderer/src/hooks/useTransientFocus.js";

export function mountReactFixture(element: HTMLElement): () => void {
  const root = createRoot(element);
  function Fixture() {
    const [open, setOpen] = useState(false);
    const [revision, setRevision] = useState(0);
    const containerRef = useRef<HTMLElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    useTransientFocus({
      active: open,
      containerRef,
      initialFocusRef: inputRef,
      onEscape: () => {
        element.dataset.closedWithRevision = String(revision);
        setOpen(false);
      },
    });
    return (
      <>
        <button id="opener" onClick={() => setOpen(true)}>
          Open
        </button>
        {open && (
          <section
            ref={containerRef}
            role="dialog"
            aria-label="Recall"
            aria-modal="true"
          >
            <input id="query" ref={inputRef} aria-label="Search" />
            <button
              id="rerender"
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh {revision}
            </button>
            <button id="close" onClick={() => setOpen(false)}>
              Close
            </button>
          </section>
        )}
      </>
    );
  }
  root.render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  return () => root.unmount();
}
