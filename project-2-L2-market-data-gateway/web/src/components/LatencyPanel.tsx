"use client";

import { useMemo, useRef, useState } from "react";
import type { HistoricalSummary, LiveSample, TailEvent } from "@/lib/types";
import { computeLiveTailEvents, tailEventsFromHistorical } from "@/lib/tailAttribution";
import { useChartTheme } from "@/lib/chartTheme";
import { LatencyChart, type LatencyPoint } from "./LatencyChart";
import { StageLatencyChart, type StagePoint } from "./StageLatencyChart";
import { TailEventsFeed } from "./TailEventsFeed";
import { StageBreakdown } from "./StageBreakdown";

type Mode = "live" | "historical";

interface LatencyPanelProps {
  recentSamples: LiveSample[];
  cpuGhz: number; // for LatencyChart's elapsed-time x-axis (live mode)
}

function isHistoricalSummary(value: unknown): value is HistoricalSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return "percentiles_ns" in v && "tail_events" in v && Array.isArray(v.tail_events);
}

// Historical sessions load from a Phase 5 summary.json the user picks —
// there is no backend that serves these files (they're written to local
// disk by an offline script), and the web app otherwise only ever talks to
// the relay (see Phase 7), so a client-side file picker is the only piece
// of infrastructure this needs. Live mode subscribes to the same rolling
// sample buffer useRelayConnection already maintains.
export function LatencyPanel({ recentSamples, cpuGhz }: LatencyPanelProps) {
  const chartTheme = useChartTheme();
  const [mode, setMode] = useState<Mode>("live");
  const [historical, setHistorical] = useState<HistoricalSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const live = useMemo(() => computeLiveTailEvents(recentSamples), [recentSamples]);

  const handleFile = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isHistoricalSummary(parsed)) {
        throw new Error("doesn't look like a Phase 5 summary.json");
      }
      setHistorical(parsed);
      setMode("historical");
      setSelectedKey(null);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "failed to load file");
    }
  };

  const tailEvents: TailEvent[] =
    mode === "live" ? live.tailEvents : historical ? tailEventsFromHistorical(historical) : [];

  const refLines =
    mode === "live"
      ? { p50: live.p50Ns, p99: live.p99Ns, p999: live.p999Ns }
      : historical
        ? {
            p50: historical.percentiles_ns.p50_ns,
            p99: historical.percentiles_ns.p99_ns,
            p999: historical.percentiles_ns.p999_ns,
          }
        : { p50: 0, p99: 0, p999: 0 };

  const stageMedians =
    mode === "live"
      ? live.stageMedians
      : historical
        ? {
            parse: historical.stage_medians_ns.parse,
            bookUpdate: historical.stage_medians_ns.book_update,
            publish: historical.stage_medians_ns.publish,
          }
        : null;

  // Historical summary.json only ever stores tail events, not the full
  // sample population (kept "compact" by design — see Phase 5) — so the
  // historical scatter necessarily shows outliers only, not a dense cloud
  // like live mode's. Labeled below rather than left to look like a bug.
  const points: LatencyPoint[] =
    mode === "live"
      ? recentSamples.map((s) => ({
          x: s.tRecvTsc,
          latencyNs: s.latencyNs,
          attribution: tailEvents.find((e) => e.tRecvTsc === s.tRecvTsc)?.attribution ?? "normal",
        }))
      : tailEvents.map((e) => ({ x: e.tRecvTsc, latencyNs: e.latencyNs, attribution: e.attribution }));

  const chartCpuGhz = mode === "live" ? cpuGhz : (historical?.session.cpu_ghz_used ?? cpuGhz);

  const selectedEvent = tailEvents.find((e) => e.key === selectedKey) ?? null;

  // Per-stage mini charts (Phase 8.5's fourth pass) — only meaningful in
  // live mode: a loaded summary.json only carries stage_ns for its sparse
  // tail_events, not the full per-sample series these need to plot anything
  // resembling a real distribution.
  const parsePoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.parseNs }));
  const bookUpdatePoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.bookUpdateNs }));
  const publishPoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.publishNs }));
  const jitterPoints: StagePoint[] = recentSamples.map((s) => ({ x: s.tRecvTsc, valueNs: s.hostJitterNs }));

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
        <ModeToggle mode={mode} onChange={setMode} disabled={!historical} />
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-accent"
        >
          Load summary.json
        </button>
        {loadError && <span className="text-[#f85149]">{loadError}</span>}
        {mode === "historical" && (
          <span className="text-muted-foreground">
            Historical: tail events only, {historical?.session.n_samples.toLocaleString()} samples captured
          </span>
        )}
      </div>

      {/* Phase 8.5's fourth pass: replaced the single combined scatter with
          an overview chart plus one small chart per pipeline stage, instead
          of overlaying everything on one shared axis. This is naturally
          taller than one chart, so the whole cluster scrolls as a unit
          rather than trying to compress five charts, the tail feed, and the
          drill-down into a fixed height. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <LatencyChart
          title="Total latency"
          description={
            mode === "live"
              ? "End-to-end latency (receipt to publish) for every live sample this session, colored by whichever stage — or host jitter — is the dominant cause when a sample crosses the tail (p99.9) threshold."
              : `End-to-end latency from a loaded historical session (${historical?.session.path ?? "loaded file"}) — tail events only, since a summary.json doesn't retain the full sample population.`
          }
          points={points}
          refLines={refLines}
          cpuGhz={chartCpuGhz}
        />

        {mode === "live" && (
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
        )}

        <div className="max-h-[220px] min-h-[72px] flex-none overflow-y-auto rounded-md border border-border">
          <TailEventsFeed tailEvents={tailEvents} selectedKey={selectedKey} onSelect={(e) => setSelectedKey(e.key)} />
        </div>
        <div className="flex-none rounded-md border border-border">
          <StageBreakdown event={selectedEvent} stageMedians={stageMedians} />
        </div>
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={() => onChange("live")}
        className={`rounded px-2 py-0.5 ${mode === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
      >
        Live
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("historical")}
        className={`rounded px-2 py-0.5 disabled:opacity-40 ${
          mode === "historical" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
        }`}
      >
        Historical
      </button>
    </div>
  );
}
