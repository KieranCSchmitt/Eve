import { useLayoutEffect, useRef, type RefObject } from "react";

export interface TransientFocusOptions {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  restoreFocus?: boolean;
  /** Return true when the host restored focus to a retained native surface. */
  onRestoreFocus?: () => boolean | void;
  /** Modal dialogs should retain the default; this does not set ARIA roles. */
  inertOutside?: boolean;
}

export interface TransientFocusControllerOptions {
  initialFocus?: () => HTMLElement | null;
  returnFocus?: () => HTMLElement | null;
  onEscape?: () => void;
  restoreFocus?: boolean;
  onRestoreFocus?: () => boolean | void;
  inertOutside?: boolean;
}

interface Layer {
  container: HTMLElement;
  options: TransientFocusControllerOptions;
  focusInside: () => void;
}

interface Scope {
  layers: Layer[];
  originalInert: Map<HTMLElement, string | null>;
}

const scopes = new WeakMap<Document, Scope>();
const selector = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "[tabindex]",
  "[contenteditable]",
  "audio[controls]",
  "video[controls]",
  "summary",
].join(",");

function available(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest("[hidden], [inert], [aria-hidden=true]") ||
    element.matches(":disabled")
  )
    return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.visibility !== "hidden" &&
    style?.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

function tabbable(container: HTMLElement): HTMLElement[] {
  const candidates = [
    ...container.querySelectorAll<HTMLElement>(selector),
  ].filter((element) => {
    if (!available(element)) return false;
    if (element.tabIndex >= 0) return true;
    return (
      element.isContentEditable &&
      !element.hasAttribute("tabindex") &&
      !element.parentElement?.isContentEditable
    );
  });
  // A radio group occupies one tab stop; keep the checked radio, or its first member.
  return candidates
    .filter((element) => {
      if (element.tagName !== "INPUT") return true;
      const radio = element as HTMLInputElement;
      if (radio.type !== "radio" || !radio.name) return true;
      const group = candidates.filter(
        (candidate): candidate is HTMLInputElement =>
          candidate.tagName === "INPUT" &&
          (candidate as HTMLInputElement).type === "radio" &&
          (candidate as HTMLInputElement).name === radio.name &&
          (candidate as HTMLInputElement).form === radio.form,
      );
      return (group.find((member) => member.checked) ?? group[0]) === radio;
    })
    .sort(
      (a, b) =>
        (a.tabIndex > 0 ? a.tabIndex : Infinity) -
        (b.tabIndex > 0 ? b.tabIndex : Infinity),
    );
}

function focus(element: HTMLElement | null | undefined): boolean {
  if (!element || !available(element)) return false;
  element.focus({ preventScroll: true });
  return element.ownerDocument.activeElement === element;
}

function top(scope: Scope): Layer | undefined {
  for (let i = scope.layers.length - 1; i >= 0; i--) {
    if (scope.layers[i].container.isConnected) return scope.layers[i];
  }
  return undefined;
}

function updateInert(scope: Scope): void {
  for (const [element, previous] of scope.originalInert) {
    if (previous === null) element.removeAttribute("inert");
    else element.setAttribute("inert", previous);
  }
  scope.originalInert.clear();
  const layer = top(scope);
  if (!layer || layer.options.inertOutside === false) return;
  const doc = layer.container.ownerDocument;
  let branch: HTMLElement | null = layer.container;
  while (branch && branch !== doc.body) {
    const parent: HTMLElement | null = branch.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (
        sibling === branch ||
        !(sibling instanceof doc.defaultView!.HTMLElement)
      )
        continue;
      scope.originalInert.set(sibling, sibling.getAttribute("inert"));
      sibling.setAttribute("inert", "");
    }
    branch = parent;
  }
}

function captureSelection(opener: HTMLElement | null): () => void {
  if (!opener) return () => {};
  if (opener.tagName === "INPUT" || opener.tagName === "TEXTAREA") {
    const input = opener as HTMLInputElement | HTMLTextAreaElement;
    const { selectionStart, selectionEnd, selectionDirection } = input;
    return () => {
      if (selectionStart !== null && selectionEnd !== null) {
        try {
          input.setSelectionRange(
            selectionStart,
            selectionEnd,
            selectionDirection ?? undefined,
          );
        } catch {
          /* Non-text input. */
        }
      }
    };
  }
  const selection = opener.ownerDocument.getSelection();
  const range =
    selection?.rangeCount &&
    opener.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange()
      : undefined;
  const anchor = selection?.anchorNode;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const end = selection?.focusNode;
  const endOffset = selection?.focusOffset ?? 0;
  return () => {
    if (
      !range ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected
    )
      return;
    const current = opener.ownerDocument.getSelection();
    if (
      anchor?.isConnected &&
      end?.isConnected &&
      anchorOffset <=
        (anchor.nodeType === 3
          ? anchor.textContent!.length
          : anchor.childNodes.length) &&
      endOffset <=
        (end.nodeType === 3 ? end.textContent!.length : end.childNodes.length)
    ) {
      current?.setBaseAndExtent(anchor, anchorOffset, end, endOffset);
    } else {
      current?.removeAllRanges();
      current?.addRange(range);
    }
  };
}

