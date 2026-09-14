import type { TailEvent } from "@/lib/types";
// host_jitter is deliberately muted/grey here (the _MUTED_JITTER variant) —
// not "our" pipeline's fault, so it reads as less actionable than a colored
// stage attribution. Each pipeline stage gets its own color instead,
// matching LatencyChart/the Phase 5 Altair palette, so an operator can
// visually scan for "is this tail event even worth investigating in our own
// code".
import { ATTRIBUTION_COLORS_MUTED_JITTER, ATTRIBUTION_LABEL, COLOR_SEVERE } from "@/lib/theme";
import { formatNs } from "@/lib/format";

// A dedicated formatter, not lib/format.ts's formatElapsedAdaptive — that
// one picks its unit from tick SPACING (built for axis labels, where
// "step" is the gap between adjacent ticks), not from the value itself.
// Feeding it a step scaled to a single value's own magnitude breaks the
// unit choice (e.g. 1.5s came out as "1500ms" instead of "1.50s") rather
// than fixing precision. This picks the unit from the value directly, the
// correct approach for a per-row "how long ago" display.
function formatElapsedSince(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 1e-3) return `${(seconds * 1e6).toFixed(0)}µs`;
  if (abs < 1) return `${(seconds * 1e3).toFixed(0)}ms`;
  if (abs < 60) return `${seconds.toFixed(2)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

interface TailEventsFeedProps {
  tailEvents: TailEvent[]; // newest first
  selectedKey: string | null;
  cpuGhz: number; // to convert tRecvTsc into a readable elapsed-time column
  onSelect: (event: TailEvent) => void;
}

export function TailEventsFeed({ tailEvents, selectedKey, cpuGhz, onSelect }: TailEventsFeedProps) {
  if (tailEvents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No tail events yet
      </div>
    );
  }

  // tRecvTsc is a raw per-session TSC cycle count with no fixed relationship
  // to wall-clock time (same reasoning as LatencyChart's x-axis — see
  // lib/types.ts's LiveSample comment) — showing it directly was reported
  // as "a number of no use". t0 anchors to the OLDEST tail event still in
  // this list (tailEvents is newest-first, so that's the last element), so
  // each row instead reads "how long after the oldest tail event shown did
  // this one happen" — the same adaptive unit/precision LatencyChart's own
  // axis uses, just applied per-row instead of as axis ticks.
  const t0 = tailEvents[tailEvents.length - 1]!.tRecvTsc;
  const tscToElapsedSeconds = (tsc: number) => (cpuGhz > 0 ? (tsc - t0) / (cpuGhz * 1e9) : 0);

  return (
    <div className="flex h-full flex-col overflow-y-auto text-xs">
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-border px-3 py-1 text-[10px] text-muted-foreground">
        <span>Time (since oldest shown)</span>
        <span className="text-right">Latency</span>
        <span className="text-right">Attribution</span>
      </div>
      {tailEvents.map((event) => {
        const selected = event.key === selectedKey;
        const elapsed = tscToElapsedSeconds(event.tRecvTsc);
        return (
          <button
            key={event.key}
            type="button"
            onClick={() => onSelect(event)}
            className={`grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-[#0a1424] px-3 py-1 text-left hover:bg-accent ${
              selected ? "bg-accent" : ""
            }`}
          >
            <span className="truncate font-mono tabular-nums text-foreground">+{formatElapsedSince(elapsed)}</span>
            {/* COLOR_SEVERE, not ask-red — this value flags a notable
                latency outlier, unrelated to bid/ask semantics (Phase 8.5). */}
            <span className="text-right font-mono tabular-nums" style={{ color: COLOR_SEVERE }}>
              {formatNs(event.latencyNs)}
            </span>
            <span className="text-right" style={{ color: ATTRIBUTION_COLORS_MUTED_JITTER[event.attribution] }}>
              {ATTRIBUTION_LABEL[event.attribution]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
