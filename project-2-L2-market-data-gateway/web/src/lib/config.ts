// Relay endpoint configuration. Must be NEXT_PUBLIC_* to reach the browser
// bundle (this app connects to the relay directly from the client — Vercel
// doesn't run a persistent WS server for us, and doesn't need to: the relay
// is the always-on piece, not this app). Defaults target a local relay
// instance (see relay/src/index.ts, default port 8080).

export const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ?? "ws://localhost:8080/live";

export const RELAY_HEALTH_URL =
  process.env.NEXT_PUBLIC_RELAY_HEALTH_URL ?? "http://localhost:8080/health";
