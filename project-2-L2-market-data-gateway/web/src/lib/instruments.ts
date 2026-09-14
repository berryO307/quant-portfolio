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
// magnitude ranges from ~1 (XRP) to ~77,000 (BTC).
export interface InstrumentConfig {
  id: string;
  label: string;
  // A native coin ("BTC") or a builder-deployed sub-dex coin ("xyz:CL") —
  // both subscribe identically over Hyperliquid's WS (confirmed live).
  symbol: string;
  relayWsUrl: string;
  relayHealthUrl: string;
  priceDecimals: number;
  qtyDecimals: number;
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

export const INSTRUMENTS: InstrumentConfig[] = [
  {
    id: "btc-hl",
    label: "BTC (Hyperliquid)",
    symbol: "BTC",
    ...relayUrls(8080, RELAY_WS_URL, RELAY_HEALTH_URL),
    priceDecimals: 2,
    qtyDecimals: 3,
  },
  {
    id: "eth-hl",
    label: "ETH (Hyperliquid)",
    symbol: "ETH",
    ...relayUrls(8081),
    priceDecimals: 2,
    qtyDecimals: 3,
  },
  {
    id: "sol-hl",
    label: "SOL (Hyperliquid)",
    symbol: "SOL",
    ...relayUrls(8082),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
  {
    id: "xrp-hl",
    label: "XRP (Hyperliquid)",
    symbol: "XRP",
    ...relayUrls(8083),
    priceDecimals: 4,
    qtyDecimals: 1,
  },
  {
    id: "hype-hl",
    label: "HYPE (Hyperliquid)",
    symbol: "HYPE",
    ...relayUrls(8084),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
  {
    id: "wti-hl",
    label: "WTI Crude Oil (Hyperliquid xyz)",
    symbol: "xyz:CL",
    ...relayUrls(8085),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
  {
    id: "brent-hl",
    label: "Brent Crude Oil (Hyperliquid xyz)",
    symbol: "xyz:BRENTOIL",
    ...relayUrls(8086),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
];
