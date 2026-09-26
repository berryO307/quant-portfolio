import type { HistogramSnapshot, LatencyBucketSnapshot } from "./types";

/* -------------------------------------------------------------------------- */
/* HISTOGRAM RECONSTRUCTION                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Must mirror relay/src/histogram.ts exactly.
 *
 * The relay records against these same geometric boundaries and sends the
 * resulting counts[] to the web layer.
 */

const HISTOGRAM_RATIO = 1.01;
const HISTOGRAM_MAX_NS = 2 ** 31;

function buildHistogramBoundaries(): Float64Array {
  const boundaries: number[] = [1];

  let value = 1;

  while (value < HISTOGRAM_MAX_NS) {
    let next = Math.floor(value * HISTOGRAM_RATIO);

    if (next <= value) {
      next = value + 1;
    }

    value = next;
    boundaries.push(value);
  }

  return Float64Array.from(boundaries);
}

export const HISTOGRAM_BOUNDARIES = buildHistogramBoundaries();

/* -------------------------------------------------------------------------- */
/* COLOUR HIERARCHY                                                           */
/* -------------------------------------------------------------------------- */

/*
 * Single source of truth for a heatmap's density -> opacity ramp, shared by
 * every visualMap that reads it (the main Latency Distribution chart AND
 * the Stage Latency Breakdown mini-charts — see StageLatencyBreakdown.tsx)
 * and each one's own density-scale legend, so a legend can never drift out
 * of sync with the heatmap it describes. Values only — the colour is a
 * single restrained token applied via withAlpha() at each call site, never
 * baked in here. One tint varied by opacity, not a multi-hue ramp: a
 * background density field needs to read as context, not another signal.
 *
 * The 0..0.5 range (up from an original 0.04..0.38) plus the sqrt()
 * compression applied where this is consumed (visualMap.max and the
 * heatmap series data) are what make the density structure actually
 * readable — a linear scale looks washed out regardless of these numbers,
 * because real latency histograms are heavily right-skewed (see
 * buildHeatmapBins's own comment on the Task #7 finding for the full
 * story).
 */
export const HEATMAP_DENSITY_OPACITY_STOPS = [
  0.08, 0.14, 0.21, 0.3, 0.4, 0.5,
] as const;

/* -------------------------------------------------------------------------- */
/* HEATMAP DISPLAY BINS                                                       */
/* -------------------------------------------------------------------------- */

export interface HeatmapBin {
  lowerUs: number;
  upperUs: number;
  centerUs: number;
}

export function chooseHeatmapBinSize(maxUs: number): number {
  /*
   * Keep enough vertical resolution to show the distribution structure.
   * This only changes frontend display aggregation; historical buckets remain
   * at the original 10-second resolution.
   */
  const targetBins = 48;
  const rawStep = maxUs / targetBins;

  const niceSteps = [
    0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 20, 25, 30,
    40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 500, 750, 1_000, 2_000,
    5_000, 10_000,
  ];

  return (
    niceSteps.find((step) => step >= rawStep) ??
    niceSteps[niceSteps.length - 1]!
  );
}

export interface HeatmapBuildResult {
  data: [number, number, number][];
  bins: HeatmapBin[];
  maxDensity: number;
}

/*
 * Which of a bucket's five histograms (total, or one of the four pipeline
 * stages) to build the heatmap/range from. Defaults to `total`, matching
 * every call site before the Stage Latency Breakdown cards existed — those
 * cards pass e.g. `(bucket) => bucket.parse` to get the exact same binning
 * algorithm applied to that stage's own histogram instead of the combined
 * total, with no duplicated logic and no new data pipeline.
 */
export type BucketSnapshotSelector = (
  bucket: LatencyBucketSnapshot,
) => HistogramSnapshot;

const selectTotal: BucketSnapshotSelector = (bucket) => bucket.total;

