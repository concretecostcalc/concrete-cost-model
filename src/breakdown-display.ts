/**
 * Rounded allocation for display.
 *
 * In `model.ts`, `total` is the sum of the unrounded per-line values, rounded once, and each
 * `LineItem.amount` is rounded independently to the cent. Both use the same `dispersion`
 * coefficient (within one `estimate()` call, `total` and every line come from the same
 * `createLineBuilder(dispersion)` instance, and every `builder.add` happens before
 * `builder.total()`, so no line item sits outside the total). The sum of the line items on the low
 * end therefore equals the total exactly in the unrounded reals, and likewise on the high end.
 *
 * Rounding each line on its own when showing whole dollars introduces drift, and this file fixes
 * that. **The total's rounding must match everywhere else** (`formatRange` / `formatRangeText`):
 * the same `Money` must never appear as two different numbers on one page. The rounding rule is
 * therefore **reused from `money.ts`'s `roundDollars`**:
 *
 * 1. Total = `roundDollars(total[end])`, identical to what `formatRange(total)` shows.
 * 2. The step behind that number (`money.ts`: >= $1,000 uses $10, otherwise $1) is also used for
 *    every line. Each line is rounded to a multiple of that step and the lines are apportioned with
 *    the largest remainder method (Hamilton apportionment, working in units of the step rather than
 *    of one dollar) so that the lines sum to exactly the total from step 1. With a coarse step a
 *    small line can land on $0; that honestly reflects "at this precision it is that small" and the
 *    row is kept.
 *
 * The central estimate (`point`, shown as "typical") goes through the same allocation as low/high:
 * target `roundDollars(total.point)`, step chosen from `total.point`, shares taken from each line's
 * `amount.point`, so the line typicals sum to the displayed total typical and all three columns
 * (low / typical / high) add back to the total. `point` stays bound by the contract in `money.ts`:
 * it must not be shown alone, only after the range (`rangeWithTypicalText` does exactly that, with
 * the same layout as `formatRangeWithTypical`; `pointText` exists only for assembling such
 * "range + typical" strings).
 *
 * One extra constraint on the typical end: each row's typical must fall between that row's
 * allocated low and high (`allocatePointBetween`). Otherwise three independent largest-remainder
 * runs can produce things like "$10 (typical ≈ $20)" on a small line. The low / high allocation is unchanged.
 *
 * Known edge: swept over all 393 metros x about 500 inputs, the three line sums never missed the
 * total and every per-line deviation was under one step. In very small jobs (area <~ 20 sq ft) a
 * line can be smaller than one rounding step (the subbase of a 5 sq ft slab is a few dollars while
 * the step is $10), or the low end can be under $1,000 while typical / high are at or above it
 * (steps of $1 and $10 mixed), and low and high themselves may end up allocated as low > high;
 * that is how the low / high allocation already behaved, and typical cannot lie between such ends.
 * It never occurred at 40 sq ft and above.
 */
import type { CostBreakdown, LineKey, Money } from './types';
import { roundDollars } from './money';

export interface DisplayLine {
  key: LineKey;
  label: string;
  low: number;
  /** Central estimate (typical). Never show it alone, only with the range; see `rangeWithTypicalText`. */
  point: number;
  high: number;
  lowText: string;
  pointText: string;
  highText: string;
  rangeText: string;
  /** Same layout as `formatRangeWithTypical` in `money.ts`: `"$a – $b (typical ≈ $c)"`. */
  rangeWithTypicalText: string;
}

export interface DisplayTotal {
  low: number;
  /** Central estimate (typical). Never show it alone; see `DisplayLine.point`. */
  point: number;
  high: number;
  lowText: string;
  pointText: string;
  highText: string;
  rangeText: string;
  rangeWithTypicalText: string;
}

export interface DisplayBreakdown {
  lines: DisplayLine[];
  total: DisplayTotal;
}

const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatWholeDollars(n: number): string {
  return `$${WHOLE_DOLLARS.format(n)}`;
}

