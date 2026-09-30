import { describe, expect, it } from 'vitest';
import { formatRange, formatRangeParts, formatRangeWithTypical, formatUnitRange, formatUnitRangeWithTypical, formatRangeText, formatUnitRangeText, formatSpanText } from '../src/money';
import type { Money } from '../src/types';

function money(low: number, point: number, high: number): Money {
  return { low, point, high };
}

describe('formatRange', () => {
  it('formats a typical total range with $1,000+ values already on the $10 grid', () => {
    expect(formatRange(money(3600, 4500, 5900))).toBe('$3,600 – $5,900');
  });

  it('rounds values ≥ $1,000 to the nearest $10', () => {
    // 3604 → 3600, 3608 → 3610 (independent rounding per value, see money.ts comment)
    expect(formatRange(money(3604, 3606, 3608))).toBe('$3,600 – $3,610');
  });

  it('rounds values < $1,000 to the nearest $1', () => {
    expect(formatRange(money(214.6, 215, 215.4))).toBe('$215'); // both round to 215 → collapses
  });

  it('collapses to a single value when low and high round to the same figure', () => {
    // 3601 and 3604 both round to 3600 on the $10 grid, even though they differ pre-rounding.
    expect(formatRange(money(3601, 3602, 3604))).toBe('$3,600');
  });

  it('formats thousands separators for large totals', () => {
    expect(formatRange(money(12345, 12345, 12345))).toBe('$12,350');
  });
});

describe('formatRangeWithTypical', () => {
  it('appends the rounded center estimate after the range', () => {
    expect(formatRangeWithTypical(money(3600, 4500, 5900))).toBe('$3,600 – $5,900 (typical ≈ $4,500)');
  });

  it('still shows a range even when it collapses to one figure', () => {
    expect(formatRangeWithTypical(money(215, 215, 215))).toBe('$215 (typical ≈ $215)');
  });
});

describe('formatRangeParts', () => {
  it('splits into the same range string formatRange would produce, plus a separate typical field', () => {
    const m = money(3600, 4500, 5900);
    expect(formatRangeParts(m)).toEqual({ range: formatRange(m), typical: 'typical ≈ $4,500' });
  });

  it('still includes a range even when it collapses to one figure (never a bare point)', () => {
    const m = money(215, 215, 215);
    const parts = formatRangeParts(m);
    expect(parts.range).toBe('$215');
    expect(parts.typical).toBe('typical ≈ $215');
  });
});

describe('formatUnitRange', () => {
  it('formats per-unit prices with exactly two decimals, no rounding to $1/$10', () => {
    expect(formatUnitRange(money(9, 11.5, 14.75))).toBe('$9.00 – $14.75');
  });

  it('collapses to a single value when low === high', () => {
    expect(formatUnitRange(money(12, 12, 12))).toBe('$12.00');
  });
});

describe('formatUnitRangeWithTypical', () => {
  it('appends the unrounded-to-dollar center estimate with two decimals', () => {
    expect(formatUnitRangeWithTypical(money(9, 11.5, 14.75))).toBe('$9.00 – $14.75 (typical ≈ $11.50)');
  });
});

describe('formatRangeText / formatUnitRangeText (prose ranges, no dash)', () => {
  it('joins the two ends with "to", using the same rounding as formatRange', () => {
    expect(formatRangeText(money(3604, 3606, 3608))).toBe('$3,600 to $3,610');
    expect(formatUnitRangeText(money(9, 11.5, 14.75))).toBe('$9.00 to $14.75');
  });

  it('collapses to a single value when both ends round to the same figure', () => {
    expect(formatRangeText(money(3601, 3602, 3604))).toBe('$3,600');
  });
});

describe('formatSpanText (prose span across two estimates)', () => {
  it('uses the low end of the first and the high end of the second', () => {
    expect(formatSpanText(money(2044, 2800, 3620), money(3470, 4800, 6166))).toBe('$2,040 to $6,170');
  });
});
