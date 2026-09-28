# L2 Gateway Web Viewer

Next.js app (App Router, TypeScript, Tailwind) showing the live L2 order book ladder, depth curve, trades tape, and latency panel with tail-event drill-down. Connects **directly from the browser** to the [relay](../relay/README.md)'s WebSocket feed and `/health` endpoint — this app has no backend of its own and needs none, since the relay is the always-on piece (see the root [README](../README.md#the-full-observability-stack)).

## Local development

```bash
npm install
cp .env.example .env.local   # point at your local relay (see below), or leave the defaults
npm run dev
```

Open http://localhost:3000. To see live data, also run the relay and its fake-gateway dev utility (see [`relay/README.md`](../relay/README.md#local-development)) — the web app works against any relay instance, local or deployed.

## Environment variables

All three are read at build/runtime by the browser bundle, so they must be prefixed `NEXT_PUBLIC_` and are **not secret** — anyone can read them from the page source. Don't put the relay's `INGEST_TOKEN` here; that's a gateway→relay secret, this app never needs it.

| Variable | Default (local dev) | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_RELAY_WS_URL` | `ws://localhost:8080/live` | The relay's browser-facing WebSocket endpoint for the FIRST instrument dropdown entry (BTC via Hyperliquid) only. Use `wss://` for a production relay behind TLS. |
| `NEXT_PUBLIC_RELAY_HEALTH_URL` | `http://localhost:8080/health` | Matching health endpoint, polled every 5s by `FeedStatusBanner`. |

The rest of the instrument dropdown (`lib/instruments.ts`) targets fixed
localhost ports (8081-8086), not individually env-overridable — this is a
local multi-instrument dev/demo tool, not a deployment with N configurable
prod endpoints. Each entry needs its own `quant_day1.exe <symbol>` + relay
pair running on its assigned port before its dropdown entry shows live
data; an instrument whose gateway isn't running just shows the existing
"feed unavailable" state. Each instrument also carries its own 24h-change figure (Hyperliquid's
`metaAndAssetCtxs` markPx/prevDayPx — see `lib/use24hChange.ts`; Bybit
support, including its REST ticker, was removed entirely) and its own
display decimal precision (`priceDecimals`/`qtyDecimals`). The wire
protocol's `hello` handshake now carries an optional `symbol` field (see
`relay/src/types.ts`) that `useRelayConnection` compares against the
selected instrument's own configured symbol — a mismatch (e.g. WTI's
port accidentally serving BTC data) surfaces as a dedicated
`FeedStatusBanner` warning and a console log, instead of silently
mislabeling every number on screen. This doesn't remove the need to keep
`lib/instruments.ts` in sync with whichever gateway/relay process is
actually feeding each port — it just means a mistake there is now
visible rather than silent.

## Deploying to Vercel

1. Import this repository into Vercel, setting **Root Directory** to `project-2-L2-market-data-gateway/web` (this is a monorepo — Vercel needs to know the Next.js app isn't at the repo root).
2. Vercel auto-detects the Next.js framework preset; no build command changes needed.
3. In the project's Environment Variables settings, set `NEXT_PUBLIC_RELAY_WS_URL` and `NEXT_PUBLIC_RELAY_HEALTH_URL` to your deployed relay's public address (e.g. `wss://relay.example.com/live` and `https://relay.example.com/health` — see [`relay/README.md`](../relay/README.md) for standing that up on Oracle Cloud Free Tier).
4. On the relay side, set `CORS_ORIGIN` to this Vercel deployment's exact origin (e.g. `https://your-app.vercel.app`) once you know it, rather than leaving the relay's default `*` open to any site.
5. Deploy. No `vercel.json` is required — the defaults (Node.js runtime, automatic HTTPS, preview deployments per branch) are exactly what this static/client-only app needs.

## The public deployment currently serves a replay, not a live feed

`LiveReplayToggle.tsx` (superseding the older, passive `ReplayIndicator.tsx`) lets a viewer explicitly pick Live or Replay and shows which one the connected relay's `hello` handshake actually confirms (`capturedAt`/`isReplay` in `HelloMessage`, see `lib/types.ts`) — explicit, never inferred, so a future real-live deployment needs no special-casing here. Selecting a mode the relay isn't currently serving shows a calm "coming soon" / "no replayed session available" card in place of the data view (`FeedModeUnavailable.tsx`) rather than silently falling back to the other mode's data mislabeled as the one you picked. The default follows whatever the relay actually is, so a first-time visitor never lands on that card by default.

Architecture note: this is a state-reflecting toggle, not a dual-upstream relay — `relay/src/index.ts`'s ingest path (`BybitIngestClient`) only ever tracks one upstream connection at a time (a new one supersedes the old, the same mechanism behind the `l2-gateway`-vs-`replay.service` collision documented in `BUGS.md`), so the toggle requests a preference and reflects reality rather than the relay actually carrying both a live and a replay feed simultaneously.

The deployed instance currently only has `replay.service` running (no live upstream) — the public relay (`l2-relay`) is fed by `relay/scripts/replay-gateway.mjs --loop`, looping a real BTC session captured on desktop hardware, not a live Oracle Cloud gateway. Why: the original live cloud deployment's queue-stage tail latency (P99/P99.9 in the tens of milliseconds on a shared-vCPU free-tier instance) was investigated and root-caused rather than assumed — see the project's [`BUGS.md`](../BUGS.md) for the full methodology (ruling out hypervisor steal and swap with real correlated measurement, the `SCHED_FIFO` fix that got a real ~285x improvement, and why the residual tail is a hardware ceiling, not a code problem). The fix was to move real capture to native desktop hardware and serve that honestly-labeled replay to the public deployment instead of chasing a latency floor no affordable shared-vCPU tier can clear.

A dedicated always-on home server (an old PC, bought cheaply) is the intended eventual replacement for this replay pipeline — deferred, not funded or scheduled yet, and for project-demonstration purposes specifically. Real constraints apply if/when that happens: ongoing electricity cost, and a stable public-reachability path (port forwarding or a CGNAT workaround) that doesn't exist today.

**Per-instrument, not global.** Each instrument connects to its own relay (`lib/instruments.ts`), so `capturedAt`/`isReplay` are per-connection state, not app-wide — switching the instrument dropdown correctly shows that instrument's *own* original capture date, not whatever the previously-selected instrument had (verified live: switching from BTC to WTI updates the banner from BTC's capture time to WTI's own, with no stale value shown in between). WTI (`xyz:CL`) has its own short desktop capture ready the same way BTC's is, but isn't wired to a public relay/port yet — see the root [README](../README.md#known-limitations) for its status and the plan to serve both instruments' tick data from Neon Postgres instead of per-instrument files.

## What this app does *not* do

No replay fallback, no server-side data fetching, no API routes. If the relay is unreachable, `FeedStatusBanner` is the only thing that tells you — the rest of the dashboard just shows its own empty/waiting states, deliberately, rather than pretending to have data it doesn't.