/** Table range format, laid out like `formatRange` in `money.ts` ("$a – $b", collapsed to one value when both ends are equal). */
function formatWholeRange(low: number, high: number): string {
  const lowText = formatWholeDollars(low);
  const highText = formatWholeDollars(high);
  return low === high ? lowText : `${lowText} – ${highText}`;
}

/**
 * Uses the same threshold as `roundDollars` in `money.ts` (totals >= $1,000 round to $10, below
 * that to $1). It only borrows the step, and does not re-implement the rounding itself (that is
 * imported above). The argument must be the raw value before rounding (`roundDollars` also tests
 * the threshold on the raw value), so the threshold agrees with `formatRange` at every boundary value.
 */
function dollarStep(n: number): number {
  return Math.abs(n) >= 1000 ? 10 : 1;
}

/**
 * Largest remainder method: apportions a set of floating-point shares (`shares`) into integer
 * multiples of `step` so that they sum to exactly `target` (`target` must already be a multiple of
 * `step`, which the output of `roundDollars` guarantees).
 *
 * Both the shares and the target are converted to "number of steps" and the classic method runs on
 * that integer grid: every share is floored first, and the difference between `target` and the sum
 * of the floors is handed out as +1 to the shares with the largest fractional parts. A negative
 * difference does the reverse (-1 to the smallest fractional parts). That cannot happen in theory,
 * because flooring only makes the sum <= the sum of the shares, but the branch is kept against
 * floating-point edges. The result is converted back to dollars.
 *
 * When `target` is approximately the sum of `shares` (which is how this file uses it, see the
 * header), the difference is at most `shares.length` steps and each allocated value differs from
 * its raw share by less than one step (the quota property of the method).
 */
function allocateSteps(shares: number[], target: number, step: number): number[] {
  const n = shares.length;
  if (n === 0) return [];

  const scaledShares = shares.map((s) => s / step);
  const scaledTarget = Math.round(target / step);

  const floors = scaledShares.map((s) => Math.floor(s));
  const flooredSum = floors.reduce((a, b) => a + b, 0);
  const remainder = scaledTarget - flooredSum;
  const scaledResult = [...floors];

  if (remainder > 0) {
    const order = scaledShares
      .map((s, i) => ({ i, frac: s - floors[i] }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < remainder; k++) {
      scaledResult[order[k % n].i] += 1;
    }
  } else if (remainder < 0) {
    const order = scaledShares
      .map((s, i) => ({ i, frac: s - floors[i] }))
      .sort((a, b) => a.frac - b.frac || a.i - b.i);
    for (let k = 0; k < -remainder; k++) {
      scaledResult[order[k % n].i] -= 1;
    }
  }

  return scaledResult.map((v) => v * step);
}

function allocateEnd(lines: CostBreakdown['lines'], total: Money, end: keyof Money): { lines: number[]; total: number } {
  const target = roundDollars(total[end]);
  const step = dollarStep(total[end]);
  const shares = lines.map((line) => line.amount[end]);
  return { lines: allocateSteps(shares, target, step), total: target };
}

/**
 * Allocation for the typical (`point`) end: same target, step and shares as `allocateSteps`, with
 * one extra constraint: each line's typical must fall **between the low and high already allocated
 * for that line** (`lows[i] <= result[i] <= highs[i]`).
 *
 * Why: the three ends each run largest remainder independently, and for a line smaller than one
 * step (a 40 sq ft slab with a smooth finish has a `finish` line of raw $8 / $12 / $16 with a $10
 * step) the low end gets $10, the typical end $20 and the high end $10, so the page would read
 * "$10 (typical ≈ $20)", with the typical outside the range.
 *
 * How: each row has two candidates, `floor(share)` or `floor(share) + 1` (as in `allocateSteps`,
 * which keeps each deviation under one step). Candidates outside [low, high] are dropped, and the
 * remaining rows get the difference by the same rule as `allocateSteps` (largest fractional part
 * first). When the constraint cannot reach the target (the step differs between `lows` and `point`
 * for a small job whose low end is under $1,000 while typical is at or above it, so a row may have
 * no multiple of the step inside [low, high] at all), it falls back to the unconstrained result of
 * `allocateSteps`: better one row out of order than three ends that do not add up to the total.
 */
function allocatePointBetween(shares: number[], target: number, step: number, lows: number[], highs: number[]): number[] {
  const n = shares.length;
  if (n === 0) return [];

  const scaled = shares.map((s) => s / step);
  const floors = scaled.map((s) => Math.floor(s));
  const scaledTarget = Math.round(target / step);

  const base: number[] = [];
  const canRaise: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.ceil(lows[i] / step);
    const hi = Math.floor(highs[i] / step);
    const ok0 = floors[i] >= lo && floors[i] <= hi;
    const ok1 = floors[i] + 1 >= lo && floors[i] + 1 <= hi;
    if (ok0) {
      base.push(floors[i]);
      canRaise.push(ok1);
    } else if (ok1) {
      base.push(floors[i] + 1);
      canRaise.push(false);
    } else {
      // No candidate lies inside [low, high] (inconsistent steps across the threshold): leave this row unconstrained.
      base.push(floors[i]);
      canRaise.push(true);
    }
  }

  const need = scaledTarget - base.reduce((a, b) => a + b, 0);
  const raisable = scaled
    .map((s, i) => ({ i, frac: s - floors[i] }))
    .filter(({ i }) => canRaise[i])
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  if (need < 0 || need > raisable.length) return allocateSteps(shares, target, step);

  const result = [...base];
  for (let k = 0; k < need; k++) result[raisable[k].i] += 1;
  return result.map((v) => v * step);
}

