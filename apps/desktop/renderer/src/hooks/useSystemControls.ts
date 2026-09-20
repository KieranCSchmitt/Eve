import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NetworkConnection,
  SystemAction,
  SystemStatus,
} from "../../../shared/bridge";

/** Host-reported state; no settings or connection success is inferred optimistically. */
export function useSystemControls(active: boolean, platform?: string) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [networks, setNetworks] = useState<NetworkConnection[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const actionPending = useRef(false);
  const readRevision = useRef(0);
  const statusReadFailed = useRef(false);
  const profilesPending = useRef(false);
  const enabled = useRef(false);
  enabled.current = active && platform === "linux";
  const refresh = useCallback(async (generation: number) => {
    const revision = ++readRevision.current;
    try {
      const value = await window.eve.systemStatus();
      if (
        epoch.current === generation &&
        enabled.current &&
        revision === readRevision.current
      ) {
        setStatus(value);
        if (statusReadFailed.current) {
          statusReadFailed.current = false;
          setMessage("");
          setError(false);
        }
      }
    } catch (error) {
      if (
        epoch.current === generation &&
        enabled.current &&
        revision === readRevision.current
      ) {
        statusReadFailed.current = true;
        setStatus(null);
        throw error;
      }
    }
  }, []);
  useEffect(() => {
    const generation = ++epoch.current;
    if (!enabled.current) return;
    setLoading(true);
    setMessage("");
    setError(false);
    statusReadFailed.current = false;
    let polling = false;
    const update = async () => {
      if (polling || actionPending.current) return;
      polling = true;
      try {
        await refresh(generation);
      } catch (error) {
        if (epoch.current === generation && enabled.current) {
          setStatus(null);
          setMessage(
            error instanceof Error
              ? error.message
              : "System status could not be read.",
          );
          setError(true);
        }
      } finally {
        polling = false;
        if (epoch.current === generation && enabled.current) setLoading(false);
      }
    };
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      ++epoch.current;
      clearInterval(timer);
    };
  }, [active, platform, refresh]);
  const loadNetworks = useCallback(async () => {
    if (!enabled.current || profilesPending.current || actionPending.current)
      return;
    const generation = epoch.current;
    profilesPending.current = true;
    statusReadFailed.current = false;
    setNetworksLoading(true);
    setMessage("");
    setError(false);
    try {
      const profiles = await window.eve.savedNetworks();
      if (epoch.current === generation && enabled.current)
        setNetworks(profiles);
    } catch (error) {
      if (epoch.current === generation && enabled.current) {
        setNetworks(undefined);
        setMessage(
          error instanceof Error
            ? error.message
            : "Saved connections could not be read.",
        );
        setError(true);
      }
    } finally {
      profilesPending.current = false;
      setNetworksLoading(false);
    }
  }, []);
  const perform = useCallback(
    async (action: SystemAction) => {
      if (!enabled.current || actionPending.current || !status?.available)
        return;
      actionPending.current = true;
      statusReadFailed.current = false;
      ++readRevision.current;
      const generation = epoch.current;
      setBusy(true);
      setMessage("");
      setError(false);
      try {
        const result = await window.eve.systemAction(action);
        if (epoch.current !== generation || !enabled.current) return;
        if (!result.performed) {
          setMessage(result.reason || "This change could not be made.");
          setError(true);
        } else if (action.type === "connect")
          setMessage("Connection request completed.");
        else if (action.type === "settings")
          setMessage("Opened this computer’s settings.");
        else if (action.type === "exit")
          setMessage(action.action === "logout" ? "Log out requested." : action.action === "restart" ? "Restart requested." : "Shut down requested.");
        await refresh(generation);
      } catch (error) {
        if (epoch.current === generation && enabled.current) {
          setMessage(
            error instanceof Error
              ? error.message
              : "This change could not be completed.",
          );
          setError(true);
        }
      } finally {
        actionPending.current = false;
        setBusy(false);
      }
    },
    [status?.available, refresh],
  );
  const clearPresentation = useCallback(() => {
    ++epoch.current;
    enabled.current = false;
    setNetworks(undefined);
    setStatus(null);
    setMessage("");
    setError(false);
  }, []);
  return {
    status,
    networks,
    loading,
    networksLoading,
    busy,
    message,
    error,
    loadNetworks,
    perform,
    clearPresentation,
  };
}
