import type { DataSource } from "./dataSource.js";
import type { IngestRecord, WireLatencyBucket } from "./types.js";
import { Histogram, wireFromHistogram, BUCKET_BOUNDARIES, type HistogramSnapshot } from "./histogram.js";

const BUCKET_MS = 10_000;
const RETENTION_BUCKETS = 360;

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

// The four pipeline stages the dashboard shows, plus their sum. In-frame
// wait is not tracked: it's excluded from every reported figure, and its
// histogram was a sixth of the stats memory and bandwidth for nothing.
interface StageHistograms {
  total: Histogram;
  parse: Histogram;
  queue: Histogram;
  book_update: Histogram;
  publish: Histogram;
}

interface LatencyBucket {
  timestampMs: number;
  // Dense histograms while this is the bucket still receiving samples;
  // null once a newer bucket starts. A finished bucket can never change
  // (samples always land in the bucket for "now"), so its dense arrays --
  // 5 x 1,854 doubles, ~74KB -- are freed and only `json` is kept.
  live: StageHistograms | null;
  // This bucket's wire form, serialized. Cached: null only while the live
  // bucket has samples it hasn't been serialized with yet.
  json: string | null;
}

// Rolling latency stats per instrument: RETENTION_BUCKETS buckets of
// BUCKET_MS each (1 hour), keyed by the relay's receipt time, plus one
// "current session" histogram reset on every new upstream connection.
// Separate from Broadcaster: this class computes stats and hands out
// ready-to-send JSON; it never touches connections.
//
// Why the representation looks like this -- measured with a full hour
// retained, two instruments:
//   - every bucket kept dense: 61MB of typed arrays, and building one new
//     viewer's history (stats_full) took 142ms of the relay's single
//     thread. 300 viewers connecting at once = ~42s with no trade sent
//     to anyone.
//   - finished buckets kept only as their JSON: see the numbers in
//     relay/README.md. A new viewer's history is assembled from cached
//     strings instead of rebuilt.
export class RollingStatsAggregator {
  private buckets = new Map<number, LatencyBucket>();
  private sessionHistogram = new Histogram();
  // Bucket ids that received samples since the last takeUpdateJson(): the
  // only ones a viewer that already has the history needs again.
  private dirty = new Set<number>();
  // Cumulative gateway ring-buffer drops, as of the newest sample. Viewers
  // used to read it off the raw samples, which they no longer receive.
  private queueOverflowDropped = 0;
  // Finished buckets' JSON, oldest first, comma-joined. Rebuilt lazily when
  // a bucket finishes or is evicted, i.e. at most once per BUCKET_MS.
  private finishedJson: string | null = "";

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
    // t_parse_begin falls back to t_recv for a gateway that predates it.
    const parseBegin = record.t_parse_begin ?? record.t_recv;
    // Total = the four stages the gateway executes (parse -> publish); same
    // definition as the dashboard. In-frame wait is excluded.
    const totalNs = (record.t_publish - parseBegin) / cpuGhz;
    if (!Number.isFinite(totalNs) || totalNs < 0) return;

