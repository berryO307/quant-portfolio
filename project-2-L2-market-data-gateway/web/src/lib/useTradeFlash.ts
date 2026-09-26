"use client";

import { useEffect, useState } from "react";
import { bucketSinglePrice } from "./orderBook";
import type { TimedTrade } from "./types";

export interface TradeFlash {
  bucketPrice: number;
  side: "bid" | "ask";
  key: number; // the trade's own trade_id — see the comment below for why
}

const FLASH_MS = 450; // matches globals.css's flash-bid/flash-ask animation duration

// Flashes the ladder row a trade just printed against, matching
// Hyperliquid's own order-book UI (reported live: "the flash on the
// hyperliquid book is when a order matches"). `key` is the trade's own
// trade_id, not just the bucketed price — two trades landing on the exact
// same price back-to-back should each get their own flash, and a plain
// price-equality check would silently no-op on the second one since
// nothing about the VALUE changed, only that a new trade happened.
//
// bucketPrice is computed with the same floor-for-bids/ceil-for-asks
// convention lib/orderBook.ts's own bucketing uses, so it lines up exactly
// with whichever bucketed row the ladder is currently showing for this
// price — side comes directly from the trade record (which side of the
// book it printed against), not inferred from price direction.
export function useTradeFlash(lastTrade: TimedTrade | null, bucketSize: number): TradeFlash | null {
  const [flash, setFlash] = useState<TradeFlash | null>(null);
  // Tracks the last trade_id already turned into a flash — compared
  // during render (not in an effect) so this is the same "derive state
  // from a changed prop" pattern already used elsewhere in this app
  // (OrderBookLadder/DepthCurve's bucket-size reset on instrument switch),
  // not a synchronous setState-in-effect, which this repo's lint config
  // disallows.
  const [seenTradeId, setSeenTradeId] = useState<number | null>(null);

  if (
    lastTrade &&
    lastTrade.trade_id !== seenTradeId &&
    (lastTrade.side === "bid" || lastTrade.side === "ask")
  ) {
    setSeenTradeId(lastTrade.trade_id);
    const roundDown = lastTrade.side === "bid";
    setFlash({
      bucketPrice: bucketSinglePrice(lastTrade.price, bucketSize, roundDown),
      side: lastTrade.side,
      key: lastTrade.trade_id,
    });
  }

  // The timer that clears the flash IS a legitimate effect (an external
  // subscription, per this repo's own set-state-in-effect exception) —
  // setState happens inside setTimeout's callback, not directly in the
  // effect body. `flash` only changes reference when a new trade sets it
  // or the timer itself clears it to null, so depending on the whole
  // object (not just its `key`) still only restarts this effect exactly
  // when a genuinely new flash begins.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  return flash;
}
