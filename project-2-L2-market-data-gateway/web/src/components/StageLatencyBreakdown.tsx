"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { EChartsOption } from "echarts";

import type { LatencyBucketSnapshot } from "@/lib/types";
import {
  aggregateHistoricalLatency,
  type LatencyStageKey,
} from "@/lib/latencySeries";
import {
  buildHeatmapBins,
  HEATMAP_DENSITY_OPACITY_STOPS,
  type HeatmapBuildResult,
} from "@/lib/heatmapBins";
import { useECharts } from "@/lib/useECharts";
import {
  buildAxisStyle,
  buildTooltipStyle,
  withAlpha,
  type ChartTheme,
} from "@/lib/chartTheme";
import {
  formatLatencyNs,
  formatBucketTime,
  formatAxisTime,
} from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* STAGE CONFIG                                                               */
/* -------------------------------------------------------------------------- */

export type PipelineStageKey = Exclude<LatencyStageKey, "total">;

interface StageConfig {
  key: PipelineStageKey;
  label: string;
}

const STAGES: readonly StageConfig[] = [
  { key: "inFrame", label: "In-Frame Wait" },
  { key: "parse", label: "Parse Latency" },
  { key: "queue", label: "Queue Latency" },
  { key: "bookUpdate", label: "Book-Update Latency" },
  { key: "publish", label: "Publish Latency" },
];

// Same colour each stage already uses in Stage Breakdown, above this
// section — parse/queue/bookUpdate/publish/inFrame all read off chartTheme's
// own dedicated tokens (see chartTheme.ts's comment on `publish` for why
// that field exists — Task #8's black-rendering fix). No new colours.
function stageColor(theme: ChartTheme, stage: PipelineStageKey): string {
  switch (stage) {
    case "inFrame":
      return theme.inFrame;
    case "parse":
      return theme.parse;
    case "queue":
      return theme.queue;
    case "bookUpdate":
      return theme.bookUpdate;
    case "publish":
      return theme.publish;
  }
}

/* -------------------------------------------------------------------------- */
/* SHARED STATS (mini card + preview both need the same numbers)             */
/* -------------------------------------------------------------------------- */

interface StageStats {
  latest: number | null;
  p50: number | null;
  p999: number | null;
  max: number | null;
}

function useStageStats(
  stage: PipelineStageKey,
  historicalBuckets: readonly LatencyBucketSnapshot[],
): StageStats {
  return useMemo(() => {
    const latestBucket = historicalBuckets[historicalBuckets.length - 1];
    const aggregated = aggregateHistoricalLatency(historicalBuckets, stage);

    return {
      latest: latestBucket ? latestBucket[stage].p99Ns : null,
      p50: aggregated ? aggregated.p50Ns : null,
      p999: aggregated ? aggregated.p999Ns : null,
      max: aggregated ? aggregated.maxNs : null,
    };
  }, [historicalBuckets, stage]);
}

/* -------------------------------------------------------------------------- */
/* SHARED CHART OPTION BUILDER                                                */
/* -------------------------------------------------------------------------- */

/*
 * One option builder for both the compact mini-card chart and the large
 * preview chart — same heatmap + line series construction either way, only
 * the grid/axis visibility and line weight differ by `variant`. Keeps the
 * two chart sizes from drifting into two different visual languages.
 */
