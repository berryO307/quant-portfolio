import type { IncomingMessage, ServerResponse } from "node:http";
import type { DataSource } from "./dataSource.js";

// GET /health — reports whether the upstream gateway connection is alive.
// "Alive" comes from DataSource.isConnected(), which for BybitIngestClient
// is heartbeat-based (see its ping/pong logic), not just "a socket object
// exists" — a half-dead TCP connection can look open while delivering
// nothing, and that should NOT report healthy.
export class HealthMonitor {
  constructor(private readonly source: DataSource) {}

  handle(_req: IncomingMessage, res: ServerResponse): void {
    const alive = this.source.isConnected();
    res.writeHead(alive ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: alive ? "ok" : "degraded",
      upstreamGatewayConnected: alive,
    }));
  }
}
