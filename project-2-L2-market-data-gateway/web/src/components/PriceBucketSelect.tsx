import { PRICE_BUCKET_OPTIONS } from "@/lib/orderBook";

// Shared by OrderBookLadder and DepthCurve — same price-bucket options,
// same dropdown, so a given bucket size means the exact same aggregation
// in both places. Matches Hyperliquid's own order-book UI, which offers
// this same $0.001-$1 grouping instead of a raw-level-count control.
export function PriceBucketSelect({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (size: number) => void;
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
      {PRICE_BUCKET_OPTIONS.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
