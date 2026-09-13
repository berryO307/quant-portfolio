import type { Attribution } from "./types";

// Single source of truth for this app's palette — GitHub-dark-inspired,
// established in Phase 5's Altair theme and carried through every phase
// since. Before this file existed, four components each hand-typed their
// own copy of the same hex values (LatencyChart, DepthCurve, StageBreakdown,
// TailEventsFeed) — consistent so far by careful copy-pasting, not by
// construction. Import from here instead so a future palette change only
// touches one file.

export const COLOR_BG = "#0d1117";
export const COLOR_PANEL_BG = "#161b22";
export const COLOR_GRID = "#21262d";
export const COLOR_BORDER = "#30363d";
export const COLOR_MUTED = "#8b949e";
export const COLOR_TEXT = "#c9d1d9";
export const COLOR_TEXT_BRIGHT = "#f0f6fc";

export const COLOR_BID = "#3fb950"; // bids, publish stage, "live"/active state
export const COLOR_ASK = "#f85149"; // asks, alerts, p99.9, degraded banner text
export const COLOR_PARSE = "#58a6ff"; // parse stage
export const COLOR_BOOK_UPDATE = "#bc8cff"; // book-update stage
export const COLOR_JITTER = "#d29922"; // host jitter, in contexts where it should stand out
export const COLOR_ERROR_BG = "#3a1418"; // FeedStatusBanner's degraded background
export const COLOR_ACTIVE = "#238636"; // active toggle/button state (LatencyPanel's mode switch)

// Default (colored) attribution palette — every category stands out equally.
// Used by charts (LatencyChart) and the depth curve's own bid/ask coloring.
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

// uPlot axis styling shared by every chart (LatencyChart, DepthCurve) — kept
// here so the two live charts can never visually drift apart from each
// other, matching the same discipline computeDepthLevels() applies to the
// ladder/curve's numbers.
export const UPLOT_AXIS_STYLE = {
  stroke: COLOR_MUTED,
  grid: { stroke: COLOR_GRID, width: 1 },
  ticks: { stroke: COLOR_BORDER },
};