/**
 * DOM controller exported for browser behavior tests and non-React overlays.
 * Native WebContents focus is the host's responsibility: place and focus its overlay
 * while modal, and use onRestoreFocus when it was the actual previous owner.
 */
export function activateTransientFocus(
  container: HTMLElement,
  options: TransientFocusControllerOptions = {},
): () => void {
  const doc = container.ownerDocument;
  if (!container.isConnected || !doc.defaultView) return () => {};
  const scope: Scope = scopes.get(doc) ?? {
    layers: [],
    originalInert: new Map(),
  };
  scopes.set(doc, scope);
  const opener =
    doc.activeElement instanceof doc.defaultView.HTMLElement &&
    doc.activeElement !== doc.body
      ? doc.activeElement
      : null;
  const restoreSelection = captureSelection(opener);
  const previousTabIndex = container.getAttribute("tabindex");
  if (previousTabIndex === null) container.setAttribute("tabindex", "-1");
  let lastFocused: HTMLElement | null = null;
  let redirecting = false;
  let disposed = false;
  const focusInside = () => {
    if (redirecting) return;
    redirecting = true;
    try {
      const initial = options.initialFocus?.();
      if (lastFocused && container.contains(lastFocused) && focus(lastFocused))
        return;
      if (initial && container.contains(initial) && focus(initial)) return;
      if (!focus(tabbable(container)[0])) focus(container);
    } finally {
      redirecting = false;
    }
  };
  const layer: Layer = { container, options, focusInside };
  scope.layers.push(layer);
  updateInert(scope);
  const onFocus = (event: FocusEvent) => {
    if (top(scope) !== layer) return;
    const target = event.target as HTMLElement | null;
    if (target && container.contains(target)) lastFocused = target;
    else focusInside();
  };
  const onKey = (event: KeyboardEvent) => {
    if (
      top(scope) !== layer ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229
    )
      return;
    if (
      event.key === "Escape" &&
      options.onEscape &&
      !event.repeat &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    }
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const items = tabbable(container);
    const index = items.indexOf(doc.activeElement as HTMLElement);
    if (
      !items.length ||
      index === -1 ||
      (event.shiftKey ? index === 0 : index === items.length - 1)
    ) {
      event.preventDefault();
      event.stopPropagation();
      focus(event.shiftKey ? items.at(-1) : items[0]) || focus(container);
    }
  };
  doc.addEventListener("focusin", onFocus);
  // Bubble so a nested editor can consume Escape; stop handled Escape before shell shortcuts.
  doc.addEventListener("keydown", onKey);
  const observer = new doc.defaultView.MutationObserver(() => {
    if (top(scope) !== layer) return;
    updateInert(scope);
    if (!container.contains(doc.activeElement)) focusInside();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  focusInside();

  return () => {
    if (disposed) return;
    disposed = true;
    const wasTop = scope.layers.at(-1) === layer;
    observer.disconnect();
    doc.removeEventListener("focusin", onFocus);
    doc.removeEventListener("keydown", onKey);
    scope.layers.splice(scope.layers.indexOf(layer), 1);
    updateInert(scope);
    if (previousTabIndex === null) container.removeAttribute("tabindex");
    else container.setAttribute("tabindex", previousTabIndex);
    if (!wasTop || options.restoreFocus === false) return;
    if (options.onRestoreFocus?.() === true) return;
    const target = options.returnFocus?.() ?? opener;
    if (focus(target)) {
      if (target === opener) restoreSelection();
    } else top(scope)?.focusInside();
  };
}

/** Activate once per opening; new callbacks never refocus an input mid-typing. */
export function useTransientFocus(options: TransientFocusOptions): void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const {
    active,
    containerRef,
    initialFocusRef,
    returnFocusRef,
    inertOutside,
    restoreFocus,
  } = options;
  useLayoutEffect(() => {
    if (!active || !containerRef.current) return;
    return activateTransientFocus(containerRef.current, {
      initialFocus: () => latest.current.initialFocusRef?.current ?? null,
      returnFocus: () => latest.current.returnFocusRef?.current ?? null,
      get onEscape() {
        return latest.current.onEscape;
      },
      onRestoreFocus: () => latest.current.onRestoreFocus?.(),
      inertOutside,
      restoreFocus,
    });
  }, [
    active,
    containerRef,
    initialFocusRef,
    returnFocusRef,
    inertOutside,
    restoreFocus,
  ]);
}
