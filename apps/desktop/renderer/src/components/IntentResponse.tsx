import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  X,
} from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { TaskPolicy } from "@eve/contracts";
import type {
  IntelligenceSettings,
  IntentProposal,
  IntentResponse as Response,
} from "../../../shared/bridge";
import { canPreviewWorkspaceFiles, WorkspaceChanges } from "./WorkspaceChanges";
import { Canvas } from "./Canvas";

export function assistanceAvailability(
  settings: IntelligenceSettings | null | undefined,
  policy: TaskPolicy,
): string {
  const scope =
    policy.processing === "local-only" ? "On this computer" : "Online AI allowed";
  if (policy.assistancePaused) return `${scope} · Automatic assistance paused`;
  if (!settings) return `${scope} · Checking Eve…`;
  if (settings.state !== "ready")
    return `${scope} · AI ${settings.state === "failed" ? "unavailable" : settings.state === "starting" ? "starting" : "not ready"}`;
  const eligible = settings.providers.filter(
    (provider) =>
      provider.enabled &&
      !provider.quarantined &&
      provider.roles.includes("explain") &&
      (provider.authentication === "none" || provider.credentialPresent) &&
      (provider.kind === "local" ||
        (policy.processing !== "local-only" &&
          settings.cloudRequestsRemaining > 0)),
  );
  if (!eligible.length)
    return `${scope} · AI unavailable${settings.localRecoveryRequired ? " while reconnecting" : " · AI is not set up yet"}`;
  return `${scope} · ${eligible
    .map((provider) =>
      provider.kind === "local"
        ? "AI set up on this computer"
        : "Online AI set up",
    )
    .filter((value, index, array) => array.indexOf(value) === index)
    .join(" · ")}`;
}

function ReadableText({
  text,
  html = false,
}: {
  text: string;
  html?: boolean;
}) {
  const content = useMemo(
    () =>
      DOMPurify.sanitize(html ? text : marked.parse(text, { async: false }), {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "em",
          "b",
          "i",
          "s",
          "code",
          "pre",
          "ul",
          "ol",
          "li",
          "blockquote",
          "h1",
          "h2",
          "h3",
          "hr",
        ],
        ALLOWED_ATTR: [],
      }),
    [text, html],
  );
  return (
    <div
      className="intent-readable"
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}

