"use client";

import { useEffect, useState } from "react";

// 24h change doesn't need anywhere near live-tick cadence — this is
// context, not the thing being measured.
const POLL_MS = 60_000;

export interface Change24h {
  pcnt: number | null; // e.g. 0.0086 means +0.86%
  lastPrice: number | null;
}

const EMPTY: Change24h = { pcnt: null, lastPrice: null };

// Bybit's public v5 ticker endpoint — category=linear to match what the C++
// gateway actually subscribes to (src/ws_client.cpp connects to
// stream.bybit.com/v5/public/linear, USDT-margined perpetual futures, not
// spot; querying category=spot here would silently show the wrong
// instrument's 24h change). No API key needed, and it's genuinely
// CORS-open for browser fetches (verified directly — the response reflects
// Access-Control-Allow-Origin back to whatever origin asked), so this is a
// plain client-side fetch, no relay/gateway involvement at all: 24h change
// is public market context, not something that needs to flow through our
// own capture pipeline.
function tickerUrl(symbol: string): string {
  return `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
}

interface BybitTickerResponse {
  result?: {
    list?: { lastPrice?: string; price24hPcnt?: string }[];
  };
}

export function use24hChange(symbol: string): Change24h {
  const [state, setState] = useState<Change24h>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(tickerUrl(symbol), { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as BybitTickerResponse;
        const entry = data.result?.list?.[0];
        if (cancelled || !entry) return;
        setState({
          pcnt: entry.price24hPcnt != null ? Number(entry.price24hPcnt) : null,
          lastPrice: entry.lastPrice != null ? Number(entry.lastPrice) : null,
        });
      } catch {
        // A different, unrelated public API being briefly unreachable
        // shouldn't disturb anything else on the page — leave whatever
        // was last shown (or nothing, on the very first failed poll)
        // rather than surfacing an error state for peripheral context.
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  return state;
}
