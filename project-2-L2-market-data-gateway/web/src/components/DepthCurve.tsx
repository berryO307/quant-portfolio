"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { computeDepthLevelsBucketed, PRICE_BUCKET_OPTIONS } from "@/lib/orderBook";
import { toPrice, toQty, type SnapshotRecord } from "@/lib/types";
import { buildAxisStyle, useChartTheme, withAlpha } from "@/lib/chartTheme";
import { LegendSwatch } from "./LegendSwatch";
import { PriceBucketSelect } from "./PriceBucketSelect";

const TICK_FONT = "10px JetBrains Mono, monospace"; // numbers: mono
const LABEL_FONT = "10px Inter, sans-serif"; // axis captions: sans

interface DepthCurveProps {
  snapshot: SnapshotRecord | null;
  hoveredPrice: number | null; // raw scaled price (PRICE_SCALE) — see lib/types.ts's toPrice()
  onHoverPrice: (price: number | null) => void;
  minHeight?: number;
  // Display precision for the active instrument (lib/instruments.ts) —
  // BTC/XRP/WTI span a wide enough price-magnitude range that a single
  // hardcoded decimal count would look wrong for most of them.
  priceDecimals?: number;
  qtyDecimals?: number;
}

// Fixes the gap at the spread by not leaving one at all instead of
// shading/labeling it: both series get one shared bridging point exactly at
// the bid/ask midpoint (a flat continuation of each side's own last real
// value, not a new data point pretending to be a real level), so the
// stepped fills meet edge-to-edge with no blank canvas between them. The
// two best prices are still genuinely different underneath (a real order
// book never has bid == ask) — only the rendered boundary, and the
// permanent "spot price" marker line, sit at their midpoint.
//
// bucketSize groups raw levels into price buckets before plotting (see
// lib/orderBook.ts's computeDepthLevelsBucketed) — this naturally controls
// how many points get plotted (coarser buckets -> fewer, wider steps), so
// there's no separate level-count limit needed on top of it.
function buildAlignedData(
  snapshot: SnapshotRecord,
  bucketSize: number
): {
  data: uPlot.AlignedData;
  rawXs: number[];
  // Index of the bridge point within data[0]/rawXs, or null if there's no
  // bridge (one side empty). The spot-price marker reads its position from
  // data[0][bridgeIdx] directly (see positionSpotLine) rather than from a
  // separately-computed price value — this index IS where that price lives
  // in the exact array uPlot is rendering, so the two can't drift apart.
  bridgeIdx: number | null;
} {
  const full = computeDepthLevelsBucketed(snapshot, bucketSize);
  const bids = full.bids;
  const asks = full.asks;
  const bidsAscending = [...bids].reverse(); // ascending price, cumulative descends toward the spread
  const asksAscending = asks; // already ascending price, cumulative rises away from the spread

  const rawBidPrices = bidsAscending.map((l) => l.price);
  const rawAskPrices = asksAscending.map((l) => l.price);
  const bidTotals = bidsAscending.map((l) => toQty(l.total));
  const askTotals = asksAscending.map((l) => toQty(l.total));
  const bidXs = rawBidPrices.map(toPrice);
  const askXs = rawAskPrices.map(toPrice);

  const bestBidRaw = bids[0]?.price ?? null;
  const bestAskRaw = asks[0]?.price ?? null;
  const hasBridge = bestBidRaw != null && bestAskRaw != null;
  // ONE shared x value at the midpoint, not one appended to each side
  // independently — two series both claiming the identical x would give
  // uPlot a duplicate/non-monotonic point, which is undefined behavior for
  // an aligned series. Both series get a real (non-null) y exactly at this
  // shared index instead: bid's own last value (flat continuation) and
  // ask's own first value (flat continuation) — the two meet at one point,
  // not two overlapping ones.
  const midPriceRaw = hasBridge ? Math.round((bestBidRaw! + bestAskRaw!) / 2) : null;
  const midPrice = midPriceRaw != null ? toPrice(midPriceRaw) : null;

  const xs = [...bidXs, ...(midPrice != null ? [midPrice] : []), ...askXs];
  const rawXs = [...rawBidPrices, ...(midPriceRaw != null ? [midPriceRaw] : []), ...rawAskPrices];

  const bidYs: (number | null)[] = [
    ...bidTotals,
    ...(midPrice != null ? [bidTotals[bidTotals.length - 1]!] : []),
    ...askXs.map(() => null),
  ];
  const askYs: (number | null)[] = [
    ...bidXs.map(() => null),
    ...(midPrice != null ? [askTotals[0]!] : []),
    ...askTotals,
  ];

  const bridgeIdx = midPrice != null ? bidXs.length : null;

  return { data: [xs, bidYs, askYs], rawXs, bridgeIdx };
}

