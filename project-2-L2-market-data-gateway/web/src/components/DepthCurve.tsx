"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { computeDepthLevels } from "@/lib/orderBook";
import { toPrice, toQty, type SnapshotRecord } from "@/lib/types";
import { COLOR_ASK, COLOR_BID, UPLOT_AXIS_STYLE } from "@/lib/theme";

interface DepthCurveProps {
  snapshot: SnapshotRecord | null;
  hoveredPrice: number | null;
  onHoverPrice: (price: number | null) => void;
  height?: number;
}

function buildAlignedData(snapshot: SnapshotRecord): { data: uPlot.AlignedData; xs: number[] } {
  const { bids, asks } = computeDepthLevels(snapshot);
  const bidsAscending = [...bids].reverse(); // ascending price, cumulative descends toward the spread
  const asksAscending = asks; // already ascending price, cumulative rises away from the spread

  const bidPrices = bidsAscending.map((l) => l.price);
  const askPrices = asksAscending.map((l) => l.price);
  const xs = [...bidPrices, ...askPrices];

  const bidYs: (number | null)[] = [...bidsAscending.map((l) => l.total), ...askPrices.map(() => null)];
  const askYs: (number | null)[] = [...bidPrices.map(() => null), ...asksAscending.map((l) => l.total)];

  return { data: [xs, bidYs, askYs], xs };
}

// Cumulative bid/ask volume vs price, next to OrderBookLadder — built from
// the exact same computeDepthLevels() call the ladder uses, so the two
// views can never silently drift apart. Cumulative totals grow AWAY from
// the spread on both sides (matches the ladder's bar-width convention):
// bids plotted ascending-price left-to-right so the curve descends toward
// the spread, asks ascending so theirs rises away from it.
//
// The uPlot instance is created ONCE (mount effect below) and updated via
// setData() on every new snapshot, rather than destroyed and rebuilt each
// time — destroy/recreate on every ~1s snapshot turned out to reliably
// break rendering after repeated cycles (confirmed via Playwright: fine at
// first, blank canvas after ~15-20 rebuilds), most likely something in
// uPlot's own cleanup interacting badly with this component's cursor hook
// across repeated construction. setData() is also the more idiomatic uPlot
// pattern regardless, and sidesteps the issue entirely rather than papering
// over its specific cause.
//
// Hover sync with the ladder is one-directional through uPlot's own cursor
// machinery (curve -> onHoverPrice, via the setCursor hook) and one-
// directional through a plain overlay (ladder -> curve, drawn from the
// hoveredPrice prop without touching uPlot's internal cursor object) — see
// the mount effect for why driving uPlot's cursor programmatically is
// avoided.
export function DepthCurve({ snapshot, hoveredPrice, onHoverPrice, height = 260 }: DepthCurveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const xsRef = useRef<number[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const onHoverPriceRef = useRef(onHoverPrice);
  useEffect(() => {
    onHoverPriceRef.current = onHoverPrice;
  }, [onHoverPrice]);

  // Mount once: create the uPlot instance with empty data. Series count,
  // colors, and the cursor hook are all fixed for this component's
  // lifetime, so there's nothing here that needs to change on every
  // snapshot — only the data does, handled by the effect below.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height,
      series: [
        {},
        {
          label: "bids",
          stroke: COLOR_BID,
          fill: `${COLOR_BID}22`,
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: false },
        },
        {
          label: "asks",
          stroke: COLOR_ASK,
          fill: `${COLOR_ASK}22`,
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: false },
        },
      ],
      scales: { x: { time: false } },
      axes: [UPLOT_AXIS_STYLE, { ...UPLOT_AXIS_STYLE, label: "cumulative size" }],
      legend: { show: false },
      cursor: { x: true, y: false, drag: { x: false, y: false } },
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            onHoverPriceRef.current(idx == null ? null : (xsRef.current[idx] ?? null));
          },
        ],
      },
    };

    const plot = new uPlot(opts, [[], [], []], el);
    plotRef.current = plot;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 400, height });
    });
    resize.observe(el);

    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [height]);

  // New snapshot -> update the existing instance's data in place.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !snapshot) return;
    const { data, xs } = buildAlignedData(snapshot);
    xsRef.current = xs;
    plot.setData(data);
  }, [snapshot]);

  // Ladder -> curve hover: draw a plain overlay line, never touching
  // uPlot's own cursor state (see the component comment above).
  useEffect(() => {
    const plot = plotRef.current;
    const overlay = overlayRef.current;
    if (!plot || !overlay) return;

    if (hoveredPrice == null) {
      overlay.style.display = "none";
      return;
    }
    const px = plot.valToPos(hoveredPrice, "x");
    if (px == null || Number.isNaN(px)) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";
    overlay.style.left = `${px}px`;
  }, [hoveredPrice]);

  // IMPORTANT: the container div (and its ref) must always render, even
  // before a snapshot has ever arrived. The mount effect above runs once,
  // reads containerRef.current, and never runs again — if this component
  // took an early return here that skipped the container on first mount
  // (snapshot is null on the very first render), the ref would still be
  // null when that effect fires, and the uPlot instance would simply never
  // get created, even after a snapshot later arrives to make this branch
  // "true". Confirmed via Playwright: this was the actual bug, not the
  // repeated-rebuild theory in the comment above the mount effect (that fix
  // was real too, but this was the one actually causing a blank chart).
  const hasData = !!snapshot && (snapshot.bids.length > 0 || snapshot.asks.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-xs">
      <div className="flex items-center gap-3 border-b border-[#30363d] px-3 py-1 text-[10px] uppercase tracking-wide text-[#8b949e]">
        <span>Depth curve</span>
        {hasData && hoveredPrice != null && (
          <span className="normal-case text-[#c9d1d9]">
            {toPrice(hoveredPrice).toFixed(4)}
            {" · "}
            {toQty(
              [...computeDepthLevels(snapshot).bids, ...computeDepthLevels(snapshot).asks].find(
                (l) => l.price === hoveredPrice
              )?.total ?? 0
            ).toFixed(3)}
          </span>
        )}
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1 p-2" onMouseLeave={() => onHoverPrice(null)}>
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[#8b949e]">
            waiting for order book snapshot...
          </div>
        )}
        <div
          ref={overlayRef}
          className="pointer-events-none absolute top-2 bottom-2 hidden w-px bg-[#c9d1d9]"
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
