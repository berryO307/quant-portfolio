import type { TailEvent } from "@/lib/types";

const STAGE_COLOR: Record<"parse" | "bookUpdate" | "publish", string> = {
  parse: "#58a6ff",
  bookUpdate: "#bc8cff",
  publish: "#3fb950",
};

const STAGE_LABEL: Record<"parse" | "bookUpdate" | "publish", string> = {
  parse: "parse",
  bookUpdate: "book-update",
  publish: "publish",
};

function formatNs(ns: number): string {
  return ns >= 1000 ? `${(ns / 1000).toFixed(1)}us` : `${ns.toFixed(0)}ns`;
}

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
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-[#8b949e]">
        select a tail event to drill in
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
    <div className="flex h-full flex-col justify-center gap-2 px-4 font-mono text-xs">
      <div className="text-[10px] uppercase tracking-wide text-[#8b949e]">Attributed to host jitter</div>
      <div className="text-2xl text-[#d29922]">{formatNs(event.hostJitterNs)}</div>
      <div className="text-[#8b949e]">
        canary delta at this sample — the pipeline&apos;s own stages were not the dominant cost
        (see JitterCanary in include/jitter_canary.hpp)
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
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-3 font-mono text-xs">
      <div className="text-[10px] uppercase tracking-wide text-[#8b949e]">
        Stage breakdown vs. session median
      </div>
      {stages.map((stage, i) => {
        const isOutlier = STAGE_LABEL[stage] === event.attribution;
        const color = STAGE_COLOR[stage];
        return (
          <div key={stage} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span style={{ color }} className={isOutlier ? "font-bold" : undefined}>
                {STAGE_LABEL[stage]}
                {isOutlier && <span className="ml-1 text-[#f85149]">(outlier)</span>}
              </span>
              <span className="text-[#c9d1d9]">{formatNs(values[i]!)}</span>
            </div>
            <Bar value={values[i]!} max={maxValue} color={color} highlighted={isOutlier} />
            <div className="flex items-center justify-between text-[#8b949e]">
              <span>session median</span>
              <span>{formatNs(medianValues[i]!)}</span>
            </div>
            <Bar value={medianValues[i]!} max={maxValue} color="#30363d" highlighted={false} />
          </div>
        );
      })}
    </div>
  );
}

function Bar({ value, max, color, highlighted }: { value: number; max: number; color: string; highlighted: boolean }) {
  const widthPct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-sm bg-[#161b22]">
      <div
        className={`h-full ${highlighted ? "ring-1 ring-[#f85149]" : ""}`}
        style={{ width: `${widthPct}%`, backgroundColor: color }}
      />
    </div>
  );
}
