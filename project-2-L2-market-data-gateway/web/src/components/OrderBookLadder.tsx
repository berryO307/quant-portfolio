import { toPrice, toQty, type SnapshotRecord, type TimedTrade } from "@/lib/types";
import { computeDepthLevels, type DepthLevel } from "@/lib/orderBook";
import type { InstrumentConfig } from "@/lib/instruments";
import { use24hChange, type Change24h } from "@/lib/use24hChange";

interface OrderBookLadderProps {
  snapshot: SnapshotRecord | null;
  instrument: InstrumentConfig;
  hoveredPrice?: number | null;
  onHoverPrice?: (price: number | null) => void;
  lastTrade?: TimedTrade | null;
  lastTradeDirection?: "up" | "down";
}

// Fixed row budget per side, independent of how many levels the snapshot
// actually has (at most EXPORT_SNAPSHOT_DEPTH=100, often fewer in a thin
// book — and now also more than fit here, since that constant was bumped
// well past what any ladder should try to display; see the truncation
// below). Phase 8.5's second pass: rendering only the real rows left the
// ladder's height at the mercy of the current book depth, floating in the
// middle of its container with dead space above/below. Padding each side
// out to a constant row count keeps the spread divider anchored at the same
// vertical position and the ladder always filling its box, book depth
// aside.
const LEVELS_PER_SIDE = 12;

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
  instrument,
  hoveredPrice = null,
  onHoverPrice,
  lastTrade = null,
  lastTradeDirection = "up",
}: OrderBookLadderProps) {
  // Called unconditionally, before the early return below — React's hook
  // ordering rules don't allow a hook call to be skipped on some renders
  // (e.g. only once a snapshot exists) and not others.
  const change24h = use24hChange(instrument);

  if (!snapshot || (snapshot.bids.length === 0 && snapshot.asks.length === 0)) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Waiting for order book snapshot…
      </div>
    );
  }

  const { bids: bidsWithTotal, asks: asksWithTotal } = computeDepthLevels(snapshot);

  // The ladder shows a fixed 12 rows/side regardless of how many levels the
  // export pipeline actually carries (bumped past 10 to smooth out the
  // depth curve — see include/export_pipeline.hpp's EXPORT_SNAPSHOT_DEPTH).
  // Slicing to the 12 nearest the spread BEFORE padding keeps the ladder's
  // own fixed row budget regardless of that; DepthCurve intentionally does
  // NOT do this same slicing — it wants every real level it can get.
  const bidsNearSpread = bidsWithTotal.slice(0, LEVELS_PER_SIDE);
  const asksNearSpread = asksWithTotal.slice(0, LEVELS_PER_SIDE);
  const asksDisplay = [...asksNearSpread].reverse(); // worst-to-best, top-to-bottom

  // Bar-width scaling relative to what's actually shown, not the full book
  // depth — reusing computeDepthLevels' own maxTotal (from ALL real levels)
  // here would make every visible bar look nearly empty once the export
  // pipeline carries far more levels than the ladder displays.
  const maxTotal = Math.max(bidsNearSpread.at(-1)?.total ?? 0, asksNearSpread.at(-1)?.total ?? 0, 1);

  // Placeholders go at the outer edge (top for asks, bottom for bids) so
  // real levels always stay anchored nearest the spread divider, regardless
  // of how many are padded in.
  const asksPadded = padTop(asksDisplay, LEVELS_PER_SIDE);
  const bidsPadded = padBottom(bidsNearSpread, LEVELS_PER_SIDE);

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <LadderHeader />
      <div className="flex flex-1 min-h-0 flex-col justify-center overflow-hidden">
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
            />
          ) : (
            <PlaceholderRow key={`ask-empty-${i}`} />
          )
        )}
        <TickerRow
          lastTrade={lastTrade}
          direction={lastTradeDirection}
          change24h={change24h}
          priceDecimals={instrument.priceDecimals}
        />
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
            />
          ) : (
            <PlaceholderRow key={`bid-empty-${i}`} />
          )
        )}
      </div>
    </div>
  );
}

function LadderHeader() {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-border px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span>Price</span>
      <span className="text-right">Size</span>
      <span className="text-right">Total</span>
    </div>
  );
}

// Replaces the old "spread X.XXXX" divider row (Phase 8.5's third pass) —
// modeled on the reference screenshot's ticker: the last trade's
// direction/price, nothing else. An earlier version of this also showed
// best bid/ask alongside as secondary context, but that duplicated the two
// rows immediately above and below it (the ladder already shows both), so
// it was just repeated numbers rather than new information — removed.
//
// The bare price on its own was reported as "vague" — no sense of whether
// it's high, low, or ordinary for the instrument. The 24h change (from
// Hyperliquid's public REST info endpoint — see lib/use24hChange.ts, a
// separate, unrelated data source from the live tick/book/trade feed)
// gives it that context, in brackets, exactly like an actual exchange
// ticker would.
function TickerRow({
  lastTrade,
  direction,
  change24h,
  priceDecimals,
}: {
  lastTrade: TimedTrade | null;
  direction: "up" | "down";
  change24h: Change24h;
  priceDecimals: number;
}) {
  const color = direction === "down" ? "text-[#f85149]" : "text-[#3fb950]";
  const arrow = direction === "down" ? "↓" : "↑";

  return (
    <div className="flex items-center justify-end gap-2 border-y border-border bg-[#0a1424] px-3 py-1 font-mono text-xs tabular-nums">
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
}: {
  row: DepthLevel;
  side: "bid" | "ask";
  maxTotal: number;
  hovered: boolean;
  onHoverPrice?: (price: number | null) => void;
  priceDecimals: number;
  qtyDecimals: number;
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
