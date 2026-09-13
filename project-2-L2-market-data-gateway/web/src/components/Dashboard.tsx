"use client";

import { useMemo, useState } from "react";
import { RELAY_HEALTH_URL, RELAY_WS_URL } from "@/lib/config";
import { useRelayConnection } from "@/lib/useRelayConnection";
import { computeLiveTailEvents, attributionSplit } from "@/lib/tailAttribution";
import { FeedStatusBanner } from "./FeedStatusBanner";
import { SessionStatsHeader } from "./SessionStatsHeader";
import { OrderBookLadder } from "./OrderBookLadder";
import { DepthCurve } from "./DepthCurve";
import { TradesTape } from "./TradesTape";
import { LatencyPanel } from "./LatencyPanel";

export function Dashboard() {
  const { wsConnected, healthOk, latestSnapshot, trades, recentSamples, stats } = useRelayConnection(
    RELAY_WS_URL,
    RELAY_HEALTH_URL
  );

  const [hoveredPrice, setHoveredPrice] = useState<number | null>(null);

  // Reuses the exact same Phase 8 computation LatencyPanel runs — no
  // separate "stats header" attribution logic to drift out of sync with it.
  const currentSessionSplit = useMemo(
    () => attributionSplit(computeLiveTailEvents(recentSamples).tailEvents),
    [recentSamples]
  );

  return (
    <div className="flex h-screen flex-col bg-[#0d1117] text-[#c9d1d9]">
      <FeedStatusBanner wsConnected={wsConnected} healthOk={healthOk} />
      <SessionStatsHeader
        currentSession={stats?.currentSession ?? null}
        currentSessionSplit={currentSessionSplit}
        rolling12h={stats?.rolling12h ?? null}
        rolling12hSplit={stats?.rolling12hSplit ?? { tailCount: 0, jitterTailCount: 0, pipelineTailCount: 0 }}
      />
      {/* min-h-0 throughout this row (and on each cell's own root, see those
          components): grid/flex items default to min-height:auto, which lets
          a child's intrinsic content size (uPlot's canvas layout, in
          DepthCurve's case) grow the item beyond its track size instead of
          respecting it — invisibly, since overflow-hidden here clips the
          result rather than erroring. Confirmed via Playwright: without
          this, DepthCurve's actual chart content gets clipped out of view
          while the container silently balloons to ~1700px tall. */}
      <div className="grid h-1/2 min-h-0 grid-cols-3 divide-x divide-[#30363d] overflow-hidden">
        <OrderBookLadder snapshot={latestSnapshot} hoveredPrice={hoveredPrice} onHoverPrice={setHoveredPrice} />
        <DepthCurve snapshot={latestSnapshot} hoveredPrice={hoveredPrice} onHoverPrice={setHoveredPrice} />
        <TradesTape trades={trades} />
      </div>
      <div className="h-1/2 min-h-0 border-t border-[#30363d] overflow-hidden">
        <LatencyPanel recentSamples={recentSamples} />
      </div>
    </div>
  );
}
