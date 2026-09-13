// Mirrors relay/src/types.ts and, transitively, the NDJSON schema written by
// ColdPathExporter (include/export_pipeline.hpp) — field names match exactly
// so a message can be parsed identically regardless of which layer it came
// through.

export type Side = "bid" | "ask" | "both" | "none";

export interface SampleRecord {
  type: "sample";
  t_recv: number;
  t_parse: number;
  t_book: number;
  t_publish: number;
  queue_depth: number;
  host_jitter_ns: number;
  side: Side;
  cpu_core: number;
}

export interface SnapshotRecord {
  type: "snapshot";
  tsc: number;
  // Ordered best-price-first: bids descending (best/highest first), asks
  // ascending (best/lowest first) — see OrderBook::top_bids/top_asks.
  // At most EXPORT_SNAPSHOT_DEPTH (10) levels per side, refreshed ~1/s —
  // this is the only order-book state the pipeline pushes; there is no
  // per-tick full-depth feed upstream of this.
  bids: [number, number][];
  asks: [number, number][];
}

export interface TradeRecord {
  type: "trade";
  tsc: number;
  price: number;
  qty: number;
  trade_id: number;
  side: Side;
}

export interface HistogramSnapshot {
  count: number;
  maxNs: number;
  p50Ns: number;
  p99Ns: number;
  p999Ns: number;
}

export interface StatsMessage {
  type: "stats";
  rolling12h: HistogramSnapshot;
  currentSession: HistogramSnapshot;
}

export type RelayMessage = SampleRecord | SnapshotRecord | TradeRecord | StatsMessage;

export function isRelayMessage(value: unknown): value is RelayMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const t = (value as { type: unknown }).type;
  return t === "sample" || t === "snapshot" || t === "trade" || t === "stats";
}

// Scale factors from the C++ side (types.hpp: PRICE_SCALE, QTY_SCALE) —
// prices/quantities travel over the wire as scaled integers, same
// convention as NormalizedTick and everything else in this pipeline.
export const PRICE_SCALE = 10_000;
export const QTY_SCALE = 1_000;

export function toPrice(scaled: number): number {
  return scaled / PRICE_SCALE;
}

export function toQty(scaled: number): number {
  return scaled / QTY_SCALE;
}

// A trade tagged with the browser's own receipt time. TradeRecord only
// carries a raw TSC value (tsc), which has no fixed relationship to
// wall-clock time without a calibration anchor the wire protocol doesn't
// carry (same class of gap as the cpu_ghz handshake — see relay/src/types.ts).
// Local receipt time is the only wall-clock basis available client-side, and
// for a live tape (not a precise historical record) that's an acceptable
// stand-in — off by network + relay queueing delay, not by session drift.
export interface TimedTrade extends TradeRecord {
  receivedAtMs: number;
}
