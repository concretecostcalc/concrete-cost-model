/**
 * Tests for `allocateDisplay`, in three groups:
 *
 * 1. The algorithm itself (largest remainder with a step): hand-made shares and targets covering
 *    ties, a negative difference, a single line and $0 lines, independent of the real cost model.
 * 2. Consistency with `money.ts`: `allocateDisplay(bd).total.rangeText` must equal
 *    `formatRange(bd.total)` character for character. The same `Money` can be shown through
 *    `formatRange` (size tables, FAQ) or `allocateDisplay` (worked examples, test-case tables) and
 *    must never appear as two different numbers.
 * 3. Consistency with the real model: run `estimate()` on the sample rate table
 *    (`examples/rates.sample.json`) and `JOB_PARAMS` over every job kind x several sizes x option
 *    combinations, and assert that the line sums on the low and high ends equal the total exactly
 *    and that every line stays within one step of its raw value.
 */
import { describe, expect, it } from 'vitest';
import { allocateDisplay } from '../src/breakdown-display';
import { formatRange, formatRangeWithTypical } from '../src/money';
import { buildRateCard, estimate } from '../src/model';
import { JOB_PARAMS } from '../src/params';
import rateTableSample from '../examples/rates.sample.json';
import type { AreaJob, BlockJob, CostBreakdown, CostInput, Money, RateTable, RebarJob, VolumeJob } from '../src/types';

const rateTable = rateTableSample as unknown as RateTable;
const jobParams = JOB_PARAMS;

function rateCardFor(cbsa: string) {
  const rc = buildRateCard(rateTable, cbsa);
  if (!rc) throw new Error(`rateCardFor: cbsa=${cbsa} not found in the sample rate table`);
  return rc;
}

/** The same threshold as `dollarStep` in `breakdown-display.ts`, recomputed independently here so the test does not import a private function. */
function stepFor(n: number): number {
  return Math.abs(n) >= 1000 ? 10 : 1;
}

// ═══════════ 1. The largest remainder method itself: hand-made shares, no real model ═══════════

/** Builds only the fields `allocateDisplay` reads (`lines[].amount` and `total`); the rest is filled in to satisfy the type. */
function fakeBreakdown(lineAmounts: Money[], total: Money): CostBreakdown {
  return {
    unit: 'sqft',
    quantity: 1,
    quantityLabel: '1 sq ft',
    total,
    perUnit: total,
    lines: lineAmounts.map((amount, i) => ({
      key: (['material', 'labor', 'mobilization', 'subbase'] as const)[i] ?? 'material',
      label: `line ${i}`,
      amount,
      inputs: [],
    })),
    geo: { level: 'national', label: 'test', cbsa: null, fellBackFrom: null },
    asOf: { wages: '2026-01', material: '2026-01', index: '2026-01' },
    notices: [],
  };
}

function money(low: number, point: number, high: number): Money {
  return { low, point, high };
}

describe('allocateDisplay — the largest remainder method itself (< $1,000 end, step $1)', () => {
  it('when the line sum already divides evenly into the total, each line just rounds with no adjustment', () => {
    const bd = fakeBreakdown([money(10, 10, 10), money(20, 20, 20)], money(30, 30, 30));
    const d = allocateDisplay(bd);
    expect(d.lines.map((l) => l.low)).toEqual([10, 20]);
    expect(d.lines.map((l) => l.high)).toEqual([10, 20]);
    expect(d.total.low).toBe(30);
    expect(d.total.high).toBe(30);
  });

  it('a positive difference goes to the largest fractional parts first (+1 to the largest fraction)', () => {
    // 10.6 + 10.6 + 10.6 = 31.8 → target = roundDollars(31.8) = 32 (< $1000, step $1);
    // floor sum = 30, difference 2, all three fractions are equal (0.6), ties broken by ascending index, so the first two get +1.
    const bd = fakeBreakdown(
      [money(10.6, 10.6, 10.6), money(10.6, 10.6, 10.6), money(10.6, 10.6, 10.6)],
      money(31.8, 31.8, 31.8),
    );
    const d = allocateDisplay(bd);
    expect(d.total.low).toBe(32);
    expect(d.lines.map((l) => l.low)).toEqual([11, 11, 10]);
    expect(d.lines.reduce((a, l) => a + l.low, 0)).toBe(d.total.low);
  });

  it('a target below the floor sum deducts from the smallest fractional parts first (negative-difference branch)', () => {
    // floor sum = 10+10+10 = 30; target is forced to 29 (hand-made data that does not line up with the total exactly, to reach this branch).
    const bd = fakeBreakdown([money(10.9, 10.9, 10.9), money(10.1, 10.1, 10.1), money(10.4, 10.4, 10.4)], money(29, 29, 29));
    const d = allocateDisplay(bd);
    expect(d.total.low).toBe(29);
    // Floor sum 30, target 29, difference -1: deduct 1 from the line with the smallest fraction (10.1, frac 0.1); the other two stay at their floors.
    expect(d.lines.map((l) => l.low)).toEqual([10, 9, 10]);
    expect(d.lines.reduce((a, l) => a + l.low, 0)).toBe(29);
  });

  it('a single line: the line itself equals the total', () => {
    const bd = fakeBreakdown([money(5.4, 5.4, 8.9)], money(5.4, 5.4, 8.9));
    const d = allocateDisplay(bd);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].low).toBe(d.total.low);
    expect(d.lines[0].high).toBe(d.total.high);
  });

  it('when low === high the range string collapses to one value (same collapsing rule as money.ts)', () => {
    const bd = fakeBreakdown([money(10, 10, 10), money(20, 20, 20)], money(30, 30, 30));
    const d = allocateDisplay(bd);
    expect(d.total.rangeText).toBe('$30');
    expect(d.lines[0].rangeText).toBe('$10');
  });

  it('when low !== high it uses the "$a – $b" format (en dash, for tables)', () => {
    const bd = fakeBreakdown([money(10, 15, 20), money(20, 30, 40)], money(30, 45, 60));
    const d = allocateDisplay(bd);
    expect(d.total.rangeText).toBe('$30 – $60');
  });
});

