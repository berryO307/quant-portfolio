"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { UPLOT_AXIS_STYLE } from "@/lib/theme";
import { formatElapsedAdaptive, formatNs } from "@/lib/format";

const TICK_FONT = "10px JetBrains Mono, monospace"; // numbers: mono
const LABEL_FONT = "10px Inter, sans-serif"; // axis captions: sans
const LOG_FLOOR_NS = 1; // see LatencyChart's comment on the same constant

export interface StagePoint {
  x: number; // tRecvTsc
  valueNs: number;
}

interface StageLatencyChartProps {
  title: string;
  description: string; // shown as a hover tooltip on the heading — what this chart measures
  color: string;
  points: StagePoint[];
  cpuGhz: number;
  minHeight?: number;
}

// One stage, one chart, one color. Phase 8.5's fourth pass: the combined
// scatter (still available as the "Total latency" overview above these)
// overlays 5 attribution categories and 3 reference lines onto one shared
// axis — useful for "which stage caused this tail event", but busy for
// "how is the parse stage doing right now". These are deliberately minimal
// instead: no legend (the heading names the one series), no reference
// lines, just points over time — self-explanatory without extra chrome, per
// the actual complaint that prompted this. Log-scale y-axis for the same
// reason as the overview chart: a stage's own values can span normal
// sub-microsecond timing and an occasional order-of-magnitude spike (a
// book-update stall, a jitter spike) that would otherwise crush the normal
// cluster flat against zero on a linear axis.
export function StageLatencyChart({ title, description, color, points, cpuGhz, minHeight = 130 }: StageLatencyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => Math.max(p.valueNs, LOG_FLOOR_NS));
    const t0 = xs[0] ?? 0;
    const tscToElapsedSeconds = (tsc: number) => (cpuGhz > 0 ? (tsc - t0) / (cpuGhz * 1e9) : 0);

    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height: Math.max(el.clientHeight || 0, minHeight),
      series: [
        {},
        {
          stroke: color,
          fill: color,
          paths: () => null, // scatter only
          points: { show: true, size: 4, fill: color, stroke: color },
        },
      ],
      scales: { x: { time: false }, y: { distr: 3, log: 10 } },
      axes: [
        {
          ...UPLOT_AXIS_STYLE,
          font: TICK_FONT,
          labelFont: LABEL_FONT,
          size: 24,
          values: (_u, ticks) => {
            const stepSeconds = ticks.length > 1 ? tscToElapsedSeconds(ticks[1]!) - tscToElapsedSeconds(ticks[0]!) : 1;
            return ticks.map((t) => formatElapsedAdaptive(tscToElapsedSeconds(t), stepSeconds));
          },
        },
        {
          ...UPLOT_AXIS_STYLE,
          font: TICK_FONT,
          labelFont: LABEL_FONT,
          size: 44,
          // Log-scale axes emit null for minor gridline positions uPlot
          // doesn't intend to label — see LatencyChart's identical guard
          // (that omission crashed the whole chart the first time around).
          values: (_u, ticks) => ticks.map((t) => (t == null ? "" : formatNs(t))),
        },
      ],
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
    };

    const plot = new uPlot(opts, [xs, ys], el);
    plotRef.current = plot;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 300, height: Math.max(el.clientHeight || 0, minHeight) });
    });
    resize.observe(el);

    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [points, cpuGhz, minHeight, color]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-[#0a1424] p-2">
      <div className="text-[11px] text-foreground" title={description}>
        {title}
      </div>
      <div className="relative min-h-0" style={{ height: minHeight }}>
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
