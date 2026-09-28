"use client";

import type {HistogramSnapshot, LatencyBucketSnapshot } from "./types";

// x-axis computation for the latency time-series charts.
//
// WHY THIS EXISTS AS ITS OWN MODULE
// ---------------------------------
// The previous (uPlot) charts fed RAW TSC CYCLE COUNTS straight in as x and
// converted to elapsed time only inside the axis tick-label callback. Two
// consequences, both of which showed up as bugs:
//
//  1. The axis was numerically a ~5.5e14-magnitude counter pretending to be
//     a time axis. Nothing downstream — range padding, tick selection,
//     tooltip values — could reason about it as a duration, so each of
//     those needed its own ad-hoc conversion, and the tick formatter had to
//     infer its unit from the *spacing between ticks* rather than from the
//     values themselves.
//  2. Every consumer re-derived `(tsc - t0) / (ghz * 1e9)` independently
//     from a `t0` it picked itself, so "elapsed" meant something slightly
//     different in the axis labels than in the tooltip.
//
// Here the conversion happens exactly once, at the data boundary, and the
// charts receive honest seconds. `t0` is the oldest retained sample, so x
// reads as "seconds since the start of the visible rolling window" — and
// every other place that needs "how long ago" (TailEventsFeed's per-row
// column included) reuses this exact same t0 rather than picking its own,
// which is what keeps them all in agreement as the rolling window slides.
//
// WHY SAMPLES CAN SHARE AN X
// --------------------------
// One WebSocket frame can carry many ticks (Hyperliquid's "trades" channel
// is an array), and `HyperliquidAdapter::dispatch()` stamps one t_recv for
// the whole frame. Every tick of that frame therefore has a byte-identical
// t_recv, and that is CORRECT — they really did arrive together, and each
// one's end-to-end latency genuinely starts there. Confirmed at the wire
// level: buffer growth tracked relay message count at a 1.02x ratio over a
// 26s window, so nothing is duplicating samples. The charts now render as a
// continuous line rather than a scatter of individually-plotted dots, so a
// shared x just draws as a near-vertical line segment — a frame's ticks no
// longer need a synthetic lateral nudge to stay visually distinguishable
// the way they did as overlapping dots.

const NS_PER_SECOND = 1e9;
const BUCKET_RATIO = 1.01;
const BUCKET_MAX_NS = 2 ** 31;

function buildBucketBoundaries(): Float64Array {
  const boundaries: number[] = [1];
  let v = 1;

  while (v < BUCKET_MAX_NS) {
    let next = Math.floor(v * BUCKET_RATIO);
    if (next <= v) next = v + 1;
    v = next;
    boundaries.push(v);
  }

  return Float64Array.from(boundaries);
}

const BUCKET_BOUNDARIES = buildBucketBoundaries();

function snapshotFromCounts(
  counts: ArrayLike<number>,
  total: number,
  maxNs: number,
): HistogramSnapshot {
  if (total === 0) {
    return {
      count: 0,
      maxNs: 0,
      p50Ns: 0,
      p99Ns: 0,
      p999Ns: 0,
      counts: Array.from(counts),
    };
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

    if (p50Ns === 0 && cumulative > t50) {
      p50Ns = BUCKET_BOUNDARIES[i]!;
    }

    if (p99Ns === 0 && cumulative > t99) {
      p99Ns = BUCKET_BOUNDARIES[i]!;
    }

    if (p999Ns === 0 && cumulative > t999) {
      p999Ns = BUCKET_BOUNDARIES[i]!;
      break;
    }
  }

  return {
    count: total,
    maxNs,
    p50Ns,
    p99Ns,
    p999Ns,
    counts: Array.from(counts),
  };
}

/*
 * Which of a bucket's five histograms to merge across the range — total, or
 * one of the four pipeline stages. Defaults to "total", matching every call
 * site before the Stage Latency Breakdown cards existed (Task: Stage
 * Latency Breakdown UI) — those cards pass e.g. "parse" to get the exact
 * same merge-and-percentile logic applied to that stage's own histogram
 * instead of the combined total, reusing this function rather than
 * duplicating it.
 */
export type LatencyStageKey =
  | "total"
  | "inFrame"
  | "parse"
  | "queue"
  | "bookUpdate"
  | "publish";

export function aggregateHistoricalLatency(
  buckets: readonly LatencyBucketSnapshot[],
  stage: LatencyStageKey = "total",
): HistogramSnapshot | null {
  if (buckets.length === 0) return null;

  const bucketCount = buckets[0]![stage].counts.length;
  const mergedCounts = new Float64Array(bucketCount);

  let total = 0;
  let maxNs = 0;

  for (const bucket of buckets) {
    const snapshot = bucket[stage];

    total += snapshot.count;

    if (snapshot.maxNs > maxNs) {
      maxNs = snapshot.maxNs;
    }

    for (let i = 0; i < snapshot.counts.length; i++) {
      mergedCounts[i] += snapshot.counts[i]!;
    }
  }

  return snapshotFromCounts(mergedCounts, total, maxNs);
}

export interface ElapsedSeries {
  xs: number[]; // seconds since the oldest retained sample
  spanSeconds: number; // xs[last] - xs[0], 0 when fewer than 2 points
}

/**
 * Converts raw TSC counter values into seconds-since-oldest.
 *
 * cpuGhz comes from the relay's hello handshake. Until that arrives it's a
 * default (3.2), which would scale the axis wrong — so a non-positive or
 * missing value yields a flat zero series rather than a silently wrong one.
 */
