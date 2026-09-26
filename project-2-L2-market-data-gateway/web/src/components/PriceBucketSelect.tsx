// Shared by OrderBookLadder and DepthCurve — same dropdown component, but
// NOT the same options list: `options` comes from the caller's own
// InstrumentConfig.priceBucketOptions (lib/instruments.ts), since a bucket
// width that's useful for one instrument's price scale (e.g. BTC's $1-$10)
// can be structurally useless for another's (WTI's $0.001-$0.01) — see
// that field's comment for the measured live data behind the split.
export function PriceBucketSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: number;
  onChange: (size: number) => void;
  options: readonly number[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      title="Price grouping — merges nearby levels into buckets of this size, summing their size"
      className={
        className ??
        "rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground"
      }
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
