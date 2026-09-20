import { useEffect, useRef, useState } from "react";
import type { SurfaceKind } from "../../../shared/bridge";
import { Logo } from "../Logo";

/** Native views do not inherit the renderer's overflow clipping. */
function videoSlotVisible(element: HTMLElement, rect: DOMRect): boolean {
  if (document.visibilityState !== "visible" || rect.left < 0 || rect.top < 0 || rect.width < 200 || rect.height < 242) return false;
  let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const bounds = ancestor.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left + ancestor.clientLeft);
      // Preserve fractional layout edges. clientWidth/clientHeight themselves
      // are integer-rounded; use their difference only for border/scrollbars.
      right = Math.min(right, bounds.right - Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - ancestor.clientLeft));
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top + ancestor.clientTop);
      bottom = Math.min(bottom, bounds.bottom - Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - ancestor.clientTop));
    }
  }
  return rect.left >= left && rect.top >= top && rect.right <= right + 0.5 && rect.bottom <= bottom + 0.5;
}

export function ActivitySurface({
  kind,
  taskId,
  sourceId,
  coveredMessage,
  focusLeaseId,
}: {
  kind: SurfaceKind;
  taskId: string;
  sourceId?: string;
  coveredMessage?: string;
  focusLeaseId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("Opening your workspace…");
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let animationFrame = 0;
    let updating = false;
    let hidingVideo = false;
    let updateAgain = false;
    let lastReadyBounds = "";
    let requestGeneration = 0;
    let videoVisibility: boolean | undefined;
    // Only the first request from a deliberate navigation carries its lease.
    // Resize and availability retries must never reclaim keyboard focus.
    let navigationLease = kind === "workbench" ? focusLeaseId : undefined;
    const update = async () => {
      clearTimeout(retry);
      if (!ref.current || disposed) return;
      const r = ref.current.getBoundingClientRect();
      if (kind === "video" && !videoSlotVisible(ref.current, r)) {
        // Hide immediately even while an earlier show/load is pending. This
        // invalidates its host generation and invokes the existing pause/capture
        // path, so late loading cannot cover the header or unrelated content.
        if (updating) updateAgain = true;
        if (videoVisibility === false) return;
        videoVisibility = false;
        lastReadyBounds = "";
        const generation = ++requestGeneration;
        setMessage("Bring the whole video into view to continue. Your place is kept.");
        hidingVideo = true;
        try {
          const result = await window.eve.surface({
            kind, taskId, ...(sourceId ? { sourceId } : {}), visible: false,
            bounds: { x: 0, y: 0, width: Math.min(10000, Math.max(0, r.width)), height: Math.min(10000, Math.max(0, r.height)) },
          });
          if (!disposed && generation === requestGeneration && !result.ready) {
            videoVisibility = undefined;
            retry = setTimeout(update, 1000);
          }
        } catch {
          if (!disposed && generation === requestGeneration) {
            videoVisibility = undefined;
            retry = setTimeout(update, 1000);
          }
        } finally {
          hidingVideo = false;
          if (!disposed && updateAgain && !updating) {
            updateAgain = false;
            schedule();
          }
        }
        return;
      }
      if (updating || (kind === "video" && hidingVideo)) {
        updateAgain = true;
        return;
      }
      const boundsKey = [r.x, r.y, r.width, r.height].join(",");
      if (boundsKey === lastReadyBounds) return;
      updating = true;
      if (kind === "video") videoVisibility = true;
      const generation = ++requestGeneration;
      try {
        const focusLease = navigationLease;
        navigationLease = undefined;
        const result = await window.eve.surface({
          kind,
          taskId,
          ...(sourceId ? { sourceId } : {}),
          ...(focusLease ? { focusLeaseId: focusLease } : {}),
          visible: true,
          bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
        });
        if (!disposed && generation === requestGeneration)
          setMessage(
            result.ready
              ? ""
              : (result.message ?? "This activity is unavailable."),
          );
        if (!disposed && generation === requestGeneration && result.ready) lastReadyBounds = boundsKey;
        if (!disposed && generation === requestGeneration && !result.ready) retry = setTimeout(update, 1000);
      } catch {
        if (!disposed && generation === requestGeneration) {
          setMessage("This activity could not open. Your work is still here.");
          retry = setTimeout(update, 2000);
        }
      } finally {
        updating = false;
        if (updateAgain && !disposed) {
          updateAgain = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => void update());
    };
    const observer = new ResizeObserver(() => {
      schedule();
    });
    observer.observe(ref.current!);
    if (kind === "video") {
      for (let ancestor = ref.current!.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor);
    }
    const visibilityObserver = kind === "video" ? new IntersectionObserver(schedule, { threshold: [0, 1] }) : null;
    visibilityObserver?.observe(ref.current!);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    if (kind === "video") document.addEventListener("visibilitychange", schedule);
    void update();
    return () => {
      disposed = true;
      clearTimeout(retry);
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      visibilityObserver?.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      void window.eve.hideSurfaces();
    };
  }, [kind, taskId, sourceId, focusLeaseId]);
  return (
    <div ref={ref} className="activity-surface" data-testid={`${kind}-surface`}>
      {(coveredMessage || message) && (
        <div className="surface-message" role="status">
          <Logo small />
          <p>{coveredMessage || message}</p>
        </div>
      )}
    </div>
  );
}
