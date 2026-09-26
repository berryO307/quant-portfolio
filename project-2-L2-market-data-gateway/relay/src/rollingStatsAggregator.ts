import type { DataSource } from "./dataSource.js";
import type { IngestRecord, LatencyBucketSnapshot } from "./types.js";
import { Histogram, snapshotFromCounts, BUCKET_BOUNDARIES, type HistogramSnapshot } from "./histogram.js";

const BUCKET_MS = 10_000;
const RETENTION_BUCKETS = 360;

export interface RollingStats {
  rollingWindow: HistogramSnapshot;
  currentSession: HistogramSnapshot;
  latencyBuckets: LatencyBucketSnapshot[];
}

// Exported for histogram.test.ts (Task #7): tests the actual merge logic
// directly rather than a reimplementation, to rule out a merge-layer bug as
// the cause of the p999Ns > maxNs investigation. No behavior change.
export function mergeHistograms(histograms: Histogram[]): { counts: Float64Array; total: number; maxNs: number } {
  const counts = new Float64Array(BUCKET_BOUNDARIES.length);
  let total = 0;
  let maxNs = 0;
  for (const h of histograms) {
    const c = h.countsView;
    for (let i = 0; i < c.length; i++) counts[i]! += c[i]!;
    total += h.count;
    if (h.maxValueNs > maxNs) maxNs = h.maxValueNs;
  }
  return { counts, total, maxNs };
}

interface LatencyBucket {
  timestampMs: number;
  total: Histogram;
  parse: Histogram;
  queue: Histogram;
  book_update: Histogram;
  publish: Histogram;
}

interface LatencyStats {
  totalNs: number;
  parseNs: number;
  queueNs: number;
  bookUpdateNs: number;
  publishNs: number;
}

// Maintains a rolling percentile view over the retained window (currently
// BUCKET_MS * RETENTION_BUCKETS = 10s * 360 = 1 hour — see RollingStats'
// own rollingWindow field, named for "whatever the retained window is" on
// purpose so it can't go stale the way its predecessor, rolling12h, did
// when the window was shrunk from 12 hours to 1 without the name changing
// to match), separate from Broadcaster: this class only computes stats, it
// never touches client connections. Depends on the abstract DataSource
// interface, same as Broadcaster, so it keeps working unmodified if the
// upstream feed implementation changes.
//
// Two histograms are tracked from the same incoming sample stream:
//   - RETENTION_BUCKETS buckets of BUCKET_MS each, keyed by wall-clock time
//     (Math.floor(now/BUCKET_MS)). Bucket assignment uses the RELAY's
//     receipt time, not the sample's raw TSC value — TSC has no fixed
//     relationship to wall-clock epoch time without an explicit calibration
//     point, which the wire protocol doesn't carry (see the cpu_ghz
//     handshake note in types.ts for the related TSC-to-ns gap). This is a
//     live-streaming service, so receipt time and capture time differ by at
//     most the network/queueing delay — negligible at this granularity.
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
//
// Used to also split the 12h tail into host-jitter vs pipeline attribution
// (Phase 9), built entirely on host_jitter_ns. Removed along with that field
// — this project measures its own hot-path work, not host scheduler noise —
// and it was dead weight even before that: nothing in the web UI ever
// rendered the split. See git history if it's ever needed again.
export class RollingStatsAggregator {
  private buckets = new Map<number, LatencyBucket>();
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
    if (record.t_pop === undefined) return;

    const cpuGhz = this.source.cpuGhz();
    const latencyNs = (record.t_publish - record.t_recv) / cpuGhz;
    const totalNs = (record.t_publish - record.t_recv) / cpuGhz;
    const parseNs = (record.t_parse - record.t_recv) / cpuGhz;
    const queueNs = (record.t_pop - record.t_parse) / cpuGhz;
    const bookUpdateNs = (record.t_book - record.t_pop) / cpuGhz;
    const publishNs = (record.t_publish - record.t_book) / cpuGhz;
    if (!Number.isFinite(latencyNs) || latencyNs < 0) return;

    this.sessionHistogram.record(latencyNs);
    this.recordRolling({
      totalNs,
      parseNs,
      queueNs,
      bookUpdateNs,
      publishNs
    }, Date.now());
  };

  private recordRolling(stats: LatencyStats, atMs: number): void {
    const bucketId = Math.floor(atMs / BUCKET_MS);
    let bucket = this.buckets.get(bucketId);
    if (!bucket) {
      bucket = {
        timestampMs: bucketId * BUCKET_MS,
        total: new Histogram(),
        parse: new Histogram(),
        queue: new Histogram(),
        book_update: new Histogram(),
        publish: new Histogram()
      };
      this.buckets.set(bucketId, bucket);
      this.evictStale(bucketId);
    }
    bucket.total.record(stats.totalNs);
    bucket.parse.record(stats.parseNs);
    bucket.queue.record(stats.queueNs);
    bucket.book_update.record(stats.bookUpdateNs);
    bucket.publish.record(stats.publishNs);
  }

  private evictStale(currentBucketId: number): void {
    for (const id of this.buckets.keys()) {
      if (currentBucketId - id >= RETENTION_BUCKETS) {
        this.buckets.delete(id);
      }
    }
  }

  private rollingSnapshot(): HistogramSnapshot {
    const { counts, total, maxNs } = mergeHistograms([...this.buckets.values()].map((bucket) => bucket.total));
    return snapshotFromCounts(counts, total, maxNs);
  }

  private snapshotBucket(bucket: LatencyBucket): LatencyBucketSnapshot {
    return {
      timestampMs: bucket.timestampMs,
      total: bucket.total.snapshot(),
      parse: bucket.parse.snapshot(),
      queue: bucket.queue.snapshot(),
      bookUpdate: bucket.book_update.snapshot(),
      publish: bucket.publish.snapshot()
    };
  }

  snapshot(): RollingStats {
    return {
      rollingWindow: this.rollingSnapshot(),
      currentSession: this.sessionHistogram.snapshot(),
      latencyBuckets: [...this.buckets.values()]
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((bucket) => this.snapshotBucket(bucket)),
    };
  }

  stop(): void {
    this.source.off("record", this.handleRecord);
    this.source.off("connected", this.handleConnected);
  }
}
