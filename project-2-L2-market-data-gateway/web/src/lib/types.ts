// Mirrors relay/src/types.ts and, transitively, the NDJSON schema written by
// ColdPathExporter (include/export_pipeline.hpp) — field names match exactly
// so a message can be parsed identically regardless of which layer it came
// through.

export type Side = "bid" | "ask" | "both" | "none";

// The four t_* stamps are points on one timeline; a stage is the gap between
// two adjacent ones. t_pop is optional only because session files captured
// before the gateway emitted it replay through this same shape — a live
// gateway always sends it.
//
// t_pop exists because a naive two-stamp difference measured the wrong
// thing: t_recv..t_parse happens on the gateway thread while t_book..
// t_publish happens on the consumer thread, so t_book - t_parse silently
// spanned the queue and the consumer's wake-up — measured live, that
// reported an 8.7ms "book update" for what is really a 20ns operation
// behind a queue wait.
//
// Previously also carried t_parse_begin (a per-tick marginal parse cost
// within a batched frame), host_jitter_ns (ambient host scheduler noise
// from a dedicated canary thread) and queue_depth (SPSC queue size at pop)
// — removed as a deliberate project-scope decision: this gateway measures
// its own hot-path work (parse/queue/book/publish), not the host machine's
// scheduler behavior. See git history if any of the three is ever needed
// again.
export interface SampleRecord {
  type: "sample";
  // See relay/src/types.ts's SampleRecord.symbol -- same optionality/
  // rationale, mirrored here verbatim.
  symbol?: string;
  t_recv: number;
  t_parse: number;
  t_pop?: number;
  t_book: number;
  t_publish: number;
  batch_index?: number;
  batch_size?: number;
  // Cumulative count of SpscRingBuffer pushes dropped because the ring was
  // full, sampled alongside this tick (a running total, not a per-tick
  // delta). Optional for the same reason as the other new fields above.
  // Kept deliberately — data-completeness (did the order book miss a real
  // tick), not a latency measurement.
  queue_overflow_dropped?: number;
  side: Side;
  cpu_core: number;
}

export interface SnapshotRecord {
  type: "snapshot";
  // See SampleRecord.symbol's comment.
  symbol?: string;
  tsc: number;
  // Ordered best-price-first: bids descending (best/highest first), asks
  // ascending (best/lowest first) — see OrderBook::top_bids/top_asks.
  // At most EXPORT_SNAPSHOT_DEPTH (100) levels per side, refreshed ~1/s —
  // this is the only order-book state the pipeline pushes; there is no
  // per-tick full-depth feed upstream of this.
  bids: [number, number][];
  asks: [number, number][];
}

// Same shape as SnapshotRecord, sourced from a second, wider-rounded l2Book
// subscription (Hyperliquid's own nSigFigs rounding, see nsigfigs below)
// instead of the primary book -- see Channel::CoarseDepth in
// include/market_data_source.hpp for why this exists. Fed to whichever
// price-bucket tier pickBestSnapshot (lib/orderBook.ts) decides needs more
// real range than the primary (finest-rounding) snapshot can cover --
// reported live: BTC's $1000 bucket rendered a single bid and single ask
// level. A SINGLE coarse tier could not serve every bucket size either:
// bucketing a snapshot whose own native level spacing is already wider than
// the requested display bucket is a no-op, so $5/$10/$100 buckets rendered
// identically to $1000 with just one (nSigFigs=2) source. The gateway now
// pushes one of these per tier (coarse_book_state.hpp's COARSE_TIERS);
// nsigfigs is what tells a viewer's live map of them apart.
export interface CoarseSnapshotRecord {
  type: "coarse_snapshot";
  // See SampleRecord.symbol's comment.
  symbol?: string;
  nsigfigs: number;
  tsc: number;
  bids: [number, number][];
  asks: [number, number][];
}

export interface TradeRecord {
  type: "trade";
  // See SampleRecord.symbol's comment.
  symbol?: string;
  tsc: number;
  price: number;
  qty: number;
  trade_id: number;
  side: Side;
  // Exchange-provided trade time (Hyperliquid's wire "time" field, epoch
  // milliseconds), NOT a gateway-local timestamp. Optional for the same
  // reason as receivedAtMs's own note below -- a session captured before
  // the gateway exported this falls back to receivedAtMs, which is what
  // TradesTape.tsx does.
  event_time_ms?: number;
}

export interface HistogramSnapshot {
  count: number;
  maxNs: number;
  p50Ns: number;
  p99Ns: number;
  p999Ns: number;
  counts: number[];
}

