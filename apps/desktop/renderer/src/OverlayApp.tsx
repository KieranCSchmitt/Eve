import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Pause, Play, X } from "lucide-react";
import type { OverlayAction, OverlayState } from "../../shared/bridge";
import { Logo } from "./Logo";
import { Recall } from "./components/Recall";
import { useTransientFocus } from "./hooks/useTransientFocus";
import {
  assistanceAvailability,
} from "./components/IntentResponse";
import { intentIsRunning } from "./hooks/useIntentAssistance";
import { SystemControls } from "./components/SystemControls";

const search = (query: string) => window.eveOverlay.search(query);
type Send = (action: OverlayAction) => void;

function Intent({
  state,
  send,
}: {
  state: Extract<OverlayState, { kind: "intent" }>;
  send: Send;
}) {
  const [text, setText] = useState(state.text);
  const running = state.requesting || intentIsRunning(state.response);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => send({ type: "close", instanceId: state.instanceId });
  useTransientFocus({
    active: true,
    containerRef: container,
    initialFocusRef: input,
    onEscape: close,
    restoreFocus: false,
  });
  return (
    <div
      className="overlay-click-away"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={container}
        className="intent-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Ask about ${state.title}`}
      >
        <div className="intent-context">
          <Logo small />
          <span>
            About <strong>{state.title}</strong>
          </span>
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close question"
          >
            <X size={17} />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() && !state.busy && !running)
              send({
                type: "intent-submit",
                instanceId: state.instanceId,
                taskId: state.taskId,
                text,
              });
          }}
        >
          <input
            ref={input}
            value={text}
            maxLength={4000}
            aria-label="Ask Eve"
            placeholder="What would you like to understand or change?"
            onChange={(event) => {
              setText(event.target.value);
              send({
                type: "intent-change",
                instanceId: state.instanceId,
                taskId: state.taskId,
                text: event.target.value,
              });
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault();
            }}
          />
          <button
            className="send-intent"
            aria-label="Submit question"
            type="submit"
            disabled={!text.trim() || state.busy || running}
          >
            <ArrowUp size={20} />
          </button>
        </form>
        {running && (
          <div className="intent-progress">
            <span role="status">
              {state.requesting && !state.response
                ? "Looking at your work…"
                : "Working on your request…"}
            </span>
            <button
              className="quiet-button"
              onClick={() =>
                send({
                  type: "intent-cancel",
                  instanceId: state.instanceId,
                  taskId: state.taskId,
                  ...(state.response
                    ? { requestId: state.response.requestId }
                    : {}),
                })
              }
            >
              Cancel request
              <X size={13} />
            </button>
          </div>
        )}
        {state.message && (
          <p className="overlay-message" role="status">
            {state.message}
          </p>
        )}
        <small>
          {assistanceAvailability(
            state.settings,
            state.policy ?? {
              processing: "local-only",
              assistancePaused: false,
            },
          )}
        </small>
      </div>
    </div>
  );
}

