"use client";

import { useEffect, useState } from "react";

// Live, theme-reactive colors for the three uPlot chart components
// (DepthCurve, LatencyChart, StageLatencyChart). Deliberately separate from
// lib/theme.ts's COLOR_* constants, which stay static hex — those are also
// read by four non-chart components (LatencyPanel, SessionStatsHeader,
// StageBreakdown, TailEventsFeed) where a color that doesn't repaint on a
// theme toggle is a minor, non-broken outcome (status colors reading fine
// on both light/dark backgrounds is a common, acceptable simplification),
// not worth widening this change to touch. uPlot's own options are
// different: colors are literal strings baked into series/axes at
// construction time, not CSS the browser repaints automatically — a chart
// built once under one theme stays that theme's colors forever unless
// something re-resolves and re-applies them.
export interface ChartTheme {
  grid: string;
  border: string;
  muted: string;
  text: string;
  bid: string;
  ask: string;
  parse: string;
  bookUpdate: string;
  jitter: string;
  severe: string;
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
  bookUpdate: "#bc8cff",
  jitter: "#9c7f43",
  severe: "#b19655",
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

export function resolveChartTheme(): ChartTheme {
  return {
    grid: resolveVar("--grid", FALLBACK.grid),
    border: resolveVar("--border", FALLBACK.border),
    muted: resolveVar("--muted-foreground", FALLBACK.muted),
    text: resolveVar("--chart-text", FALLBACK.text),
    bid: resolveVar("--bid", FALLBACK.bid),
    ask: resolveVar("--ask", FALLBACK.ask),
    parse: resolveVar("--parse", FALLBACK.parse),
    bookUpdate: resolveVar("--book-update", FALLBACK.bookUpdate),
    jitter: resolveVar("--jitter", FALLBACK.jitter),
    severe: resolveVar("--severe", FALLBACK.severe),
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

// Replaces lib/theme.ts's static UPLOT_AXIS_STYLE for the three chart
// components — same shape, built fresh from a live ChartTheme instead of
// three hardcoded hex constants, so grid/border/tick color actually follow
// the active theme.
export function buildAxisStyle(theme: ChartTheme) {
  return {
    stroke: theme.muted,
    grid: { stroke: theme.grid, width: 1, dash: [2, 3] as number[] },
    ticks: { show: false },
    border: { show: true, stroke: theme.border, width: 1 },
  };
}

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
