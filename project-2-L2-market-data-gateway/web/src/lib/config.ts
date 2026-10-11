// Relay endpoint configuration. Must be NEXT_PUBLIC_* to reach the browser
// bundle (this app connects to the relay directly from the client — Vercel
// doesn't run a persistent WS server for us, and doesn't need to: the relay
// is the always-on piece, not this app).
//
// ONE relay serves every instrument (relay/src/server.ts), so the app needs
// one base URL and derives each instrument's endpoints from its symbol.
// Adding an instrument is an entry in lib/instruments.ts -- no new env var,
// relay, port or deployment.
//
// http:// or https://, no trailing slash. The WebSocket URL is derived from
// it (https -> wss) so the two can never point at different hosts.
const RELAY_URL = (process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const RELAY_WS_BASE = RELAY_URL.replace(/^http/, "ws");

// Symbols contain ":" (builder sub-dex coins like "xyz:CL"), so they're
// URL-encoded; the relay decodes them back.
export function relayLiveUrl(symbol: string): string {
  return `${RELAY_WS_BASE}/live?symbol=${encodeURIComponent(symbol)}`;
}

export function relayHealthUrl(symbol: string): string {
  return `${RELAY_URL}/health?symbol=${encodeURIComponent(symbol)}`;
}
