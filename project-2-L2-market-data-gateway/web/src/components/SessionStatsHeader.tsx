import type { AttributionSplit, HistogramSnapshot } from "@/lib/types";
import { formatNs } from "@/lib/format";
import { COLOR_ASK, COLOR_JITTER, COLOR_MUTED, COLOR_PARSE, COLOR_TEXT } from "@/lib/theme";

interface SessionStatsHeaderProps {
  currentSession: HistogramSnapshot | null;
  currentSessionSplit: AttributionSplit;
  rolling12h: HistogramSnapshot | null;
  rolling12hSplit: AttributionSplit;
}

// Two visually distinct panels, never blended into one number — a
// background tint + divider + explicit labels ("this run" vs "trailing
// 12h") so it's never ambiguous which window a percentile belongs to.
// currentSessionSplit is computed client-side (see
// lib/tailAttribution.ts's attributionSplit(), fed by the same rolling
// sample buffer LatencyPanel uses); rolling12hSplit comes from the relay's
// RollingStatsAggregator, which uses an IQR-based threshold approximation
// instead of the exact median+5*MAD used everywhere else, since it only
// retains bucketed histogram counts, not raw samples (see that file's
// module comment for why).
export function SessionStatsHeader({
  currentSession,
  currentSessionSplit,
  rolling12h,
  rolling12hSplit,
}: SessionStatsHeaderProps) {
  return (
    <div className="grid grid-cols-2 divide-x divide-[#30363d] border-b border-[#30363d] font-mono text-xs">
      <StatsPanel
        title="Current session"
        subtitle="since the gateway last (re)connected"
        snapshot={currentSession}
        split={currentSessionSplit}
        tint="bg-[#0d1117]"
      />
      <StatsPanel
        title="Last 12 hours"
        subtitle="rolling window, survives gateway restarts"
        snapshot={rolling12h}
        split={rolling12hSplit}
        tint="bg-[#0f1420]"
      />
    </div>
  );
}

function StatsPanel({
  title,
  subtitle,
  snapshot,
  split,
  tint,
}: {
  title: string;
  subtitle: string;
  snapshot: HistogramSnapshot | null;
  split: AttributionSplit;
  tint: string;
}) {
  const count = snapshot?.count ?? 0;
  const jitterPct = split.tailCount > 0 ? (split.jitterTailCount / split.tailCount) * 100 : 0;

  return (
    <div className={`flex items-center gap-4 px-3 py-2 ${tint}`}>
      <div>
        <div className="text-[#c9d1d9]">{title}</div>
        <div className="text-[10px] text-[#8b949e]">{subtitle}</div>
      </div>
      <Stat label="p50" value={snapshot ? formatNs(snapshot.p50Ns) : "--"} />
      <Stat label="p99" value={snapshot ? formatNs(snapshot.p99Ns) : "--"} />
      <Stat label="p99.9" value={snapshot ? formatNs(snapshot.p999Ns) : "--"} color={COLOR_JITTER} />
      <Stat label="max" value={snapshot ? formatNs(snapshot.maxNs) : "--"} color={COLOR_ASK} />
      <Stat label="n" value={count.toLocaleString()} />
      <div className="ml-auto flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[#8b949e]">tail attribution</span>
        {split.tailCount === 0 ? (
          <span className="text-[#8b949e]">no tail events</span>
        ) : (
          <>
            <div className="flex h-2 w-24 overflow-hidden rounded-sm bg-[#30363d]">
              <div className="h-full" style={{ width: `${jitterPct}%`, backgroundColor: COLOR_MUTED }} title="host jitter" />
              <div
                className="h-full"
                style={{ width: `${100 - jitterPct}%`, backgroundColor: COLOR_PARSE }}
                title="pipeline stages"
              />
            </div>
            <span className="text-[#8b949e]">
              {split.jitterTailCount} jitter / {split.pipelineTailCount} pipeline
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color = COLOR_TEXT }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] uppercase tracking-wide text-[#8b949e]">{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}
