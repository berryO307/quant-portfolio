"use client";

import { toPrice, toQty, type CoarseSnapshotRecord, type SnapshotRecord, type TimedTrade } from "@/lib/types";
import { computeDepthLevelsBucketed, TARGET_LADDER_ROWS, type DepthLevel } from "@/lib/orderBook";
import type { InstrumentConfig } from "@/lib/instruments";
import { use24hChange, type Change24h } from "@/lib/use24hChange";
import { useTradeFlash } from "@/lib/useTradeFlash";
import { PriceBucketSelect } from "./PriceBucketSelect";

interface OrderBookLadderProps {
  // The live pipeline's snapshot — always the finest rounding. Drives the
  // spread/ticker row (and the empty state below), which should always
  // reflect the true finest-precision market regardless of which bucket is
  // selected for display.
  snapshot: SnapshotRecord | null;
  // What feeds the bucketed ladder rows. Currently always the same live
  // gateway snapshot as `snapshot` below — this used to sometimes be a
  // separately-fetched, coarser-rounded snapshot pulled directly from
  // Hyperliquid's REST API for wide bucket selections, bypassing the
  // gateway entirely. Removed: reported live, it kept the order book and
  // depth curve updating even after the gateway process was stopped, since
  // that fetch had nothing to do with gateway/relay connectivity. A kept-
  // separate prop rather than collapsing onto `snapshot` outright, since
  // "what feeds the bucketed view" and "what the true finest-precision
  // market is" are still conceptually different questions even though they
  // resolve to the same value today.
  // Widened beyond SnapshotRecord: for the coarsest bucket tiers this is
  // coarseSnapshot (Dashboard.tsx), a CoarseSnapshotRecord -- see
  // needsCoarseSnapshot in lib/instruments.ts. Same shape (bids/asks),
  // different price rounding.
  bucketedSnapshot: SnapshotRecord | CoarseSnapshotRecord | null;
  // See useRelayConnection's own comment -- true once connected-and-
  // healthy has held for an unreasonable amount of time with no snapshot
  // at all. Distinguishes "just connected, this is normal" from "waited
  // long enough that something's probably actually wrong" in the empty
  // state below, instead of an indefinite unchanging ellipsis either way.
  snapshotTimedOut: boolean;
  instrument: InstrumentConfig;
  // Owned by Dashboard, not this component — DepthCurve shows the exact
  // same bucketed book, so there's one selector for both, here, matching
  // Hyperliquid's own UI (a single control, not two independent ones).
  bucketSize: number;
  onBucketSizeChange: (size: number) => void;
  hoveredPrice?: number | null;
  onHoverPrice?: (price: number | null) => void;
  lastTrade?: TimedTrade | null;
  lastTradeDirection?: "up" | "down";
}

// Upper bound on rows per side, independent of how many levels the snapshot
// actually has (at most EXPORT_SNAPSHOT_DEPTH=100, often fewer in a thin
// book). Shared with lib/orderBook.ts's pickBestSnapshot (TARGET_LADDER_ROWS)
// so "does this bucket size have enough real range to fill the ladder" and
// "how many rows does the ladder actually try to show" agree by
// construction.
//
// The ACTUAL row count rendered is min(MAX_LEVELS_PER_SIDE, real levels on
// the deeper side) — not always the max. A fixed row budget regardless of
// real depth (the previous behaviour) left a thin book padded out with a
// wall of empty placeholder rows, and forced the ladder's container to a
// constant height whether or not there was real data to fill it. Sizing to
// the real data instead means a shallow book renders a short ladder — see
// Dashboard.tsx, where the ladder's wrapper is sized to content (flex-none)
// and the depth curve below it is flex-1, so it grows to fill whatever
// vertical space the ladder didn't need.
const MAX_LEVELS_PER_SIDE = TARGET_LADDER_ROWS;

function padTop<T>(arr: T[], size: number): (T | null)[] {
  const pad = Math.max(0, size - arr.length);
  return [...(Array(pad).fill(null) as null[]), ...arr];
}

function padBottom<T>(arr: T[], size: number): (T | null)[] {
  const pad = Math.max(0, size - arr.length);
  return [...arr, ...(Array(pad).fill(null) as null[])];
}

