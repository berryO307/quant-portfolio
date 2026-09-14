import { RELAY_HEALTH_URL, RELAY_WS_URL } from "./config";

// Instrument shortlist for the dropdown (Hyperliquid migration, see
// HYPERLIQUID_MIGRATION_PROMPT.md at the project root for the research this
// list is grounded in). Each entry names a real, independently-verified-
// liquid instrument — pulled from Hyperliquid's own metaAndAssetCtxs 24h
// volume figures, not guessed. Three third-party oil sub-dexs (flx, km,
// cash) were checked the same way and found to have zero volume/open
// interest — dead listings, deliberately excluded here.
//
// Architecture: one gateway process per instrument (see the migration
// prompt's "how the dropdown actually gets live data" section) — each
// instrument here names its OWN relay WS/health endpoint, on its own port,
// because each is expected to be served by its own independently-running
// `quant_day1.exe --source=<x> <symbol>` + relay pair, not one process
// multiplexing symbols. Selecting an instrument in the UI just switches
// which relay endpoint the browser connects to (useRelayConnection already
// reconnects whenever its wsUrl/healthUrl props change) — nothing here
// reconfigures a running gateway. An instrument whose gateway/relay isn't
// currently running just shows the existing "feed unavailable" state
// (FeedStatusBanner) rather than erroring.
//
// priceDecimals/qtyDecimals: DISPLAY precision only — the wire scale
// (PRICE_SCALE=10000, QTY_SCALE=1000 in lib/types.ts) is fixed and
// identical for every instrument regardless of source; what varies here is
// how many decimal places make sense to actually show for an instrument
// whose price magnitude ranges from ~1 (XRP) to ~77,000 (BTC).
export interface InstrumentConfig {
  id: string;
  label: string;
  source: "bybit" | "hyperliquid";
  // Gateway/wire symbol: Bybit takes "btcusdt"-style; Hyperliquid takes a
  // native coin ("BTC") or a builder-deployed sub-dex coin ("xyz:CL") —
  // both subscribe identically over Hyperliquid's WS (confirmed live).
  symbol: string;
  relayWsUrl: string;
  relayHealthUrl: string;
  priceDecimals: number;
  qtyDecimals: number;
}

// Sequential local ports starting from the project's existing default
// (8080, Bybit BTCUSDT — unchanged, so NEXT_PUBLIC_RELAY_WS_URL/
// NEXT_PUBLIC_RELAY_HEALTH_URL continue to override that one instrument
// exactly as before this feature existed). The rest are fixed localhost
// ports, not individually env-overridable — this is a local multi-instrument
// dev/demo tool, not a deployment with N independently configurable prod
// endpoints.
function relayUrls(port: number, overrideWs?: string, overrideHealth?: string) {
  return {
    relayWsUrl: overrideWs ?? `ws://localhost:${port}/live`,
    relayHealthUrl: overrideHealth ?? `http://localhost:${port}/health`,
  };
}

export const INSTRUMENTS: InstrumentConfig[] = [
  {
    id: "btc-bybit",
    label: "BTC/USDT (Bybit)",
    source: "bybit",
    symbol: "btcusdt",
    ...relayUrls(8080, RELAY_WS_URL, RELAY_HEALTH_URL),
    priceDecimals: 2,
    qtyDecimals: 3,
  },
  {
    id: "btc-hl",
    label: "BTC (Hyperliquid)",
    source: "hyperliquid",
    symbol: "BTC",
    ...relayUrls(8081),
    priceDecimals: 2,
    qtyDecimals: 3,
  },
  {
    id: "eth-hl",
    label: "ETH (Hyperliquid)",
    source: "hyperliquid",
    symbol: "ETH",
    ...relayUrls(8082),
    priceDecimals: 2,
    qtyDecimals: 3,
  },
  {
    id: "sol-hl",
    label: "SOL (Hyperliquid)",
    source: "hyperliquid",
    symbol: "SOL",
    ...relayUrls(8083),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
  {
    id: "xrp-hl",
    label: "XRP (Hyperliquid)",
    source: "hyperliquid",
    symbol: "XRP",
    ...relayUrls(8084),
    priceDecimals: 4,
    qtyDecimals: 1,
  },
  {
    id: "hype-hl",
    label: "HYPE (Hyperliquid)",
    source: "hyperliquid",
    symbol: "HYPE",
    ...relayUrls(8085),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
  {
    id: "wti-hl",
    label: "WTI Crude Oil (Hyperliquid xyz)",
    source: "hyperliquid",
    symbol: "xyz:CL",
    ...relayUrls(8086),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
  {
    id: "brent-hl",
    label: "Brent Crude Oil (Hyperliquid xyz)",
    source: "hyperliquid",
    symbol: "xyz:BRENTOIL",
    ...relayUrls(8087),
    priceDecimals: 3,
    qtyDecimals: 2,
  },
];
