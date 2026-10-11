import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { DataSource, DataSourceEvents } from "./dataSource.js";
import { isHelloMessage, isIngestRecord, type HelloMessage } from "./types.js";

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
// this one upstream connection. One instance exists per instrument (see
// channel.ts). attach() is called by the router (server.ts) only after it
// has read the connection's hello, checked its token, and used its symbol
// to pick this instance -- this class owns neither routing nor auth.
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
  private lastCapturedAt: number | undefined;
  private lastIsReplay = false;
  private lastSymbol: string | undefined;

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  cpuGhz(): number {
    return this.lastCpuGhz;
  }

  capturedAt(): number | undefined {
    return this.lastCapturedAt;
  }

  isReplay(): boolean {
    return this.lastIsReplay;
  }

  symbol(): string | undefined {
    return this.lastSymbol;
  }

  // `hello` is the connection's already-consumed first message, validated by
  // the router. Applying it here (rather than waiting for it as the first
  // "message") is what lets the router read it to choose the channel
  // without this class ever seeing the socket before that decision.
  attach(ws: WebSocket, hello: HelloMessage): void {
    this.promote(ws);
    this.applyHello(hello);
    ws.on("message", (data) => this.handleMessage(data));
    // "close" always follows "error" for a ws connection, so this is the
    // one disconnect path.
    ws.on("close", () => this.handleDisconnect(ws));
  }

  private applyHello(hello: HelloMessage): void {
    this.lastCpuGhz = hello.cpu_ghz;
    this.lastCapturedAt = hello.capturedAt;
    this.lastIsReplay = hello.isReplay ?? false;
    this.lastSymbol = hello.symbol;
    this.emit("connected", {
      cpuGhz: this.lastCpuGhz,
      capturedAt: this.lastCapturedAt,
      isReplay: this.lastIsReplay,
      symbol: this.lastSymbol,
    });
  }

  private promote(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) {
      // A fresh connection supersedes whatever we had — close the old one
      // rather than letting two upstream feeds coexist and double-deliver.
      this.socket.terminate();
    }
    // The old socket's close handler bails out (it's no longer
    // this.socket), so its heartbeat must be stopped here or the interval
    // leaks -- one per supersede, e.g. every live/replay handover.
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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
      // A replay re-sends hello at the start of every loop pass. It can't
      // re-route the connection (the channel was chosen at attach time),
      // so a later hello naming a different (or no) symbol is ignored rather
      // than silently relabelling this channel.
      if (parsed.symbol !== this.lastSymbol) return;
      this.applyHello(parsed);
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
