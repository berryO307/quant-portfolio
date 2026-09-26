"use client";

import { useEffect, useMemo, useRef, useState, MouseEvent } from "react";

import { type StatsMessage, type LiveSample } from "@/lib/types";
import { computeLiveTailEvents } from "@/lib/tailAttribution";

import {
  aggregateHistoricalLatency,
  RANGE_MS,
  type LatencyRange,
} from "@/lib/latencySeries";

import { useECharts } from "@/lib/useECharts";

import {
  buildAxisStyle,
  buildTooltipPosition,
  buildTooltipStyle,
  useChartTheme,
  withAlpha,
} from "@/lib/chartTheme";

import {
  buildHeatmapBins,
  HEATMAP_DENSITY_OPACITY_STOPS,
} from "@/lib/heatmapBins";

import {
  formatLatencyNs,
  formatBucketTime,
  formatAxisTime,
} from "@/lib/format";

import {
  StageLatencyBreakdown,
  type PipelineStageKey,
} from "./StageLatencyBreakdown";

interface LatencyPanelProps {
  recentSamples: LiveSample[];
  cpuGhz: number;
  stats: StatsMessage | null;
}

/* -------------------------------------------------------------------------- */
/* FORMATTING                                                                 */
/* -------------------------------------------------------------------------- */


/*
 * The X axis's own bucket timestamps (and every formatAxisTime/
 * formatBucketTime call above) already render in whatever timezone the
 * VIEWER's browser is in — Date/toLocaleTimeString are inherently
 * local-timezone. This just labels that fact explicitly (e.g. "GMT+5:30")
 * instead of leaving "Local time" ambiguous about which locale it means.
 * Date.getTimezoneOffset() returns minutes WEST of UTC (so e.g. IST is
 * -330), hence the sign flip below to get the conventional "GMT+5:30" form.
 * Not memoized: cheap, and re-evaluating on each chart rebuild means a
 * mid-session DST transition (or the OS clock/timezone changing) is
 * reflected immediately rather than needing a page reload.
 */
