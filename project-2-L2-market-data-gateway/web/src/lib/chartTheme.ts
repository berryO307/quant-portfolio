"use client";

import { useEffect, useState } from "react";

// Live, theme-reactive styling for the three ECharts chart components
// (DepthCurve, LatencyChart, StageLatencyChart). Deliberately separate from
// lib/theme.ts's COLOR_* constants, which stay static hex — those are also
// read by three non-chart components (LatencyPanel, StageBreakdown,
// TailEventsFeed) where a color that doesn't repaint on a theme toggle is a
// minor, non-broken outcome (status colors reading fine on both light/dark
// backgrounds is a common, acceptable simplification), not worth widening
// this change to touch.
//
// Chart options are different: colors are literal strings inside an option
// object, not CSS the browser repaints automatically — a chart configured
// once under one theme keeps that theme's colors until something
// re-resolves and re-applies them. The critical detail (and the reason
// these are plain values rather than a registered `echarts.registerTheme`
// theme) is that a registered ECharts theme can ONLY be swapped by
// disposing and re-initialising the instance — exactly the unmount-and-
// rebuild that made the previous uPlot version flash empty on every
// light/dark toggle. Feeding theme values through setOption() instead
// restyles the live instance in place, no teardown.
export interface ChartTheme {
  grid: string;
  border: string;
  muted: string;
  text: string;
  bid: string;
  ask: string;
  parse: string;
  queue: string;
  bookUpdate: string;
  // Task #8: dedicated, hex-backed token for the Publish stage — see
  // globals.css's own comment on --publish for why this exists rather than
  // reusing palette[3] (the generic categorical --chart-4, which is
  // oklch()-backed and rendered black through zrender's colour parser).
  publish: string;
  severe: string;
  // Thermal ramp for the Latency Tails distribution chart (heatmap density
  // + the four percentile lines) — see globals.css's own comment on
  // --heat-cool for why these are dedicated tokens rather than reusing
  // parse/severe/ask: the existing palette had no true vivid warm color,
  // which is exactly what a "cool baseline -> critical extreme" severity
  // ramp needs. heatCrit intentionally resolves to the same value as `ask`
  // in both themes (see globals.css) — kept as its own named field anyway
  // so LatencyPanel.tsx can express "this is the critical/hottest end of
  // MY OWN ramp" without reaching for a token whose name means something
  // else (order-book ask side) in every other chart.
  heatCool: string;
  heatWarm: string;
  heatHot: string;
  heatCrit: string;
  // Tooltip/panel surface, so a chart tooltip matches the panels around it.
  panel: string;
  // ECharts' categorical fallback palette (option.color) — the generic
  // tweakcn --chart-1..5 ramp. Every series in this app names its own
  // semantic color (bid/ask/parse/...), so this is only what ECharts falls
  // back to for anything unnamed, but it should still follow the theme.
  palette: string[];
  fontFamily: string;
  radiusPx: number;
}

// Dark-mode fallback (matches the CSS custom properties' own dark values in
// app/globals.css) — used only for the very first render before any DOM
// exists to read from (SSR) or before the browser has painted a computed
// style yet.
const FALLBACK: ChartTheme = {
  grid: "#111b2a",
  border: "#1e293b",
  muted: "#94a3b8",
  text: "#cbd5e1",
  bid: "#3fb950",
  ask: "#f85149",
  parse: "#58a6ff",
  queue: "#2dd4bf",
  bookUpdate: "#bc8cff",
  publish: "#818cf8",
  severe: "#b19655",
  heatCool: "#38bdf8",
  heatWarm: "#fbbf24",
  heatHot: "#fb923c",
  heatCrit: "#f85149",
  panel: "#0a1424",
  palette: ["#3b82f6", "#60a5fa", "#38bdf8", "#475569", "#6366f1"],
  fontFamily: "Inter, system-ui, sans-serif",
  radiusPx: 6,
};

// Reads a CSS custom property off <html> and resolves it to a color string
// the canvas can use directly. The property's raw value (oklch(...), a
// hex, whatever globals.css happens to hold) doesn't matter — assigning it
// to a throwaway element's `color` and reading getComputedStyle back gives
// the browser's own resolved "rgb(r, g, b)", the same resolution it already
// does to paint anything else. Cheaper than hand-rolling an oklch->rgb
// conversion, and correct by construction since it's the browser's own math.
function resolveVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;

  const probe = document.createElement("span");
  probe.style.color = raw;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);

  return resolved || fallback;
}

// Non-color custom properties (--font-sans) can't go through resolveVar's
// color round-trip — assigning a font stack to `style.color` resolves to
// nothing. These are used as-is, exactly as the CSS declares them.
function resolveRawVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