export function toElapsedSeconds(tscValues: readonly number[], cpuGhz: number): ElapsedSeries {
  if (tscValues.length === 0 || !(cpuGhz > 0)) {
    return { xs: tscValues.map(() => 0), spanSeconds: 0 };
  }

  const t0 = tscValues[0]!;
  const cyclesPerSecond = cpuGhz * NS_PER_SECOND;
  const xs = tscValues.map((tsc) => (tsc - t0) / cyclesPerSecond);
  const spanSeconds = xs.length > 1 ? xs[xs.length - 1]! - xs[0]! : 0;

  return { xs, spanSeconds };
}

/**
 * Axis bounds for an elapsed-seconds x-axis.
 *
 * Returned explicitly rather than left to ECharts' auto-ranging so the
 * points provably occupy the full plotting width: min/max ARE the data's
 * own first/last x. A degenerate window (one point, or every sample
 * sharing one timestamp) would collapse to min === max and render as a
 * single column, so that case gets a nominal 1s width instead.
 */
export function elapsedAxisBounds(xs: readonly number[]): { min: number; max: number } {
  if (xs.length === 0) return { min: 0, max: 1 };
  const min = xs[0]!;
  const max = xs[xs.length - 1]!;
  if (!(max > min)) return { min, max: min + 1 };
  return { min, max };
}

/**
 * Explicit min/max for a LINEAR y-axis.
 *
 * The charts used a log axis while latency routinely spanned 3-4 decades
 * (microseconds to tens of milliseconds) — a linear axis over that range
 * would crush everything below the tail flat against zero. Round 8/9's
 * fixes (see notes/Engineering_Notes.md §8-9) closed that range down to
 * roughly one decade in the normal case, so a linear axis is now honest
 * and, unlike log, lets the eye read differences by simple proportional
 * height rather than by decade-counting.
 *
 * min floors at 0 (a latency can't be negative, and pinning the floor
 * there rather than to the data's own minimum keeps the axis stable
 * frame-to-frame instead of creeping with whatever the current smallest
 * sample happens to be). max gets a flat 10% headroom so the highest
 * point/reference line never sits flush against the top edge.
 */
export function linearAxisBounds(values: readonly number[]): { min: number; max: number } {
  const usable = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (usable.length === 0) return { min: 0, max: 1 };
  const max = Math.max(...usable);
  if (max <= 0) return { min: 0, max: 1 };
  return { min: 0, max: max * 1.1 };
}

export interface HistoricalLatencyPoint {
  timestampMs: number;
  p50Ns: number;
  p99Ns: number;
  p999Ns: number;
  maxNs: number;
}

export function toHistoricalLatencySeries(
  buckets: readonly LatencyBucketSnapshot[],
): HistoricalLatencyPoint[] {
  return buckets.map((bucket) => ({
    timestampMs: bucket.timestampMs,
    p50Ns: bucket.total.p50Ns,
    p99Ns: bucket.total.p99Ns,
    p999Ns: bucket.total.p999Ns,
    maxNs: bucket.total.maxNs,
  }));
}

export type LatencyRange = "5m" | "15m" | "1h";

export const RANGE_MS: Record<LatencyRange, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

export function filterLatencyRange(
  points: readonly HistoricalLatencyPoint[],
  range: LatencyRange,
): HistoricalLatencyPoint[] {
  if (points.length === 0) return [];

  const cutoff = points[points.length - 1]!.timestampMs - RANGE_MS[range];

  return points.filter((point) => point.timestampMs >= cutoff);
}

// ---------------------------------------------------------------------------
// Development-time verification
// ---------------------------------------------------------------------------
// The migration brief asked for the x-array to be logged immediately before
// setOption and confirmed to span the expected range. This is that check,
// kept in the source (not a throwaway console.log) so it can be re-run any
// time the data path changes, and throttled so a 60fps flush doesn't spam
// the console. Stripped from production builds by the NODE_ENV guard.

const lastLoggedAt = new Map<string, number>();
const VERIFY_THROTTLE_MS = 5_000;

export function verifyXSpread(label: string, xs: readonly number[]): void {
  if (process.env.NODE_ENV === "production") return;
  if (typeof window === "undefined") return;
  if (xs.length < 2) return;

  const now = Date.now();
  const last = lastLoggedAt.get(label) ?? 0;
  if (now - last < VERIFY_THROTTLE_MS) return;
  lastLoggedAt.set(label, now);

  const min = xs[0]!;
  const max = xs[xs.length - 1]!;
  const span = max - min;

  // How evenly the points occupy the window: 10 equal-width time buckets.
  // Perfectly uniform arrival puts ~10% in each. This is what makes
  // "clustered" vs "spread" an observation rather than an impression.
  const buckets = new Array(10).fill(0);
  for (const x of xs) {
    if (span <= 0) continue;
    let i = Math.floor(((x - min) / span) * 10);
    if (i > 9) i = 9;
    if (i < 0) i = 0;
    buckets[i]++;
  }
  const occupied = buckets.filter((c) => c > 0).length;
  const unique = new Set(xs).size;

  console.info(
    `[x-verify:${label}] n=${xs.length} span=${span.toFixed(2)}s ` +
      `min=${min.toFixed(2)}s max=${max.toFixed(2)}s ` +
      `unique=${unique} (${((unique / xs.length) * 100).toFixed(0)}%) ` +
      `occupied-buckets=${occupied}/10 [${buckets.join(",")}]`
  );
}