"use client";

import { RELAY_HEALTH_URL, RELAY_WS_URL } from "@/lib/config";
import { useRelayConnection } from "@/lib/useRelayConnection";
import { FeedStatusBanner } from "./FeedStatusBanner";
import { OrderBookLadder } from "./OrderBookLadder";
import { TradesTape } from "./TradesTape";

export function Dashboard() {
  const { wsConnected, healthOk, latestSnapshot, trades } = useRelayConnection(RELAY_WS_URL, RELAY_HEALTH_URL);

  return (
    <div className="flex h-screen flex-col bg-[#0d1117] text-[#c9d1d9]">
      <FeedStatusBanner wsConnected={wsConnected} healthOk={healthOk} />
      <div className="grid flex-1 grid-cols-2 divide-x divide-[#30363d] overflow-hidden">
        <OrderBookLadder snapshot={latestSnapshot} />
        <TradesTape trades={trades} />
      </div>
    </div>
  );
}
