import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RollingStatsAggregator } from "./rollingStatsAggregator.js";
import { Histogram, toWireHistogram, wireFromHistogram } from "./histogram.js";

// Unit tests for the stats representation: finished buckets kept only as
// cached JSON, the live one dense. Wall time is mocked so buckets can be
// created deterministically.
const GHZ = 3;
class FakeSource extends EventEmitter {
  cpuGhz() {
    return GHZ;
  }
}
const sample = (totalNs: number) => {
  const c = totalNs * GHZ;
  return { type: "sample", t_recv: 1_000, t_parse_begin: 1_000, t_parse: 1_000 + c / 4, t_pop: 1_000 + c / 2, t_book: 1_000 + (3 * c) / 4, t_publish: 1_000 + c, queue_overflow_dropped: 0 };
};

function withClock(run: (setNow: (ms: number) => void) => void) {
  const real = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    run((ms) => (now = ms));
  } finally {
    Date.now = real;
  }
}

type Full = { latencyBuckets: { timestampMs: number; total: { count: number } }[] };

test("wireFromHistogram matches the snapshot-based conversion exactly", () => {
  assert.deepEqual(wireFromHistogram(new Histogram()), toWireHistogram(new Histogram().snapshot()));
  for (let trial = 0; trial < 20; trial++) {
    const h = new Histogram();
    const n = 1 + Math.floor(Math.random() * 2_000);
    for (let i = 0; i < n; i++) h.record(Math.exp(Math.random() * 14)); // 1ns .. ~1.2ms
    assert.deepEqual(wireFromHistogram(h), toWireHistogram(h.snapshot()));
  }
});

test("finished buckets stay correct, cached and in order; updates carry only what changed", () => {
  withClock((setNow) => {
    const src = new FakeSource();
    const agg = new RollingStatsAggregator(src as never);
    const t0 = 1_800_000_000_000;
    for (let b = 0; b < 3; b++) {
      setNow(t0 + b * 10_000);
      for (let i = 0; i <= b; i++) src.emit("record", sample(5_000)); // bucket b gets b+1 samples
    }
    const first = agg.fullMessageJson();
    const full = JSON.parse(first) as Full;
    assert.deepEqual(full.latencyBuckets.map((x) => x.total.count), [1, 2, 3]);
    assert.deepEqual(full.latencyBuckets.map((x) => x.timestampMs), [t0, t0 + 10_000, t0 + 20_000]);
    assert.equal(agg.fullMessageJson(), first, "unchanged stats -> the identical cached string");

    agg.takeUpdateJson(); // drain
    src.emit("record", sample(5_000)); // into the live (third) bucket
    const update = JSON.parse(agg.takeUpdateJson()!) as Full;
    assert.deepEqual(update.latencyBuckets.map((x) => x.total.count), [4], "only the live bucket");
    assert.equal(agg.takeUpdateJson(), null, "nothing new -> nothing to send");
  });
});

test("retention: an hour of buckets, oldest evicted first", () => {
  withClock((setNow) => {
    const src = new FakeSource();
    const agg = new RollingStatsAggregator(src as never);
    const t0 = 1_800_000_000_000;
    for (let b = 0; b < 365; b++) {
      setNow(t0 + b * 10_000);
      src.emit("record", sample(2_000));
    }
    const full = JSON.parse(agg.fullMessageJson()) as Full;
    assert.equal(full.latencyBuckets.length, 360);
    assert.equal(full.latencyBuckets[0]!.timestampMs, t0 + 5 * 10_000);
    assert.equal(full.latencyBuckets.at(-1)!.timestampMs, t0 + 364 * 10_000);
  });
});
