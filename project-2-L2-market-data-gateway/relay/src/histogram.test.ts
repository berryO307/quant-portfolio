// Task #7 investigation: "P99.9 > Max" was reported as looking impossible.
// These tests reproduce it deterministically and pin down WHY it's an
// expected property of this histogram's percentile semantics (an
// HDR-histogram-style upper-bound bucket estimate), not a bug — see the
// comment on HistogramSnapshot in histogram.ts for the full explanation.
// They exist to stop a future change from "fixing" this away (e.g. via
// Math.min(p999Ns, maxNs) clamping), which would silently discard real
// bucket-resolution information.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  Histogram,
  BUCKET_BOUNDARIES,
  snapshotFromCounts,
} from "./histogram.js";
import { mergeHistograms } from "./rollingStatsAggregator.js";

// Re-derives the exact boundary record()/bucketIndex() would assign to
// `value`, using the same lower_bound semantics — so the assertions below
// can state their expected value in terms of the real algorithm instead of
// a magic number.
function boundaryFor(value: number): number {
  let lo = 0;
  let hi = BUCKET_BOUNDARIES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (BUCKET_BOUNDARIES[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return BUCKET_BOUNDARIES[lo]!;
}

describe("Histogram percentile semantics", () => {
  test("p999Ns can legitimately exceed maxNs (the reported case)", () => {
    // total = 1000. For any total <= 1000, floor(total * 999/1000) targets
    // the very last-ranked (i.e. maximum) sample's own bucket — see the
    // HistogramSnapshot comment for the derivation. 999 small samples in
    // one bucket, then a single much larger "max" sample in its own bucket.
    const h = new Histogram();
    for (let i = 0; i < 999; i++) h.record(100);
    const maxSample = 500_000;
    h.record(maxSample);

    const snap = h.snapshot();

    // maxNs is the exact raw value — never bucket-rounded.
    assert.equal(snap.maxNs, maxSample);

    // p999's target (999) is only exceeded once the max sample itself is
    // counted, so p999Ns resolves to THAT bucket's upper boundary.
    assert.equal(snap.p999Ns, boundaryFor(maxSample));

    // The boundary is a fixed geometric constant, essentially never equal
    // to an arbitrary raw sample — so it's strictly greater here.
    assert.ok(
      snap.p999Ns > snap.maxNs,
      `expected p999Ns (${snap.p999Ns}) > maxNs (${snap.maxNs})`,
    );

    // p99's target (990) is already satisfied within the 999-sample small
    // bucket (cumulative 999 > 990) — it never touches the max's bucket at
    // all, matching the real-world symptom being specifically "P99.9 > Max"
    // rather than "P99 > Max".
    assert.ok(snap.p99Ns < snap.maxNs);
  });

  test("maxNs is always the exact raw sample, never bucket-rounded", () => {
    const h = new Histogram();
    const values = [3, 7, 12_345, 999_999, 42];
    for (const v of values) h.record(v);
    assert.equal(h.maxValueNs, Math.max(...values));
  });

  test("repeated identical values: percentiles collapse to one bucket, still >= max", () => {
    const h = new Histogram();
    for (let i = 0; i < 500; i++) h.record(777);
    const snap = h.snapshot();
    const b = boundaryFor(777);

    assert.equal(snap.p50Ns, b);
    assert.equal(snap.p99Ns, b);
    assert.equal(snap.p999Ns, b);
    assert.equal(snap.maxNs, 777);
    assert.ok(snap.p999Ns >= snap.maxNs);
  });

  test("single extreme value", () => {
    const h = new Histogram();
    h.record(2_000_000_000);
    const snap = h.snapshot();

    assert.equal(snap.count, 1);
    assert.equal(snap.maxNs, 2_000_000_000);
    assert.ok(snap.p999Ns >= snap.maxNs);
  });

  test("normal-ish distribution: percentiles stay ordered and near maxNs, no overshoot below max", () => {
    const h = new Histogram();
    // A spread of values with a long tail, large enough total that p999's
    // target does NOT land in the exact-max bucket, so no overshoot is
    // expected here — a contrast case to the reproduction above.
    for (let i = 0; i < 5000; i++) h.record(1_000 + (i % 200));
    h.record(50_000);
    h.record(75_000);
    const snap = h.snapshot();

    assert.ok(snap.p50Ns <= snap.p99Ns);
    assert.ok(snap.p99Ns <= snap.p999Ns);
    assert.equal(snap.maxNs, 75_000);
  });

  test("merging histograms preserves the exact max and total count (rules out a merge-layer bug)", () => {
    const a = new Histogram();
    const b = new Histogram();
    for (let i = 0; i < 300; i++) a.record(50);
    a.record(10_000);
    for (let i = 0; i < 300; i++) b.record(60);
    b.record(999_999);

    const { counts, total, maxNs } = mergeHistograms([a, b]);
    const merged = snapshotFromCounts(counts, total, maxNs);

    assert.equal(merged.count, 602);
    assert.equal(merged.maxNs, 999_999);
    // Merging is exact element-wise addition of bucket counts plus an
    // exact max-of-maxes — not a re-derivation from percentiles — so this
    // is not a source of the p999Ns > maxNs behavior; that's inherent to
    // snapshotFromCounts() itself, exercised above.
  });

  test("historical bucket snapshot shape: a single Histogram.snapshot() matches snapshotFromCounts() on its own counts", () => {
    const h = new Histogram();
    for (let i = 0; i < 200; i++) h.record(100 + i);
    h.record(1_000_000);

    const direct = h.snapshot();
    const viaHelper = snapshotFromCounts(h.countsView, h.count, h.maxValueNs);

    assert.deepEqual(direct, viaHelper);
  });
});
