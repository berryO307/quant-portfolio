"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { computeDepthLevels } from "@/lib/orderBook";
import { toPrice, toQty, type SnapshotRecord } from "@/lib/types";
import { buildAxisStyle, useChartTheme, withAlpha } from "@/lib/chartTheme";
import { LegendSwatch } from "./LegendSwatch";

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

// Two options, not the earlier four (Phase 8.5's eighth pass): "Tick"
// redraws directly as each snapshot arrives (no throttle at all — ms: 0 is
// a sentinel meaning "skip the interval entirely", not a 0ms setInterval),
// "1s" throttles to a fixed one-second cadence that's easier to watch by
// eye than every individual tick.
const TIMEFRAMES: { label: string; ms: number }[] = [
  { label: "Tick", ms: 0 },
  { label: "1s", ms: 1_000 },
];
const DEFAULT_TIMEFRAME_MS = 1_000;

// Floor for the depth-level selector. Was 50 back when this fed Bybit's
// export pipeline (up to 100 real levels/side) — now that Hyperliquid is
// the only source, its l2Book channel is HARD-capped at exactly 20 levels
// per side, confirmed directly against the live API (tried nSigFigs
// 2 through 5 on both REST and WS: always exactly 20/20, regardless —
// nSigFigs only changes price-aggregation granularity, never level count;
// there is no deeper feed, WS or REST, native or dex-scoped). A floor of
// 50 could never be reached, which is why the selector always collapsed
// to a single misleadingly-labeled "50 levels" option showing only the
// real ~20. Floor and step both lowered to fit the real ceiling. There's
// still no hardcoded ceiling here: the selector's actual max always tracks
// however many levels the live snapshot genuinely has (see
// maxAvailableLevels below) — if Hyperliquid ever raises l2Book's own cap,
// this grows to match with nothing here needing to change.
const MIN_DEPTH_LEVELS = 5;
const DEPTH_STEP = 5;

// Fixes the gap at the spread by not leaving one at all instead of
// shading/labeling it: both series get one shared bridging point exactly at
// the bid/ask midpoint (a flat continuation of each side's own last real
// value, not a new data point pretending to be a real level), so the
// stepped fills meet edge-to-edge with no blank canvas between them. The
// two best prices are still genuinely different underneath (a real order
// book never has bid == ask) — only the rendered boundary, and the
// permanent "spot price" marker line, sit at their midpoint.
//
// maxLevels bounds how many real levels (nearest the spread first, on each
// side) get plotted — the depth-level selector's value. Slicing happens
// right after computeDepthLevels, same "closest to spread first" ordering
// OrderBookLadder's own truncation already relies on.
function buildAlignedData(
  snapshot: SnapshotRecord,
  maxLevels: number
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
  const full = computeDepthLevels(snapshot);
  const bids = full.bids.slice(0, maxLevels);
  const asks = full.asks.slice(0, maxLevels);
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
  const [timeframeMs, setTimeframeMs] = useState(DEFAULT_TIMEFRAME_MS);
  const [throttledSnapshot, setThrottledSnapshot] = useState<SnapshotRecord | null>(null);
  // Defaults to "show everything available" (effectiveDepthLevels below
  // clamps this to whatever the live snapshot actually has) rather than
  // the floor — with a real ceiling as shallow as Hyperliquid's 20/side,
  // starting at the 5-level floor would show a quarter of the book by
  // default, which reads as broken/incomplete rather than deliberately
  // narrowed. A generously large sentinel keeps this correct even if a
  // future source's real ceiling differs from today's 20.
  const [depthLevels, setDepthLevels] = useState(1000);
  const latestSnapshotRef = useRef<SnapshotRecord | null>(null);

  useEffect(() => {
    onHoverPriceRef.current = onHoverPrice;
  }, [onHoverPrice]);
  useEffect(() => {
    latestSnapshotRef.current = snapshot;
  }, [snapshot]);

  // Tick mode (ms 0) skips this entirely and effectiveSnapshot below just
  // uses the live prop directly. 1s mode pulls whatever the latest snapshot
  // is on that cadence instead of redrawing on every individual push, and
  // fires once immediately on selecting it so switching feels responsive
  // rather than waiting a full second for the first redraw.
  useEffect(() => {
    if (timeframeMs <= 0) return;
    setThrottledSnapshot(latestSnapshotRef.current);
    const id = setInterval(() => setThrottledSnapshot(latestSnapshotRef.current), timeframeMs);
    return () => clearInterval(id);
  }, [timeframeMs]);

  const effectiveSnapshot = timeframeMs <= 0 ? snapshot : (throttledSnapshot ?? snapshot);

  // The selector's ceiling tracks whatever the live snapshot actually has —
  // not a hardcoded number — so it grows on its own if the export pipeline
  // ever carries more than 50/side again, with nothing here to update.
  const maxAvailableLevels = Math.max(
    effectiveSnapshot?.bids.length ?? MIN_DEPTH_LEVELS,
    effectiveSnapshot?.asks.length ?? MIN_DEPTH_LEVELS,
    MIN_DEPTH_LEVELS
  );
  const effectiveDepthLevels = Math.min(depthLevels, maxAvailableLevels);

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

  // New (possibly throttled) snapshot, OR a depth-selector change -> update
  // the existing instance's data in place, and reposition the permanent
  // spot-price line.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !effectiveSnapshot) return;
    const { data, rawXs, bridgeIdx } = buildAlignedData(effectiveSnapshot, effectiveDepthLevels);
    rawXsRef.current = rawXs;
    bridgeIdxRef.current = bridgeIdx;
    plot.setData(data);
    positionSpotLine();
     
  }, [effectiveSnapshot, effectiveDepthLevels]);

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

  const hasData = !!effectiveSnapshot && (effectiveSnapshot.bids.length > 0 || effectiveSnapshot.asks.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 rounded-md border border-border bg-panel p-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-foreground" title="Cumulative bid/ask size at each price level, live.">
          Depth curve
        </div>
        <div className="flex items-center gap-3">
          <DepthLevelSelect value={effectiveDepthLevels} max={maxAvailableLevels} onChange={setDepthLevels} />
          <TimeframeToggle value={timeframeMs} onChange={setTimeframeMs} />
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

function DepthLevelSelect({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  // Options in DEPTH_STEP increments from MIN_DEPTH_LEVELS up to max — max
  // itself always included even if it doesn't land on a round step, so
  // "show everything available" is always one of the choices, not just
  // whatever the nearest step happens to be.
  const options: number[] = [];
  for (let n = MIN_DEPTH_LEVELS; n < max; n += DEPTH_STEP) options.push(n);
  options.push(max);

  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      title={`Levels per side shown, nearest the spread first (${MIN_DEPTH_LEVELS}–${max} available)`}
      className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground"
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n} levels
        </option>
      ))}
    </select>
  );
}

function TimeframeToggle({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  return (
    <div
      className="flex overflow-hidden rounded border border-border text-[10px]"
      title="How often the depth curve redraws: every tick, or once a second"
    >
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf.label}
          type="button"
          onClick={() => onChange(tf.ms)}
          className={`px-1.5 py-0.5 ${value === tf.ms ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
        >
          {tf.label}
        </button>
      ))}
    </div>
  );
}
