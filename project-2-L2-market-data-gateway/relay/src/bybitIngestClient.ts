import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { DataSource, DataSourceEvents } from "./dataSource.js";
import { isHelloMessage, isIngestRecord } from "./types.js";

// Default calibrated TSC frequency, used until a real hello handshake
// arrives. Matches the existing default in analysis/reader.py and
// analysis/export_summary.py — same gap (the gateway never persists its
// calibrate_tsc_ghz() result anywhere durable), same fallback value, kept
// consistent across all three languages that now need it.
const DEFAULT_CPU_GHZ = 3.2;

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_MISSED_PONGS = 2; // dead after 30s of silence

// Receives data pushed from our own gateway over its outbound connection.
// Does NOT talk to Bybit directly — the name is a holdover from what this
// feed conceptually represents (Bybit market data), not a description of
// what this class connects to.
//
// Role reversal vs. a typical "ingest client": the GATEWAY is the one that
// makes the outbound connection (it's the ephemeral, per-session process);
// this relay is the always-on side, so it runs the WebSocket *server* for
// this one upstream connection. handleConnection() is called by the
// composition root (index.ts) whenever a new connection arrives on the
// ingest path — this class doesn't own HTTP routing.
//
// Reconnect contract (see Phase 6 explanation): only one upstream connection
// is considered current at a time. If a new one arrives while an old one is
// still technically open, the old one is closed immediately — always trust
// the newest connection. Liveness is judged by a ping/pong heartbeat, not
// merely "is a socket open", since a half-dead TCP connection can look open
// while delivering nothing. The (not yet built) gateway-side push client
// should reconnect with the same backoff already used for the Bybit feed in
// ws_client.hpp: 1s base delay, x2 multiplier, 30s cap.
export class BybitIngestClient extends EventEmitter implements DataSource {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private lastCpuGhz = DEFAULT_CPU_GHZ;

  // ingestToken: when set (INGEST_TOKEN env var in production — see
  // relay/README.md), a connecting client must prove it knows this value in
  // its hello message before it's treated as the upstream gateway. Without
  // this, /ingest is open to anyone who finds the URL, who could otherwise
  // inject arbitrary fake market data to every connected viewer. undefined
  // (the local-dev default) preserves the original open behavior exactly.
  constructor(private readonly ingestToken?: string) {
    super();
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  cpuGhz(): number {
    return this.lastCpuGhz;
  }

  handleConnection(ws: WebSocket): void {
    if (!this.ingestToken) {
      this.promote(ws);
      ws.on("message", (data) => this.handleMessage(data));
      ws.on("close", () => this.handleDisconnect(ws));
      ws.on("error", () => this.handleDisconnect(ws));
      return;
    }

    // Token required: this connection is on PROBATION until its first
    // message proves itself a hello with a matching token — it must not
    // supersede the current upstream connection before then (see promote()),
    // or any client could disconnect the real gateway just by opening a
    // socket, without ever needing to know the token.
    ws.on("error", () => {}); // swallow — a rejected/never-authenticated socket has no disconnect handler to run
    ws.once("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        ws.terminate();
        return;
      }
      if (!isHelloMessage(parsed) || parsed.token !== this.ingestToken) {
        ws.terminate();
        return;
      }

      this.promote(ws);
      this.lastCpuGhz = parsed.cpu_ghz;
      this.emit("connected", { cpuGhz: this.lastCpuGhz });

      ws.on("message", (data2) => this.handleMessage(data2));
      // "close" always follows "error" for a ws connection, so relying on
      // just this is sufficient now that this socket is promoted — the
      // swallow-error listener registered above stays attached too
      // (harmless no-op alongside this).
      ws.on("close", () => this.handleDisconnect(ws));
    });
  }

  private promote(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) {
      // A fresh connection supersedes whatever we had — close the old one
      // rather than letting two upstream feeds coexist and double-deliver.
      this.socket.terminate();
    }
    this.socket = ws;
    this.missedPongs = 0;
    this.startHeartbeat(ws);
    ws.on("pong", () => {
      this.missedPongs = 0;
    });
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return; // malformed line — drop it, don't crash the ingest path over one bad message
    }

    if (isHelloMessage(parsed)) {
      this.lastCpuGhz = parsed.cpu_ghz;
      this.emit("connected", { cpuGhz: this.lastCpuGhz });
      return;
    }

    if (isIngestRecord(parsed)) {
      this.emit("record", parsed);
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        ws.terminate(); // triggers "close" -> handleDisconnect
        return;
      }
      this.missedPongs++;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private handleDisconnect(ws: WebSocket): void {
    if (this.socket !== ws) return; // a newer connection already replaced this one
    this.socket = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.emit("disconnected");
  }

  override on<K extends keyof DataSourceEvents>(event: K, listener: DataSourceEvents[K]): this {
    return super.on(event, listener);
  }

  override off<K extends keyof DataSourceEvents>(event: K, listener: DataSourceEvents[K]): this {
    return super.off(event, listener);
  }
}
