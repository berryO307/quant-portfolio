// Price-axis sizing and label precision for the depth curve.
//
// Both concerns live together because they're the same question asked twice:
// "what price range is actually on screen right now?" The bounds come
// straight from that range, and the label precision comes from how finely
// that range has to be subdivided to label it.

// Roughly how many labelled ticks the price axis should carry. Low on
// purpose: the previous version let ECharts auto-fit labels and produced a
// dense wall of `77280.00 77300.00 77320.00 ...` that ran together at this
// panel's width. Six gives enough anchors to read the range without the
// labels touching.
export const PRICE_AXIS_TICKS = 6;

const MAX_DECIMALS = 6;

/**
 * Decimal places for price tick labels, derived from the range actually
 * being rendered rather than from a per-instrument constant.
 *
 * The instrument's own `priceDecimals` (2 for BTC, 3 for WTI) is the right
 * precision for the ORDER BOOK LADDER, where every row is a distinct real
 * price and the trailing digits carry information. It is the wrong
 * precision for axis ticks: BTC's tick size is $1, so an axis spanning
 * ~$40 renders `77380.00, 77386.67, ...` where the `.00` is pure noise and
 * costs horizontal room that made the labels collide.
 *
 * What matters for a tick label is the gap between adjacent ticks: if ticks
 * are ~6.7 apart, zero decimals distinguishes them; if they're 0.004 apart,
 * three are needed. So precision is computed from the interval this axis
 * will actually use, which keeps it correct for a $77k instrument and a $98
 * one without either being special-cased.
 */
export function derivePriceDecimals(min: number, max: number, tickCount = PRICE_AXIS_TICKS): number {
  const range = max - min;
  if (!Number.isFinite(range) || range <= 0) return 2;

  const interval = range / Math.max(1, tickCount);
  // ceil(-log10(interval)): interval 6.7 -> -0.83 -> 0 decimals.
  // interval 0.004 -> 2.4 -> 3 decimals. interval 0.05 -> 1.3 -> 2.
  const decimals = Math.ceil(-Math.log10(interval));
  return Math.min(Math.max(decimals, 0), MAX_DECIMALS);
}

/**
 * Tight x-axis bounds for the prices currently plotted.
 *
 * ECharts' `scale: true` (what this used before) widens the axis out to
 * round numbers, which on an order book — where every visible level sits
 * inside a band a few dollars wide — left visible empty gutters on both
 * sides before the first bid and after the last ask. These bounds are the
 * real data extent plus a 2% margin, so the curve reaches both edges of the
 * plot area with just enough room that the outermost step isn't clipped
 * against the axis line.
 */
export function priceAxisBounds(prices: readonly number[]): { min: number; max: number } {
  const finite = prices.filter((p) => Number.isFinite(p));
  if (finite.length === 0) return { min: 0, max: 1 };

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min;

  if (range <= 0) {
    // Every level at one price (a one-sided or single-level book). Give it a
    // nominal width so the axis doesn't collapse to a single column.
    const nominal = Math.max(Math.abs(min) * 1e-4, 0.01);
    return { min: min - nominal, max: max + nominal };
  }

  const margin = range * 0.02;
  return { min: min - margin, max: max + margin };
}
