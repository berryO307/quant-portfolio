import { sampleKey, type Attribution, type LiveSample, type StageNs, type TailEvent } from "./types";

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

// Whichever stage ate the most time. "queue" joined the list once the
// gateway started exporting its queue-pop stamp: before that, queue wait
// was folded into bookUpdate and every queue-caused tail event was
// mislabelled as a slow book update.
function dominantStage(stage: StageNs): Attribution {
  const ranked: [Attribution, number][] = [
    ["parse", stage.parse],
    ["queue", stage.queue],
    ["book-update", stage.bookUpdate],
    ["publish", stage.publish],
  ];
  return ranked.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

export interface LiveTailResult {
  tailEvents: TailEvent[]; // newest first
  p50Ns: number;
  p99Ns: number;
  p999Ns: number;
  stageMedians: StageNs;
}

// Flags samples above the buffer's own p99.9 as tail events, attributing
// each to whichever stage delta is largest — same rule as the Python
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
      stageMedians: { parse: 0, queue: 0, bookUpdate: 0, publish: 0 },
    };
  }

  const sortedLatency = samples.map((s) => s.latencyNs).sort((a, b) => a - b);
  const p50Ns = percentile(sortedLatency, 50);
  const p99Ns = percentile(sortedLatency, 99);
  const p999Ns = percentile(sortedLatency, 99.9);
  const stageMedians: StageNs = {
    parse: median([...samples.map((s) => s.parseNs)].sort((a, b) => a - b)),
    queue: median([...samples.map((s) => s.queueNs)].sort((a, b) => a - b)),
    bookUpdate: median([...samples.map((s) => s.bookUpdateNs)].sort((a, b) => a - b)),
    publish: median([...samples.map((s) => s.publishNs)].sort((a, b) => a - b)),
  };

  // >= p999Ns, not > p999Ns: by definition of how percentile() picks
  // sorted[idx], p999Ns itself is the value of a REAL sample near the tail
  // of this exact buffer — requiring samples to be STRICTLY greater than
  // their own buffer's 99.9th-percentile value means, at most, only the
  // single highest sample (assuming no ties) can ever qualify, and if two
  // or more samples tie exactly at the tail (real timer-resolution ties,
  // or — as diagnosed live — a short captured session replayed on --loop
  // reintroducing byte-identical latency values every time it repeats),
  // NONE of them count, since none is "strictly greater than" a value
  // they're all equal to. Reported: p99.9 showing a clearly elevated
  // ~7ms with zero tail events ever appearing below it. >= correctly
  // flags every sample at or above the threshold, which is also the
  // conventional definition of a percentile-based outlier.
  const tailEvents: TailEvent[] = [];
  // Guards against the same tick ever producing two rows in the feed — not
  // expected (each tick appears once in `samples`), but a rolling buffer
  // fed by a network stream is exactly the kind of thing that's cheap to
  // make provably safe against a duplicate rather than trust it can't
  // happen. Keeps the first occurrence; a duplicate of a real tick would
  // carry identical data regardless of which copy wins.
  const seenKeys = new Set<string>();
  for (const s of samples) {
    if (s.latencyNs < p999Ns) continue;
    const key = sampleKey(s.tRecvTsc, s.batchIndex);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const stage: StageNs = {
      parse: s.parseNs,
      queue: s.queueNs,
      bookUpdate: s.bookUpdateNs,
      publish: s.publishNs,
    };
    const attribution: Attribution = dominantStage(stage);
    tailEvents.push({
      key,
      tRecvTsc: s.tRecvTsc,
      batchIndex: s.batchIndex,
      batchSize: s.batchSize,
      latencyNs: s.latencyNs,
      attribution,
      stageNs: stage,
    });
  }

  tailEvents.reverse(); // newest first, matching TimedTrade's convention elsewhere
  return { tailEvents, p50Ns, p99Ns, p999Ns, stageMedians };
}
