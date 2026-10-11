import type { Metadata } from "next";

import { Dashboard } from "@/components/Dashboard";
import { INSTRUMENTS } from "@/lib/instruments";

export const metadata: Metadata = {
  title: "L2 OrderBook",
};

// The URL is the source of truth for the instrument: /orderbook?symbol=xyz:CL
// is shareable/bookmarkable and survives a reload, and the browser's back
// button steps through instrument switches. An unknown or missing symbol
// falls back to the first instrument.
//
// key={instrument.id}: switching instrument remounts the Dashboard, so every
// per-instrument piece of state (connection, book, trades, bucket size, feed
// mode) starts clean instead of each needing its own manual reset.
export default async function Page({ searchParams }: { searchParams: Promise<{ symbol?: string | string[] }> }) {
  const { symbol } = await searchParams;
  const instrument = INSTRUMENTS.find((i) => i.symbol === symbol) ?? INSTRUMENTS[0]!;
  return <Dashboard key={instrument.id} instrument={instrument} />;
}
