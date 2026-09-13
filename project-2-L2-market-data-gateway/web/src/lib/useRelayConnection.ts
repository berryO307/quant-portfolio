"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isRelayMessage, type LiveSample, type SnapshotRecord, type StatsMessage, type TimedTrade } from "./types";

// Same reconnect backoff used everywhere else in this project (ws_client.hpp
// for the gateway's Bybit feed, and the documented contract for a future
// gateway->relay push client in relay/src/bybitIngestClient.ts): 1s base,
// x2 multiplier, 30s cap. Kept identical here for consistency, not because
// the browser has the same constraints as the C++ side.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MULT = 2;

const HEALTH_POLL_MS = 5_000;
const MAX_TRADES = 200;

// Matches the default used everywhere else this gap shows up (reader.py,
// export_summary.py, relay/src/bybitIngestClient.ts) — used only until a
// real hello handshake arrives (see relay/src/index.ts).
const DEFAULT_CPU_GHZ = 3.2;

// Bounded rolling buffer for the live latency chart + client-side tail
// detection (lib/tailAttribution.ts). Not meant to be a full session
// history — that's what a loaded Phase 5 summary.json is for.
const MAX_LIVE_SAMPLES = 2_000;

// Samples can arrive at thousands/sec; committing a new 2000-element array
// to React state on every single one would mean that many re-renders and
// array copies per second. Instead, incoming samples land in a plain ref
// array (O(1) push, no re-render) and get flushed into state in one batch
// on this interval — same "don't update UI faster than a human can see it"
// idea as the Phase 3 terminal progress view's ~1s cadence, just faster
// since this feeds a chart instead of text.
const SAMPLE_FLUSH_INTERVAL_MS = 250;

export interface RelayState {
  wsConnected: boolean;
  healthOk: boolean;
  cpuGhz: number;
  latestSnapshot: SnapshotRecord | null;
  trades: TimedTrade[]; // newest first, capped at MAX_TRADES
  recentSamples: LiveSample[]; // chronological (oldest first), capped at MAX_LIVE_SAMPLES
  stats: StatsMessage | null;
}

// FeedStatusBanner reads wsConnected && healthOk together (see its own
// comment) — this hook exposes both independently rather than pre-combining
// them, since they're detecting different failure modes: wsConnected false
// means "can't reach the relay at all"; healthOk false (while wsConnected is
// true) means "relay is up but has no live upstream gateway data".
export function useRelayConnection(wsUrl: string, healthUrl: string): RelayState {
  const [wsConnected, setWsConnected] = useState(false);
  const [healthOk, setHealthOk] = useState(false);
  const [cpuGhz, setCpuGhz] = useState(DEFAULT_CPU_GHZ);
  const [latestSnapshot, setLatestSnapshot] = useState<SnapshotRecord | null>(null);
  const [trades, setTrades] = useState<TimedTrade[]>([]);
  const [recentSamples, setRecentSamples] = useState<LiveSample[]>([]);
  const [stats, setStats] = useState<StatsMessage | null>(null);

  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the onmessage closure so a sample can be converted to ns
  // using whatever cpu_ghz is current, without recreating the closure every
  // time a hello message updates it.
  const cpuGhzRef = useRef(DEFAULT_CPU_GHZ);
  const pendingSamplesRef = useRef<LiveSample[]>([]);
  // Indirection so scheduleReconnect can call "the current connect" without
  // referencing the connect binding from inside its own initializer (which
  // both violates the TDZ and would go stale across re-renders anyway).
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    // Every handler below checks "is this still the current connection"
    // before acting, rather than a shared mounted/cancelled boolean. That
    // matters under React StrictMode's dev-mode double-invoke (mount ->
    // effect -> cleanup -> effect again): a boolean flips back to "mounted"
    // on the second invoke while the FIRST socket's close event is still in
    // flight, which would otherwise let a stale connection's reconnect
    // timer race the real one. Identity against wsRef.current — nulled out
    // in the effect's cleanup below — has no such window. Same "supersede,
    // don't coexist" pattern as BybitIngestClient uses server-side.
    const isCurrent = () => wsRef.current === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      setWsConnected(true);
      reconnectDelayRef.current = RECONNECT_BASE_MS; // reset backoff on a successful connect
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // malformed message — drop it, don't tear down the connection over one bad frame
      }
      if (!isRelayMessage(parsed)) return;

      switch (parsed.type) {
        case "hello":
          cpuGhzRef.current = parsed.cpu_ghz;
          setCpuGhz(parsed.cpu_ghz);
          break;
        case "snapshot":
          setLatestSnapshot(parsed);
          break;
        case "trade":
          setTrades((prev) => [{ ...parsed, receivedAtMs: Date.now() }, ...prev].slice(0, MAX_TRADES));
          break;
        case "stats":
          setStats(parsed);
          break;
        case "sample": {
          const ghz = cpuGhzRef.current;
          pendingSamplesRef.current.push({
            tRecvTsc: parsed.t_recv,
            latencyNs: (parsed.t_publish - parsed.t_recv) / ghz,
            parseNs: (parsed.t_parse - parsed.t_recv) / ghz,
            bookUpdateNs: (parsed.t_book - parsed.t_parse) / ghz,
            publishNs: (parsed.t_publish - parsed.t_book) / ghz,
            hostJitterNs: parsed.host_jitter_ns,
          });
          break;
        }
      }
    };

    const scheduleReconnect = () => {
      if (!isCurrent()) return; // this socket was intentionally superseded/closed — not a real drop
      setWsConnected(false);
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * RECONNECT_MULT, RECONNECT_MAX_MS);
      timerRef.current = setTimeout(() => connectRef.current(), delay);
    };

    ws.onclose = scheduleReconnect;
    ws.onerror = () => ws.close(); // close() triggers onclose -> scheduleReconnect; avoid double-scheduling
  }, [wsUrl]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null; // makes any in-flight handler for the old socket see itself as superseded
    };
  }, [connect]);

  useEffect(() => {
    const flush = setInterval(() => {
      if (pendingSamplesRef.current.length === 0) return;
      const incoming = pendingSamplesRef.current;
      pendingSamplesRef.current = [];
      setRecentSamples((prev) => {
        const combined = prev.length > 0 ? prev.concat(incoming) : incoming;
        return combined.length > MAX_LIVE_SAMPLES
          ? combined.slice(combined.length - MAX_LIVE_SAMPLES)
          : combined;
      });
    }, SAMPLE_FLUSH_INTERVAL_MS);
    return () => clearInterval(flush);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(healthUrl, { cache: "no-store" });
        const data = (await res.json()) as { upstreamGatewayConnected?: boolean };
        if (!cancelled) setHealthOk(res.ok && data.upstreamGatewayConnected === true);
      } catch {
        if (!cancelled) setHealthOk(false);
      }
    };

    poll();
    const interval = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [healthUrl]);

  return { wsConnected, healthOk, cpuGhz, latestSnapshot, trades, recentSamples, stats };
}
