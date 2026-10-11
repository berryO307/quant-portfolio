import { formatCaptureTime } from "@/lib/format";

/*
 * Persistent historical-data notice, shown for as long as a replayed
 * capture is the thing on screen (see Dashboard's showingReplay — the
 * relay's own hello, gated on a healthy connection, not the viewer's mode
 * selection).
 *
 * Slim by design: one line at desktop width, border + 10% amber wash
 * rather than a filled card, so it costs ~26px of vertical space and
 * nothing else. No pulse, no animation, no close button — a notice the
 * viewer can dismiss would defeat the point, and a notice that moves is
 * worse than one that doesn't. Not interactive, so it never sits between
 * the viewer and the data underneath.
 *
 * Colours come from --brand-amber, which is defined for both themes
 * (app/globals.css), unlike FeedStatusBanner's hardcoded dark-only hexes
 * next to it.
 */
export function ReplayNotice({ capturedAt }: { capturedAt: number | undefined }) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-brand-amber/30 bg-brand-amber/10 px-3 py-1.5 text-[11px]"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-amber" aria-hidden />
      <span className="shrink-0 font-semibold uppercase tracking-[0.08em] text-brand-amber">Replay</span>
      {/* The two facts that have to stay explicit: the data is historical,
          and the market timestamps on screen belong to the capture rather
          than to the current clock. Scoped to MARKET timestamps on purpose
          -- the latency charts' own time axis is relay receipt time, which
          is genuinely current even in replay (see RecordedBadge). */}
      <span className="min-w-0 text-foreground/80">
        You are viewing historical market data. Market timestamps come from the recorded capture, not the live
        market.
      </span>
      {/* Below `md` the top bar has no room for its CAPTURE TIME block, so
          the same value rides along here instead -- the capture time is
          never missing while a replay is on screen, at any width. */}
      <span className="shrink-0 font-mono text-brand-amber md:hidden">
        {capturedAt != null ? `Recorded ${formatCaptureTime(capturedAt)}` : "Capture time unavailable"}
      </span>
    </div>
  );
}

/*
 * Small "this came from a capture" chip for panel headers whose numbers or
 * timestamps would otherwise read as live measurements (the trades tape's
 * time column, the latency panel's two chart headers).
 *
 * `title` carries the precise version for the latency panel's case, where
 * the distinction is genuinely subtle: the latency VALUES were measured
 * during the original capture, while the chart's time axis is when the
 * relay streamed those samples (RollingStatsAggregator buckets by its own
 * receipt time). The essential facts never depend on that hover -- they're
 * in the banner above -- so this stays an aid, not the only disclosure.
 */
export function RecordedBadge({ title, className = "" }: { title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-[4px] border border-brand-amber/40 bg-brand-amber/10 px-1 py-[1px] text-[9px] font-semibold uppercase tracking-[0.08em] text-brand-amber ${className}`}
    >
      Recorded
    </span>
  );
}