    this.sessionHistogram.record(totalNs);
    const live = this.liveBucket(Date.now());
    if (!live) return;
    live.total.record(totalNs);
    live.parse.record((record.t_parse - parseBegin) / cpuGhz);
    live.queue.record((record.t_pop - record.t_parse) / cpuGhz);
    live.book_update.record((record.t_book - record.t_pop) / cpuGhz);
    live.publish.record((record.t_publish - record.t_book) / cpuGhz);
  };

  // The live bucket for `atMs`, starting a new one (and finishing the
  // previous one) when time has moved into a new BUCKET_MS slot.
  private liveBucket(atMs: number): StageHistograms | null {
    const bucketId = Math.floor(atMs / BUCKET_MS);
    let bucket = this.buckets.get(bucketId);
    if (!bucket) {
      for (const b of this.buckets.values()) if (b.live) this.finish(b);
      bucket = {
        timestampMs: bucketId * BUCKET_MS,
        live: { total: new Histogram(), parse: new Histogram(), queue: new Histogram(), book_update: new Histogram(), publish: new Histogram() },
        json: null,
      };
      this.buckets.set(bucketId, bucket);
      this.evictStale(bucketId);
    }
    // A finished bucket only comes back if the wall clock stepped backwards
    // (an NTP correction). Its dense data is gone; drop the sample rather
    // than resurrect the bucket.
    if (!bucket.live) return null;
    bucket.json = null;
    this.dirty.add(bucketId);
    return bucket.live;
  }

  private finish(bucket: LatencyBucket): void {
    this.bucketJson(bucket);
    bucket.live = null;
    this.finishedJson = null;
  }

  private bucketJson(bucket: LatencyBucket): string {
    if (bucket.json === null) {
      const live = bucket.live!; // json is only ever null on the live bucket
      const wire: WireLatencyBucket = {
        timestampMs: bucket.timestampMs,
        total: wireFromHistogram(live.total),
        parse: wireFromHistogram(live.parse),
        queue: wireFromHistogram(live.queue),
        bookUpdate: wireFromHistogram(live.book_update),
        publish: wireFromHistogram(live.publish),
      };
      bucket.json = JSON.stringify(wire);
    }
    return bucket.json;
  }

  private evictStale(currentBucketId: number): void {
    for (const id of this.buckets.keys()) {
      if (currentBucketId - id >= RETENTION_BUCKETS) {
        this.buckets.delete(id);
        this.dirty.delete(id);
        this.finishedJson = null;
      }
    }
  }

  private sortedBuckets(): LatencyBucket[] {
    return [...this.buckets.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  }

  /** Everything retained, serialized, for a viewer that just connected
   * (and for GET /stats). Built from cached pieces: the finished buckets'
   * joined JSON changes at most every BUCKET_MS, so a burst of connections
   * costs a string concatenation each, not a rebuild. */
  fullMessageJson(): string {
    const finished = (this.finishedJson ??= this.sortedBuckets()
      .filter((b) => !b.live)
      .map((b) => b.json)
      .join(","));
    const live = [...this.buckets.values()].filter((b) => b.live).map((b) => this.bucketJson(b));
    const all = [finished, ...live].filter((s) => s.length > 0).join(",");
    return `{"type":"stats_full","binCount":${BUCKET_BOUNDARIES.length},"latencyBuckets":[${all}],"queueOverflowDropped":${this.queueOverflowDropped}}`;
  }

  /** Buckets changed since the previous call, serialized (null if none),
   * for viewers that already hold the history. Clears the change set. */
  takeUpdateJson(): string | null {
    if (this.dirty.size === 0) return null;
    const changed = [...this.dirty]
      .map((id) => this.buckets.get(id))
      .filter((b): b is LatencyBucket => b !== undefined)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((b) => this.bucketJson(b));
    this.dirty.clear();
    let oldest = Infinity;
    for (const b of this.buckets.values()) oldest = Math.min(oldest, b.timestampMs);
    return `{"type":"stats_update","binCount":${BUCKET_BOUNDARIES.length},"latencyBuckets":[${changed.join(",")}],"oldestTimestampMs":${Number.isFinite(oldest) ? oldest : 0},"queueOverflowDropped":${this.queueOverflowDropped}}`;
  }

  /** Nobody is watching: forget what changed. A viewer that connects later
   * starts from fullMessageJson() anyway. */
  clearUpdate(): void {
    this.dirty.clear();
  }

  /** This upstream session's end-to-end latency histogram. */
  sessionSnapshot(): HistogramSnapshot {
    return this.sessionHistogram.snapshot();
  }

  stop(): void {
    this.source.off("record", this.handleRecord);
    this.source.off("connected", this.handleConnected);
  }
}