function Proposal({
  proposal,
  actionable,
  busy,
  onApply,
  onDiscard,
  inline = false,
}: {
  proposal: IntentProposal;
  actionable: boolean;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  inline?: boolean;
}) {
  const [preview, setPreview] = useState(inline);
  const actions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // File review begins at its first passage, never by jumping past code to Apply.
    if (!inline && preview && proposal.kind !== "workspace")
      actions.current?.scrollIntoView({ block: "nearest" });
  }, [preview, proposal.kind, inline]);
  const ready =
    actionable &&
    proposal.status === "ready" &&
    proposal.kind !== "unsupported";
  const workspaceFiles =
    proposal.kind === "workspace" && canPreviewWorkspaceFiles(proposal.files)
      ? proposal.files
      : undefined;
  const hasPreview =
    proposal.kind === "workspace"
      ? !!workspaceFiles
      : proposal.kind === "canvas" ? !!proposal.canvas
      : proposal.before !== undefined || proposal.after !== undefined;
  const status =
    proposal.status === "ready"
      ? "Proposed change"
      : proposal.status === "applied"
        ? "Applied to your work"
        : proposal.status === "applying"
          ? "Applying…"
          : proposal.status === "uncertain"
            ? "Change needs review"
            : proposal.status === "stale"
              ? "Your work changed · Ask again"
              : proposal.status === "expired"
                ? "Preview expired · Ask again"
                : proposal.status === "unsupported"
                  ? "This change is not supported"
                  : proposal.status === "discarded"
                    ? "Discarded"
                    : "Change could not be applied";
  return (
    <article className="intent-proposal" aria-label={proposal.label}>
      <div className="proposal-heading">
        <FileText size={15} />
        <span>{status}</span>
        {proposal.status === "applied" && <Check size={15} />}
      </div>
      <h3>{proposal.label}</h3>
      <p>{proposal.summary}</p>
      {hasPreview && !inline && (
        <button
          className="quiet-button proposal-preview-button"
          aria-expanded={preview}
          onClick={() => setPreview((value) => !value)}
        >
          {preview ? "Hide preview" : "Preview change"}
          {preview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
      {proposal.kind === "workspace" && !workspaceFiles && (
        <p className="proposal-message" role="status">
          This change cannot be previewed completely.
          {proposal.status === "ready" && " Ask again for a smaller change."}
        </p>
      )}
      {preview && workspaceFiles && <WorkspaceChanges files={workspaceFiles} />}
      {preview && proposal.kind === "canvas" && proposal.canvas && (
        <div className="proposal-canvas-preview">
          <Canvas document={proposal.canvas} assets={[]} onChange={() => {}} disabled />
          {proposal.canvas.blocks.some(block => (block.kind === "image" && block.assetId !== null) || block.sourceIds.length > 0) && <p className="proposal-message">Saved images and references will open from your canvas.</p>}
        </div>
      )}
      {preview && hasPreview && proposal.kind !== "workspace" && proposal.kind !== "canvas" && (
        <div className="proposal-comparison">
          <section aria-label="Before change">
            <span className="eyebrow">BEFORE</span>
            {proposal.before ? (
              <ReadableText
                text={proposal.before}
                html={proposal.kind === "note"}
              />
            ) : (
              <p className="intent-empty-value">Empty</p>
            )}
          </section>
          <section aria-label="After change">
            <span className="eyebrow">AFTER</span>
            {proposal.after ? (
              <ReadableText
                text={proposal.after}
                html={proposal.kind === "note"}
              />
            ) : (
              <p className="intent-empty-value">Empty</p>
            )}
          </section>
        </div>
      )}
      {proposal.message && (
        <p className="proposal-message" role="status">
          {proposal.message}
        </p>
      )}
      {proposal.kind === "workspace" && proposal.status === "uncertain" && (
        <div className="proposal-actions">
          <button className="quiet-button" disabled={busy} onClick={onApply}>
            {busy ? "Checking status…" : "Check status"}
          </button>
        </div>
      )}
      {ready && (
        <div ref={actions} className="proposal-actions">
          <button className="quiet-button" aria-label={inline ? "Dismiss change" : undefined} title={inline ? "Dismiss change" : undefined} onClick={onDiscard}>
            <X size={13} />
            {!inline && "Discard"}
          </button>
          <button
            className="primary-button"
            aria-label={inline ? "Approve change" : undefined}
            title={inline ? "Approve change" : undefined}
            disabled={!preview || !hasPreview}
            onClick={onApply}
          >
            {!inline && "Apply change"}
            <Check size={13} />
          </button>
        </div>
      )}
    </article>
  );
}

export function IntentResponse({
  response,
  busy,
  onApply,
  onDiscard,
  onOpenSource,
  inline = false,
}: {
  response: Response;
  busy?: boolean;
  onApply: (proposalId: string) => void;
  onDiscard: (proposalId: string) => void;
  onOpenSource: (sourceId: string) => void;
  inline?: boolean;
}) {
  const running =
    response.status === "pending" || response.status === "running";
  return (
    <section
      className="intent-response"
      aria-label="Eve response"
      aria-busy={running}
    >
      <div className="intent-response-meta">
        <span>
          {response.provider
            ? response.provider.kind === "local" ? "On this computer" : "Online"
            : running
              ? "Preparing"
              : "Eve"}
        </span>
        <span>
          {running
            ? "Working…"
            : response.status === "complete"
              ? response.basis === "general"
                ? "General knowledge"
                : response.basis === "selection"
                  ? "Based on your selection"
                  : response.citations.length
                    ? "With sources"
                    : "Response"
              : response.status === "unavailable"
                ? "Unavailable"
                : response.status === "stale"
                  ? "Your work changed"
                  : response.status === "cancelled"
                    ? "Cancelled"
                    : "Could not complete"}
        </span>
      </div>
      {!inline && response.provider && <details className="intent-response-details"><summary>About this response</summary><p>AI model: {response.provider.model}</p></details>}
      <div role="status" aria-live="polite" aria-atomic="true">
        <ReadableText text={response.message} />
      </div>
      {!!response.citations.length && (
        <div className="intent-citations" aria-label="Sources used">
          <span className="eyebrow">SOURCES USED</span>
          {response.citations.map((citation, index) => (
            <article
              className="intent-citation"
              key={`${citation.sourceId}:${index}`}
            >
              <div>
                <strong>{citation.title}</strong>
                <span>
                  {citation.provenance === "authored-notes"
                    ? "Your notes"
                    : citation.provenance === "retrieved"
                      ? "Related source"
                      : "Saved reference"}
                  {citation.mediaTime !== undefined &&
                    ` · ${Math.floor(citation.mediaTime / 60)}:${String(Math.floor(citation.mediaTime % 60)).padStart(2, "0")}`}
                </span>
              </div>
              {citation.quote && <blockquote>{citation.quote}</blockquote>}
              {citation.canOpen && (
                <button
                  className="quiet-button"
                  onClick={() => onOpenSource(citation.sourceId)}
                >
                  Open source
                  <ArrowUpRight size={13} />
                </button>
              )}
            </article>
          ))}
        </div>
      )}
      {response.proposals.map((proposal) => (
        <Proposal
          key={`${response.requestId}:${proposal.id}`}
          proposal={proposal}
          actionable={response.status === "complete" && !busy}
          busy={!!busy}
          onApply={() => onApply(proposal.id)}
          onDiscard={() => onDiscard(proposal.id)}
          inline={inline}
        />
      ))}
    </section>
  );
}
