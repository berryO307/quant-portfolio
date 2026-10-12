import type { WebSocket } from "ws";
import { BUDGET_CLOSE_CODE, BUDGET_CLOSE_REASON, type EgressBudget } from "./egressBudget.js";

const DEFAULT_MAX_CLIENTS = 500;

// A client whose outbound buffer exceeds this is "slow" — skip queueing it
// any more data for this broadcast rather than letting its backlog grow.
const SLOW_CLIENT_BUFFERED_BYTES = 1 << 20; // 1MB

// A client still backed up past THIS point isn't just slow, it's stuck —
// give up on it outright rather than holding the memory indefinitely.
const STUCK_CLIENT_BUFFERED_BYTES = 8 << 20; // 8MB

/** The part of a viewer's TCP socket used for egress accounting. */
export interface CountedSocket {
  readonly bytesWritten: number;
}

// Tracks connected browser clients, enforces a concurrent-connection cap,
// and — the important part — never lets a slow client's backlog block the
// broadcast loop. ws.send() is already async and won't block Node's event
// loop by itself, but it WILL queue unboundedly in the client's internal
// buffer if we keep calling send() on a client that isn't draining. So
// broadcast() checks bufferedAmount before sending: a slow client just gets
// this message dropped (it'll catch up on the next one that fits), and a
// truly stuck client gets disconnected. Same "drop and count, never block
// the fast path" principle as the C++ side's SPSC ring buffers.
//
// Egress is measured from each viewer's socket (bytesWritten: what actually
// left, after permessage-deflate and with frame headers), not from message
// sizes -- compressed traffic is ~4x smaller than the JSON, so counting the
// JSON made the daily budget run out 4x early. Collected once a second by
// the relay (takeEgressBytes), so the budget can overshoot by at most one
// second of traffic.
export class ConnectionManager {
  private clients = new Set<WebSocket>();
  private droppedMessages = 0;
  private sockets = new Map<WebSocket, { socket: CountedSocket; counted: number }>();
  // Bytes written by viewers that disconnected since the last collection.
  private closedUncounted = 0;

  constructor(
    private readonly maxClients: number = DEFAULT_MAX_CLIENTS,
    // Shared by every channel: the cap is on the relay's total egress.
    private readonly budget?: EgressBudget
  ) {}

  /** Sends to one viewer. Returns false (and has disconnected every viewer)
   * once today's egress budget is spent. */
  send(ws: WebSocket, data: string): boolean {
    if (this.budget?.exhausted()) {
      this.closeAllForBudget();
      return false;
    }
    ws.send(data);
    return true;
  }

  // Budget spent: end every viewer's stream with a reason the browser can
  // show, rather than leaving sockets open that will never get data.
  private closeAllForBudget(): void {
    for (const client of this.clients) client.close(BUDGET_CLOSE_CODE, BUDGET_CLOSE_REASON);
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  get droppedMessageCount(): number {
    return this.droppedMessages;
  }

  /** Returns false (and the caller should close the socket) if at capacity.
   * `socket` is the viewer's TCP socket, for egress accounting. */
  addClient(ws: WebSocket, socket?: CountedSocket): boolean {
    if (this.clients.size >= this.maxClients) return false;

    this.clients.add(ws);
    if (socket) this.sockets.set(ws, { socket, counted: socket.bytesWritten });
    const remove = () => {
      this.clients.delete(ws);
      const s = this.sockets.get(ws);
      if (s) {
        this.closedUncounted += s.socket.bytesWritten - s.counted;
        this.sockets.delete(ws);
      }
    };
    ws.on("close", remove);
    ws.on("error", remove);
    return true;
  }

  /** Bytes written to this channel's viewers since the previous call. */
  takeEgressBytes(): number {
    let bytes = this.closedUncounted;
    this.closedUncounted = 0;
    for (const s of this.sockets.values()) {
      const now = s.socket.bytesWritten;
      bytes += now - s.counted;
      s.counted = now;
    }
    return bytes;
  }

  broadcast(data: string | Buffer): void {
    if (this.budget?.exhausted()) {
      this.closeAllForBudget();
      return;
    }
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN) continue;

      if (client.bufferedAmount >= STUCK_CLIENT_BUFFERED_BYTES) {
        client.terminate();
        this.clients.delete(client);
        continue;
      }

      if (client.bufferedAmount >= SLOW_CLIENT_BUFFERED_BYTES) {
        this.droppedMessages++;
        continue; // drop this message for this client only — others are unaffected
      }

      client.send(data);
    }
  }
}
