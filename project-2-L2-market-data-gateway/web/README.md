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
| `NEXT_PUBLIC_RELAY_WS_URL` | `ws://localhost:8080/live` | The relay's browser-facing WebSocket endpoint for the FIRST instrument dropdown entry (BTC/USDT via Bybit) only. Use `wss://` for a production relay behind TLS. |
| `NEXT_PUBLIC_RELAY_HEALTH_URL` | `http://localhost:8080/health` | Matching health endpoint, polled every 5s by `FeedStatusBanner`. |

The rest of the instrument dropdown (`lib/instruments.ts`) targets fixed
localhost ports (8081-8087), not individually env-overridable — this is a
local multi-instrument dev/demo tool, not a deployment with N configurable
prod endpoints. Each entry needs its own `quant_day1.exe --source=<bybit|
hyperliquid> <symbol>` + relay pair running on its assigned port before its
dropdown entry shows live data; an instrument whose gateway isn't running
just shows the existing "feed unavailable" state. Each instrument also
carries its own 24h-change data source (Bybit's public REST ticker, or
Hyperliquid's `metaAndAssetCtxs` markPx/prevDayPx — see `lib/use24hChange.ts`)
and its own display decimal precision (`priceDecimals`/`qtyDecimals`) — the
wire protocol itself carries no symbol field, so nothing in the pipeline
would catch a gateway/dropdown-entry mismatch; keep `lib/instruments.ts` in
sync with whichever gateway process is actually feeding each port.

## Deploying to Vercel

1. Import this repository into Vercel, setting **Root Directory** to `project-2-L2-market-data-gateway/web` (this is a monorepo — Vercel needs to know the Next.js app isn't at the repo root).
2. Vercel auto-detects the Next.js framework preset; no build command changes needed.
3. In the project's Environment Variables settings, set `NEXT_PUBLIC_RELAY_WS_URL` and `NEXT_PUBLIC_RELAY_HEALTH_URL` to your deployed relay's public address (e.g. `wss://relay.example.com/live` and `https://relay.example.com/health` — see [`relay/README.md`](../relay/README.md) for standing that up on Oracle Cloud Free Tier).
4. On the relay side, set `CORS_ORIGIN` to this Vercel deployment's exact origin (e.g. `https://your-app.vercel.app`) once you know it, rather than leaving the relay's default `*` open to any site.
5. Deploy. No `vercel.json` is required — the defaults (Node.js runtime, automatic HTTPS, preview deployments per branch) are exactly what this static/client-only app needs.

## What this app does *not* do

No replay fallback, no server-side data fetching, no API routes. If the relay is unreachable, `FeedStatusBanner` is the only thing that tells you — the rest of the dashboard just shows its own empty/waiting states, deliberately, rather than pretending to have data it doesn't.
