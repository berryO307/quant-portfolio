import type { DataSource } from "./dataSource.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { IngestRecord } from "./types.js";

// Fans out incoming records to connected browser clients. Depends only on
// the abstract DataSource interface (not BybitIngestClient) and delegates
// actual per-client delivery/backpressure to ConnectionManager — this class
// has exactly one job: serialize each record once and hand the same bytes
// to everyone, rather than re-serializing per client.
//
// Also remembers the latest snapshot/coarse_snapshot (one per nsigfigs
// tier) it has seen, so index.ts's /live upgrade handler can hand a
// newly-connecting client an immediate starting book instead of leaving it
// on "Waiting for order book snapshot…" until the upstream's own next
// snapshot happens to go out. That wait is NOT bounded in general — a
// live gateway's own l2Book snapshot cadence is a few times a second, but
// a REPLAYED session only emits a snapshot when the ORIGINAL capture's
// own depth-update activity did (see ColdPathExporter's own comment:
// "want_snapshot" fires per applied depth tick, not on a flat timer), so a
// quiet stretch in the original capture replays as an equally quiet
// stretch here — measured live on the deployed relay: real gaps of 13.8s
// and 22.5s between consecutive snapshots in the same session, and
// nothing caps how much longer a given stretch could be. A client that
// connects right after one, previously, just waited however long that
// gap happened to be, indefinitely as far as the UI could tell the
// difference from "broken."
export class Broadcaster {
  private latestSnapshot: string | null = null;
  private readonly latestCoarseSnapshots = new Map<number, string>(); // nsigfigs -> serialized record

  constructor(
    private readonly source: DataSource,
    private readonly connections: ConnectionManager
  ) {
    this.source.on("record", this.handleRecord);
    // Cleared on disconnect, not just left stale until a new one arrives —
    // sending a client a snapshot from an upstream session that's no
    // longer the current one (different capture, possibly a different
    // symbol entirely if the deployment ever changes) would be actively
    // misleading, worse than the honest "waiting" state it would replace.
    this.source.on("disconnected", this.handleDisconnected);
  }

  private handleRecord = (record: IngestRecord): void => {
    const payload = JSON.stringify(record);
    if (record.type === "snapshot") {
      this.latestSnapshot = payload;
    } else if (record.type === "coarse_snapshot") {
      this.latestCoarseSnapshots.set(record.nsigfigs, payload);
    }
    this.connections.broadcast(payload);
  };

  private handleDisconnected = (): void => {
    this.latestSnapshot = null;
    this.latestCoarseSnapshots.clear();
  };

  /** Already-serialized latest snapshot/coarse_snapshot payloads, oldest
   * tier first — index.ts sends these directly to a newly-connecting
   * client right after its hello, in the same order a live stream would
   * have delivered them in. Empty when no snapshot has arrived yet this
   * upstream session (a brand-new connection genuinely has nothing to
   * hand over, which is different from — and rarer than — the "one
   * arrived a while ago, just not to THIS client yet" case this exists
   * to fix). */
  latestSnapshotPayloads(): string[] {
    const payloads: string[] = [];
    if (this.latestSnapshot) payloads.push(this.latestSnapshot);
    payloads.push(...this.latestCoarseSnapshots.values());
    return payloads;
  }

  stop(): void {
    this.source.off("record", this.handleRecord);
    this.source.off("disconnected", this.handleDisconnected);
  }
}
