// Simplified HDR-histogram-style latency tracker — third port of the same
// algorithm, after include/live_histogram.hpp (C++) and
// analysis/export_summary.py (Python). Same geometric bucket boundaries
// (~1% relative resolution, ratio 1.01, up to ~2.1s) and the same
// cumulative-count percentile lookup, so a percentile computed here agrees
// with the C++ live view and the Python offline summary for the same data.

const BUCKET_RATIO = 1.01;
const BUCKET_MAX_NS = 2 ** 31; // ~2.1s ceiling; larger values clamp into the top bucket

function buildBucketBoundaries(): Float64Array {
  const boundaries: number[] = [1];
  let v = 1;
  while (v < BUCKET_MAX_NS) {
    let next = Math.floor(v * BUCKET_RATIO);
    if (next <= v) next = v + 1; // guard against rounding stalls at small v
    v = next;
    boundaries.push(v);
  }
  return Float64Array.from(boundaries);
}

export const BUCKET_BOUNDARIES = buildBucketBoundaries();

// First index i such that BUCKET_BOUNDARIES[i] >= value — lower_bound
// semantics, matching std::lower_bound in LiveHistogram::record().
function bucketIndex(valueNs: number): number {
  const v = Math.max(1, valueNs);
  let lo = 0;
  let hi = BUCKET_BOUNDARIES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (BUCKET_BOUNDARIES[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface HistogramSnapshot {
  count: number;
  maxNs: number;
  p50Ns: number;
  p99Ns: number;
  p999Ns: number;
}

// One geometric-bucket histogram. Counts are a plain Float64Array indexed by
// bucket, matching BUCKET_BOUNDARIES — mergeable by element-wise addition
// with any other histogram built from the same boundaries (this is exactly
// how RollingStatsAggregator combines multiple hourly buckets into one
// trailing-window snapshot without re-touching individual samples).
export class Histogram {
  private counts = new Float64Array(BUCKET_BOUNDARIES.length);
  private total = 0;
  private maxNs = 0;

  record(valueNs: number): void {
    this.counts[bucketIndex(valueNs)]!++;
    this.total++;
    if (valueNs > this.maxNs) this.maxNs = valueNs;
  }

  get count(): number {
    return this.total;
  }

  get countsView(): Readonly<Float64Array> {
    return this.counts;
  }

  get maxValueNs(): number {
    return this.maxNs;
  }

  snapshot(): HistogramSnapshot {
    if (this.total === 0) {
      return { count: 0, maxNs: 0, p50Ns: 0, p99Ns: 0, p999Ns: 0 };
    }
    return snapshotFromCounts(this.counts, this.total, this.maxNs);
  }
}

// Percentile lookup shared by Histogram.snapshot() and
// RollingStatsAggregator's merged-bucket snapshot — same cumulative-count
// method as LiveHistogram::snapshot() in C++: integer-division targets and
// a strict "cumulative > target" crossing test.
export function snapshotFromCounts(
  counts: ArrayLike<number>,
  total: number,
  maxNs: number
): HistogramSnapshot {
  if (total === 0) {
    return { count: 0, maxNs: 0, p50Ns: 0, p99Ns: 0, p999Ns: 0 };
  }

  const t50 = Math.floor((total * 50) / 100);
  const t99 = Math.floor((total * 99) / 100);
  const t999 = Math.floor((total * 999) / 1000);

  let cumulative = 0;
  let p50Ns = 0;
  let p99Ns = 0;
  let p999Ns = 0;

  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i]!;
    if (p50Ns === 0 && cumulative > t50) p50Ns = BUCKET_BOUNDARIES[i]!;
    if (p99Ns === 0 && cumulative > t99) p99Ns = BUCKET_BOUNDARIES[i]!;
    if (p999Ns === 0 && cumulative > t999) {
      p999Ns = BUCKET_BOUNDARIES[i]!;
      break;
    }
  }

  return { count: total, maxNs, p50Ns, p99Ns, p999Ns };
}