// AttributionSplit/rollingWindowSplit (an IQR-based host-jitter vs pipeline
// attribution over the relay's rolling window) used to live here too —
// removed along with host_jitter_ns on the relay side (see
// rollingStatsAggregator.ts), and it was dead weight even before that:
// nothing in this app ever rendered the split.
export interface StatsMessage {
  type: "stats";
  // Named for "whatever the retained window currently is," not a fixed
  // duration — this field used to be called rolling12h, which quietly went
  // wrong the moment the relay's actual retention shrank to 1 hour (see
  // rollingStatsAggregator.ts) without the name changing to match.
  rollingWindow: HistogramSnapshot;
  currentSession: HistogramSnapshot;
  latencyBuckets?: LatencyBucketSnapshot[];
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
  // Set only when the upstream connection is relay/scripts/replay-gateway.mjs
  // looping a real captured session, not a live gateway -- see relay/src/
  // types.ts's own HelloMessage for the full contract. capturedAt is the
  // ORIGINAL capture's start (epoch ms, from that session's own filename),
  // never "now" -- a looping replay re-sends this same hello on every lap.
  capturedAt?: number;
  // Explicit, not inferred from capturedAt's presence or anything else --
  // a future real-live gateway reconnecting should never need special-
  // casing here just because it happens to share some other field.
  isReplay?: boolean;
  // Which instrument this connection is carrying (e.g. "BTC" or "xyz:CL")
  // -- see relay/src/types.ts's HelloMessage.symbol for the full contract.
  // Every instrument is still served on its own dedicated relay/port (see
  // lib/instruments.ts), so this doesn't route anything client-side; it's
  // read by ReplayIndicator/useRelayConnection purely as a ground-truth
  // label, so a misconfigured port-to-instrument mapping would show up as
  // a mismatch instead of silently mislabeling data.
  symbol?: string;
}

export type RelayMessage =
  | SampleRecord
  | SnapshotRecord
  | CoarseSnapshotRecord
  | TradeRecord
  | StatsMessage
  | HelloMessage;

export function isRelayMessage(value: unknown): value is RelayMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const t = (value as { type: unknown }).type;
  return (
    t === "sample" ||
    t === "snapshot" ||
    t === "coarse_snapshot" ||
    t === "trade" ||
    t === "stats" ||
    t === "hello"
  );
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
  // Browser wall-clock at WS message arrival -- includes exchange-to-relay
  // network time, gateway processing, relay-to-browser network time, and
  // client-side render batching. NOT when the trade happened on the
  // exchange; kept as a fallback display value for pre-existing session
  // files that predate event_time_ms, and as a latency-diagnostic value in
  // its own right, but TradesTape.tsx displays event_time_ms when present.
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
  // t_recv -> t_parse. For tick k of a multi-tick frame (every tick in the
  // frame shares t_recv) this is cumulative through this tick's position in
  // the frame, not this tick's own marginal parse cost alone — a deliberate
  // project-scope simplification (there used to be a separate "in-frame
  // wait" stage isolating the marginal cost; removed as not worth the extra
  // per-tick field for what this project is measuring).
  parseNs: number;
  queueNs: number; // gateway thread -> consumer thread handoff
  bookUpdateNs: number;
  publishNs: number;
  // Position within the frame this tick arrived in. Ticks of one frame
  // genuinely share tRecvTsc, so these are what tells them apart — for
  // plotting them at distinct x positions, and for keying a tail event to
  // one specific tick rather than to every tick of its frame.
  batchIndex: number;
  batchSize: number;
  // Cumulative, not per-tick — the newest sample's value is the current
  // session total. See SampleRecord's field for what it counts.
  queueOverflowDropped: number;
}

export type Attribution = "parse" | "queue" | "book-update" | "publish";

// Canonical shape both a loaded historical summary.json's tail_events and
// client-side live tail detection produce, so TailEventsFeed/StageBreakdown
// don't need to know which source they're rendering.
// The four stages tile t_recv -> t_publish exactly: every nanosecond of a
// sample's latencyNs belongs to exactly one of them. Keep it that way — a
// stage set that does not sum to the total makes the breakdown unreadable
// against the chart above it.
export interface StageNs {
  parse: number;
  queue: number;
  bookUpdate: number;
  publish: number;
}

export interface TailEvent {
  // Unique per tick, not per frame: a frame carrying many ticks produces
  // many samples sharing tRecvTsc, so batchIndex has to be part of this or
  // several tail events collide on one key.
  key: string;
  tRecvTsc: number;
  batchIndex: number;
  // Ticks of one frame share tRecvTsc exactly (see the key comment above)
  // and, when the whole frame was delayed by the same upstream stall, can
  // also land on a near-identical latencyNs — close enough that both round
  // to the same displayed value. Two such siblings then render as two
  // textually-identical rows in TailEventsFeed, which reads as a duplicate
  // bug even though they're genuinely distinct ticks. batchSize lets the
  // feed show which batch position each one is, so that case reads as
  // "two siblings from the same burst" instead of looking like the same
  // thing shown twice.
  batchSize: number;
  latencyNs: number;
  attribution: Attribution;
  stageNs: StageNs;
}

// Identity of a single tick. Used wherever a sample has to be matched back
// to its tail event — tRecvTsc alone is ambiguous within a frame.
export function sampleKey(tRecvTsc: number, batchIndex: number): string {
  return `live-${tRecvTsc}-${batchIndex}`;
}

export interface LatencyBucketSnapshot {
    timestampMs: number;
    total: HistogramSnapshot;
    parse: HistogramSnapshot;
    queue: HistogramSnapshot;
    bookUpdate: HistogramSnapshot;
    publish: HistogramSnapshot;
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
  percentiles_ns: { 
    count: number; 
    p50_ns: number; 
    p99_ns: number; 
    p999_ns: number; 
    max_ns: number;
  };
  stage_medians_ns: {
    parse: number;
    queue: number;
    book_update: number;
    publish: number;
  };
  tail_events: {
    index: number;
    t_recv_tsc: number;
    latency_ns: number;
    attribution: Attribution;
    stage_ns: {
      parse: number;
      queue: number;
      book_update: number;
      publish: number;
    }
  };
  latency_buckets: LatencyBucketSnapshot[];
}
