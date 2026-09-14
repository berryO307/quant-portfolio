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
  const cpuGhzRef = useRef(cpuGhz);

  useEffect(() => {
    cpuGhzRef.current = cpuGhz;
    // cpuGhz only changes on a rare mid-session reconnect handshake, not on
    // the regular data cadence — nothing else would trigger uPlot to
    // recompute axis labels when only this ref changes, so force one.
    plotRef.current?.redraw();
  }, [cpuGhz]);

  // Mount once: create the uPlot instance with empty data. Series/axes/
  // color are fixed for this component's lifetime — only the data changes,
  // handled by the effect below via plot.setData(). Previously `new
  // uPlot(...)` ran inside the effect keyed on `points`, tearing down and
  // rebuilding the whole canvas on every data update (~4x/second) — see
  // LatencyChart.tsx's identical fix and comment for the full reasoning;
  // this component had the same bug for the same cause.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

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
          // t0 reads u.data[0][0] — uPlot's own current data — rather than
          // a value captured in a closure at mount time, which would go
          // stale the instant new data arrived now that the instance isn't
          // recreated per update. See LatencyChart.tsx's identical pattern.
          values: (u, ticks) => {
            const t0 = (u.data[0]?.[0] as number | undefined) ?? 0;
            const ghz = cpuGhzRef.current;
            const tscToElapsedSeconds = (tsc: number) => (ghz > 0 ? (tsc - t0) / (ghz * 1e9) : 0);
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

    const plot = new uPlot(opts, [[], []], el);
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
    // color is a mount-time dependency (not read via ref) since a color
    // change here would mean a different stage's chart entirely, not a
    // live update to the same one — deliberately still recreates the
    // instance in that case, only "new data for the same stage" is now
    // handled without recreation.
  }, [minHeight, color]);

  // New data -> update the existing instance in place instead of rebuilding
  // it — the actual fix, same reasoning as LatencyChart.tsx.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => Math.max(p.valueNs, LOG_FLOOR_NS));
    plot.setData([xs, ys]);
  }, [points]);

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
