import { useEffect, useRef, useState } from "react";
import {
  Bluetooth,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  LockKeyhole,
  LogOut,
  Monitor,
  Network,
  Power,
  RotateCw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  OverlayAction,
  OverlayState,
  SystemAction,
} from "../../../shared/bridge";

type SystemState = Extract<OverlayState, { kind: "system" }>;
type ExitAction = Extract<SystemAction, { type: "exit" }>["action"];
const exitLabels: Record<ExitAction, string> = {
  logout: "Log out",
  restart: "Restart",
  shutdown: "Shut down",
};

export function SystemControls({
  state,
  send,
}: {
  state: SystemState;
  send: (action: OverlayAction) => void;
}) {
  const [showNetworks, setShowNetworks] = useState(false);
  const [showPower, setShowPower] = useState(false);
  const [exit, setExit] = useState<ExitAction | null>(null);
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [volume, setVolume] = useState<number | undefined>(
    state.system?.audio.volume,
  );
  const volumeDirty = useRef(false);
  const adjustingVolume = useRef(false);
  const busy = !!(state.busy || state.systemBusy || state.systemLoading);
  const system = state.system;
  const act = (action: SystemAction) =>
    send({
      type: "system-action",
      instanceId: state.instanceId,
      taskId: state.taskId,
      action,
    });
  useEffect(() => {
    if (!state.systemBusy && !adjustingVolume.current) {
      setVolume(state.system?.audio.volume);
      volumeDirty.current = false;
    }
  }, [state.system?.audio.volume, state.systemBusy]);
  const commitVolume = () => {
    adjustingVolume.current = false;
    if (volumeDirty.current && volume !== undefined && !busy) {
      volumeDirty.current = false;
      act({ type: "volume", percent: Math.round(volume) });
    }
  };
  if (state.host?.platform !== "linux") return null;
  return (
    <section className="system-controls" aria-label="Desktop controls">
      <div className="system-section-heading">
        <span>On this desktop</span>
        {state.systemLoading && <span role="status">Reading status…</span>}
      </div>
      {!system?.available ? (
        <p className="system-unavailable">
          {state.systemLoading
            ? "Connecting to system controls…"
            : "Eve cannot access this computer’s system controls."}
        </p>
      ) : (
        <>
          <div className="system-audio">
            <div className="system-control-label">
              <Volume2 size={16} />
              <span>Sound</span>
              {system.audio.available && volume !== undefined && (
                <output htmlFor="desktop-volume">{Math.round(volume)}%</output>
              )}
            </div>
            {!system.audio.available ? (
              <p className="system-unavailable">
                Audio controls are unavailable.
              </p>
            ) : (
              <div className="system-volume-row">
                {system.audio.muted !== undefined && (
                  <button
                    className="icon-button system-mute"
                    disabled={busy}
                    aria-label={
                      system.audio.muted ? "Unmute sound" : "Mute sound"
                    }
                    aria-pressed={system.audio.muted}
                    onClick={() =>
                      act({ type: "mute", muted: !system.audio.muted })
                    }
                  >
                    {system.audio.muted ? (
                      <VolumeX size={17} />
                    ) : (
                      <Volume2 size={17} />
                    )}
                  </button>
                )}
                {volume !== undefined ? (
                  <input
                    id="desktop-volume"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={volume}
                    disabled={busy}
                    aria-label="System volume"
                    aria-valuetext={`${Math.round(volume)} percent`}
                    onPointerDown={() => {
                      adjustingVolume.current = true;
                    }}
                    onChange={(event) => {
                      volumeDirty.current = true;
                      setVolume(Number(event.target.value));
                    }}
                    onPointerUp={commitVolume}
                    onPointerCancel={() => {
                      adjustingVolume.current = false;
                      volumeDirty.current = false;
                      setVolume(state.system?.audio.volume);
                    }}
                    onKeyUp={(event) => {
                      if (
                        [
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                          "Home",
                          "End",
                          "PageUp",
                          "PageDown",
                        ].includes(event.key)
                      )
                        commitVolume();
                    }}
                    onBlur={commitVolume}
                  />
                ) : (
                  <span className="system-unavailable">
                    Volume could not be read.
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="system-network">
            <div className="system-control-label">
              <Network size={16} />
              <span>Connections</span>
            </div>
            {!system.network.available ? (
              <p className="system-unavailable">
                Network status is unavailable.
              </p>
            ) : (
              <>
                {system.network.active.length ? (
                  <ul className="active-connections">
                    {system.network.active.map((connection) => (
                      <li key={connection.uuid}>
                        <span className="status-dot" />
                        <span>{connection.name}</span>
                        <small>{connection.device || connection.type}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="system-unavailable">
                    No connections are currently reported.
                  </p>
                )}
                <button
                  className="quiet-button saved-connections-toggle"
                  disabled={busy}
                  aria-expanded={showNetworks}
                  onClick={() => {
                    const next = !showNetworks;
                    setShowNetworks(next);
                    if (next)
                      send({
                        type: "system-networks",
                        instanceId: state.instanceId,
                        taskId: state.taskId,
                      });
                  }}
                >
                  Saved connections
                  {showNetworks ? (
                    <ChevronUp size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
                {showNetworks && (
                  <div className="saved-connections">
                    {state.networksLoading ? (
                      <p role="status">Reading saved connections…</p>
                    ) : state.savedNetworks?.length ? (
                      <>
                        <label htmlFor="saved-network">
                          Choose a connection
                        </label>
                        <select
                          id="saved-network"
                          value={selectedNetwork}
                          disabled={busy}
                          onChange={(event) =>
                            setSelectedNetwork(event.target.value)
                          }
                        >
                          <option value="">Select saved connection</option>
                          {state.savedNetworks.map((connection) => (
                            <option
                              key={connection.uuid}
                              value={connection.uuid}
                            >
                              {connection.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="quiet-button"
                          disabled={
                            busy ||
                            !state.savedNetworks.some(
                              (connection) =>
                                connection.uuid === selectedNetwork,
                            ) ||
                            system.network.active.some(
                              (connection) =>
                                connection.uuid === selectedNetwork,
                            )
                          }
                          onClick={() =>
                            act({ type: "connect", uuid: selectedNetwork })
                          }
                        >
                          {system.network.active.some(
                            (connection) => connection.uuid === selectedNetwork,
                          )
                            ? "Already connected"
                            : "Connect"}
                        </button>
                      </>
                    ) : (
                      <p>
                        {state.savedNetworks
                          ? "No saved connections found."
                          : "Saved connections could not be read. Close this list and try again."}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <div
            className="system-settings-links"
            aria-label="Open desktop settings"
          >
            {(
              [
                { panel: "sound", label: "Sound", Icon: Volume2 },
                { panel: "network", label: "Network", Icon: Network },
                { panel: "bluetooth", label: "Bluetooth", Icon: Bluetooth },
                { panel: "display", label: "Displays", Icon: Monitor },
              ] as const
            ).map(({ panel, label, Icon }) => (
              <button
                key={panel}
                disabled={busy}
                aria-label={`Open ${label.toLowerCase()} settings`}
                onClick={() => act({ type: "settings", panel })}
              >
                <Icon size={15} />
                <span>{label}</span>
                <ExternalLink size={11} />
              </button>
            ))}
          </div>
          <div className="system-session-actions">
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => act({ type: "lock" })}
            >
              <LockKeyhole size={14} />
              Lock desktop
            </button>
            {system.session && (
              <button
                className="quiet-button"
                disabled={busy}
                aria-expanded={showPower}
                onClick={() => {
                  setShowPower((value) => !value);
                  setExit(null);
                }}
              >
                <Power size={14} />
                Power
              </button>
            )}
          </div>
          {system.session && showPower && (
            <div className="system-power">
              {exit ? (
                <div
                  className="system-exit-confirmation"
                  role="group"
                  aria-label={`Confirm ${exitLabels[exit].toLowerCase()}`}
                >
                  <strong>{exit === "logout" ? "Log out?" : `${exitLabels[exit]} this computer?`}</strong>
                  <p>Eve will check for unsaved work before continuing.</p>
                  <div>
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => setExit(null)}
                    >
                      <X size={13} />
                      Cancel
                    </button>
                    <button
                      className="system-exit-button"
                      disabled={busy}
                      onClick={() => act({ type: "exit", action: exit })}
                    >
                      {exitLabels[exit]}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="system-power-options">
                  {(
                    [
                      { action: "logout", Icon: LogOut },
                      { action: "restart", Icon: RotateCw },
                      { action: "shutdown", Icon: Power },
                    ] as const
                  ).map(({ action, Icon }) => (
                    <button
                      key={action}
                      disabled={busy}
                      onClick={() => setExit(action)}
                    >
                      <Icon size={15} />
                      {exitLabels[action]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {state.systemBusy && (
        <p className="system-action-status" role="status">
          Working with the desktop…
        </p>
      )}
      {state.systemMessage && (
        <p
          className={`system-action-status${state.systemError ? " is-error" : ""}`}
          role={state.systemError ? "alert" : "status"}
        >
          {state.systemMessage}
        </p>
      )}
    </section>
  );
}
