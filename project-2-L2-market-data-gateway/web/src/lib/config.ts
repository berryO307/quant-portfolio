// Relay endpoint configuration. Must be NEXT_PUBLIC_* to reach the browser
// bundle (this app connects to the relay directly from the client — Vercel
// doesn't run a persistent WS server for us, and doesn't need to: the relay
// is the always-on piece, not this app). Defaults target a local relay
// instance (see relay/src/index.ts, default port 8080).

export const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ?? "ws://localhost:8080/live";

export const RELAY_HEALTH_URL =
  process.env.NEXT_PUBLIC_RELAY_HEALTH_URL ?? "http://localhost:8080/health";

// Which instrument each relay endpoint is actually serving is NOT wired to
// the wire protocol at all — it never carries a symbol (see
// relay/src/types.ts; SampleRecord/SnapshotRecord/TradeRecord are all
// symbol-agnostic) — so lib/instruments.ts's INSTRUMENTS list is a
// standalone assumption that must be kept in sync with whichever gateway
// process is actually feeding each relay port. RELAY_WS_URL/
// RELAY_HEALTH_URL above configure ONLY the first (Bybit BTCUSDT) entry in
// that list — the rest use fixed localhost ports (see instruments.ts).
