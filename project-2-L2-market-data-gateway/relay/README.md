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
npm run replay-gateway -- ../data/export/session_<timestamp>.ndjson.gz 8080 <cpu_ghz> --loop
```

`<cpu_ghz>` must be the value the *capture itself* printed at startup (`Calibrated Host TSC Frequency: X GHz`) — every stage-latency number downstream depends on converting that specific session's raw TSC deltas with the frequency they were actually recorded at, not a guessed or default one.

Without `--loop`, this does exactly one real-time pass through the file and then disconnects (matching a real gateway session ending) — for a 3-minute capture, that means the web viewer shows "Live feed unavailable" again after 3 real minutes, with nothing wrong. `--loop` re-runs the same pass indefinitely instead (re-sending the same `hello` each time, the same way a real gateway reconnecting would), which is almost always what you actually want for a standing local data source.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | The port this process listens on — both the `/ingest` WebSocket the gateway connects to and the `/live`, `/health`, `/stats` endpoints the web viewer uses. This *is* "the gateway connection address": combined with the host's public IP, `ws://<host>:<PORT>/ingest` (or `wss://` behind a TLS-terminating proxy) is what a gateway-side push client needs to be configured to connect to. |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` on `/health` and `/stats`, which the browser polls cross-origin. Defaults open for local dev; **set this to your deployed web app's exact origin in production** (e.g. `https://your-app.vercel.app`) so other sites can't read these endpoints from a visitor's browser. |
| `MAX_CLIENTS` | `500` | Concurrent `/live` browser-client cap enforced by `ConnectionManager`. A connection beyond this is closed immediately with code `1013` ("try again later"). Raise this if you expect more concurrent viewers than that; the per-client cost is small (a `Set` entry plus whatever's still in its send buffer). |
| `INGEST_TOKEN` | unset (open) | Shared secret the gateway's hello handshake must include (`{"type":"hello","cpu_ghz":...,"token":"..."}`) before its connection is treated as the upstream feed. **Strongly recommended for any deployment reachable from the public internet** — without it, anyone who finds the relay's URL can connect to `/ingest` and push arbitrary fake market data to every connected viewer. Leaving it unset preserves the original open behavior, which is fine for local dev but not for production. |

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
6. **TLS.** The web viewer needs `wss://`/`https://`, not `ws://`/`http://`, once it's deployed on Vercel (mixed content is blocked by browsers). Put this relay behind a reverse proxy (Caddy is the simplest option — it handles Let's Encrypt certificates automatically) or a load balancer that terminates TLS, rather than trying to serve TLS from Node directly.
7. **Point the web app at it** — set `NEXT_PUBLIC_RELAY_WS_URL=wss://your-domain/live` and `NEXT_PUBLIC_RELAY_HEALTH_URL=https://your-domain/health` in the Vercel project (see [`web/README.md`](../web/README.md)).

## What this service does *not* do

No persistence across its own restarts (the 12-hour rolling stats are in-memory only — a relay restart loses that history, though a reconnecting gateway resumes immediately), no authentication on `/live` or `/health` (they're read-only and rate-limited only by `MAX_CLIENTS`), no TLS termination (put a reverse proxy in front for that).
