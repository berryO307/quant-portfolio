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
// book ladder/depth curve (see lib/orderBook.ts's computeDepthLevelsBucketed),
// matching Hyperliquid's own dropdown values exactly (BTC: 1-1000, WTI:
// 0.001-1) — these WERE a single shared list (0.001-1) copied wholesale
// from Hyperliquid's WTI UI and wrongly applied to BTC too; fixed to be
// per-instrument, matching each instrument's own real dropdown.
//
// Matching the values alone isn't enough to make every option USEFUL,
// though: Hyperliquid's public l2Book hard-caps every instrument at 20
// levels/side (BUGS.md #24), and what price RANGE those 20 levels span is
// a function of the REQUESTED nSigFigs (significant-figure rounding) —
// confirmed live: BTC's 20 levels/side span ~$21 at the default/finest
// rounding, ~$190 at nSigFigs=4, ~$1900 at nSigFigs=3, ~$19000 at
// nSigFigs=2 (WTI: ~$0.022 / $0.19 / $1.9 / $19 at the same four tiers) —
// i.e. each coarser bucket tier needs the correspondingly coarser nSigFigs
// request, or it collapses to ~2 rows total (confirmed live: WTI at
// bucket=1 with the DEFAULT/finest rounding still applied). See
// nSigFigsForBucket below and lib/useCoarseBookSnapshot.ts, which fetches
// that wider-but-coarser view directly from Hyperliquid's public REST API
// (bypassing the live WS pipeline, which only ever carries the finest
// rounding) whenever a coarse bucket is selected.
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
    priceBucketOptions: [1, 2, 5, 10, 100, 1000],
  },
  {
    id: "wti-hl",
    label: "WTI Crude Oil (Hyperliquid xyz)",
    symbol: "xyz:CL",
    shortLabel: "WTI",
    ...relayUrls(8085),
    priceDecimals: 3,
    qtyDecimals: 2,
    priceBucketOptions: [0.001, 0.002, 0.005, 0.01, 0.1, 1],
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
