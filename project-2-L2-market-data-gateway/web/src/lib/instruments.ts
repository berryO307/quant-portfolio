import { RELAY_HEALTH_URL, RELAY_WS_URL } from "./config";

// Instrument shortlist for the dropdown (Hyperliquid migration, see
// HYPERLIQUID_MIGRATION_PROMPT.md at the project root for the research this
// list is grounded in). Each entry names a real, independently-verified-
// liquid instrument — pulled from Hyperliquid's own metaAndAssetCtxs 24h
// volume figures, not guessed. Three third-party oil sub-dexs (flx, km,
// cash) were checked the same way and found to have zero volume/open
// interest — dead listings, deliberately excluded here.
//
// Bybit was removed entirely (see market_data_source.hpp on the C++ side
// and BUGS.md) — every instrument here is Hyperliquid. Kept as its own
// list/type rather than folding into a single hardcoded symbol so a
// second source can be added back here later without restructuring
// anything downstream.
//
// Architecture: one gateway process per instrument (see the migration
// prompt's "how the dropdown actually gets live data" section) — each
// instrument here names its OWN relay WS/health endpoint, on its own port,
// because each is expected to be served by its own independently-running
// `quant_day1.exe <symbol>` + relay pair, not one process multiplexing
// symbols. Selecting an instrument in the UI just switches which relay
// endpoint the browser connects to (useRelayConnection already reconnects
// whenever its wsUrl/healthUrl props change) — nothing here reconfigures a
// running gateway. An instrument whose gateway/relay isn't currently
// running just shows the existing "feed unavailable" state
// (FeedStatusBanner) rather than erroring — see BUGS.md for why that's
// expected unless a capture + replay-gateway is actually running for it
// (there is currently no live gateway->relay push client at all; "live" so
// far has always meant a captured session replayed with --loop).
//
// priceDecimals/qtyDecimals: DISPLAY precision only — the wire scale
// (PRICE_SCALE=10000, QTY_SCALE=1000 in lib/types.ts) is fixed and
// identical for every instrument; what varies here is how many decimal
// places make sense to actually show for an instrument whose price
// magnitude ranges from ~98 (WTI) to ~77,000 (BTC).
//
// priceBucketOptions: per-instrument price-grouping choices for the order
// book ladder/depth curve (see lib/orderBook.ts's computeDepthLevelsBucketed
// and pickBestSnapshot). Deliberately limited to exactly the bucket sizes
// that match one of Hyperliquid's own native rounding tiers for this
// instrument — the primary (finest) subscription plus nSigFigs 4/3/2 (see
// include/coarse_book_state.hpp's COARSE_TIERS) — never an "in-between"
// size like BTC's old $2/$5 or WTI's old $0.002/$0.005 options.
//
// This isn't an arbitrary restriction: Hyperliquid hard-caps every
// subscription at 20 real levels/side, at whichever ONE of those 4 discrete
// nSigFigs values you request — there is no continuous "give me exactly $5
// granularity" request. An in-between bucket size can only be served by the
// one source whose native rounding is at or finer than it (never a coarser
// tier — pickBestSnapshot correctly refuses that, since it would silently
// show coarser data mislabeled as the requested size), and that source's
// own real range is only ~20 levels wide, so an in-between bucket
// unavoidably renders a visibly thinner ladder than every tier-aligned
// option next to it in the same dropdown — confirmed live: BTC bucket=5
// filled only 5 of the ladder's ~20 rows/side, against a full 20 at
// bucket=1 or bucket=10. There is no fix for this at the client: it would
// require either fabricating data Hyperliquid never sent, or showing a
// coarser tier's real data silently mislabeled as a finer bucket size —
// exactly the bug already fixed twice over (project-2-v2.4.8, v2.4.9).
// Every option below is chosen so it always fills the full ladder instead.
export interface InstrumentConfig {
  id: string;
  label: string;
  // A native coin ("BTC") or a builder-deployed sub-dex coin ("xyz:CL") —
  // both subscribe identically over Hyperliquid's WS (confirmed live).
  symbol: string;
  // Short display name for tight spaces (order book column headers) where
  // the full `label` or wire `symbol` ("xyz:CL") would overflow/read oddly
  // — e.g. "Size (xyz:CL)" vs. "Size (WTI)".
  shortLabel: string;
  relayWsUrl: string;
  relayHealthUrl: string;
  priceDecimals: number;
  qtyDecimals: number;
  priceBucketOptions: readonly number[];
}

