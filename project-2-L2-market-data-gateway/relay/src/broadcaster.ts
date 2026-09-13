import type { DataSource } from "./dataSource.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { IngestRecord } from "./types.js";

// Fans out incoming records to connected browser clients. Depends only on
// the abstract DataSource interface (not BybitIngestClient) and delegates
// actual per-client delivery/backpressure to ConnectionManager — this class
// has exactly one job: serialize each record once and hand the same bytes
// to everyone, rather than re-serializing per client.
export class Broadcaster {
  constructor(
    private readonly source: DataSource,
    private readonly connections: ConnectionManager
  ) {
    this.source.on("record", this.handleRecord);
  }

  private handleRecord = (record: IngestRecord): void => {
    const payload = JSON.stringify(record);
    this.connections.broadcast(payload);
  };

  stop(): void {
    this.source.off("record", this.handleRecord);
  }
}
