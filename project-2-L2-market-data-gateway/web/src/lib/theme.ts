import type { Attribution, StageNs } from "./types";

// Single source of truth for this app's palette. Two families of color live
// here: (1) neutrals/accent, derived from the tweakcn theme in
// app/globals.css (Phase 8.5's redesign) — converted from its dark-mode
// OKLCH tokens to hex once, by hand, since uPlot's JS options need literal
// color strings, not CSS custom properties; and (2) domain colors (bid/ask,
// pipeline-stage attribution), which are project-specific and were never
// part of any theme — kept exactly as established in Phase 5's
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
// Queue wait (gateway thread -> consumer thread handoff). Teal: it has to
// sit beside parse-blue and book-update-purple without reading as either,
// since the three are routinely compared against each other in the tail
// drill-down, and it must not borrow bid-green or ask-red, which mean a
// book side everywhere else in this app.
export const COLOR_QUEUE = "#2dd4bf";
// COLOR_SEVERE: severity (p99.9/max reference line + stat). Muted down from
// Phase 8.5's first-pass value (#e3b341 — a fairly saturated amber/gold) in
// the third pass: next to the theme's blue --primary accent, it was reading
// as a competing highlight color rather than the secondary severity
// indicator it's meant to be. (Was COLOR_ASK before the first pass, which
// collided with ask-red's bid/ask-only meaning — see git history; a latency
// severity marker and an ask price level have nothing to do with each
// other, but shared a color.)
export const COLOR_SEVERE = "#b19655";
export const COLOR_ERROR_BG = "#3a1418"; // FeedStatusBanner's degraded background

export const ATTRIBUTION_COLORS: Record<Attribution | "normal", string> = {
  normal: COLOR_MUTED,
  parse: COLOR_PARSE,
  queue: COLOR_QUEUE,
  "book-update": COLOR_BOOK_UPDATE,
  publish: COLOR_BID,
};

// Display label for each attribution value.
export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  parse: "parse",
  queue: "queue wait",
  "book-update": "book-update",
  publish: "publish",
};

// Keyed by StageNs's own field names, in pipeline order — StageBreakdown
// iterates these to render one bar per stage.
export const STAGE_LABEL: Record<keyof StageNs, Attribution> = {
  parse: "parse",
  queue: "queue",
  bookUpdate: "book-update",
  publish: "publish",
};

export const STAGE_COLOR: Record<keyof StageNs, string> = {
  parse: COLOR_PARSE,
  queue: COLOR_QUEUE,
  bookUpdate: COLOR_BOOK_UPDATE,
  publish: COLOR_BID,
};

// Axis styling for the charts now lives in lib/chartTheme.ts's
// buildAxisStyle(), built from live CSS custom properties rather than these
// static hex constants — the static version could never follow a light/dark
// toggle. The constants above are still read by the non-chart components
// (StageBreakdown, TailEventsFeed, LatencyPanel).