function System({
  state,
  send,
}: {
  state: Extract<OverlayState, { kind: "system" }>;
  send: Send;
}) {
  const container = useRef<HTMLElement>(null);
  const close = () => send({ type: "close", instanceId: state.instanceId });
  useTransientFocus({
    active: true,
    containerRef: container,
    onEscape: close,
    restoreFocus: false,
  });
  const { policy, taskId } = state;
  const status = (provider: "nemotron" | "openai") => {
    const value = state.host?.providers[provider];
    return value === "ready"
      ? "Set up"
      : value === "error"
        ? "Unavailable"
        : "Not set up";
  };
  return (
    <div
      className="overlay-click-away"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={container}
        className={`system-popover${state.host?.platform === "linux" ? " has-system-controls" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace settings"
      >
        <div className="popover-heading">
          Your workspace
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close settings"
          >
            <X size={16} />
          </button>
        </div>
        <p>
          <span className="status-dot" />
          Working on this computer
        </p>
        <SystemControls state={state} send={send} />
        <dl>
          <dt>AI on this computer</dt>
          <dd>{status("nemotron")}</dd>
          <dt>Online AI</dt>
          <dd>{status("openai")}</dd>
          <dt>Voice</dt>
          <dd>
            {state.host?.providers.voice === "ready"
              ? "Set up"
              : "Off"}
          </dd>
        </dl>
        {policy && taskId && <>
        <fieldset className="processing-settings" disabled={state.busy}>
          <legend>Where Eve can use AI</legend>
          <label>
            <input
              type="radio"
              name="processing"
              value="local-only"
              checked={policy.processing === "local-only"}
              onChange={() =>
                send({
                  type: "set-policy",
                  instanceId: state.instanceId,
                  taskId,
                  policy: { ...policy, processing: "local-only" },
                })
              }
            />
            On this computer only
          </label>
          <label>
            <input
              type="radio"
              name="processing"
              value="hybrid"
              checked={policy.processing === "hybrid"}
              onChange={() =>
                send({
                  type: "set-policy",
                  instanceId: state.instanceId,
                  taskId,
                  policy: { ...policy, processing: "hybrid" },
                })
              }
            />
            Allow online AI
          </label>
        </fieldset>
        <button
          className="quiet-button assistance-setting"
          aria-pressed={policy.assistancePaused}
          disabled={state.busy}
          onClick={() =>
            send({
              type: "set-policy",
              instanceId: state.instanceId,
              taskId,
              policy: {
                ...policy,
                assistancePaused: !policy.assistancePaused,
              },
            })
          }
        >
          {policy.assistancePaused ? (
            <Play size={14} />
          ) : (
            <Pause size={14} />
          )}
          {policy.assistancePaused
            ? "Resume background assistance"
            : "Pause background assistance"}
        </button>
        </>}
        {state.message && (
          <p className="overlay-message" role="alert">
            {state.message}
          </p>
        )}
        <small>
          You can write, use your tools, and return to saved work even when AI is
          unavailable. {policy && "Your AI choices apply only to this space."}
        </small>
        <div className="system-foot">
          Eve {state.host?.version ?? ""} ·{" "}
          {state.host?.mode === "session"
            ? "Your desktop"
            : "Desktop app"}
        </div>
      </section>
    </div>
  );
}

function Maintenance({
  state,
  send,
}: {
  state: Extract<OverlayState, { kind: "maintenance" }>;
  send: Send;
}) {
  const container = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const [requestedCancel, setRequestedCancel] = useState(false);
  const sendRef = useRef(send);
  sendRef.current = send;
  const announced = useRef(false);
  const descriptionId = useId();
  const cancelling = requestedCancel || state.phase === "cancelling";
  const cancel = () => {
    if (cancelled.current || state.phase === "cancelling") return;
    cancelled.current = true;
    setRequestedCancel(true);
    sendRef.current({
      type: "maintenance-cancel",
      instanceId: state.instanceId,
    });
  };
  useTransientFocus({
    active: true,
    containerRef: container,
    initialFocusRef: cancelButton,
    onEscape: cancel,
    restoreFocus: false,
  });
  useEffect(() => {
    // The host may pause native surfaces only after the mounted input shield
    // and its focus trap are ready. Component identity is the host instance ID.
    const frame = requestAnimationFrame(() => {
      if (
        !announced.current &&
        container.current?.isConnected &&
        container.current.contains(document.activeElement)
      ) {
        announced.current = true;
        sendRef.current({
          type: "maintenance-ready",
          instanceId: state.instanceId,
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [state.instanceId]);
  return (
    <div className="maintenance-shield">
      <section
        ref={container}
        className="maintenance-card"
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        aria-describedby={descriptionId}
      >
        <Logo small />
        <div className="eyebrow">TAKING CARE OF YOUR WORK</div>
        <h1>{state.title}</h1>
        <p id={descriptionId}>{state.detail}</p>
        <div className="maintenance-progress" aria-hidden="true">
          <span />
        </div>
        <div className="maintenance-foot">
          <span role="status" aria-live="polite">
            {cancelling ? "Cancelling…" : "Working…"}
          </span>
          <button
            ref={cancelButton}
            className="quiet-button"
            aria-disabled={cancelling}
            onClick={cancel}
          >
            {cancelling ? "Cancel requested" : "Cancel"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function OverlayApp() {
  const [state, setState] = useState<OverlayState | null>(null);
  useEffect(() => {
    const off = window.eveOverlay.onState(setState);
    window.eveOverlay.ready();
    return off;
  }, []);
  if (!state) return null;
  const send: Send = (action) => window.eveOverlay.action(action);
  if (state.kind === "maintenance")
    return <Maintenance key={state.instanceId} state={state} send={send} />;
  if (state.kind === "recall")
    return (
      <Recall
        key={state.instanceId}
        tasks={state.tasks}
        current={state.current}
        busy={state.busy}
        message={state.message}
        search={search}
        onClose={() => send({ type: "close", instanceId: state.instanceId })}
        onSelect={(taskId) =>
          send({ type: "select-task", instanceId: state.instanceId, taskId })
        }
        onCreate={(title) =>
          send({ type: "create-task", instanceId: state.instanceId, title })
        }
      />
    );
  return state.kind === "intent" ? (
    <Intent key={state.instanceId} state={state} send={send} />
  ) : (
    <System key={state.instanceId} state={state} send={send} />
  );
}
