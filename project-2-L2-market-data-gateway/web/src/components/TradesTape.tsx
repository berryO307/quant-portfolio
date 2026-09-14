"use client";

import { useEffect, useRef, useState } from "react";
import { toPrice, toQty, type TimedTrade } from "@/lib/types";

const ROW_HEIGHT_PX = 24; // must match TradeRow's h-6

interface TradesTapeProps {
  trades: TimedTrade[]; // newest first
}

// Phase 8.5's third pass: dropped the scroll+virtualization approach for a
// dense, scrollbar-free tape matching the reference screenshot — this is
// fast-moving live data; nobody scrolls down looking for an old trade. A
// ResizeObserver measures how many fixed-height rows actually fit the
// container, and only that many (of the newest trades) are ever rendered;
// useRelayConnection also caps the underlying array itself at MAX_TRADES,
// well past what any realistic tape height needs.
export function TradesTape({ trades }: TradesTapeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRows, setVisibleRows] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setVisibleRows(Math.max(0, Math.floor(entry.contentRect.height / ROW_HEIGHT_PX)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visible = trades.slice(0, visibleRows);

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="grid grid-cols-3 gap-2 border-b border-border px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      {trades.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">Waiting for trades…</div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-hidden">
          {visible.map((trade) => (
            <TradeRow key={trade.trade_id} trade={trade} />
          ))}
        </div>
      )}
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
      <span className={`font-mono tabular-nums ${color}`}>{toPrice(trade.price).toFixed(4)}</span>
      <span className="text-right font-mono tabular-nums text-foreground">{toQty(trade.qty).toFixed(3)}</span>
      <span className="text-right font-mono tabular-nums text-muted-foreground">{time}</span>
    </div>
  );
}
