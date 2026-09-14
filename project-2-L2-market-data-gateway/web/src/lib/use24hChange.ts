"use client";

import { useEffect, useState } from "react";
import type { InstrumentConfig } from "./instruments";

// 24h change doesn't need anywhere near live-tick cadence — this is
// context, not the thing being measured.
const POLL_MS = 60_000;

export interface Change24h {
  pcnt: number | null; // e.g. 0.0086 means +0.86%
  lastPrice: number | null;
}

const EMPTY: Change24h = { pcnt: null, lastPrice: null };

// Hyperliquid's metaAndAssetCtxs carries markPx + prevDayPx per instrument
// in the SAME response used to ground the instrument shortlist itself
// (see instruments.ts's header comment) — no separate ticker endpoint
// needed, confirmed live: {"markPx":"77704.0","prevDayPx":"76775.0"} for
// BTC. Also CORS-open (verified directly, access-control-allow-origin: *).
// A dex-scoped symbol ("xyz:CL") needs the request's "dex" field set to
// the part before the colon — the response's own universe entries are
// already named with the full "xyz:CL"-style prefix, confirmed live, so
// matching by the untouched symbol string works for both native and
// dex-scoped instruments without separately stripping the prefix.
//
// (Bybit's REST ticker was used here before Bybit support was removed
// entirely — see BUGS.md and instruments.ts's header comment.)
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

interface HyperliquidAssetCtx {
  markPx?: string;
  prevDayPx?: string;
}
interface HyperliquidMetaAndAssetCtxs {
  0: { universe: { name: string }[] };
  1: HyperliquidAssetCtx[];
}

async function fetchHyperliquid24h(symbol: string): Promise<Change24h | null> {
  const dex = symbol.includes(":") ? symbol.split(":")[0] : undefined;
  const body = dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" };
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as HyperliquidMetaAndAssetCtxs;
  const idx = data[0]?.universe?.findIndex((u) => u.name === symbol) ?? -1;
  if (idx < 0) return null;
  const ctx = data[1]?.[idx];
  if (!ctx?.markPx || !ctx?.prevDayPx) return null;
  const markPx = Number(ctx.markPx);
  const prevDayPx = Number(ctx.prevDayPx);
  if (!Number.isFinite(markPx) || !Number.isFinite(prevDayPx) || prevDayPx === 0) return null;
  return { pcnt: (markPx - prevDayPx) / prevDayPx, lastPrice: markPx };
}

export function use24hChange(instrument: InstrumentConfig): Change24h {
  const [state, setState] = useState<Change24h>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let isFirstPoll = true;

    const poll = async () => {
      if (isFirstPoll) {
        // Switching instruments — don't show the previous one's stale
        // figure while the first fetch for the new one is in flight.
        // Nested inside poll() rather than the effect body directly so
        // this is a callback-triggered update, not a synchronous one.
        setState(EMPTY);
        isFirstPoll = false;
      }
      try {
        const result = await fetchHyperliquid24h(instrument.symbol);
        if (cancelled || !result) return;
        setState(result);
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
  }, [instrument.symbol]);

  return state;
}
