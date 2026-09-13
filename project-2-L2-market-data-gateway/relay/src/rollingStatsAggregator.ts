import type { DataSource } from "./dataSource.js";
import type { IngestRecord } from "./types.js";
import { Histogram, snapshotFromCounts, BUCKET_BOUNDARIES, type HistogramSnapshot } from "./histogram.js";

const HOUR_MS = 3_600_000;
const RETENTION_HOURS = 12;

export interface RollingStats {
  rolling12h: HistogramSnapshot;
  currentSession: HistogramSnapshot;
}

// Maintains a 12-hour rolling percentile view, separate from Broadcaster:
// this class only computes stats, it never touches client connections.
// Depends on the abstract DataSource interface, same as Broadcaster, so it
// keeps working unmodified if the upstream feed implementation changes.
//
// Two histograms are tracked from the same incoming sample stream:
//   - 12 hourly buckets, keyed by wall-clock hour (Math.floor(now/HOUR_MS)).
//     Bucket assignment uses the RELAY's receipt time, not the sample's raw
//     TSC value — TSC has no fixed relationship to wall-clock epoch time
//     without an explicit calibration point, which the wire protocol
//     doesn't carry (see the cpu_ghz handshake note in types.ts for the
//     related TSC-to-ns gap). This is a live-streaming service, so
//     receipt time and capture time differ by at most the network/queueing
//     delay — negligible for an hour-granularity rolling window.
//   - one "current session" histogram, reset whenever the DataSource signals
//     a new upstream connection (a new capture session beginning), so a
//     brief gateway reconnect doesn't retroactively corrupt session stats
//     with a fresh gateway process's numbers under the old session's data.
//
// Rollover: on each sample, compute its bucket id; create the bucket if it
// doesn't exist yet, then evict every retained bucket whose id is >=12
// behind the current one. This handles both the common case (advancing one
// hour at a time) and a long-idle gap (the gateway not running for >12h)
// identically — eviction is a pass over whatever's retained, not a
// step-by-step walk forward.
export class RollingStatsAggregator {
  private buckets = new Map<number, Histogram>();
  private sessionHistogram = new Histogram();

  constructor(private readonly source: DataSource) {
    this.source.on("record", this.handleRecord);
    this.source.on("connected", this.handleConnected);
  }

  private handleConnected = (): void => {
    this.sessionHistogram = new Histogram();
  };

  private handleRecord = (record: IngestRecord): void => {
    if (record.type !== "sample") return;

    const cpuGhz = this.source.cpuGhz();
    const latencyNs = (record.t_publish - record.t_recv) / cpuGhz;
    if (!Number.isFinite(latencyNs) || latencyNs < 0) return;

    this.sessionHistogram.record(latencyNs);
    this.recordRolling(latencyNs, Date.now());
  };

  private recordRolling(latencyNs: number, atMs: number): void {
    const bucketId = Math.floor(atMs / HOUR_MS);
    let bucket = this.buckets.get(bucketId);
    if (!bucket) {
      bucket = new Histogram();
      this.buckets.set(bucketId, bucket);
      this.evictStale(bucketId);
    }
    bucket.record(latencyNs);
  }

  private evictStale(currentBucketId: number): void {
    for (const id of this.buckets.keys()) {
      if (currentBucketId - id >= RETENTION_HOURS) {
        this.buckets.delete(id);
      }
    }
  }

  private rollingSnapshot(): HistogramSnapshot {
    const merged = new Float64Array(BUCKET_BOUNDARIES.length);
    let total = 0;
    let maxNs = 0;
    for (const bucket of this.buckets.values()) {
      const counts = bucket.countsView;
      for (let i = 0; i < counts.length; i++) merged[i]! += counts[i]!;
      total += bucket.count;
      if (bucket.maxValueNs > maxNs) maxNs = bucket.maxValueNs;
    }
    return snapshotFromCounts(merged, total, maxNs);
  }

  snapshot(): RollingStats {
    return {
      rolling12h: this.rollingSnapshot(),
      currentSession: this.sessionHistogram.snapshot(),
    };
  }

  stop(): void {
    this.source.off("record", this.handleRecord);
    this.source.off("connected", this.handleConnected);
  }
}
