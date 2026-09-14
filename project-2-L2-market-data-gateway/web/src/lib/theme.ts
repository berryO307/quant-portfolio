import type { Attribution } from "./types";

// Single source of truth for this app's palette. Two families of color live
// here: (1) neutrals/accent, derived from the tweakcn theme in
// app/globals.css (Phase 8.5's redesign) — converted from its dark-mode
// OKLCH tokens to hex once, by hand, since uPlot's JS options need literal
// color strings, not CSS custom properties; and (2) domain colors (bid/ask,
// pipeline-stage attribution, host jitter), which are project-specific and
// were never part of any theme — kept exactly as established in Phase 5's
// Altair theme and carried through every phase since.
//
// Before this file existed, four components each hand-typed their own copy
// of the same hex values (LatencyChart, DepthCurve, StageBreakdown,
// TailEventsFeed) — consistent so far by careful copy-pasting, not by
// construction. Import from here instead so a future palette change only
// touches one file.

// ── Neutrals + accent (from the tweakcn theme's dark-mode tokens) ──────────
export const COLOR_BG = "#020817"; // --background
export const COLOR_PANEL_BG = "#0a1424"; // derived mid-tier: the theme has no
// distinct "card" tone (--card equals --background exactly) — this app still
// needs a subtle tint for header strips/dividers/stat boxes that reads as
// "slightly raised" without introducing a shadow or a border-toned fill.
export const COLOR_GRID = "#111b2a"; // derived, subtler than COLOR_BORDER — uPlot gridlines only
export const COLOR_BORDER = "#1e293b"; // --border / --secondary / --muted / --accent (all equal in this theme)
export const COLOR_MUTED = "#94a3b8"; // --muted-foreground
export const COLOR_TEXT = "#cbd5e1"; // between muted and bright — regular readable values (ladder/tape numbers)
export const COLOR_TEXT_BRIGHT = "#f8fafc"; // --foreground
export const COLOR_ACCENT = "#3b82f6"; // --primary — the one sparing UI accent (active tab, focus, mode toggle)

// ── Domain colors (not from the theme — project-specific, unchanged) ───────
export const COLOR_BID = "#3fb950"; // bids, publish stage, "live"/active state
export const COLOR_ASK = "#f85149"; // asks, alerts, degraded banner text
export const COLOR_PARSE = "#58a6ff"; // parse stage
export const COLOR_BOOK_UPDATE = "#bc8cff"; // book-update stage
// COLOR_JITTER/COLOR_SEVERE: host jitter (p99 reference line) and severity
// (p99.9/max reference line + stat) respectively. Both muted down from
// Phase 8.5's first-pass values (#d29922, #e3b341 — a fairly saturated
// amber/gold) in the third pass: next to the theme's blue --primary accent,
// they were reading as competing highlight colors rather than the secondary
// severity indicators they're meant to be. Same hues, ~50% less saturation
// and slightly darker — still visually distinct from each other and from
// bid-green/ask-red, just quieter. (COLOR_SEVERE itself was COLOR_ASK before
// the first pass, which collided with ask-red's bid/ask-only meaning — see
// git history; a latency severity marker and an ask price level have
// nothing to do with each other, but shared a color.)
export const COLOR_JITTER = "#9c7f43";
export const COLOR_SEVERE = "#b19655";
export const COLOR_ERROR_BG = "#3a1418"; // FeedStatusBanner's degraded background

export const ATTRIBUTION_COLORS: Record<Attribution | "normal", string> = {
  normal: COLOR_MUTED,
  host_jitter: COLOR_JITTER,
  parse: COLOR_PARSE,
  "book-update": COLOR_BOOK_UPDATE,
  publish: COLOR_BID,
};

// TailEventsFeed's deliberate variant: host_jitter muted/grey instead of
// amber, so it reads as less actionable than a colored stage attribution —
// not "our" pipeline's fault. See TailEventsFeed for the full rationale.
export const ATTRIBUTION_COLORS_MUTED_JITTER: Record<Attribution, string> = {
  host_jitter: COLOR_MUTED,
  parse: COLOR_PARSE,
  "book-update": COLOR_BOOK_UPDATE,
  publish: COLOR_BID,
};

// Display label for each attribution value — only host_jitter differs from
// its raw value (space instead of underscore).
export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  host_jitter: "host jitter",
  parse: "parse",
  "book-update": "book-update",
  publish: "publish",
};

export const STAGE_LABEL: Record<"parse" | "bookUpdate" | "publish", Attribution> = {
  parse: "parse",
  bookUpdate: "book-update",
  publish: "publish",
};

export const STAGE_COLOR: Record<"parse" | "bookUpdate" | "publish", string> = {
  parse: COLOR_PARSE,
  bookUpdate: COLOR_BOOK_UPDATE,
  publish: COLOR_BID,
};

// uPlot axis styling shared by every chart (LatencyChart, StageLatencyChart,
// DepthCurve) — kept here so no two charts can visually drift apart from
// each other, matching the same discipline computeDepthLevelsBucketed()
// applies to the ladder/curve's numbers.
//
// Refined in Phase 8.5's fourth pass — the previous version (solid grid,
// visible tick marks, no defined axis edge) rendered fine but read as an
// out-of-the-box chart rather than something styled for this theme. Tick
// marks are off entirely (the gridline + label already says where a value
// falls; a separate tick stub added nothing), the grid is a soft dashed
// line instead of solid, and the axis now has an explicit border — the same
// "give it a defined edge instead of a bare canvas" idea theme.ts's
// COLOR_PANEL_BG comment already applies to non-chart panels.
export const UPLOT_AXIS_STYLE = {
  stroke: COLOR_MUTED,
  grid: { stroke: COLOR_GRID, width: 1, dash: [2, 3] as number[] },
  ticks: { show: false },
  border: { show: true, stroke: COLOR_BORDER, width: 1 },
};
