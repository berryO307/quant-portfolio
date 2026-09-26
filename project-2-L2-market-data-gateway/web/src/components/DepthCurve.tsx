"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeDepthLevelsBucketed } from "@/lib/orderBook";
import { toPrice, toQty, type CoarseSnapshotRecord, type SnapshotRecord } from "@/lib/types";
import {
  buildAxisStyle,
  buildChartBase,
  buildCrosshairPointer,
  buildTooltipPosition,
  buildTooltipStyle,
  tooltipSwatch,
  useChartTheme,
  withAlpha,
} from "@/lib/chartTheme";
import { PRICE_AXIS_TICKS, derivePriceDecimals, priceAxisBounds } from "@/lib/priceAxis";
import { useECharts, type EChartsOption } from "@/lib/useECharts";
import { LegendSwatch } from "./LegendSwatch";

interface DepthCurveProps {
  // See OrderBookLadder's bucketedSnapshot prop -- Dashboard.tsx passes
  // the same possibly-coarse value here. Drives the plotted curve SHAPE
  // (cumulative bid/ask arrays) — never the true best bid/ask (see
  // primarySnapshot below for why those are a different question).
  snapshot: SnapshotRecord | CoarseSnapshotRecord | null;
  // The live pipeline's own snapshot — always the finest rounding,
  // regardless of which bucket size is selected for display. Mirrors
  // OrderBookLadder's own two-prop split (its `snapshot` vs
  // `bucketedSnapshot`) for the identical reason: the true best bid/ask
  // (and therefore the market's real midpoint) is a property of the REAL
  // market, not of whatever bucket size happens to be selected. Using the
  // BUCKETED snapshot's own bids[0]/asks[0] for this — the bug this prop
  // fixes — silently substitutes each side's floored/ceiled BUCKET
  // BOUNDARY for its true best price, which drifts further from reality
  // the coarser the bucket gets: at a $10 bucket, a true best bid of
  // 81118 reports as bucket 81110, and a true best ask of 81119 reports as
  // bucket 81120, moving the computed midpoint (and the dashed center
  // line drawn at it) up to $10+ away from where the book is actually
  // crossing. Required, not optional — an omitted value would silently
  // reintroduce exactly that bug with no signal anything was wrong.
  primarySnapshot: SnapshotRecord | null;
  hoveredPrice: number | null; // raw scaled price (PRICE_SCALE) — see lib/types.ts's toPrice()
  onHoverPrice: (price: number | null) => void;
  minHeight?: number;
  // Display precision for the active instrument (lib/instruments.ts) —
  // BTC/WTI span a wide enough price-magnitude range that a single
  // hardcoded decimal count would look wrong for both of them.
  priceDecimals?: number;
  qtyDecimals?: number;
  // Owned by Dashboard, driven by OrderBookLadder's own selector — this
  // component has no bucket control of its own (the two used to have
  // independent selectors, which could show a different bucket size on each
  // half of what's supposed to be one book).
  bucketSize: number;
}

// Height reserved for the x-axis strip (ticks + "Price" caption). Shared
// with the tooltip's position clamp so the readout can never cover it.
const GRID_BOTTOM = 34;
// Matches the `grid.left` pixel inset in the option below — duplicated
// here (not read back from ECharts) because the size-imbalance badge is a
// plain HTML overlay positioned by the SAME arithmetic the chart itself
// uses to place its grid, computed directly from the container's own
// measured width rather than through ECharts' internal layout (see
// badgeLeftPx below for why).
const GRID_LEFT = 52;
// Full right margin (room for the ask axis's own tick labels) — used when
// the container is wide enough to show both y-axes. See COMPACT_WIDTH_PX
// and gridRight below for the narrow-container case.
const GRID_RIGHT_FULL = 52;
// Right margin once the ask y-axis is hidden (see COMPACT_WIDTH_PX) — just
// enough to keep the curve's own edge clear of the panel border.
const GRID_RIGHT_COMPACT = 12;
// Top inset for the plot area.
const GRID_TOP = 10;

