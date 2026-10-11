"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OrderBookLadder } from "./OrderBookLadder";
import { DepthCurve } from "./DepthCurve";
import { TARGET_LADDER_ROWS } from "@/lib/orderBook";
import type { InstrumentConfig } from "@/lib/instruments";
import type { CoarseSnapshotRecord, SnapshotRecord, TimedTrade } from "@/lib/types";

// Matches DepthCurve's own default `minHeight` prop — passed explicitly
// below (rather than relying on that default silently agreeing with this
// constant) so the drag clamp here and the chart's own internal CSS floor
// can never drift apart if one of them changes later.
const DEPTH_CURVE_MIN_HEIGHT = 200;
// Thickness of the draggable handle itself.
const DIVIDER_HEIGHT = 6;

// Row-geometry estimates matching OrderBookLadder's own Tailwind classes —
// LadderHeader (text-[10px], py-1, border-b), LadderRow/PlaceholderRow
// (text-xs, py-0.5), SpreadAndTickerRow (its inner text-xs span sets the
// tallest line, py-1, border-y). Used ONLY to size the ladder in whole-row
// increments (see MIN_LADDER_HEIGHT and the drag-snapping in
// onDividerPointerMove below) — an approximation is fine here since being a
// few px off just shifts where a drag snaps, not whether rows render
// correctly (OrderBookLadder's own CSS clipping, not this component, is
// what's actually responsible for a row rendering whole or not at all).
const HEADER_HEIGHT_PX = 24;
const SPREAD_ROW_HEIGHT_PX = 26;
const ROW_HEIGHT_PX = 20;
// Fixed chrome present regardless of row count (header + the spread/ticker
// divider row).
const LADDER_BASE_HEIGHT_PX = HEADER_HEIGHT_PX + SPREAD_ROW_HEIGHT_PX;

// The floor for the ladder side of the split, expressed as "always show at
// least this many real rows per side" rather than a raw pixel guess — a
// bare pixel number (120px, the original value here) turned out to only fit
// 2-3 rows, unreadable. 9 rows/side is enough to read real price structure
// at a glance without needing the depth curve to have handed over the
// entire panel.
const MIN_LADDER_ROWS_PER_SIDE = 9;
// Below this container width, the floor drops further still — a phone
// screen doesn't have room for both a 9-row-per-side ladder AND a readable
// depth curve without one of them getting squeezed; the ladder is the one
// that should give way, matching Hyperliquid's own mobile app convention
// of a compact top-of-book snapshot rather than the full desktop ladder.
const MOBILE_WIDTH_PX = 480;
const MOBILE_MIN_LADDER_ROWS_PER_SIDE = 5;

// Upper bound on how many rows a drag can ever ask for — matches
// OrderBookLadder's own row cap (MAX_LEVELS_PER_SIDE, itself
// TARGET_LADDER_ROWS) so dragging can't snap to a row count the ladder
// would never actually render that many real (or placeholder) rows for.
const MAX_LADDER_ROWS_PER_SIDE = TARGET_LADDER_ROWS;

// Starting row count per side, before the user ever touches the divider.
// Previously the ladder started at its natural/uncapped size (up to
// TARGET_LADDER_ROWS = 20 rows, whatever real book depth filled), which
// read as too tall against the depth curve below it. 17 is deliberately
// still short of the 20-row cap — leaves the ladder reading as "a lot of
// rows" rather than "every row", closer to the depth curve's share of the
// split. Dragging and the existing double-click-to-reset behaviour are
// unchanged — this only moves where the split STARTS.
const DEFAULT_LADDER_ROWS_PER_SIDE = 17;

function minLadderHeightFor(minRows: number): number {
  return LADDER_BASE_HEIGHT_PX + minRows * 2 * ROW_HEIGHT_PX;
}

// Nearest whole-row-pair height to `rawHeight`, clamped to
// [minRows, MAX_LADDER_ROWS_PER_SIDE] rows/side and never exceeding
// `ceiling`. Used so a drag always lands exactly on "N rows per side,"
// never mid-row — a raw pixel height let the divider stop with a row
// sliced cleanly in half by the ladder's own overflow-hidden clipping,
// which read as broken rather than intentional.
function snapToRowHeight(rawHeight: number, ceiling: number, minRows: number): number {
  const rawRows = (rawHeight - LADDER_BASE_HEIGHT_PX) / (2 * ROW_HEIGHT_PX);
  const rows = Math.min(MAX_LADDER_ROWS_PER_SIDE, Math.max(minRows, Math.round(rawRows)));
  const snapped = LADDER_BASE_HEIGHT_PX + rows * 2 * ROW_HEIGHT_PX;
  // Re-clamped against the ceiling: rounding UP to the nearest row could
  // land past it (e.g. `ceiling` sits mid-row for the depth curve's own
  // floor to hold exactly).
  return Math.min(snapped, ceiling);
}

