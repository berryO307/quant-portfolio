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
export function FeedStatusBanner({ wsConnected, healthOk }: FeedStatusBannerProps) {
  const isLive = wsConnected && healthOk;

  if (isLive) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-[#8b949e]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#3fb950]" aria-hidden />
        Live
      </div>
    );
  }

  const reason = !wsConnected ? "reconnecting to relay" : "upstream gateway offline";

  return (
    <div className="flex items-center gap-2 border-b border-[#30363d] bg-[#3a1418] px-3 py-1.5 text-xs font-mono text-[#f85149]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#f85149]" aria-hidden />
      Live feed unavailable
      <span className="text-[#8b949e]">({reason})</span>
    </div>
  );
}
