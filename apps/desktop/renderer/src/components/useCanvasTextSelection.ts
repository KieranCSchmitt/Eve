import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  canvasDataEqual,
  type CanvasSuggestionRefreshScope,
} from "@eve/contracts";
export type { CanvasSuggestionRefreshScope } from "@eve/contracts";
type Selected = {
  scope: CanvasSuggestionRefreshScope;
  value: string;
  direction: "forward" | "backward" | "none";
};

/** Measure native textarea text without moving its editor or document selection. */
function selectionRect(
  input: HTMLTextAreaElement,
  start: number,
  end: number,
  backward = false,
) {
  const frame = input.getBoundingClientRect();
  const computed = getComputedStyle(input);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.inert = true;
  for (const property of [
    "box-sizing",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-transform",
    "text-indent",
    "text-align",
    "direction",
    "tab-size",
    "word-spacing",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ]) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${frame.width}px`,
    height: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    borderStyle: "solid",
  });
  const text = document.createTextNode(input.value);
  mirror.append(text);
  document.body.append(mirror);
  try {
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const origin = mirror.getBoundingClientRect();
    const rectangles = [...range.getClientRects()].map((rect) => ({
      left:
        frame.left +
        (backward ? rect.left : rect.right) -
        origin.left -
        input.scrollLeft,
      top: frame.top + rect.top - origin.top - input.scrollTop,
      bottom: frame.top + rect.bottom - origin.top - input.scrollTop,
    }));
    const visible = rectangles.filter(
      (rect) =>
        rect.bottom > Math.max(frame.top, 0) &&
        rect.top < Math.min(frame.bottom, window.innerHeight),
    );
    return (
      (backward ? visible[0] : visible.at(-1)) ??
      (backward ? rectangles[0] : rectangles.at(-1)) ?? {
        left: frame.left,
        top: frame.bottom,
        bottom: frame.bottom,
      }
    );
  } finally {
    mirror.remove();
  }
}

/** Respect the workspace's scroll viewport as well as the native window. */
function visibleFrame(element: HTMLElement) {
  let top = 0,
    bottom = window.innerHeight;
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (!/(?:auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY))
      continue;
    const rect = parent.getBoundingClientRect();
    top = Math.max(top, rect.top + parent.clientTop);
    bottom = Math.min(
      bottom,
      rect.top + parent.clientTop + parent.clientHeight,
    );
  }
  return { top, bottom };
}

/** Ephemeral selection context only. It never writes, requests, or focuses on arrival. */
export function useCanvasTextSelection({
  input,
  host,
  blockId,
  value,
  enabled,
  insightScope,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  host: RefObject<HTMLDivElement | null>;
  blockId: string;
  value: string;
  enabled: boolean;
  insightScope?: CanvasSuggestionRefreshScope;
}) {
  const action = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [retained, setRetained] = useState<Selected | null>(null);
  const insightAnchor =
    retained &&
    retained.value === value &&
    insightScope &&
    canvasDataEqual(retained.scope, insightScope)
      ? retained
      : null;
  const anchor = selected || insightAnchor;
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [reservedHeight, setReservedHeight] = useState(0);
  const [retainReservation, setRetainReservation] = useState(false);
  const pointerActive = useRef(false);
  const composing = useRef(false),
    dragging = useRef(false),
    dismissed = useRef("");
  const latest = useRef({ enabled, blockId, value, selected, retained });
  latest.current = { enabled, blockId, value, selected, retained };
  const signature = (current: Selected) =>
    JSON.stringify([current.scope, current.value]);
  const read = () => {
    const element = input.current;
    if (
      !latest.current.enabled ||
      !element ||
      composing.current ||
      dragging.current ||
      document.activeElement !== element
    )
      return;
    const start = element.selectionStart,
      end = element.selectionEnd;
    if (start === end || !element.value.slice(start, end).trim()) {
      setSelected(null);
      setRetained(null);
      return;
    }
    const next: Selected = {
      scope: {
        blockId: latest.current.blockId,
        selection: {
          field: "body",
          start,
          end,
          text: element.value.slice(start, end),
        },
      },
      value: element.value,
      direction: element.selectionDirection,
    };
    if (signature(next) === dismissed.current) return;
    if (
      latest.current.retained &&
      signature(latest.current.retained) !== signature(next)
    )
      setRetained(null);
    setSelected((previous) =>
      previous &&
      signature(previous) === signature(next) &&
      previous.direction === next.direction
        ? previous
        : next,
    );
  };
  const currentScope = () => {
    const current = latest.current,
      element = input.current,
      snapshot = current.selected || current.retained;
    if (
      !current.enabled ||
      composing.current ||
      !snapshot ||
      !element?.isConnected ||
      snapshot.scope.blockId !== current.blockId ||
      snapshot.value !== current.value ||
      element.value !== snapshot.value
    )
      return null;
    const selection = snapshot.scope.selection!;
    if (
      element.selectionStart !== selection.start ||
      element.selectionEnd !== selection.end ||
      element.value.slice(selection.start, selection.end) !== selection.text
    )
      return null;
    return snapshot.scope;
  };
  const dismiss = (restore = false) => {
    const snapshot = latest.current.selected || latest.current.retained,
      element = input.current;
    if (snapshot) dismissed.current = signature(snapshot);
    if (
      restore &&
      snapshot &&
      element?.isConnected &&
      currentScope() &&
      action.current?.contains(document.activeElement)
    ) {
      element.focus({ preventScroll: true });
      element.setSelectionRange(
        snapshot.scope.selection!.start,
        snapshot.scope.selection!.end,
        snapshot.direction,
      );
    }
    setSelected(null);
    setRetained(null);
  };
  useLayoutEffect(() => {
    if (
      !enabled ||
      (selected &&
        (selected.value !== value || selected.scope.blockId !== blockId))
    )
      setSelected(null);
    if (
      !enabled ||
      (retained &&
        (retained.value !== value || retained.scope.blockId !== blockId))
    )
      setRetained(null);
  }, [enabled, value, blockId, selected, retained]);
  useLayoutEffect(() => {
    let release: ReturnType<typeof setTimeout> | undefined;
    let gesture: { id: number; type: string; target: Element | null } | null =
      null;
    const actionable = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest("button, a, input, textarea, select, [tabindex]") ||
          target
        : null;
    const reset = () => {
      clearTimeout(release);
      gesture = null;
      pointerActive.current = false;
      setRetainReservation(false);
    };
    const start = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) {
        reset();
        return;
      }
      clearTimeout(release);
      gesture = {
        id: event.pointerId,
        type: event.pointerType,
        target: actionable(event.target),
      };
      pointerActive.current = true;
    };
    const finish = (event: PointerEvent) => {
      if (
        !gesture ||
        event.pointerId !== gesture.id ||
        event.pointerType !== gesture.type
      )
        return;
      if (dragging.current) {
        dragging.current = false;
        read();
      }
      // Touch compatibility mouse/focus events can arrive in a later task.
      // Keep the target still until its actual click, not a timer after pointerup.
      const hit = actionable(
        document.elementFromPoint(event.clientX, event.clientY),
      );
      if (hit !== gesture.target) reset();
    };
    const clicked = (event: MouseEvent) => {
      if (!gesture) return;
      if (
        event instanceof PointerEvent &&
        event.pointerId !== gesture.id &&
        event.pointerId !== -1
      )
        return;
      const completed = gesture;
      clearTimeout(release);
      // The target is now determined. Release after this click's handlers and
      // defaults, even when a handler stops propagation before window bubbling.
      release = setTimeout(() => {
        if (gesture === completed) reset();
      }, 0);
    };
    const cancel = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.id) {
        dragging.current = false;
        reset();
      }
    };
    const abandon = () => {
      dragging.current = false;
      reset();
    };
    window.addEventListener("pointerdown", start, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("click", clicked, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", abandon);
    window.addEventListener("contextmenu", abandon, true);
    window.addEventListener("keydown", abandon, true);
    return () => {
      clearTimeout(release);
      window.removeEventListener("pointerdown", start, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("click", clicked, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", abandon);
      window.removeEventListener("contextmenu", abandon, true);
      window.removeEventListener("keydown", abandon, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!anchor || !input.current || !host.current) return;
    let frame = 0,
      active = true;
    const place = () => {
      const element = input.current,
        parent = host.current,
        control = action.current;
      if (!element || !parent || !control) return;
      const selection = anchor.scope.selection!;
      if (selection.end > element.value.length) return;
      const rect = selectionRect(
          element,
          selection.start,
          selection.end,
          anchor.direction === "backward",
        ),
        bounds = parent.getBoundingClientRect();
      const width = control.offsetWidth,
        originalHeight = control.offsetHeight;
      const left = Math.max(
        bounds.left,
        Math.min(
          rect.left,
          bounds.right - width,
          window.innerWidth - width - 8,
        ),
      );
      const inputBottom = element.getBoundingClientRect().bottom;
      const visible = visibleFrame(parent);
      const lineVisible =
        rect.bottom > visible.top && rect.top < visible.bottom;
      const docked =
        lineVisible &&
        inputBottom >= visible.top &&
        inputBottom <= visible.bottom - 8 &&
        inputBottom - rect.bottom <= 32;
      const below = docked ? inputBottom + 7 : rect.bottom + 7;
      const insight = control.querySelector<HTMLElement>(
        ".canvas-context-insight",
      );
      const chrome = insight
        ? originalHeight - insight.offsetHeight
        : originalHeight;
      const roomBelow = visible.bottom - below - 8;
      const roomAbove = rect.top - visible.top - 15;
      const above =
        lineVisible &&
        !docked &&
        roomBelow < chrome + (insight ? 80 : 0) &&
        roomAbove > roomBelow;
      if (insight) {
        // Reserve a useful reading area even at the viewport edge. If fewer
        // than 80px remain, ordinary workspace scrolling can reveal it; wheel
        // input is never trapped in a nonoverflowing explanation container.
        const available = Math.max(
          80,
          Math.floor(
            (lineVisible
              ? above
                ? roomAbove
                : roomBelow
              : visible.bottom - visible.top - 16) - chrome,
          ),
        );
        const maxHeight = `${available}px`;
        if (
          control.style.getPropertyValue("--canvas-context-insight-height") !==
          maxHeight
        )
          control.style.setProperty(
            "--canvas-context-insight-height",
            maxHeight,
          );
      }
      const height = control.offsetHeight;
      let top = above ? rect.top - height - 7 : below;
      if (!docked && lineVisible)
        top = Math.max(
          visible.top + 8,
          Math.min(top, visible.bottom - height - 8),
        );
      // An offscreen selection scrolls with its text. Clamping it to the
      // viewport would reserve the scroll distance below this editor, causing
      // scroll anchoring to grow the block and repeat that distance forever.
      // Reserve only the local popup overflow, never more than its own height.
      setReservedHeight(
        Math.min(height + 14, Math.max(0, top + height + 7 - inputBottom)),
      );
      setPosition((previous) =>
        previous.left === left - bounds.left &&
        previous.top === top - bounds.top
          ? previous
          : { left: left - bounds.left, top: top - bounds.top },
      );
    };
    const schedule = () => {
      if (!active) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(input.current);
    observer.observe(host.current);
    if (action.current) observer.observe(action.current);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    void document.fonts.ready.then(schedule);
    place();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [anchor, input, host]);
  return {
    selected,
    anchor,
    insightVisible:
      !!insightAnchor &&
      (!selected || canvasDataEqual(selected.scope, insightAnchor.scope)),
    retain() {
      const snapshot = latest.current.selected;
      if (snapshot && currentScope()) setRetained(snapshot);
    },
    position,
    reservedHeight: anchor || retainReservation ? reservedHeight : 0,
    action,
    currentScope,
    dismiss,
    events: {
      onSelect: read,
      onPointerDown: () => {
        dragging.current = true;
      },
      onPointerUp: () => {
        dragging.current = false;
        read();
      },
      onPointerCancel: () => {
        dragging.current = false;
      },
      onKeyUp: read,
      onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Escape" && !composing.current && anchor) {
          event.stopPropagation();
          dismiss();
        }
      },
      onCompositionStart: () => {
        composing.current = true;
        setSelected(null);
        setRetained(null);
      },
      onCompositionEnd: () => {
        composing.current = false;
        read();
      },
      onBlur: (event: { relatedTarget: EventTarget | null }) => {
        if (
          event.relatedTarget instanceof Node &&
          action.current?.contains(event.relatedTarget)
        )
          return;
        queueMicrotask(() => {
          if (
            document.activeElement !== input.current &&
            !action.current?.contains(document.activeElement)
          ) {
            if (pointerActive.current && reservedHeight > 0)
              setRetainReservation(true);
            setSelected(null);
          }
        });
      },
    },
  };
}
