import type { DataSource } from "./dataSource.js";
import type {
  IngestRecord,
  LatencyBucketSnapshot,
  StatsFullMessage,
  StatsUpdateMessage,
  WireLatencyBucket,
} from "./types.js";
import { Histogram, snapshotFromCounts, toWireHistogram, BUCKET_BOUNDARIES, type HistogramSnapshot } from "./histogram.js";

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
  in_frame: Histogram;
  parse: Histogram;
  queue: Histogram;
  book_update: Histogram;
  publish: Histogram;
}

interface LatencyStats {
  totalNs: number;
  inFrameNs: number;
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
  // Bucket ids that received samples since the last takeUpdate(): the only
  // ones a viewer that already has the history needs again.
  private dirty = new Set<number>();
  // Cumulative gateway ring-buffer drops, as of the newest sample. Viewers
  // used to read it off the raw samples, which they no longer receive.
  private queueOverflowDropped = 0;

  constructor(private readonly source: DataSource) {
    this.source.on("record", this.handleRecord);
    this.source.on("connected", this.handleConnected);
  }

  private handleConnected = (): void => {
    this.sessionHistogram = new Histogram();
    this.queueOverflowDropped = 0; // a session counter, like the histogram above
  };

  private handleRecord = (record: IngestRecord): void => {
    if (record.type !== "sample") return;
    if (record.t_pop === undefined) return;
    if (record.queue_overflow_dropped !== undefined) this.queueOverflowDropped = record.queue_overflow_dropped;

    const cpuGhz = this.source.cpuGhz();
    // t_parse_begin falls back to t_recv for a pre-existing gateway/relay
    // that predates it — reproduces the old conflated "parse" (cumulative
    // through this tick's batch position) with inFrameNs correctly at 0,
    // same fallback useRelayConnection.ts uses client-side. See
    // SampleRecord's own comment and Engineering_Notes.md §11.6.
    const parseBegin = record.t_parse_begin ?? record.t_recv;
    // Total = the four pipeline stages the gateway executes (parse ->
    // publish). In-frame wait (t_recv -> t_parse_begin, a batched tick
    // waiting behind its siblings in one frame) is excluded from every
    // reported figure; it's typically under 10us and was skewing the
    // percentiles. Same definition as useRelayConnection.ts.
    const latencyNs = (record.t_publish - parseBegin) / cpuGhz;
    const totalNs = latencyNs;
    const inFrameNs = (parseBegin - record.t_recv) / cpuGhz;
    const parseNs = (record.t_parse - parseBegin) / cpuGhz;
    const queueNs = (record.t_pop - record.t_parse) / cpuGhz;
    const bookUpdateNs = (record.t_book - record.t_pop) / cpuGhz;
    const publishNs = (record.t_publish - record.t_book) / cpuGhz;
    if (!Number.isFinite(latencyNs) || latencyNs < 0) return;

    this.sessionHistogram.record(latencyNs);
    this.recordRolling({
      totalNs,
      inFrameNs,
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
        in_frame: new Histogram(),
        parse: new Histogram(),
        queue: new Histogram(),
        book_update: new Histogram(),
        publish: new Histogram()
      };
      this.buckets.set(bucketId, bucket);
      this.evictStale(bucketId);
    }
    this.dirty.add(bucketId);
    bucket.total.record(stats.totalNs);
    bucket.in_frame.record(stats.inFrameNs);
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
      inFrame: bucket.in_frame.snapshot(),
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

  private wireBucket(bucket: LatencyBucket): WireLatencyBucket {
    const s = this.snapshotBucket(bucket);
    return {
      timestampMs: s.timestampMs,
      total: toWireHistogram(s.total),
      inFrame: toWireHistogram(s.inFrame),
      parse: toWireHistogram(s.parse),
      queue: toWireHistogram(s.queue),
      bookUpdate: toWireHistogram(s.bookUpdate),
      publish: toWireHistogram(s.publish),
    };
  }

  /** Everything retained, for a viewer that just connected. */
  fullMessage(): StatsFullMessage {
    return {
      type: "stats_full",
      binCount: BUCKET_BOUNDARIES.length,
      latencyBuckets: [...this.buckets.values()]
        .sort((a, b) => a.timestampMs - b.timestampMs)
        .map((bucket) => this.wireBucket(bucket)),
      queueOverflowDropped: this.queueOverflowDropped,
    };
  }

  /** Buckets changed since the previous call (null if none), for viewers
   * that already hold the history. Clears the change set. */
  takeUpdate(): StatsUpdateMessage | null {
    if (this.dirty.size === 0) return null;
    const changed = [...this.dirty]
      .map((id) => this.buckets.get(id))
      .filter((b): b is LatencyBucket => b !== undefined)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    this.dirty.clear();
    let oldest = Infinity;
    for (const b of this.buckets.values()) oldest = Math.min(oldest, b.timestampMs);
    return {
      type: "stats_update",
      binCount: BUCKET_BOUNDARIES.length,
      latencyBuckets: changed.map((bucket) => this.wireBucket(bucket)),
      oldestTimestampMs: Number.isFinite(oldest) ? oldest : 0,
      queueOverflowDropped: this.queueOverflowDropped,
    };
  }

  /** Nobody is watching: forget what changed. A viewer that connects later
   * starts from fullMessage() anyway. */
  clearUpdate(): void {
    this.dirty.clear();
  }

  stop(): void {
    this.source.off("record", this.handleRecord);
    this.source.off("connected", this.handleConnected);
  }
}
