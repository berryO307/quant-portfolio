interface FeedStatusBannerProps {
  wsConnected: boolean;
  healthOk: boolean;
}

// The only degraded-state indicator in this app — no replay fallback exists,
// so "live feed unavailable" is the full extent of how a problem surfaces to
// the user. Combines two independent signals: wsConnected (can the browser
// reach the relay at all) and healthOk (is the relay's upstream gateway
// connection alive) — either one being false means there's no live data,
// even though they're different failures under the hood.
//
// Renders nothing at all while live (Phase 8.5's third pass removed the
// "Live" dot/row — a working feed isn't information worth a permanent line
// of chrome; every other part of the dashboard already implies it by
// showing moving data). This component only ever needs to interrupt you
// when something's actually wrong.
export function FeedStatusBanner({ wsConnected, healthOk }: FeedStatusBannerProps) {
  const isLive = wsConnected && healthOk;

  if (isLive) {
    return null;
  }

  const reason = !wsConnected ? "reconnecting to relay" : "upstream gateway offline";

  return (
    <div className="flex items-center gap-2 border-b border-border bg-[#3a1418] px-3 py-1.5 text-xs text-[#f85149]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#f85149]" aria-hidden />
      Live feed unavailable
      <span className="text-muted-foreground">({reason})</span>
    </div>
  );
}
