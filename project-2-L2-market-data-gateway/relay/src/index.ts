import { createRelay, SYMBOL_PATTERN } from "./server.js";

// Entry point: read configuration from the environment and start one relay
// serving every instrument. All behaviour lives in server.ts (a factory, so
// tests can run real relays on random ports). See relay/README.md for the
// env var reference.
const PORT = Number(process.env.PORT ?? 8080);

const symbols = (process.env.SYMBOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const invalid = symbols.filter((s) => !SYMBOL_PATTERN.test(s));
if (invalid.length > 0) {
  console.error(`[relay] invalid SYMBOLS entries: ${invalid.join(", ")}`);
  process.exit(1);
}

// Comma-separated, e.g. "https://app.vercel.app,http://localhost:3000".
const corsOrigins = (process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const relay = createRelay({
  corsOrigins,
  maxClients: Number(process.env.MAX_CLIENTS ?? 500),
  maxChannels: Number(process.env.MAX_CHANNELS ?? 256),
  // 1024MB/day = at most ~$0.05/day of egress at $0.05/GB, ~$1.55/month,
  // whatever goes wrong. A viewer costs ~8KB/s, so that is ~35 viewer-hours
  // a day. 0 = no cap (not recommended on metered hosting).
  egressBudgetMBPerDay: Number(process.env.EGRESS_BUDGET_MB_PER_DAY ?? 1024),
  ingestToken: process.env.INGEST_TOKEN, // undefined = open /ingest, the local-dev default
  symbols,
  statsIntervalMs: 1_000, // same cadence as the gateway's terminal progress view
  helloTimeoutMs: 10_000,
});

relay.server.listen(PORT, () => {
  console.log(
    `[relay] listening on :${PORT}  (ws: /ingest, /live?symbol= · http: /health, /stats?symbol=, /symbols)` +
      (symbols.length > 0 ? `  pre-declared: ${symbols.join(", ")}` : "")
  );
});
