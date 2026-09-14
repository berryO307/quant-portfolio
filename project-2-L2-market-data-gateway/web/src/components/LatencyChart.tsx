"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Attribution } from "@/lib/types";
import { ATTRIBUTION_COLORS, ATTRIBUTION_LABEL, COLOR_JITTER, COLOR_MUTED, COLOR_SEVERE, UPLOT_AXIS_STYLE } from "@/lib/theme";
import { formatElapsedAdaptive, formatNs } from "@/lib/format";
import { LegendSwatch } from "./LegendSwatch";

const ATTRIBUTION_ORDER: (Attribution | "normal")[] = ["normal", "parse", "book-update", "publish", "host_jitter"];
const TICK_FONT = "10px JetBrains Mono, monospace"; // numbers: mono
const LABEL_FONT = "10px Inter, sans-serif"; // axis captions: sans

// Phase 8.5's third pass: pipeline stages span orders of magnitude (a
// parse/queue delay can be single-digit µs, a tail event hundreds of µs) —
// on one shared LINEAR y-axis the small values all crush down near zero and
// become indistinguishable. Log scale (uPlot's distr:3) fixes this without
// splitting into a second chart, which would lose the visual relationship
// between "normal" points and the tail events among them. A log scale can't
// plot zero or negative values, so real durations (never zero/negative in
// practice) are floored at this epsilon for DISPLAY only — this never
// touches latencyNs itself, only what gets handed to uPlot.
const LOG_FLOOR_NS = 1;

export interface LatencyPoint {
  x: number; // tRecvTsc — a monotonic per-session ordering, not wall-clock time
  latencyNs: number;
  attribution: Attribution | "normal";
}

interface LatencyChartProps {
  title: string;
  description: string; // shown as a hover tooltip on the heading — what this chart measures
  points: LatencyPoint[];
  refLines: { p50: number; p99: number; p999: number };
  cpuGhz: number; // to convert tRecvTsc deltas into a readable elapsed-time x-axis
  minHeight?: number;
}

