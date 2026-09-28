# L2 Gateway Relay

The only 24/7 piece of this system. Receives data pushed from the C++ gateway (an ephemeral, per-session process) over a single upstream WebSocket connection, fans it out to any number of browser clients, and maintains a 12-hour rolling latency view that survives gateway restarts. See the root [README](../README.md#the-full-observability-stack) for how this fits into the rest of the pipeline.

## Local development

```bash
npm install
npm run dev              # starts the relay on :8080
npm run fake-gateway      # in a second terminal — simulates the C++ gateway's push connection
```

`scripts/fake-gateway.mjs` speaks the exact same wire protocol a real gateway push client would (hello handshake, then sample/snapshot/trade records) — it's what the [web viewer](../web/README.md) can be developed against without running the full C++ capture stack. Pass a port as an argument (`npm run fake-gateway -- 8091`) to match a relay started on a non-default port, and set `INGEST_TOKEN` to match if the relay is running with one configured (see below).

### Replaying a real captured session

`scripts/replay-gateway.mjs` is `fake-gateway.mjs`'s counterpart for real data: it reads a session the C++ gateway actually captured (`data/export/session_*.ndjson.gz`, written by `ColdPathExporter` — see `include/export_pipeline.hpp`) and streams it to `/ingest` at real-time pace, so the web viewer shows genuine captured market activity instead of synthetic data, with no changes needed anywhere else in the pipeline (the exported record shapes already match the wire protocol exactly).

```bash
npm run replay-gateway -- ../data/export/session_<timestamp>.ndjson.gz 8080 <cpu_ghz> --symbol=<SYM> --loop
```

`<cpu_ghz>` must be the value the *capture itself* printed at startup (`Calibrated Host TSC Frequency: X GHz`) — every stage-latency number downstream depends on converting that specific session's raw TSC deltas with the frequency they were actually recorded at, not a guessed or default one.

`--symbol=<SYM>` is required (e.g. `--symbol=BTC` or `--symbol=xyz:CL`) — a session filename encodes a capture *timestamp*, never an instrument, so unlike the timestamp there's no honest value to fall back to if it's omitted. Stamped onto the hello handshake and onto every replayed record (see `relay/src/types.ts`'s `symbol` field) so the wire format is self-describing regardless of which port it arrived on.

Without `--loop`, this does exactly one real-time pass through the file and then disconnects (matching a real gateway session ending) — for a 3-minute capture, that means the web viewer shows "Live feed unavailable" again after 3 real minutes, with nothing wrong. `--loop` re-runs the same pass indefinitely instead (re-sending the same `hello` each time, the same way a real gateway reconnecting would), which is almost always what you actually want for a standing local data source.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | The port this process listens on — both the `/ingest` WebSocket the gateway connects to and the `/live`, `/health`, `/stats` endpoints the web viewer uses. This *is* "the gateway connection address": combined with the host's public IP, `ws://<host>:<PORT>/ingest` (or `wss://` behind a TLS-terminating proxy) is what a gateway-side push client needs to be configured to connect to. |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` on `/health` and `/stats`, which the browser polls cross-origin. Defaults open for local dev; **set this to your deployed web app's exact origin in production** (e.g. `https://your-app.vercel.app`) so other sites can't read these endpoints from a visitor's browser. |
| `MAX_CLIENTS` | `500` | Concurrent `/live` browser-client cap enforced by `ConnectionManager`. A connection beyond this is closed immediately with code `1013` ("try again later"). Raise this if you expect more concurrent viewers than that; the per-client cost is small (a `Set` entry plus whatever's still in its send buffer). |
| `INGEST_TOKEN` | unset (open) | Shared secret the gateway's hello handshake must include (`{"type":"hello","cpu_ghz":...,"token":"..."}`) before its connection is treated as the upstream feed. **Strongly recommended for any deployment reachable from the public internet** — without it, anyone who finds the relay's URL can connect to `/ingest` and push arbitrary fake market data to every connected viewer. Leaving it unset preserves the original open behavior, which is fine for local dev but not for production. |
| `DATABASE_URL` | unset | Neon Postgres connection string, used only by `migrate-to-neon.mjs` and `replay-gateway-neon.mjs` (see below) — the relay server itself (`src/index.ts`) never reads this. Use the **pooled** connection string from Neon's dashboard, not the direct one — see the Neon section below for why. Handle exactly like `INGEST_TOKEN`: set as a systemd `Environment=` line on the deployed unit, never committed. |

## Deploying to an always-on Linux host (Oracle Cloud Free Tier)

Oracle Cloud's Always Free tier includes an ARM-based Ampere A1 VM (up to 4 OCPUs / 24GB RAM, permanently free, not a trial) — comfortably enough for this relay, which holds at most 12 hours of bucketed histogram counts (a few MB) plus whatever's buffered per connected client.

1. **Provision the VM.** Oracle Cloud Console → Compute → Instances → Create Instance. Pick the Ampere A1 shape, Ubuntu 22.04 (or later) as the image, and open a security-list ingress rule for whatever port you'll run the relay on (see `PORT` above) in addition to the default SSH rule.
2. **Install Node.js** (v20+; this repo was built against v22+ — check with `node --version` after install):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
3. **Clone the repo and install dependencies:**
   ```bash
   git clone <this-repo-url>
   cd quant-command-center/project-2-L2-market-data-gateway/relay
   npm install
   npm run build     # compiles src/ to dist/ via tsc
   ```
4. **Set environment variables** and run. For a real deployment, generate a random token rather than typing one by hand:
   ```bash
   export PORT=8080
   export CORS_ORIGIN=https://your-app.vercel.app
   export MAX_CLIENTS=500
   export INGEST_TOKEN=$(openssl rand -hex 32)
   node dist/index.js
   ```
   Keep that `INGEST_TOKEN` value somewhere safe — it's what the C++ gateway's push client (a future phase; see the root README's roadmap) will need to be configured with to authenticate.
5. **Keep it running** across reboots and crashes with `systemd` rather than a bare `node` process. Example unit file at `/etc/systemd/system/l2-relay.service`:
   ```ini
   [Unit]
   Description=L2 Gateway Relay
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/home/ubuntu/quant-command-center/project-2-L2-market-data-gateway/relay
   ExecStart=/usr/bin/node dist/index.js
   Restart=on-failure
   Environment=PORT=8080
   Environment=CORS_ORIGIN=https://your-app.vercel.app
   Environment=MAX_CLIENTS=500
   Environment=INGEST_TOKEN=<the value from step 4>

   [Install]
   WantedBy=multi-user.target
   ```
   Then `sudo systemctl enable --now l2-relay`.
5a. **Replay mode**, if you're not running a live gateway against this relay
   (see the root [`README.md`](../README.md#known-limitations) and
   [`BUGS.md`](../BUGS.md) for why this project currently does this in
   production): `scripts/replay-gateway.mjs` connects to this relay's own
   `/ingest` endpoint like a real gateway would, replaying a captured
   `.ndjson.gz` session at real-time pace instead of live data. It parses
   the original capture's start time directly out of the session's own
   `session_<epoch_ms>.ndjson.gz` filename and sends it as `capturedAt` in
   the `hello` handshake, along with `isReplay: true` — both are what drive
   the web viewer's replay disclosure bar (`ReplayIndicator.tsx`). Example
   unit file at `/etc/systemd/system/replay.service`, run on the SAME host
   as `l2-relay` (the script's target is hardcoded to `localhost`) and only
   ever instead of a live gateway, never alongside one:
   ```ini
   [Unit]
   Description=Replay a real captured L2 session to l2-relay's own /ingest, looped
   After=network.target l2-relay.service
   Requires=l2-relay.service

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/quant-command-center/project-2-L2-market-data-gateway/relay
   ExecStart=/usr/bin/node scripts/replay-gateway.mjs /home/ubuntu/replay-data/session_<epoch_ms>.ndjson.gz 8080 <cpu_ghz> --loop
   Restart=on-failure
   RestartSec=5
   Environment=INGEST_TOKEN=<the same value l2-relay.service uses>

   [Install]
   WantedBy=multi-user.target
   ```
   Then `sudo systemctl enable --now replay`. If a live gateway (`l2-gateway`
   or similar) is already connected when this starts, stop it first —
   `/ingest` is meant for one upstream connection at a time.
6. **TLS.** The web viewer needs `wss://`/`https://`, not `ws://`/`http://`, once it's deployed on Vercel (mixed content is blocked by browsers). Put this relay behind a reverse proxy (Caddy is the simplest option — it handles Let's Encrypt certificates automatically) or a load balancer that terminates TLS, rather than trying to serve TLS from Node directly.
7. **Point the web app at it** — set `NEXT_PUBLIC_RELAY_WS_URL=wss://your-domain/live` and `NEXT_PUBLIC_RELAY_HEALTH_URL=https://your-domain/health` in the Vercel project (see [`web/README.md`](../web/README.md)).

## Tick data storage: Neon Postgres

With a second instrument (WTI, `xyz:CL`) now real alongside BTC, a growing set of captured `.ndjson.gz` session files needing to be individually `scp`'d to whichever host runs the replay stopped being the right long-term approach — Neon Postgres is the canonical, queryable replay source going forward. `scripts/schema.sql` has the full design rationale in its own comments; short version: a `sessions` table (one row per captured file — symbol, capture timestamp, calibrated `cpu_ghz`) and a `ticks` table (one row per exported record, mirroring `ExportRecord`'s own sample/snapshot/coarse_snapshot/trade tagged union directly, ordered by a `seq` column so the original interleaved arrival order comes back with a plain `ORDER BY seq`).

**The `.ndjson.gz` files are not replaced or deleted once loaded into Neon — they stay the durable cold backup and the only source `migrate-to-neon.mjs` ever reads from.** Neon is where a running `replay-gateway-neon.mjs` reads from; the files are what you'd re-run the migration against if the database were ever lost, wiped, or needed rebuilding with a schema change.

1. **Create the schema** (once, against a fresh database):
   ```bash
   psql "$DATABASE_URL" -f scripts/schema.sql
   ```
2. **Load a captured session:**
   ```bash
   DATABASE_URL=postgres://... npm run migrate-to-neon -- ../data/export/session_<timestamp>.ndjson.gz --symbol=<SYM> --cpu-ghz=<GHZ>
   ```
   Safe to re-run against the same file — `sessions` is keyed `UNIQUE(symbol, captured_at_ms)`, so a repeat load replaces that session's `ticks` rows rather than duplicating them.
3. **Replay from Neon instead of a file:**
   ```bash
   DATABASE_URL=postgres://... npm run replay-gateway-neon -- --symbol=<SYM> 8080 --loop
   ```
   Picks the most recent session loaded for that symbol. Same wire protocol, same pacing logic, same `--loop` behavior as the file-based `replay-gateway.mjs` — the only difference is where the tick data comes from.

**Driver choice matters here.** `migrate-to-neon.mjs` is a short-lived batch job — a plain `pg` `Client` (one connection, a batch of inserts, exit) is the right tool, with no connection-lifecycle concerns worth solving for a process that finishes in seconds. `replay-gateway-neon.mjs` is different: it's meant to run under systemd indefinitely, and Neon's free tier autosuspends its compute endpoint after a period of inactivity — a persistent connection would need its own reconnect-on-idle handling to survive that reliably. Rather than building that, `replay-gateway-neon.mjs` uses `@neondatabase/serverless`'s HTTP driver and loads an entire session into memory in **one** query at startup, exactly like the file-based script reads its whole file up front. After that single query, the real-time pacing loop runs purely from memory for the rest of the process's life — Neon can autosuspend at any point after startup without affecting a running replay at all.

**Does this replace the flat-file approach entirely?** No, by design — see above. The files are the origin data (only the C++ gateway's `ColdPathExporter` produces them) and the safety net; Neon is the queryable, symbol-indexed read path an operational replay service actually wants, and one that no longer requires physically copying a file to whatever host is going to serve it.

**Status**: schema and both scripts are complete and syntax/type-checked, but not yet run against a real Neon database as of this writing — pending provisioning a Neon project and handing over its pooled connection string. `replay.service`/`replay-wti.service` deployment against Neon (rather than the current file-based `replay.service` on `l2-relay`) is a followup once that's in hand.

## What this service does *not* do

No persistence across its own restarts (the 12-hour rolling stats are in-memory only — a relay restart loses that history, though a reconnecting gateway resumes immediately), no authentication on `/live` or `/health` (they're read-only and rate-limited only by `MAX_CLIENTS`), no TLS termination (put a reverse proxy in front for that).