// Motion between snapshots, not shape — the stepped rendering stays exactly
// as-is (see the y-axis comment below for why a curved/smoothed shape would
// misrepresent discrete order-book levels the same way log-scaling would
// have). What "smooth" means here is a snapshot update growing/shrinking
// each bar over ~200ms instead of snapping, matched PER PRICE LEVEL rather
// than per array index — a snapshot's xs array shifts as the best price
// moves, so index 0 in the old frame and index 0 in the new frame are
// rarely the same price; tweening by index would animate between two
// unrelated levels. Looked up by exact price match instead: a level whose
// price exists in both frames smoothly interpolates between its two real
// sizes, a level that's newly appeared (or in the old frame, disappeared)
// just appears/vanishes immediately — there's no honest "from" value to
// animate a level that didn't exist a moment ago.
const TWEEN_MS = 200;

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

function lookupFromValues(
  oldXs: readonly number[],
  oldYs: readonly (number | null)[],
  newXs: readonly number[],
  newYs: readonly (number | null)[]
): (number | null)[] {
  const byPrice = new Map<number, number>();
  for (let i = 0; i < oldXs.length; i++) {
    const y = oldYs[i];
    if (y != null) byPrice.set(oldXs[i]!, y);
  }
  return newYs.map((toV, i) => {
    if (toV == null) return null;
    const fromV = byPrice.get(newXs[i]!);
    return fromV != null ? fromV : toV; // no match -> appears at its final value, not animated
  });
}

