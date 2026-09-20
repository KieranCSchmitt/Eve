import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import "./CanvasPreparation.css";

/** Waiting reflects the real request lifecycle; the animation never implies a percentage. */
export function CanvasPreparation({ request, message, compact = false, onCancel }: {
  request?: string;
  message?: string;
  compact?: boolean;
  onCancel(): void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return <div className={`canvas-preparation ${compact ? "is-compact" : ""}`} data-testid="canvas-preparation">
    {!compact && <>
      <div className="canvas-preparation-heading">
        <span className="canvas-preparation-label"><Sparkles size={15} /> A little room for your idea</span>
        <h1>Bringing your space<br /><em>together.</em></h1>
        {request && <p className="canvas-preparation-request">{request}</p>}
      </div>
      <div className="canvas-preparation-preview" aria-hidden="true">
        <div className="canvas-preparation-page"><span /><i /><i /><i /><div className="canvas-preparation-caret" /></div>
        <div className="canvas-preparation-side"><div><span /><i /><i /></div><div><span /><i /></div></div>
      </div>
    </>}
    <div className="canvas-preparation-status">
      <span className="canvas-preparation-pulse" aria-hidden="true" />
      <span role="status">{message || "Preparing your space…"}</span>
      {elapsed >= 5 && <span className="canvas-preparation-elapsed" aria-label={`${elapsed} seconds elapsed`}>{elapsed}s</span>}
      <button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>
    </div>
    {!compact && <p className="canvas-preparation-footnote">You’ll be able to shape every detail.</p>}
  </div>;
}