interface OrderBookDepthSplitProps {
  snapshot: SnapshotRecord | null;
  bucketedSnapshot: SnapshotRecord | CoarseSnapshotRecord | null;
  // True once the connection has been healthy for an unreasonable amount
  // of time with no snapshot at all (see useRelayConnection's own comment
  // on SNAPSHOT_TIMEOUT_MS) -- lets the two "waiting" states below say
  // something more useful than an indefinite ellipsis once that's been
  // true long enough to actually mean something.
  snapshotTimedOut: boolean;
  instrument: InstrumentConfig;
  bucketSize: number;
  onBucketSizeChange: (size: number) => void;
  hoveredPrice: number | null;
  onHoverPrice: (price: number | null) => void;
  lastTrade: TimedTrade | null;
  lastTradeDirection: "up" | "down";
}

// A manually resizable vertical split between the order book ladder and the
// depth curve below it.
//
// Two things had to be true for dragging to actually work, and the first
// version of this component only had the second one:
//
// 1. The ladder's own "natural" content height (up to MAX_LEVELS_PER_SIDE
//    rows per side — see OrderBookLadder) is capped by `maxLadderHeight`
//    (tracked live via ResizeObserver against this component's own measured
//    height) applied as a real CSS `max-height`, in BOTH the default
//    (un-dragged) and dragged states — without this, at 20 rows/side plus
//    the header and spread row, the ladder's full content easily runs past
//    800px, silently overflowing whatever ancestor was clipping it before
//    the user ever touched the divider.
// 2. Dragging computes the ladder's new height directly from the cursor's
//    CURRENT position relative to this container's own top edge (see
//    onDividerPointerMove below) — not from a delta added to a
//    separately-measured "starting height" snapshot. A delta-based drag has
//    a real failure mode: if that starting snapshot is stale or reflects a
//    size larger than what's actually visible for any reason, the very
//    first pointer-move can snap straight to the clamp instead of tracking
//    the cursor, or fail to visibly move anything at all. Position-based
//    dragging has no such intermediate state to get wrong — every move
//    event is a fresh, independent computation from the container's own
//    rect (which the ResizeObserver above already keeps current) and the
//    pointer's live position.
export function OrderBookDepthSplit({
  snapshot,
  bucketedSnapshot,
  snapshotTimedOut,
  instrument,
  bucketSize,
  onBucketSizeChange,
  hoveredPrice,
  onHoverPrice,
  lastTrade,
  lastTradeDirection,
}: OrderBookDepthSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Starts at DEFAULT_LADDER_ROWS_PER_SIDE (17 rows/side) rather than null
  // (natural/uncapped height) — see that constant's own comment. Still just
  // the STARTING value of the same state a drag sets: maxLadderHeight below
  // still clamps it exactly as before, and double-click-to-reset still
  // sets this back to null (true natural sizing), unchanged.
  const [ladderHeight, setLadderHeight] = useState<number | null>(() =>
    minLadderHeightFor(DEFAULT_LADDER_ROWS_PER_SIDE),
  );
  // Live container height AND width, kept in sync by the ResizeObserver
  // below — height drives maxLadderHeight (so the cap stays correct across
  // window resizes and panel-layout changes, not just at the moment a drag
  // starts); width drives the mobile row-floor drop (MOBILE_WIDTH_PX).
  const [containerHeight, setContainerHeight] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  // true only between a pointerdown on the divider and its matching
  // pointerup/pointercancel.
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerHeight(entry.contentRect.height);
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const minLadderRows =
    containerWidth != null && containerWidth < MOBILE_WIDTH_PX ? MOBILE_MIN_LADDER_ROWS_PER_SIDE : MIN_LADDER_ROWS_PER_SIDE;
  const minLadderHeight = minLadderHeightFor(minLadderRows);

  // Never below minLadderHeight (the ladder's own floor, narrower on a
  // mobile-width container) and never so tall that the depth curve below
  // it would have to shrink under DEPTH_CURVE_MIN_HEIGHT. Undefined (no
  // cap) only until the very first ResizeObserver callback has landed.
  const maxLadderHeight =
    containerHeight != null
      ? Math.max(minLadderHeight, containerHeight - DEPTH_CURVE_MIN_HEIGHT - DIVIDER_HEIGHT)
      : undefined;

  // Absolute-position dragging, not delta tracking: the ladder's new height
  // is computed directly from where the cursor currently sits relative to
  // the split container's own top edge, clamped — NOT from "how far the
  // cursor has moved since pointerdown" added to a separately-measured
  // "starting height." The delta approach had a real failure mode: it read
  // the ladder's OWN rect at drag-start as the starting point, and if that
  // rect was for any reason stale or larger than what was actually visible
  // (clipped by an ancestor), the very first pointermove could snap or fail
  // to visibly move anything. Cursor-position-relative-to-container has no
  // such intermediate state to get wrong — it's a pure function of the
  // container's rect (already tracked live by the ResizeObserver above) and
  // the pointer's current position, recomputed fresh on every move.
  function onDividerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
  }

  function onDividerPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!isDraggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const cursorOffset = e.clientY - containerTop;
    const cap = maxLadderHeight ?? cursorOffset;
    setLadderHeight(snapToRowHeight(cursorOffset, cap, minLadderRows));
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    isDraggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* height: explicit once the user has dragged; otherwise auto (sizes
          to real content, up to maxHeight). maxHeight applies in BOTH
          cases — see this component's own top comment for why the cap has
          to be unconditional, not just something the drag clamp enforces.
          overflow-hidden is what turns "content taller than the box" into
          a clean cutoff instead of an overflow/squash. */}
      <div
        className="flex-none overflow-hidden border-b border-border"
        style={{ height: ladderHeight ?? undefined, maxHeight: maxLadderHeight }}
      >
        <OrderBookLadder
          snapshot={snapshot}
          bucketedSnapshot={bucketedSnapshot}
          snapshotTimedOut={snapshotTimedOut}
          instrument={instrument}
          bucketSize={bucketSize}
          onBucketSizeChange={onBucketSizeChange}
          hoveredPrice={hoveredPrice}
          onHoverPrice={onHoverPrice}
          lastTrade={lastTrade}
          lastTradeDirection={lastTradeDirection}
        />
      </div>

      <div
        className="group flex flex-none cursor-row-resize touch-none select-none items-center justify-center border-b border-border bg-panel hover:bg-accent"
        style={{ height: DIVIDER_HEIGHT }}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Escape hatch back to natural (content-sized, capped by
        // maxLadderHeight) sizing — once ladderHeight is set by a drag,
        // nothing else in this component ever sets it back to null, so a
        // drag to an unwanted height had no way back except reloading the
        // page. Also what recovers a ladderHeight value carried over from
        // an earlier version of this component across a dev-mode hot
        // reload (React/Fast Refresh preserves state across an edit here,
        // the STORED pixel number does not get invalidated just because
        // the surrounding logic changed).
        onDoubleClick={() => setLadderHeight(null)}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize order book / depth curve split"
        title="Drag to resize — double-click to reset"
      >
        <div className="h-0.5 w-8 rounded-full bg-border group-hover:bg-muted-foreground" />
      </div>

      {/* flex-1 + min-h-0: whatever height the ladder above didn't use
          flows straight here. DepthCurve's own inner wrapper applies
          `minHeight` as a hard CSS floor (see that component) — the same
          constant maxLadderHeight is computed against above, kept in sync
          so a resize this split didn't cause (the browser window itself
          shrinking, say) still can't squash the chart below a readable
          size, via the ResizeObserver re-deriving maxLadderHeight rather
          than a one-time drag-start snapshot.

          `minHeight` below is the fixed DEPTH_CURVE_MIN_HEIGHT constant —
          deliberately NOT `ladderHeight`, NOT `maxLadderHeight`, and
          nothing else derived from this component's own drag state. See
          the matching invariant comment on DepthCurve's own `curve` memo:
          its size-imbalance badge must report the same "who's heavier"
          answer for a given live order book regardless of how the two
          panels are currently split, and the only way to guarantee that is
          for this call site to never hand it anything resize-derived. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <DepthCurve
          snapshot={bucketedSnapshot}
          primarySnapshot={snapshot}
          snapshotTimedOut={snapshotTimedOut}
          hoveredPrice={hoveredPrice}
          onHoverPrice={onHoverPrice}
          priceDecimals={instrument.priceDecimals}
          qtyDecimals={instrument.qtyDecimals}
          bucketSize={bucketSize}
          minHeight={DEPTH_CURVE_MIN_HEIGHT}
        />
      </div>
    </div>
  );
}
