/**
 * Bag counts for 80 lb bagged concrete.
 *
 * Two groups of assertions:
 * 1. The constants and the algorithm itself (1 / 2 / 5 cu yd, etc.);
 * 2. The text (plural, "less than one bag", thousands separators).
 */
import { describe, expect, it } from 'vitest';
import { BAGS_PER_CU_YD, BAG_YIELD_CU_FT, bagsForCuYd, formatBagsLine } from '../src/bags';

describe('bags — constants', () => {
  it('80 lb bag: 0.6 cu ft per bag, 45 bags per cu yd', () => {
    expect(BAG_YIELD_CU_FT).toBe(0.6);
    expect(BAGS_PER_CU_YD).toBe(45);
    expect(BAGS_PER_CU_YD).toBe(Math.round(27 / BAG_YIELD_CU_FT));
  });
});

describe('bags — bagsForCuYd', () => {
  it.each([
    [1, 45],
    [2, 90],
    [5, 225],
    [10, 450],
    [0.5, 23], // 22.5 → rounds to 23
    [2.5, 113], // 112.5 → 113
    [1.234, 56], // 55.53
  ])('%s cu yd → %s bags', (cuYd, expected) => {
    expect(bagsForCuYd(cuYd)).toBe(expected);
  });

  it('no waste allowance: bag count is volume × bags per cu yd, rounded, with no 5% waste factor applied', () => {
    expect(bagsForCuYd(5)).toBe(5 * BAGS_PER_CU_YD);
    expect(bagsForCuYd(5)).not.toBe(Math.round(5 * BAGS_PER_CU_YD * 1.05));
  });

  it('never negative or NaN for zero or tiny volumes', () => {
    expect(bagsForCuYd(0)).toBe(0);
    expect(bagsForCuYd(0.01)).toBe(0); // 0.45 bag
    expect(Number.isFinite(bagsForCuYd(50_000))).toBe(true);
  });
});

describe('bags — formatBagsLine', () => {
  it('regular: About N bags of 80-lb concrete (0.6 cu ft each, no waste allowance)', () => {
    expect(formatBagsLine(5)).toBe('About 225 bags of 80-lb concrete (0.6 cu ft each, no waste allowance)');
  });

  it('thousands separators', () => {
    expect(formatBagsLine(50_000)).toBe('About 2,250,000 bags of 80-lb concrete (0.6 cu ft each, no waste allowance)');
  });

  it('exactly one bag uses the singular', () => {
    // 1 bag = 1/45 cu yd ≈ 0.0222
    expect(formatBagsLine(1 / BAGS_PER_CU_YD)).toBe('About 1 bag of 80-lb concrete (0.6 cu ft each, no waste allowance)');
  });

  it('under half a bag reads "Less than one bag", never "About 0"', () => {
    expect(formatBagsLine(0.01)).toBe('Less than one bag of 80-lb concrete (0.6 cu ft each, no waste allowance)');
    expect(formatBagsLine(0.01)).not.toContain('About 0');
  });

  it('gives a bag count only, with no dollar amount', () => {
    for (const v of [0.01, 1, 2, 5, 50_000]) {
      expect(formatBagsLine(v)).not.toContain('$');
    }
  });
});