function allocatePoint(
  lines: CostBreakdown['lines'],
  total: Money,
  low: { lines: number[] },
  high: { lines: number[] },
): { lines: number[]; total: number } {
  const target = roundDollars(total.point);
  const step = dollarStep(total.point);
  const shares = lines.map((line) => line.amount.point);
  return { lines: allocatePointBetween(shares, target, step, low.lines, high.lines), total: target };
}

/**
 * Converts a `CostBreakdown` into a whole-dollar display breakdown: every line and the total get
 * integer low / point (typical) / high values plus formatted strings. The total matches, character
 * for character, how the same `Money` is shown elsewhere (`formatRange`), and on each of the low,
 * point and high ends the line sums equal that end's total exactly.
 *
 * For example tables in content pages, test-case tables, and line-item tables in a calculator UI.
 */
export function allocateDisplay(breakdown: CostBreakdown): DisplayBreakdown {
  const low = allocateEnd(breakdown.lines, breakdown.total, 'low');
  const high = allocateEnd(breakdown.lines, breakdown.total, 'high');
  const point = allocatePoint(breakdown.lines, breakdown.total, low, high);

  const lines: DisplayLine[] = breakdown.lines.map((line, i) => {
    const rangeText = formatWholeRange(low.lines[i], high.lines[i]);
    const pointText = formatWholeDollars(point.lines[i]);
    return {
      key: line.key,
      label: line.label,
      low: low.lines[i],
      point: point.lines[i],
      high: high.lines[i],
      lowText: formatWholeDollars(low.lines[i]),
      pointText,
      highText: formatWholeDollars(high.lines[i]),
      rangeText,
      rangeWithTypicalText: `${rangeText} (typical ≈ ${pointText})`,
    };
  });

  const totalRangeText = formatWholeRange(low.total, high.total);
  const totalPointText = formatWholeDollars(point.total);
  return {
    lines,
    total: {
      low: low.total,
      point: point.total,
      high: high.total,
      lowText: formatWholeDollars(low.total),
      pointText: totalPointText,
      highText: formatWholeDollars(high.total),
      rangeText: totalRangeText,
      rangeWithTypicalText: `${totalRangeText} (typical ≈ ${totalPointText})`,
    },
  };
}