// Below this container width, the chart switches to a compact layout: the
// right (ask) y-axis is hidden and the price-axis tick count is reduced.
// Reported live: in a narrow panel (VSCode's side-by-side/Simple Browser
// view, a phone-width browser, or this app's own left column at a small
// window size) the dual y-axis was reserving ~104px of fixed margin
// (GRID_RIGHT_FULL + GRID_LEFT) — on a ~300px-wide panel that's over a
// third of the whole chart gone to axis labels before a single price tick
// gets room, and ECharts' own axisLabel.hideOverlap then dropped EVERY
// x-axis label rather than some of them, since none of them fit — which is
// what actually made the price axis unreadable, not a resize/redraw bug
// (the ResizeObserver in useECharts already keeps the chart itself correct
// at any size). Below the threshold, only the left (bid) axis is shown —
// both axes plot the identical [0, yMax] range (see yAxis below), so
// nothing about the CURVE's shape or the reference lines' meaning changes,
// only which side carries the redundant second copy of the same scale.
const COMPACT_WIDTH_PX = 380;
// Fewer ticks need to fit in a narrower price axis — 3 instead of the
// default 6 (see lib/priceAxis.ts's PRICE_AXIS_TICKS) leaves enough gap
// between labels that hideOverlap doesn't have to drop any of them.
const COMPACT_PRICE_AXIS_TICKS = 3;

interface CurveData {
  bid: [number, number][]; // [displayPrice, cumulativeSize], ascending price
  ask: [number, number][];
  displayXs: number[]; // every plotted x, ascending — for nearest-point hover lookup
  rawXs: number[]; // the PRICE_SCALE-scaled counterpart of displayXs
  midPrice: number | null; // display-space bid/ask midpoint, where the marker sits
  // Total resting size across every visibly-plotted level on each side —
  // the cumulative value at the FARTHEST point from the spread (where each
  // side's own cumulative total peaks), not at the bridging midpoint. Used
  // for the center dashed line's size-imbalance annotation and to pick a
  // shared y-axis max for both sides (see below) — not just whatever
  // qty happens to be largest across both arrays, since the bridging point
  // duplicates a real value rather than adding a new one.
  bidTotal: number;
  askTotal: number;
}

