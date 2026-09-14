import type { TailEvent } from "@/lib/types";
// host_jitter is deliberately muted/grey here (the _MUTED_JITTER variant) —
// not "our" pipeline's fault, so it reads as less actionable than a colored
// stage attribution. Each pipeline stage gets its own color instead,
// matching LatencyChart/the Phase 5 Altair palette, so an operator can
// visually scan for "is this tail event even worth investigating in our own
// code".
import { ATTRIBUTION_COLORS_MUTED_JITTER, ATTRIBUTION_LABEL, COLOR_SEVERE } from "@/lib/theme";
import { formatNs } from "@/lib/format";

interface TailEventsFeedProps {
  tailEvents: TailEvent[]; // newest first
  selectedKey: string | null;
  onSelect: (event: TailEvent) => void;
}

export function TailEventsFeed({ tailEvents, selectedKey, onSelect }: TailEventsFeedProps) {
  if (tailEvents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No tail events yet
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-xs">
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-border px-3 py-1 text-[10px] text-muted-foreground">
        <span>Timestamp (TSC)</span>
        <span className="text-right">Latency</span>
        <span className="text-right">Attribution</span>
      </div>
      {tailEvents.map((event) => {
        const selected = event.key === selectedKey;
        return (
          <button
            key={event.key}
            type="button"
            onClick={() => onSelect(event)}
            className={`grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-[#0a1424] px-3 py-1 text-left hover:bg-accent ${
              selected ? "bg-accent" : ""
            }`}
          >
            <span className="truncate font-mono tabular-nums text-foreground">{event.tRecvTsc}</span>
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