describe('allocateDisplay — step $10 (>= $1,000 end)', () => {
  it('when the target is not a multiple of the step from the line sum, lines round to the step and a small line may get $0 (honest about precision, row kept)', () => {
    // total.low = 2503 → roundDollars tests the threshold on the raw value 2503 >= 1000, step $10;
    // roundDollars(2503) = round(250.3)*10 = 2500. shares/10 = [0.3, 250], floor sum = 250 = target/10,
    // difference 0, neither line is adjusted: lines = [0, 2500], and the first honestly shows $0.
    const bd = fakeBreakdown([money(3, 3, 3), money(2500, 2500, 2500)], money(2503, 2503, 2503));
    const d = allocateDisplay(bd);
    expect(d.total.low).toBe(2500);
    expect(d.lines.map((l) => l.low)).toEqual([0, 2500]);
    expect(d.lines[0].lowText).toBe('$0');
    expect(d.lines.reduce((a, l) => a + l.low, 0)).toBe(d.total.low);
  });

  it('thousands separators: large whole-dollar values carry commas and are already rounded to the $10 step', () => {
    // total.low = 3234 >= 1000 → step $10, roundDollars(3234) = round(323.4)*10 = 3230.
    // shares/10 = [123.4, 200], floor sum = 323 = target/10 (3230/10), difference 0: lines = [1230, 2000].
    const bd = fakeBreakdown([money(1234, 1234, 1234), money(2000, 2000, 2000)], money(3234, 3234, 3234));
    const d = allocateDisplay(bd);
    expect(d.lines[0].lowText).toBe('$1,230');
    expect(d.total.lowText).toBe('$3,230');
  });

  it('matches the $10 step boundary of formatRange: 3604/3606/3608 each round independently to 3600/3610 (same case as money.test.ts)', () => {
    const total = money(3604, 3606, 3608);
    const bd = fakeBreakdown([money(1604, 1606, 1608), money(2000, 2000, 2000)], total);
    const d = allocateDisplay(bd);
    expect(d.total.rangeText).toBe(formatRange(total));
    expect(d.total.rangeText).toBe('$3,600 – $3,610');
  });
});

describe('allocateDisplay — identical to formatRange in money.ts, character for character', () => {
  const GOLDEN_TOTALS: Money[] = [
    money(3600, 4500, 5900), // the typical range from money.test.ts
    money(3604, 3606, 3608), // $10 step boundary
    money(214.6, 215, 215.4), // < $1000, both ends collapse to the same integer
    money(3601, 3602, 3604), // low === high after rounding, collapses to one value
    money(12345, 12345, 12345), // large amount + thousands separator
    money(1120, 1500, 2230), // the magnitude of a real 40 sq ft slab
  ];

  for (const total of GOLDEN_TOTALS) {
    it(`total=${JSON.stringify(total)}: total.rangeText of allocateDisplay === formatRange(total)`, () => {
      // Two arbitrary lines whose sum is about the total: here the total is simply split in half.
      // The assertion is about the total's display only and does not depend on how the lines are split.
      const bd = fakeBreakdown([money(total.low / 2, total.point / 2, total.high / 2), money(total.low / 2, total.point / 2, total.high / 2)], total);
      const d = allocateDisplay(bd);
      expect(d.total.rangeText).toBe(formatRange(total));
    });
  }
});

