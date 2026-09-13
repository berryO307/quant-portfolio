import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { BybitIngestClient } from "./bybitIngestClient.js";
import { ConnectionManager } from "./connectionManager.js";
import { Broadcaster } from "./broadcaster.js";
import { RollingStatsAggregator } from "./rollingStatsAggregator.js";
import { HealthMonitor } from "./healthMonitor.js";

// Composition root — this is the only file that knows the concrete classes.
// Everything downstream of BybitIngestClient depends on the abstract
// DataSource interface (see dataSource.ts), so swapping the upstream feed
// only means changing what gets constructed here.

// See relay/README.md for the full deployment env var reference.
const PORT = Number(process.env.PORT ?? 8080);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS ?? 500);
const INGEST_TOKEN = process.env.INGEST_TOKEN; // undefined = open /ingest, matches local-dev default
const STATS_BROADCAST_INTERVAL_MS = 1_000; // same cadence as the Phase 3 terminal progress view

const ingestClient = new BybitIngestClient(INGEST_TOKEN);
const connections = new ConnectionManager(MAX_CLIENTS);
const broadcaster = new Broadcaster(ingestClient, connections);
const rollingStats = new RollingStatsAggregator(ingestClient);
const health = new HealthMonitor(ingestClient);
void broadcaster; // constructed for its side effect (subscribing to the source); no further use here

const httpServer = createServer((req, res) => {
  // The browser client (web/) polls /health and /stats directly from a
  // different origin (its own Vercel domain vs. wherever this relay is
  // hosted) — CORS must be open for that GET to succeed at all. Defaults to
  // "*" for local dev; set CORS_ORIGIN to the deployed web app's exact
  // origin in production to stop other sites from being able to read it.
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);

  if (req.url === "/health") {
    health.handle(req, res);
    return;
  }
  if (req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rollingStats.snapshot()));
    return;
  }
  res.writeHead(404);
  res.end();
});

// Two WS endpoints on one server: /ingest (the single upstream gateway
// connection) and /live (many browser clients). noServer + a manual
// "upgrade" router keeps this to one dependency (ws) with no framework.
const ingestWss = new WebSocketServer({ noServer: true });
const liveWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";

  if (url.startsWith("/ingest")) {
    ingestWss.handleUpgrade(req, socket, head, (ws) => {
      ingestClient.handleConnection(ws);
    });
    return;
  }

  if (url.startsWith("/live")) {
    liveWss.handleUpgrade(req, socket, head, (ws) => {
      if (!connections.addClient(ws)) {
        ws.close(1013, "relay at capacity");
        return;
      }
      // A newly-connected browser client needs cpu_ghz to convert any
      // SampleRecord's raw TSC fields into ns (see the hello handshake
      // contract in types.ts) — send it directly rather than making the
      // client wait for the next upstream gateway (re)connection.
      ws.send(JSON.stringify({ type: "hello", cpu_ghz: ingestClient.cpuGhz() }));
    });
    return;
  }

  socket.destroy();
});

// Rebroadcast the hello handshake to every browser client whenever the
// upstream gateway (re)connects, so clients already open pick up a changed
// cpu_ghz too, not just newly-connecting ones (handled above).
ingestClient.on("connected", ({ cpuGhz }) => {
  connections.broadcast(JSON.stringify({ type: "hello", cpu_ghz: cpuGhz }));
});

// Push the rolling/session stats snapshot to browser clients on the same
// cadence the Phase 3 terminal progress view used, so a live dashboard
// updates at a familiar rate without each client having to poll /stats.
setInterval(() => {
  connections.broadcast(JSON.stringify({ type: "stats", ...rollingStats.snapshot() }));
}, STATS_BROADCAST_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}  (ws: /ingest, /live · http: /health, /stats)`);
});