export function DepthCurve({
  snapshot,
  hoveredPrice,
  onHoverPrice,
  minHeight = 200,
  priceDecimals = 2,
  qtyDecimals = 3,
}: DepthCurveProps) {
  const chartTheme = useChartTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const rawXsRef = useRef<number[]>([]);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const spotLineRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const bridgeIdxRef = useRef<number | null>(null);
  // In-flight tween's requestAnimationFrame handle, so a new snapshot
  // arriving mid-tween can cancel and retarget from whatever's currently
  // on screen instead of the two tweens fighting over plot.setData().
  const tweenRafRef = useRef<number | null>(null);
  const onHoverPriceRef = useRef(onHoverPrice);
  // True while the mouse is actively over THIS chart — set synchronously by
  // the setCursor hook below, read by the ladder-hover-sync effect further
  // down. Without this, hovering the chart itself drove BOTH uPlot's own
  // native crosshair AND the manual ladder-sync overlay line at once (the
  // same hoveredPrice value feeds both), which showed as two
  // barely-misaligned vertical lines — reported via screenshot. The manual
  // overlay is for the OPPOSITE direction (a hover that originated on the
  // ladder) and should stay out of the way whenever the chart's own
  // crosshair already has it covered.
  const isSelfHoverRef = useRef(false);
  // Finest option by default, matching OrderBookLadder's own default — see
  // PriceBucketSelect's comment. Always renders the live snapshot directly
  // now (the earlier Tick/1s throttle toggle is gone — the tween already
  // smooths every update regardless of how often they arrive, so a
  // separate client-side throttle wasn't adding anything the tween didn't
  // already provide, just one more control to explain).
  const [bucketSize, setBucketSize] = useState<number>(PRICE_BUCKET_OPTIONS[0]);

  useEffect(() => {
    onHoverPriceRef.current = onHoverPrice;
  }, [onHoverPrice]);

  // Shared by the resize observer and the snapshot-update effect below —
  // repositions the permanent spot-price marker.
  //
  // Reads the marker's x-VALUE from plot.data[0][bridgeIdxRef.current] —
  // uPlot's OWN current data array — rather than from a separately-tracked
  // price ref. Previously this read a `midPrice` value computed once in
  // buildAlignedData and stashed in a ref alongside (but independent of)
  // the call to plot.setData(data) — two copies of "the same" value that
  // only stayed in sync by both being set together in the same effect.
  // Reported via screenshot: the marker sometimes rendered many real price
  // levels deep into the bid or ask side instead of at the true best-bid/
  // best-ask boundary — every captured/replayed snapshot checked was
  // internally well-formed (sorted, never crossed, correct midpoint), which
  // pointed at the rendering side, not the data. Indexing into plot.data
  // directly makes the marker's position and the plot's own rendered data
  // the same read, closing off that whole class of two-copies-drifting-
  // apart bug regardless of the exact trigger.
  function positionSpotLine() {
    const plot = plotRef.current;
    const line = spotLineRef.current;
    const idx = bridgeIdxRef.current;
    if (!plot || !line) return;
    const mid = idx != null ? (plot.data[0]?.[idx] as number | undefined) : undefined;
    if (mid == null) {
      line.style.display = "none";
      return;
    }
    const px = plot.valToPos(mid, "x");
    if (px == null || Number.isNaN(px)) {
      line.style.display = "none";
      return;
    }
    line.style.display = "block";
    line.style.left = `${px}px`;
  }

  // Mount once: create the uPlot instance with empty data. Series count,
  // colors, and the cursor hook are all fixed for this component's
  // lifetime — only the data changes, handled by the effect below.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(el.clientHeight || 0, minHeight),
      series: [
        {},
        {
          label: "bids",
          stroke: chartTheme.bid,
          fill: withAlpha(chartTheme.bid, 0.2),
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: true, size: 5, fill: chartTheme.bid, stroke: chartTheme.bid },
        },
        {
          label: "asks",
          stroke: chartTheme.ask,
          fill: withAlpha(chartTheme.ask, 0.2),
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: true, size: 5, fill: chartTheme.ask, stroke: chartTheme.ask },
        },
      ],
      // LINEAR y-axis, deliberately — a log-scale attempt here (this
      // component's previous version) was wrong, not just a style choice:
      // cumulative size is the actual physical quantity a depth chart
      // exists to compare honestly (how much bigger is this wall than that
      // one?), unlike a latency chart's time axis, which is naturally
      // multi-order-of-magnitude and has no "true proportion" to preserve.
      // Log-scaling it makes a 10x-larger wall look barely bigger — it
      // LIES about resting size, the one thing this chart is for. The
      // fix for "too few points, big jarring steps" is getting more real
      // levels from the export pipeline instead (see PHASES.md/BUGS.md) —
      // not distorting the axis to paper over having only ~10.
      scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, max] } },
      axes: [
        {
          ...buildAxisStyle(chartTheme),
          label: "price",
          font: TICK_FONT,
          labelFont: LABEL_FONT,
          values: (_u, ticks) => ticks.map((t) => t.toFixed(priceDecimals)),
        },
        { ...buildAxisStyle(chartTheme), label: "cumulative size", font: TICK_FONT, labelFont: LABEL_FONT },
      ],
      legend: { show: false },
      // A real crosshair (both axes) plus a floating tooltip — uPlot
      // supports this natively.
      cursor: { x: true, y: true, drag: { x: false, y: false } },
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const tooltip = tooltipRef.current;
            isSelfHoverRef.current = idx != null;

            if (idx == null) {
              onHoverPriceRef.current(null);
              if (tooltip) tooltip.style.display = "none";
              return;
            }
            onHoverPriceRef.current(rawXsRef.current[idx] ?? null);
            if (!tooltip) return;

            const price = u.data[0]?.[idx];
            const bidVal = u.data[1]?.[idx];
            const askVal = u.data[2]?.[idx];
            const size = bidVal ?? askVal;
            if (price == null || size == null) {
              tooltip.style.display = "none";
              return;
            }

            tooltip.textContent = `${price.toFixed(priceDecimals)} · ${size.toFixed(qtyDecimals)}`;
            tooltip.style.display = "block";

            // Boundary-aware placement (bug reported via screenshot: near
            // the right/bottom edge, an always-"+12px from cursor" tooltip
            // ran past the chart and visibly wrapped/clipped). Flip to the
            // opposite side of the cursor whenever the default placement
            // would overflow the plotting area.
            const cursorLeft = u.cursor.left ?? 0;
            const cursorTop = u.cursor.top ?? 0;
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            const maxLeft = el.clientWidth;
            const maxTop = el.clientHeight;

            let left = cursorLeft + 12;
            if (left + tw > maxLeft) left = cursorLeft - tw - 12;
            left = Math.max(2, Math.min(left, maxLeft - tw - 2));

            let top = cursorTop + 12;
            if (top + th > maxTop) top = cursorTop - th - 12;
            top = Math.max(2, Math.min(top, maxTop - th - 2));

            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
          },
        ],
      },
    };

    const plot = new uPlot(opts, [[], [], []], el);
    plotRef.current = plot;

    // These three overlays are created here, imperatively, and appended
    // directly onto uPlot's own .u-over element — NOT rendered as React JSX
    // children of the outer container. .u-over is the interactive layer
    // uPlot sizes and positions to exactly the plotting rectangle, excluding
    // the axis-label gutters — valToPos() pixel offsets are measured from
    // ITS origin, so a `left` CSS value only lands correctly when the
    // element is actually inside it. Keeping them fully outside React's
    // render tree also avoids any chance of React's reconciliation touching
    // or repositioning them across this component's re-renders.
    const overlay = document.createElement("div");
    overlay.className = "pointer-events-none absolute top-2 bottom-2 w-px bg-foreground";
    overlay.style.display = "none";

    // Permanent (not hover-dependent) marker at the current spot price —
    // the same bid/ask midpoint the gap-closing bridge point above sits at.
    const spotLine = document.createElement("div");
    spotLine.className = "pointer-events-none absolute top-2 bottom-2 border-l border-dashed border-foreground/70";
    spotLine.style.display = "none";

    const tooltip = document.createElement("div");
    tooltip.className =
      "pointer-events-none absolute z-10 rounded-sm border border-border bg-card px-1.5 py-1 font-mono text-[10px] tabular-nums text-foreground";
    tooltip.style.display = "none";

    plot.over.appendChild(spotLine);
    plot.over.appendChild(overlay);
    plot.over.appendChild(tooltip);

    overlayRef.current = overlay;
    spotLineRef.current = spotLine;
    tooltipRef.current = tooltip;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 400, height: Math.max(el.clientHeight || 0, minHeight) });
      positionSpotLine();
    });
    resize.observe(el);

    return () => {
      resize.disconnect();
      plot.destroy(); // also removes .u-over and everything appended to it above
      plotRef.current = null;
      overlayRef.current = null;
      spotLineRef.current = null;
      tooltipRef.current = null;
    };
     
    // priceDecimals/qtyDecimals are read inside opts (axis tick labels,
    // tooltip text) — including them here means switching the active
    // instrument tears down and rebuilds the plot with correct precision,
    // rather than keeping the previous instrument's decimal counts baked
    // into a closure until some other prop happens to change. chartTheme
    // for the same reason: colors are baked into series/axes at
    // construction, not CSS the browser repaints on its own, so a light/
    // dark toggle needs this to actually rebuild with the new palette.
  }, [minHeight, priceDecimals, qtyDecimals, chartTheme]);

  // New snapshot, OR a price-bucket change -> update the existing
  // instance's data in place, tweening the cumulative-size bars from
  // whatever's currently on screen to the new values instead of snapping
  // (see TWEEN_MS/lookupFromValues above), and reposition the permanent
  // spot-price line each frame since the marker's own pixel position
  // depends on the plot's current data.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !snapshot) return;

    const { data, rawXs, bridgeIdx } = buildAlignedData(snapshot, bucketSize);
    rawXsRef.current = rawXs;
    bridgeIdxRef.current = bridgeIdx;

    // A snapshot arriving before the previous tween finished cancels it —
    // the new tween starts from whatever's actually on screen right now
    // (read below via plot.data), not from the last fully-settled frame,
    // so back-to-back updates never stutter or visibly reset.
    if (tweenRafRef.current != null) {
      cancelAnimationFrame(tweenRafRef.current);
      tweenRafRef.current = null;
    }

    const [newXs, newBidYs, newAskYs] = data as [number[], (number | null)[], (number | null)[]];
    const curXs = (plot.data[0] as number[] | undefined) ?? [];
    const curBidYs = (plot.data[1] as (number | null)[] | undefined) ?? [];
    const curAskYs = (plot.data[2] as (number | null)[] | undefined) ?? [];

    // Nothing to animate from (first-ever data for this chart) -> set the
    // final values directly, no tween.
    if (curXs.length === 0) {
      plot.setData(data);
      positionSpotLine();
      return;
    }

    const fromBidYs = lookupFromValues(curXs, curBidYs, newXs, newBidYs);
    const fromAskYs = lookupFromValues(curXs, curAskYs, newXs, newAskYs);

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const eased = easeOutQuad(t);
      const bidYs = newBidYs.map((toV, i) => {
        const fromV = fromBidYs[i];
        return toV == null || fromV == null ? toV : fromV + (toV - fromV) * eased;
      });
      const askYs = newAskYs.map((toV, i) => {
        const fromV = fromAskYs[i];
        return toV == null || fromV == null ? toV : fromV + (toV - fromV) * eased;
      });
      plot.setData([newXs, bidYs, askYs]);
      positionSpotLine();

      if (t < 1) {
        tweenRafRef.current = requestAnimationFrame(tick);
      } else {
        tweenRafRef.current = null;
        plot.setData(data); // snap to the exact final values, no float drift
        positionSpotLine();
      }
    };
    tweenRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (tweenRafRef.current != null) {
        cancelAnimationFrame(tweenRafRef.current);
        tweenRafRef.current = null;
      }
    };
  }, [snapshot, bucketSize]);

  // Ladder -> curve hover: draw a plain overlay line, never touching
  // uPlot's own cursor state (its own crosshair is driven by the mouse
  // directly; this is the reverse direction — a hover that originated on
  // the ladder, not on this chart). Skipped entirely while the chart's own
  // crosshair is already active (see isSelfHoverRef's comment above) —
  // showing both was the two-misaligned-lines bug.
  useEffect(() => {
    const plot = plotRef.current;
    const overlay = overlayRef.current;
    if (!plot || !overlay) return;

    if (hoveredPrice == null || isSelfHoverRef.current) {
      overlay.style.display = "none";
      return;
    }
    const px = plot.valToPos(toPrice(hoveredPrice), "x");
    if (px == null || Number.isNaN(px)) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";
    overlay.style.left = `${px}px`;
  }, [hoveredPrice]);

  const hasData = !!snapshot && (snapshot.bids.length > 0 || snapshot.asks.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 rounded-lg border border-border bg-panel p-2 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-foreground" title="Cumulative bid/ask size at each price level, live.">
          Depth curve
        </div>
        <div className="flex items-center gap-3">
          <PriceBucketSelect value={bucketSize} onChange={setBucketSize} />
          <LegendSwatch color={chartTheme.bid} label="Bids" />
          <LegendSwatch color={chartTheme.ask} label="Asks" />
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1"
        style={{ minHeight }}
        onMouseLeave={() => onHoverPrice(null)}
      >
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
            Waiting for order book snapshot…
          </div>
        )}
        {/* The spot-price line, ladder-hover line, and cursor tooltip are
            NOT rendered here — see the mount effect above for why they're
            created imperatively and appended onto uPlot's own .u-over
            element instead. */}
      </div>
    </div>
  );
}

