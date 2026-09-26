import { PRICE_SCALE, type CoarseSnapshotRecord, type SnapshotRecord } from "./types";

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
// (grouped into selectable price buckets rather than showing every raw
// level). Both OrderBookLadder and DepthCurve share this so a chosen
// bucket size looks identical on both. The available bucket sizes
// themselves are NOT a shared constant — they're per-instrument
// (InstrumentConfig.priceBucketOptions in lib/instruments.ts), since a
// bucket width that's useful for one instrument's price scale can be
// wildly wrong for another's — see that field's own comment.

// Groups raw [price, qty] pairs (PRICE_SCALE-scaled integers) into buckets
// of `bucketRaw` (same scale), summing qty within each bucket. All integer
// arithmetic — bucketRaw is always an exact multiple of 1 raw unit at
// PRICE_SCALE=10000 for any bucket size an instrument's own
// priceBucketOptions would realistically offer, so there's no
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

// Buckets a single raw price the same way bucketRawLevels above aggregates
// a whole side — used by OrderBookLadder's trade-flash effect to find
// which bucketed row a given trade actually falls into, so what flashes
// lines up exactly with how the ladder itself grouped that price (same
// floor-for-bids/ceil-for-asks convention, same PRICE_SCALE conversion).
export function bucketSinglePrice(rawPrice: number, bucketSizeDisplay: number, roundDown: boolean): number {
  const bucketRaw = Math.max(1, Math.round(bucketSizeDisplay * PRICE_SCALE));
  if (bucketRaw <= 1) return rawPrice;
  return roundDown ? Math.floor(rawPrice / bucketRaw) * bucketRaw : Math.ceil(rawPrice / bucketRaw) * bucketRaw;
}

// How many populated rows a bucket selection should realistically be able to
// fill for it to look like a real ladder rather than 1-2 levels padded out
// with empty placeholder rows. Matches OrderBookLadder's own row cap
// (MAX_LEVELS_PER_SIDE). Shared here (not re-declared per caller) because
// pickBestSnapshot below and OrderBookLadder's own rendering need to agree
// on what "enough range" means for the same reason
// bucketRawLevels/computeDepthLevelsBucketed below is shared: two
// independent guesses would silently drift apart.
export const TARGET_LADDER_ROWS = 20;

// A per-side raw-price span: how far the worst visible level sits from the
// best one. Used only to judge whether a snapshot has enough REAL range for
// a given bucket size — never to render anything itself.
function sideSpanRaw(side: readonly [number, number][]): number {
  if (side.length === 0) return 0;
  return Math.abs(side[side.length - 1]![0] - side[0]![0]);
}

// Picks whichever available snapshot (the primary, finest-rounding book, or
// one of the gateway's coarser nSigFigs tiers — see CoarseSnapshotRecord)
// actually has enough real price range to fill TARGET_LADDER_ROWS at the
// caller's chosen bucket size, preferring the FINEST one that qualifies.
//
// This is the fix for a bug that showed up as soon as more than one coarse
// tier existed: with a single fixed coarse source, EVERY bucket size from
// some point upward rendered identically, because bucketing a snapshot
// whose own native level spacing is already wider than the requested
// bucket is a no-op — grouping-by-$10 does nothing to data that arrived
// already grouped by $1,000. The fix is not a bigger lookup table (that
// just moves the same bug to a different bucket size on a different
// instrument's price scale) — it's picking the snapshot at RUN TIME based
// on what its own real data actually covers, which is the one thing that
// stays correct for an instrument this project has never seen, at
// whatever its native price magnitude turns out to be: a $5 bucket on a
// $75,000 instrument and a $0.005 bucket on a $1 instrument make exactly
// the same range/spacing comparison, just at different absolute scales,
// because everything here is computed from the bucket size and the
// snapshot's own prices, never from a hardcoded price magnitude.
//
// "Finest that qualifies" (rather than "widest range available") matters
// for accuracy: a tier with MORE rounding baked in reports coarser
// quantities at each price, and using an unnecessarily coarse tier for a
// bucket size the primary (or a less-rounded tier) could already cover
// perfectly well would throw away real precision for no reason.
export function pickBestSnapshot(
  primary: SnapshotRecord | null,
  coarseByTier: ReadonlyMap<number, CoarseSnapshotRecord>,
  bucketSizeDisplay: number
): SnapshotRecord | CoarseSnapshotRecord | null {
  const bucketRaw = Math.max(1, Math.round(bucketSizeDisplay * PRICE_SCALE));
  const needed = bucketRaw * TARGET_LADDER_ROWS;

  // Candidates ordered finest-first: the primary snapshot (no rounding at
  // all) beats every coarse tier, and among coarse tiers a HIGHER nSigFigs
  // means LESS rounding (Hyperliquid's convention), so higher beats lower.
  const candidates: (SnapshotRecord | CoarseSnapshotRecord)[] = [];
  if (primary) candidates.push(primary);
  candidates.push(...[...coarseByTier.values()].sort((a, b) => b.nsigfigs - a.nsigfigs));

  const fits = (snap: SnapshotRecord | CoarseSnapshotRecord): boolean =>
    sideSpanRaw(snap.bids) >= needed && sideSpanRaw(snap.asks) >= needed;

  const best = candidates.find(fits);
  if (best) return best;

  // Nothing has enough range for this bucket size (can happen briefly at
  // startup before a coarse tier's first message arrives, or if an
  // instrument's own real book is just thin) — widest available real data
  // beats showing nothing, chosen by whichever candidate's own min(bid
  // span, ask span) is largest.
  let widest: SnapshotRecord | CoarseSnapshotRecord | null = null;
  let widestSpan = -1;
  for (const c of candidates) {
    const span = Math.min(sideSpanRaw(c.bids), sideSpanRaw(c.asks));
    if (span > widestSpan) {
      widestSpan = span;
      widest = c;
    }
  }
  return widest;
}

// Aggregates a snapshot's raw levels into bucketSizeDisplay-wide price
// buckets (a display-space value, e.g. 0.005 dollars — converted to raw
// PRICE_SCALE units here, once, rather than asking every call site to know
// about PRICE_SCALE). Shared by OrderBookLadder and DepthCurve so both
// always render identical cumulative totals for a given bucket size, by
// construction rather than by coincidence.
export function computeDepthLevelsBucketed(
  snapshot: SnapshotRecord | CoarseSnapshotRecord,
  bucketSizeDisplay: number
): DepthLevels {
  const bucketRaw = Math.max(1, Math.round(bucketSizeDisplay * PRICE_SCALE));
  const bids = withCumulativeTotal(bucketRawLevels(snapshot.bids, bucketRaw, true));
  const asks = withCumulativeTotal(bucketRawLevels(snapshot.asks, bucketRaw, false));
  const maxTotal = Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0, 1);
  return { bids, asks, maxTotal };
}
