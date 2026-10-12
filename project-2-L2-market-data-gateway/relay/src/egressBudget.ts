// A hard cap on what the relay sends to viewers per UTC day.
//
// Why this exists: hosting bills network egress by the byte ($0.05/GB on
// Railway), and nothing else in the relay bounded it. A bug that made every
// stats message 8.2MB -- one per viewer per second -- turned each open
// dashboard tab into ~30GB/hour of egress and ran up a $15 bill in about a
// day, mostly from tabs left open in the background. That bug is fixed
// (a viewer now costs ~8KB/s), but the next one shouldn't be able to cost
// money either: once today's budget is spent, the relay stops streaming to
// viewers until the next UTC day instead of billing more.
//
// Counted: every payload sent to a viewer (WebSocket messages, and HTTP
// response bodies). Not counted: frame/TLS/TCP overhead -- a few percent --
// and traffic to data sources on /ingest, which is ingress and not billed.
// So the real bill can run slightly above the cap, never far above it.
const DAY_MS = 86_400_000;

export class EgressBudget {
  private day = Math.floor(Date.now() / DAY_MS);
  private sent = 0;

  /** @param budgetBytes bytes per UTC day; 0 means no cap. */
  constructor(private readonly budgetBytes: number) {}

  private rollover(): void {
    const today = Math.floor(Date.now() / DAY_MS);
    if (today !== this.day) {
      this.day = today;
      this.sent = 0;
    }
  }

  /** Counts `bytes` against today's budget. Returns false, counting
   * nothing, if they don't fit: the caller must not send them. */
  trySpend(bytes: number): boolean {
    this.rollover();
    if (this.budgetBytes > 0 && this.sent + bytes > this.budgetBytes) return false;
    this.sent += bytes;
    return true;
  }

  /** Counts bytes that are sent regardless (tiny health responses). */
  record(bytes: number): void {
    this.rollover();
    this.sent += bytes;
  }

  exhausted(): boolean {
    this.rollover();
    return this.budgetBytes > 0 && this.sent >= this.budgetBytes;
  }

  summary() {
    this.rollover();
    const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 100) / 100;
    return {
      sentTodayMB: mb(this.sent),
      budgetMB: this.budgetBytes > 0 ? mb(this.budgetBytes) : null,
      resetsAt: new Date((this.day + 1) * DAY_MS).toISOString(),
    };
  }
}

/** Close code + reason a viewer gets when the day's budget is spent. */
export const BUDGET_CLOSE_CODE = 1013;
export const BUDGET_CLOSE_REASON = "daily bandwidth budget reached";