// Sequential local ports starting from the project's existing default
// (8080 — previously Bybit BTCUSDT, now BTC via Hyperliquid, so
// NEXT_PUBLIC_RELAY_WS_URL/NEXT_PUBLIC_RELAY_HEALTH_URL continue to
// override that one default instrument). The rest are fixed localhost
// ports, not individually env-overridable — this is a local
// multi-instrument dev/demo tool, not a deployment with N independently
// configurable prod endpoints.
function relayUrls(port: number, overrideWs?: string, overrideHealth?: string) {
  return {
    relayWsUrl: overrideWs ?? `ws://localhost:${port}/live`,
    relayHealthUrl: overrideHealth ?? `http://localhost:${port}/health`,
  };
}

// Only the two instruments actually running a live gateway (see
// relay/scripts/run-live-forever.sh) are listed — ETH/SOL/XRP/HYPE/Brent
// were never wired to a real live source (BUGS.md's "always shows feed
// unavailable" case), so keeping them in the dropdown just offered a dead
// end. Add an entry back here once its own gateway is actually running.
export const INSTRUMENTS: InstrumentConfig[] = [
  {
    id: "btc-hl",
    label: "BTC (Hyperliquid)",
    symbol: "BTC",
    shortLabel: "BTC",
    ...relayUrls(8080, RELAY_WS_URL, RELAY_HEALTH_URL),
    priceDecimals: 2,
    qtyDecimals: 3,
    priceBucketOptions: [1, 10, 100, 1000],
  },
  {
    id: "wti-hl",
    label: "WTI Crude Oil (Hyperliquid xyz)",
    symbol: "xyz:CL",
    shortLabel: "WTI",
    ...relayUrls(8085),
    priceDecimals: 3,
    qtyDecimals: 2,
    priceBucketOptions: [0.001, 0.01, 0.1, 1],
  },
];

// Picks a sensible default bucket size from ANY instrument's own
// priceBucketOptions, without hardcoding a per-instrument index or needing
// to know the instrument's price magnitude/tick size. Each instrument's own
// list is already tuned finest-first (see each entry above), but the
// absolute finest option is rarely the best STARTING view: at BTC's $1
// (its tightest real bucket) the depth curve has barely any visible shape
// until the book has had time to build up, and the ladder can look thin
// even though it's showing real data. The coarsest option collapses the
// opposite way (BTC's $1000 buckets can flatten the whole visible book
// into 1-2 steps). The list's MIDDLE entry is a genuinely
// instrument-agnostic compromise — whatever THIS instrument's own tuned
// list considers medium granularity, by construction, since this function
// only ever reads the list's length, never a hardcoded value from it.
export function defaultBucketSize(options: readonly number[]): number {
  if (options.length === 0) return 1;
  return options[Math.floor(options.length / 2)]!;
}

// This file used to also export needsCoarseSnapshot: a per-bucket-index
// lookup ("indices 2+ of priceBucketOptions use the coarse snapshot")
// deciding whether a bucket selection needed the gateway's wider-rounded
// book instead of the primary one. Removed — it assumed a single fixed
// coarse tier, and broke exactly the way a hardcoded table always does:
// every bucket size past a point rendered identically, since bucketing a
// snapshot whose own native spacing is already wider than the requested
// bucket is a no-op. Replaced by lib/orderBook.ts's pickBestSnapshot, which
// picks a snapshot by what its own real data covers at runtime rather than
// by a static index rule — see that function's own comment for why that is
// what actually generalizes to an instrument this project hasn't seen yet.