function getGmtOffsetLabel(): string {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;

  return `GMT${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
}

function formatAge(timestampMs: number): string {
  const ageMs = Math.max(0, Date.now() - timestampMs);
  const ageSeconds = Math.floor(ageMs / 1_000);

  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }

  const ageMinutes = Math.floor(ageSeconds / 60);

  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }

  const ageHours = Math.floor(ageMinutes / 60);

  return `${ageHours}h ago`;
}

function formatRangeLabel(range: LatencyRange): string {
  switch (range) {
    case "5m":
      return "5 minutes";

    case "15m":
      return "15 minutes";

    case "1h":
      return "1 hour";
  }
}

/*
 * Short-form elapsed duration for the "X of history available" qualifier
 * below — deliberately not formatAge()'s "Xm ago" phrasing (that's for a
 * point in time; this is a SPAN) and not formatRangeLabel()'s spelled-out
 * "1 hour" (that's the selected range's own label, not a measured amount).
 */
function formatShortDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatPercentage(value: number): string {
  if (value > 0 && value < 1) {
    return "<1%";
  }

  return `${Math.round(value)}%`;
}

/* -------------------------------------------------------------------------- */
/* METRIC ICONS                                                               */
/* -------------------------------------------------------------------------- */

function MetricIcon({ metric }: { metric: "p50" | "p99" | "p999" | "max" }) {
  const common = "h-4 w-4 shrink-0";

  if (metric === "p50") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className={common}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path
          d="M3 10h3l2-4 3 8 2-4h4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (metric === "p99") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className={common}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path
          d="M3 14l4-4 3 2 6-7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <path d="M12 5h4v4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (metric === "p999") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className={common}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M10 3l7 13H3L10 3z" strokeLinejoin="round" />

        <path d="M10 8v4" strokeLinecap="round" />

        <circle cx="10" cy="14" r="0.7" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={common}
      fill="currentColor"
    >
      <path d="M10 2c1.3 2.2.8 3.4 2.8 4.8 1.6 1.1 3.2 2.7 3.2 5.2a6 6 0 1 1-12 0c0-2.4 1.4-4.2 3.1-5.9.1 1.7.9 2.5 1.9 3.1-.1-2.3.8-4.5 1-7.2z" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* METRIC HINT                                                                */
/* -------------------------------------------------------------------------- */

function MetricHint({ children }: { children: string }) {
  return (
    <span className="group relative cursor-help">
      <span className="border-b border-dotted border-current text-[10px]">
        ?
      </span>

      <span
        className="
          pointer-events-none
          absolute
          left-0
          top-full
          z-30
          mt-2
          w-48
          rounded-md
          border
          border-border
          bg-panel
          px-2.5
          py-2
          text-[10px]
          leading-snug
          font-normal
          normal-case
          tracking-normal
          text-muted-foreground
          opacity-0
          shadow-md
          transition-opacity
          duration-150
          group-hover:opacity-100
        "
      >
        {children}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* METRIC VISIBILITY (TASK #4)                                               */
/* -------------------------------------------------------------------------- */

type PercentileMetric = "p50" | "p99" | "p999" | "max";

const ALL_METRICS_VISIBLE: Record<PercentileMetric, boolean> = {
  p50: true,
  p99: true,
  p999: true,
  max: true,
};

/* -------------------------------------------------------------------------- */
/* PANEL                                                                      */
/* -------------------------------------------------------------------------- */

export function LatencyPanel({
  recentSamples,
  cpuGhz: _cpuGhz,
  stats,
}: LatencyPanelProps) {
  const { containerRef, chartRef, setOption } = useECharts();

  const chartTheme = useChartTheme();

  const [historicalRange, setHistoricalRange] = useState<LatencyRange>("15m");

  const [selectedBucketTimestamp, setSelectedBucketTimestamp] = useState<
    number | null
  >(null);

  const [hoveredBucketIndex, setHoveredBucketIndex] = useState(-1);

  /*
   * Clicking a stage in the Stage Breakdown bar/legend below highlights
   * (not opens) the matching card in the Stage Latency Breakdown section —
   * the expand button already exists for opening the big preview, so this
   * click is deliberately a lighter-weight "point at this one" action.
   */
  const [highlightedStage, setHighlightedStage] =
    useState<PipelineStageKey | null>(null);

  /*
   * Task #4: independent per-metric visibility for the Latency Distribution
   * chart's own P50/P99/P99.9/Max legend. Plain React state rather than
   * ECharts' built-in legend component/selectedMode — the header legend is
   * (and was already, before this task) custom HTML built from chartTheme
   * colors, not a registered `legend:` block in setOption, so there is no
   * existing ECharts legend to hook into. Duplicating visibility here is
   * the simplest architecture consistent with that, not a workaround.
   */
  const [visibleMetrics, setVisibleMetrics] =
    useState<Record<PercentileMetric, boolean>>(ALL_METRICS_VISIBLE);

  const toggleMetric = (metric: PercentileMetric) => {
    setVisibleMetrics((current) => ({
      ...current,
      [metric]: !current[metric],
    }));
  };

  const historicalBucketsRef = useRef<
    NonNullable<StatsMessage["latencyBuckets"]>
  >([]);
  const hoveredBucketIndexRef = useRef(-1);
  /*
   * Portal target for the Stage Latency Breakdown preview modal — see that
   * component's own comment on why it portals into this ref instead of
   * rendering fixed/inset-0 over the whole viewport (it used to spill over
   * the order book on the left; this confines it to this panel's own
   * column, which is also visually "the historical summary's own area").
   */
  const panelRootRef = useRef<HTMLDivElement>(null);
  /*
   * Keep this calculation because the component still receives the live
   * sample stream. The historical Latency Tails view itself is driven by
   * latencyBuckets.
   */
  useMemo(() => computeLiveTailEvents(recentSamples), [recentSamples]);

  /* ------------------------------------------------------------------------ */
  /* HISTORICAL BUCKETS                                                       */
  /* ------------------------------------------------------------------------ */

  const historicalBuckets = useMemo(() => {
    const latencyBuckets = stats?.latencyBuckets;

    if (!latencyBuckets || latencyBuckets.length === 0) {
      return [];
    }

    const latestTimestampMs =
      latencyBuckets[latencyBuckets.length - 1]!.timestampMs;

    const cutoff = latestTimestampMs - RANGE_MS[historicalRange];

    return latencyBuckets.filter((bucket) => bucket.timestampMs >= cutoff);
  }, [stats, historicalRange]);

  /*
   * How much history is ACTUALLY on screen, vs. the selected range's own
   * label ("1 hour"). Selecting "1h" means "show up to the last hour of
   * retained history" — it can't retroactively produce data that doesn't
   * exist yet (e.g. right after the relay/gateway restarts). Surfaced in
   * the header below so that state reads as "not enough history yet" (a
   * normal, temporary condition) rather than looking like a broken range
   * selector when the X-axis span doesn't match the button that's active.
   */
  const actualHistorySpanMs =
    historicalBuckets.length >= 2
      ? historicalBuckets[historicalBuckets.length - 1]!.timestampMs -
        historicalBuckets[0]!.timestampMs
      : 0;

  const isPartialHistory =
    historicalBuckets.length > 0 &&
    actualHistorySpanMs < RANGE_MS[historicalRange] * 0.9;

  useEffect(() => {
    historicalBucketsRef.current = historicalBuckets;
  }, [historicalBuckets]);

  /* ------------------------------------------------------------------------ */
  /* PEAK TAIL                                                                */
  /* ------------------------------------------------------------------------ */

  const latestSpike = useMemo(() => {
    if (historicalBuckets.length === 0) {
      return null;
    }

    return historicalBuckets.reduce((largest, bucket) =>
      bucket.total.maxNs > largest.total.maxNs ? bucket : largest,
    );
  }, [historicalBuckets]);

  const latestSpikeStage = useMemo(() => {
    if (!latestSpike) {
      return null;
    }

    const stages = [
      {
        name: "parse",
        value: latestSpike.parse.p99Ns,
      },
      {
        name: "queue",
        value: latestSpike.queue.p99Ns,
      },
      {
        name: "book-update",
        value: latestSpike.bookUpdate.p99Ns,
      },
      {
        name: "publish",
        value: latestSpike.publish.p99Ns,
      },
    ];

    return stages.reduce((largest, stage) =>
      stage.value > largest.value ? stage : largest,
    );
  }, [latestSpike]);

  /* ------------------------------------------------------------------------ */
  /* KPI AGGREGATION                                                           */
  /* ------------------------------------------------------------------------ */

  const historicalLatency = useMemo(() => {
    if (historicalBuckets.length === 0) {
      return null;
    }

    return aggregateHistoricalLatency(historicalBuckets);
  }, [historicalBuckets]);

  /* ------------------------------------------------------------------------ */
  /* SELECTED BUCKET                                                           */
  /* ------------------------------------------------------------------------ */

  const selectedBucket = useMemo(() => {
    if (selectedBucketTimestamp === null) {
      return null;
    }

    return (
      historicalBuckets.find(
        (bucket) => bucket.timestampMs === selectedBucketTimestamp,
      ) ?? null
    );
  }, [historicalBuckets, selectedBucketTimestamp]);

  /*
   * Index form of the same lookup, for the chart's hover-overlay markers —
   * "Peak Tail" sets selectedBucketTimestamp but was never reflected on the
   * chart itself (only Stage Breakdown, which reads `selectedBucket`
   * directly). Feeding this into the same overlay the mouse-hover path
   * already drives (see hoveredBucket below) makes clicking Peak Tail
   * "pop" the corresponding point on the chart too, without adding a
   * second highlight mechanism.
   */
  const selectedBucketIndex = useMemo(() => {
    if (selectedBucketTimestamp === null) {
      return -1;
    }

    return historicalBuckets.findIndex(
      (bucket) => bucket.timestampMs === selectedBucketTimestamp,
    );
  }, [historicalBuckets, selectedBucketTimestamp]);

  /*
   * Live mouse hover wins when active; otherwise fall back to whatever
   * bucket is "selected" (Peak Tail click, or a chart click). Hoisted to
   * component scope (was local to the chart-building effect below) so it
   * can also be passed to StageLatencyBreakdown, which uses it to mirror
   * the same highlighted point on its own four mini charts — hovering the
   * main Latency Distribution chart now reflects there too, since they
   * share the same historicalBuckets/time horizon.
   */
  const highlightedBucketIndex =
    hoveredBucketIndex >= 0 ? hoveredBucketIndex : selectedBucketIndex;

  /* ------------------------------------------------------------------------ */
  /* STAGE BREAKDOWN                                                           */
  /* ------------------------------------------------------------------------ */

  const stageBreakdown = useMemo(() => {
    const bucket =
      selectedBucket ?? historicalBuckets[historicalBuckets.length - 1] ?? null;

    if (!bucket) {
      return null;
    }

    const stages: {
      key: PipelineStageKey;
      name: string;
      valueNs: number;
      color: string;
    }[] = [
      {
        key: "parse",
        name: "parse",
        valueNs: bucket.parse.p99Ns,
        color: chartTheme.parse,
      },
      {
        key: "queue",
        name: "queue",
        valueNs: bucket.queue.p99Ns,
        color: chartTheme.queue,
      },
      {
        key: "bookUpdate",
        name: "book-update",
        valueNs: bucket.bookUpdate.p99Ns,
        color: chartTheme.bookUpdate,
      },
      {
        key: "publish",
        name: "publish",
        valueNs: bucket.publish.p99Ns,
        // Task #8: was chartTheme.palette[3] (the generic categorical
        // --chart-4) — switched to the new dedicated chartTheme.publish
        // token so Publish reads as the exact same colour everywhere it
        // appears (this bar, the Stage Latency Breakdown cards, and their
        // preview), not just visually similar. See chartTheme.ts's comment
        // on `publish` for why palette[3] specifically had to go (it broke
        // ECharts rendering elsewhere, even though this plain-CSS bar was
        // never affected).
        color: chartTheme.publish,
      },
    ];

    const totalNs = stages.reduce((sum, stage) => sum + stage.valueNs, 0);

    return {
      bucket,

      stages: stages.map((stage) => ({
        ...stage,

        percentage: totalNs > 0 ? (stage.valueNs / totalNs) * 100 : 0,
      })),
    };
  }, [selectedBucket, historicalBuckets, chartTheme]);

  /* ------------------------------------------------------------------------ */
  /* RANGE / SELECTION CLEANUP                                                */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (selectedBucketTimestamp === null) {
      return;
    }

    const stillVisible = historicalBuckets.some(
      (bucket) => bucket.timestampMs === selectedBucketTimestamp,
    );

    if (!stillVisible) {
      setSelectedBucketTimestamp(null);
    }
  }, [historicalBuckets, selectedBucketTimestamp]);

  /*
   * A selected historical bucket is deliberately temporary.
   *
   * This lets the dashboard inspect an older event for five seconds and then
   * automatically return to live-follow mode.
   */
  useEffect(() => {
    if (selectedBucketTimestamp === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      setSelectedBucketTimestamp(null);
    }, 5_000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [selectedBucketTimestamp]);

  /* ------------------------------------------------------------------------ */
  /* CHART INTERACTION                                                        */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const chart = chartRef.current;

    if (!chart) {
      return;
    }

    /*
     * HOVER
     *
     * Keep the existing working manual hover implementation.
     * The important result is hoveredBucketIndexRef.current.
     */
    const handleCanvasMouseMove = (event: {
      offsetX?: number;
      offsetY?: number;
      zrX?: number;
      zrY?: number;
    }) => {
      const x = event.offsetX ?? event.zrX;
      const y = event.offsetY ?? event.zrY;

      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        return;
      }

      const buckets = historicalBucketsRef.current;

      if (buckets.length === 0) {
        return;
      }

      if (!chart.containPixel({ gridIndex: 0 }, [x, y])) {
        hoveredBucketIndexRef.current = -1;
        setHoveredBucketIndex(-1);

        chart.dispatchAction({
          type: "hideTip",
        });

        return;
      }
      const GRID_LEFT = 72;
      const GRID_RIGHT = 24;

      const plotWidth = chart.getWidth() - GRID_LEFT - GRID_RIGHT;

      if (plotWidth <= 0) {
        hoveredBucketIndexRef.current = -1;
        setHoveredBucketIndex(-1);
        return;
      }

      const ratio = (x - GRID_LEFT) / plotWidth;

      const bucketIndex = Math.round(ratio * (buckets.length - 1));

      if (bucketIndex < 0 || bucketIndex >= buckets.length) {
        hoveredBucketIndexRef.current = -1;
        setHoveredBucketIndex(-1);
        return;
      }

      const previousBucketIndex = hoveredBucketIndexRef.current;

      hoveredBucketIndexRef.current = bucketIndex;

      setHoveredBucketIndex((current) =>
        current === bucketIndex ? current : bucketIndex,
      );
    };

    const handleCanvasClick = () => {
      const bucketIndex = hoveredBucketIndexRef.current;

      if (!Number.isInteger(bucketIndex) || bucketIndex < 0) {
        return;
      }

      const bucket = historicalBucketsRef.current[bucketIndex];

      if (!bucket) {
        return;
      }

      setSelectedBucketTimestamp(bucket.timestampMs);
    };

    /*
     * CLICK
     *
     * This is deliberately attached to the chart's DOM element rather than
     * ZRender. It catches clicks on:
     *   - percentile lines
     *   - Max markers
     *   - heatmap cells
     *   - empty space in the plotting area
     *
     * We reuse the bucket already resolved by the working hover path.
     */
    const handleChartDomClick = () => {
      const bucketIndex = hoveredBucketIndexRef.current;

      if (!Number.isInteger(bucketIndex) || bucketIndex < 0) {
        return;
      }

      const bucket = historicalBucketsRef.current[bucketIndex];

      if (!bucket) {
        return;
      }

      setSelectedBucketTimestamp(bucket.timestampMs);
    };

    /*
     * Stale-hover bug: handleCanvasMouseMove only resets
     * hoveredBucketIndexRef when a mousemove event actually lands outside
     * the plot area — but a real DOM mousemove only fires while the
     * pointer is still over the element. Move the cursor off the chart
     * fast enough (or straight onto, say, the Peak Tail button elsewhere
     * on the page) and no further mousemove ever reaches this handler, so
     * hoveredBucketIndexRef stays stuck at its last in-bounds value
     * indefinitely. That stale value then kept outranking a fresh
     * Peak-Tail-driven selectedBucketIndex in highlightedBucketIndex's own
     * "hover wins when active" fallback (hoveredBucketIndex >= 0 ? hover :
     * selected) — clicking Peak Tail updated Stage Breakdown correctly
     * (it reads selectedBucket directly) but the chart's own highlight
     * stayed pinned to wherever the mouse last actually was, not to the
     * bucket Peak Tail just selected.
     *
     * First attempt at this fix used zrender's own "globalout" event —
     * turned out not to actually fire for this case. zrender's internal
     * "globalout" only corresponds to the pointer leaving the whole
     * document/window (it listens on `document` for a mouseout with no
     * relatedTarget, a mechanism meant for continuing a drag past the
     * canvas edge), NOT "moved onto a sibling element elsewhere on the
     * same page" — which is exactly the Peak-Tail-button case this needs
     * to catch, so nothing fired and the dot stayed put. A plain DOM
     * `mouseleave` on the chart's own container element is the correct
     * event here: it fires whenever the pointer exits THIS element's
     * bounds specifically, regardless of what's next on the page.
     */
    const handleCanvasMouseLeave = () => {
      hoveredBucketIndexRef.current = -1;
      setHoveredBucketIndex(-1);

      chart.dispatchAction({
        type: "hideTip",
      });
    };

    const dom = chart.getDom();

    chart.getZr().on("mousemove", handleCanvasMouseMove);

    dom.addEventListener("click", handleChartDomClick, true);
    dom.addEventListener("mouseleave", handleCanvasMouseLeave);

    return () => {
      if (chart.isDisposed()) {
        return;
      }

      chart.getZr().off("mousemove", handleCanvasMouseMove);
      dom.removeEventListener("click", handleChartDomClick, true);
      dom.removeEventListener("mouseleave", handleCanvasMouseLeave);
    };
  }, [chartRef]);

  const handleHistoricalChartClick = (event: MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current;

    if (!chart || chart.isDisposed()) {
      return;
    }

    const buckets = historicalBucketsRef.current;

    if (buckets.length === 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();

    /*
     * X coordinate relative to the ECharts container.
     */
    const x = event.clientX - rect.left;

    /*
     * These match the chart's actual grid configuration.
     */
    const GRID_LEFT = 72;
    const GRID_RIGHT = 24;

    const plotWidth = chart.getWidth() - GRID_LEFT - GRID_RIGHT;

    if (plotWidth <= 0) {
      return;
    }

    /*
     * Convert the clicked X coordinate into the nearest
     * historical bucket index.
     */
    const ratio = (x - GRID_LEFT) / plotWidth;

    const bucketIndex = Math.round(ratio * (buckets.length - 1));

    if (bucketIndex < 0 || bucketIndex >= buckets.length) {
      return;
    }

    const bucket = buckets[bucketIndex];

    if (!bucket) {
      return;
    }

    console.log(
      "[LatencyPanel] selecting bucket",
      bucketIndex,
      bucket.timestampMs,
    );

    setSelectedBucketTimestamp(bucket.timestampMs);
  };
  /* ------------------------------------------------------------------------ */
  /* HEATMAP + PERCENTILE OVERLAY                                             */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const axis = buildAxisStyle(chartTheme);
    const heatmap = buildHeatmapBins(historicalBuckets);

    if (!heatmap) {
      setOption({
        animation: false,
        series: [],
      });

      return;
    }

    /*
     * Task #5: target label COUNT per range rather than a fixed bucket-index
     * step. The previous version (6/18/30, i.e. hardcoded 60s/180s/300s
     * spacing) silently assumed the range is always fully populated with
     * back-to-back 10-second buckets — accurate once there's a full window
     * of history, but it under-labels a range that's only partially filled
     * (e.g. 15m selected shortly after the gateway started, with only a few
     * minutes of buckets so far: 18-bucket steps would produce one, maybe
     * two, labels total). Deriving the step from the ACTUAL bucket count
     * that's present adapts automatically, while still giving 1h fewer
     * labels than 5m per the "should not become a wall" requirement — the
     * bucket cadence itself (10s) is unchanged, this only decides how many
     * of those buckets' labels are worth drawing.
     */
    const TARGET_X_LABEL_COUNT: Record<LatencyRange, number> = {
      "5m": 6,
      "15m": 8,
      "1h": 10,
    };

    /*
     * Irregular-looking gaps bug: formatAxisTime() displays whole minutes
     * (HH:MM), but bucket timestamps land on an exact 10-second wall-clock
     * grid (RollingStatsAggregator's bucketId = floor(atMs / 10_000)), so a
     * step of fewer than 6 buckets (60s) can land two candidate labels in
     * the SAME displayed minute depending on phase — e.g. 5m's target of 6
     * labels over ~30 buckets rounds to a 5-bucket (50s) step, which is
     * below the minute boundary. The dedup pass below then drops the
     * second colliding candidate rather than reflowing the remaining ones,
     * so the gap to the NEXT surviving label doubles right at that spot —
     * exactly the irregular spacing reported around 02:50/02:51 in a 5m
     * view. Flooring the step at 6 buckets guarantees every step crosses at
     * least one minute boundary, so the dedup pass becomes a no-op safety
     * net (for genuine data gaps) instead of something that fires on
     * every render.
     */
    const MIN_X_LABEL_STEP_BUCKETS = 6;

    const xLabelEvery = Math.max(
      MIN_X_LABEL_STEP_BUCKETS,
      Math.round(
        historicalBuckets.length / TARGET_X_LABEL_COUNT[historicalRange],
      ),
    );

    /*
     * Stepping by xLabelEvery alone isn't enough to avoid duplicate visible
     * labels: buckets aren't guaranteed to land exactly xLabelEvery*10s apart
     * (a late/skipped bucket shifts the phase), so two stepped indices that
     * are NOT pixel-overlapping (hideOverlap only catches that case) can
     * still format to the same displayed hour:minute. Precompute, once, the
     * exact set of indices to show: step by xLabelEvery, but skip any
     * candidate whose formatted label repeats the last one actually shown.
     * Computed up front (not inside the interval callback below) so there's
     * no render-order-dependent mutation happening during ECharts' own
     * label-measurement passes.
     */
    const shownXLabelIndices = new Set<number>();
    {
      let previousLabel: string | null = null;

      for (
        let index = 0;
        index < historicalBuckets.length;
        index += xLabelEvery
      ) {
        const label = formatAxisTime(historicalBuckets[index]!.timestampMs);

        if (label !== previousLabel) {
          shownXLabelIndices.add(index);
          previousLabel = label;
        }
      }
    }

    /* Roughly 8–10 readable Y labels regardless of the number of bins. */
    const yLabelInterval = Math.max(0, Math.ceil(heatmap.bins.length / 9) - 1);

    // highlightedBucketIndex is now hoisted to component scope (see its own
    // comment there) — this closes over that outer value; it's what
    // actually drives the overlay series' data below.
    const hoveredBucket =
      highlightedBucketIndex >= 0
        ? (historicalBuckets[highlightedBucketIndex] ?? null)
        : null;

    /* ---------------------------------------------------------------------- */
    /* PERCENTILE / MAX FOREGROUND                                            */
    /* ---------------------------------------------------------------------- */

    /*
     * The heatmap must use a category Y-axis because ECharts requires two
     * category axes for a cartesian heatmap. The percentile overlays therefore
     * use a second, hidden value Y-axis so they retain their real latency
     * values instead of being quantized into heatmap bins.
     *
     * Task #6 (overlap readability): all three line series now share
     * smooth: 0 (straight segments, no spline). Previously P50/P99 used
     * 0.08 and P99.9 used 0.06 — close but mismatched smoothing factors on
     * lines whose VALUES are already close is what was actually collapsing
     * them into an indistinguishable band: each series' bezier curve
     * between two real sample points bows by a slightly different amount,
     * so two lines with nearly equal values can drift apart or cross
     * between buckets in ways that reflect the smoothing math, not the real
     * data — visual noise on top of an already-tight gap. Straight segments
     * between the exact same [bucketIndex, valueUs] points remove that
     * noise entirely; the plotted values themselves are unchanged. P99 is
     * also now the only crisp (no shadowBlur) solid line — P99.9 keeps its
     * glow and switches to a longer, bolder dash pattern — so "glowing +
     * dashed" vs "solid + crisp" is a second cue that survives even where
     * color alone would be hard to tell apart at a glance.
     *
     * These four series are still genuinely STATIC — every render passes the
     * exact same [bucketIndex, valueUs] tuples regardless of hover state.
     * The hover highlight used to live HERE instead, as a per-point
     * symbolSize/itemStyle toggle (0 everywhere, large-with-shadowBlur at
     * hoveredBucketIndex) baked into these series' own `data`. That's what
     * caused the trailing ghost dot: toggling a glowing (shadowBlur) symbol
     * on a POINT THAT REMAINS PART OF THE SERIES is a mutation, not an
     * add/remove, and zrender's canvas renderer does incremental
     * dirty-rectangle repainting for performance — the blur radius paints
     * pixels outside the box the renderer invalidates for a same-point
     * property change, so on a fast sweep (mousemove firing across many
     * separate browser tasks, each one its own setOption before the next
     * frame's repaint fully covers the previous glow) a soft leftover
     * could survive until a later, larger repaint happened to cover that
     * region — which is exactly the "trail disappears shortly afterward on
     * its own" symptom (a stale index would NOT self-heal without further
     * input; a paint artifact does). animationDurationUpdate:0 was already
     * correct and stays — this was never an animation/timing bug, it was a
     * canvas-repaint bug from mutating a retained point's glow every frame.
     * See hoverOverlaySeries below for the actual fix.
     */
    const percentileSeries = [
      /* ---------------------------------------------------------------------- */
      /* P50                                                                     */
      /* ---------------------------------------------------------------------- */
      {
        name: "P50",
        type: "line" as const,
        yAxisIndex: 1,
        z: 14,

        showSymbol: true,
        symbol: "circle",
        symbolSize: 0,
        smooth: 0,

        animationDurationUpdate: 0,
        animationEasingUpdate: "cubicOut" as const,

        emphasis: {
          disabled: true,
        },

        /*
         * Colour hierarchy: P50 is the baseline, meant to read as clearly
         * subordinate to P99 (bold + crisp) and P99.9 (dashed + glow — see
         * below). Token unchanged (chartTheme.heatCool, matching the legend
         * and tooltip row) — width/opacity are what recede it.
         */
        lineStyle: {
          color: chartTheme.heatCool,
          width: 1.5,
          opacity: 0.65,
        },

        data: visibleMetrics.p50
          ? historicalBuckets.map((bucket, bucketIndex) => [
              bucketIndex,
              bucket.total.p50Ns / 1_000,
            ])
          : [],
      },

      /* ---------------------------------------------------------------------- */
      /* P99                                                                     */
      /* ---------------------------------------------------------------------- */
      {
        name: "P99",
        type: "line" as const,
        yAxisIndex: 1,
        z: 15,

        showSymbol: true,
        symbol: "circle",
        symbolSize: 0,
        smooth: 0,

        animationDurationUpdate: 0,
        animationEasingUpdate: "cubicOut" as const,

        emphasis: {
          disabled: true,
        },

        /*
         * The primary tail signal: bold and crisp (no shadowBlur — the glow
         * moved to being P99.9's own distinguishing trait). Widened from
         * 1.75 to 2 so it's unambiguously the thickest line even where
         * P99.9 sits right on top of it; "solid, bold, no glow" vs "dashed,
         * glowing" is a shape/texture cue that still works when the two
         * are numerically close enough that colour alone is hard to split.
         */
        lineStyle: {
          color: chartTheme.heatWarm,
          width: 2,
          opacity: 1,
        },

        data: visibleMetrics.p99
          ? historicalBuckets.map((bucket, bucketIndex) => [
              bucketIndex,
              bucket.total.p99Ns / 1_000,
            ])
          : [],
      },

      /* ---------------------------------------------------------------------- */
      /* P99.9                                                                   */
      /* ---------------------------------------------------------------------- */
      {
        name: "P99.9",
        type: "line" as const,
        yAxisIndex: 1,
        z: 16,

        showSymbol: true,
        symbol: "circle",
        symbolSize: 0,
        smooth: 0,

        animationDurationUpdate: 0,
        animationEasingUpdate: "cubicOut" as const,

        emphasis: {
          disabled: true,
        },

        /*
         * Severe tail: dashed + glowing is its own distinguishing pair,
         * deliberately different from P99's solid-crisp treatment rather
         * than just a thinner/fainter version of it. A custom, longer dash
         * ([6, 4] instead of ECharts' default short dash) reads clearly as
         * "broken line" even where it's laid directly over P99's solid
         * stroke — the default dash is fine on its own but can visually
         * smear into a solid-looking band once smooth:0 removes the spline
         * (which used to distort the dash spacing along curves anyway).
         */
        lineStyle: {
          color: chartTheme.heatHot,
          width: 1.5,
          opacity: 1,
          type: [6, 4],
          shadowBlur: 2.5,
          shadowColor: chartTheme.heatHot,
        },

        data: visibleMetrics.p999
          ? historicalBuckets.map((bucket, bucketIndex) => [
              bucketIndex,
              bucket.total.p999Ns / 1_000,
            ])
          : [],
      },

      /* ---------------------------------------------------------------------- */
      /* MAX                                                                     */
      /* ---------------------------------------------------------------------- */
      {
        name: "Max",
        type: "scatter" as const,
        yAxisIndex: 1,
        z: 17,

        symbol: "diamond",
        /*
         * Extreme-event marker: already z:17, the topmost of the four
         * percentile series, so it was never actually hidden BEHIND a
         * line — but a small flat diamond sitting exactly where a bold P99
         * line or a dashed+glowing P99.9 line passes through the same
         * point could still read as just a kink in that line rather than
         * its own distinct marker. Slightly larger (8 -> 9) plus its own
         * subtle glow (previously only the hover-highlighted Max got a
         * shadow) gives it a visual halo that separates it from whatever
         * line is directly underneath, without needing to move it off its
         * real value.
         */
        symbolSize: 9,

        animationDurationUpdate: 0,

        emphasis: {
          disabled: true,
        },

        itemStyle: {
          color: chartTheme.heatCrit,
          borderColor: chartTheme.panel,
          borderWidth: 1,
          shadowBlur: 3,
          shadowColor: chartTheme.heatCrit,
        },

        data: visibleMetrics.max
          ? historicalBuckets.map((bucket, bucketIndex) => [
              bucketIndex,
              bucket.total.maxNs / 1_000,
            ])
          : [],
      },
    ];

    /* ---------------------------------------------------------------------- */
    /* HOVER OVERLAY (the actual highlight mechanism)                         */
    /* ---------------------------------------------------------------------- */

    /*
     * A dedicated series per percentile line, holding AT MOST ONE point —
     * the currently hovered bucket's value on that line, or none at all
     * when nothing is hovered. This is the user's own stated preference:
     * the real series stay static, and the hover state is a genuine
     * add/remove of a small overlay rather than a property mutation on a
     * point that was always going to be part of the series anyway. An
     * empty `data: []` here means zrender has nothing to paint for this
     * series at all — there is no "residual" position for a ghost to leak
     * from, unlike toggling a retained point's symbolSize back to 0.
     *
     * silent + tooltip.show:false: these exist purely as a visual
     * highlight, not an interactive target — the manual mousemove handler
     * above already does all real hit-testing, and the axis-trigger
     * tooltip's own bucket resolution (the formatter below) explicitly
     * matches on seriesName "P50"/"P99"/"P99.9"/"Max", so naming these
     * differently keeps them out of that lookup automatically; show:false
     * additionally keeps them from ever appearing as their own tooltip row.
     */
    /*
     * Always exactly 4 series (never conditionally spread in/out of the
     * array) — only `data` toggles between `[]` and one point. Relying on
     * the SERIES ARRAY ITSELF changing length between setOption calls would
     * mean ECharts' default (unkeyed, positional) merge has to infer a
     * removal every time the mouse leaves the chart, which is exactly the
     * kind of implicit, "usually right, occasionally not" behavior that
     * produced the original ghost in the first place. A series that legally
     * exists with zero data points is unambiguous; ECharts simply has
     * nothing to paint for it, full stop.
     */
    const hoverOverlaySeries = [
      {
        name: "P50 hover",
        type: "scatter" as const,
        yAxisIndex: 1,
        z: 24,
        silent: true,
        animation: false,
        tooltip: { show: false },
        emphasis: { disabled: true },
        symbol: "circle",
        symbolSize: 10,
        itemStyle: {
          color: chartTheme.heatCool,
          borderColor: chartTheme.panel,
          borderWidth: 2,
          shadowBlur: 6,
          shadowColor: chartTheme.heatCool,
        },
        data:
          hoveredBucket && visibleMetrics.p50
            ? [[highlightedBucketIndex, hoveredBucket.total.p50Ns / 1_000]]
            : [],
      },
      {
        name: "P99 hover",
        type: "scatter" as const,
        yAxisIndex: 1,
        z: 25,
        silent: true,
        animation: false,
        tooltip: { show: false },
        emphasis: { disabled: true },
        symbol: "circle",
        symbolSize: 11,
        itemStyle: {
          color: chartTheme.heatWarm,
          borderColor: chartTheme.panel,
          borderWidth: 2,
          shadowBlur: 7,
          shadowColor: chartTheme.heatWarm,
        },
        data:
          hoveredBucket && visibleMetrics.p99
            ? [[highlightedBucketIndex, hoveredBucket.total.p99Ns / 1_000]]
            : [],
      },
      {
        name: "P99.9 hover",
        type: "scatter" as const,
        yAxisIndex: 1,
        z: 26,
        silent: true,
        animation: false,
        tooltip: { show: false },
        emphasis: { disabled: true },
        symbol: "circle",
        symbolSize: 10,
        itemStyle: {
          color: chartTheme.heatHot,
          borderColor: chartTheme.panel,
          borderWidth: 2,
          shadowBlur: 7,
          shadowColor: chartTheme.heatHot,
        },
        data:
          hoveredBucket && visibleMetrics.p999
            ? [[highlightedBucketIndex, hoveredBucket.total.p999Ns / 1_000]]
            : [],
      },
      {
        name: "Max hover",
        type: "scatter" as const,
        yAxisIndex: 1,
        z: 27,
        silent: true,
        animation: false,
        tooltip: { show: false },
        emphasis: { disabled: true },
        symbol: "diamond",
        symbolSize: 14,
        itemStyle: {
          color: chartTheme.heatCrit,
          borderColor: chartTheme.panel,
          borderWidth: 2,
          shadowBlur: 8,
          shadowColor: chartTheme.heatCrit,
        },
        data:
          hoveredBucket && visibleMetrics.max
            ? [[highlightedBucketIndex, hoveredBucket.total.maxNs / 1_000]]
            : [],
      },
    ];

    /* ---------------------------------------------------------------------- */
    /* CHART OPTION                                                            */
    /* ---------------------------------------------------------------------- */

    setOption({
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 0,
      animationEasingUpdate: "cubicOut" as const,

      grid: {
        top: 20,
        right: 24,
        bottom: 58,
        left: 72,
      },

      /*
       * One bucket-level tooltip for the whole combined visualization.
       * "samples" refers to the entire 10-second bucket, not one heatmap cell.
       */
      tooltip: {
        ...buildTooltipStyle(chartTheme),

        trigger: "axis",
        triggerOn: "mousemove",
        confine: true,
        position: buildTooltipPosition(58),

        axisPointer: {
          type: "line",
          snap: true,
          lineStyle: {
            opacity: 0,
          },
        },

        formatter: (rawParams) => {
          const params = Array.isArray(rawParams) ? rawParams : [rawParams];

          /*
           * Use an overlay series' dataIndex instead of axisValue.
           * ECharts' CallbackDataParams type does not expose axisValue here,
           * while dataIndex is available and maps 1:1 to historical buckets
           * for P50/P99/P99.9/Max.
           */
          const anchorParam = params.find(
            (param) =>
              param.seriesName === "P50" ||
              param.seriesName === "P99" ||
              param.seriesName === "P99.9" ||
              param.seriesName === "Max",
          );

          const bucketIndex =
            anchorParam && Number.isInteger(anchorParam.dataIndex)
              ? anchorParam.dataIndex
              : -1;

          if (bucketIndex < 0 || bucketIndex >= historicalBuckets.length) {
            return "";
          }

          const bucket = historicalBuckets[bucketIndex];

          if (!bucket) {
            return "";
          }

          const timestamp = bucket.timestampMs;

          /*
           * Task #4: a toggled-off metric's series has empty `data`, so it
           * already can't be the anchorParam above — but without this guard
           * its row would still render here unconditionally (bucket.total.*
           * doesn't know about visibility). Skip rows for hidden metrics so
           * the tooltip reflects only what's actually drawn on the chart.
           */
          const rows: string[] = [];

          /*
           * Fixed-width label column (inline-block) so every value lines up
           * at the same x-offset regardless of label length — "P99.9:" is
           * the longest (6 chars incl. colon), so that sets the width; the
           * shorter labels (P50/P99/Max) pad out to match instead of the
           * value after them drifting right. Colon included INSIDE the
           * coloured span so label+colon read as one coloured unit.
           */
          const TOOLTIP_LABEL_WIDTH_PX = 42;

          const tooltipRow = (label: string, color: string, valueNs: number) =>
            `<div><span style="display:inline-block;width:${TOOLTIP_LABEL_WIDTH_PX}px;color:${color}">${label}:</span> <strong>${formatLatencyNs(
              valueNs,
            )}</strong></div>`;

          if (visibleMetrics.p50) {
            rows.push(tooltipRow("P50", chartTheme.heatCool, bucket.total.p50Ns));
          }

          if (visibleMetrics.p99) {
            rows.push(tooltipRow("P99", chartTheme.heatWarm, bucket.total.p99Ns));
          }

          if (visibleMetrics.p999) {
            rows.push(
              tooltipRow("P99.9", chartTheme.heatHot, bucket.total.p999Ns),
            );
          }

          if (visibleMetrics.max) {
            rows.push(tooltipRow("Max", chartTheme.heatCrit, bucket.total.maxNs));
          }

          return [
            `<strong>${formatBucketTime(timestamp)}</strong>`,

            `<div style="margin-top:4px;opacity:.7;font-size:11px;line-height:1.5">10-second bucket<br />${
              bucket.total.count
            } samples</div>`,

            `<div style="margin-top:8px;line-height:1.75">`,

            ...rows,

            `</div>`,
          ].join("");
        },
      },

      /* -------------------------------------------------------------------- */
      /* DENSITY COLOR MAPPING                                                 */
      /* -------------------------------------------------------------------- */

      /*
       * Keep visualMap because the heatmap relies on it for density -> color
       * mapping, but hide the UI legend so it does not compete with the data.
       *
       * CONTRAST root cause (from the prior pass, still valid — inspecting
       * the actual numbers, not guessing at opacity): this is a LINEAR scale
       * from 0 to the single densest cell's count. Real latency histograms
       * are heavily right-skewed — one or two bins spike far above the rest
       * — so `heatmap.maxDensity` is an outlier, not a representative "busy"
       * value. Under a linear 0..max mapping most ordinary cells land in
       * only the bottom fifth of the range. `max` and the series data below
       * are both sqrt-compressed so the bulk of cells spread further up the
       * color ramp instead of bunching at the bottom. Display transform
       * only — heatmap.data / counts[] / maxDensity (still the real value,
       * used for the legend's tooltip) are untouched.
       *
       * COLOUR root cause (this pass): the heatmap previously stepped
       * through the same heatCool -> heatWarm -> heatHot -> heatCrit
       * thermal ramp as the percentile lines. That's wrong for a background
       * density field — those four tokens are deliberately alarm/severity
       * colors (warm/hot/critical), so a "busy" cell in the heatmap read as
       * an alarm signal competing with P99.9/Max for attention, rather than
       * quiet statistical context. A single restrained tint instead, varied
       * only by opacity.
       *
       * REGRESSION (fixed here): that single tint was chartTheme.muted for
       * one render, which produced solid BLACK cells. Root cause — every
       * OTHER token this file uses (parse/ask/bid/severe/heatCool etc.) is
       * backed by a plain hex custom property in globals.css, but
       * --muted-foreground is defined as oklch(...). resolveVar()'s browser
       * round-trip (assign to a probe element's `color`, read back
       * getComputedStyle) can hand back that oklch(...) string VERBATIM on
       * engines that preserve wide-gamut color functions in computed style,
       * instead of normalizing to rgb(...). withAlpha()'s regex only
       * matches rgb()/rgba(), so it silently passed the unparseable oklch
       * string straight through with no alpha applied — and zrender's own
       * lightweight color parser doesn't understand oklch() syntax at all,
       * so it fell back to black. Fix: use chartTheme.parse instead — hex-
       * backed in both themes (see globals.css), so it's guaranteed to
       * round-trip through resolveVar() as rgb(...) and survive
       * withAlpha()'s regex. Still a restrained, single, low-opacity tint
       * (not the alarm ramp), still distinct from heatWarm/heatHot/heatCrit,
       * and still repaints correctly on a light/dark toggle since --parse
       * itself is theme-aware.
       */
      visualMap: {
        show: false,
        seriesIndex: 0,
        min: 0,
        max: Math.sqrt(Math.max(1, heatmap.maxDensity)),
        calculable: false,
        hoverLink: false,

        inRange: {
          color: HEATMAP_DENSITY_OPACITY_STOPS.map((stop) =>
            withAlpha(chartTheme.parse, stop),
          ),
        },
      },

      /* -------------------------------------------------------------------- */
      /* X AXIS                                                               */
      /* -------------------------------------------------------------------- */

      xAxis: {
        ...axis,
        type: "category",
        data: historicalBuckets.map((bucket) => String(bucket.timestampMs)),

        name: `Local time (${getGmtOffsetLabel()})`,
        nameLocation: "middle",
        nameGap: 30,

        nameTextStyle: {
          ...axis.nameTextStyle,
          fontWeight: 700,
        },

        axisLabel: {
          ...axis.axisLabel,
          fontSize: 10,
          fontWeight: 500,
          hideOverlap: true,
          interval: (index: number) => shownXLabelIndices.has(index),
          formatter: (value: string) => formatAxisTime(Number(value)),
        },

        axisTick: {
          show: false,
        },

        /*
         * Was show:false — inconsistent with the Y axis (yAxis[0] inherits
         * axisLine: {show:true} from buildAxisStyle() via ...axis, which is
         * the vertical line visible on the left). Explicitly matching that
         * here instead of overriding it away, so the plot has a baseline on
         * both edges rather than one.
         */
        axisLine: {
          show: true,
          lineStyle: {
            color: chartTheme.border,
          },
        },

        splitLine: {
          show: false,
        },

        axisPointer: {
          show: true,
          snap: true,

          lineStyle: {
            opacity: 0,
          },

          label: {
            show: false,
          },
        },
      },

      /* -------------------------------------------------------------------- */
      /* Y AXES                                                               */
      /* -------------------------------------------------------------------- */

      yAxis: [
        /*
         * Heatmap axis: category coordinates matching display bins.
         *
         * Task #5: labeled with each bin's LOWER boundary instead of its
         * CENTER. chooseHeatmapBinSize() picks binSizeUs from a "nice
         * numbers" list (0.25, 0.5, 1, 2, 5, 10, 25, 50 µs, ...), so a bin's
         * lower edge (index * binSizeUs) is always a clean multiple of that
         * step — e.g. 0, 10, 20, 30 µs — while its center is that value plus
         * half a step (5, 15, 25, 35 µs), which reads as an arbitrary offset
         * next to round P50/P99/P99.9/Max values. This is a label-only
         * change: the `data` array is still exactly one entry per bin, in
         * the same order, so the heatmap's own `data` (which addresses rows
         * by binIndex/position, not by this label text) and the hidden
         * continuous overlay axis (still spanning the same
         * [0, heatmap.bins[last].upperUs] domain below, untouched) keep
         * lining up with the visible axis exactly as before.
         */
        {
          ...axis,
          type: "category",
          data: heatmap.bins.map((bin) => String(bin.lowerUs)),

          name: "Latency (µs)",
          nameLocation: "middle",
          nameGap: 48,

          nameTextStyle: {
            ...axis.nameTextStyle,
            fontSize: 11,
            fontWeight: 700,
          },

          axisLabel: {
            ...axis.axisLabel,
            fontSize: 10,
            fontWeight: 500,
            interval: yLabelInterval,
            formatter: (value: string) =>
              `${Number(value).toFixed(Number(value) < 10 ? 1 : 0)} µs`,
          },

          axisTick: {
            show: false,
          },

          splitLine: {
            show: false,
          },
        },

        /* Overlay axis: real continuous latency values. */
        {
          type: "value",
          min: 0,
          max: heatmap.bins[heatmap.bins.length - 1]?.upperUs ?? 1,
          show: false,
          position: "left",

          axisLabel: {
            show: false,
          },

          axisTick: {
            show: false,
          },

          axisLine: {
            show: false,
          },

          splitLine: {
            show: false,
          },
        },
      ],

      /* -------------------------------------------------------------------- */
      /* SERIES                                                                */
      /* -------------------------------------------------------------------- */

      series: [
        {
          name: "Latency distribution",
          type: "heatmap" as const,
          coordinateSystem: "cartesian2d",
          yAxisIndex: 0,
          z: 1,

          /*
           * sqrt() the color-mapped value only — matches visualMap.max's
           * sqrt() above so the two stay in the same units. The bucket
           * index and bin index (first two tuple elements) are untouched;
           * this is purely how the third element maps to a color.
           */
          data: heatmap.data.map(([bucketIndex, binIndex, density]) => [
            bucketIndex,
            binIndex,
            Math.sqrt(density),
          ]),
          progressive: 4000,
          animation: false,

          itemStyle: {
            borderWidth: 0,
          },

          /* Do not paint a selected cell/column on hover. */
          emphasis: {
            disabled: true,
          },
        },

        ...percentileSeries,
        ...hoverOverlaySeries,
      ],
    });
  }, [
    historicalBuckets,
    historicalRange,
    hoveredBucketIndex,
    selectedBucketIndex,
    visibleMetrics,
    setOption,
    chartTheme,
  ]);

  /* ------------------------------------------------------------------------ */
  /* RENDER                                                                   */
  /* ------------------------------------------------------------------------ */

  return (
    <div
      ref={panelRootRef}
      className="relative flex h-full min-h-0 flex-col text-xs"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {/* ------------------------------------------------------------------ */}
        {/* HISTORICAL SUMMARY                                                  */}
        {/* ------------------------------------------------------------------ */}

        <div className="shrink-0 rounded-lg border border-border bg-panel p-3">
          {/* HEADER */}

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">
                Historical Summary
              </div>

              <div className="text-[11px] text-muted-foreground">
                Last {formatRangeLabel(historicalRange)}
                {isPartialHistory && (
                  <span
                    className="text-muted-foreground/70"
                    title="The relay/gateway hasn't been collecting for a full selected range yet — this will fill in as more history accumulates."
                  >
                    {" "}
                    ({formatShortDuration(actualHistorySpanMs)} of history
                    available)
                  </span>
                )}{" "}
                • {historicalLatency ? historicalLatency.count : 0} samples
              </div>
            </div>

            <div className="flex rounded-md border border-border p-0.5">
              {(["5m", "15m", "1h"] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() => {
                    setHistoricalRange(range);
                  }}
                  className={`rounded px-2 py-1 text-[11px] ${
                    historicalRange === range
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>

          {/* KPI CARDS */}

          <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {/* P50 */}

            <div className="rounded-lg border border-border bg-panel p-3 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <MetricIcon metric="p50" />

                  <span className="text-[11px] font-medium uppercase tracking-wide">
                    P50
                  </span>

                  <MetricHint>
                    Median latency across the selected range.
                  </MetricHint>
                </div>
              </div>

              <div className="mt-1 text-xl font-semibold tabular-nums text-muted-foreground">
                {historicalLatency
                  ? formatLatencyNs(historicalLatency.p50Ns)
                  : "—"}
              </div>
            </div>

            {/* P99 */}

            <div className="rounded-lg border border-border bg-panel p-3 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-primary">
                  <MetricIcon metric="p99" />

                  <span className="text-[11px] font-medium uppercase tracking-wide">
                    P99
                  </span>

                  <MetricHint>
                    99% of observations are at or below this latency.
                  </MetricHint>
                </div>
              </div>

              <div className="mt-1 text-xl font-semibold tabular-nums text-primary">
                {historicalLatency
                  ? formatLatencyNs(historicalLatency.p99Ns)
                  : "—"}
              </div>
            </div>

            {/* P99.9 */}

            <div className="rounded-lg border border-border bg-panel p-3 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-severe">
                  <MetricIcon metric="p999" />

                  <span className="text-[11px] font-medium uppercase tracking-wide">
                    P99.9
                  </span>

                  <MetricHint>
                    99.9% of observations are at or below this latency.
                  </MetricHint>
                </div>
              </div>

              <div className="mt-1 text-xl font-semibold tabular-nums text-severe">
                {historicalLatency
                  ? formatLatencyNs(historicalLatency.p999Ns)
                  : "—"}
              </div>
            </div>

            {/* MAX */}

            <div className="rounded-lg border border-border bg-panel p-3 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-destructive">
                  <MetricIcon metric="max" />

                  <span className="text-[11px] font-medium uppercase tracking-wide">
                    MAX
                  </span>

                  <MetricHint>
                    Highest observed latency in the selected range.
                  </MetricHint>
                </div>
              </div>

              <div className="mt-1 text-xl font-semibold tabular-nums text-destructive">
                {historicalLatency
                  ? formatLatencyNs(historicalLatency.maxNs)
                  : "—"}
              </div>
            </div>
          </div>

          {/* PEAK TAIL + STAGE BREAKDOWN */}

          <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
            {/* PEAK TAIL */}

            <button
              type="button"
              onClick={() => {
                if (latestSpike) {
                  setSelectedBucketTimestamp(latestSpike.timestampMs);
                }
              }}
              className="rounded-lg border border-border bg-panel p-3 text-left transition hover:border-severe/50 hover:bg-muted/40 lg:col-span-1"
            >
              <div className="mb-2 text-sm font-medium text-foreground">
                Peak Tail
              </div>

              {latestSpike && latestSpikeStage ? (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-2xl font-semibold tabular-nums text-severe">
                      {formatLatencyNs(latestSpike.total.maxNs)}
                    </div>

                    <span className="text-[11px] text-muted-foreground">
                      {formatAge(latestSpike.timestampMs)}
                    </span>
                  </div>

                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {latestSpikeStage.name}
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[10px]">
                    <span className="text-muted-foreground">
                      Inspect bucket
                    </span>

                    <span className="font-medium text-foreground">→</span>
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No historical data
                </div>
              )}
            </button>

            {/* STAGE BREAKDOWN */}

            <div className="rounded-lg border border-border bg-panel p-3 lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    Stage Breakdown
                  </div>

                  {stageBreakdown && (
                    <div className="text-[11px] text-muted-foreground">
                      {selectedBucket ? "Selected bucket" : "Latest bucket"} ·{" "}
                      {formatBucketTime(stageBreakdown.bucket.timestampMs)}
                    </div>
                  )}
                </div>

                {stageBreakdown && (
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Total P99
                    </div>

                    <div className="text-sm font-semibold tabular-nums text-foreground">
                      {formatLatencyNs(stageBreakdown.bucket.total.p99Ns)}
                    </div>
                  </div>
                )}
              </div>

              {stageBreakdown ? (
                <>
                  <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                    {stageBreakdown.stages.map((stage) => (
                      <button
                        key={stage.name}
                        type="button"
                        onClick={() =>
                          setHighlightedStage((current) =>
                            current === stage.key ? null : stage.key,
                          )
                        }
                        title={`Highlight ${stage.name} in Stage Latency Breakdown`}
                        aria-label={`Highlight ${stage.name} in Stage Latency Breakdown`}
                        className="cursor-pointer transition-[width] duration-500 ease-out hover:brightness-110"
                        style={{
                          width: `${stage.percentage}%`,
                          backgroundColor: `color-mix(in srgb, ${stage.color} 75%, ${chartTheme.text} 25%)`,
                        }}
                      />
                    ))}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                    {stageBreakdown.stages.map((stage) => (
                      <button
                        key={stage.name}
                        type="button"
                        onClick={() =>
                          setHighlightedStage((current) =>
                            current === stage.key ? null : stage.key,
                          )
                        }
                        title={`Highlight ${stage.name} in Stage Latency Breakdown`}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-muted/50"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
                            style={{
                              backgroundColor: `color-mix(in srgb, ${stage.color} 75%, ${chartTheme.text} 25%)`,
                            }}
                          />

                          <span className="text-muted-foreground">
                            {stage.name}
                          </span>
                        </div>

                        <span className="tabular-nums text-foreground">
                          {formatLatencyNs(stage.valueNs)} (
                          {formatPercentage(stage.percentage)})
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No historical data
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* HISTORICAL LATENCY DISTRIBUTION                                    */}
        {/* ------------------------------------------------------------------ */}

        {/* shrink-0: this flex column (the LatencyPanel scroll area above)
            has a genuinely definite height at lg+ (the right column is
            stretched to the viewport-bound row), and its children default
            to flex-shrink:1 — without shrink-0, when the three cards'
            combined natural content exceeded that height, the browser
            shrank THIS card's box down to its min-h-[300px] floor (a
            flex-shrink target, not a true minimum) while the chart canvas
            below — a plain block child, still rendered at its own fixed
            h-[360px] regardless of the shrunken parent — kept its full
            height and, with no overflow-hidden on this card to catch it,
            visually spilled straight past the shrunk boundary into Stage
            Latency Breakdown underneath. shrink-0 keeps this card (and its
            two siblings, see their own shrink-0) at their real content
            height; the scroll area's own overflow-y-auto already handles
            revealing whatever doesn't fit, exactly as intended. */}
        <div className="min-h-[300px] w-full shrink-0 rounded-lg border border-border bg-panel p-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <div>
              <div className="text-sm font-medium text-foreground">
                Latency Distribution
              </div>

              <div className="text-[10px] font-semibold text-muted-foreground">
                Histogram + Line Chart
              </div>

              {/* Density scale — lives in the header, directly under the
                  subtitle, left-aligned. Not inside the plotting area (an
                  earlier pass tried an absolutely-positioned overlay on top
                  of the chart; moved back out to the header on request) and
                  not sharing the percentile-chip row on the right (that row
                  stays P50/P99/P99.9/Max only). Same chartTheme.parse +
                  HEATMAP_DENSITY_OPACITY_STOPS the actual heatmap visualMap
                  resolves to (see that block's comment for why parse, not
                  muted), so this can never show a different scale than the
                  heatmap it's describing. "Sample density" sits on its own
                  line, with the bar and its "fewer -> more samples" caption
                  stacked directly beneath, both the same width (w-28) so
                  the caption lines up under the bar instead of trailing off
                  to one side of it. No title/tooltip here any more — the
                  caption alone was judged sufficient explanation, and the
                  hover text's "(busiest cell: N samples)" aside read as
                  clutter on top of that. */}
              <div className="mt-1 flex flex-col gap-1 text-muted-foreground">
                <span className="text-[11px] whitespace-nowrap">
                  Sample density
                </span>

                <div
                  className="h-3 w-28 overflow-hidden rounded-full border border-border/50"
                  style={{
                    background: `linear-gradient(to right, ${HEATMAP_DENSITY_OPACITY_STOPS.map(
                      (stop) => withAlpha(chartTheme.parse, stop),
                    ).join(", ")})`,
                  }}
                />

                <span className="w-28 whitespace-nowrap text-center text-[9px] text-muted-foreground/70">
                  fewer → more samples
                </span>
              </div>
            </div>

            {/* Percentile legend — now also the Task #4 visibility toggle:
                each chip is a button that flips that metric's entry in
                visibleMetrics, which gates that series' (and its hover
                overlay's) `data` above. Colours/labels are unchanged; the
                only new thing is opacity + aria-pressed on the chip itself
                to make the on/off state obvious, and cursor-pointer/hover
                feedback so it reads as interactive. The density scale lives
                in the header block on the left instead of sharing this
                row. */}
            <div className="flex items-center gap-3 text-[10px]">
              <button
                type="button"
                onClick={() => toggleMetric("p50")}
                aria-pressed={visibleMetrics.p50}
                title={
                  visibleMetrics.p50 ? "Hide P50" : "Show P50"
                }
                className={`flex items-center gap-1 rounded px-1 py-0.5 transition-opacity hover:opacity-100 ${
                  visibleMetrics.p50 ? "opacity-100" : "opacity-40"
                }`}
              >
                <span
                  className="h-1.5 w-4 rounded-full"
                  style={{
                    backgroundColor: chartTheme.heatCool,
                  }}
                />
                <span className="text-muted-foreground">P50</span>
              </button>

              <button
                type="button"
                onClick={() => toggleMetric("p99")}
                aria-pressed={visibleMetrics.p99}
                title={
                  visibleMetrics.p99 ? "Hide P99" : "Show P99"
                }
                className={`flex items-center gap-1 rounded px-1 py-0.5 transition-opacity hover:opacity-100 ${
                  visibleMetrics.p99 ? "opacity-100" : "opacity-40"
                }`}
              >
                <span
                  className="h-1.5 w-4 rounded-full"
                  style={{
                    backgroundColor: chartTheme.heatWarm,
                  }}
                />
                <span className="text-muted-foreground">P99</span>
              </button>

              <button
                type="button"
                onClick={() => toggleMetric("p999")}
                aria-pressed={visibleMetrics.p999}
                title={
                  visibleMetrics.p999 ? "Hide P99.9" : "Show P99.9"
                }
                className={`flex items-center gap-1 rounded px-1 py-0.5 transition-opacity hover:opacity-100 ${
                  visibleMetrics.p999 ? "opacity-100" : "opacity-40"
                }`}
              >
                <span
                  className="h-0 w-4 border-t border-dashed"
                  style={{
                    borderColor: chartTheme.heatHot,
                  }}
                />
                <span className="text-muted-foreground">P99.9</span>
              </button>

              <button
                type="button"
                onClick={() => toggleMetric("max")}
                aria-pressed={visibleMetrics.max}
                title={
                  visibleMetrics.max ? "Hide Max" : "Show Max"
                }
                className={`flex items-center gap-1 rounded px-1 py-0.5 transition-opacity hover:opacity-100 ${
                  visibleMetrics.max ? "opacity-100" : "opacity-40"
                }`}
              >
                <span
                  className="h-1.5 w-1.5 rotate-45"
                  style={{
                    backgroundColor: chartTheme.heatCrit,
                  }}
                />
                <span className="text-muted-foreground">Max</span>
              </button>
            </div>
          </div>

          <div
            ref={containerRef}
            onClick={handleHistoricalChartClick}
            className="h-[360px] w-full"
          />
        </div>

        <StageLatencyBreakdown
          historicalBuckets={historicalBuckets}
          chartTheme={chartTheme}
          highlightedBucketIndex={highlightedBucketIndex}
          highlightedStage={highlightedStage}
          portalTarget={panelRootRef}
        />
      </div>
    </div>
  );
}
