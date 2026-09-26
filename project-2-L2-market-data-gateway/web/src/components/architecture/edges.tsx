"use client";

import { memo, useEffect, useRef, useState } from "react";
import { EdgeLabelRenderer, type Edge, type EdgeProps, type EdgeTypes } from "@xyflow/react";
import { COL_GAP, COLOR } from "./layout";

/*
 * Custom React Flow edge type for the architecture diagram (spec § "Edges").
 * Every link is THREE stacked <path>s sharing one `d`:
 *   1. casing — 10px round-cap stroke, red (hot path) or slate (off-hot):
 *      the hot/cold marker.
 *   2. track  — 1.5px stroke in the link's protocol colour, with an
 *      arrowhead at the end.
 *   3. pulse  — 3px glowing comet, animated (see globals.css .tf-comet).
 *
 * The hot/cold boundary is data (`casing` below), not something computed
 * from node identity — it sits at the GATEWAY'S RIGHT EDGE per spec, so
 * only "exchange -> gateway" is `hot`; every other link (including
 * "gateway -> relay", which crosses the network) is `off-hot`. This is
 * deliberate — relay push and export drain are off-hot threads, so the hot
 * path already ended before the wire. Do not "fix" this by making
 * gateway->relay hot too.
 *
 * Comet sizing: PER-EDGE MEASURED path length, not a fixed pixel guess.
 * An earlier pass hardcoded a 136px period (36 comet + 100 gap), sized for
 * the original, much-more-spread-out column layout. Once the columns were
 * widened-and-tightened (this page's width/height rework), real edge paths
 * came out far shorter (~55-67px for the pipeline row) or, for the two
 * dropped/arced links, far longer (~300-660px) than that fixed 136px
 * assumption — so the SAME fixed dasharray either barely painted anything
 * visible on the short edges (36px comet swallowed by a 100px gap on a
 * 55px path — mostly gap, and when the "on" segment DID land on the path it
 * covered most of it at once, reading as a flash, not a travelling dot) or
 * tiled multiple simultaneous comet segments on the long ones (a 136px
 * pattern repeating ~2-5x across a 300-660px path, each copy animating
 * together — several comets chasing each other on one link, not one).
 * Measuring each path's own rendered length (via a ref + getTotalLength(),
 * not `pathLength` normalisation — SVG's own pathLength attribute rewrites
 * the coordinate system implicitly and silently shrinks/distorts the dash,
 * which is why the original comment here warned against it) and sizing the
 * comet to exactly 1/3 of THAT length, with the gap filling the other 2/3
 * and the animation travelling exactly one full path length per cycle, is
 * what guarantees exactly one comet, always visible, always sized relative
 * to its own link, on every edge regardless of how far apart its two nodes
 * end up being.
 */

export type EdgeOrientation = "row" | "underArc" | "vertical";
export type EdgeCasing = "hot" | "off-hot";

export interface SpecEdgeData extends Record<string, unknown> {
  protocolColor: string;
  casing: EdgeCasing;
  orientation: EdgeOrientation;
  pulseDurationS: number;
  pulseDelayS?: number;
  markerId: string;
  label: { endpoint: string; payload: string };
  /** Nudges the label off the path's literal midpoint — used for the
   * gateway->disk link, whose label sits "beside" the link per spec, not
   * centred on top of it. */
  labelOffset?: { x: number; y: number };
}

const CASING_COLOR: Record<EdgeCasing, string> = {
  hot: COLOR.hot,
  "off-hot": COLOR.offHot,
};
const CASING_ALPHA: Record<EdgeCasing, number> = {
  hot: 0.17,
  "off-hot": 0.11,
};
// What the Legend card used to spell out generically ("Live WebSocket
// stream" / "HTTP poll (slower pulse)" / "Disk write" for line colour,
// "Red = hot path, slate = off-hot" for casing colour) now lives on the
// lines themselves — hover shows it instead of a fixed corner card, so
// keyed by the exact colour value each edge already carries.
const PROTOCOL_MEANING: Record<string, string> = {
  [COLOR.accentBlue]: "Live WebSocket stream",
  [COLOR.accentTeal]: "HTTP poll (slower pulse)",
  [COLOR.disk]: "Disk write",
};
const CASING_MEANING: Record<EdgeCasing, string> = {
  hot: "Hot path",
  "off-hot": "Off-hot path",
};
// Theme-aware text colour for off-hot text — plain COLOR.offHot (slate) is
// the same washed-out-in-one-theme problem --cold-path-text/offHotLight
// already fixed elsewhere on this page; reused here for the same reason.
const CASING_TEXT_COLOR: Record<EdgeCasing, string> = {
  hot: COLOR.hot,
  "off-hot": COLOR.offHotLight,
};

function buildPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  orientation: EdgeOrientation,
): { d: string; midX: number; midY: number } {
  if (orientation === "underArc") {
    // Dips below both cards — source and target are both bottom-mounted
    // handles on nodes in the same row (viewer, relay).
    const dipY = Math.max(sourceY, targetY) + 54;
    // EASE, not 0: a control point sharing its endpoint's exact X forces
    // the tangent AT that endpoint to be perfectly vertical — that's the
    // TRUE derivative, so the arrowhead (which orients to it correctly)
    // ends up looking "right" in isolation but wrong next to the curve,
    // because the visible stroke leading up to it has been sweeping at a
    // shallow angle the whole way and then snaps to 90° only in the very
    // last pixel — a "hook" the eye reads as the arrow not matching the
    // line. Offsetting each control point by a fraction of dx blends that
    // last stretch of tangent toward the curve's actual sweep instead of
    // a dead vertical snap, so the arrow now points along the same angle
    // the line is visibly travelling at, not just its literal endpoint
    // derivative.
    const dx = (targetX - sourceX) * 0.18;
    const d = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${dipY}, ${targetX - dx} ${dipY}, ${targetX} ${targetY}`;
    return { d, midX: (sourceX + targetX) / 2, midY: dipY };
  }
  if (orientation === "vertical") {
    // Fixed curve "reach" (36px), not derived from the actual gap: this
    // edge's target (Capture Sink) can sit well to the LEFT of its source
    // (Gateway) now, and a midY-based control point collapses onto the
    // endpoints once the gap shrinks — leaving zero vertical room for the
    // curve to cover that horizontal offset smoothly, which is what
    // kinked this line into a sharp bend once DISK_LABEL_GAP got small.
    // A fixed reach keeps the S-curve shape smooth no matter how tight
    // the gap gets, the same way "row" below always uses half of dx
    // regardless of how close the two columns are. Deliberately NOT
    // clamped to the actual gap size — if the gap shrinks below 2*reach,
    // the two control points simply cross over each other, which draws a
    // gentle S/wave instead of failing; capping reach to the gap is what
    // brings back exactly the collapse-to-a-kink bug this is fixing.
    const reach = 36;
    const midY = (sourceY + targetY) / 2;
    // EASE, not 0: same reasoning as underArc above — a control point
    // sharing its endpoint's exact X forces a dead-vertical tangent right
    // at that endpoint, which the arrowhead correctly follows but which
    // reads as disconnected from the curve's actual diagonal sweep (this
    // edge travels sideways to reach Capture Sink, now offset well left of
    // Gateway). Only easing the TARGET side (dx), not the source: Gateway's
    // own bottom-source handle should still emit straight down — that's
    // the natural, correct-looking start; only the arriving end had a
    // visible arrowhead to misalign.
    const dx = (targetX - sourceX) * 0.25;
    const d = `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + reach}, ${targetX - dx} ${targetY - reach}, ${targetX} ${targetY}`;
    return { d, midX: (sourceX + targetX) / 2, midY };
  }
  // "row" — plain horizontal S-curve between two same-row, side-by-side cards.
  const dx = (targetX - sourceX) / 2;
  const d = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX - dx} ${targetY}, ${targetX} ${targetY}`;
  return { d, midX: (sourceX + targetX) / 2, midY: (sourceY + targetY) / 2 };
}

/** 1/3 comet, 2/3 gap — matches spec's own "comet ~⅓ of the link" sizing,
 * just computed from the path's real length instead of assumed. */
function cometDashFor(pathLength: number): { dasharray: string; period: number } {
  const comet = pathLength / 3;
  const gap = pathLength - comet;
  return { dasharray: `${comet} ${gap}`, period: pathLength };
}

