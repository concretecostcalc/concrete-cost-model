/**
 * `Money` formatting. This is the only place that turns `.point` into a string, and **no exported
 * function formats `point` alone**: every function forces the low/high range along with it, and
 * `point`, when it appears, can only follow the range as the "typical" value.
 *
 * Rounding rule: totals >= $1,000 round to $10, totals < $1,000 round to $1; unit prices keep two
 * decimals and are not rounded. Each value is rounded on its own (not switched as a group when
 * low, high or point first crosses $1,000). The three can straddle the threshold (a 40 sq ft job's
 * low can be under $1,000 while its high is over), and rounding each by its own magnitude avoids
 * letting rounding create a new jump.
 */
import type { Money } from './types';

const DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const UNIT_DOLLARS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Exported for `breakdown-display.ts`: line-item allocation must round its total to exactly the
 * figure that `formatRange` / `formatRangeText` show, so it imports this rather than
 * re-implementing the same rounding rule and risking drift.
 */
export function roundDollars(n: number): number {
  const step = Math.abs(n) >= 1000 ? 10 : 1;
  return Math.round(n / step) * step;
}

function formatDollars(n: number): string {
  return `$${DOLLARS.format(roundDollars(n))}`;
}

function formatUnitDollars(n: number): string {
  return `$${UNIT_DOLLARS.format(n)}`;
}

/**
 * Total range, e.g. `"$3,600 – $5,900"`. When rounding makes low === high (zero dispersion, or
 * rounding collapses both to the same number) it shrinks to one value, `"$4,500"`:
 * `"$4,500 – $4,500"` only makes people wonder about a copy-paste error.
 */
export function formatRange(m: Money): string {
  const low = formatDollars(m.low);
  const high = formatDollars(m.high);
  return low === high ? low : `${low} – ${high}`;
}

/** Total range plus central estimate, e.g. `"$3,600 – $5,900 (typical ≈ $4,500)"`. The only way `point` may appear. */
export function formatRangeWithTypical(m: Money): string {
  return `${formatRange(m)} (typical ≈ ${formatDollars(m.point)})`;
}

/**
 * The same data as `formatRangeWithTypical`, split into two strings for layouts that render them
 * separately (a large range on one line, a small "typical" on the next).
 *
 * The same rule applies: on its own, `typical` is just the string form of `point`, so **the two
 * fields must be rendered together**. Showing only `typical` without `range` would amount to
 * exporting a function that formats `point` alone, which this file forbids. Callers must use both.
 */
export function formatRangeParts(m: Money): { range: string; typical: string } {
  return { range: formatRange(m), typical: `typical ≈ ${formatDollars(m.point)}` };
}

/** Unit-price range, e.g. `"$9.00 – $14.75"`. Two decimals, not rounded to $1/$10. */
export function formatUnitRange(m: Money): string {
  const low = formatUnitDollars(m.low);
  const high = formatUnitDollars(m.high);
  return low === high ? low : `${low} – ${high}`;
}

/** Unit-price range plus central estimate, e.g. `"$9.00 – $14.75 (typical ≈ $11.50)"`. */
export function formatUnitRangeWithTypical(m: Money): string {
  return `${formatUnitRange(m)} (typical ≈ ${formatUnitDollars(m.point)})`;
}

/**
 * Total range for use inside a sentence, e.g. `"$3,600 to $5,900"` (running text avoids the dash;
 * result panels and tables use the compact `formatRange`). Collapses to one value when rounding makes them equal.
 */
export function formatRangeText(m: Money): string {
  const low = formatDollars(m.low);
  const high = formatDollars(m.high);
  return low === high ? low : `${low} to ${high}`;
}

/** Unit-price range for use inside a sentence, e.g. `"$9.00 to $14.75"`. */
export function formatUnitRangeText(m: Money): string {
  const low = formatUnitDollars(m.low);
  const high = formatUnitDollars(m.high);
  return low === high ? low : `${low} to ${high}`;
}

/**
 * A range spanning two estimates, e.g. from a small patio's low to a large driveway's high:
 * `"$2,040 to $6,170"`. Reads only the `low` of `from` and the `high` of `to` and never synthesizes
 * a central value.
 */
export function formatSpanText(from: Money, to: Money): string {
  const low = formatDollars(from.low);
  const high = formatDollars(to.high);
  return low === high ? low : `${low} to ${high}`;
}
