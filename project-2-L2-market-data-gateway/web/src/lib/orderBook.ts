import type { SnapshotRecord } from "./types";

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

// Shared by OrderBookLadder and DepthCurve so both always render the exact
// same cumulative totals by construction, not by coincidence — computing
// this twice from the same raw snapshot would risk the two views drifting
// apart if one call site's logic ever changed without the other.
export function computeDepthLevels(snapshot: SnapshotRecord): DepthLevels {
  const bids = withCumulativeTotal(snapshot.bids);
  const asks = withCumulativeTotal(snapshot.asks);
  const maxTotal = Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0, 1);
  return { bids, asks, maxTotal };
}