// Both sides get one shared bridging point at the bid/ask midpoint — a flat
// continuation of each side's own nearest real value, not a data point
// pretending to be a real level — so the two stepped fills meet edge to edge
// with no blank canvas between them. The two best prices are still genuinely
// different underneath (a real order book never has bid == ask); only the
// rendered boundary and the spot-price marker sit at their midpoint.
//
// bucketSize groups raw levels into price buckets before plotting (see
// lib/orderBook.ts) — that alone controls how many points get plotted
// (coarser buckets -> fewer, wider steps), so there's no separate
// level-count limit on top of it.
function buildCurveData(
  snapshot: SnapshotRecord | CoarseSnapshotRecord,
  primarySnapshot: SnapshotRecord | null,
  bucketSize: number
): CurveData {
  const { bids, asks } = computeDepthLevelsBucketed(snapshot, bucketSize);

  // bids arrive best-first (highest price, smallest cumulative). Reversed to
  // ascending price, the cumulative therefore DESCENDS toward the spread.
  const bidsAscending = [...bids].reverse();
  const asksAscending = asks; // already ascending price, cumulative rises away from the spread

  // The TRUE best bid/ask, from the unbucketed primary snapshot — NOT
  // bids[0]/asks[0] above, which are each side's floored/ceiled BUCKET
  // boundary once bucketSize > 1. See primarySnapshot's own prop comment
  // for the bug this fixes: at a coarse bucket, the bucket-boundary
  // midpoint can land far from where the book is actually crossing. Falls
  // back to the bucketed values only if primarySnapshot hasn't arrived yet
  // (e.g. the very first render) — same "something beats nothing" reasoning
  // as OrderBookLadder's own spread computation.
  const bestBidRaw = primarySnapshot?.bids[0]?.[0] ?? bids[0]?.price ?? null;
  const bestAskRaw = primarySnapshot?.asks[0]?.[0] ?? asks[0]?.price ?? null;
  const hasBridge = bestBidRaw != null && bestAskRaw != null;
  const midRaw = hasBridge ? Math.round((bestBidRaw + bestAskRaw) / 2) : null;
  const midPrice = midRaw != null ? toPrice(midRaw) : null;

  const bid: [number, number][] = bidsAscending.map((l) => [toPrice(l.price), toQty(l.total)]);
  const ask: [number, number][] = asksAscending.map((l) => [toPrice(l.price), toQty(l.total)]);

  // Cumulative DESCENDS toward the spread on the bid side (see the comment
  // above), so the side's full total sits at index 0 (farthest, lowest
  // price); it RISES away from the spread on the ask side, so the full
  // total sits at the last index (farthest, highest price). Read before the
  // bridging point below is appended, which would otherwise duplicate
  // whichever end value it's spliced next to.
  const bidTotal = toQty(bidsAscending[0]?.total ?? 0);
  const askTotal = toQty(asksAscending[asksAscending.length - 1]?.total ?? 0);

  // Unlike uPlot's AlignedData (one shared x array across every series, so
  // two series could never both own a point at the same x), ECharts series
  // carry their own [x, y] pairs — so both sides can legitimately hold the
  // midpoint, each at its own value, and the fills meet exactly there.
  if (midPrice != null) {
    const lastBid = bid[bid.length - 1];
    if (lastBid) bid.push([midPrice, lastBid[1]]);
    const firstAsk = ask[0];
    if (firstAsk) ask.unshift([midPrice, firstAsk[1]]);
  }

  const rawBidPrices = bidsAscending.map((l) => l.price);
  const rawAskPrices = asksAscending.map((l) => l.price);

  return {
    bid,
    ask,
    displayXs: [...rawBidPrices.map(toPrice), ...(midPrice != null ? [midPrice] : []), ...rawAskPrices.map(toPrice)],
    rawXs: [...rawBidPrices, ...(midRaw != null ? [midRaw] : []), ...rawAskPrices],
    midPrice,
    bidTotal,
    askTotal,
  };
}

// Vertical fade from the series color down to fully transparent — the
// Bookmap-style look. Declared as ECharts' plain gradient object rather than
// `new echarts.graphic.LinearGradient(...)` so the option stays serialisable
// data with no imperative construction in it.
function verticalFade(color: string) {
  return {
    type: "linear" as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(color, 0.45) },
      { offset: 1, color: withAlpha(color, 0.02) },
    ],
  };
}