// Default vertical nudge that lifts a "row" edge's label clear of the path
// itself. With the original, far-more-spread-out column layout a label sat
// centred on a long link and still left comet visible on either side; once
// the columns were tightened, several pipeline links measure only ~55-67px
// end to end — shorter than the label box itself — so a label dead-centred
// ON the path completely covers the comet for that link's entire length,
// the whole time. Lifting the label off the path (it already sits in its
// own DOM layer via EdgeLabelRenderer, so this is purely a label
// repositioning, not a path change) leaves the comet visible along the
// actual line while the label still reads as "belonging" to that link.
// -20 wasn't enough clearance once cards got taller/denser again — the
// label's own box (with its padding) still overlapped the comet's actual
// travel path at the label's bottom edge, so the moving pulse read as
// disappearing "under" the label instead of just passing near it.
const ROW_LABEL_Y_OFFSET = -34;

function SpecEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const edgeData = data as SpecEdgeData;
  const { d, midX, midY } = buildPath(sourceX, sourceY, targetX, targetY, edgeData.orientation);
  const defaultLabelOffsetY = edgeData.orientation === "row" ? ROW_LABEL_Y_OFFSET : 0;
  const labelX = midX + (edgeData.labelOffset?.x ?? 0);
  const labelY = midY + (edgeData.labelOffset?.y ?? defaultLabelOffsetY);

  const pulseRef = useRef<SVGPathElement>(null);
  const [dash, setDash] = useState<{ dasharray: string; period: number } | null>(null);
  const [hovered, setHovered] = useState(false);

  // Measured on mount and whenever `d` changes (never, in practice — this
  // diagram is static — but node positions are still only known once React
  // Flow has laid the graph out, so the very first paint needs this too).
  // Not `pathLength` normalisation: this reads the path's OWN rendered
  // geometric length back out via the standard SVG API, then sizes a plain
  // pixel dasharray to it — the coordinate system itself is untouched.
  useEffect(() => {
    const el = pulseRef.current;
    if (!el) return;
    const length = el.getTotalLength();
    if (length > 0) setDash(cometDashFor(length));
  }, [d]);

  return (
    <>
      {/* 0. hit area — invisible, wide (16px) stroke purely so hovering the
          line is actually possible: the visible casing/track/pulse paths
          are 1.5-10px, which is a thin, easy-to-miss target for what the
          Legend card used to always show. pointerEvents "stroke" (not the
          default "visiblePainted") keeps hit-testing confined to the path
          itself instead of triggering across this component's whole
          otherwise-transparent bounding box. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={16} style={{ pointerEvents: "stroke" }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} />
      {/* 1. casing — the hot/cold marker. pointerEvents "none": without it
          this (and track/pulse below) each default to SVG's own
          "visiblePainted" hit-testing on their painted stroke, and since
          they're drawn AFTER (on top of) the invisible hit path above,
          the cursor kept flickering between "over the hit path" and "over
          this thinner painted stroke" as it moved — each handoff fired a
          spurious mouseleave/mouseenter on the hit path, which is exactly
          why the hover tooltip flashed on then immediately off. Only the
          hit path above should ever receive pointer events. */}
      <path
        d={d}
        fill="none"
        stroke={CASING_COLOR[edgeData.casing]}
        strokeOpacity={CASING_ALPHA[edgeData.casing]}
        strokeWidth={10}
        strokeLinecap="round"
        style={{ pointerEvents: "none" }}
      />
      {/* 2. track — protocol colour, faint, with an arrowhead at the end */}
      <path
        d={d}
        fill="none"
        stroke={edgeData.protocolColor}
        strokeOpacity={0.22}
        strokeWidth={1.5}
        markerEnd={`url(#${edgeData.markerId})`}
        style={{ pointerEvents: "none" }}
      />
      {/* 3. pulse — the animated comet. Invisible (opacity 0) until its
          real length has been measured, so it never flashes a wrongly-
          sized dash for one frame before snapping to the correct size. */}
      <path
        ref={pulseRef}
        className="tf-comet"
        style={
          {
            pointerEvents: "none",
            "--tf-comet-dur": `${edgeData.pulseDurationS}s`,
            "--tf-comet-delay": `${edgeData.pulseDelayS ?? 0}s`,
            "--tf-comet-period": dash ? `${-dash.period}px` : "0px",
            strokeDasharray: dash?.dasharray,
            opacity: dash ? 1 : 0,
            filter: `drop-shadow(0 0 6px ${edgeData.protocolColor})`,
          } as React.CSSProperties
        }
        d={d}
        fill="none"
        stroke={edgeData.protocolColor}
        strokeWidth={3}
        strokeLinecap="round"
        data-edge-id={id}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            // z-index: a label sitting on top of a comet/casing already
            // needs to paint above the edge layer; without this it
            // rendered behind the CARDS too, which is what made "wss"
            // read as "ss" — the card's own opaque background was
            // covering the label's edges, not clipping its text.
            zIndex: 1000,
            // maxWidth: caps the label at the column gap it actually has
            // to live in (COL_GAP, minus this box's own border/padding),
            // NOT the text's natural width. Without this, a longer label
            // on some future edge just overlaps the neighbouring cards
            // again, exactly like this one did — capping the width and
            // dropping whitespace-nowrap (below) makes it wrap onto more
            // lines instead, which self-adjusts for any label length
            // without hand-tuning positions per edge.
            // COL_GAP - 40, not - 20: the label needs clearance on BOTH
            // sides now (gateway's card on the left, the COLD PATH frame's
            // own border 8px inside relay's edge on the right) — at -20
            // the label's own half-width left only ~2px of slack against
            // the frame border even when perfectly centred, and the old
            // manual x-offset (edge "gateway-relay") pushing it further
            // left to dodge that frame just pushed it straight through
            // gateway's card on the other side instead. -40 gives real
            // margin on both sides at once, so no offset is needed at all.
            maxWidth: edgeData.orientation === "row" ? COL_GAP - 40 : 220,
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "none",
          }}
          className="rounded-md border border-border/70 bg-panel/90 px-2 py-1.5 text-center leading-tight shadow-sm backdrop-blur-sm"
        >
          <div className="font-mono text-[10.5px] font-medium" style={{ color: edgeData.protocolColor }}>
            {edgeData.label.endpoint}
          </div>
          <div className="mt-0.5 text-[9.5px] text-dim">{edgeData.label.payload}</div>
          {/* Legend replacement — only on hover, since this is what the old
              fixed Legend card always showed for every line's colour. */}
          {hovered && (
            <div className="mt-1 border-t border-border/50 pt-1 text-[9.5px] leading-tight">
              <span style={{ color: edgeData.protocolColor }}>
                {PROTOCOL_MEANING[edgeData.protocolColor] ?? edgeData.protocolColor}
              </span>
              <span className="text-dim"> · </span>
              <span style={{ color: CASING_TEXT_COLOR[edgeData.casing] }}>{CASING_MEANING[edgeData.casing]}</span>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// memo: without this, every React Flow re-render (a hover, a theme toggle,
// a zoom/pan tick) recreates this component's props object, which by
// itself wouldn't restart a CSS animation — but it WOULD re-run the
// getTotalLength() effect and briefly re-set `dash` to the same value,
// and on some browsers a `style` object identity change on an animating
// element can restart the animation's clock even when the computed values
// are unchanged. memo makes the common case (nothing this edge cares about
// actually changed) skip re-rendering entirely, so the animation's timeline
// is never touched by something happening elsewhere on the page.
const MemoSpecEdge = memo(SpecEdge);

export const edgeTypes: EdgeTypes = { spec: MemoSpecEdge };

// Marker ids — referenced by track paths above, defined once as real SVG
// <marker> elements in ArchitectureView (React Flow's edge SVG needs the
// <defs> to live in the same <svg>, so ArchitectureView renders them via
// ArrowMarkerDefs, exported below for it to use).
const MARKER_BLUE = "arch-arrow-blue";
const MARKER_TEAL = "arch-arrow-teal";
const MARKER_DISK = "arch-arrow-disk";

// Each colour here is used by exactly one pulseDurationS across every edge
// (accentBlue edges are all 1.25s, the teal health-check edge is 2.6s, the
// disk edge is 1.05s — see ARCHITECTURE_EDGES below), so the arrowhead can
// share that same rhythm without ever fighting a second, differently-timed
// edge reusing the same marker colour.
const MARKER_DURATION_S: Record<string, number> = {
  [MARKER_BLUE]: 1.25,
  [MARKER_TEAL]: 2.6,
  [MARKER_DISK]: 1.05,
};

export function ArrowMarkerDefs() {
  const defs: { id: string; color: string }[] = [
    { id: MARKER_BLUE, color: COLOR.accentBlue },
    { id: MARKER_TEAL, color: COLOR.accentTeal },
    { id: MARKER_DISK, color: COLOR.disk },
  ];
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {defs.map(({ id, color }) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            {/* Was a flat, permanently-static fillOpacity — every other
                moving part on this page (comet, chips, halos) pulses or
                travels, so a dead arrowhead sitting right at the end of an
                animating line read as broken/disconnected rather than part
                of the same system. tf-arrow-pulse breathes its opacity in
                the same rhythm as the comet using this exact marker colour
                (see MARKER_DURATION_S) — not phase-locked to any one
                edge's comet (several differently-delayed edges share one
                blue marker, so exact per-edge sync isn't possible with a
                single shared <marker>), but alive at the same tempo instead
                of static. */}
            <path
              className="tf-arrow-pulse"
              d="M 0 0 L 10 5 L 0 10 z"
              fill={color}
              style={{ ["--tf-arrow-dur" as string]: `${MARKER_DURATION_S[id]}s` } as React.CSSProperties}
            />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

function edge(
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  opts: SpecEdgeData,
): Edge<SpecEdgeData> {
  return {
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: "spec",
    data: opts,
  };
}

// Six links total (spec § "Edges" table): four along the row, one return
// (viewer -> relay /health, drawn right-to-left per spec), one disk write.
// There is deliberately NO edge from browser to Hyperliquid — the browser
// never talks to the exchange, only to the relay. Do not add one.
export const ARCHITECTURE_EDGES: Edge<SpecEdgeData>[] = [
  edge("exchange-gateway", "exchange", "right-source", "gateway", "left-target", {
    protocolColor: COLOR.accentBlue,
    casing: "hot", // the ONLY hot-cased link — boundary is the gateway's right edge
    orientation: "row",
    pulseDurationS: 1.25,
    pulseDelayS: 0,
    markerId: MARKER_BLUE,
    label: { endpoint: "wss · TLS 1.3", payload: "trades + l2Book / 5 sockets" },
  }),
  edge("gateway-relay", "gateway", "right-source", "relay", "left-target", {
    protocolColor: COLOR.accentBlue,
    casing: "off-hot",
    orientation: "row",
    pulseDurationS: 1.25,
    pulseDelayS: 0.2,
    markerId: MARKER_BLUE,
    label: { endpoint: "ws /ingest", payload: "normalised ticks / + latency samples" },
    // No x-offset: a manual -30 push toward gateway was here to dodge the
    // COLD PATH frame's left border, but with maxWidth now COL_GAP - 40
    // (see edges.tsx label sizing above) the centred label already clears
    // the frame border on the right AND gateway's card on the left. The
    // offset was tuned for a wider label that no longer applies and was
    // instead pushing this label through HotPathFrame/L2DataCapture.
    labelOffset: { x: 0, y: ROW_LABEL_Y_OFFSET },
  }),
  edge("relay-viewer", "relay", "right-source", "viewer", "left-target", {
    protocolColor: COLOR.accentBlue,
    casing: "off-hot",
    orientation: "row",
    pulseDurationS: 1.25,
    pulseDelayS: 0.4,
    markerId: MARKER_BLUE,
    label: { endpoint: "ws /live", payload: "every record as-is / + stats @ 1 Hz" },
  }),
  edge("viewer-browser", "viewer", "right-source", "browser", "left-target", {
    protocolColor: COLOR.accentBlue,
    casing: "off-hot",
    orientation: "row",
    pulseDurationS: 1.25,
    pulseDelayS: 0.6,
    markerId: MARKER_BLUE,
    label: { endpoint: "render", payload: "one paint per / animation frame" },
  }),
  // Return link — source is `viewer`, target is `relay`, so the path is
  // drawn viewer -> relay (right-to-left on screen, since viewer sits to
  // the right of relay). Negative dashoffset then travels forward along
  // THAT direction, matching spec's explicit "must be drawn viewer->relay".
  edge("viewer-relay-health", "viewer", "bottom-source", "relay", "bottom-target", {
    protocolColor: COLOR.accentTeal,
    casing: "off-hot",
    orientation: "underArc",
    pulseDurationS: 2.6,
    markerId: MARKER_TEAL,
    label: { endpoint: "GET /health", payload: "200 ok · 503 degraded" },
  }),
  edge("gateway-disk", "gateway", "bottom-source", "captureSink", "top-target", {
    protocolColor: COLOR.disk,
    casing: "off-hot",
    orientation: "vertical",
    pulseDurationS: 1.05,
    markerId: MARKER_DISK,
    label: { endpoint: "mmap · CSV · gzip", payload: "off the hot path" },
    // Was x:118 — far enough right that the label read as unrelated to
    // the vertical drop it's actually labelling. Pulled in to sit close
    // beside the line instead.
    labelOffset: { x: 58, y: 0 },
  }),
];
