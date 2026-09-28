import type { IngestRecord } from "./types.js";

// Abstract upstream feed. Broadcaster and RollingStatsAggregator depend only
// on this — not on BybitIngestClient or WebSockets — so a different source
// (a replay-from-file source for tests, a different exchange's gateway, a
// second redundant gateway instance) can be substituted without touching
// either consumer.
export interface DataSourceEvents {
  record: (record: IngestRecord) => void;
  connected: (info: { cpuGhz: number; capturedAt?: number; isReplay?: boolean; symbol?: string }) => void;
  disconnected: () => void;
}

export interface DataSource {
  isConnected(): boolean;
  /** Calibrated TSC frequency from the current (or most recent) connection's
   * hello handshake — see HelloMessage in types.ts. */
  cpuGhz(): number;
  /** Original capture start (epoch ms) and replay flag from the current (or
   * most recent) connection's hello — undefined/false for a real live
   * gateway, set by replay-gateway.mjs. See HelloMessage in types.ts. */
  capturedAt(): number | undefined;
  isReplay(): boolean;
  /** Instrument this connection is carrying (Hyperliquid coin name), from
   * the current (or most recent) hello — undefined for a session predating
   * this field. See HelloMessage.symbol in types.ts. */
  symbol(): string | undefined;
  on<K extends keyof DataSourceEvents>(event: K, listener: DataSourceEvents[K]): void;
  off<K extends keyof DataSourceEvents>(event: K, listener: DataSourceEvents[K]): void;
}
