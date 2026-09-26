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

// OrderBookLadder's own row cap (MAX_LEVELS_PER_SIDE) and OrderBookDepthSplit's
// drag-resize clamp both read this directly, so the two stay in sync by
// construction rather than by two independently-maintained constants
// silently drifting apart. NOT used by pickBestSnapshot below any more — it
// used to double as that function's own "enough range" threshold, which was
// the actual bug (see pickBestSnapshot's own comment): it happened to be
// numerically entangled with the same ~20-levels-per-side Hyperliquid
// always returns, which is what made the wrong comparison look plausible
// for so long.
export const TARGET_LADDER_ROWS = 20;

// A per-side raw-price span: how far the worst visible level sits from the
// best one. Used only to judge how much real range a snapshot covers when
// NOTHING qualifies (the last-resort fallback below) — never to decide
// whether a snapshot is fine enough for a bucket size; see nativeGapRaw for
// that (span alone can't answer it — see that function's own comment).
function sideSpanRaw(side: readonly [number, number][]): number {
  if (side.length === 0) return 0;
  return Math.abs(side[side.length - 1]![0] - side[0]![0]);
}

// A per-side estimate of a snapshot's OWN native rounding: the average gap
// between its consecutive real levels. Hyperliquid always returns the same
// ~20 levels/side regardless of nSigFigs (BUGS.md #24) — a coarser tier's
// wider total SPAN is entirely explained by a wider gap PER level, not by
// carrying more real levels, so dividing span by (count - 1) recovers that
// per-level gap directly from the snapshot's own data (same "never a
// hardcoded per-instrument table" approach the rest of this file already
// uses), without needing to know nSigFigs-to-dollar conversion math or the
// instrument's live price magnitude.
function nativeGapRaw(side: readonly [number, number][]): number {
  if (side.length < 2) return 0; // can't measure a gap; treat as arbitrarily fine
  return sideSpanRaw(side) / (side.length - 1);
}

// Picks whichever available snapshot (the primary, finest-rounding book, or
// one of the gateway's coarser nSigFigs tiers — see CoarseSnapshotRecord)
// can actually represent the caller's chosen bucket size WITHOUT snapping
// it to something coarser, preferring the COARSEST one that qualifies (see
// below for why coarsest, not finest).
//
// This replaced an earlier version of this same fix that compared each
// candidate's total SPAN against bucketRaw * TARGET_LADDER_ROWS (20) — a
// real, reported bug (BUGS.md): because Hyperliquid always returns ~20
// levels/side regardless of tier, "span" is ALREADY approximately
// (native gap * 20), so that comparison reduced to roughly
// "native gap * 20 >= bucketRaw * 20" i.e. "native gap >= bucketRaw" — the
// OPPOSITE of "is this source fine enough" — which is why every bucket
// size except the very coarsest option (nothing coarser existed to
// wrongly promote INTO) silently rendered one tier coarser than selected.
// Comparing bucketRaw against each candidate's own native gap directly,
// instead of against a total-span threshold entangled with the same
// level-count Hyperliquid happens to also use for row-filling, is what
// actually fixes it rather than re-tuning the same wrong comparison.
//
// Coarsest qualifying, not finest: once a candidate's native gap is <=
// bucketRaw, bucketing it at bucketRaw is exact — no precision is lost
// relative to the request either way, because the DISPLAYED result is
// capped at bucketRaw regardless of which qualifying source produced it.
// The old "prefer finest" comment worried about losing real precision from
// an unnecessarily coarse tier — a real concern under the old, span-based
// qualifying test (which could accept a coarser tier even when a finer one
// ALSO had "enough range"), but moot now: among sources that all render
// bucketRaw exactly, the coarsest one is the one with genuinely more real
// range/depth behind it, so preferring it fills more of the ladder for
// free, not at the cost of anything the user asked to see.
export function pickBestSnapshot(
  primary: SnapshotRecord | null,
  coarseByTier: ReadonlyMap<number, CoarseSnapshotRecord>,
  bucketSizeDisplay: number
): SnapshotRecord | CoarseSnapshotRecord | null {
  const bucketRaw = Math.max(1, Math.round(bucketSizeDisplay * PRICE_SCALE));

  // Candidates ordered finest-first: the primary snapshot (no rounding at
  // all) beats every coarse tier, and among coarse tiers a HIGHER nSigFigs
  // means LESS rounding (Hyperliquid's convention), so higher beats lower.
  const candidates: (SnapshotRecord | CoarseSnapshotRecord)[] = [];
  if (primary) candidates.push(primary);
  candidates.push(...[...coarseByTier.values()].sort((a, b) => b.nsigfigs - a.nsigfigs));

  const fits = (snap: SnapshotRecord | CoarseSnapshotRecord): boolean =>
    nativeGapRaw(snap.bids) <= bucketRaw && nativeGapRaw(snap.asks) <= bucketRaw;

  // Coarsest (last) qualifying candidate, not the first/finest one — see
  // this function's own comment above for why. candidates is ordered
  // finest-first, so scanning all of it and keeping the last match found
  // is exactly "coarsest that still qualifies."
  let best: SnapshotRecord | CoarseSnapshotRecord | null = null;
  for (const c of candidates) {
    if (fits(c)) best = c;
  }
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
