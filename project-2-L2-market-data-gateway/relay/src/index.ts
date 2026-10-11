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

const relay = createRelay({
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  maxClients: Number(process.env.MAX_CLIENTS ?? 500),
  maxChannels: Number(process.env.MAX_CHANNELS ?? 256),
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