// L2 aggregated levels only — at most 100/side, refreshed ~1/s (see the
// SnapshotRecord comment in lib/types.ts for why). Asks render above the
// spread divider worst-to-best top-to-bottom, bids below best-to-worst
// top-to-bottom, so both blocks read "closer to the spread = closer to the
// divider". Each row's background bar is anchored to the same edge on both
// sides and scaled against the larger of the two sides' max cumulative
// total, so relative bid/ask depth imbalance stays visually comparable.
//
// hoveredPrice/onHoverPrice implement the DepthCurve hover sync (Phase 9):
// hovering a row here reports its price up to the shared parent state, and
// a row highlights when the parent reports back that same price (which may
// have originated from DepthCurve instead).
export function OrderBookLadder({
  snapshot,
  bucketedSnapshot,
  snapshotTimedOut,
  instrument,
  bucketSize,
  onBucketSizeChange,
  hoveredPrice = null,
  onHoverPrice,
  lastTrade = null,
  lastTradeDirection = "up",
}: OrderBookLadderProps) {
  // Called unconditionally, before the early return below — React's hook
  // ordering rules don't allow a hook call to be skipped on some renders
  // (e.g. only once a snapshot exists) and not others.
  const change24h = use24hChange(instrument);
  const tradeFlash = useTradeFlash(lastTrade, bucketSize);

  if (!snapshot || (snapshot.bids.length === 0 && snapshot.asks.length === 0)) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1.5 p-4 text-center text-xs">
        {snapshotTimedOut ? (
          <>
            <span className="text-foreground">Still no order book snapshot</span>
            <span className="max-w-xs text-muted-foreground">
              Connected to the relay, but no snapshot has arrived after an unusually long wait — try
              switching instruments and back, or refreshing the page.
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Waiting for order book snapshot…</span>
        )}
      </div>
    );
  }

  const { bids: bidsWithTotal, asks: asksWithTotal } = computeDepthLevelsBucketed(
    bucketedSnapshot ?? snapshot,
    bucketSize
  );

  // Spread is a property of the REAL market, not of whatever bucket size
  // is currently selected for display — computed from the raw snapshot's
  // own best bid/ask, not the (possibly coarser) bucketed levels above.
  const bestBidRaw = snapshot.bids[0]?.[0] ?? null;
  const bestAskRaw = snapshot.asks[0]?.[0] ?? null;
  const hasSpread = bestBidRaw != null && bestAskRaw != null;
  const spread = hasSpread ? toPrice(bestAskRaw! - bestBidRaw!) : null;
  const midPrice = hasSpread ? toPrice((bestBidRaw! + bestAskRaw!) / 2) : null;
  const spreadPct = spread != null && midPrice ? (spread / midPrice) * 100 : null;

  // Slice to the MAX_LEVELS_PER_SIDE nearest the spread on each side (the
  // export pipeline can carry far more — see
  // include/export_pipeline.hpp's EXPORT_SNAPSHOT_DEPTH). DepthCurve
  // intentionally does NOT do this same slicing — it wants every real
  // level it can get.
  const bidsNearSpread = bidsWithTotal.slice(0, MAX_LEVELS_PER_SIDE);
  const asksNearSpread = asksWithTotal.slice(0, MAX_LEVELS_PER_SIDE);
  const asksDisplay = [...asksNearSpread].reverse(); // worst-to-best, top-to-bottom

  // Rows actually rendered per side: whichever side has more real levels,
  // capped at MAX_LEVELS_PER_SIDE — NOT always the max. A shallow book (say
  // 4 real levels/side) renders a 4-row ladder, not a 20-row one padded out
  // with 16 empty placeholders; a deep book fills all the way to the cap.
  // Both sides pad to the SAME count (the deeper side's) so the spread
  // divider stays centered regardless of a bid/ask depth imbalance.
  const levelsPerSide = Math.min(MAX_LEVELS_PER_SIDE, Math.max(bidsNearSpread.length, asksNearSpread.length));

  // Bar-width scaling relative to what's actually shown, not the full book
  // depth — reusing computeDepthLevelsBucketed's own maxTotal (from ALL real
  // levels) here would make every visible bar look nearly empty once the
  // export pipeline carries far more levels than the ladder displays.
  const maxTotal = Math.max(bidsNearSpread.at(-1)?.total ?? 0, asksNearSpread.at(-1)?.total ?? 0, 1);

  // Placeholders go at the outer edge (top for asks, bottom for bids) so
  // real levels always stay anchored nearest the spread divider, regardless
  // of how many are padded in.
  const asksPadded = padTop(asksDisplay, levelsPerSide);
  const bidsPadded = padBottom(bidsNearSpread, levelsPerSide);

  return (
    // h-full: fills whatever height its parent (OrderBookDepthSplit's
    // ladder wrapper) currently gives it — which itself is either "auto"
    // (sized to real content, when there's room — a % height against an
    // "auto" ancestor resolves as auto too, so this falls back to natural
    // content sizing in that case, same as before) or a capped/dragged
    // pixel value once content would exceed it. Either way, the asks/bids
    // sections below split whatever height this ends up with 50/50.
    <div className="flex h-full min-h-0 flex-col text-xs">
      <LadderHeader
        bucketSize={bucketSize}
        onBucketSizeChange={onBucketSizeChange}
        bucketOptions={instrument.priceBucketOptions}
        instrumentLabel={instrument.shortLabel}
      />
      {/* Asks and bids each get an EQUAL flex-1 share of whatever height is
          available, not one shared overflow-hidden block. A single block
          (the previous structure) clips whatever falls past its bottom
          edge — since bids render last (physically at the bottom), that
          silently ate into bids first while every ask stayed visible, no
          matter how far the ladder was squeezed. Two equal-share sections
          shrink in lockstep, so squeezing the ladder always removes the
          same number of rows from each side, converging toward the spread
          symmetrically instead of favoring one side. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* justify-end: asks render worst-to-best, top-to-bottom (farthest
            from the spread first) — anchoring this section's content to
            its OWN bottom means overflow-hidden clips from the TOP first,
            i.e. the farthest asks go first and the ones nearest the spread
            (at the bottom of this section, right above the divider row)
            stay visible longest. Mirrors the bids section below exactly. */}
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
          {asksPadded.map((row, i) =>
            row ? (
              <LadderRow
                key={`ask-${row.price}`}
                row={row}
                side="ask"
                maxTotal={maxTotal}
                hovered={row.price === hoveredPrice}
                onHoverPrice={onHoverPrice}
                priceDecimals={instrument.priceDecimals}
                qtyDecimals={instrument.qtyDecimals}
                flashKey={
                  tradeFlash?.side === "ask" && tradeFlash.bucketPrice === row.price ? tradeFlash.key : undefined
                }
              />
            ) : (
              <PlaceholderRow key={`ask-empty-${i}`} />
            )
          )}
        </div>
        <SpreadAndTickerRow
          spread={spread}
          spreadPct={spreadPct}
          lastTrade={lastTrade}
          direction={lastTradeDirection}
          change24h={change24h}
          priceDecimals={instrument.priceDecimals}
        />
        {/* Default (top-anchored) flow: bids render best-to-worst,
            top-to-bottom, so the farthest bid sits at the bottom of this
            section — overflow-hidden clipping from the bottom removes it
            first, same "farthest goes first" rule as the asks section
            above, just mirrored. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {bidsPadded.map((row, i) =>
            row ? (
              <LadderRow
                key={`bid-${row.price}`}
                row={row}
                side="bid"
                maxTotal={maxTotal}
                hovered={row.price === hoveredPrice}
                onHoverPrice={onHoverPrice}
                priceDecimals={instrument.priceDecimals}
                qtyDecimals={instrument.qtyDecimals}
                flashKey={
                  tradeFlash?.side === "bid" && tradeFlash.bucketPrice === row.price ? tradeFlash.key : undefined
                }
              />
            ) : (
              <PlaceholderRow key={`bid-empty-${i}`} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

// Same 3-column grid template (grid-cols-3 gap-2 px-3) as LadderRow/
// PlaceholderRow below, so "Price"/"Size (…)"/"Total (…)" land in exactly
// the same column widths as the price/size/total cells underneath them —
// the previous flex-based header (bucket select left, "Size"/"Total"
// right-justified as a pair) had no shared width source with the data
// grid, so its labels drifted out of alignment with their columns as soon
// as the row values' digit counts differed from the header text's own
// width.
//
// The price-bucket dropdown sits in the "Price Bucket" column, matching
// Hyperliquid's own order-book UI, which puts its equivalent selector in
// this same top-left spot rather than as a separate control row competing
// for vertical space. Labeled "Price Bucket", not bare "Price" — every row
// below is grouped by the selected bucket size (see
// lib/orderBook.ts's computeDepthLevelsBucketed), not a raw exchange
// price, and the dropdown right next to it IS the bucket-size control, so
// the column should say what it's actually showing.
function LadderHeader({
  bucketSize,
  onBucketSizeChange,
  bucketOptions,
  instrumentLabel,
}: {
  bucketSize: number;
  onBucketSizeChange: (size: number) => void;
  bucketOptions: readonly number[];
  instrumentLabel: string;
}) {
  return (
    <div className="grid grid-cols-3 items-center gap-2 border-b border-border px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span>Price Bucket</span>
        <PriceBucketSelect
          value={bucketSize}
          onChange={onBucketSizeChange}
          options={bucketOptions}
          className="rounded border border-border bg-panel px-1 py-0.5 font-mono text-[10px] normal-case tabular-nums text-foreground"
        />
      </div>
      <span className="text-right">Size ({instrumentLabel})</span>
      <span className="text-right">Total ({instrumentLabel})</span>
    </div>
  );
}

// Spread (absolute + %) and the last-trade/24h-change ticker on one line —
// reported as two stacked rows reading like unrelated information when
// they're really the same "where is the market right now" context.
// Spread on the left, ticker on the right, matching Hyperliquid's own
// order-book UI's single divider row at the bid/ask boundary.
//
// The bare last-trade price on its own was reported as "vague" earlier —
// no sense of whether it's high, low, or ordinary for the instrument. The
// 24h change (from Hyperliquid's public REST info endpoint — see
// lib/use24hChange.ts, a separate, unrelated data source polled every 60s,
// not the live tick/book/trade feed — 24h context doesn't need live-tick
// cadence) gives it that, in brackets, like an actual exchange ticker.
function SpreadAndTickerRow({
  spread,
  spreadPct,
  lastTrade,
  direction,
  change24h,
  priceDecimals,
}: {
  spread: number | null;
  spreadPct: number | null;
  lastTrade: TimedTrade | null;
  direction: "up" | "down";
  change24h: Change24h;
  priceDecimals: number;
}) {
  const color = direction === "down" ? "text-[#f85149]" : "text-[#3fb950]";
  const arrow = direction === "down" ? "↓" : "↑";

  return (
    <div className="flex items-center justify-between gap-3 border-y border-border bg-panel px-3 py-1 font-mono text-[10px] tabular-nums">
      {spread != null && spreadPct != null ? (
        <span className="text-muted-foreground">
          Spread <span className="text-foreground">{spread.toFixed(priceDecimals)}</span>{" "}
          <span className="text-foreground">{spreadPct.toFixed(3)}%</span>
        </span>
      ) : (
        <span />
      )}
      <span className="flex items-center gap-2 text-xs">
        {lastTrade ? (
          <span className={`font-semibold ${color}`}>
            {arrow} {toPrice(lastTrade.price).toFixed(priceDecimals)}
          </span>
        ) : (
          <span className="text-muted-foreground">waiting for trades…</span>
        )}
        {change24h.pcnt != null && (
          <span className={change24h.pcnt >= 0 ? "text-[#3fb950]" : "text-[#f85149]"}>
            ({change24h.pcnt >= 0 ? "+" : ""}
            {(change24h.pcnt * 100).toFixed(2)}% 24h)
          </span>
        )}
      </span>
    </div>
  );
}

function PlaceholderRow() {
  return (
    <div className="grid grid-cols-3 gap-2 px-3 py-0.5 text-muted-foreground/30" aria-hidden>
      <span className="font-mono">—</span>
      <span className="text-right font-mono">—</span>
      <span className="text-right font-mono">—</span>
    </div>
  );
}

function LadderRow({
  row,
  side,
  maxTotal,
  hovered,
  onHoverPrice,
  priceDecimals,
  qtyDecimals,
  flashKey,
}: {
  row: DepthLevel;
  side: "bid" | "ask";
  maxTotal: number;
  hovered: boolean;
  onHoverPrice?: (price: number | null) => void;
  priceDecimals: number;
  qtyDecimals: number;
  // The flashing trade's own trade_id, only when THIS row is the one it
  // printed against — see lib/useTradeFlash.ts. Keyed onto the overlay
  // div below (not just toggled via a className) so React mounts a fresh
  // DOM node per trade, restarting the CSS animation even when two trades
  // land on the same bucketed price back-to-back — reusing the same node
  // wouldn't replay an animation that's already finished.
  flashKey?: number;
}) {
  const textColor = side === "bid" ? "text-[#3fb950]" : "text-[#f85149]";
  const barColor = side === "bid" ? "bg-[#3fb950]/15" : "bg-[#f85149]/15";
  const widthPct = Math.min(100, (row.total / maxTotal) * 100);

  return (
    <div
      className={`relative grid grid-cols-3 gap-2 px-3 py-0.5 ${hovered ? "bg-accent" : ""}`}
      onMouseEnter={() => onHoverPrice?.(row.price)}
      onMouseLeave={() => onHoverPrice?.(null)}
    >
      <div className={`absolute inset-y-0 right-0 ${barColor}`} style={{ width: `${widthPct}%` }} aria-hidden />
      {flashKey != null && (
        <div
          key={flashKey}
          className={`absolute inset-0 ${side === "bid" ? "flash-bid" : "flash-ask"}`}
          aria-hidden
        />
      )}
      <span className={`relative z-10 font-mono tabular-nums ${textColor}`}>
        {toPrice(row.price).toFixed(priceDecimals)}
      </span>
      <span className="relative z-10 text-right font-mono tabular-nums text-foreground">
        {toQty(row.qty).toFixed(qtyDecimals)}
      </span>
      <span className="relative z-10 text-right font-mono tabular-nums text-muted-foreground">
        {toQty(row.total).toFixed(qtyDecimals)}
      </span>
    </div>
  );
}
