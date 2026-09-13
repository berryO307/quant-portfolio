"use client";

import { useEffect, useRef, useState } from "react";
import { toPrice, toQty, type TimedTrade } from "@/lib/types";

const ROW_HEIGHT_PX = 24; // must match TradeRow's h-6
const OVERSCAN = 6;

interface TradesTapeProps {
  trades: TimedTrade[]; // newest first
}

// Simple windowed rendering: only rows within the visible viewport (plus a
// small overscan) are mounted, no matter how many trades are retained. Not
// pulling in a virtualization library since row height is fixed and
// uniform — a scroll-position calculation is enough.
export function TradesTape({ trades }: TradesTapeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col font-mono text-xs">
      <div className="grid grid-cols-3 gap-2 border-b border-[#30363d] px-3 py-1 text-[10px] uppercase tracking-wide text-[#8b949e]">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      {trades.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[#8b949e]">waiting for trades...</div>
      ) : (
        <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="flex-1 overflow-y-auto">
          <TapeWindow trades={trades} scrollTop={scrollTop} viewportHeight={viewportHeight} />
        </div>
      )}
    </div>
  );
}

function TapeWindow({
  trades,
  scrollTop,
  viewportHeight,
}: {
  trades: TimedTrade[];
  scrollTop: number;
  viewportHeight: number;
}) {
  const totalHeight = trades.length * ROW_HEIGHT_PX;
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT_PX) + OVERSCAN * 2;
  const lastVisible = Math.min(trades.length, firstVisible + visibleCount);
  const visible = trades.slice(firstVisible, lastVisible);

  return (
    <div style={{ height: totalHeight, position: "relative" }}>
      <div style={{ transform: `translateY(${firstVisible * ROW_HEIGHT_PX}px)` }}>
        {visible.map((trade) => (
          <TradeRow key={trade.trade_id} trade={trade} />
        ))}
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: TimedTrade }) {
  const color = trade.side === "bid" ? "text-[#3fb950]" : "text-[#f85149]";
  const date = new Date(trade.receivedAtMs);
  const time =
    date.toLocaleTimeString("en-US", { hour12: false }) + "." + String(trade.receivedAtMs % 1000).padStart(3, "0");

  return (
    <div className="grid h-6 grid-cols-3 items-center gap-2 px-3">
      <span className={color}>{toPrice(trade.price).toFixed(4)}</span>
      <span className="text-right text-[#c9d1d9]">{toQty(trade.qty).toFixed(3)}</span>
      <span className="text-right text-[#8b949e]">{time}</span>
    </div>
  );
}
