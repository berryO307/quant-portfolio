# Web Dashboard

Next.js client dashboard for the L2 gateway. It connects from the browser to the relay's WebSocket feed and health endpoint; the web app has no persistent backend of its own.

**Public dashboard:** [l2-orderbook-gateway.vercel.app](https://l2-orderbook-gateway.vercel.app/)

## Local development

```bash
npm install
# Copy .env.example to .env.local; the local default is http://localhost:8080.
npm run dev
```

Open `http://localhost:3000`. Start the relay and a fake gateway in separate terminals for sample data; see the [relay README](../relay/README.md#local-development).

## Relay configuration

Set `NEXT_PUBLIC_RELAY_URL` to the relay base URL, without a trailing slash. The app derives the WebSocket and health URLs from it. The default in `.env.example` is `http://localhost:8080`; production uses the Railway relay's HTTPS URL so the browser connects with WSS.

This value is public and must not contain a credential. The gateway ingest token and Neon connection string belong only in the Railway service settings.

## Deployment

Vercel serves this Next.js app from the `project-2-L2-market-data-gateway/web` directory. Set `NEXT_PUBLIC_RELAY_URL` to the Railway relay's public base URL. Set `CORS_ORIGIN` on Railway to the dashboard origin.

The dashboard includes an L2 ladder, depth curve, trades tape, ECharts latency views, and an explicit Live/Replay selector. Feed mode is confirmed from the relay handshake per instrument. When the selected mode is unavailable, the UI shows an unavailable state rather than displaying the other mode's data.

The public Railway service currently streams replayed sessions loaded from Neon. The C++ gateway's live push path remains available, but the Railway deployment does not run the native gateway process. See the [gateway README](../README.md#known-limitations) for the measurement context and system diagram.
