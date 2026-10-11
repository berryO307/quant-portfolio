"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { FeedMode } from "@/components/LiveReplayToggle";

/*
 * Mirrors lib/sidebarState.tsx's own pattern exactly, for the same reason:
 * Sidebar is rendered once in the root layout, shared across every route
 * (including /architecture, which has no live connection at all), while
 * the actual feed data (mode, isReplay, capturedAt) lives in Dashboard's
 * own useRelayConnection state, which only exists on /orderbook. Dashboard
 * WRITES its current feed info here (via an effect, since render-time
 * writes to another component's state aren't allowed); Sidebar READS it
 * to render the Live/Replay toggle near the collapse arrow. `feed` is
 * null whenever no Dashboard is mounted (any other route, or before the
 * first render), which is what tells Sidebar to render nothing here
 * rather than a stale or meaningless toggle.
 */

export interface FeedModeInfo {
  mode: FeedMode;
  onModeChange: (mode: FeedMode) => void;
  isReplay: boolean;
  capturedAt: number | undefined;
  connectionHealthy: boolean;
}

interface FeedModeState {
  feed: FeedModeInfo | null;
  setFeed: (feed: FeedModeInfo | null) => void;
}

const FeedModeStateContext = createContext<FeedModeState | null>(null);

export function FeedModeStateProvider({ children }: { children: ReactNode }) {
  const [feed, setFeed] = useState<FeedModeInfo | null>(null);
  return <FeedModeStateContext.Provider value={{ feed, setFeed }}>{children}</FeedModeStateContext.Provider>;
}

export function useFeedModeState(): FeedModeState {
  const ctx = useContext(FeedModeStateContext);
  if (!ctx) {
    throw new Error("useFeedModeState must be used within FeedModeStateProvider");
  }
  return ctx;
}
