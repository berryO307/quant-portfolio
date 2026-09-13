import type { DataSource } from "./dataSource.js";
import type { IngestRecord } from "./types.js";
import {
  Histogram,
  snapshotFromCounts,
  percentileFromCounts,
  BUCKET_BOUNDARIES,
  type HistogramSnapshot,
} from "./histogram.js";

const HOUR_MS = 3_600_000;
const RETENTION_HOURS = 12;

// How much of the IQR (p75-p25) above the median counts as "elevated" —
// same 5x multiplier as the exact median+5*MAD threshold used elsewhere
// (Phase 5/8), applied to a different (but comparably robust) spread
// estimate. See the module comment below for why MAD itself isn't usable
// here.
const JITTER_IQR_MULTIPLIER = 5;

export interface AttributionSplit {
  tailCount: number;
  jitterTailCount: number;
  pipelineTailCount: number;
}

export interface RollingStats {
  rolling12h: HistogramSnapshot;
  rolling12hSplit: AttributionSplit;
  currentSession: HistogramSnapshot;
}

interface Bucket {
  latency: Histogram;
  jitter: Histogram;
  tailCount: number;
  jitterTailCount: number;
}

function newBucket(): Bucket {
  return { latency: new Histogram(), jitter: new Histogram(), tailCount: 0, jitterTailCount: 0 };
}

function mergeHistograms(histograms: Histogram[]): { counts: Float64Array; total: number; maxNs: number } {
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
//
// Phase 9: host_jitter vs pipeline attribution split for the 12h window.
// Unlike Phase 5/8's exact per-event attribution (which needs raw samples
// and a real median+5*MAD threshold), this class only ever retains bucketed
// histogram counts — no raw samples, by design, since 12 hours of raw
// samples would be a lot of memory for a rolling display. So:
//   - The tail/jitter threshold is derived FROM the bucket histograms
//     themselves (median + 5*IQR instead of median + 5*MAD — MAD needs raw
//     deviations, which aren't recoverable from bucket counts, while
//     percentiles are exactly what this representation already supports).
//   - Classification uses the MERGED 12h state (matching what's actually
//     displayed), evaluated BEFORE recording the new sample, so a sample
//     never influences the very threshold it's being classified against.
//     This does mean recomputing the merge on every sample rather than
//     once per broadcast tick — acceptable here since this is an ingest
//     path in a Node relay, not the C++ trading hot path.
export class RollingStatsAggregator {
  private buckets = new Map<number, Bucket>();
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
    this.recordRolling(latencyNs, record.host_jitter_ns, Date.now());
  };

  private recordRolling(latencyNs: number, hostJitterNs: number, atMs: number): void {
    const bucketId = Math.floor(atMs / HOUR_MS);
    let bucket = this.buckets.get(bucketId);
    if (!bucket) {
      bucket = newBucket();
      this.buckets.set(bucketId, bucket);
      this.evictStale(bucketId);
    }

    // Classify against the merged 12h state as it stood BEFORE this sample.
    const buckets = [...this.buckets.values()];
    const latencyMerge = mergeHistograms(buckets.map((b) => b.latency));
    const isTail =
      latencyMerge.total > 0 &&
      latencyNs > percentileFromCounts(latencyMerge.counts, latencyMerge.total, 99.9);

    if (isTail) {
      bucket.tailCount++;
      const jitterMerge = mergeHistograms(buckets.map((b) => b.jitter));
      const median = percentileFromCounts(jitterMerge.counts, jitterMerge.total, 50);
      const p25 = percentileFromCounts(jitterMerge.counts, jitterMerge.total, 25);
      const p75 = percentileFromCounts(jitterMerge.counts, jitterMerge.total, 75);
      const threshold = median + JITTER_IQR_MULTIPLIER * (p75 - p25);
      if (jitterMerge.total > 0 && hostJitterNs > threshold) {
        bucket.jitterTailCount++;
      }
    }

    bucket.latency.record(latencyNs);
    bucket.jitter.record(hostJitterNs);
  }

  private evictStale(currentBucketId: number): void {
    for (const id of this.buckets.keys()) {
      if (currentBucketId - id >= RETENTION_HOURS) {
        this.buckets.delete(id);
      }
    }
  }

  private rollingSnapshot(): HistogramSnapshot {
    const buckets = [...this.buckets.values()];
    const { counts, total, maxNs } = mergeHistograms(buckets.map((b) => b.latency));
    return snapshotFromCounts(counts, total, maxNs);
  }

  private rollingSplit(): AttributionSplit {
    let tailCount = 0;
    let jitterTailCount = 0;
    for (const bucket of this.buckets.values()) {
      tailCount += bucket.tailCount;
      jitterTailCount += bucket.jitterTailCount;
    }
    return { tailCount, jitterTailCount, pipelineTailCount: tailCount - jitterTailCount };
  }

  snapshot(): RollingStats {
    return {
      rolling12h: this.rollingSnapshot(),
      rolling12hSplit: this.rollingSplit(),
      currentSession: this.sessionHistogram.snapshot(),
    };
  }

  stop(): void {
    this.source.off("record", this.handleRecord);
    this.source.off("connected", this.handleConnected);
  }
}
