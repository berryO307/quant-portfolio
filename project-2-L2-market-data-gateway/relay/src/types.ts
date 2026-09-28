// Record shapes mirror the NDJSON schema written by ColdPathExporter
// (see include/export_pipeline.hpp) exactly — field names match the C++
// gzprintf format strings so a payload can be parsed identically whether it
// came from a live gateway push or a replayed session file.

import type { HistogramSnapshot } from "./histogram.js";

export type Side = "bid" | "ask" | "both" | "none";

// The four t_* stamps are points on one timeline; a stage is the gap
// between two adjacent ones. t_pop is optional purely because session files
// captured before it existed replay through the same path — a live gateway
// always sends it. A consumer that falls back when it's absent gets the
// old, conflated stage: t_book - t_parse charges the book update for the
// queue wait ahead of it.
//
// Previously also carried t_parse_begin (a per-tick marginal parse cost
// within a batched frame), host_jitter_ns (ambient host scheduler noise
// from a dedicated canary thread) and queue_depth (SPSC queue size at pop)
// — removed as a deliberate project-scope decision, not because the wire
// format changed accidentally: this gateway measures its own hot-path work,
// not host scheduler behavior. See git history if any of the three is ever
// needed again.
export interface SampleRecord {
  type: "sample";
  // Optional for the same reason as t_pop/queue_overflow_dropped above -- a
  // pre-existing session file/relay predating this field still parses. Set
  // by replay-gateway.mjs (which knows its own --symbol flag) and by a
  // future live gateway push client. Two instruments never actually share
  // one relay/ingest connection (BybitIngestClient supersedes rather than
  // multiplexes -- see its promote() contract), so this can't fix a
  // same-connection collision that structurally can't happen; it exists so
  // a record is self-describing on the wire regardless, and so a future
  // consumer that DOES aggregate multiple relays' messages (e.g. a
  // dashboard combining several WS connections) has something to key on
  // instead of trusting whichever connection happened to deliver it.
  symbol?: string;
  t_recv: number;
  t_parse: number;
  t_pop?: number;
  t_book: number;
  t_publish: number;
  batch_index?: number;
  batch_size?: number;
  // Cumulative count, sampled alongside this tick (a running total, not a
  // per-tick delta). Optional for the same reason as the other new fields:
  // a pre-existing session file captured before this counter existed
  // replays through the same shape. Kept deliberately when
  // t_parse_begin/host_jitter_ns/queue_depth were removed — this is
  // data-completeness (did the order book miss a real tick), not latency.
  queue_overflow_dropped?: number;
  side: Side;
  cpu_core: number;
}

export interface SnapshotRecord {
  type: "snapshot";
  // See SampleRecord.symbol's comment -- same optionality/rationale, shared
  // verbatim across every record type rather than repeated per-type.
  symbol?: string;
  tsc: number;
  bids: [number, number][];
  asks: [number, number][];
}

// Same shape as SnapshotRecord, sourced from a second, wider-rounded l2Book
// subscription (Hyperliquid's own nSigFigs rounding, see nsigfigs below)
// instead of the primary book -- see Channel::CoarseDepth in
// include/market_data_source.hpp for why this exists: the primary
// subscription's finest rounding only ever spans a narrow real price range
// (~$20-30 on a ~$75,000 BTC), which left the web UI's widest price-bucket
// views (e.g. a $1000 bucket) with just 1-2 real levels to aggregate. A
// SINGLE coarse tier was not enough either -- bucketing a snapshot whose own
// native level spacing is already wider than the requested display bucket
// is a no-op, so $5/$10/$100 buckets rendered identically to $1000 once
// there was only one (nSigFigs=2) coarse source. The gateway now runs one
// of these per tier in coarse_book_state.hpp's COARSE_TIERS; nsigfigs is
// what tells them apart on the wire.
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
  // milliseconds), NOT a gateway-local timestamp -- see ExportTrade in
  // include/export_pipeline.hpp for why this was added. Optional so a
  // session file/relay session captured before the gateway exported it
  // still parses.
  event_time_ms?: number;
}

export type IngestRecord = SampleRecord | SnapshotRecord | TradeRecord | CoarseSnapshotRecord;

// Handshake message expected once per ingest connection, before any
// SampleRecord — see BybitIngestClient. Not part of the C++ NDJSON export
// format (that's a file format with no need for a handshake); this is
// specific to the live push contract a future gateway-side client will
// speak. cpu_ghz is the calibrated TSC frequency (calibrate_tsc_ghz() in
// rdtsc.hpp) for this session — samples' t_recv/t_parse/t_book/t_publish
// are raw TSC values, not nanoseconds, and cannot be converted without it.
// token is optional and only checked when the relay is started with
// INGEST_TOKEN set (see BybitIngestClient) — local/dev deployments with no
// token configured ignore this field entirely.
export interface HelloMessage {
  type: "hello";
  cpu_ghz: number;
  token?: string;
  // Set only by a replay-gateway.mjs connection (a real captured session
  // looped against /ingest, not a live gateway) -- epoch ms of the
  // ORIGINAL capture's start, taken directly from that session's own
  // "session_<epoch_ms>.ndjson.gz" filename, never "now" (a looping replay
  // reconnects/re-sends this same hello on every lap; "now" would silently
  // relabel a real historical capture as freshly live on every loop).
  capturedAt?: number;
  // Explicit, not inferred from the presence of capturedAt or anything
  // else -- a future real-live gateway reconnecting should never need
  // special-casing here just because it happens to share some other field.
  isReplay?: boolean;
  // Which instrument this connection is carrying (Hyperliquid coin name,
  // e.g. "BTC" or "xyz:CL") -- optional for the same back-compat reason as
  // capturedAt/isReplay (a session predating this field still connects).
  // Every deployment still runs one relay/ingest connection per instrument
  // (see BybitIngestClient's promote() contract -- a second upstream
  // supersedes the first rather than multiplexing alongside it), so this
  // can't actually resolve a same-connection collision; it's here so the
  // frontend and any future multi-relay aggregator have a ground truth for
  // "which instrument is this" instead of trusting whichever wsUrl happened
  // to be configured for a given port.
  symbol?: string;
}

export function isIngestRecord(value: unknown): value is IngestRecord {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const t = (value as { type: unknown }).type;
  return t === "sample" || t === "snapshot" || t === "trade" || t === "coarse_snapshot";
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  return (value as { type: unknown }).type === "hello";
}

export interface LatencyBucketSnapshot {
  timestampMs: number;
  total: HistogramSnapshot;
  parse: HistogramSnapshot;
  queue: HistogramSnapshot;
  bookUpdate: HistogramSnapshot;
  publish: HistogramSnapshot;
}

export interface StatsMessage {
  type: "stats";
  rollingWindow: HistogramSnapshot;
  currentSession: HistogramSnapshot;
  latencyBuckets: LatencyBucketSnapshot[];
}