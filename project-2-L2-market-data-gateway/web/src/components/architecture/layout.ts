/*
 * Shared geometry/colour constants for the architecture diagram. Kept in
 * one file because nodes.tsx (card positions, rail widths) and edges.tsx
 * (link endpoints, casing colour) both need the same column math —
 * duplicating it in both places is exactly how it drifts.
 *
 * Layout shape (hierarchy pass): one continuous React Flow coordinate
 * system — every card below is a real node with a real {x, y} position on
 * the SAME canvas, so pan/zoom moves and scales it all together. Legend is
 * the one exception: it's a screen-fixed overlay rendered outside this
 * canvas entirely (ArchitectureView.tsx), deliberately NOT part of this
 * coordinate system, so it does not pan or zoom with everything else.
 *
 *   [Hyperliquid]→(HOT PATH┌Gateway┐)→(COLD PATH┌Relay→Viewer→Browser┐)
 *                          └──────┘         └──────────────────────┘
 *                              |
 *                        [Capture Sink]
 *   ──────────────────── latency instrumentation (full width) ──────────────────────
 *
 * HOT PATH and COLD PATH are no longer a rail strip floating above the
 * row — HOT PATH is HotPathFrame, a JSX wrapper around L2DataCapture's own
 * content; COLD PATH is ColdPathBackdropNode, a separate background NODE
 * (negative zIndex) sized to enclose relay/viewer/browser, since a JSX
 * wrapper can't span three sibling React Flow nodes. Both live in
 * nodes.tsx.
 */

// Design tokens — dark-mode hex literals. Card chrome (bg/border/text)
// goes through the app's existing --panel/--border/--foreground theme
// tokens so light mode "just works"; these are fixed accent colours (only
// glow intensity may differ by theme, never the hue), so they are not
// re-derived from the theme system.
export const COLOR = {
  accentBlue: "#5b9bf7", // gateway, WebSocket links
  accentTeal: "#2dd4bf", // source, HTTP links
  accentGreen: "#4ade80", // relay
  accentViolet: "#a78bfa", // book-update
  accentPink: "#f472b6", // browser, publish
  accentAmber: "#f0a83d", // backpressure
  accentGold: "#c9a227", // fixed-capacity numbers
  hot: "#f0546b", // hot path — red
  offHot: "#64748b", // cold path — slate
  // Was a fixed #94a3b8 (light slate) shared by both themes — glary
  // against dark mode's near-black background and nearly invisible
  // against light mode's white one. Now a real per-theme CSS variable
  // (globals.css), same pattern --rf-grid-dot already uses for exactly
  // this failure mode. Affects every "off-hot/cold" badge and label on
  // this page (COLD PATH, WRITE-ONLY, System Constants' Off-hot group),
  // not just one spot — they all had the same bug.
  offHotLight: "var(--cold-path-text)",
  disk: "#cbd5e1",
} as const;

// Normalised inter-row/inter-card gap used everywhere.
export const ROW_GAP = 30;

// Pipeline column geometry — end-caps (Hyperliquid, Browser) are short and
// vertically centred against the tall cards either side of them; the three
// systems this project builds (gateway/relay/viewer) are full height.
//
// Narrowed further still (250/340 -> 220/300): every row inside these
// cards is single-column (`cols={1}` on Group — see nodes.tsx) — a short
// label on the left, a short tag pill on the right, nothing else on that
// line, so there's no reason for these to be as wide as the original
// 280/460. Paired with tighter Row/Card padding (px-2->px-1.5, gap-2->
// gap-1.5, p-2.5->p-2 in nodes.tsx) to claw back a little more room
// without losing the safety margin these widths need. Sized to the actual
// longest label+tag pairs across these cards (roughly "Export ring ->
// ColdPathExporter" / "65,536 slots" for STAGE_WIDTH, "l2Book nSigFigs
// 4/3/2" / "3 sockets" for END_CAP_WIDTH) with headroom — not measured
// live, nudge up if any row still wraps.
export const END_CAP_WIDTH = 220;
export const STAGE_WIDTH = 300;
// Wide enough to hold a two-line edge label (endpoint + payload) without
// it having to spill onto the cards on either side — 56 was sized for the
// connector line alone and never accounted for the label sitting on top
// of it, which is what was overlapping "L2DataCapture" and "Hyperliquid".
// EdgeLabelRenderer content in edges.tsx is also width-capped to this gap
// (minus its own padding), so a longer label on a future edge WRAPS
// (grows taller) instead of silently overlapping neighbouring cards again.
export const COL_GAP = 130;

// Left margin only now — Legend used to reserve a sidebar column here, but
// it's a fixed screen overlay now, not a canvas node, so the pipeline
// reclaims that space and starts near the canvas's own left edge.
const MAIN_X = ROW_GAP;

export const COL_X = {
  exchange: MAIN_X,
  gateway: MAIN_X + END_CAP_WIDTH + COL_GAP,
  relay: MAIN_X + END_CAP_WIDTH + COL_GAP + STAGE_WIDTH + COL_GAP,
  viewer: MAIN_X + END_CAP_WIDTH + COL_GAP + 2 * (STAGE_WIDTH + COL_GAP),
  browser: MAIN_X + END_CAP_WIDTH + COL_GAP + 3 * (STAGE_WIDTH + COL_GAP),
} as const;

// Full canvas width, sidebar included — the latency instrumentation card
// spans this ("full-width card directly underneath the architecture").
export const CANVAS_WIDTH = COL_X.browser + END_CAP_WIDTH;

// The hot/cold boundary sits at the GATEWAY'S RIGHT EDGE, not the network
// edge — relay push and export drain are off-hot threads, so the hot path
// ends at the ring hand-off inside the C++ process, before the wire. This
// is deliberate — do not move it to the exchange<->gateway or
// gateway<->relay wire. HotPathFrame wrapping exactly (and only)
// L2DataCapture, and ColdPathBackdropNode starting exactly at
// COL_X.relay, is this rule expressed visually — do not grow the hot
// frame to cover gateway<->relay, or shrink the cold backdrop to exclude
// relay.
export const HOT_COLD_BOUNDARY_X = COL_X.gateway + STAGE_WIDTH;