// ═══════════ 2. Consistency with the real model: every job kind x several sizes x option combinations ═══════════

interface Case {
  label: string;
  input: CostInput;
  cbsa: string;
}

const AREA_SIZES = [40, 120, 250, 600, 1500];
const CASES: Case[] = [];

for (const kind of ['slab', 'driveway', 'patio'] as const) {
  for (const areaSqFt of AREA_SIZES) {
    const base: AreaJob = { kind, areaSqFt, thicknessIn: 4 };
    CASES.push({ label: `${kind}@${areaSqFt}sf no options`, input: base, cbsa: 'US' });
  }
}

// Option combinations: one at a time, then all together, covering reinforcement/finish/pump/removeExisting/subbase.
const OPTION_COMBOS: AreaJob['options'][] = [
  { reinforcement: 'mesh' },
  { reinforcement: 'rebar' },
  { finish: 'stamped' },
  { finish: 'smooth' },
  { finish: 'exposed' },
  { pumpRequired: true },
  { removeExisting: true },
  { subbaseIn: 6 },
  { reinforcement: 'rebar', finish: 'stamped', pumpRequired: true, removeExisting: true, subbaseIn: 6 },
];
for (const areaSqFt of [40, 250, 1000]) {
  for (const options of OPTION_COMBOS) {
    CASES.push({
      label: `slab@${areaSqFt}sf options=${JSON.stringify(options)}`,
      input: { kind: 'slab', areaSqFt, thicknessIn: 4, options },
      cbsa: 'US',
    });
  }
}

for (const volumeCuYd of [2, 4, 5, 8, 12]) {
  const input: VolumeJob = { kind: 'volume', volumeCuYd };
  CASES.push({ label: `volume@${volumeCuYd}cuyd`, input, cbsa: 'US' });
}

for (const blockCount of [200, 500, 1000]) {
  const input: BlockJob = { kind: 'block', blockCount };
  CASES.push({ label: `block@${blockCount}`, input, cbsa: 'US' });
}

for (const lengthFt of [200, 500, 1000, 2000]) {
  const input: RebarJob = { kind: 'rebar', lengthFt, barSize: 4 };
  CASES.push({ label: `rebar@${lengthFt}ft`, input, cbsa: 'US' });
}

// Every metro in the sample data, to confirm the conclusion does not hold only for the national baseline.
for (const metro of rateTable.metros) {
  CASES.push({ label: `slab@250sf @ ${metro.name}`, input: { kind: 'slab', areaSqFt: 250, thicknessIn: 4 }, cbsa: metro.cbsa });
  CASES.push({ label: `rebar@500ft @ ${metro.name}`, input: { kind: 'rebar', lengthFt: 500, barSize: 4 }, cbsa: metro.cbsa });
}

describe('allocateDisplay — consistency with real estimate() output (line sums equal the total, and the total matches formatRange)', () => {
  it('matrix sanity check: covers all 6 job kinds, 40 sq ft, and several option combinations', () => {
    expect(CASES.some((c) => c.input.kind === 'slab' && 'areaSqFt' in c.input && c.input.areaSqFt === 40)).toBe(true);
    const kinds = new Set(CASES.map((c) => c.input.kind));
    expect(kinds).toEqual(new Set(['slab', 'driveway', 'patio', 'volume', 'block', 'rebar']));
  });

  for (const { label, input, cbsa } of CASES) {
    it(`${label} (${cbsa}): total matches formatRange, line sums equal the total exactly, every line within one step`, () => {
      const breakdown = estimate(input, rateCardFor(cbsa), jobParams);
      const display = allocateDisplay(breakdown);

      expect(display.total.rangeText).toBe(formatRange(breakdown.total));

      const sumLow = display.lines.reduce((a, l) => a + l.low, 0);
      const sumPoint = display.lines.reduce((a, l) => a + l.point, 0);
      const sumHigh = display.lines.reduce((a, l) => a + l.high, 0);
      expect(sumLow).toBe(display.total.low);
      expect(sumPoint).toBe(display.total.point);
      expect(sumHigh).toBe(display.total.high);

      const lowStep = stepFor(breakdown.total.low);
      const pointStep = stepFor(breakdown.total.point);
      const highStep = stepFor(breakdown.total.high);
      for (let i = 0; i < breakdown.lines.length; i++) {
        const original = breakdown.lines[i].amount;
        expect(Math.abs(display.lines[i].low - original.low)).toBeLessThan(lowStep);
        expect(Math.abs(display.lines[i].point - original.point)).toBeLessThan(pointStep);
        expect(Math.abs(display.lines[i].high - original.high)).toBeLessThan(highStep);
        // Every displayed row has low <= typical <= high (holds across this whole realistic size matrix;
        // only a tiny line smaller than one rounding step in a job of about 20 sq ft or less can be an
        // exception, see the header comment in breakdown-display.ts and the "very small jobs" section below).
        expect(display.lines[i].low).toBeLessThanOrEqual(display.lines[i].point);
        expect(display.lines[i].point).toBeLessThanOrEqual(display.lines[i].high);
      }
      expect(Math.abs(display.total.low - breakdown.total.low)).toBeLessThanOrEqual(lowStep);
      expect(Math.abs(display.total.point - breakdown.total.point)).toBeLessThanOrEqual(pointStep);
      expect(Math.abs(display.total.high - breakdown.total.high)).toBeLessThanOrEqual(highStep);
    });
  }
});

