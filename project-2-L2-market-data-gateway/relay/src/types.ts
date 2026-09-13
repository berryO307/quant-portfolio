// Record shapes mirror the NDJSON schema written by ColdPathExporter
// (see include/export_pipeline.hpp) exactly — field names match the C++
// gzprintf format strings so a payload can be parsed identically whether it
// came from a live gateway push or a replayed session file.

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

export type IngestRecord = SampleRecord | SnapshotRecord | TradeRecord;

// Handshake message expected once per ingest connection, before any
// SampleRecord — see BybitIngestClient. Not part of the C++ NDJSON export
// format (that's a file format with no need for a handshake); this is
// specific to the live push contract a future gateway-side client will
// speak. cpu_ghz is the calibrated TSC frequency (calibrate_tsc_ghz() in
// rdtsc.hpp) for this session — samples' t_recv/t_parse/t_book/t_publish
// are raw TSC values, not nanoseconds, and cannot be converted without it.
export interface HelloMessage {
  type: "hello";
  cpu_ghz: number;
}

export function isIngestRecord(value: unknown): value is IngestRecord {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const t = (value as { type: unknown }).type;
  return t === "sample" || t === "snapshot" || t === "trade";
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  return (value as { type: unknown }).type === "hello";
}
