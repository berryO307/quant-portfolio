"use client";

import { useEffect, useState } from "react";

import { useFeedModeState } from "@/lib/feedModeState";
import { formatCaptureTime } from "@/lib/format";

/*
 * The top bar's operating-state cluster: what you are looking at (live
 * market data, a historical capture, or nothing because the feed is down),
 * when a replayed capture was recorded, and the viewer's own local time —
 * the three things that were previously only inferable from the sidebar
 * toggle, or not shown at all.
 *
 * Reads the SAME state Dashboard already publishes for the sidebar
 * (lib/feedModeState.tsx): no second source of truth, no new props threaded
 * through the layout, and nothing added to the relay protocol. `feed` is
 * null on any route without a Dashboard mounted (/architecture), which is
 * what hides the badge there instead of showing a meaningless "offline".
 *
 * Presentational only. It reports state; it never changes it — the
 * Live/Replay SELECTOR stays in the sidebar, where it already was.
 */

// What is actually on screen, which is not the same as the mode the viewer
// selected: `isReplay` comes from the relay's own hello handshake, and
// `connectionHealthy` gates it because useRelayConnection reports
// isReplay=false before the first hello has arrived. Showing the selected
// mode here would claim "LIVE" while a replay is on screen (or while
// nothing is connected at all), which is exactly the confusion this
// component exists to remove.
type DisplayState = "live" | "replay" | "offline";

const BADGE: Record<DisplayState, { label: string; detail: string; className: string; dotClassName: string }> = {
  live: {
    label: "LIVE",
    detail: "Feed connected",
    className: "border-brand-green/40 bg-brand-green/10 text-brand-green",
    dotClassName: "bg-brand-green",
  },
  replay: {
    label: "REPLAY",
    // Deliberately not "Looping playback": nothing in the hello handshake
    // says whether the upstream replay was started with --loop, and this
    // component does not get to assert a playback behaviour it cannot see.
    detail: "Historical capture",
    className: "border-brand-amber/40 bg-brand-amber/10 text-brand-amber",
    dotClassName: "bg-brand-amber",
  },
  offline: {
    label: "OFFLINE",
    detail: "Reconnecting to relay",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
    dotClassName: "bg-destructive",
  },
};

export function FeedModeIndicator() {
  const { feed } = useFeedModeState();

  const state: DisplayState | null = feed
    ? !feed.connectionHealthy
      ? "offline"
      : feed.isReplay
        ? "replay"
        : "live"
    : null;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {state && (
        <div
          className={`flex shrink-0 items-center gap-1.5 rounded-[7px] border px-1.5 py-[3px] ${BADGE[state].className}`}
        >
          {/* Static, not the sidebar toggle's pulsing tf-dot-glow dot: this
              badge is persistent chrome, and a permanent pulse in the top
              bar is motion with nothing to report. The text label carries
              the state on its own, so colour is never the only signal. */}
          <span className={`h-1.5 w-1.5 rounded-full ${BADGE[state].dotClassName}`} aria-hidden />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">{BADGE[state].label}</span>
          {/* Narrow viewports keep the badge itself and drop the prose:
              "LIVE" next to moving data is the part that matters. */}
          <span className="hidden text-[10px] text-muted-foreground lg:inline">{BADGE[state].detail}</span>
        </div>
      )}

      {state === "replay" && (
        <>
          <span className="hidden h-5 w-px shrink-0 bg-border md:block" aria-hidden />
          <CaptureTime capturedAt={feed?.capturedAt} />
        </>
      )}

      <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden />
      <LocalClock />
    </div>
  );
}

/*
 * When the data on screen was recorded. `capturedAt` is the original
 * capture's own start time, carried through the relay's hello (see
 * relay/src/types.ts) — never derived from the current date, and never
 * replaced by new Date() when it is missing, since a capture time that
 * silently equals "now" is the single most misleading thing this redesign
 * had to rule out.
 *
 * Hidden below `md`, where there is no room for it beside the wordmark;
 * ReplayNotice carries the same value at those widths instead, so the
 * capture time is never absent while a replay is on screen.
 */
function CaptureTime({ capturedAt }: { capturedAt: number | undefined }) {
  return (
    <div className="hidden min-w-0 flex-col items-end leading-tight md:flex">
      <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-brand-amber">Capture time</span>
      <span className="truncate font-mono text-[11px] text-foreground">
        {capturedAt != null ? formatCaptureTime(capturedAt) : "Capture time unavailable"}
      </span>
    </div>
  );
}

/*
 * The viewer's own wall clock, explicitly labelled so it can't be read as a
 * market timestamp — the confusion this redesign is mostly about. Same
 * browser-locale, browser-timezone basis as before (no locale or timeZone
 * argument anywhere), now with the resolved zone printed next to the time
 * rather than left implicit.
 *
 * Moved here from TopBar unchanged in behaviour: still a local 1s interval,
 * still nothing to do with relay data, still null until mounted (the server
 * cannot know the viewer's clock or locale, so rendering one during SSR
 * would hydrate as a mismatch).
 */
function LocalClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // Deferred to a microtask, matching the pattern lib/useTheme.ts and
    // Sidebar's codename already use: a setState in an effect BODY is what
    // react-hooks/set-state-in-effect flags, and the interval's own tick is
    // already inside a callback.
    queueMicrotask(() => setNow(new Date()));
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    // Same footprint as the real thing, so the top bar doesn't reflow on
    // mount.
    return <div aria-hidden="true" className="hidden h-[26px] w-[128px] sm:block" />;
  }

  return (
    <div className="hidden flex-col items-end leading-tight sm:flex">
      <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Local time
        <span className="font-normal tracking-normal normal-case">
          {" · "}
          {now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        </span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        {now.toLocaleTimeString(undefined, { timeZoneName: "short" })}
      </span>
    </div>
  );
}
