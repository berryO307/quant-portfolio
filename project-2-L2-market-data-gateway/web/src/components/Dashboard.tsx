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

type LeftTab = "orderbook" | "trades";

export function Dashboard() {
  const { wsConnected, healthOk, cpuGhz, latestSnapshot, trades, recentSamples, stats } = useRelayConnection(
    RELAY_WS_URL,
    RELAY_HEALTH_URL
  );

  const [hoveredPrice, setHoveredPrice] = useState<number | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("orderbook");

  // Reuses the exact same Phase 8 computation LatencyPanel runs — no
  // separate "stats header" attribution logic to drift out of sync with it.
  const currentSessionSplit = useMemo(
    () => attributionSplit(computeLiveTailEvents(recentSamples).tailEvents),
    [recentSamples]
  );

  // For the ticker row (Phase 8.5's third pass, replacing the old spread
  // divider) — trades arrive newest-first, so [0] is the last trade and [1]
  // is the one before it. Direction defaults to "up" when there's nothing
  // to compare against yet (fewer than two trades).
  const lastTrade = trades[0] ?? null;
  const lastTradeDirection: "up" | "down" =
    lastTrade && trades[1] && lastTrade.price < trades[1].price ? "down" : "up";

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <FeedStatusBanner wsConnected={wsConnected} healthOk={healthOk} />

      {/* Two columns: market data (tabbed) on the left, latency on the
          right (Phase 8.5 — order book and trades used to sit side by side,
          competing for attention; the WebSocket connection lives entirely
          in useRelayConnection above, so switching tabs below never touches
          it, and neither ladder/curve nor tape carry any connection state
          of their own to lose on remount). */}
      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-border overflow-y-auto lg:grid-cols-[42%_1fr] lg:divide-x lg:divide-y-0 lg:overflow-hidden">
        <div className="flex min-h-[480px] flex-col overflow-hidden lg:min-h-0">
          <TabBar active={leftTab} onChange={setLeftTab} />
          {leftTab === "orderbook" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-[3] overflow-hidden border-b border-border">
                <OrderBookLadder
                  snapshot={latestSnapshot}
                  hoveredPrice={hoveredPrice}
                  onHoverPrice={setHoveredPrice}
                  lastTrade={lastTrade}
                  lastTradeDirection={lastTradeDirection}
                />
              </div>
              <div className="min-h-0 flex-[2] overflow-hidden">
                <DepthCurve snapshot={latestSnapshot} hoveredPrice={hoveredPrice} onHoverPrice={setHoveredPrice} />
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              <TradesTape trades={trades} />
            </div>
          )}
        </div>

        <div className="flex min-h-[480px] flex-col overflow-hidden lg:min-h-0">
          <SessionStatsHeader
            currentSession={stats?.currentSession ?? null}
            currentSessionSplit={currentSessionSplit}
            rolling12h={stats?.rolling12h ?? null}
            rolling12hSplit={stats?.rolling12hSplit ?? { tailCount: 0, jitterTailCount: 0, pipelineTailCount: 0 }}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <LatencyPanel recentSamples={recentSamples} cpuGhz={cpuGhz} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBar({ active, onChange }: { active: LeftTab; onChange: (tab: LeftTab) => void }) {
  return (
    <div className="flex border-b border-border text-xs">
      <TabButton label="Order book" selected={active === "orderbook"} onClick={() => onChange("orderbook")} />
      <TabButton label="Trades" selected={active === "trades"} onClick={() => onChange("trades")} />
    </div>
  );
}

function TabButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 ${
        selected
          ? "border-b-2 border-primary text-foreground"
          : "border-b-2 border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