// --radius is a CSS length (0.375rem); ECharts wants a number of pixels.
// Resolved through the browser's own layout rather than parsed by hand, so
// rem/em/calc() all work without this needing to know the root font size.
function resolveRadiusPx(fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--radius").trim();
  if (!raw) return fallback;

  const probe = document.createElement("span");
  probe.style.borderTopLeftRadius = raw;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = parseFloat(getComputedStyle(probe).borderTopLeftRadius);
  document.body.removeChild(probe);

  return Number.isFinite(resolved) ? resolved : fallback;
}

export function resolveChartTheme(): ChartTheme {
  return {
    grid: resolveVar("--grid", FALLBACK.grid),
    border: resolveVar("--border", FALLBACK.border),
    muted: resolveVar("--muted-foreground", FALLBACK.muted),
    text: resolveVar("--chart-text", FALLBACK.text),
    bid: resolveVar("--bid", FALLBACK.bid),
    ask: resolveVar("--ask", FALLBACK.ask),
    parse: resolveVar("--parse", FALLBACK.parse),
    queue: resolveVar("--queue", FALLBACK.queue),
    bookUpdate: resolveVar("--book-update", FALLBACK.bookUpdate),
    publish: resolveVar("--publish", FALLBACK.publish),
    heatCool: resolveVar("--heat-cool", FALLBACK.heatCool),
    heatWarm: resolveVar("--heat-warm", FALLBACK.heatWarm),
    heatHot: resolveVar("--heat-hot", FALLBACK.heatHot),
    heatCrit: resolveVar("--heat-crit", FALLBACK.heatCrit),
    severe: resolveVar("--severe", FALLBACK.severe),
    panel: resolveVar("--panel", FALLBACK.panel),
    palette: [
      resolveVar("--chart-1", FALLBACK.palette[0]!),
      resolveVar("--chart-2", FALLBACK.palette[1]!),
      resolveVar("--chart-3", FALLBACK.palette[2]!),
      resolveVar("--chart-4", FALLBACK.palette[3]!),
      resolveVar("--chart-5", FALLBACK.palette[4]!),
    ],
    fontFamily: resolveRawVar("--font-sans", FALLBACK.fontFamily),
    radiusPx: resolveRadiusPx(FALLBACK.radiusPx),
  };
}

// resolveVar returns the browser's own computed "rgb(r, g, b)" (or
// "rgba(...)" if the source had alpha), never a hex string — so the old
// hex-suffix trick this app used elsewhere for translucent fills
// (`${COLOR_BID}33`, a hex string with two extra alpha digits appended)
// would silently produce invalid CSS ("rgb(63, 185, 80)33") if applied to
// a resolved theme color. This does the same job correctly regardless of
// which format the browser handed back.
export function withAlpha(rgbColor: string, alpha: number): string {
  const match = rgbColor.match(/rgba?\(([^)]+)\)/);
  if (!match) return rgbColor;
  const [r, g, b] = match[1].split(",").map((s) => s.trim());
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Numbers use the mono face everywhere in this app (axis ticks, tooltips);
// axis captions use the theme's sans stack. Kept here rather than in each
// chart so all three stay consistent.
const MONO_FAMILY = "JetBrains Mono, ui-monospace, monospace";

// Shared ECharts axis styling. Returned as a plain option fragment (not a
// registered theme) so it can be spread into setOption() on a live
// instance — see ChartTheme's own comment for why that distinction is the
// whole point of this file.
export function buildAxisStyle(theme: ChartTheme) {
  return {
    axisLine: { show: true, lineStyle: { color: theme.border } },
    axisTick: { show: false },
    axisLabel: {
      color: theme.muted,
      fontSize: 10,
      fontFamily: MONO_FAMILY,
      hideOverlap: true,
    },
    nameTextStyle: {
      color: theme.muted,
      fontSize: 10,
      fontFamily: theme.fontFamily,
    },
    splitLine: { show: true, lineStyle: { color: theme.grid, width: 1, type: "dashed" as const } },
  };
}

// Tooltip + global text styling, shared by all three charts so a tooltip
// reads as part of the same surface as the panel it floats over.
export function buildTooltipStyle(theme: ChartTheme) {
  return {
    backgroundColor: theme.panel,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: theme.radiusPx,
    padding: [4, 8] as [number, number],
    textStyle: {
      color: theme.text,
      fontSize: 10,
      fontFamily: MONO_FAMILY,
    },
    extraCssText: "box-shadow: none;",
  };
}

// ECharts types the axis-pointer label's `value` as ScaleDataValue, which
// includes Date. These charts only ever plot numbers, but the formatter
// signature still has to accept the wider type to be assignable.
interface AxisPointerLabelParams {
  axisDimension?: string;
  value: number | string | Date;
}