function buildStageOption(params: {
  stage: StageConfig;
  historicalBuckets: readonly LatencyBucketSnapshot[];
  heatmap: HeatmapBuildResult;
  chartTheme: ChartTheme;
  color: string;
  variant: "compact" | "large";
  // Bucket index to mirror from the main Latency Distribution chart's own
  // hover/selection, -1 (or omitted) when nothing is highlighted. See the
  // dedicated overlay series below for why this isn't done via
  // dispatchAction — that was the multiple-dots ghost-trail bug.
  highlightedBucketIndex?: number;
}): EChartsOption {
  const {
    stage,
    historicalBuckets,
    heatmap,
    chartTheme,
    color,
    variant,
    highlightedBucketIndex = -1,
  } = params;
  const large = variant === "large";

  /*
   * Plain helper (not an EChartsOption formatter itself) so the formatter
   * passed inline in the returned option object below keeps its normal
   * contextual parameter typing from EChartsOption's own tooltip type,
   * rather than needing this function's params typed out by hand.
   */
  const tooltipContentForBucket = (bucketIndex: number): string => {
    if (bucketIndex < 0 || bucketIndex >= historicalBuckets.length) {
      return "";
    }

    const bucket = historicalBuckets[bucketIndex];

    if (!bucket) {
      return "";
    }

    const snapshot = bucket[stage.key];

    return [
      `<strong>${formatBucketTime(bucket.timestampMs)}</strong>`,
      `<div style="margin-top:4px"><span style="color:${color}">${stage.label}</span> <strong>${formatLatencyNs(
        snapshot.p99Ns,
      )}</strong></div>`,
    ].join("");
  };

  /*
   * Large variant only: same minimum-6-bucket-step + duplicate-label-skip
   * safeguard as the main Latency Distribution chart's own X axis (Task
   * #5's irregular-spacing fix) — a smaller, self-contained copy here
   * rather than sharing LatencyPanel's inline closures, since this chart's
   * grid/layout are different enough that little would actually be saved.
   */
  let shownXLabelIndices: Set<number> | null = null;

  if (large) {
    shownXLabelIndices = new Set<number>();
    const targetLabels = 6;
    const step = Math.max(
      6,
      Math.round(historicalBuckets.length / targetLabels),
    );
    let previousLabel: string | null = null;

    for (let index = 0; index < historicalBuckets.length; index += step) {
      const label = formatAxisTime(historicalBuckets[index]!.timestampMs);

      if (label !== previousLabel) {
        shownXLabelIndices.add(index);
        previousLabel = label;
      }
    }
  }

  const axis = large ? buildAxisStyle(chartTheme) : null;
  const yLabelInterval = large
    ? Math.max(0, Math.ceil(heatmap.bins.length / 6) - 1)
    : 0;

  return {
    animation: false,

    grid: large
      ? { top: 16, right: 20, bottom: 32, left: 56 }
      : { top: 6, right: 6, bottom: 6, left: 6 },

    tooltip: {
      ...buildTooltipStyle(chartTheme),
      trigger: "axis",
      triggerOn: "mousemove",
      confine: true,

      axisPointer: {
        type: "line",
        snap: true,
        lineStyle: { opacity: 0 },
      },

      formatter: (rawParams) => {
        const params = Array.isArray(rawParams) ? rawParams : [rawParams];

        const lineParam = params.find(
          (param) => param.seriesName === stage.label,
        );

        const bucketIndex =
          lineParam && Number.isInteger(lineParam.dataIndex)
            ? lineParam.dataIndex
            : -1;

        return tooltipContentForBucket(bucketIndex);
      },
    },

    visualMap: {
      show: false,
      seriesIndex: 0,
      min: 0,
      max: Math.sqrt(Math.max(1, heatmap.maxDensity)),
      calculable: false,
      hoverLink: false,

      inRange: {
        color: HEATMAP_DENSITY_OPACITY_STOPS.map((stop) =>
          withAlpha(color, stop),
        ),
      },
    },

    xAxis: large
      ? {
          ...axis,
          type: "category",
          data: historicalBuckets.map((bucket) => String(bucket.timestampMs)),
          axisLabel: {
            ...axis!.axisLabel,
            fontSize: 10,
            hideOverlap: true,
            interval: (index: number) =>
              shownXLabelIndices!.has(index),
            formatter: (value: string) => formatAxisTime(Number(value)),
          },
          axisTick: { show: false },
          splitLine: { show: false },
        }
      : {
          type: "category",
          data: historicalBuckets.map((bucket) => String(bucket.timestampMs)),
          show: false,
        },

    yAxis: large
      ? [
          {
            ...axis,
            type: "category",
            data: heatmap.bins.map((bin) => String(bin.lowerUs)),
            axisLabel: {
              ...axis!.axisLabel,
              fontSize: 10,
              interval: yLabelInterval,
              formatter: (value: string) =>
                `${Number(value).toFixed(Number(value) < 10 ? 1 : 0)} µs`,
            },
            axisTick: { show: false },
            splitLine: { show: false },
          },
          {
            type: "value",
            min: 0,
            max: heatmap.bins[heatmap.bins.length - 1]?.upperUs ?? 1,
            show: false,
          },
        ]
      : [
          {
            type: "category",
            data: heatmap.bins.map((bin) => String(bin.lowerUs)),
            show: false,
          },
          {
            type: "value",
            min: 0,
            max: heatmap.bins[heatmap.bins.length - 1]?.upperUs ?? 1,
            show: false,
          },
        ],

    series: [
      {
        name: "density",
        type: "heatmap",
        coordinateSystem: "cartesian2d",
        yAxisIndex: 0,
        z: 1,
        data: heatmap.data.map(([bucketIndex, binIndex, density]) => [
          bucketIndex,
          binIndex,
          Math.sqrt(density),
        ]),
        progressive: 4000,
        animation: false,
        itemStyle: { borderWidth: 0 },
        emphasis: { disabled: true },
      },
      {
        name: stage.label,
        type: "line",
        yAxisIndex: 1,
        z: 5,
        /*
         * showSymbol stays false (no permanent dots cluttering the line),
         * but symbolSize is a real size rather than 0 and emphasis is left
         * enabled — that's what makes ECharts draw a visible marker at
         * whichever point THIS chart's own mousemove/tooltip is currently
         * pointing at. This is the plain built-in ECharts hover symbol,
         * driven entirely inside zrender by the pointer directly over this
         * one chart — not the cross-chart sync from the main Latency
         * Distribution chart, which is a separate mechanism (the dedicated
         * overlay series below).
         */
        showSymbol: false,
        symbolSize: large ? 8 : 6,
        smooth: 0,
        animationDurationUpdate: 0,
        itemStyle: {
          color,
          borderColor: chartTheme.panel,
          borderWidth: 2,
        },
        emphasis: {
          scale: true,
          itemStyle: {
            color,
            borderColor: chartTheme.panel,
            borderWidth: 2,
            shadowBlur: large ? 10 : 7,
            shadowColor: color,
          },
        },
        lineStyle: {
          color,
          width: large ? 2 : 1.5,
        },
        data: historicalBuckets.map((bucket, bucketIndex) => [
          bucketIndex,
          bucket[stage.key].p99Ns / 1_000,
        ]),
      },
      /*
       * Dedicated hover-overlay series for the CROSS-CHART sync from the
       * main Latency Distribution chart's own hover/selection —
       * highlightedBucketIndex. Same fix as Task #2's original ghost-trail
       * bug on the main chart, which this one reintroduced by a different
       * route: an earlier version drove this via chart.dispatchAction
       * ("highlight"/"downplay") called directly from a useEffect on every
       * hoveredBucketIndex change, i.e. once per mousemove tick on a
       * DIFFERENT chart, completely unbatched and outside setOption's own
       * rAF coalescing — on a fast sweep, four mini-charts each fired their
       * own uncoalesced highlight/downplay pair per tick, and the emphasis
       * symbol's enlarged/glowing paint region didn't always get fully
       * invalidated by the next repaint before another highlight landed,
       * leaving visible leftover dots (exactly the same canvas
       * dirty-rectangle mechanism as the original bug).
       *
       * Fix: stop touching a RETAINED point's emphasis state from outside;
       * instead this is a genuine, separate series holding AT MOST ONE
       * point, added/removed via `data` (`[]` vs one tuple) INSIDE this
       * same option object — which goes through useECharts' setOption,
       * already rAF-batched, so a fast sweep collapses into one repaint per
       * frame instead of one per tick, and an add/remove has no ambiguous
       * "did the old paint get cleared" case the way a toggled glow does.
       */
      /*
       * "Halo" behind the solid sync dot below — a larger, translucent ring
       * so the marker reads as an unmistakable "target" regardless of how
       * busy/spiky the underlying line is right at that point (Parse/
       * Queue/Book-Update's own data is jagged enough that a plain small
       * dot could get lost among nearby real peaks, even positioned
       * correctly — this is what actually made it look like only Publish
       * was responding, since Publish's dot happened to also sit on an
       * obvious spike of its own).
       */
      {
        name: `${stage.label} sync halo`,
        type: "scatter",
        yAxisIndex: 1,
        z: 6,
        silent: true,
        animation: false,
        tooltip: { show: false },
        emphasis: { disabled: true },
        symbol: "circle",
        symbolSize: large ? 26 : 20,
        itemStyle: {
          color: withAlpha(color, 0.25),
          borderWidth: 0,
        },
        data:
          highlightedBucketIndex >= 0 &&
          highlightedBucketIndex < historicalBuckets.length
            ? [
                [
                  highlightedBucketIndex,
                  historicalBuckets[highlightedBucketIndex]![stage.key]
                    .p99Ns / 1_000,
                ],
              ]
            : [],
      },
      {
        name: `${stage.label} sync`,
        type: "scatter",
        yAxisIndex: 1,
        z: 7,
        silent: true,
        animation: false,
        tooltip: { show: false },
        emphasis: { disabled: true },
        symbol: "circle",
        symbolSize: large ? 14 : 11,
        itemStyle: {
          color,
          borderColor: chartTheme.panel,
          borderWidth: 3,
          shadowBlur: large ? 12 : 9,
          shadowColor: color,
        },
        data:
          highlightedBucketIndex >= 0 &&
          highlightedBucketIndex < historicalBuckets.length
            ? [
                [
                  highlightedBucketIndex,
                  historicalBuckets[highlightedBucketIndex]![stage.key]
                    .p99Ns / 1_000,
                ],
              ]
            : [],
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* SECTION                                                                    */
/* -------------------------------------------------------------------------- */

interface StageLatencyBreakdownProps {
  historicalBuckets: readonly LatencyBucketSnapshot[];
  chartTheme: ChartTheme;
  // Same bucket index the main Latency Distribution chart's own hover (or
  // Peak-Tail-click) is currently pointing at, -1 when nothing is. Mirrored
  // onto each mini card's chart so hovering the main chart also shows where
  // that same 10-second bucket falls on every stage's own line — they share
  // the same historicalBuckets/time horizon, so the index lines up exactly.
  highlightedBucketIndex: number;
  // Set by clicking a stage's segment/legend row in the Stage Breakdown bar
  // (LatencyPanel.tsx) — points at, rather than opens, the matching card
  // here. Opening is still only ever done via each card's own expand
  // button.
  highlightedStage: PipelineStageKey | null;
  // Where the expand preview portals to — see StagePreviewModal's own
  // comment for why (confining it to this panel's column instead of the
  // whole viewport, which used to spill over the order book on the left).
  portalTarget: RefObject<HTMLDivElement | null>;
}

/*
 * Four per-stage cards below the main Latency Distribution chart — same
 * historicalBuckets array (already filtered to the selected 5m/15m/1h range
 * and already the source for Stage Breakdown above), so these stay
 * synchronized with the main chart and the range control automatically,
 * with no separate data source. Pure presentation: every number here reads
 * straight off the existing per-stage HistogramSnapshot fields
 * (LatencyBucketSnapshot.parse/queue/bookUpdate/publish, each already
 * carrying count/maxNs/p50Ns/p99Ns/p999Ns/counts — see lib/types.ts).
 */
export function StageLatencyBreakdown({
  historicalBuckets,
  chartTheme,
  highlightedBucketIndex,
  highlightedStage,
  portalTarget,
}: StageLatencyBreakdownProps) {
  const [expandedStage, setExpandedStage] = useState<PipelineStageKey | null>(
    null,
  );

  const expandedConfig =
    expandedStage !== null
      ? STAGES.find((stage) => stage.key === expandedStage)!
      : null;

  return (
    <div className="w-full shrink-0 rounded-lg border border-border bg-panel p-2">
      <div className="mb-2 px-1">
        <div className="text-sm font-medium text-foreground">
          Stage Latency Breakdown
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <StageMiniCard
            key={stage.key}
            stage={stage}
            historicalBuckets={historicalBuckets}
            chartTheme={chartTheme}
            highlightedBucketIndex={highlightedBucketIndex}
            pointedAt={highlightedStage === stage.key}
            onExpand={() => setExpandedStage(stage.key)}
          />
        ))}
      </div>

      {expandedConfig && (
        <StagePreviewModal
          stage={expandedConfig}
          historicalBuckets={historicalBuckets}
          chartTheme={chartTheme}
          portalTarget={portalTarget}
          onClose={() => setExpandedStage(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* EXPAND ICON                                                                */
/* -------------------------------------------------------------------------- */

function ExpandIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <path
        d="M8 4H4v4M12 16h4v-4M4 4l5 5M16 16l-5-5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* MINI CARD                                                                  */
/* -------------------------------------------------------------------------- */

interface StageMiniCardProps {
  stage: StageConfig;
  historicalBuckets: readonly LatencyBucketSnapshot[];
  chartTheme: ChartTheme;
  highlightedBucketIndex: number;
  pointedAt: boolean;
  onExpand: () => void;
}

function StageMiniCard({
  stage,
  historicalBuckets,
  chartTheme,
  highlightedBucketIndex,
  pointedAt,
  onExpand,
}: StageMiniCardProps) {
  const { containerRef, setOption } = useECharts();
  const color = stageColor(chartTheme, stage.key);
  const stats = useStageStats(stage.key, historicalBuckets);

  const selectSnapshot = useMemo(
    () => (bucket: LatencyBucketSnapshot) => bucket[stage.key],
    [stage.key],
  );

  const heatmap = useMemo(
    () => buildHeatmapBins(historicalBuckets, selectSnapshot),
    [historicalBuckets, selectSnapshot],
  );

  useEffect(() => {
    if (!heatmap) {
      setOption({ animation: false, series: [] });
      return;
    }

    setOption(
      buildStageOption({
        stage,
        historicalBuckets,
        heatmap,
        chartTheme,
        color,
        variant: "compact",
        highlightedBucketIndex,
      }),
    );
  }, [
    heatmap,
    historicalBuckets,
    stage,
    color,
    chartTheme,
    highlightedBucketIndex,
    setOption,
  ]);

  return (
    <div
      className={`group relative rounded-lg border bg-panel p-2 transition-colors duration-300 ${
        pointedAt ? "border-2" : "border border-border"
      }`}
      style={pointedAt ? { borderColor: color } : undefined}
    >
      {/* EXPAND CONTROL — hidden until the card is hovered (or focused, for
          keyboard users, since group-hover alone wouldn't reach them). */}
      <button
        type="button"
        onClick={onExpand}
        title={`Expand ${stage.label}`}
        aria-label={`Expand ${stage.label}`}
        className="absolute top-2 right-2 rounded-md border border-border/70 bg-panel/90 p-1 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground focus:opacity-100"
      >
        <ExpandIcon />
      </button>

      {/* HEADER */}
      <div className="flex items-center justify-between pr-6">
        <div className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-xs font-medium text-foreground">
            {stage.label}
          </span>
        </div>

        <span className="text-[10px] tabular-nums text-muted-foreground">
          {stats.latest !== null ? formatLatencyNs(stats.latest) : "—"}
        </span>
      </div>

      {/* STATS ROW */}
      <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
        <span>
          P50{" "}
          <strong className="tabular-nums text-foreground">
            {stats.p50 !== null ? formatLatencyNs(stats.p50) : "—"}
          </strong>
        </span>
        <span>
          P99.9{" "}
          <strong className="tabular-nums text-foreground">
            {stats.p999 !== null ? formatLatencyNs(stats.p999) : "—"}
          </strong>
        </span>
        <span>
          Max{" "}
          <strong className="tabular-nums text-foreground">
            {stats.max !== null ? formatLatencyNs(stats.max) : "—"}
          </strong>
        </span>
      </div>

      {/*
       * CHART — substantially taller than the original 90px thumbnail
       * (Task #8, "use the blank space"). Still compact/unlabeled (no axis
       * text) so four of these side by side still reads as a dashboard
       * strip, not four separate full charts; the labeled, larger version
       * lives in the expand preview below.
       */}
      <div ref={containerRef} className="mt-1.5 h-[220px] w-full" />

      {/* PER-STAGE DENSITY LEGEND — this stage's own colour, not shared
          across cards, so it always matches the heatmap actually rendered
          above it. */}
      <div className="mt-1.5 flex items-center gap-1">
        <div
          className="h-1.5 w-14 overflow-hidden rounded-full border border-border/50"
          style={{
            background: `linear-gradient(to right, ${HEATMAP_DENSITY_OPACITY_STOPS.map(
              (stop) => withAlpha(color, stop),
            ).join(", ")})`,
          }}
        />
        <span className="whitespace-nowrap text-[8px] text-muted-foreground/70">
          fewer → more samples
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* PREVIEW MODAL                                                              */
/* -------------------------------------------------------------------------- */

const AUTO_CLOSE_MS = 5_000;

interface StagePreviewModalProps {
  stage: StageConfig;
  historicalBuckets: readonly LatencyBucketSnapshot[];
  chartTheme: ChartTheme;
  portalTarget: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

function StagePreviewModal({
  stage,
  historicalBuckets,
  chartTheme,
  portalTarget,
  onClose,
}: StagePreviewModalProps) {
  const { containerRef, setOption } = useECharts();
  const color = stageColor(chartTheme, stage.key);
  const stats = useStageStats(stage.key, historicalBuckets);

  const selectSnapshot = useMemo(
    () => (bucket: LatencyBucketSnapshot) => bucket[stage.key],
    [stage.key],
  );

  const heatmap = useMemo(
    () => buildHeatmapBins(historicalBuckets, selectSnapshot),
    [historicalBuckets, selectSnapshot],
  );

  useEffect(() => {
    if (!heatmap) {
      setOption({ animation: false, series: [] });
      return;
    }

    setOption(
      buildStageOption({
        stage,
        historicalBuckets,
        heatmap,
        chartTheme,
        color,
        variant: "large",
      }),
    );
  }, [heatmap, historicalBuckets, stage, color, chartTheme, setOption]);

  /*
   * ~5s-of-inactivity auto-close. `resetTimer` is called on mount and on
   * every mousemove/click/keydown inside the modal, so it only fires after
   * a genuine pause — interacting with the preview keeps pushing it back,
   * it never closes out from under an active user. `onClose` itself (the
   * explicit Close button, or Escape) clears the pending timer via the
   * effect cleanup on unmount, so there's never a stray close firing after
   * the modal is already gone.
   */
  const timerRef = useRef<number | null>(null);

  const resetTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(onClose, AUTO_CLOSE_MS);
  };

  useEffect(() => {
    resetTimer();

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else {
        resetTimer();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  /*
   * Confined to this panel's own column instead of the whole viewport — was
   * `fixed inset-0`, which centered over the full screen and spilled over
   * the order book on the left. Portals into LatencyPanel's own root
   * (`portalTarget`, a `position: relative` element covering just this
   * column), then uses `absolute inset-0` so it fills exactly that
   * column's box regardless of the surrounding scroll container. Card
   * sizing switched from viewport units (vw/vh) to percentages of that
   * same box for the same reason — vw would still size against the full
   * screen even once correctly positioned.
   */
  if (!portalTarget.current) {
    return null;
  }

  return createPortal(
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseMove={resetTimer}
      onClick={(event) => {
        // Clicking the dim backdrop closes immediately — only the card
        // itself stops propagation below.
        if (event.target === event.currentTarget) {
          onClose();
        } else {
          resetTimer();
        }
      }}
    >
      <div
        className="flex max-h-[90%] w-[92%] max-w-2xl flex-col rounded-lg border border-border bg-panel p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* HEADER */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="text-base font-semibold text-foreground">
              {stage.label}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            Close
          </button>
        </div>

        {/* STATS ROW */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-panel p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Current
            </div>
            <div
              className="mt-0.5 text-lg font-semibold tabular-nums"
              style={{ color }}
            >
              {stats.latest !== null ? formatLatencyNs(stats.latest) : "—"}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-panel p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              P50
            </div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {stats.p50 !== null ? formatLatencyNs(stats.p50) : "—"}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-panel p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              P99.9
            </div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {stats.p999 !== null ? formatLatencyNs(stats.p999) : "—"}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-panel p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Max
            </div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {stats.max !== null ? formatLatencyNs(stats.max) : "—"}
            </div>
          </div>
        </div>

        {/* CHART */}
        <div ref={containerRef} className="mt-3 h-[46vh] min-h-[320px] w-full" />

        {/* DENSITY LEGEND — same stage colour as everything above. */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            Sample density
          </span>
          <div
            className="h-2 w-24 overflow-hidden rounded-full border border-border/50"
            style={{
              background: `linear-gradient(to right, ${HEATMAP_DENSITY_OPACITY_STOPS.map(
                (stop) => withAlpha(color, stop),
              ).join(", ")})`,
            }}
          />
          <span className="whitespace-nowrap text-[10px] text-muted-foreground/70">
            fewer → more samples
          </span>
        </div>

        <div className="mt-2 text-[10px] text-muted-foreground/70">
          Closes automatically after a few seconds of inactivity — move the
          mouse or press a key to keep it open.
        </div>
      </div>
    </div>,
    portalTarget.current,
  );
}
