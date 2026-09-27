"use client";

import { useEffect, useState } from "react";

interface ReplayIndicatorProps {
  isReplay: boolean;
  capturedAt: number | undefined; // epoch ms, the ORIGINAL capture's start
}

// Calm, factual disclosure — NOT an error/warning state, unlike
// FeedStatusBanner (whose visual language this otherwise matches: same
// flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs
// shape, same small rounded dot). Deliberately neutral/brand coloring
// (bg-panel + text-brand-blue), not the alarm red/amber FeedStatusBanner
// uses for a real problem — a replay session isn't a problem, it's a
// disclosed fact about where the data came from.
//
// Renders nothing at all when isReplay is false (a real live gateway) —
// same "silent unless there's something to say" convention
// FeedStatusBanner follows for its own healthy case, just inverted: THIS
// component's "nothing to say" case is the live one, not the replay one.
export function ReplayIndicator({ isReplay, capturedAt }: ReplayIndicatorProps) {
  // "X days/hours ago" needs the viewer's current time, which (like
  // Sidebar's codename and TopBar's Clock) doesn't exist during SSR —
  // rendering it there would either be wrong or mismatch what the client
  // hydrates with. Deferred to a microtask, same pattern those two use,
  // so this is a callback-triggered update, not a synchronous setState
  // directly in the render/effect body.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!isReplay) return;
    queueMicrotask(() => setNow(Date.now()));
    // Updates once a minute -- "X minutes/hours/days ago" doesn't need
    // finer resolution than that, and a captured session's age changes
    // slowly enough that anything faster would just be wasted renders.
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [isReplay]);

  if (!isReplay) return null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-brand-blue" aria-hidden />
      <span className="text-foreground">Replay</span>
      {capturedAt != null ? (
        <span className="text-muted-foreground">
          — originally captured {formatCapturedAt(capturedAt)}
          {now != null ? ` — ${formatRelativeAge(capturedAt, now)}` : null}
        </span>
      ) : (
        // capturedAt can be legitimately absent (see replay-gateway.mjs's
        // own filename-parse fallback) -- still disclose replay mode
        // itself rather than silently rendering nothing, just without a
        // date this component was never given.
        <span className="text-muted-foreground">— originally captured session (date unknown)</span>
      )}
    </div>
  );
}

// The viewer's own local time/locale, same reasoning as TopBar's Clock --
// a capture timestamp is a real wall-clock moment, not something that
// should always read in one fixed timezone regardless of who's looking.
function formatCapturedAt(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

function formatRelativeAge(epochMs: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  const deltaMin = Math.round(deltaS / 60);
  const deltaHr = Math.round(deltaMin / 60);
  const deltaDay = Math.round(deltaHr / 24);
  if (deltaMin < 1) return "just now";
  if (deltaMin < 60) return `${deltaMin} minute${deltaMin === 1 ? "" : "s"} ago`;
  if (deltaHr < 24) return `${deltaHr} hour${deltaHr === 1 ? "" : "s"} ago`;
  return `${deltaDay} day${deltaDay === 1 ? "" : "s"} ago`;
}
