"use client";

import { useMemo, useState } from "react";
import type { LiveSample } from "@/lib/types";
import { computeLiveTailEvents } from "@/lib/tailAttribution";
import { useChartTheme } from "@/lib/chartTheme";
import { LatencyChart, type LatencyPoint } from "./LatencyChart";
import { StageLatencyChart, type StagePoint } from "./StageLatencyChart";
import { TailEventsFeed } from "./TailEventsFeed";
import { StageBreakdown } from "./StageBreakdown";

interface LatencyPanelProps {
  recentSamples: LiveSample[];
  cpuGhz: number; // for LatencyChart's elapsed-time x-axis
}

// Live only — this used to also support loading a Phase 5 summary.json for
// historical review, with a Live/Historical mode toggle. Removed: a
// historical snapshot loaded from a file is exactly the kind of "sample
// data" that can mask a real live-only latency bug (the whole point of
// this panel), and the toggle threaded a second code path through every
// piece of state below for a feature that worked against that goal.
// Always subscribes to the same rolling sample buffer useRelayConnection
// maintains — see git history if historical loading is ever needed again.
export function LatencyPanel({ recentSamples, cpuGhz }: LatencyPanelProps) {
  const chartTheme = useChartTheme();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const live = useMemo(() => computeLiveTailEvents(recentSamples), [recentSamples]);
  const tailEvents = live.tailEvents;
  const refLines = { p50: live.p50Ns, p99: live.p99Ns, p999: live.p999Ns };

  const points: LatencyPoint[] = recentSamples.map((s) => ({
    x: s.tRecvTsc,
    latencyNs: s.latencyNs,
    attribution: tailEvents.find((e) => e.tRecvTsc === s.tRecvTsc)?.attribution ?? "normal",
  }));

  const selectedEvent = tailEvents.find((e) => e.key === selectedKey) ?? null;

  const parsePoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.parseNs }));
  const bookUpdatePoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.bookUpdateNs }));
  const publishPoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.publishNs }));
  const jitterPoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.hostJitterNs }));

  return (
    <div className="flex h-full flex-col text-xs">
      {/* Phase 8.5's fourth pass: replaced the single combined scatter with
          an overview chart plus one small chart per pipeline stage, instead
          of overlaying everything on one shared axis. This is naturally
          taller than one chart, so the whole cluster scrolls as a unit
          rather than trying to compress five charts, the tail feed, and the
          drill-down into a fixed height. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <LatencyChart
          title="Total latency"
          description="End-to-end latency (receipt to publish) for every live sample this session, colored by whichever stage — or host jitter — is the dominant cause when a sample crosses the tail (p99.9) threshold."
          points={points}
          refLines={refLines}
          cpuGhz={cpuGhz}
        />

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <StageLatencyChart
            title="Parse stage"
            description="Time to parse the raw exchange message into a normalized tick."
            color={chartTheme.parse}
            points={parsePoints}
            cpuGhz={cpuGhz}
          />
          <StageLatencyChart
            title="Book-update stage"
            description="Time to apply the parsed tick to the in-memory order book."
            color={chartTheme.bookUpdate}
            points={bookUpdatePoints}
            cpuGhz={cpuGhz}
          />
          <StageLatencyChart
            title="Publish stage"
            description="Time to publish the updated tick downstream, after the book update."
            color={chartTheme.bid}
            points={publishPoints}
            cpuGhz={cpuGhz}
          />
          <StageLatencyChart
            title="Host jitter"
            description="OS scheduling noise measured by a dedicated canary thread — not part of the pipeline's own work, but it can still delay a sample."
            color={chartTheme.jitter}
            points={jitterPoints}
            cpuGhz={cpuGhz}
          />
        </div>

        <div className="max-h-[220px] min-h-[72px] flex-none overflow-y-auto rounded-lg border border-border shadow-sm">
          <TailEventsFeed
            tailEvents={tailEvents}
            selectedKey={selectedKey}
            cpuGhz={cpuGhz}
            onSelect={(e) => setSelectedKey((prev) => (prev === e.key ? null : e.key))}
          />
        </div>
        <div className="flex-none rounded-lg border border-border shadow-sm">
          <StageBreakdown event={selectedEvent} stageMedians={live.stageMedians} />
        </div>
      </div>
    </div>
  );
}
