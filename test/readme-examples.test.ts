/**
 * Pins the numbers quoted in README.md, so the README cannot drift from what the code produces.
 * If a parameter or the sample data changes on purpose, update these strings and the README together.
 */
import { describe, expect, it } from 'vitest';
import { allocateDisplay } from '../src/breakdown-display';
import { buildRateCard, estimate } from '../src/model';
import { formatRange, formatUnitRange } from '../src/money';
import { JOB_PARAMS } from '../src/params';
import type { RateTable } from '../src/types';
import rates from '../examples/rates.sample.json';

const table = rates as unknown as RateTable;

function slab(areaSqFt: number, cbsa: string) {
  const card = buildRateCard(table, cbsa);
  if (!card) throw new Error(`unknown CBSA ${cbsa}`);
  return estimate({ kind: 'slab', areaSqFt, thicknessIn: 4 }, card, JOB_PARAMS);
}

describe('README examples', () => {
  it('slab, national, 4 in: 40 sq ft vs 400 sq ft', () => {
    const small = slab(40, 'US');
    expect(formatRange(small.total)).toBe('$1,120 – $2,230');
    expect(formatUnitRange(small.perUnit)).toBe('$28.00 – $55.66');
    const large = slab(400, 'US');
    expect(formatRange(large.total)).toBe('$3,010 – $5,990');
    expect(formatUnitRange(large.perUnit)).toBe('$7.53 – $14.97');
  });

  it('a linear area × price rate taken from the 400 sq ft job is far below the model at 40 sq ft', () => {
    const linearTypical = 40 * slab(400, 'US').perUnit.point;
    expect(linearTypical).toBeCloseTo(450, 0);
    expect(slab(40, 'US').total.point / linearTypical).toBeGreaterThan(3.7);
  });

  it('the same 400 sq ft slab changes with location', () => {
    expect(formatRange(slab(400, 'US').total)).toBe('$3,010 – $5,990');
    expect(formatRange(slab(400, '26420').total)).toBe('$2,750 – $5,500');
    expect(formatRange(slab(400, '42660').total)).toBe('$3,320 – $7,770');
    expect(formatRange(slab(400, '18140').total)).toBe('$3,140 – $6,490');
  });

  it('quick-start snippet: Houston line items', () => {
    const display = allocateDisplay(slab(400, '26420'));
    expect(display.total.rangeWithTypicalText).toBe('$2,750 – $5,500 (typical ≈ $4,130)');
    expect(display.lines.map((l) => `${l.label} | ${l.rangeText}`)).toEqual([
      'Mobilization (site setup & delivery) | $800 – $1,600',
      'Concrete material (incl. forms) | $580 – $1,170',
      'Labor & placement | $1,230 – $2,450',
      'Subbase (4 in) | $140 – $280',
    ]);
  });
});
