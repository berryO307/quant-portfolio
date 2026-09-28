"use client";

import { useState } from "react";
import { useRelayConnection } from "@/lib/useRelayConnection";
import { INSTRUMENTS, defaultBucketSize } from "@/lib/instruments";
import { pickBestSnapshot } from "@/lib/orderBook";
import { FeedStatusBanner } from "./FeedStatusBanner";
import { ReplayIndicator } from "./ReplayIndicator";
import { OrderBookDepthSplit } from "./OrderBookDepthSplit";
import { TradesTape } from "./TradesTape";
import { LatencyPanel } from "./LatencyPanel";
import { InstrumentSelect } from "./InstrumentSelect";

type LeftTab = "orderbook" | "trades";

export function Dashboard() {
  const [instrument, setInstrument] = useState(INSTRUMENTS[0]);
  // Owned here, not by OrderBookLadder/DepthCurve individually — one price
  // bucket applies to both at once (they show the same book), matching
  // Hyperliquid's own UI, which has a single selector, not two independent
  // ones. Reset alongside the instrument switch itself (not a separate
  // effect/render-diff trick) since this is the one place that already
  // knows exactly when that switch happens.
  //
  // defaultBucketSize (lib/instruments.ts), not priceBucketOptions[0] (the
  // absolute finest option) — starting at the finest bucket gave BTC a
  // depth curve with barely any visible shape and WTI's own finest option
  // is thin the same way; a middle-of-the-list bucket is a reasonable
  // starting view for any instrument without this component needing to
  // know its price magnitude or tick size.
  const [bucketSize, setBucketSize] = useState<number>(defaultBucketSize(INSTRUMENTS[0]!.priceBucketOptions));
  function handleInstrumentChange(next: (typeof INSTRUMENTS)[number]) {
    setInstrument(next);
    setBucketSize(defaultBucketSize(next.priceBucketOptions));
  }
  const {
    wsConnected,
    healthOk,
    cpuGhz,
    capturedAt,
    isReplay,
    symbolMismatch,
    latestSnapshot,
    coarseSnapshots,
    trades,
    recentSamples,
    stats,
  } = useRelayConnection(instrument.relayWsUrl, instrument.relayHealthUrl, instrument.symbol);

  // The order book and depth curve are always built from the gateway's own
  // captured data, never from anything else. Coarser price buckets (e.g.
  // BTC's $1000) need more real price range than the primary subscription's
  // finest rounding carries (~$20-30 on BTC) -- coarseSnapshots holds the
  // gateway's OWN additional, wider-rounded l2Book subscriptions for
  // exactly that (Channel::CoarseDepth, include/market_data_source.hpp),
  // not a browser-side fetch. History: this used to be a live poll straight
  // from the browser to Hyperliquid's REST API (lib/useCoarseBookSnapshot,
  // removed) -- reported live, it kept the order book/depth curve updating
  // after the gateway process was stopped, since that fetch had nothing to
  // do with gateway/relay connectivity.
  //
  // pickBestSnapshot (lib/orderBook.ts), not a fixed per-bucket-index
  // lookup: a single coarse tier, or a static "this bucket size needs
  // coarse data" table, both broke the same way -- every bucket size wider
  // than what one specific source's own native rounding could usefully
  // subdivide rendered identically. Picking the finest available snapshot
  // that actually has enough real range for the CURRENT bucket selection,
  // computed from that snapshot's own prices rather than a hardcoded
  // instrument-specific table, is what makes this correct for an
  // instrument this project has never configured, not just for BTC/WTI.
  const bucketedSnapshot = pickBestSnapshot(latestSnapshot, coarseSnapshots, bucketSize);

  const [hoveredPrice, setHoveredPrice] = useState<number | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("orderbook");

  // For the ticker row (Phase 8.5's third pass, replacing the old spread
  // divider) — trades arrive newest-first, so [0] is the last trade and [1]
  // is the one before it. Direction defaults to "up" when there's nothing
  // to compare against yet (fewer than two trades).
  const lastTrade = trades[0] ?? null;
  const lastTradeDirection: "up" | "down" =
    lastTrade && trades[1] && lastTrade.price < trades[1].price ? "down" : "up";

  // Cumulative, not per-tick — the newest sample carries the current
  // session total (see LiveSample's own comment). recentSamples is
  // chronological (oldest first), so the newest is the last element.
  const queueOverflowDropped = recentSamples.at(-1)?.queueOverflowDropped ?? 0;

  // h-full, not h-screen: this now renders inside the app shell's main
  // region (below the top bar, beside the sidebar), so a full-viewport
  // height here would overflow by exactly the top bar's height.
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <ReplayIndicator isReplay={isReplay} capturedAt={capturedAt} />
      <FeedStatusBanner
        wsConnected={wsConnected}
        healthOk={healthOk}
        queueOverflowDropped={queueOverflowDropped}
        symbolMismatch={symbolMismatch}
      />

      {/* Two columns: market data (tabbed) on the left, latency on the
          right (Phase 8.5 — order book and trades used to sit side by side,
          competing for attention; the WebSocket connection lives entirely
          in useRelayConnection above, so switching tabs below never touches
          it, and neither ladder/curve nor tape carry any connection state
          of their own to lose on remount).

          overflow-y-auto at every breakpoint, not lg:overflow-hidden — the
          previous lg: variant assumed a desktop-width viewport is always
          tall enough to fit everything without scrolling, which broke down
          the moment the order book's own minimum content height grew (9
          guaranteed ladder rows + the depth curve's own floor) past what a
          SHORT-but-WIDE viewport actually has — an embedded browser panel
          inside an IDE, say, which easily clears the lg width breakpoint
          while being nowhere near a full desktop's height. With
          overflow-hidden there, that excess height was silently clipped —
          the depth curve's x-axis, sitting at the very bottom, went
          missing with no scrollbar to reveal it. overflow-y-auto degrades
          to a normal scrollbar instead: on a screen tall enough for
          everything (the common case), no scrollbar appears and nothing
          about the layout changes; on one that isn't, the content is still
          fully reachable. */}
      {/* auto-rows-[minmax(680px,1fr)], not the plain `auto` this used to
          be, and not the 480px floor each stacked column used to carry:
          below lg (single column, two stacked rows) `auto` track sizing
          measures each row from its item's own intrinsic content height —
          and a flex-column item whose children are flex-1 (i.e. flex-basis
          0%) contributes ~0 to that intrinsic measurement no matter how
          much real content those children hold, since flex-basis 0% items
          only grow into space the grid track ALREADY decided to give them.
          The row was therefore always sized to exactly this item's
          explicit min-h floor and nothing more, regardless of overflow.
          minmax(_, 1fr) fixes the "nothing more" part by giving each row a
          DEFINITE pixel height up front (the floor, or an equal share of
          this grid's own already-definite height when there's more to
          give), which correctly cascades down through the flex-1/min-h-0
          chain inside — but the floor itself also had to grow, from 480 to
          680: OrderBookDepthSplit's own drag-resize clamp,
          maxLadderHeight = max(minLadderHeight, containerHeight -
          DEPTH_CURVE_MIN_HEIGHT - DIVIDER_HEIGHT), degenerates to exactly
          minLadderHeight (zero draggable range — the divider "stuck") the
          moment containerHeight can't cover minLadderHeight (410px, 9
          rows/side) + the depth curve's own floor (200px) + the divider
          (6px). 480px cleared none of that headroom once the tab bar and
          padding above it were accounted for, so the split collapsed and
          the depth curve — rendered last, past whatever the ladder and
          divider already consumed — was the part that ran out of room and
          got clipped by this column's own overflow-hidden. 680px clears
          ladder-floor + curve-floor + divider + chrome with room to spare.
          At lg+ there's only a single row (two columns), so this is a
          no-op there — unchanged from before. */}
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(680px,1fr)] grid-cols-1 divide-y divide-border overflow-y-auto lg:grid-cols-[42%_1fr] lg:divide-x lg:divide-y-0">
        {/* order-2 lg:order-1: below the lg breakpoint (single-column
            stack), the latency panel renders FIRST and this market-data
            column second — latency is the primary thing this project
            measures, and on a phone-width screen scrolling past four
            latency charts to reach it read as backwards. At lg and above
            both `order` values reset to the DOM order (this column first,
            same as always), so nothing changes on desktop. */}
        <div className="order-2 flex min-h-[680px] flex-col overflow-hidden lg:order-1 lg:min-h-0">
          <div className="flex items-center justify-between border-b border-border">
            {/* InstrumentSelect sits at the far right of this row, not
                inline right after the tabs — position only, its props and
                behaviour are unchanged. The theme toggle that used to live
                here was removed — TopBar's toggle is now the only one,
                avoiding two controls for one piece of state. */}
            <TabBar active={leftTab} onChange={setLeftTab} />
            <div className="px-2">
              <InstrumentSelect value={instrument} onChange={handleInstrumentChange} />
            </div>
          </div>
          {leftTab === "orderbook" ? (
            // Wrapper only — OrderBookDepthSplit's own root div still owns
            // the ResizeObserver/drag-split logic and just fills whatever
            // box it's given, so padding here doesn't touch its internals.
            // pb-2 keeps the depth curve's x-axis ("Price") from sitting
            // flush against the very bottom edge, matching the breathing
            // room the panels on the right already have.
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-2">
              <OrderBookDepthSplit
                snapshot={latestSnapshot}
                bucketedSnapshot={bucketedSnapshot}
                instrument={instrument}
                bucketSize={bucketSize}
                onBucketSizeChange={setBucketSize}
                hoveredPrice={hoveredPrice}
                onHoverPrice={setHoveredPrice}
                lastTrade={lastTrade}
                lastTradeDirection={lastTradeDirection}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              <TradesTape trades={trades} />
            </div>
          )}
        </div>

        <div className="order-1 flex min-h-[680px] flex-col overflow-hidden lg:order-2 lg:min-h-0">
          <div className="min-h-0 flex-1 overflow-hidden">
            <LatencyPanel
            recentSamples={recentSamples} 
            cpuGhz={cpuGhz}
            stats={stats}
             />
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBar({ active, onChange }: { active: LeftTab; onChange: (tab: LeftTab) => void }) {
  return (
    <div className="flex text-xs">
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
