import { useEffect, useState } from "react";

/** Each mounted consumer owns its deadline update, including retained reviews. */
export function useCanvasReviewExpiration(expiresAt: number | undefined): boolean {
  const [clockRevision, updateClock] = useState(0);
  const expired = expiresAt !== undefined &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now());
  useEffect(() => {
    if (expiresAt === undefined || expired) return;
    // A deadline can pass between render and this effect: schedule a zero-delay
    // update then, rather than leaving that render's still-ready state mounted.
    const delay = Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647);
    const timer = window.setTimeout(() => updateClock(revision => revision + 1), delay);
    return () => window.clearTimeout(timer);
  }, [expiresAt, expired, clockRevision]);
  return expired;
}
