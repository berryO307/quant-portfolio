import type { WebSocket } from "ws";
import { BUDGET_CLOSE_CODE, BUDGET_CLOSE_REASON, type EgressBudget } from "./egressBudget.js";

const DEFAULT_MAX_CLIENTS = 500;

// A client whose outbound buffer exceeds this is "slow" — skip queueing it
// any more data for this broadcast rather than letting its backlog grow.
const SLOW_CLIENT_BUFFERED_BYTES = 1 << 20; // 1MB

// A client still backed up past THIS point isn't just slow, it's stuck —
// give up on it outright rather than holding the memory indefinitely.
const STUCK_CLIENT_BUFFERED_BYTES = 8 << 20; // 8MB

// Tracks connected browser clients, enforces a concurrent-connection cap,
// and — the important part — never lets a slow client's backlog block the
// broadcast loop. ws.send() is already async and won't block Node's event
// loop by itself, but it WILL queue unboundedly in the client's internal
// buffer if we keep calling send() on a client that isn't draining. So
// broadcast() checks bufferedAmount before sending: a slow client just gets
// this message dropped (it'll catch up on the next one that fits), and a
// truly stuck client gets disconnected. Same "drop and count, never block
// the fast path" principle as the C++ side's SPSC ring buffers.
export class ConnectionManager {
  private clients = new Set<WebSocket>();
  private droppedMessages = 0;

  constructor(
    private readonly maxClients: number = DEFAULT_MAX_CLIENTS,
    // Shared by every channel: the cap is on the relay's total egress.
    private readonly budget?: EgressBudget
  ) {}

  /** Sends to one viewer, counted against the egress budget. Returns false
   * (and has disconnected every viewer) once today's budget is spent. */
  send(ws: WebSocket, data: string): boolean {
    if (this.budget && !this.budget.trySpend(Buffer.byteLength(data))) {
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

  /** Returns false (and the caller should close the socket) if at capacity. */
  addClient(ws: WebSocket): boolean {
    if (this.clients.size >= this.maxClients) return false;

    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    return true;
  }

  broadcast(data: string | Buffer): void {
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
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

      if (this.budget && !this.budget.trySpend(bytes)) {
        this.closeAllForBudget();
        return;
      }
      client.send(data);
    }
  }
}