export function buildHeatmapBins(
  historicalBuckets: readonly LatencyBucketSnapshot[],
  selectSnapshot: BucketSnapshotSelector = selectTotal,
): HeatmapBuildResult | null {
  if (historicalBuckets.length === 0) {
    return null;
  }

  /*
   * Task #7 investigation finding: the relay's percentiles (p50/p99/p99.9)
   * are HDR-histogram-style bucket-boundary estimates — snapshotFromCounts()
   * in relay/src/histogram.ts returns the UPPER boundary of the geometric
   * bucket that contains the target-ranked sample, while maxNs is tracked
   * separately as the exact raw value. When the top percentile's target
   * rank lands in the same bucket as the true max (common for moderate
   * sample counts — see relay/src/histogram.test.ts for the exact
   * reproduction and the math), that bucket's upper boundary is virtually
   * always slightly ABOVE the exact max it contains, so p999Ns > maxNs is
   * an expected, legitimate outcome, not a bug. This is intentional and
   * shared byte-for-byte with include/live_histogram.hpp and
   * analysis/export_summary.py — the calculation itself is NOT changed
   * here.
   *
   * What WAS a real frontend bug: sizing this chart's latency range using
   * only maxNs. Since p50/p99/p999Ns can each legitimately exceed maxNs
   * (p999 in particular), a range sized from maxNs alone could be too
   * short to contain its own plotted percentile lines — clipping P99.9 off
   * the top of the chart exactly in the case this investigation reproduced.
   * Using the max of ALL FOUR statistics fixes that without touching the
   * histogram calculation, the heatmap's own binning algorithm, or
   * anything about how percentiles are computed.
   */
  const maxUs = Math.max(
    ...historicalBuckets.map((bucket) => {
      const snapshot = selectSnapshot(bucket);

      return (
        Math.max(
          snapshot.maxNs,
          snapshot.p50Ns,
          snapshot.p99Ns,
          snapshot.p999Ns,
        ) / 1_000
      );
    }),
  );

  if (!Number.isFinite(maxUs) || maxUs <= 0) {
    return null;
  }

  const binSizeUs = chooseHeatmapBinSize(maxUs);

  const binCount = Math.max(1, Math.ceil(maxUs / binSizeUs));

  const bins: HeatmapBin[] = Array.from(
    {
      length: binCount,
    },
    (_, index) => {
      const lowerUs = index * binSizeUs;

      const upperUs = (index + 1) * binSizeUs;

      return {
        lowerUs,
        upperUs,
        centerUs: (lowerUs + upperUs) / 2,
      };
    },
  );

  const data: [number, number, number][] = [];

  let maxDensity = 0;

  for (
    let bucketIndex = 0;
    bucketIndex < historicalBuckets.length;
    bucketIndex += 1
  ) {
    const bucket = historicalBuckets[bucketIndex]!;

    const displayCounts = new Float64Array(binCount);

    const counts = selectSnapshot(bucket).counts ?? [];

    for (
      let histogramIndex = 0;
      histogramIndex < counts.length;
      histogramIndex += 1
    ) {
      const count = counts[histogramIndex] ?? 0;

      if (count <= 0) {
        continue;
      }

      const boundaryIndex = Math.min(
        histogramIndex,
        HISTOGRAM_BOUNDARIES.length - 1,
      );

      const boundaryNs = HISTOGRAM_BOUNDARIES[boundaryIndex]!;

      const latencyUs = boundaryNs / 1_000;

      const displayBinIndex = Math.min(
        Math.max(Math.floor(latencyUs / binSizeUs), 0),
        binCount - 1,
      );

      displayCounts[displayBinIndex]! += count;
    }

    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      const density = displayCounts[binIndex]!;

      /*
       * Zero-density cells are omitted.
       *
       * This keeps the chart background clean instead of painting the whole
       * matrix with the lowest visualMap color.
       */
      if (density <= 0) {
        continue;
      }

      data.push([bucketIndex, binIndex, density]);

      maxDensity = Math.max(maxDensity, density);
    }
  }

  if (data.length === 0) {
    return null;
  }

  return {
    data,
    bins,
    maxDensity,
  };
}
