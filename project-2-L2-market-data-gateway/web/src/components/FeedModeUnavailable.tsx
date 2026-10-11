import type { FeedMode } from "./LiveReplayToggle";

interface FeedModeUnavailableProps {
  mode: FeedMode;
}

// Shown in place of the whole data view (order book/trades + latency
// panel) when the viewer has selected a mode the relay's real upstream
// isn't currently serving -- e.g. "Live" selected against the deployed
// site, which currently only runs replay.service (see BUGS.md and the
// root README's Known Limitations). Deliberately calm/on-theme, matching
// LiveReplayToggle's own "disclosed fact, not an alarm" coloring, and
// deliberately a full replacement for the data view rather than a banner
// layered on top of it -- showing the old replay data mislabeled as live
// underneath a warning is exactly the silent-mislabeling failure mode
// this whole feature exists to avoid. The toggle itself stays visible
// above this (Dashboard.tsx), so switching to the mode that IS available
// is always one click away.
export function FeedModeUnavailable({ mode }: FeedModeUnavailableProps) {
  const heading = mode === "live" ? "Live feed — coming soon" : "No replayed session available";
  const body =
    mode === "live"
      ? "This deployment doesn't have a live gateway connected right now — see the Replay tab for a real captured session, or check back once a live feed is running."
      : "No replayed session is currently loaded on this relay — try the Live tab if a live gateway is connected.";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <span className="h-2 w-2 rounded-full bg-brand-blue" aria-hidden />
      <p className="text-sm font-medium text-foreground">{heading}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
