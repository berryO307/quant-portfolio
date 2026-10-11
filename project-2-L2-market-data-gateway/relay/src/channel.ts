import type { WebSocket } from "ws";
import { BybitIngestClient } from "./bybitIngestClient.js";
import { ConnectionManager } from "./connectionManager.js";
import { Broadcaster } from "./broadcaster.js";
import { RollingStatsAggregator } from "./rollingStatsAggregator.js";
import { HealthMonitor } from "./healthMonitor.js";

// Everything the relay keeps for ONE instrument: its upstream connection,
// its browser clients, its snapshot cache and its latency stats. Before
// multi-instrument support these five objects were module-level singletons
// in index.ts, which is why one relay process could only ever serve one
// instrument. Bundling them per symbol means a new instrument costs a few
// objects in a Map, not another process, port and deployment.
//
// Nothing inside these classes changed for this: each already depended
// only on the abstract DataSource interface, so giving every channel its
// own source was enough to isolate instruments from each other.
export class Channel {
  readonly source = new BybitIngestClient();
  readonly clients: ConnectionManager;
  readonly broadcaster: Broadcaster;
  readonly stats: RollingStatsAggregator;
  readonly health: HealthMonitor;

  constructor(readonly symbol: string, maxClients: number) {
    this.clients = new ConnectionManager(maxClients);
    this.broadcaster = new Broadcaster(this.source, this.clients);
    this.stats = new RollingStatsAggregator(this.source);
    this.health = new HealthMonitor(this.source);

    // Re-send hello to this channel's viewers when its upstream
    // (re)connects, so a viewer already open picks up a new cpu_ghz or a
    // replay pass restarting.
    this.source.on("connected", () => this.clients.broadcast(this.helloPayload()));
  }

  helloPayload(): string {
    return JSON.stringify({
      type: "hello",
      cpu_ghz: this.source.cpuGhz(),
      capturedAt: this.source.capturedAt(),
      isReplay: this.source.isReplay(),
      symbol: this.symbol,
    });
  }

  // A new viewer gets hello (needed to convert TSC fields to ns) and the
  // latest cached snapshots straight away, instead of waiting for the
  // upstream's next ones -- for a replay that wait is unbounded (see
  // Broadcaster's comment).
  addViewer(ws: WebSocket): void {
    ws.send(this.helloPayload());
    for (const payload of this.broadcaster.latestSnapshotPayloads()) ws.send(payload);
    // The retained latency history, once. From here on the viewer only
    // gets stats_update deltas (see the stats timer in server.ts).
    ws.send(JSON.stringify(this.stats.fullMessage()));
  }

  summary() {
    return {
      symbol: this.symbol,
      upstreamConnected: this.source.isConnected(),
      isReplay: this.source.isReplay(),
      capturedAt: this.source.capturedAt(),
      viewers: this.clients.size,
      // Messages not sent to a viewer because its connection was backed up
      // (ConnectionManager's slow-client guard). Should stay at or near 0;
      // a climbing number means viewers are missing trades and books.
      droppedToSlowViewers: this.clients.droppedMessageCount,
    };
  }
}

// Channels keyed by symbol.
//
// Who may CREATE a channel is the security-relevant decision. Only an
// authenticated upstream (ingest) or the operator's SYMBOLS list can. If a
// browser could create one just by asking for /live?symbol=<anything>, any
// visitor could grow this Map without bound. maxChannels caps it anyway, as
// a backstop against a misbehaving (but authenticated) source.
export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  constructor(
    private readonly maxClients: number,
    private readonly maxChannels: number
  ) {}

  get(symbol: string): Channel | undefined {
    return this.channels.get(symbol);
  }

  /** Returns undefined when the channel cap is reached. */
  getOrCreate(symbol: string): Channel | undefined {
    const existing = this.channels.get(symbol);
    if (existing) return existing;
    if (this.channels.size >= this.maxChannels) return undefined;
    const channel = new Channel(symbol, this.maxClients);
    this.channels.set(symbol, channel);
    return channel;
  }

  all(): Channel[] {
    return [...this.channels.values()];
  }

  /** Viewers across every channel -- MAX_CLIENTS is one global budget, so
   * adding instruments doesn't multiply the relay's connection limit. */
  totalViewers(): number {
    let n = 0;
    for (const c of this.channels.values()) n += c.clients.size;
    return n;
  }
}
