"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isRelayMessage, type SnapshotRecord, type StatsMessage, type TimedTrade } from "./types";

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

export interface RelayState {
  wsConnected: boolean;
  healthOk: boolean;
  latestSnapshot: SnapshotRecord | null;
  trades: TimedTrade[]; // newest first, capped at MAX_TRADES
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
  const [latestSnapshot, setLatestSnapshot] = useState<SnapshotRecord | null>(null);
  const [trades, setTrades] = useState<TimedTrade[]>([]);
  const [stats, setStats] = useState<StatsMessage | null>(null);

  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        case "snapshot":
          setLatestSnapshot(parsed);
          break;
        case "trade":
          setTrades((prev) => [{ ...parsed, receivedAtMs: Date.now() }, ...prev].slice(0, MAX_TRADES));
          break;
        case "stats":
          setStats(parsed);
          break;
        case "sample":
          break; // not rendered in this scaffold — stats messages already summarize these
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

  return { wsConnected, healthOk, latestSnapshot, trades, stats };
}
