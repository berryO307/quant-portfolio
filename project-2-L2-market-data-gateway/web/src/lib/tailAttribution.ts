import type { Attribution, HistoricalSummary, LiveSample, TailEvent } from "./types";

// Fourth port of the same tail-attribution logic, after C++ (nowhere —
// this classification only ever existed in Python/relay), Python
// (analysis/export_summary.py), and the relay's histogram bucketing. Here
// it runs over a small (thousands, not millions) bounded live buffer, so an
// exact sort-based percentile/median is used directly rather than the
// geometric-bucket approximation the cross-language-parity cases need —
// this computation is self-contained to the live view, nothing else needs
// to agree with its exact number.

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx]!;
}

export interface JitterBaseline {
  baselineNs: number;
  thresholdNs: number;
}

// Same median + 5*MAD approach as find_tail_events() in export_summary.py,
// with the same fallback to baseline + 1000ns if MAD == 0 (a buffer where
// jitter readings are all but identical, so any nonzero deviation would
// otherwise look "infinitely elevated").
export function computeJitterBaseline(hostJitterNs: number[]): JitterBaseline {
  const sorted = [...hostJitterNs].sort((a, b) => a - b);
  const baselineNs = median(sorted);
  const deviations = sorted.map((v) => Math.abs(v - baselineNs)).sort((a, b) => a - b);
  const mad = median(deviations);
  const thresholdNs = baselineNs + (mad > 0 ? 5 * mad : 1000);
  return { baselineNs, thresholdNs };
}

function dominantStage(stage: { parse: number; bookUpdate: number; publish: number }): Attribution {
  if (stage.bookUpdate >= stage.parse && stage.bookUpdate >= stage.publish) return "book-update";
  if (stage.publish >= stage.parse) return "publish";
  return "parse";
}

export interface LiveTailResult {
  tailEvents: TailEvent[]; // newest first
  p50Ns: number;
  p99Ns: number;
  p999Ns: number;
  jitter: JitterBaseline;
  stageMedians: { parse: number; bookUpdate: number; publish: number };
}

// Flags samples above the buffer's own p99.9 as tail events, attributing
// each to host_jitter (own hostJitterNs exceeds the buffer's jitter
// threshold) or whichever stage delta is largest — same rule as the Python
// script, just computed over a rolling live buffer instead of a full
// session file. Also returns p50/p99/p99.9 and per-stage medians over the
// same buffer, for the chart's reference lines and the drill-down's "vs
// session median" comparison respectively.
export function computeLiveTailEvents(samples: LiveSample[]): LiveTailResult {
  if (samples.length === 0) {
    return {
      tailEvents: [],
      p50Ns: 0,
      p99Ns: 0,
      p999Ns: 0,
      jitter: { baselineNs: 0, thresholdNs: 0 },
      stageMedians: { parse: 0, bookUpdate: 0, publish: 0 },
    };
  }

  const sortedLatency = samples.map((s) => s.latencyNs).sort((a, b) => a - b);
  const p50Ns = percentile(sortedLatency, 50);
  const p99Ns = percentile(sortedLatency, 99);
  const p999Ns = percentile(sortedLatency, 99.9);
  const jitter = computeJitterBaseline(samples.map((s) => s.hostJitterNs));
  const stageMedians = {
    parse: median([...samples.map((s) => s.parseNs)].sort((a, b) => a - b)),
    bookUpdate: median([...samples.map((s) => s.bookUpdateNs)].sort((a, b) => a - b)),
    publish: median([...samples.map((s) => s.publishNs)].sort((a, b) => a - b)),
  };

  const tailEvents: TailEvent[] = [];
  for (const s of samples) {
    if (s.latencyNs <= p999Ns) continue;
    const stage = { parse: s.parseNs, bookUpdate: s.bookUpdateNs, publish: s.publishNs };
    const attribution: Attribution =
      s.hostJitterNs > jitter.thresholdNs ? "host_jitter" : dominantStage(stage);
    tailEvents.push({
      key: `live-${s.tRecvTsc}`,
      tRecvTsc: s.tRecvTsc,
      latencyNs: s.latencyNs,
      hostJitterNs: s.hostJitterNs,
      attribution,
      stageNs: stage,
    });
  }

  tailEvents.reverse(); // newest first, matching TimedTrade's convention elsewhere
  return { tailEvents, p50Ns, p99Ns, p999Ns, jitter, stageMedians };
}

export function tailEventsFromHistorical(summary: HistoricalSummary): TailEvent[] {
  return summary.tail_events
    .map((e) => ({
      key: `hist-${e.index}`,
      tRecvTsc: e.t_recv_tsc,
      latencyNs: e.latency_ns,
      hostJitterNs: e.host_jitter_ns,
      attribution: e.attribution,
      stageNs: { parse: e.stage_ns.parse, bookUpdate: e.stage_ns.book_update, publish: e.stage_ns.publish },
    }))
    .reverse(); // summary.json lists tail_events in session order; newest first here too
}
