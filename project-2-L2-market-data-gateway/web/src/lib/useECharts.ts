"use client";

import { useCallback, useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";

// Explicit component registration rather than importing the `echarts`
// barrel: this dashboard uses exactly two chart types and three components,
// and the barrel pulls in every chart type and coordinate system ECharts
// ships. Measured both ways with `next build` on this app: the barrel
// produces a 1140 KB largest chunk / 1692 KB total client JS; the selective
// imports below produce 557 KB / 1110 KB — half the chart chunk, for a page
// that also has to stay responsive while a WebSocket streams into it.
// Registered once at module scope, shared by all three chart components.
echarts.use([
  HeatmapChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export type { EChartsOption };

/**
 * Owns one ECharts instance for the lifetime of the component.
 *
 * The deliberate design constraint: this hook has NO dependencies that can
 * change. The instance is created on mount and disposed on unmount, never
 * in between — not for new data, not for a theme toggle, not for a resize.
 * Everything else goes through `setOption`, which ECharts diffs against the
 * live option and applies in place.
 *
 * That's the structural fix for the class of bug that dogged the previous
 * uPlot implementation: there, colors and axis config were baked into the
 * instance at construction, so a theme change *had* to re-run `new
 * uPlot(...)` (visible as a flash-to-empty and a rebuild delay), and data
 * updates were one `setData` call away from accidentally being a full
 * rebuild if a dependency array grew by one entry. Here neither is
 * expressible — there is exactly one construction site and it can only run
 * once.
 *
 * setOption calls are coalesced into a single animation frame, so a render
 * that changes several inputs at once (new points AND new reference lines
 * AND a new theme) still results in exactly one option application.
 */
export function useECharts() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const pendingRef = useRef<EChartsOption | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    // Defensive: if this component mounted while its container was still
    // 0×0 (e.g. a conditionally-rendered tab, or a CSS reflow — grid/flex
    // going from side-by-side to stacked on a narrower viewport — that
    // hadn't settled yet at the exact moment echarts.init() ran above),
    // ECharts bakes the canvas to that zero size and the chart never draws
    // anything until something explicitly asks it to re-measure. The
    // ResizeObserver below covers every SUBSEQUENT size change, but this
    // covers the very first paint, one microtask after mount — by then the
    // browser has committed layout for this render, so el's real
    // dimensions (if any exist yet) are available.
    queueMicrotask(() => chart.resize());

    // ECharts sizes itself to the container at init and does not observe it
    // afterwards — without this, a chart in a flex/grid panel keeps its
    // first-paint size forever while the panel around it resizes.
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(el);

    return () => {
      resize.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = null;
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // Merge semantics (no `notMerge`) are what let a theme-only update carry
  // just the restyled fragments while leaving the current data in place,
  // and a data-only update leave styling alone. `replaceMerge: ["series"]`
  // is passed by callers that genuinely change the series *set*; for the
  // steady state (same series, new values) plain merge is what animates.
  const setOption = useCallback(
    (option: EChartsOption, replaceSeries = false) => {
      pendingRef.current = option;
      const doReplace = replaceSeries;
      if (rafRef.current != null) return;

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const chart = chartRef.current;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (!chart || !next || chart.isDisposed()) return;
        chart.setOption(
          next,
          doReplace ? { replaceMerge: ["series"] } : undefined,
        );
      });
    },
    [],
  );

  return { containerRef, chartRef, setOption };
}
