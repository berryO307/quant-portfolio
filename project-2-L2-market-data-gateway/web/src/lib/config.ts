// Relay endpoint configuration. Must be NEXT_PUBLIC_* to reach the browser
// bundle (this app connects to the relay directly from the client — Vercel
// doesn't run a persistent WS server for us, and doesn't need to: the relay
// is the always-on piece, not this app). Defaults target a local relay
// instance (see relay/src/index.ts, default port 8080).

export const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ?? "ws://localhost:8080/live";

export const RELAY_HEALTH_URL =
  process.env.NEXT_PUBLIC_RELAY_HEALTH_URL ?? "http://localhost:8080/health";

// Which instrument the 24h-change ticker (see lib/use24hChange.ts) asks
// Bybit's public REST API about. This is NOT wired to the actual live feed
// at all — the wire protocol never carries a symbol (see relay/src/types.ts;
// SampleRecord/SnapshotRecord/TradeRecord are all symbol-agnostic) — it's a
// standalone assumption matching the C++ gateway's own hardcoded default
// (src/main.cpp: `argv[2] ?? "btcusdt"`). If this project ever captures a
// different symbol, this needs to be set to match, or the 24h change shown
// will be for the wrong instrument.
export const TICKER_SYMBOL = process.env.NEXT_PUBLIC_TICKER_SYMBOL ?? "BTCUSDT";
