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

// Mirrors relay/src/rollingStatsAggregator.ts's AttributionSplit — an
// IQR-based approximation of the exact median+5*MAD attribution used
// elsewhere (Phase 5/8), since the relay only retains bucketed histogram
// counts for its 12h window, not raw samples MAD needs.
export interface AttributionSplit {
  tailCount: number;
  jitterTailCount: number;
  pipelineTailCount: number;
}

export interface StatsMessage {
  type: "stats";
  rolling12h: HistogramSnapshot;
  rolling12hSplit: AttributionSplit;
  currentSession: HistogramSnapshot;
}

// Rebroadcast by the relay to every browser client whenever the upstream
// gateway (re)connects, and sent directly to each newly-connecting browser
// client too (see relay/src/index.ts) — same handshake contract as
// relay/src/types.ts's HelloMessage, one hop further downstream. Needed
// because SampleRecord's t_recv/t_parse/t_book/t_publish are raw TSC values,
// not ns.
export interface HelloMessage {
  type: "hello";
  cpu_ghz: number;
}

export type RelayMessage = SampleRecord | SnapshotRecord | TradeRecord | StatsMessage | HelloMessage;

export function isRelayMessage(value: unknown): value is RelayMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const t = (value as { type: unknown }).type;
  return t === "sample" || t === "snapshot" || t === "trade" || t === "stats" || t === "hello";
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

// ── Phase 8: latency panel ──────────────────────────────────────────────────

// A live SampleRecord with its TSC fields already converted to ns (using
// whatever cpu_ghz was known at the moment it arrived — see
// useRelayConnection). Kept in a bounded rolling buffer for the live scatter
// chart and for client-side tail detection (lib/tailAttribution.ts).
export interface LiveSample {
  tRecvTsc: number;
  latencyNs: number;
  parseNs: number;
  bookUpdateNs: number;
  publishNs: number;
  hostJitterNs: number;
}

export type Attribution = "host_jitter" | "parse" | "book-update" | "publish";

// Canonical shape both a loaded historical summary.json's tail_events and
// client-side live tail detection produce, so TailEventsFeed/StageBreakdown
// don't need to know which source they're rendering.
export interface TailEvent {
  key: string;
  tRecvTsc: number;
  latencyNs: number;
  hostJitterNs: number;
  attribution: Attribution;
  stageNs: { parse: number; bookUpdate: number; publish: number };
}

// Mirrors analysis/export_summary.py's summary.json exactly (snake_case,
// matching the file on disk) — parsed as-is from an uploaded file, then
// adapted into the canonical shapes above by lib/tailAttribution.ts.
export interface HistoricalSummary {
  session: {
    path: string;
    cpu_ghz_used: number;
    n_samples: number;
    duration_s_approx: number;
  };
  percentiles_ns: { count: number; p50_ns: number; p99_ns: number; p999_ns: number; max_ns: number };
  stage_medians_ns: { parse: number; book_update: number; publish: number };
  host_jitter: { baseline_ns: number; elevated_threshold_ns: number };
  tail_events: {
    index: number;
    t_recv_tsc: number;
    latency_ns: number;
    host_jitter_ns: number;
    attribution: Attribution;
    stage_ns: { parse: number; book_update: number; publish: number };
  }[];
}
