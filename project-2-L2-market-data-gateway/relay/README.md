# Relay

The Node.js relay accepts gateway or replay pushes, routes them by instrument, and serves WebSocket feeds and rolling latency aggregates to browser clients. The deployed service runs on Railway. The public feed is supplied by replay workers that load captured sessions from Neon Postgres; a running C++ gateway can also push to the relay.

See the [gateway README](../README.md#architecture) for the full system and demo.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `ws /ingest` | Authenticated gateway or replay input; instrument comes from the hello message. |
| `ws /live?symbol=BTC` | Browser feed for one instrument. |
| `GET /health?symbol=BTC` | Health for the selected feed. |
| `GET /health` | Relay health across configured channels. |
| `GET /stats?symbol=BTC` | Rolling latency aggregates for one instrument. |
| `GET /symbols` | Configured channels, connection state, and viewer counts. |

Encode symbols containing `:` in query parameters, for example `xyz%3ACL`.

## Local development

```bash
npm install
npm run dev
```

In another terminal, send protocol-shaped sample records:

```bash
npm run fake-gateway -- --symbol=BTC
```

The fake gateway is for UI and relay development; it is not an exchange feed. To replay an exported capture file, use `npm run replay-gateway -- <session.ndjson.gz> 8080 <cpu_ghz> --symbol=BTC --loop`. Use the TSC frequency recorded with that capture.

## Railway deployment

`railway.json` runs `npm run build` and starts `scripts/start-railway.mjs`. Configure Railway with this directory as the service root. Set `PORT`, `CORS_ORIGIN`, `SYMBOLS`, and `DATABASE_URL` in the service settings. The start script creates the relay and launches one Neon-backed replay worker per symbol when both `DATABASE_URL` and `SYMBOLS` are set. Without them, the relay waits for a gateway on `/ingest`.

Use `INGEST_TOKEN` to protect `/ingest`; set the same value for the gateway or replay sender. Set `CORS_ORIGIN` to the Vercel dashboard origin. Keep `DATABASE_URL` and `INGEST_TOKEN` in the provider's secret settings, not in Git. The browser only needs the public relay base URL through `NEXT_PUBLIC_RELAY_URL` in the web app.

## Neon tick storage

[`scripts/schema.sql`](scripts/schema.sql) creates `sessions` and `ticks`. The migration script imports a gateway export while preserving the original record order. `replay-gateway-neon.mjs` loads one session for a symbol from Neon at startup and streams it to `/ingest` at the capture's pace. The replay then runs from memory; Neon is not queried for every tick.

For local migration, set `DATABASE_URL` in your shell and run:

```bash
node scripts/migrate-to-neon.mjs <session.ndjson.gz> --symbol=BTC --cpu-ghz=<capture_frequency>
```

The Railway worker selects the latest stored session for each configured symbol and loops it. Keep the `.ndjson.gz` capture as the source archive; Neon is the queryable replay store.

## Limits

Latency aggregates are held in relay memory for a rolling one-hour window and reset when Railway restarts the relay. Captured tick sessions persist in Neon. The relay does not terminate TLS itself; the public deployment relies on Railway's HTTPS/WSS endpoint.
