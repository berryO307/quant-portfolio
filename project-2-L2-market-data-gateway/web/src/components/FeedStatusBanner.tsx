interface FeedStatusBannerProps {
  wsConnected: boolean;
  healthOk: boolean;
  // Cumulative count of gateway-side ring-buffer overflow drops (see
  // include/export_pipeline.hpp's ExportSample::queue_overflow_dropped) as
  // of the most recent sample. Zero on every live session observed so far
  // — this exists so the day it isn't zero, it's visible here instead of
  // only in the gateway's own console heartbeat log.
  queueOverflowDropped: number;
}

// The only degraded-state indicator in this app — no replay fallback exists,
// so "live feed unavailable" is the full extent of how a problem surfaces to
// the user. Combines two independent signals: wsConnected (can the browser
// reach the relay at all) and healthOk (is the relay's upstream gateway
// connection alive) — either one being false means there's no live data,
// even though they're different failures under the hood. A third, separate
// condition (queueOverflowDropped > 0) doesn't mean the feed is down — data
// is still flowing — but it means the gateway is silently losing ticks
// upstream of everything this UI shows, which is exactly the kind of thing
// this banner exists to surface rather than hide.
//
// Renders nothing at all while live and healthy (Phase 8.5's third pass
// removed the "Live" dot/row — a working feed isn't information worth a
// permanent line of chrome; every other part of the dashboard already
// implies it by showing moving data). This component only ever needs to
// interrupt you when something's actually wrong.
export function FeedStatusBanner({ wsConnected, healthOk, queueOverflowDropped }: FeedStatusBannerProps) {
  const isLive = wsConnected && healthOk;

  if (isLive && queueOverflowDropped === 0) {
    return null;
  }

  if (!isLive) {
    const reason = !wsConnected ? "reconnecting to relay" : "upstream gateway offline";
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[#3a1418] px-3 py-1.5 text-xs text-[#f85149]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#f85149]" aria-hidden />
        Live feed unavailable
        <span className="text-muted-foreground">({reason})</span>
      </div>
    );
  }

  // Live but dropping ticks: a real problem, but not the same one — amber,
  // not the connection-down red, and the feed keeps rendering underneath.
  return (
    <div className="flex items-center gap-2 border-b border-border bg-[#3a2a0f] px-3 py-1.5 text-xs text-[#d29922]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#d29922]" aria-hidden />
      Gateway dropping ticks — ring buffer overflow
      <span className="text-muted-foreground">({queueOverflowDropped} dropped this session)</span>
    </div>
  );
}
