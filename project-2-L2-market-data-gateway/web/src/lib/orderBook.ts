import { PRICE_SCALE, type SnapshotRecord } from "./types";

export interface DepthLevel {
  price: number;
  qty: number;
  total: number; // cumulative size from the best price out to this level
}

export function withCumulativeTotal(levels: [number, number][]): DepthLevel[] {
  let running = 0;
  return levels.map(([price, qty]) => {
    running += qty;
    return { price, qty, total: running };
  });
}

export interface DepthLevels {
  bids: DepthLevel[]; // best (highest) first
  asks: DepthLevel[]; // best (lowest) first
  maxTotal: number;
}

// Price-bucket aggregation, matching Hyperliquid's own order-book UI
// (grouped into $0.001/$0.002/$0.005/$0.01/$0.1/$1 buckets, selectable)
// rather than showing every raw level. Both OrderBookLadder and DepthCurve
// share this so a chosen bucket size looks identical on both.
export const PRICE_BUCKET_OPTIONS = [0.001, 0.002, 0.005, 0.01, 0.1, 1] as const;

// Groups raw [price, qty] pairs (PRICE_SCALE-scaled integers) into buckets
// of `bucketRaw` (same scale), summing qty within each bucket. All integer
// arithmetic — bucketRaw is always an exact multiple of 1 raw unit for
// every option in PRICE_BUCKET_OPTIONS at PRICE_SCALE=10000, so there's no
// floating-point drift to worry about the way there would be bucketing in
// display-space dollars directly.
//
// roundDown picks which bucket boundary a price snaps to: true (bids)
// floors to the bucket below — a bucket labeled $96.61 at $0.01 granularity
// means "size resting from here down to (but not below) $96.61", the same
// convention Hyperliquid's own aggregated view uses. false (asks) ceils to
// the bucket above, the mirrored reasoning for the other side: a bucket
// never claims a better price than what's actually resting inside it.
//
// Input must already be sorted best-price-first (bids descending, asks
// ascending, per SnapshotRecord's own convention) — output stays sorted
// the same way.
function bucketRawLevels(levels: readonly [number, number][], bucketRaw: number, roundDown: boolean): [number, number][] {
  if (bucketRaw <= 1) return [...levels]; // already the finest possible granularity — nothing to merge

  const sums = new Map<number, number>();
  for (const [price, qty] of levels) {
    const bucketPrice = roundDown ? Math.floor(price / bucketRaw) * bucketRaw : Math.ceil(price / bucketRaw) * bucketRaw;
    sums.set(bucketPrice, (sums.get(bucketPrice) ?? 0) + qty);
  }

  const bucketed = [...sums.entries()] as [number, number][];
  bucketed.sort((a, b) => (roundDown ? b[0] - a[0] : a[0] - b[0]));
  return bucketed;
}

// Aggregates a snapshot's raw levels into bucketSizeDisplay-wide price
// buckets (a display-space value, e.g. 0.005 dollars — converted to raw
// PRICE_SCALE units here, once, rather than asking every call site to know
// about PRICE_SCALE). Shared by OrderBookLadder and DepthCurve so both
// always render identical cumulative totals for a given bucket size, by
// construction rather than by coincidence.
export function computeDepthLevelsBucketed(snapshot: SnapshotRecord, bucketSizeDisplay: number): DepthLevels {
  const bucketRaw = Math.max(1, Math.round(bucketSizeDisplay * PRICE_SCALE));
  const bids = withCumulativeTotal(bucketRawLevels(snapshot.bids, bucketRaw, true));
  const asks = withCumulativeTotal(bucketRawLevels(snapshot.asks, bucketRaw, false));
  const maxTotal = Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0, 1);
  return { bids, asks, maxTotal };
}
