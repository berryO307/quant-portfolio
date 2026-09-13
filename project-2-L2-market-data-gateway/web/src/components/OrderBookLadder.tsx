import { toPrice, toQty, type SnapshotRecord } from "@/lib/types";
import { computeDepthLevels, type DepthLevel } from "@/lib/orderBook";

interface OrderBookLadderProps {
  snapshot: SnapshotRecord | null;
  hoveredPrice?: number | null;
  onHoverPrice?: (price: number | null) => void;
}

// L2 aggregated levels only — at most 10/side, refreshed ~1/s (see the
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
export function OrderBookLadder({ snapshot, hoveredPrice = null, onHoverPrice }: OrderBookLadderProps) {
  if (!snapshot || (snapshot.bids.length === 0 && snapshot.asks.length === 0)) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-[#8b949e]">
        waiting for order book snapshot...
      </div>
    );
  }

  const { bids: bidsWithTotal, asks: asksWithTotal, maxTotal } = computeDepthLevels(snapshot);
  const asksDisplay = [...asksWithTotal].reverse(); // worst-to-best, top-to-bottom

  const bestBid = bidsWithTotal[0]?.price;
  const bestAsk = asksWithTotal[0]?.price;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-xs">
      <LadderHeader />
      <div className="flex flex-1 flex-col justify-end overflow-hidden">
        {asksDisplay.map((row) => (
          <LadderRow
            key={`ask-${row.price}`}
            row={row}
            side="ask"
            maxTotal={maxTotal}
            hovered={row.price === hoveredPrice}
            onHoverPrice={onHoverPrice}
          />
        ))}
      </div>
      <SpreadDivider spread={spread} />
      <div className="flex-1 overflow-hidden">
        {bidsWithTotal.map((row) => (
          <LadderRow
            key={`bid-${row.price}`}
            row={row}
            side="bid"
            maxTotal={maxTotal}
            hovered={row.price === hoveredPrice}
            onHoverPrice={onHoverPrice}
          />
        ))}
      </div>
    </div>
  );
}

function LadderHeader() {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-[#30363d] px-3 py-1 text-[10px] uppercase tracking-wide text-[#8b949e]">
      <span>Price</span>
      <span className="text-right">Size</span>
      <span className="text-right">Total</span>
    </div>
  );
}

function SpreadDivider({ spread }: { spread: number | null }) {
  return (
    <div className="border-y border-[#30363d] bg-[#161b22] px-3 py-1 text-center text-[10px] text-[#8b949e]">
      {spread !== null ? `spread ${toPrice(spread).toFixed(4)}` : "spread —"}
    </div>
  );
}

function LadderRow({
  row,
  side,
  maxTotal,
  hovered,
  onHoverPrice,
}: {
  row: DepthLevel;
  side: "bid" | "ask";
  maxTotal: number;
  hovered: boolean;
  onHoverPrice?: (price: number | null) => void;
}) {
  const textColor = side === "bid" ? "text-[#3fb950]" : "text-[#f85149]";
  const barColor = side === "bid" ? "bg-[#3fb950]/15" : "bg-[#f85149]/15";
  const widthPct = Math.min(100, (row.total / maxTotal) * 100);

  return (
    <div
      className={`relative grid grid-cols-3 gap-2 px-3 py-0.5 ${hovered ? "bg-[#30363d]" : ""}`}
      onMouseEnter={() => onHoverPrice?.(row.price)}
      onMouseLeave={() => onHoverPrice?.(null)}
    >
      <div className={`absolute inset-y-0 right-0 ${barColor}`} style={{ width: `${widthPct}%` }} aria-hidden />
      <span className={`relative z-10 ${textColor}`}>{toPrice(row.price).toFixed(4)}</span>
      <span className="relative z-10 text-right text-[#c9d1d9]">{toQty(row.qty).toFixed(3)}</span>
      <span className="relative z-10 text-right text-[#8b949e]">{toQty(row.total).toFixed(3)}</span>
    </div>
  );
}
