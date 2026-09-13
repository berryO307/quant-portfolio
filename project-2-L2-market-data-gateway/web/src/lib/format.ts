// Shared by StageBreakdown and TailEventsFeed — was two identical copies.
export function formatNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)}us`;
  return `${ns.toFixed(0)}ns`;
}
