import type { Attribution, TailEvent } from "@/lib/types";

// host_jitter is deliberately muted/grey here — not "our" pipeline's fault,
// so it reads as less actionable than a colored stage attribution. Each
// pipeline stage gets its own color instead, matching LatencyChart/the
// Phase 5 Altair palette, so an operator can visually scan for "is this
// tail event even worth investigating in our own code".
const ATTRIBUTION_STYLE: Record<Attribution, { color: string; label: string }> = {
  host_jitter: { color: "#8b949e", label: "host jitter" },
  parse: { color: "#58a6ff", label: "parse" },
  "book-update": { color: "#bc8cff", label: "book-update" },
  publish: { color: "#3fb950", label: "publish" },
};

function formatNs(ns: number): string {
  return ns >= 1000 ? `${(ns / 1000).toFixed(1)}us` : `${ns.toFixed(0)}ns`;
}

interface TailEventsFeedProps {
  tailEvents: TailEvent[]; // newest first
  selectedKey: string | null;
  onSelect: (event: TailEvent) => void;
}

export function TailEventsFeed({ tailEvents, selectedKey, onSelect }: TailEventsFeedProps) {
  if (tailEvents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-[#8b949e]">
        no tail events yet
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto font-mono text-xs">
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-[#30363d] px-3 py-1 text-[10px] uppercase tracking-wide text-[#8b949e]">
        <span>Timestamp (TSC)</span>
        <span className="text-right">Latency</span>
        <span className="text-right">Attribution</span>
      </div>
      {tailEvents.map((event) => {
        const style = ATTRIBUTION_STYLE[event.attribution];
        const selected = event.key === selectedKey;
        return (
          <button
            key={event.key}
            type="button"
            onClick={() => onSelect(event)}
            className={`grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-[#161b22] px-3 py-1 text-left hover:bg-[#161b22] ${
              selected ? "bg-[#161b22]" : ""
            }`}
          >
            <span className="truncate text-[#c9d1d9]">{event.tRecvTsc}</span>
            <span className="text-right text-[#f85149]">{formatNs(event.latencyNs)}</span>
            <span className="text-right" style={{ color: style.color }}>
              {style.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