// ═══════════ 3. Typical (point) goes through the same allocation as low/high ═══════════

describe('allocateDisplay — typical (point) allocation', () => {
  it('line typicals sum to exactly the displayed total typical (hand-made shares that need a +1 adjustment)', () => {
    // point shares 10.6 × 3 = 31.8 → target 32, floor sum 30, difference 2, the first two get +1 (equal fractions, ties broken by index).
    const bd = fakeBreakdown(
      [money(9, 10.6, 12), money(9, 10.6, 12), money(9, 10.6, 12)],
      money(27, 31.8, 36),
    );
    const d = allocateDisplay(bd);
    expect(d.lines.map((l) => l.point)).toEqual([11, 11, 10]);
    expect(d.total.point).toBe(32);
    expect(d.lines.reduce((a, l) => a + l.point, 0)).toBe(d.total.point);
  });

  it('the step for point is decided by total.point itself, independent of the low/high ends (low < $1,000 <= point crossing the threshold)', () => {
    // total.low = 990 → step $1; total.point = 1,040 → step $10; total.high = 1,090 → step $10.
    const bd = fakeBreakdown([money(500, 520, 545), money(490, 520, 545)], money(990, 1040, 1090));
    const d = allocateDisplay(bd);
    expect(d.total.low).toBe(990);
    expect(d.total.point).toBe(1040);
    expect(d.total.high).toBe(1090);
    expect(d.lines.reduce((a, l) => a + l.low, 0)).toBe(990);
    expect(d.lines.reduce((a, l) => a + l.point, 0)).toBe(1040);
    expect(d.lines.reduce((a, l) => a + l.high, 0)).toBe(1090);
    expect(d.lines.every((l) => l.point % 10 === 0 && l.high % 10 === 0)).toBe(true);
  });

  it('typical never leaves the row\'s [low, high]: the finish row of a 40 sq ft slab with a smooth finish (raw $8.03 / $12 / $15.97, step $10)', () => {
    // A constant copy of real estimate() output (does not move with model parameters). With three
    // independent largest-remainder runs this row would get $10 / $20 / $10, which the page would
    // show as "$10 (typical ≈ $20)".
    const bd = fakeBreakdown(
      [
        money(803.27, 1200, 1596.73),
        money(155.21, 231.86, 308.52),
        money(147.3, 220.06, 292.81),
        money(8.03, 12, 15.97),
        money(14.35, 21.44, 28.53),
      ],
      money(1128.17, 1685.36, 2242.55),
    );
    const d = allocateDisplay(bd);
    const finish = d.lines[3];
    expect(finish.low).toBeLessThanOrEqual(finish.point);
    expect(finish.point).toBeLessThanOrEqual(finish.high);
    for (const line of d.lines) {
      expect(line.low).toBeLessThanOrEqual(line.point);
      expect(line.point).toBeLessThanOrEqual(line.high);
    }
    expect(d.lines.reduce((a, l) => a + l.point, 0)).toBe(d.total.point);
    expect(d.lines.reduce((a, l) => a + l.low, 0)).toBe(d.total.low);
    expect(d.lines.reduce((a, l) => a + l.high, 0)).toBe(d.total.high);
  });

  const GOLDEN: Money[] = [
    money(3600, 4500, 5900),
    money(3604, 3606, 3608),
    money(214.6, 215, 215.4),
    money(3601, 3602, 3604),
    money(1120, 1500, 2230),
  ];
  for (const total of GOLDEN) {
    it(`total=${JSON.stringify(total)}: rangeWithTypicalText is identical to formatRangeWithTypical in money.ts`, () => {
      const half = money(total.low / 2, total.point / 2, total.high / 2);
      const d = allocateDisplay(fakeBreakdown([half, half], total));
      expect(d.total.rangeWithTypicalText).toBe(formatRangeWithTypical(total));
    });
  }

  it('a line\'s rangeWithTypicalText = rangeText + " (typical ≈ " + pointText + ")", and the range collapses to one value when low==high', () => {
    const bd = fakeBreakdown([money(10, 10, 10), money(20, 20, 20)], money(30, 30, 30));
    const d = allocateDisplay(bd);
    expect(d.lines[0].rangeWithTypicalText).toBe('$10 (typical ≈ $10)');
    const bd2 = fakeBreakdown([money(10, 15, 20), money(20, 30, 40)], money(30, 45, 60));
    const d2 = allocateDisplay(bd2);
    expect(d2.lines[0].rangeWithTypicalText).toBe(`${d2.lines[0].rangeText} (typical ≈ ${d2.lines[0].pointText})`);
    expect(d2.lines[0].rangeWithTypicalText).toBe('$10 – $20 (typical ≈ $15)');
  });
});

