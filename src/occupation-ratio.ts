/**
 * Wage ratios for the substitute occupations.
 *
 * Kept in its own file so that `model.ts` depends only on this one object rather than on the whole
 * `JOB_PARAMS` table. `params.ts` re-exports it.
 */
import type { Tracked } from './types';

// Metros with no data for SOC 47-2051 (cement masons) use another occupation as a substitute, and
// occupations differ in pay: using construction laborers' wage as if it were a mason's wage would
// understate labor by about 12% in those metros, while using first-line supervisors' wage would
// overstate it by about 43% (e.g. Eagle Pass, TX).
// Each ratio is the **within-metro** median over the 336 metros where both occupations have data
// (never compared across metros, so "small metros are cheaper" does not leak into the occupation
// difference). Data: BLS OEWS 2025-05, mean hourly wage.
// Usage: substitute-metro wage × ratio ≈ the cement-mason wage for that metro.

export const OCCUPATION_WAGE_RATIO: Record<'SOC 47-2061' | 'SOC 47-1011', Tracked<number>> = {
  'SOC 47-2061': {
    value: 1.1373,
    prov: {
      level: 'calibrated',
      source: 'Derived by ConcreteCostCalc from BLS OEWS',
      ref: 'SOC 47-2051 ÷ SOC 47-2061, same-metro pairs',
      asOf: '2025-05',
      geo: 'national',
      note: 'Median ratio of mean hourly wages across 336 metros with data for both occupations; P25-P75 1.088-1.198',
    },
  },
  'SOC 47-1011': {
    value: 0.6965,
    prov: {
      level: 'calibrated',
      source: 'Derived by ConcreteCostCalc from BLS OEWS',
      ref: 'SOC 47-2051 ÷ SOC 47-1011, same-metro pairs',
      asOf: '2025-05',
      geo: 'national',
      note: 'Median ratio of mean hourly wages across 336 metros with data for both occupations; P25-P75 0.657-0.734',
    },
  },
};
