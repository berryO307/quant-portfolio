"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Attribution } from "@/lib/types";
import { ATTRIBUTION_COLORS, COLOR_ASK, COLOR_JITTER, COLOR_MUTED, UPLOT_AXIS_STYLE } from "@/lib/theme";

const ATTRIBUTION_ORDER: (Attribution | "normal")[] = ["normal", "parse", "book-update", "publish", "host_jitter"];

export interface LatencyPoint {
  x: number; // tRecvTsc — a monotonic per-session ordering, not wall-clock time
  latencyNs: number;
  attribution: Attribution | "normal";
}

interface LatencyChartProps {
  points: LatencyPoint[];
  refLines: { p50: number; p99: number; p999: number };
  height?: number;
}

// uPlot, not Altair/Vega-Lite — this is the live interactive chart (Phase 5's
// Altair output is static HTML for offline review, a different tool for a
// different job). One series per attribution category (with nulls at every
// x not in that category) rather than per-point color callbacks — simpler,
// and idiomatic uPlot for a small fixed set of categories. Reference lines
// are their own constant-value series, dashed, no points.
export function LatencyChart({ points, refLines, height = 260 }: LatencyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xs = points.map((p) => p.x);
    const seriesByCategory = ATTRIBUTION_ORDER.map((cat) =>
      points.map((p) => (p.attribution === cat ? p.latencyNs : null))
    );
    const refLineValues = [refLines.p50, refLines.p99, refLines.p999];
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
      { label: "p99.9", stroke: COLOR_ASK, width: 1, dash: [4, 3], points: { show: false } },
    ];

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      series,
      scales: { x: { time: false } },
      axes: [UPLOT_AXIS_STYLE, { ...UPLOT_AXIS_STYLE, label: "latency (ns)" }],
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
    };

    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 600, height });
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
  }, [points, refLines.p50, refLines.p99, refLines.p999, height]);

  return <div ref={containerRef} className="w-full" />;
}