/** Reads a displayed "$1,230" back into a number: the assertions are about the strings a user actually sees, not internal numbers. */
function readDollars(text: string): number {
  const m = /^\$([\d,]+)$/.exec(text);
  if (!m) throw new Error(`readDollars: not a whole-dollar string: ${text}`);
  return Number(m[1].replace(/,/g, ''));
}

describe('allocateDisplay — displayed strings of a line-item table: six typical inputs, low / typical / high each add up to the total', () => {
  const SCENARIOS: { label: string; input: CostInput }[] = [
    { label: '40 sq ft small slab', input: { kind: 'slab', areaSqFt: 40, thicknessIn: 4 } },
    { label: '1,000 sq ft slab (rounding each line on its own once came out $2–3 above the total)', input: { kind: 'slab', areaSqFt: 1000, thicknessIn: 4 } },
    {
      label: 'driveway with removal + pump',
      input: { kind: 'driveway', areaSqFt: 600, thicknessIn: 4, options: { removeExisting: true, pumpRequired: true } },
    },
    { label: 'volume 2 cu yd (with short-load fee)', input: { kind: 'volume', volumeCuYd: 2 } },
    { label: '500 blocks', input: { kind: 'block', blockCount: 500 } },
    { label: 'rebar 500 ft', input: { kind: 'rebar', lengthFt: 500, barSize: 4 } },
  ];

  for (const { label, input } of SCENARIOS) {
    it(`${label}: displayed line low / typical / high each add up to the displayed total`, () => {
      const breakdown = estimate(input, rateCardFor('US'), jobParams);
      const d = allocateDisplay(breakdown);

      const sums = { low: 0, point: 0, high: 0 };
      for (const line of d.lines) {
        sums.low += readDollars(line.lowText);
        sums.point += readDollars(line.pointText);
        sums.high += readDollars(line.highText);
      }
      expect(sums.low).toBe(readDollars(d.total.lowText));
      expect(sums.point).toBe(readDollars(d.total.pointText));
      expect(sums.high).toBe(readDollars(d.total.highText));

      // The displayed total is identical, character for character, to how the same Money is shown elsewhere.
      expect(d.total.rangeWithTypicalText).toBe(formatRangeWithTypical(breakdown.total));
    });
  }
});

describe('allocateDisplay — very small jobs (a known edge, documented, not a defect to fix)', () => {
  it('when a line is smaller than one rounding step, each end may give it $0 or one step, low <= typical <= high is not guaranteed, and the three sums stay exact', () => {
    // 5 sq ft slab: the total of about $900–$1,800 is past the $1,000 threshold, step $10, while the subbase is only a few dollars.
    const breakdown = estimate({ kind: 'slab', areaSqFt: 5, thicknessIn: 4 }, rateCardFor('US'), jobParams);
    const d = allocateDisplay(breakdown);
    expect(d.lines.reduce((a, l) => a + l.low, 0)).toBe(d.total.low);
    expect(d.lines.reduce((a, l) => a + l.point, 0)).toBe(d.total.point);
    expect(d.lines.reduce((a, l) => a + l.high, 0)).toBe(d.total.high);
    const subbase = d.lines.find((l) => l.key === 'subbase');
    expect(subbase).toBeDefined();
    // This line's raw value is only a few dollars, far below the $10 step: its typical can only be $0 or $10, still within one step of the raw value.
    expect([0, 10]).toContain(subbase!.point);
  });
});
