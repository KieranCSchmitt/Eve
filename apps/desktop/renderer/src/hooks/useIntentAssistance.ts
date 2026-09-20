import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasSuggestionRefreshScope } from "@eve/contracts";
import type {
  IntelligenceSettings,
  IntentResponse,
} from "../../../shared/bridge";

interface Attempt {
  taskId: string;
  requestId?: string;
  cancelled: boolean;
  requesting: boolean;
}

export const intentIsRunning = (response?: IntentResponse | null) =>
  response?.status === "pending" || response?.status === "running";

/** Presentation state only. The host owns context binding, validation, and mutations. */
export function useIntentAssistance() {
  const [responses, setResponses] = useState<Record<string, IntentResponse>>(
    {},
  );
  const [requesting, setRequesting] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<IntelligenceSettings | null>(null);
  const attempts = useRef(new Map<string, Attempt>());
  const earlyEvents = useRef(new Map<string, IntentResponse>());
  const currentResponses = useRef(responses);
  const mounted = useRef(true);
  const mutations = useRef(new Set<string>());
  const cancelRemote = useCallback((attempt: Attempt) => {
    if (!attempt.requestId) return;
    void window.eve.cancelIntent(attempt.requestId).catch(() => {
      if (mounted.current && attempts.current.get(attempt.taskId) === attempt)
        setMessages((values) => ({
          ...values,
          [attempt.taskId]:
            "The result is hidden, but cancellation could not be confirmed.",
        }));
    });
  }, []);
  const accept = useCallback((response: IntentResponse) => {
    const attempt = attempts.current.get(response.taskId);
    if (
      !mounted.current ||
      !attempt ||
      attempt.requestId !== response.requestId
    )
      return;
    const previous = currentResponses.current[response.taskId];
    if (attempt.cancelled) {
      if (previous?.requestId !== response.requestId) return;
      const approved = previous.proposals.filter(
        (item) =>
          item.kind === "workspace" &&
          ["applying", "uncertain", "applied"].includes(item.status),
      );
      if (!approved.length) return;
      // Cancellation hides generation, not the settlement of an effect already
      // approved by the user. Never restore new proposals or cancelled content.
      response = {
        ...previous,
        proposals: approved.map((item) => {
          const settled = response.proposals.find(
            (next) =>
              next.id === item.id &&
              next.kind === "workspace" &&
              next.status !== "ready",
          );
          return settled ?? item;
        }),
      };
    }
    if (
      previous?.requestId === response.requestId &&
      !intentIsRunning(previous) &&
      intentIsRunning(response)
    )
      return;
    currentResponses.current = {
      ...currentResponses.current,
      [response.taskId]: response,
    };
    setResponses(currentResponses.current);
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!window.eve) return;
    let statusEventSeen = false;
    void window.eve
      .intelligenceSettings()
      .then((value) => {
        if (mounted.current && !statusEventSeen) setSettings(value);
      })
      .catch(() => {
        // Unknown is represented explicitly; failure must not imply a provider is ready.
      });
    const off = window.eve.onIntelligence((event) => {
      if (event.type === "status") {
        statusEventSeen = true;
        setSettings(event.settings);
      } else if (event.type === "intent") {
        const response = event.response;
        const attempt = attempts.current.get(response.taskId);
        if (!attempt) return;
        if (attempt.requestId) accept(response);
        else if (attempt.requesting) {
          // IPC events may overtake the invoke receipt. Bind only after the receipt
          // supplies the matching ID; never infer identity from the current space.
          earlyEvents.current.set(response.requestId, response);
          if (earlyEvents.current.size > 32)
            earlyEvents.current.delete(
              earlyEvents.current.keys().next().value!,
            );
        }
      }
    });
    return () => {
      mounted.current = false;
      off();
      for (const attempt of attempts.current.values()) {
        attempt.cancelled = true;
        if (
          attempt.requestId &&
          intentIsRunning(currentResponses.current[attempt.taskId])
        )
          void window.eve
            .cancelIntent(attempt.requestId)
            .catch(() => undefined);
      }
      earlyEvents.current.clear();
    };
  }, [accept]);
  const submit = useCallback(
    async (taskId: string, text: string, before: () => Promise<unknown>, mode?: "canvas" | "ask" | "suggestions" | "learn" | "selection", selection?: () => { id: string; canvasRevision: number }, contextualRefresh?: () => { canvasRevision: number; scope: CanvasSuggestionRefreshScope }) => {
      const previous = attempts.current.get(taskId);
      if (
        previous?.requesting ||
        intentIsRunning(currentResponses.current[taskId])
      )
        return;
      if (
        currentResponses.current[taskId]?.proposals.some(
          (item) =>
            item.status === "applying" || (item.kind === "workspace" && item.status === "uncertain"),
        )
      ) {
        setMessages((values) => ({
          ...values,
          [taskId]:
            "Check the status of this approved change before replacing its review.",
        }));
        return;
      }
      const attempt: Attempt = { taskId, cancelled: false, requesting: true };
      attempts.current.set(taskId, attempt);
      setRequesting((values) => ({ ...values, [taskId]: true }));
      setMessages((values) => ({ ...values, [taskId]: "" }));
      currentResponses.current = { ...currentResponses.current };
      delete currentResponses.current[taskId];
      setResponses(currentResponses.current);
      try {
        await before();
        if (attempt.cancelled || !mounted.current) return;
        const suggestion = selection?.();
        const refresh = contextualRefresh?.();
        const receipt = await window.eve.ask({ taskId, text, ...(mode ? { mode } : {}), ...(suggestion ? { suggestion } : {}), ...(refresh ? { refresh } : {}) });
        attempt.requestId = receipt.requestId;
        if (attempt.cancelled || !mounted.current) {
          cancelRemote(attempt);
          earlyEvents.current.delete(receipt.requestId);
          return;
        }
        const early = earlyEvents.current.get(receipt.requestId);
        earlyEvents.current.delete(receipt.requestId);
        accept(
          early ?? {
            requestId: receipt.requestId,
            taskId,
            status: "pending",
            message: "Looking at your work…",
            citations: [],
            proposals: [],
          },
        );
        return receipt.requestId;
      } catch (error) {
        if (mounted.current && !attempt.cancelled)
          setMessages((values) => ({
            ...values,
            [taskId]:
              error instanceof Error
                ? error.message
                : "This request could not start. Your question is still here.",
          }));
      } finally {
        attempt.requesting = false;
        if (mounted.current && attempts.current.get(taskId) === attempt)
          setRequesting((values) => ({ ...values, [taskId]: false }));
      }
    },
    [accept, cancelRemote],
  );
  const cancel = useCallback(
    (taskId: string, requestId?: string) => {
      const attempt = attempts.current.get(taskId);
      if (!attempt || (requestId && attempt.requestId !== requestId)) return;
      attempt.cancelled = true;
      attempt.requesting = false;
      if (attempt.requestId) cancelRemote(attempt);
      const previous = currentResponses.current[taskId];
      if (previous) {
        currentResponses.current = {
          ...currentResponses.current,
          [taskId]: {
            ...previous,
            status: "cancelled",
            message: "Cancellation requested.",
            proposals: previous.proposals.filter(
              (item) =>
                item.kind === "workspace" &&
                (item.status === "applying" || item.status === "uncertain"),
            ),
            citations: [],
          },
        };
        setResponses(currentResponses.current);
      }
      setMessages((values) => ({
        ...values,
        [taskId]: previous ? "" : "Cancellation requested.",
      }));
      setRequesting((values) => ({ ...values, [taskId]: false }));
    },
    [cancelRemote],
  );
  const proposal = useCallback(
    async (
      taskId: string,
      requestId: string,
      proposalId: string,
      operation: "apply" | "discard",
      before: () => Promise<unknown>,
    ) => {
      const response = currentResponses.current[taskId];
      const candidate = response?.proposals.find(
        (item) => item.id === proposalId,
      );
      const key = `${requestId}:${proposalId}`;
      const statusCheck =
        operation === "apply" &&
        candidate?.kind === "workspace" &&
        candidate.status === "uncertain";
      if (
        response?.requestId !== requestId ||
        (!statusCheck &&
          (response.status !== "complete" || candidate?.status !== "ready")) ||
        !candidate ||
        candidate.kind === "unsupported" ||
        mutations.current.has(key)
      )
        return;
      mutations.current.add(key);
      setMessages((values) => ({ ...values, [taskId]: "" }));
      if (operation === "apply" && !statusCheck)
        accept({
          ...response,
          proposals: response.proposals.map((item) =>
            item.id === proposalId ? { ...item, status: "applying" } : item,
          ),
        });
      let dispatched = false;
      try {
        if (!statusCheck) await before();
        dispatched = true;
        const next = await (
          operation === "apply"
            ? window.eve.applyProposal
            : window.eve.discardProposal
        )({ requestId, proposalId });
        accept(next);
      } catch (error) {
        const current = currentResponses.current[taskId];
        if (current?.requestId === requestId)
          accept({
            ...current,
            proposals: current.proposals.map((item) =>
              item.id === proposalId
                ? {
                    ...item,
                    status:
                      statusCheck ||
                      (candidate.kind === "workspace" &&
                        operation === "apply" &&
                        dispatched)
                        ? "uncertain"
                        : "error",
                    message:
                      error instanceof Error
                        ? error.message
                        : "This change could not be completed.",
                  }
                : item,
            ),
          });
      } finally {
        mutations.current.delete(key);
      }
    },
    [accept],
  );
  const clearPresentation = useCallback(() => {
    for (const attempt of attempts.current.values()) {
      attempt.cancelled = true;
      attempt.requesting = false;
      if (attempt.requestId) cancelRemote(attempt);
    }
    attempts.current.clear();
    earlyEvents.current.clear();
    currentResponses.current = {};
    setResponses({});
    setRequesting({});
    setMessages({});
  }, [cancelRemote]);
  return {
    responses,
    requesting,
    messages,
    settings,
    submit,
    cancel,
    proposal,
    clearPresentation,
  };
}
