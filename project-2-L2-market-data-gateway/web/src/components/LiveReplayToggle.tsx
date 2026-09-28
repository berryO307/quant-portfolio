"use client";

import { useEffect, useState } from "react";

export type FeedMode = "live" | "replay";

interface LiveReplayToggleProps {
  mode: FeedMode;
  onModeChange: (mode: FeedMode) => void;
  // Whether the CURRENTLY connected upstream is actually a replay -- from
  // the relay's own hello handshake (see relay/src/types.ts's HelloMessage),
  // never inferred. This can disagree with `mode`: a viewer can select
  // "Live" while the relay's real upstream is a replay (the deployed
  // site's current state), or select "Replay" while it's actually live
  // (this machine's dev-up.sh stack right now) -- see Dashboard.tsx for
  // how that mismatch is handled (a calm "not available" card in place of
  // the data view, not this component's job to decide).
  isReplay: boolean;
  capturedAt: number | undefined; // epoch ms, the ORIGINAL capture's start
  // Only trust `isReplay` once the connection is actually healthy --
  // before the first real hello arrives, useRelayConnection's isReplay
  // defaults to false, which would otherwise flash "Live" as if
  // confirmed before anything is actually known.
  connectionHealthy: boolean;
}

// Interactive successor to the old passive ReplayIndicator: two buttons
// (the viewer's own preference) plus a status dot/caption reflecting
// whatever the relay's ACTUAL current upstream is. Calm, on-theme styling
// throughout -- matches FeedStatusBanner's shape (flex items-center gap-2
// border-b border-border px-3 py-1.5 text-xs) but never its alarm
// red/amber: a mode selection not currently being served isn't an error,
// it's an expected, honestly-disclosed state (see the "coming soon" card
// this drives in Dashboard.tsx).
export function LiveReplayToggle({ mode, onModeChange, isReplay, capturedAt, connectionHealthy }: LiveReplayToggleProps) {
  // Same SSR-safe deferred-clock pattern as the component this replaced
  // (and TopBar's Clock, Sidebar's codename) -- "X ago" needs the
  // viewer's own current time, which doesn't exist during SSR.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!isReplay) return;
    queueMicrotask(() => setNow(Date.now()));
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [isReplay]);

  // What the relay's real upstream currently is, only once that's actually
  // known -- connectionHealthy gates this the same way Dashboard.tsx gates
  // the mismatch card, so this component and that decision never disagree
  // about what "actually live right now" means.
  const actualMode: FeedMode | null = connectionHealthy ? (isReplay ? "replay" : "live") : null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-xs">
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5">
        <ModeButton label="Live" selected={mode === "live"} onClick={() => onModeChange("live")} />
        <ModeButton label="Replay" selected={mode === "replay"} onClick={() => onModeChange("replay")} />
      </div>
      {/* Status dot: filled brand-blue when the selected mode is the one
          actually being served right now, muted/hollow otherwise (selected
          but not yet confirmed, or confirmed unavailable) -- the same
          "disclosed fact, not an alarm" coloring the old ReplayIndicator
          used, never FeedStatusBanner's red/amber. */}
      <span
        className={`h-1.5 w-1.5 rounded-full ${actualMode === mode ? "bg-brand-blue" : "bg-muted-foreground/40"}`}
        aria-hidden
      />
      {mode === "replay" && actualMode === "replay" ? (
        <span className="text-muted-foreground">
          {capturedAt != null ? (
            <>
              originally captured {formatCapturedAt(capturedAt)}
              {now != null ? ` — ${formatRelativeAge(capturedAt, now)}` : null}
            </>
          ) : (
            "originally captured session (date unknown)"
          )}
        </span>
      ) : null}
    </div>
  );
}

function ModeButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
        selected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

// The viewer's own local time/locale -- same reasoning as TopBar's Clock.
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
