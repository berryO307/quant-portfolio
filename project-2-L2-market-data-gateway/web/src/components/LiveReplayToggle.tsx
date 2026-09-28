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
  // Sidebar's own collapsed/expanded state (lib/sidebarState) -- true on
  // the 56px rail, matching how Sidebar's own NAV_ITEMS shrink to
  // icon-only there. Not this component's business to know WHY it's
  // compact, only to render accordingly.
  compact: boolean;
}

// Lives in the sidebar, near the collapse arrow (see Sidebar.tsx) --
// two buttons (the viewer's own preference) plus a status dot reflecting
// whatever the relay's ACTUAL current upstream is. Calm, on-theme styling
// throughout, matching Sidebar's own nav-item conventions (rounded rows,
// bg-muted for the active/selected one) rather than a bolted-on control.
export function LiveReplayToggle({
  mode,
  onModeChange,
  isReplay,
  capturedAt,
  connectionHealthy,
  compact,
}: LiveReplayToggleProps) {
  // Same SSR-safe deferred-clock pattern as Sidebar's own codename and
  // TopBar's Clock -- "X ago" needs the viewer's own current time, which
  // doesn't exist during SSR.
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
  const capturedCaption =
    capturedAt != null
      ? formatCapturedAt(capturedAt) + (now != null ? ` — ${formatRelativeAge(capturedAt, now)}` : "")
      : "date unknown";

  if (compact) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-border p-2 py-2.5">
        <CompactModeButton
          icon={LiveIcon}
          label="Live"
          selected={mode === "live"}
          active={actualMode === "live"}
          onClick={() => onModeChange("live")}
        />
        <CompactModeButton
          icon={ReplayIcon}
          label="Replay"
          selected={mode === "replay"}
          active={actualMode === "replay"}
          onClick={() => onModeChange("replay")}
          title={mode === "replay" && actualMode === "replay" ? `Replay — ${capturedCaption}` : "Replay"}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border p-2.5">
      <div className="flex items-center gap-1 rounded-[9px] border border-border bg-background p-0.5">
        <ModeButton icon={LiveIcon} label="Live" selected={mode === "live"} onClick={() => onModeChange("live")} />
        <ModeButton
          icon={ReplayIcon}
          label="Replay"
          selected={mode === "replay"}
          onClick={() => onModeChange("replay")}
        />
      </div>
      <div className="flex items-center gap-1.5 px-1 text-[11px] leading-tight text-muted-foreground">
        <StatusDot mode={mode} active={actualMode === mode} />
        {mode === "replay" && actualMode === "replay" ? (
          <span className="truncate" title={capturedCaption}>
            {capturedCaption}
          </span>
        ) : (
          <span>{actualMode === mode ? "connected" : "not connected"}</span>
        )}
      </div>
    </div>
  );
}

// Filled dot, colored by WHICH mode it's reporting on, only "lit" (opaque,
// glowing for Live) when that mode is the one actually active -- selected
// but not yet confirmed, or confirmed unavailable, both read as the same
// muted/hollow dot, matching LiveReplayToggle's original "disclosed fact,
// not an alarm" coloring (never FeedStatusBanner's red/amber for an
// actual error).
//
// Live's lit color is red with a soft glow (box-shadow blur, not a second
// blurred element) -- reads as "on air / recording" at a glance, the
// established visual shorthand for "live" specifically, distinct from
// Replay's own lit color (still brand-blue, unchanged: red and blue don't
// clash, and Replay was never the one this task asked to change).
function StatusDot({ mode, active }: { mode: FeedMode; active: boolean }) {
  if (!active) {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />;
  }
  if (mode === "live") {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_5px_1.5px_rgba(239,68,68,0.75)]"
        aria-hidden
      />
    );
  }
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-blue" aria-hidden />;
}

function ModeButton({
  icon: Icon,
  label,
  selected,
  onClick,
}: {
  icon: (props: { className?: string }) => React.JSX.Element;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-[7px] px-2 py-1 text-[12px] font-medium transition-colors ${
        selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

// Icon-only rail form (56px wide, matching Sidebar's own NAV_ITEMS
// collapsed treatment exactly: icon + bg-muted when selected, no visible
// label). The active/lit status dot rides as a small badge on the icon's
// own corner -- absolutely positioned relative to THIS button alone (a
// `relative` wrapper scoped to one 18px icon, not the page), so it can
// never end up floating over unrelated content the way FeedModeUnavailable's
// own now-removed decorative dot did.
function CompactModeButton({
  icon: Icon,
  label,
  selected,
  active,
  onClick,
  title,
}: {
  icon: (props: { className?: string }) => React.JSX.Element;
  label: string;
  selected: boolean;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      title={title ?? label}
      className={`flex items-center justify-center rounded-[9px] p-2.5 transition-colors ${
        selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <Icon className="h-[18px] w-[18px]" />
        {active && (
          <span
            className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${
              label === "Live"
                ? "bg-red-500 shadow-[0_0_4px_1px_rgba(239,68,68,0.8)]"
                : "bg-brand-blue"
            }`}
            aria-hidden
          />
        )}
      </span>
    </button>
  );
}

function LiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="2.4" fill="currentColor" stroke="none" />
      <path d="M5.8 5.8a6 6 0 0 0 0 8.4M14.2 5.8a6 6 0 0 1 0 8.4" strokeLinecap="round" />
      <path d="M3 3a10 10 0 0 0 0 14M17 3a10 10 0 0 1 0 14" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

function ReplayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 10a6 6 0 1 0 1.8-4.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 3.5v3.5H7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 7v3.3l2.3 1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
