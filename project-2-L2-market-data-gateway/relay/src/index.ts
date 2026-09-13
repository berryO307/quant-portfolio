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

const PORT = Number(process.env.PORT ?? 8080);
const STATS_BROADCAST_INTERVAL_MS = 1_000; // same cadence as the Phase 3 terminal progress view

const ingestClient = new BybitIngestClient();
const connections = new ConnectionManager();
const broadcaster = new Broadcaster(ingestClient, connections);
const rollingStats = new RollingStatsAggregator(ingestClient);
const health = new HealthMonitor(ingestClient);
void broadcaster; // constructed for its side effect (subscribing to the source); no further use here

const httpServer = createServer((req, res) => {
  // The browser client (web/) polls /health and /stats directly from a
  // different origin (its own Vercel domain vs. wherever this relay is
  // hosted) — CORS must be open for that GET to succeed at all. Read-only,
  // unauthenticated endpoints, so allowing any origin is fine here.
  res.setHeader("Access-Control-Allow-Origin", "*");

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
      }
    });
    return;
  }

  socket.destroy();
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
