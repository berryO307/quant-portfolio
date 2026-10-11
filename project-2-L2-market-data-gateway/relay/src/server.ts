import { createServer, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ChannelRegistry } from "./channel.js";
import { isHelloMessage } from "./types.js";

export interface RelayConfig {
  corsOrigin: string;
  /** Viewer cap across ALL instruments (one global budget). */
  maxClients: number;
  /** Backstop on how many instruments one relay will hold. */
  maxChannels: number;
  /** When set, an ingest hello must carry this token. */
  ingestToken?: string;
  /** Channels to create up front, so viewers can connect before their feed. */
  symbols: string[];
  statsIntervalMs: number;
  /** An ingest socket that hasn't sent its hello by then is dropped. */
  helloTimeoutMs: number;
}

export interface Relay {
  server: Server;
  registry: ChannelRegistry;
  close(): Promise<void>;
}

// Hyperliquid coin names: "BTC", builder sub-dex coins like "xyz:CL".
// Bounded so a symbol can't be used to stuff arbitrary data into the Map.
export const SYMBOL_PATTERN = /^[A-Za-z0-9:_.-]{1,32}$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// One relay process, many instruments.
//
// Routing rule, the same for both sides of the relay:
//   - a DATA SOURCE names its instrument in its hello (first message) on
//     /ingest. Identity lives in the handshake, next to the token that
//     authenticates it, rather than in a URL anyone can type.
//   - a BROWSER names the instrument it wants in the query string:
//     /live?symbol=BTC, /health?symbol=BTC, /stats?symbol=BTC.
export function createRelay(config: RelayConfig): Relay {
  const registry = new ChannelRegistry(config.maxClients, config.maxChannels);
  for (const symbol of config.symbols) registry.getOrCreate(symbol);

  const server = createServer((req, res) => {
    // Browsers call /health and /stats cross-origin (Vercel domain -> relay
    // domain); the deployed relay restricts this to the web app's origin.
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);

    const url = new URL(req.url ?? "/", "http://relay");
    const symbol = url.searchParams.get("symbol");

    switch (url.pathname) {
      case "/symbols":
        sendJson(res, 200, registry.all().map((c) => c.summary()));
        return;

      case "/health": {
        if (symbol === null) {
          // Whole relay: healthy only if every instrument has its feed.
          const channels = registry.all();
          const ok = channels.length > 0 && channels.every((c) => c.source.isConnected());
          sendJson(res, ok ? 200 : 503, {
            status: ok ? "ok" : "degraded",
            channels: Object.fromEntries(channels.map((c) => [c.symbol, c.source.isConnected()])),
          });
          return;
        }
        const channel = registry.get(symbol);
        if (!channel) {
          sendJson(res, 404, { status: "unknown_symbol", symbol });
          return;
        }
        channel.health.handle(req, res);
        return;
      }

      case "/stats": {
        const channel = symbol === null ? undefined : registry.get(symbol);
        if (!channel) {
          sendJson(res, symbol === null ? 400 : 404, {
            error: symbol === null ? "symbol query parameter required" : "unknown symbol",
            symbols: registry.all().map((c) => c.symbol),
          });
          return;
        }
        sendJson(res, 200, channel.stats.snapshot());
        return;
      }

      default:
        res.writeHead(404);
        res.end();
    }
  });

  // noServer: this file routes upgrades itself. clientTracking off: the
  // channels already track their own sockets.
  const wss = new WebSocketServer({ noServer: true, clientTracking: false });

  // Every upgraded socket, so close() can end them. An upgraded socket is
  // no longer one of the HTTP server's connections: server.close() alone
  // would wait on them forever, and each attached feed's heartbeat timer
  // would keep the process alive.
  // (Tracked in the upgrade callbacks: with noServer, handleUpgrade never
  // emits wss "connection".)
  const sockets = new Set<WebSocket>();
  function track(ws: WebSocket): void {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  }

  function acceptIngest(ws: WebSocket): void {
    ws.on("error", () => {}); // until attached, a failing socket has nothing to clean up
    const helloTimer = setTimeout(() => ws.terminate(), config.helloTimeoutMs);

    // The source stays unattached -- it can't displace a channel's current
    // feed or create a channel -- until its hello passes every check below.
    ws.once("message", (data) => {
      clearTimeout(helloTimer);
      let hello: unknown;
      try {
        hello = JSON.parse(String(data));
      } catch {
        ws.terminate();
        return;
      }
      if (!isHelloMessage(hello)) {
        ws.close(1008, "first message must be hello");
        return;
      }
      if (config.ingestToken && hello.token !== config.ingestToken) {
        ws.terminate(); // no reason given to an unauthenticated caller
        return;
      }
      if (typeof hello.symbol !== "string" || !SYMBOL_PATTERN.test(hello.symbol)) {
        ws.close(1008, "hello must declare a valid symbol");
        return;
      }
      const channel = registry.getOrCreate(hello.symbol);
      if (!channel) {
        ws.close(1013, "channel limit reached");
        return;
      }
      channel.source.attach(ws, hello);
    });
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");

    if (url.pathname === "/ingest") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        acceptIngest(ws);
      });
      return;
    }

    if (url.pathname === "/live") {
      const symbol = url.searchParams.get("symbol");
      const channel = symbol === null ? undefined : registry.get(symbol);
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        // Upgrade first, then close with a reason: the reason shows up in
        // the browser's close event / devtools, where a refused HTTP
        // upgrade would only show a generic failure.
        if (!channel) {
          ws.close(1008, symbol === null ? "symbol query parameter required" : "unknown symbol");
          return;
        }
        if (registry.totalViewers() >= config.maxClients || !channel.clients.addClient(ws)) {
          ws.close(1013, "relay at capacity");
          return;
        }
        channel.addViewer(ws);
      });
      return;
    }

    socket.destroy();
  });

  // Stats only for instruments someone is watching: building a snapshot
  // merges every retained histogram bucket, so with many instruments and
  // few viewers, skipping idle channels is most of the per-tick cost saved.
  const statsTimer = setInterval(() => {
    for (const channel of registry.all()) {
      if (channel.clients.size === 0) continue;
      channel.clients.broadcast(JSON.stringify({ type: "stats", ...channel.stats.snapshot() }));
    }
  }, config.statsIntervalMs);

  return {
    server,
    registry,
    close: () =>
      new Promise((resolve) => {
        clearInterval(statsTimer);
        for (const ws of sockets) ws.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
