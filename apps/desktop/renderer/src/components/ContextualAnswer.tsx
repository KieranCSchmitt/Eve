import { useMemo } from "react";
import { ArrowUpRight, X } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { IntentResponse } from "../../../shared/bridge";
import "./ContextualAnswer.css";

/** A single, dismissible insight at the current work, never a chat transcript. */
export function ContextualAnswer({ response, message, pending, onDismiss, onOpenSource }: {
  response?: IntentResponse; message?: string; pending?: boolean;
  onDismiss(): void; onOpenSource(sourceId: string): void;
}) {
  const text = message || response?.message || "Reading this passage…";
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }), {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "code", "ul", "ol", "li", "blockquote"], ALLOWED_ATTR: [],
  }), [text]);
  return <aside className="contextual-answer" aria-label="About this passage" aria-busy={!!pending}>
    <div className="contextual-answer-heading"><span>{pending ? "Reading…" : response?.basis === "general" ? "General knowledge" : response?.citations.length ? "From your sources" : "Eve"}</span>
      <button className="icon-button" aria-label={pending ? "Cancel explanation" : "Dismiss explanation"} title={pending ? "Cancel explanation" : "Dismiss explanation"} onClick={onDismiss}><X size={15} /></button></div>
    <div className="contextual-answer-text" role="status" dangerouslySetInnerHTML={{ __html: html }} />
    {!!response?.citations.length && <div className="contextual-answer-sources" aria-label="Sources used">{response.citations.map((citation, index) => <div key={`${citation.sourceId}:${index}`}>
      {citation.canOpen ? <button className="quiet-button" onClick={() => onOpenSource(citation.sourceId)}>{citation.title}<ArrowUpRight size={12} /></button> : <span>{citation.title}</span>}
      <blockquote>{citation.quote}</blockquote>
    </div>)}</div>}
  </aside>;
}
