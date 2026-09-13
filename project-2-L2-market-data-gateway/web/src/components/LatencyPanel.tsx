"use client";

import { useMemo, useRef, useState } from "react";
import type { HistoricalSummary, LiveSample, TailEvent } from "@/lib/types";
import { computeLiveTailEvents, tailEventsFromHistorical } from "@/lib/tailAttribution";
import { LatencyChart, type LatencyPoint } from "./LatencyChart";
import { TailEventsFeed } from "./TailEventsFeed";
import { StageBreakdown } from "./StageBreakdown";

type Mode = "live" | "historical";

interface LatencyPanelProps {
  recentSamples: LiveSample[];
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
export function LatencyPanel({ recentSamples }: LatencyPanelProps) {
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

  const selectedEvent = tailEvents.find((e) => e.key === selectedKey) ?? null;

  return (
    <div className="flex h-full flex-col font-mono text-xs">
      <div className="flex items-center gap-3 border-b border-[#30363d] px-3 py-1.5">
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
          className="rounded border border-[#30363d] px-2 py-0.5 text-[#c9d1d9] hover:bg-[#161b22]"
        >
          load summary.json
        </button>
        {loadError && <span className="text-[#f85149]">{loadError}</span>}
        {mode === "historical" && (
          <span className="text-[#8b949e]">
            historical: tail events only, {historical?.session.n_samples.toLocaleString()} samples captured
          </span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[2fr_1fr] divide-x divide-[#30363d] overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="p-2">
            <LatencyChart points={points} refLines={refLines} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden border-t border-[#30363d]">
            <TailEventsFeed tailEvents={tailEvents} selectedKey={selectedKey} onSelect={(e) => setSelectedKey(e.key)} />
          </div>
        </div>
        <StageBreakdown event={selectedEvent} stageMedians={stageMedians} />
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
        className={`rounded px-2 py-0.5 ${mode === "live" ? "bg-[#238636] text-white" : "text-[#8b949e] hover:bg-[#161b22]"}`}
      >
        live
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("historical")}
        className={`rounded px-2 py-0.5 disabled:opacity-40 ${
          mode === "historical" ? "bg-[#238636] text-white" : "text-[#8b949e] hover:bg-[#161b22]"
        }`}
      >
        historical
      </button>
    </div>
  );
}
