"use client";

import { useState } from "react";
import type { AttributionSplit, HistogramSnapshot } from "@/lib/types";
import { formatNs } from "@/lib/format";
import { COLOR_JITTER, COLOR_MUTED, COLOR_PARSE, COLOR_SEVERE } from "@/lib/theme";

type StatsWindow = "session" | "rolling12h";

interface SessionStatsHeaderProps {
  currentSession: HistogramSnapshot | null;
  currentSessionSplit: AttributionSplit;
  rolling12h: HistogramSnapshot | null;
  rolling12hSplit: AttributionSplit;
}

const WINDOW_LABEL: Record<StatsWindow, string> = {
  session: "Current session",
  rolling12h: "Last 12 hours",
};

const WINDOW_DESCRIPTION: Record<StatsWindow, string> = {
  session: "since the gateway last (re)connected",
  rolling12h: "rolling window, survives gateway restarts",
};

// Phase 8.5's third pass: this used to be two full panels, side by side,
// each repeating the same five stat labels — real information (two
// genuinely different windows) buried in a lot of repeated chrome. One
// compact row plus a toggle says the same thing with about half the
// permanent screen real estate; a hover tooltip on each stat (native
// title attribute — no need for anything heavier here) carries the
// "which window is this" context that used to come from the row it sat in.
export function SessionStatsHeader({
  currentSession,
  currentSessionSplit,
  rolling12h,
  rolling12hSplit,
}: SessionStatsHeaderProps) {
  const [activeWindow, setActiveWindow] = useState<StatsWindow>("session");
  const snapshot = activeWindow === "session" ? currentSession : rolling12h;
  const split = activeWindow === "session" ? currentSessionSplit : rolling12hSplit;
  const windowSuffix = WINDOW_DESCRIPTION[activeWindow];

  const count = snapshot?.count ?? 0;
  const jitterPct = split.tailCount > 0 ? (split.jitterTailCount / split.tailCount) * 100 : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-foreground">{WINDOW_LABEL[activeWindow]}</span>
        <WindowToggle active={activeWindow} onChange={setActiveWindow} />
      </div>

      <div className="grid grid-cols-5 gap-x-2">
        <Stat
          label="p50"
          value={snapshot ? formatNs(snapshot.p50Ns) : "--"}
          title={`50th percentile (median) latency — ${windowSuffix}`}
        />
        <Stat
          label="p99"
          value={snapshot ? formatNs(snapshot.p99Ns) : "--"}
          color={COLOR_JITTER}
          title={`99th percentile latency — ${windowSuffix}`}
        />
        <Stat
          label="p99.9"
          value={snapshot ? formatNs(snapshot.p999Ns) : "--"}
          color={COLOR_SEVERE}
          title={`99.9th percentile latency (tail threshold) — ${windowSuffix}`}
        />
        <Stat
          label="max"
          value={snapshot ? formatNs(snapshot.maxNs) : "--"}
          color={COLOR_SEVERE}
          title={`Maximum observed latency — ${windowSuffix}`}
        />
        <Stat label="n" value={count.toLocaleString()} title={`Sample count — ${windowSuffix}`} />
      </div>

      <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground" title={`Tail-event attribution split — ${windowSuffix}`}>
        <span>Tail attribution:</span>
        {split.tailCount === 0 ? (
          <span>no tail events</span>
        ) : (
          <>
            <div className="flex h-2 w-20 flex-none overflow-hidden rounded-sm bg-border">
              <div className="h-full" style={{ width: `${jitterPct}%`, backgroundColor: COLOR_MUTED }} title="host jitter" />
              <div
                className="h-full"
                style={{ width: `${100 - jitterPct}%`, backgroundColor: COLOR_PARSE }}
                title="pipeline stages"
              />
            </div>
            <span>
              {split.jitterTailCount} jitter / {split.pipelineTailCount} pipeline
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function WindowToggle({ active, onChange }: { active: StatsWindow; onChange: (w: StatsWindow) => void }) {
  return (
    <div className="flex overflow-hidden rounded border border-border text-[10px]">
      <button
        type="button"
        title="Show current-session stats"
        onClick={() => onChange("session")}
        className={`px-1.5 py-0.5 ${active === "session" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
      >
        Session
      </button>
      <button
        type="button"
        title="Show trailing 12-hour rolling stats"
        onClick={() => onChange("rolling12h")}
        className={`px-1.5 py-0.5 ${active === "rolling12h" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
      >
        12h
      </button>
    </div>
  );
}

function Stat({ label, value, color, title }: { label: string; value: string; color?: string; title: string }) {
  return (
    <div className="flex flex-none flex-col items-end" title={title}>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}