/**
 * The shared crosshair. Every chart in this dashboard uses exactly this —
 * same dashed lines, same themed label chip — so hovering the depth curve
 * and hovering a latency panel feel like the same instrument rather than
 * two libraries bolted together.
 *
 * formatX/formatY format the pointer's own label chips. Without them the
 * crosshair prints raw numbers (`12.43`, `2.26e+7`) while the axis ticks
 * beside it read `12s` and `22.6ms`, which makes the two look unrelated.
 */
export function buildCrosshairPointer(
  theme: ChartTheme,
  format: { x?: (value: number) => string; y?: (value: number) => string } = {}
) {
  return {
    type: "cross" as const,
    snap: true,
    lineStyle: { color: withAlpha(theme.muted, 0.5), width: 1, type: "dashed" as const },
    crossStyle: { color: withAlpha(theme.muted, 0.5), width: 1, type: "dashed" as const },
    label: {
      backgroundColor: theme.panel,
      borderColor: theme.border,
      borderWidth: 1,
      color: theme.text,
      fontSize: 10,
      fontFamily: MONO_FAMILY,
      formatter: (p: AxisPointerLabelParams): string => {
        const numeric = Number(p.value);
        if (!Number.isFinite(numeric)) return String(p.value);
        const fn = p.axisDimension === "y" ? format.y : format.x;
        return fn ? fn(numeric) : String(numeric);
      },
    },
  };
}

// A legend-matching color dot for tooltip rows. ECharts' own default
// `{a}/{b}/{c}` templates render a marker for axis-triggered tooltips but
// not for the custom formatters these charts use, so every chart builds its
// rows through this — otherwise the tooltip's "which series is this"
// affordance silently disagrees with the LegendSwatch row above the chart.
export function tooltipSwatch(color: string): string {
  return (
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;` +
    `background:${color};margin-right:6px;vertical-align:middle"></span>`
  );
}

/**
 * Keeps a tooltip inside the canvas and, above all, off the x-axis.
 *
 * ECharts' default placement trails the cursor down-and-right, which puts
 * the tooltip straight over the bottom axis whenever the pointer is in the
 * lower half of the plot — reported on the depth curve as the price readout
 * colliding with the tick labels. This prefers ABOVE the cursor, flips
 * below only when there isn't room up there, and in every case clamps the
 * bottom edge to `bottomInset` pixels clear of the canvas floor so the
 * axis strip is never covered.
 *
 * bottomInset should be the chart's grid `bottom` plus a little slack.
 */
export function buildTooltipPosition(bottomInset: number) {
  const EDGE = 4;
  const OFFSET = 14;
  return (
    point: [number, number],
    _params: unknown,
    _dom: unknown,
    _rect: unknown,
    size: { contentSize: [number, number]; viewSize: [number, number] }
  ): [number, number] => {
    const [cursorX, cursorY] = point;
    const [tipW, tipH] = size.contentSize;
    const [viewW, viewH] = size.viewSize;

    let x = cursorX + OFFSET;
    if (x + tipW > viewW - EDGE) x = cursorX - tipW - OFFSET;
    x = Math.max(EDGE, Math.min(x, viewW - tipW - EDGE));

    let y = cursorY - tipH - OFFSET; // preferred: clear of the cursor, above it
    if (y < EDGE) y = cursorY + OFFSET; // no room above — fall back to below
    y = Math.max(EDGE, Math.min(y, viewH - tipH - bottomInset));

    return [x, y];
  };
}

// Every chart's option starts from this: the categorical palette, the base
// text style, and animation timing for in-place data updates. ECharts
// diffs the incoming option against the live one and animates matching
// series between their old and new values — which is what replaces the
// hand-rolled requestAnimationFrame tweening the uPlot DepthCurve needed.
export function buildChartBase(theme: ChartTheme) {
  return {
    color: theme.palette,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    animation: true,
    animationDuration: 0, // initial paint: no reason to animate in from nothing
    animationDurationUpdate: 200,
    animationEasingUpdate: "cubicOut" as const,
  };
}

export const CHART_MONO_FAMILY = MONO_FAMILY;

// Re-resolves whenever <html>'s class changes (ThemeToggle only ever
// touches the `dark` class, never these charts directly) via a
// MutationObserver rather than polling — the toggle is a rare, deliberate
// user action, not something worth checking on a timer for.
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(FALLBACK);

  useEffect(() => {
    const update = () => setTheme(resolveChartTheme());
    // FALLBACK was a guess made with no DOM to read; correct it once
    // mounted. Deferred to a microtask (not called directly here) so this
    // is a callback-triggered update, not a synchronous one.
    queueMicrotask(update);

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
