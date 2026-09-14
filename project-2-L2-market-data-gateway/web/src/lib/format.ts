// Shared by StageBreakdown and TailEventsFeed — was two identical copies.
export function formatNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)}us`;
  return `${ns.toFixed(0)}ns`;
}

// LatencyChart's x-axis (Phase 8.5): samples/tail events only carry
// tRecvTsc, a raw per-session TSC cycle count with no fixed relationship to
// wall-clock time (see LiveSample's comment in lib/types.ts) — there's no
// "real" timestamp to show. What IS meaningful is elapsed time since the
// first point currently plotted, which the caller converts from a raw
// tRecvTsc delta to seconds via the known cpu_ghz first.
//
// First version of this (fixed 1-decimal seconds, e.g. "0.0s") was a real
// bug reported in Phase 8.5's second pass: the live scatter's visible
// sample window is very often well under a second (samples can arrive at
// thousands/sec — see useRelayConnection's MAX_LIVE_SAMPLES comment), so
// every tick rounded to the same string. Unit and decimal precision are now
// picked from the actual spacing between adjacent ticks (stepSeconds),
// not from the value being formatted — that's what guarantees consecutive
// ticks render as distinct strings instead of just "usually looking fine."
function pickElapsedUnit(stepSeconds: number): { unit: string; mult: number } {
  if (stepSeconds >= 1) return { unit: "s", mult: 1 };
  if (stepSeconds >= 1e-3) return { unit: "ms", mult: 1e3 };
  return { unit: "µs", mult: 1e6 };
}

function decimalsForStep(stepInUnit: number): number {
  if (!Number.isFinite(stepInUnit) || stepInUnit <= 0) return 1;
  // Enough decimal places that a change of one tick-step is visible in the
  // chosen unit (e.g. a 0.05ms step needs 2 decimals: "1.20ms" -> "1.25ms"),
  // capped so we never print more precision than is legible.
  return Math.min(Math.max(Math.ceil(-Math.log10(stepInUnit)), 0), 2);
}

export function formatElapsedAdaptive(valueSeconds: number, stepSeconds: number): string {
  const { unit, mult } = pickElapsedUnit(Math.max(Math.abs(stepSeconds), 1e-9));
  const decimals = decimalsForStep(Math.abs(stepSeconds) * mult);
  return `${(valueSeconds * mult).toFixed(decimals)}${unit}`;
}

// Actually run (node, not hand-computed) against a short and a long tick
// window before trusting this — see the comment above formatElapsedAdaptive:
//   formatElapsedAdaptive(0.000123, 0.00005) -> "123µs"  \ short window (50us step): distinct
//   formatElapsedAdaptive(0.000173, 0.00005) -> "173µs"  /
//   formatElapsedAdaptive(12.4, 2)           -> "12s"    \ long window (2s step): distinct
//   formatElapsedAdaptive(14.4, 2)           -> "14s"    /