function nearestIndex(sortedXs: readonly number[], target: number): number | null {
  if (sortedXs.length === 0) return null;
  let lo = 0;
  let hi = sortedXs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedXs[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index at or past target; whichever neighbour is closer wins.
  const prev = lo > 0 ? lo - 1 : lo;
  return Math.abs(sortedXs[prev]! - target) <= Math.abs(sortedXs[lo]! - target) ? prev : lo;
}

export function DepthCurve({
  snapshot,
  primarySnapshot,
  hoveredPrice,
  onHoverPrice,
  minHeight = 200,
  priceDecimals = 2,
  qtyDecimals = 3,
  bucketSize,
}: DepthCurveProps) {
  const chartTheme = useChartTheme();
  const { containerRef, chartRef, setOption } = useECharts();

  // Computed once per real data change, not re-derived inside the ECharts
  // effect below — both that effect AND the size-imbalance badge's plain
  // HTML render (JSX, at the bottom of this component) need the same
  // curve/derived values, and computing it twice is how the two silently
  // drift apart.
  //
  // INVARIANT, deliberately: this dependency array is
  // [snapshot, primarySnapshot, bucketSize] and MUST STAY that way.
  // bidTotal/askTotal/the size-imbalance badge (sizeDiff, further down) all
  // trace back to this value alone — reading the COMPLETE order book the
  // gateway sent (every real level in the current bucketedSnapshot), never
  // a subset. In particular, this must never depend on this component's
  // own pixel size, containerWidth, or anything else about how much of the
  // ORDER BOOK LADDER happens to be visible — OrderBookDepthSplit's
  // resizable divider (see that component) only ever changes the ladder
  // wrapper's own CSS height/max-height; it does not and must not pass
  // that height (or anything derived from it) down as a prop here. A user
  // shrinking the ladder to show fewer rows, or enlarging this chart, must
  // never change what this badge reports — otherwise the same live order
  // book would silently report a different "who's heavier" answer
  // depending on how someone happened to have the panels split at that
  // exact moment, which is exactly the kind of inconsistency this
  // component exists to avoid.
  const curve = useMemo(
    () => (snapshot ? buildCurveData(snapshot, primarySnapshot, bucketSize) : null),
    [snapshot, primarySnapshot, bucketSize]
  );

  const curveRef = useRef<CurveData | null>(null);
  useEffect(() => {
    curveRef.current = curve;
  }, [curve]);

  // The hover handler is attached once (see the effect below), so it reads
  // the current callback through a ref rather than closing over whichever
  // one existed at mount. Assigned in an effect, not during render.
  const onHoverPriceRef = useRef(onHoverPrice);
  useEffect(() => {
    onHoverPriceRef.current = onHoverPrice;
  }, [onHoverPrice]);
  // True while the pointer is over THIS chart. ECharts' own cross
  // axis-pointer already marks where the cursor is, so the separate marker
  // for an externally-originated hover (one that started on the ladder)
  // stays out of the way rather than drawing a second, near-identical line
  // a pixel away from the first.
  const isSelfHoverRef = useRef(false);

  // Hover wiring, attached once. useECharts' own effect is declared before
  // this one, so the instance already exists by the time this runs.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const onAxisPointer = (raw: unknown) => {
      const params = raw as { axesInfo?: { value?: number | string }[] };
      const value = Number(params.axesInfo?.[0]?.value);
      const curveNow = curveRef.current;
      if (!curveNow || !Number.isFinite(value)) return;
      isSelfHoverRef.current = true;
      const idx = nearestIndex(curveNow.displayXs, value);
      onHoverPriceRef.current(idx == null ? null : curveNow.rawXs[idx] ?? null);
    };

    const onGlobalOut = () => {
      isSelfHoverRef.current = false;
      onHoverPriceRef.current(null);
    };

    chart.on("updateAxisPointer", onAxisPointer);
    chart.on("globalout", onGlobalOut);
    return () => {
      // React runs effect cleanups in the order the effects were declared,
      // and useECharts' effect is declared first — so by the time this runs
      // on unmount, the instance it owns has already been disposed.
      // Detaching handlers from a disposed instance is harmless but ECharts
      // logs "[ECharts] Instance ... has been disposed" for it, which is
      // exactly the kind of console noise that reads as a real fault later.
      if (!chart.isDisposed()) {
        chart.off("updateAxisPointer", onAxisPointer);
        chart.off("globalout", onGlobalOut);
      }
    };
  }, [chartRef]);

  // Both derived from the prices actually on screen, so they stay correct
  // as the bucket size changes the level spacing and as the book drifts.
  const priceBounds = useMemo(() => priceAxisBounds(curve?.displayXs ?? []), [curve]);
  const axisPriceDecimals = derivePriceDecimals(priceBounds.min, priceBounds.max);

  // Size-imbalance readout (repurposed from an unlabeled spread marker —
  // showing bid/ask spread on this chart isn't meaningful across every
  // instrument: BTC's is comparable to this bucket's own rounding, WTI's
  // isn't). Dominant side (whichever has more resting size across
  // everything currently plotted) drives both the label text and its
  // color — green/bid when bids are heavier, red/ask when asks are.
  const sizeDiff = curve ? curve.bidTotal - curve.askTotal : 0;
  const dominantIsBid = sizeDiff >= 0;
  const dominantColor = dominantIsBid ? chartTheme.bid : chartTheme.ask;
  const sizeDiffLabel = curve
    ? `${dominantIsBid ? "BID HEAVY" : "ASK HEAVY"}  ${Math.abs(sizeDiff).toFixed(qtyDecimals)}`
    : "";

  // Container width, live — drives the compact-layout switch (hides the
  // ask y-axis, reduces tick count) in the option-building effect below.
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const gridRight = containerWidth != null && containerWidth < COMPACT_WIDTH_PX ? GRID_RIGHT_COMPACT : GRID_RIGHT_FULL;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => setContainerWidth(el.getBoundingClientRect().width);
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  const isCompact = containerWidth != null && containerWidth < COMPACT_WIDTH_PX;

  // Which side, if any, the user clicked in the legend — the OTHER side is
  // then faded (not hidden entirely: this is "which side are you focused
  // on comparing," not ECharts' own legend-toggle series visibility, which
  // would also rescale the axes and let the size-imbalance badge and the
  // hover tooltip read as if the hidden side had zero depth). Clicking the
  // side that's already focused clears it, same toggle convention as the
  // ladder-resize divider's double-click reset.
  const [focusedSide, setFocusedSide] = useState<"bid" | "ask" | null>(null);
  const FADED_OPACITY = 0.15;
  const bidOpacity = focusedSide === "ask" ? FADED_OPACITY : 1;
  const askOpacity = focusedSide === "bid" ? FADED_OPACITY : 1;

  useEffect(() => {
    const axis = buildAxisStyle(chartTheme);

    // The external-hover marker: only drawn for a hover that originated on
    // the ladder. While the pointer is over this chart, ECharts' own cross
    // pointer is already showing that position.
    const externalHoverX =
      !isSelfHoverRef.current && hoveredPrice != null ? toPrice(hoveredPrice) : null;

    // Shared across both y-axes (see the yAxis config below) so the same
    // cumulative-size value lands at the same height whether it's read off
    // the left (bid) or right (ask) axis — two independently auto-scaled
    // axes would let a visually-taller ask curve mean nothing (different
    // scale), defeating the point of putting a scale on that side at all.
    const yMax = Math.max(curve?.bidTotal ?? 0, curve?.askTotal ?? 0, 1) * 1.05;

    // Plain vertical lines only — no markLine label here. The size-diff
    // badge itself is a plain HTML overlay (see the JSX below and
    // badgeLeftPx above), so these just need to draw the dashed/solid
    // reference lines.
    const markLineData: { xAxis: number; lineStyle: Record<string, unknown> }[] = [];
    if (curve?.midPrice != null) {
      markLineData.push({
        xAxis: curve.midPrice,
        lineStyle: { color: withAlpha(chartTheme.text, 0.75), type: "dashed", width: 1 },
      });
    }
    if (externalHoverX != null) {
      markLineData.push({
        xAxis: externalHoverX,
        lineStyle: { color: withAlpha(chartTheme.text, 0.35), type: "solid", width: 1 },
      });
    }

    const option: EChartsOption = {
      ...buildChartBase(chartTheme),
      // Snapshot-to-snapshot morphing is exactly what ECharts' update
      // animation is for — this replaces the hand-rolled requestAnimationFrame
      // tween (ease function, mid-tween retarget handling, per-price value
      // lookup) the uPlot version needed to get the same effect.
      animationDurationUpdate: 200,
      // `right` is GRID_RIGHT_FULL normally (room for the ask axis's own
      // tick labels) or GRID_RIGHT_COMPACT once that axis is hidden below
      // COMPACT_WIDTH_PX — badgeLeftPx's own effect computes the identical
      // value from the same containerWidth, so the two never disagree.
      grid: { left: GRID_LEFT, right: gridRight, top: GRID_TOP, bottom: GRID_BOTTOM, containLabel: false },
      tooltip: {
        ...buildTooltipStyle(chartTheme),
        trigger: "axis",
        // Shared with both latency charts so the crosshair behaves
        // identically everywhere. The formatters keep the pointer's own
        // label chips in the same units as the axis ticks they slide along
        // — previously these printed unformatted numbers.
        axisPointer: buildCrosshairPointer(chartTheme, {
          x: (v) => v.toFixed(axisPriceDecimals),
          y: (v) => v.toFixed(qtyDecimals),
        }),
        // Pinned above the cursor and clamped clear of the axis strip — the
        // default down-and-right placement put this readout on top of the
        // price tick labels whenever the pointer was low in the plot.
        position: buildTooltipPosition(GRID_BOTTOM + 8),
        formatter: (raw: unknown) => {
          const params = raw as { seriesName?: string; color?: string; data?: [number, number] }[];
          if (!Array.isArray(params) || params.length === 0) return "";
          const price = params[0]?.data?.[0];
          if (price == null) return "";
          // Explicit "Price"/"Bids"/"Asks" labels on their own rows, not a
          // bare number followed by the raw lowercase series id — a plain
          // "82400.00" read as unlabeled at a glance, and "asks" (the
          // series' internal id, used verbatim before) isn't how this app
          // capitalizes it anywhere else (see LegendSwatch's own "Bids"/
          // "Asks" labels above the chart). Tooltip price keeps the
          // instrument's full precision — unlike the axis labels, this is a
          // specific level the user pointed at, so the trailing digits are
          // the information rather than noise.
          const rows = [`Price - <strong>${price.toFixed(priceDecimals)}</strong>`];
          for (const p of params) {
            if (p.data?.[1] == null) continue;
            const label = p.seriesName === "bids" ? "Bids" : p.seriesName === "asks" ? "Asks" : p.seriesName;
            rows.push(
              `${tooltipSwatch(p.color ?? chartTheme.muted)}${label} - <strong>${p.data[1].toFixed(qtyDecimals)} qty</strong>`
            );
          }
          return rows.join("<br/>");
        },
      },
      xAxis: {
        ...axis,
        type: "value",
        // Plain "Price" — "Price Bucket" (tried briefly) read as
        // misleading here: the CURVE's own x-axis is a continuous price
        // scale (every real price the book has data at, edge to edge, not
        // one point per bucket), unlike the order book ladder's rows,
        // which genuinely are one bucket each and keep that label.
        name: "Price",
        nameLocation: "middle",
        nameGap: 20,
        // Hard bounds from the prices actually plotted, not `scale: true`.
        // Auto-scaling rounded outward to nice numbers and left visible dead
        // gutters before the first bid and after the last ask; these bounds
        // put the curve edge to edge. See lib/priceAxis.ts.
        min: priceBounds.min,
        max: priceBounds.max,
        // Fewer ticks in a narrow (compact) container — see
        // COMPACT_PRICE_AXIS_TICKS's own comment for why a narrow panel
        // otherwise lost every price label at once, not just some of them.
        splitNumber: isCompact ? COMPACT_PRICE_AXIS_TICKS : PRICE_AXIS_TICKS,
        axisLabel: {
          ...axis.axisLabel,
          // Precision derived from the rendered range (see priceAxis.ts) —
          // 0 decimals for BTC's $1-tick book, 3 for WTI's sub-cent one.
          formatter: (value: number) => value.toFixed(axisPriceDecimals),
          hideOverlap: true,
          // The bounds are the data extent plus a 2% margin, so the max
          // rarely lands on a round number and ECharts would print it right
          // next to the last regular tick (`77260  77264`). Dropping it
          // keeps the spacing even; the curve reaching the edge already
          // communicates the extent.
          showMaxLabel: false,
          showMinLabel: false,
        },
        splitLine: { show: false },
      },
      // Two y-axes, one per side, sharing the same [0, yMax] range (computed
      // above) so a given cumulative-size value sits at the same height on
      // either axis — reading "how big is this wall" off whichever side of
      // the chart is closer to it, rather than only ever being able to read
      // the bid side directly and the ask side by eye against the left
      // labels. Both LINEAR, deliberately — cumulative size is the physical
      // quantity a depth chart exists to compare honestly ("how much bigger
      // is this wall than that one?"). Log-scaling it would make a
      // 10x-larger wall look barely bigger, which misrepresents resting
      // size, the one thing this chart is for.
      //
      // Label precision uses the active instrument's own qtyDecimals (a
      // DepthCurve prop, not a per-axis guess) — the same reasoning
      // lib/instruments.ts's own comment gives for priceDecimals/
      // qtyDecimals existing per instrument at all: BTC and WTI's resting
      // sizes sit at different natural magnitudes, so a single hardcoded
      // decimal count would be wrong for one of them.
      yAxis: [
        {
          ...axis,
          type: "value",
          name: "Cumulative Size (bids)",
          nameLocation: "middle",
          nameGap: 38,
          min: 0,
          max: yMax,
          axisLabel: { ...axis.axisLabel, formatter: (value: number) => value.toFixed(qtyDecimals) },
        },
        {
          ...axis,
          type: "value",
          name: "Cumulative Size (asks)",
          nameLocation: "middle",
          nameGap: 38,
          position: "right" as const,
          min: 0,
          max: yMax,
          axisLabel: { ...axis.axisLabel, formatter: (value: number) => value.toFixed(qtyDecimals) },
          // Both axes plot the same [0, yMax] range on the same physical
          // gridlines — a second set at identical heights would just
          // double-draw the left axis's own lines.
          splitLine: { show: false },
          // Hidden in a narrow container (see COMPACT_WIDTH_PX) — the ask
          // series still plots against this axis's [0, yMax] range either
          // way (yAxisIndex: 1 below), so hiding it changes nothing about
          // the curve's own shape, only whether its redundant copy of the
          // bid axis's scale is drawn.
          show: !isCompact,
        },
      ],
      series: [
        {
          id: "bids",
          name: "bids",
          type: "line" as const,
          yAxisIndex: 0,
          // 'start': between two bid levels the cumulative equals the value
          // at the RIGHT (higher-price) point, because cumulative bid depth
          // at price q is "all size resting at prices >= q" and there are no
          // levels strictly between the two. So the vertical transition
          // belongs at the left point and the value holds across to the
          // right — which is what 'start' draws. (The ask side is the mirror
          // image and needs 'end'; the uPlot version used one alignment for
          // both, so one of the two sides was always off by a step.)
          step: "start" as const,
          showSymbol: false,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { color: chartTheme.bid, width: 1.5, opacity: bidOpacity },
          itemStyle: { color: chartTheme.bid, opacity: bidOpacity },
          areaStyle: { color: verticalFade(chartTheme.bid), origin: "start" as const, opacity: bidOpacity },
          data: curve?.bid ?? [],
        },
        {
          id: "asks",
          name: "asks",
          type: "line" as const,
          yAxisIndex: 1,
          // 'end': cumulative ask depth at q is "all size resting at prices
          // <= q", so between two levels the value is the LEFT point's —
          // horizontal first, vertical at the right. Mirror of the bid side.
          step: "end" as const,
          showSymbol: false,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { color: chartTheme.ask, width: 1.5, opacity: askOpacity },
          itemStyle: { color: chartTheme.ask, opacity: askOpacity },
          areaStyle: { color: verticalFade(chartTheme.ask), origin: "start" as const, opacity: askOpacity },
          data: curve?.ask ?? [],
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            data: markLineData,
          },
        },
      ],
    };

    setOption(option);
  }, [
    curve,
    priceBounds,
    axisPriceDecimals,
    hoveredPrice,
    priceDecimals,
    qtyDecimals,
    chartTheme,
    gridRight,
    isCompact,
    bidOpacity,
    askOpacity,
    setOption,
  ]);

  const hasData = !!snapshot && (snapshot.bids.length > 0 || snapshot.asks.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 rounded-lg border border-border bg-panel p-2 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-foreground" title="Cumulative bid/ask size at each price level, live.">
          Depth curve
        </div>
        {/* Size-imbalance badge, in the header row above the chart —
            previously an absolutely-positioned overlay ON the plot, sitting
            right on top of the center dashed line. The line ran the
            chart's full height directly behind it regardless of how
            opaque the badge's own background was, which read as the line
            visibly passing through/behind the badge no matter how that was
            styled. Living in the header instead sidesteps the collision
            entirely — nothing here shares space with the line — and drops
            the pixel-position tracking (badgeLeftPx, formerly here) that
            existed only to place it over the plot in the first place. */}
        {hasData && sizeDiffLabel && (
          <div className="group relative flex items-center">
            <div
              className="flex items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-2 pr-1 font-mono text-[10px] font-bold"
              style={{ color: chartTheme.text, borderColor: withAlpha(dominantColor, 0.5), backgroundColor: chartTheme.panel }}
            >
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dominantColor }} />
              {sizeDiffLabel}
              {/* A dotted underline on "cursor-help" reads as "hover me"
                  without needing a separate icon glyph competing for space
                  inside an already-tight pill — the info affordance IS the
                  badge, not a bolted-on circle next to it. */}
              <span className="cursor-help text-[9px] font-normal text-muted-foreground underline decoration-dotted underline-offset-2">
                why?
              </span>
            </div>
            {/* Custom popover, not a native `title` tooltip — a browser
                default tooltip is a plain unstyled gray box that also
                forces the explanation into one unbroken run-on line,
                which is what made the previous version read as bloated.
                This is themed (panel background, real border, rounded)
                and wraps onto its own short lines, closer to how the
                ECharts tooltip elsewhere in this app already looks.
                Opacity-based show/hide (not `hidden`), so it's still in
                the DOM for a smooth fade rather than popping in. */}
            <div
              className="pointer-events-none absolute left-1/2 top-full z-10 mt-1.5 w-44 -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-[10px] leading-snug opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100"
              style={{ backgroundColor: chartTheme.panel, borderColor: chartTheme.border, color: chartTheme.text }}
            >
              Larger side&apos;s total size minus the smaller — whole book, not just visible rows.
            </div>
          </div>
        )}
        {/* Bids/Asks legend, now clickable: clicking one fades the OTHER
            side's line/area (not this one hidden entirely — see
            focusedSide's own comment) so a user can visually isolate
            whichever side they're comparing. Clicking the already-focused
            side clears it. The clicked swatch itself stays full-opacity as
            a "this one is selected" cue; the other one dims to match its
            own now-faded curve. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setFocusedSide((prev) => (prev === "bid" ? null : "bid"))}
            className="cursor-pointer transition-opacity"
            style={{ opacity: focusedSide === "ask" ? FADED_OPACITY : 1 }}
            aria-pressed={focusedSide === "bid"}
            title="Click to fade asks"
          >
            <LegendSwatch color={chartTheme.bid} label="Bids" />
          </button>
          <button
            type="button"
            onClick={() => setFocusedSide((prev) => (prev === "ask" ? null : "ask"))}
            className="cursor-pointer transition-opacity"
            style={{ opacity: focusedSide === "bid" ? FADED_OPACITY : 1 }}
            aria-pressed={focusedSide === "ask"}
            title="Click to fade bids"
          >
            <LegendSwatch color={chartTheme.ask} label="Asks" />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1" style={{ minHeight }}>
        <div ref={containerRef} className="absolute inset-0" />
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
            Waiting for order book snapshot…
          </div>
        )}
      </div>
    </div>
  );
}
