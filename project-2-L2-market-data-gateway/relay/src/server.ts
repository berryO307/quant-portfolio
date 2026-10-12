import { createServer, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ChannelRegistry } from "./channel.js";
import type { CountedSocket } from "./connectionManager.js";
import { BUDGET_CLOSE_CODE, BUDGET_CLOSE_REASON, EgressBudget } from "./egressBudget.js";
import { isHelloMessage } from "./types.js";

export interface RelayConfig {
  /** Origins allowed to read /health, /stats, /symbols from a browser.
   * ["*"] allows any. */
  corsOrigins: string[];
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
  /** Hard cap on bytes sent to viewers per UTC day (see EgressBudget).
   * 0 or omitted = no cap. */
  egressBudgetMBPerDay?: number;
  /** How often viewer egress is collected and checked against the budget
   * (default 1000ms). */
  egressCheckMs?: number;
}

export interface Relay {
  server: Server;
  registry: ChannelRegistry;
  close(): Promise<void>;
}

// Hyperliquid coin names: "BTC", builder sub-dex coins like "xyz:CL".
// Bounded so a symbol can't be used to stuff arbitrary data into the Map.
export const SYMBOL_PATTERN = /^[A-Za-z0-9:_.-]{1,32}$/;


// One relay process, many instruments.
//
// Routing rule, the same for both sides of the relay:
//   - a DATA SOURCE names its instrument in its hello (first message) on
//     /ingest. Identity lives in the handshake, next to the token that
//     authenticates it, rather than in a URL anyone can type.
//   - a BROWSER names the instrument it wants in the query string:
//     /live?symbol=BTC, /health?symbol=BTC, /stats?symbol=BTC.
export function createRelay(config: RelayConfig): Relay {
  const budget = new EgressBudget(Math.max(0, config.egressBudgetMBPerDay ?? 0) * 1_048_576);
  const registry = new ChannelRegistry(config.maxClients, config.maxChannels, budget);

  // HTTP bodies are egress too. Recorded, never refused here: health
  // responses are a few hundred bytes and the dashboard needs them to say
  // WHY it has no data. /stats, the one large body, checks the budget
  // itself below.
  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    sendJsonText(res, status, JSON.stringify(body));
  }
  function sendJsonText(res: ServerResponse, status: number, text: string): void {
    budget.record(Buffer.byteLength(text));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }
  for (const symbol of config.symbols) registry.getOrCreate(symbol);

  const server = createServer((req, res) => {
    // Browsers call /health and /stats cross-origin (Vercel domain -> relay
    // domain). Access-Control-Allow-Origin can carry only ONE origin, so for
    // an allowlist (production site + local dev) the relay echoes the
    // request's own Origin when it's on the list. Vary: Origin stops a cache
    // from serving one origin's allowed response to another.
    if (config.corsOrigins.includes("*")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

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
            egress: budget.summary(),
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
        if (budget.exhausted()) {
          sendJson(res, 503, { error: BUDGET_CLOSE_REASON, egress: budget.summary() });
          return;
        }
        sendJsonText(res, 200, channel.stats.fullMessageJson()); // same body a new viewer gets as stats_full
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

  // Viewers (/live) get their own server with permessage-deflate: the
  // standard WebSocket compression every browser negotiates by itself, no
  // client code involved. The stream is JSON numbers with repeated keys,
  // and egress is billed per byte. Kept off /ingest (`wss` above): data
  // sources are on localhost or the operator's own link, ingress isn't
  // billed, and compressing there would only spend CPU.
  //
  // Bounded memory per viewer: a 4KB window (serverMaxWindowBits 12) and
  // memLevel 7 keep each viewer's compressor around 80KB. The compressor
  // keeps its window between messages (context takeover), so ws compresses
  // every message, and even small ones shrink a lot: measured, a ~70-byte
  // trade goes out as ~14 bytes once the compressor has seen a few.
  const wssLive = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: {
      zlibDeflateOptions: { memLevel: 7 },
      serverMaxWindowBits: 12,
    },
  });

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
      // Live beats replay. A newer feed normally supersedes the current one
      // (see BybitIngestClient.promote), but a replay is only a stand-in for
      // when no live gateway is running: it must not knock a live feed off.
      // The replay retries on its own and takes over again once the live
      // feed disconnects. A live hello still supersedes a replay at once.
      if (hello.isReplay && channel.source.isConnected() && !channel.source.isReplay()) {
        ws.close(1013, "live feed active");
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
      wssLive.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        // Upgrade first, then close with a reason: the reason shows up in
        // the browser's close event / devtools, where a refused HTTP
        // upgrade would only show a generic failure.
        if (!channel) {
          ws.close(1008, symbol === null ? "symbol query parameter required" : "unknown symbol");
          return;
        }
        if (budget.exhausted()) {
          ws.close(BUDGET_CLOSE_CODE, BUDGET_CLOSE_REASON);
          return;
        }
        if (registry.totalViewers() >= config.maxClients || !channel.clients.addClient(ws, socket as unknown as CountedSocket)) {
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
  //
  // Only what changed since the last tick (normally the one current 10s
  // bucket), sparse-encoded. This used to re-send the whole retained hour
  // every tick: 8.2MB per viewer per second, which overflowed every
  // viewer's connection and made the relay drop their trades and books.
  // A viewer gets the full history once, on connect (Channel.addViewer).
  // What viewers were actually sent (compressed, from their sockets), into
  // the daily budget. Once over, the next send to any viewer closes them all.
  const egressTimer = setInterval(() => {
    for (const channel of registry.all()) budget.record(channel.clients.takeEgressBytes());
  }, config.egressCheckMs ?? 1_000);

  const statsTimer = setInterval(() => {
    for (const channel of registry.all()) {
      if (channel.clients.size === 0) {
        channel.stats.clearUpdate();
        continue;
      }
      const update = channel.stats.takeUpdateJson();
      if (update) channel.clients.broadcast(update);
    }
  }, config.statsIntervalMs);

  return {
    server,
    registry,
    close: () =>
      new Promise((resolve) => {
        clearInterval(statsTimer);
        clearInterval(egressTimer);
        for (const ws of sockets) ws.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
