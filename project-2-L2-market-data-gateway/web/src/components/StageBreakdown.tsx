import type { TailEvent } from "@/lib/types";
import { COLOR_JITTER, COLOR_SEVERE, STAGE_COLOR, STAGE_LABEL } from "@/lib/theme";
import { formatNs } from "@/lib/format";

interface StageBreakdownProps {
  event: TailEvent | null;
  stageMedians: { parse: number; bookUpdate: number; publish: number } | null;
}

// Two very different views depending on attribution: a stage-attributed
// event gets a stacked/grouped bar of its own stage durations against the
// session median (the outlier stage highlighted); a host_jitter-attributed
// event isn't about our pipeline's stages at all, so it shows the canary
// delta instead — showing stage bars for that case would just be misleading
// (the "outlier" stage there is an artifact, not the actual cause).
export function StageBreakdown({ event, stageMedians }: StageBreakdownProps) {
  if (!event) {
    // Compact, single line — this used to reserve a full column (and later
    // a full-height strip) for three lines of centered placeholder text
    // even when empty. Phase 8.5's second pass: don't spend vertical budget
    // on an empty state.
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
        Select a tail event above to see its per-stage timing vs. the session median, or its host-jitter canary delta.
      </div>
    );
  }

  if (event.attribution === "host_jitter") {
    return <CanaryDeltaView event={event} />;
  }

  return <StageBarsView event={event} stageMedians={stageMedians} />;
}

function CanaryDeltaView({ event }: { event: TailEvent }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-xs">
      <div className="text-[10px] text-muted-foreground">Attributed to host jitter</div>
      <div className="text-2xl font-mono tabular-nums" style={{ color: COLOR_JITTER }}>
        {formatNs(event.hostJitterNs)}
      </div>
      <div className="text-muted-foreground">
        Canary delta at this sample — the pipeline&apos;s own stages were not the dominant cost (see JitterCanary in
        include/jitter_canary.hpp).
      </div>
    </div>
  );
}

function StageBarsView({
  event,
  stageMedians,
}: {
  event: TailEvent;
  stageMedians: { parse: number; bookUpdate: number; publish: number } | null;
}) {
  const stages: ("parse" | "bookUpdate" | "publish")[] = ["parse", "bookUpdate", "publish"];
  const values = stages.map((s) => event.stageNs[s]);
  const medianValues = stages.map((s) => stageMedians?.[s] ?? 0);
  const maxValue = Math.max(...values, ...medianValues, 1);

  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-xs">
      <div className="text-[10px] text-muted-foreground">Stage breakdown vs. session median</div>
      {stages.map((stage, i) => {
        const isOutlier = STAGE_LABEL[stage] === event.attribution;
        const color = STAGE_COLOR[stage];
        return (
          <div key={stage} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span style={{ color }} className={isOutlier ? "font-semibold" : undefined}>
                {STAGE_LABEL[stage]}
                {isOutlier && (
                  <span className="ml-1" style={{ color: COLOR_SEVERE }}>
                    (outlier)
                  </span>
                )}
              </span>
              <span className="font-mono tabular-nums text-foreground">{formatNs(values[i]!)}</span>
            </div>
            <Bar value={values[i]!} max={maxValue} color={color} highlighted={isOutlier} />
            <div className="flex items-center justify-between text-muted-foreground">
              <span>session median</span>
              <span className="font-mono tabular-nums">{formatNs(medianValues[i]!)}</span>
            </div>
            <Bar value={medianValues[i]!} max={maxValue} color="#1e293b" highlighted={false} />
          </div>
        );
      })}
    </div>
  );
}

function Bar({ value, max, color, highlighted }: { value: number; max: number; color: string; highlighted: boolean }) {
  const widthPct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-sm bg-panel">
      <div
        className="h-full"
        style={{ width: `${widthPct}%`, backgroundColor: color, boxShadow: highlighted ? `inset 0 0 0 1px ${COLOR_SEVERE}` : undefined }}
      />
    </div>
  );
}