// uPlot, not Altair/Vega-Lite — this is the live interactive chart (Phase 5's
// Altair output is static HTML for offline review, a different tool for a
// different job). One series per attribution category (with nulls at every
// x not in that category) rather than per-point color callbacks — simpler,
// and idiomatic uPlot for a small fixed set of categories. Reference lines
// are their own constant-value series, dashed, no points.
//
// Phase 8.5's second pass turned uPlot's built-in legend off (legend:
// {show:false}) — it was a permanent two-row block of "label: --"
// placeholders, taller than the chart itself, only ever showing a real
// value while the cursor sat over a point. Replaced with a static
// LegendSwatch row above the chart (the color key, always visible) plus a
// small floating tooltip that follows the cursor (the live value, only
// visible on hover) — see the setCursor hook below.
export function LatencyChart({ title, description, points, refLines, cpuGhz, minHeight = 200 }: LatencyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xs = points.map((p) => p.x);
    const seriesByCategory = ATTRIBUTION_ORDER.map((cat) =>
      points.map((p) => (p.attribution === cat ? Math.max(p.latencyNs, LOG_FLOOR_NS) : null))
    );
    const refLineValues = [refLines.p50, refLines.p99, refLines.p999].map((v) => Math.max(v, LOG_FLOOR_NS));
    const refSeries = refLineValues.map(() => xs.map(() => null as number | null));
    // Constant lines only need two anchor points (first/last x) to draw
    // correctly under uPlot's line renderer, but using the full x domain
    // with a constant y is simpler to keep in sync with the main series.
    refLineValues.forEach((v, i) => {
      if (xs.length > 0) {
        refSeries[i]![0] = v;
        refSeries[i]![xs.length - 1] = v;
      }
    });

    const data: uPlot.AlignedData = [xs, ...seriesByCategory, ...refSeries];

    const series: uPlot.Series[] = [
      {},
      ...ATTRIBUTION_ORDER.map((cat) => ({
        label: cat,
        stroke: ATTRIBUTION_COLORS[cat],
        fill: ATTRIBUTION_COLORS[cat],
        paths: () => null, // scatter only — no connecting line
        points: { show: true, size: 5, fill: ATTRIBUTION_COLORS[cat], stroke: ATTRIBUTION_COLORS[cat] },
      })),
      { label: "p50", stroke: COLOR_MUTED, width: 1, dash: [4, 3], points: { show: false } },
      { label: "p99", stroke: COLOR_JITTER, width: 1, dash: [4, 3], points: { show: false } },
      // Was COLOR_ASK (bid/ask red) before Phase 8.5's redesign — collided
      // with ask's meaning despite having nothing to do with the order
      // book. See theme.ts's COLOR_SEVERE comment.
      { label: "p99.9", stroke: COLOR_SEVERE, width: 1, dash: [4, 3], points: { show: false } },
    ];

    // tRecvTsc has no fixed relationship to wall-clock time (raw per-session
    // TSC cycles) — the only readable thing to show is elapsed time since
    // the first point currently plotted, converted via the known cpu_ghz.
    // formatElapsedAdaptive picks its unit/precision from the SPACING
    // between ticks, not the value itself — see format.ts's comment for why
    // that's what fixes the "every tick reads 0.0s" bug.
    const t0 = xs[0] ?? 0;
    const tscToElapsedSeconds = (tsc: number) => (cpuGhz > 0 ? (tsc - t0) / (cpuGhz * 1e9) : 0);

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: Math.max(el.clientHeight || 0, minHeight),
      series,
      scales: { x: { time: false }, y: { distr: 3, log: 10 } },
      axes: [
        {
          ...UPLOT_AXIS_STYLE,
          label: "elapsed time",
          font: TICK_FONT,
          labelFont: LABEL_FONT,
          values: (_u, ticks) => {
            const stepSeconds = ticks.length > 1 ? tscToElapsedSeconds(ticks[1]!) - tscToElapsedSeconds(ticks[0]!) : 1;
            return ticks.map((t) => formatElapsedAdaptive(tscToElapsedSeconds(t), stepSeconds));
          },
        },
        {
          ...UPLOT_AXIS_STYLE,
          label: "latency (log scale)",
          font: TICK_FONT,
          labelFont: LABEL_FONT,
          // A log-scale axis (distr:3) generates minor gridline positions
          // uPlot doesn't intend to label at all — it passes those as null
          // rather than omitting them, which crashed formatNs() the moment
          // this went live (confirmed via a Playwright console-error capture,
          // not just inferred from the blank chart). Every other axis
          // `values` callback in this app takes numbers only; this is the
          // one exception, specifically because it's the one log-scale axis.
          values: (_u, ticks) => ticks.map((t) => (t == null ? "" : formatNs(t))),
        },
      ],
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      hooks: {
        setCursor: [
          (u) => {
            const tooltip = tooltipRef.current;
            if (!tooltip) return;
            const idx = u.cursor.idx;
            const point = idx == null ? null : points[idx];
            if (!point) {
              tooltip.style.display = "none";
              return;
            }
            const label = point.attribution === "normal" ? "normal" : ATTRIBUTION_LABEL[point.attribution];
            tooltip.textContent = `${label} · ${formatNs(point.latencyNs)}`;
            tooltip.style.display = "block";

            // Boundary-aware placement (same fix as DepthCurve's cursor
            // tooltip): a fixed "+12px from cursor" offset runs past the
            // chart and clips/wraps near the right/bottom edge. Flip to the
            // opposite side of the cursor whenever the default placement
            // would overflow the plotting area.
            const cursorLeft = u.cursor.left ?? 0;
            const cursorTop = u.cursor.top ?? 0;
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            const maxLeft = el.clientWidth;
            const maxTop = el.clientHeight;

            let left = cursorLeft + 12;
            if (left + tw > maxLeft) left = cursorLeft - tw - 12;
            left = Math.max(2, Math.min(left, maxLeft - tw - 2));

            let top = cursorTop + 12;
            if (top + th > maxTop) top = cursorTop - th - 12;
            top = Math.max(2, Math.min(top, maxTop - th - 2));

            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
          },
        ],
      },
    };

    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 600, height: Math.max(el.clientHeight || 0, minHeight) });
    });
    resize.observe(el);

    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Rebuilding on every data change (rather than plot.setData) keeps this
    // simple — series count/order never changes, only which points and how
    // many, and uPlot's construction cost at this data size (<=2000 points)
    // is negligible next to the ~250ms batch cadence samples arrive at.
  }, [points, refLines.p50, refLines.p99, refLines.p999, cpuGhz, minHeight]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 rounded-md border border-border bg-[#0a1424] p-2">
      {/* Hover the heading for what this chart shows (Phase 8.5's fourth
          pass) — replaces a permanently-visible subtitle line with a native
          tooltip, one less line of always-on text competing for space. */}
      <div className="text-xs text-foreground" title={description}>
        {title}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {ATTRIBUTION_ORDER.map((cat) => (
          <LegendSwatch key={cat} color={ATTRIBUTION_COLORS[cat]} label={cat === "normal" ? "normal" : ATTRIBUTION_LABEL[cat]} />
        ))}
        <LegendSwatch color={COLOR_MUTED} label="p50" dashed />
        <LegendSwatch color={COLOR_JITTER} label="p99" dashed />
        <LegendSwatch color={COLOR_SEVERE} label="p99.9" dashed />
      </div>
      {/* This wrapper, not containerRef, is what should grow to fill
          available space (Phase 8.5's "let the chart take the slack" fix) —
          containerRef fills it via absolute inset-0, and the ResizeObserver
          above measures ITS size, so the plot's actual pixel height tracks
          however much room the surrounding layout gives this panel. */}
      <div className="relative min-h-0 flex-1" style={{ minHeight }}>
        <div ref={containerRef} className="absolute inset-0" />
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-10 hidden rounded-sm border border-border bg-card px-1.5 py-1 font-mono text-[10px] tabular-nums text-foreground"
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
