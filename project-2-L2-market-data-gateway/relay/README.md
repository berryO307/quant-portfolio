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

`EGRESS_BUDGET_MB_PER_DAY` (default `1024`) caps what the relay sends to viewers per UTC day. Railway bills egress at $0.05/GB, so the default bounds egress at about $0.05 a day whatever goes wrong; once it is spent, viewers are disconnected with close code 1013 and refused until the next UTC day. `GET /health` reports `egress.sentTodayMB` against `egress.budgetMB`. Set `0` only on unmetered hosting. The relay counts the bytes actually written to each viewer's socket (after compression, frame headers included) once a second, so the cap can be overshot by at most one second of traffic; TLS overhead added by Railway's edge is not counted.

What a viewer costs: `/live` negotiates permessage-deflate (standard WebSocket compression, automatic in browsers; the compressor keeps its window between messages, so even a ~70-byte trade goes out as ~14 bytes), raw per-tick `sample` records stay inside the relay (they feed the stats; the overflow counter they carried is in the stats messages), and stats messages carry only the latency buckets that changed. Measured on the wire, replaying the same recorded hour: BTC 0.56 KB/s and WTI 0.47 KB/s per viewer, about 2 MB per viewer-hour. Dashboards also disconnect a tab that has been hidden for 60 seconds.

Measured idle cost of the Railway service (relay plus two replay workers replaying one-hour sessions, nobody connected): about 222 MB of RAM and 0.002 vCPU, roughly $2.20 a month at Railway's $10/GB-month RAM price, inside the Hobby plan's included $5. Replay memory scales with session length (an 8-hour BTC session needed 144 MB for its worker; a one-hour session needs 77 MB), so keep replay sessions short. The rolling latency history adds about 3 MB for a full hour across both instruments: only the current 10-second bucket keeps full histograms, and finished buckets are kept as their serialized JSON, which is also what a connecting viewer receives (assembled in ~0.3 ms rather than rebuilt). Each connected viewer adds roughly 150 KB (WebSocket compressor state and buffers). Load-test results for 100–500 viewers are in the [project README](../README.md#hosting-cost-and-scale).

## Neon tick storage

[`scripts/schema.sql`](scripts/schema.sql) creates `sessions` and `ticks`. The migration script imports a gateway export while preserving the original record order. `replay-gateway-neon.mjs` loads one session for a symbol from Neon at startup and streams it to `/ingest` at the capture's pace. The replay then runs from memory; Neon is not queried for every tick.

For local migration, set `DATABASE_URL` in your shell and run:

```bash
node scripts/migrate-to-neon.mjs <session.ndjson.gz> --symbol=BTC --cpu-ghz=<capture_frequency> --replace
```

`--replace` deletes the symbol's other sessions in the same transaction once the load succeeds (a failed load deletes nothing), so Neon holds one session per symbol and does not grow with each refresh. The Railway worker selects the latest stored session for each configured symbol and loops it; it loads at startup, so restart or redeploy the service after uploading a new session. Keep the `.ndjson.gz` capture as the source archive; Neon is the queryable replay store.

## Limits

Latency aggregates are held in relay memory for a rolling one-hour window and reset when Railway restarts the relay. Captured tick sessions persist in Neon. The relay does not terminate TLS itself; the public deployment relies on Railway's HTTPS/WSS endpoint.
