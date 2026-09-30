/**
 * Tests mechanics only (formula structure, notices, null, exhaustiveness, boundary steps), not where prices land.
 * Everything uses simple hand-made parameters (defined in this file, never the real `JOB_PARAMS`), and expected
 * values are recomputed in the test with the same formula as model.ts, not made-up numbers or numbers
 * back-solved from an acceptance range.
 *
 * The one exception is `OCCUPATION_WAGE_RATIO` (imported from `../src/params`): it is the wage ratio for substitute
 * occupations, a structural part of the formula rather than a parameter awaiting calibration, so the real constant is
 * used directly, but expectations always use its `.value` dynamically and never a literal like 1.1373, so
 * changing that value does not break these tests.
 */
import { describe, expect, it } from 'vitest';
import { buildRateCard, estimate, formworkPerimeterFt } from '../src/model';
import { OCCUPATION_WAGE_RATIO } from '../src/params';
import type {
  AreaJob,
  AreaJobExtras,
  CostBreakdown,
  CostInput,
  Finish,
  JobParams,
  JobParamsByKind,
  MetroRate,
  ParamLevel,
  Provenance,
  RateCard,
  RateTable,
  Reinforcement,
  Tracked,
} from '../src/types';

// ═══════════ Test helper: hand-made Tracked<number> ═══════════

function tracked(value: number, level: ParamLevel = 'assumed', extra: Partial<Provenance> = {}): Tracked<number> {
  return { value, prov: { level, source: 'test fixture', asOf: '2026-01', ...extra } };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ═══════════ Hand-made RateTable: national + 4 metros, covering combinations of substitution / fallback / no percentiles ═══════════

const NATIONAL_METRO: MetroRate = {
  cbsa: 'US',
  name: 'United States (test national)',
  state: null,
  wageHourly: tracked(20, 'sourced', { ref: 'SOC 47-2051', geo: 'national' }),
  wageP25: tracked(16, 'sourced', { ref: 'SOC 47-2051 P25', geo: 'national' }),
  wageP75: tracked(24, 'sourced', { ref: 'SOC 47-2051 P75', geo: 'national' }),
  materialRegion: 'US',
};

const MARKET_DISPERSION = tracked(0.15, 'calibrated', { note: 'test market dispersion' });

const NATIONAL_RATE_CARD: RateCard = {
  metro: NATIONAL_METRO,
  laborBurden: tracked(1.5, 'calibrated'),
  quoteMultiplier: tracked(2, 'calibrated'),
  materialPerCuYd: tracked(100, 'sourced'),
  regionFactor: tracked(1, 'assumed', { geo: 'national' }),
  dispersion: MARKET_DISPERSION,
};

/** An ordinary metro: has its own SOC 47-2051 data (no substitution) and wage percentiles. */
const METRO_SOUTH: MetroRate = {
  cbsa: '10001',
  name: 'Southville, TX',
  state: 'TX',
  wageHourly: tracked(25, 'sourced', { ref: 'SOC 47-2051', geo: 'metro' }),
  wageP25: tracked(20, 'sourced', { ref: 'SOC 47-2051 P25', geo: 'metro' }),
  wageP75: tracked(30, 'sourced', { ref: 'SOC 47-2051 P75', geo: 'metro' }),
  materialRegion: 'S',
};

/** A substituted metro (SOC 47-2061 construction laborers), with wage percentiles. */
const METRO_SUBSTITUTED: MetroRate = {
  cbsa: '20002',
  name: 'Substituteville, OH',
  state: 'OH',
  wageHourly: tracked(40, 'sourced', { ref: 'SOC 47-2061', geo: 'metro', note: 'original wage note' }),
  wageP25: tracked(32, 'sourced', { ref: 'SOC 47-2061 P25', geo: 'metro' }),
  wageP75: tracked(48, 'sourced', { ref: 'SOC 47-2061 P75', geo: 'metro' }),
  materialRegion: 'MW',
};

/** Not substituted, but a geographic fallback happened (metro → state), and there are no wage percentiles. */
const METRO_GEO_FALLBACK_ONLY: MetroRate = {
  cbsa: '30003',
  name: 'Fallbackville, ND',
  state: 'ND',
  wageHourly: tracked(22, 'sourced', { ref: 'SOC 47-2051', geo: 'state', fellBackFrom: 'metro', note: 'geo fallback note' }),
  materialRegion: 'MW',
};

/** Substitution and geographic fallback at once (a synthetic version of the worst case, e.g. Eagle Pass), no wage percentiles. */
const METRO_BOTH_SIGNALS: MetroRate = {
  cbsa: '40004',
  name: 'Bothville, WY',
  state: 'WY',
  wageHourly: tracked(35, 'sourced', { ref: 'SOC 47-1011', geo: 'state', fellBackFrom: 'metro' }),
  materialRegion: 'W',
};

const REGION_FACTORS: RateTable['regionFactors'] = {
  US: tracked(1, 'assumed', { geo: 'national' }),
  NE: tracked(1.1, 'sourced', { geo: 'region' }),
  MW: tracked(1.05, 'sourced', { geo: 'region' }),
  S: tracked(0.95, 'sourced', { geo: 'region' }),
  W: tracked(1.2, 'sourced', { geo: 'region' }),
};

const TEST_RATE_TABLE: RateTable = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  national: NATIONAL_RATE_CARD,
  metros: [METRO_SOUTH, METRO_SUBSTITUTED, METRO_GEO_FALLBACK_ONLY, METRO_BOTH_SIGNALS],
  regionFactors: REGION_FACTORS,
};

// A second table where "market" ranks higher than "wage" (sourced vs assumed), to verify minLevel does not care which side is which.
const NATIONAL_RATE_CARD_SOURCED_MARKET: RateCard = { ...NATIONAL_RATE_CARD, dispersion: tracked(0.15, 'sourced') };
const METRO_WEAK_WAGE_LEVEL: MetroRate = {
  cbsa: '50005',
  name: 'Weaklevelville, CA',
  state: 'CA',
  wageHourly: tracked(28, 'sourced', { ref: 'SOC 47-2051', geo: 'metro' }),
  wageP25: tracked(20, 'assumed', { geo: 'metro' }),
  wageP75: tracked(36, 'sourced', { geo: 'metro' }),
  materialRegion: 'W',
};
const TEST_RATE_TABLE_WEAK_WAGE: RateTable = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  national: NATIONAL_RATE_CARD_SOURCED_MARKET,
  metros: [METRO_WEAK_WAGE_LEVEL],
  regionFactors: REGION_FACTORS,
};

// ═══════════ Hand-made JobParamsByKind ═══════════

const AREA_EXTRAS_TEST: AreaJobExtras = {
  reinforcement: { none: tracked(0), mesh: tracked(2, 'calibrated'), rebar: tracked(3, 'calibrated') },
  finish: { broom: tracked(0), smooth: tracked(1), stamped: tracked(4, 'calibrated'), exposed: tracked(3, 'calibrated') },
  subbase: tracked(0.5),
  demolition: tracked(1.5),
  pump: tracked(200, 'calibrated'),
};

const AREA_JOB_PARAMS_TEST: JobParams & { areaExtras: AreaJobExtras; forms: Tracked<number>; defaultSubbaseIn: Tracked<number> } = {
  mobilization: tracked(1000, 'calibrated'),
  wasteFactor: tracked(1.1),
  crewUnitsPerHour: tracked(10), // sq ft / worker-hour
  areaExtras: AREA_EXTRAS_TEST,
  forms: tracked(3, 'calibrated'), // $/lin ft
  defaultSubbaseIn: tracked(4), // in
};

/** Area (sq ft) → perimeter (ft) under the square assumption; the same formula as `4 * Math.sqrt(areaSqFt)` in model.ts. */
function squarePerimeterFt(areaSqFt: number): number {
  return 4 * Math.sqrt(areaSqFt);
}

const JOB_PARAMS_TEST: JobParamsByKind = {
  slab: AREA_JOB_PARAMS_TEST,
  driveway: AREA_JOB_PARAMS_TEST,
  patio: AREA_JOB_PARAMS_TEST,
  volume: {
    mobilization: tracked(999999), // Volume jobs must not read it: deliberately absurdly large, so the total would explode if it were read
    wasteFactor: tracked(1.05),
    crewUnitsPerHour: tracked(0.0000001), // Volume jobs must not read it: labor would become astronomical if it were read
    shortLoadThresholdCuYd: tracked(5),
    shortLoadFee: tracked(75, 'calibrated'),
  },
  block: {
    mobilization: tracked(300, 'calibrated'),
    wasteFactor: tracked(1.02),
    crewUnitsPerHour: tracked(20), // block / worker-hour
    unitMaterial: tracked(2),
  },
  rebar: {
    mobilization: tracked(200, 'calibrated'),
    wasteFactor: tracked(1.03),
    crewUnitsPerHour: tracked(100), // lin ft / worker-hour
    unitMaterial: tracked(0.5),
  },
};

/**
 * Expected values for area jobs, computed here. The formula is involved (the material line folds in forms and,
 * when it applies, a short-load fee, and subbase is present by default), so it is computed in one place to avoid
 * every test deriving it by hand and tripping over the others. Mirrors the estimateAreaJob/addAreaExtras
 * formulas in model.ts but is implemented independently (it does not import model.ts internals).
 */
function expectedAreaBreakdown(areaSqFt: number, thicknessIn: number, opts: { subbaseIn?: number } = {}) {
  const params = AREA_JOB_PARAMS_TEST;
  const rates = NATIONAL_RATE_CARD;
  const volumeParams = JOB_PARAMS_TEST.volume;

  const cuYd = (areaSqFt * (thicknessIn / 12)) / 27;
  const orderedCuYd = cuYd * params.wasteFactor.value;
  const concreteMaterial = orderedCuYd * rates.materialPerCuYd.value * rates.regionFactor.value;
  const formsCost = squarePerimeterFt(areaSqFt) * params.forms.value;
  const isShortLoad = orderedCuYd < volumeParams.shortLoadThresholdCuYd.value;
  const shortLoadFee = isShortLoad ? volumeParams.shortLoadFee.value : 0;
  const materialTotal = concreteMaterial + formsCost + shortLoadFee;

  const labor =
    (areaSqFt / params.crewUnitsPerHour.value) * rates.metro.wageHourly.value * rates.laborBurden.value * rates.quoteMultiplier.value;
  const mobilization = params.mobilization.value;

  const subbaseIn = opts.subbaseIn ?? params.defaultSubbaseIn.value;
  const subbase = subbaseIn > 0 ? AREA_EXTRAS_TEST.subbase.value * areaSqFt * subbaseIn : 0;

  const total = mobilization + materialTotal + labor + subbase;
  return { cuYd, orderedCuYd, concreteMaterial, formsCost, isShortLoad, shortLoadFee, materialTotal, labor, mobilization, subbaseIn, subbase, total };
}

// ═══════════ 1. Area jobs: formula structure ═══════════
// Uses areaSqFt=1000 (large enough) as the baseline input for the "formula structure" tests, so the actual ordered volume
// (cuYd × wasteFactor) stays well above shortLoadThresholdCuYd=5 and triggers no short-load fee. The short-load fee is
// tested separately in section 1c with small sizes, so the two concerns stay apart and the assertions stay clean.

describe('estimate — area jobs (slab/driveway/patio): formula structure', () => {
  const input: AreaJob = { kind: 'slab', areaSqFt: 1000, thicknessIn: 4 };

  it('with no options: mobilization + material + labor + (default) subbase lines, amounts match the hand-computed formula', () => {
    const result = estimate(input, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const expected = expectedAreaBreakdown(input.areaSqFt, input.thicknessIn);
    expect(expected.isShortLoad).toBe(false); // Precondition: this test isolates the base shape with no short-load fee

    expect(result.lines.map((l) => l.key)).toEqual(['mobilization', 'material', 'labor', 'subbase']);
    expect(result.lines[0].amount.point).toBeCloseTo(round2(expected.mobilization), 2);
    expect(result.lines[1].amount.point).toBeCloseTo(round2(expected.materialTotal), 2);
    expect(result.lines[2].amount.point).toBeCloseTo(round2(expected.labor), 2);
    expect(result.lines[3].amount.point).toBeCloseTo(round2(expected.subbase), 2);
    expect(result.total.point).toBeCloseTo(round2(expected.total), 2);
    expect(result.perUnit.point).toBeCloseTo(round2(expected.total / input.areaSqFt), 2);
    expect(result.unit).toBe('sqft');
    expect(result.quantity).toBe(input.areaSqFt);
  });

  it('Money invariants: low < point < high on both total and perUnit when dispersion > 0', () => {
    const result = estimate(input, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(result.total.low).toBeLessThan(result.total.point);
    expect(result.total.point).toBeLessThan(result.total.high);
    expect(result.perUnit.low).toBeLessThan(result.perUnit.point);
    expect(result.perUnit.point).toBeLessThan(result.perUnit.high);
  });

  it('each line carries the Provenance of every param it used (feeds an expandable source panel)', () => {
    const result = estimate(input, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const labor = result.lines.find((l) => l.key === 'labor')!;
    expect(labor.inputs).toContain(AREA_JOB_PARAMS_TEST.crewUnitsPerHour.prov);
    expect(labor.inputs).toContain(NATIONAL_RATE_CARD.metro.wageHourly.prov);
    expect(labor.inputs).toContain(NATIONAL_RATE_CARD.laborBurden.prov);
    expect(labor.inputs).toContain(NATIONAL_RATE_CARD.quoteMultiplier.prov);

    const material = result.lines.find((l) => l.key === 'material')!;
    expect(material.inputs).toContain(AREA_JOB_PARAMS_TEST.wasteFactor.prov);
    expect(material.inputs).toContain(NATIONAL_RATE_CARD.materialPerCuYd.prov);
    expect(material.inputs).toContain(NATIONAL_RATE_CARD.regionFactor.prov);
    expect(material.inputs).toContain(AREA_JOB_PARAMS_TEST.forms.prov);

    const subbase = result.lines.find((l) => l.key === 'subbase')!;
    expect(subbase.inputs).toContain(AREA_EXTRAS_TEST.subbase.prov);
    expect(subbase.inputs).toContain(AREA_JOB_PARAMS_TEST.defaultSubbaseIn.prov); // The default was actually used
  });
});

// ═══════════ 1a. Form material: priced by perimeter (square assumed), folded into the 'material' line ═══════════

describe('estimate — area jobs: forms priced by perimeter, folded into the material line', () => {
  it('forms cost = 4·√area × forms rate, added on top of the concrete material amount', () => {
    const areaSqFt = 1000; // Large enough to trigger no short-load fee, isolating forms itself
    const result = estimate({ kind: 'slab', areaSqFt, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const material = result.lines.find((l) => l.key === 'material')!;
    const expected = expectedAreaBreakdown(areaSqFt, 4);
    expect(expected.isShortLoad).toBe(false);

    expect(material.amount.point).toBeCloseTo(round2(expected.concreteMaterial + expected.formsCost), 2);
    expect(expected.formsCost).toBeCloseTo(squarePerimeterFt(areaSqFt) * AREA_JOB_PARAMS_TEST.forms.value, 6);
    expect(material.label).toContain('forms');
  });

  it('a larger area (bigger perimeter) adds proportionally more forms cost — not a flat fee', () => {
    const small = estimate({ kind: 'slab', areaSqFt: 400, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const big = estimate({ kind: 'slab', areaSqFt: 1600, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    // Area ×4 → perimeter ×2 under the square assumption → forms cost ×2 (the concrete material cost also goes ×4, so total material
    // cannot be compared directly; instead subtract the pure concrete part from each to isolate the forms component, which grows with perimeter rather than area).
    const smallExpected = expectedAreaBreakdown(400, 4);
    const bigExpected = expectedAreaBreakdown(1600, 4);
    const smallForms = small.lines.find((l) => l.key === 'material')!.amount.point - round2(smallExpected.concreteMaterial);
    const bigForms = big.lines.find((l) => l.key === 'material')!.amount.point - round2(bigExpected.concreteMaterial);
    expect(bigForms).toBeCloseTo(smallForms * 2, 0);
  });
});

// ═══════════ 1a'. Form perimeter: the real rectangle's perimeter when length and width are given, else the square fallback ═══════════

describe('estimate — area jobs: forms use the real rectangle perimeter when length and width are given', () => {
  const formsRate = AREA_JOB_PARAMS_TEST.forms.value;
  const materialPoint = (input: AreaJob) =>
    estimate(input, NATIONAL_RATE_CARD, JOB_PARAMS_TEST).lines.find((l) => l.key === 'material')!.amount.point;

  it('a non-square rectangle prices forms at 2×(L+W), not 4√area', () => {
    const areaOnly: AreaJob = { kind: 'driveway', areaSqFt: 800, thicknessIn: 4 };
    const withDims: AreaJob = { ...areaOnly, lengthFt: 20, widthFt: 40 };
    const realPerimeter = 2 * (20 + 40);
    const expectedDelta = (realPerimeter - squarePerimeterFt(800)) * formsRate;
    expect(expectedDelta).toBeGreaterThan(0); // A long, narrow shape: the real perimeter is longer than a square of the same area
    expect(materialPoint(withDims) - materialPoint(areaOnly)).toBeCloseTo(expectedDelta, 1);
    expect(formworkPerimeterFt(withDims)).toBe(realPerimeter);
  });

  it('only the material line changes; every other line and the per-unit figure follow the total', () => {
    const areaOnly: AreaJob = { kind: 'slab', areaSqFt: 240, thicknessIn: 4 };
    const withDims: AreaJob = { ...areaOnly, lengthFt: 12, widthFt: 20 };
    const a = estimate(areaOnly, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const b = estimate(withDims, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    for (const line of a.lines) {
      if (line.key === 'material') continue;
      expect(b.lines.find((l) => l.key === line.key)!.amount).toEqual(line.amount);
    }
    expect(b.total.point).toBeGreaterThan(a.total.point);
    expect(b.quantity).toBe(a.quantity);
  });

  it('a square gives the same result with or without length and width', () => {
    for (const side of [8, 10, 20, 24, 30]) {
      const areaOnly: AreaJob = { kind: 'patio', areaSqFt: side * side, thicknessIn: 4 };
      const withDims: AreaJob = { ...areaOnly, lengthFt: side, widthFt: side };
      expect(estimate(withDims, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).toEqual(
        estimate(areaOnly, NATIONAL_RATE_CARD, JOB_PARAMS_TEST),
      );
    }
  });

  it('applies to slab, driveway and patio alike', () => {
    for (const kind of ['slab', 'driveway', 'patio'] as const) {
      const areaOnly: AreaJob = { kind, areaSqFt: 320, thicknessIn: 4 };
      const withDims: AreaJob = { ...areaOnly, lengthFt: 16, widthFt: 20 };
      expect(materialPoint(withDims)).toBeGreaterThan(materialPoint(areaOnly));
    }
  });

  it('length and width must both be given: one alone falls back to the square perimeter', () => {
    const base: AreaJob = { kind: 'slab', areaSqFt: 240, thicknessIn: 4 };
    expect(formworkPerimeterFt({ ...base, lengthFt: 12 })).toBe(squarePerimeterFt(240));
    expect(formworkPerimeterFt({ ...base, widthFt: 20 })).toBe(squarePerimeterFt(240));
  });

  it('non-positive or non-finite dimensions fall back to the square perimeter', () => {
    const base: AreaJob = { kind: 'slab', areaSqFt: 240, thicknessIn: 4 };
    for (const [lengthFt, widthFt] of [
      [0, 240],
      [-12, -20],
      [Number.NaN, 20],
      [Number.POSITIVE_INFINITY, 20],
    ]) {
      expect(formworkPerimeterFt({ ...base, lengthFt, widthFt })).toBe(squarePerimeterFt(240));
    }
  });

  it('dimensions that disagree with the area are ignored — the area wins', () => {
    const base: AreaJob = { kind: 'slab', areaSqFt: 240, thicknessIn: 4 };
    // 10×10 = 100 ≠ 240: the dimensions are not trusted, and no error is thrown.
    expect(formworkPerimeterFt({ ...base, lengthFt: 10, widthFt: 10 })).toBe(squarePerimeterFt(240));
    expect(() => estimate({ ...base, lengthFt: 10, widthFt: 10 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).not.toThrow();
  });

  it('dimensions within 1% of the area still count (rounded inputs)', () => {
    const base: AreaJob = { kind: 'slab', areaSqFt: 240.5, thicknessIn: 4 };
    expect(formworkPerimeterFt({ ...base, lengthFt: 12, widthFt: 20 })).toBe(64);
  });
});

// ═══════════ 1b. Crushed-stone subbase: defaultSubbaseIn by default, an explicit subbaseIn overrides it ═══════════

describe('estimate — area jobs: default gravel subbase vs explicit subbaseIn', () => {
  it('no options.subbaseIn: a subbase line appears using defaultSubbaseIn, with its Provenance in inputs', () => {
    const areaSqFt = 1000;
    const result = estimate({ kind: 'slab', areaSqFt, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const subbase = result.lines.find((l) => l.key === 'subbase')!;
    const expected = AREA_EXTRAS_TEST.subbase.value * areaSqFt * AREA_JOB_PARAMS_TEST.defaultSubbaseIn.value;
    expect(subbase.amount.point).toBeCloseTo(round2(expected), 2);
    expect(subbase.inputs).toContain(AREA_JOB_PARAMS_TEST.defaultSubbaseIn.prov);
  });

  it('explicit options.subbaseIn overrides the default thickness, and defaultSubbaseIn no longer appears in inputs', () => {
    const areaSqFt = 1000;
    const result = estimate(
      { kind: 'slab', areaSqFt, thicknessIn: 4, options: { subbaseIn: 6 } },
      NATIONAL_RATE_CARD,
      JOB_PARAMS_TEST,
    );
    const subbase = result.lines.find((l) => l.key === 'subbase')!;
    const expected = AREA_EXTRAS_TEST.subbase.value * areaSqFt * 6;
    expect(subbase.amount.point).toBeCloseTo(round2(expected), 2);
    expect(subbase.inputs).toContain(AREA_EXTRAS_TEST.subbase.prov);
    expect(subbase.inputs).not.toContain(AREA_JOB_PARAMS_TEST.defaultSubbaseIn.prov); // The default was not used this time
  });
});

// ═══════════ 1c. Short-load fee for area jobs: reuses the two volume parameters, judged on the actual ordered volume ═══════════

describe('estimate — area jobs: small-load surcharge reusing volume.shortLoadThresholdCuYd/shortLoadFee', () => {
  // Solve for the areaSqFt that sits exactly on the threshold: orderedCuYd = areaToCuYd(area,4) × wasteFactor = threshold
  // ⇒ areaToCuYd = threshold/wasteFactor ⇒ area = areaToCuYd × 27 × 12 / thicknessIn = (threshold/wasteFactor) × 81 (when thicknessIn=4).
  const threshold = JOB_PARAMS_TEST.volume.shortLoadThresholdCuYd.value;
  const atThresholdAreaSqFt = (threshold / AREA_JOB_PARAMS_TEST.wasteFactor.value) * 81;

  function materialLineOf(areaSqFt: number) {
    return estimate({ kind: 'slab', areaSqFt, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST).lines.find(
      (l) => l.key === 'material',
    )!;
  }

  it('strictly below the threshold: short load fee is folded into the material line', () => {
    const material = materialLineOf(atThresholdAreaSqFt - 50);
    expect(material.label).toContain('short load fee');
    expect(material.inputs).toContain(JOB_PARAMS_TEST.volume.shortLoadThresholdCuYd.prov);
    expect(material.inputs).toContain(JOB_PARAMS_TEST.volume.shortLoadFee.prov);
  });

  it('at or above the threshold: no short load fee', () => {
    expect(materialLineOf(atThresholdAreaSqFt).label).not.toContain('short load fee');
    expect(materialLineOf(atThresholdAreaSqFt + 50).label).not.toContain('short load fee');
  });

  it('the step itself: total tracks the hand-computed formula on both sides of the threshold', () => {
    const belowArea = atThresholdAreaSqFt - 1;
    const below = estimate({ kind: 'slab', areaSqFt: belowArea, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const at = estimate({ kind: 'slab', areaSqFt: atThresholdAreaSqFt, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);

    const expectedBelow = expectedAreaBreakdown(belowArea, 4);
    const expectedAt = expectedAreaBreakdown(atThresholdAreaSqFt, 4);
    expect(expectedBelow.isShortLoad).toBe(true);
    expect(expectedAt.isShortLoad).toBe(false);

    expect(below.total.point).toBeCloseTo(round2(expectedBelow.total), 2);
    expect(at.total.point).toBeCloseTo(round2(expectedAt.total), 2);
    // Past the threshold the total drops noticeably (one shortLoadFee less, with only 1 sq ft more material/labor/subbase, which is negligible).
    expect(below.total.point).toBeGreaterThan(at.total.point);
  });

  it('reuses the exact same Tracked<number> objects volume uses — not a separately calibrated area-only copy', () => {
    const material = materialLineOf(atThresholdAreaSqFt - 50);
    // Reference equality, not just numeric equality: proves area jobs did not build a second set of shortLoad parameters.
    expect(material.inputs.includes(JOB_PARAMS_TEST.volume.shortLoadThresholdCuYd.prov)).toBe(true);
    expect(material.inputs.includes(JOB_PARAMS_TEST.volume.shortLoadFee.prov)).toBe(true);
  });
});

describe('estimate — area job optional extras: $/sf, $/(sf·in), lump sum', () => {
  it('omitted options: no reinforcement/finish/demolition/pump lines (defaults are $0 add-ons); subbase now defaults on', () => {
    const result = estimate({ kind: 'slab', areaSqFt: 1000, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const keys = result.lines.map((l) => l.key);
    expect(keys).not.toContain('reinforcement');
    expect(keys).not.toContain('finish');
    expect(keys).not.toContain('demolition');
    expect(keys).not.toContain('pump');
    expect(keys).toContain('subbase'); // Present by default
  });

  it('explicit reinforcement=none / finish=broom behave the same as omitting options', () => {
    const result = estimate(
      { kind: 'slab', areaSqFt: 1000, thicknessIn: 4, options: { reinforcement: 'none', finish: 'broom' } },
      NATIONAL_RATE_CARD,
      JOB_PARAMS_TEST,
    );
    const keys = result.lines.map((l) => l.key);
    expect(keys).not.toContain('reinforcement');
    expect(keys).not.toContain('finish');
  });

  it('every optional add-on, once triggered, produces the correctly-priced line', () => {
    const areaSqFt = 1000; // Large enough to trigger no short-load fee, so it does not tangle with the options checked separately in this test
    const result = estimate(
      {
        kind: 'slab',
        areaSqFt,
        thicknessIn: 4,
        options: { reinforcement: 'mesh', finish: 'stamped', subbaseIn: 2, removeExisting: true, pumpRequired: true },
      },
      NATIONAL_RATE_CARD,
      JOB_PARAMS_TEST,
    );

    const reinforcement = result.lines.find((l) => l.key === 'reinforcement')!;
    expect(reinforcement.amount.point).toBeCloseTo(round2(AREA_EXTRAS_TEST.reinforcement.mesh.value * areaSqFt), 2);

    const finish = result.lines.find((l) => l.key === 'finish')!;
    expect(finish.amount.point).toBeCloseTo(round2(AREA_EXTRAS_TEST.finish.stamped.value * areaSqFt), 2);

    const subbase = result.lines.find((l) => l.key === 'subbase')!;
    expect(subbase.amount.point).toBeCloseTo(round2(AREA_EXTRAS_TEST.subbase.value * areaSqFt * 2), 2);

    const demolition = result.lines.find((l) => l.key === 'demolition')!;
    expect(demolition.amount.point).toBeCloseTo(round2(AREA_EXTRAS_TEST.demolition.value * areaSqFt), 2);

    const pump = result.lines.find((l) => l.key === 'pump')!;
    expect(pump.amount.point).toBeCloseTo(round2(AREA_EXTRAS_TEST.pump.value), 2);

    const base = expectedAreaBreakdown(areaSqFt, 4, { subbaseIn: 2 });
    expect(base.isShortLoad).toBe(false);
    const expectedTotal =
      base.mobilization +
      base.materialTotal + // Already includes concrete + forms (this size triggers no short-load fee)
      base.labor +
      base.subbase + // Explicit subbaseIn=2, overriding the default thickness
      AREA_EXTRAS_TEST.reinforcement.mesh.value * areaSqFt +
      AREA_EXTRAS_TEST.finish.stamped.value * areaSqFt +
      AREA_EXTRAS_TEST.demolition.value * areaSqFt +
      AREA_EXTRAS_TEST.pump.value;
    expect(result.total.point).toBeCloseTo(round2(expectedTotal), 2);
  });
});

// ═══════════ 2. Volume jobs: delivered price only ═══════════

describe('estimate — volume (delivered-price only, no labor, no real mobilization fee)', () => {
  it('has no labor line and no mobilization line when not a short load', () => {
    const result = estimate({ kind: 'volume', volumeCuYd: 10 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const keys = result.lines.map((l) => l.key);
    expect(keys).not.toContain('labor');
    expect(keys).not.toContain('mobilization');
  });

  it("short-load fee line is keyed 'mobilization', not 'material' (a second 'material'-keyed line would collide as a UI render key)", () => {
    const threshold = JOB_PARAMS_TEST.volume.shortLoadThresholdCuYd.value;
    const result = estimate({ kind: 'volume', volumeCuYd: threshold - 0.5 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const materialLines = result.lines.filter((l) => l.key === 'material');
    const mobilizationLines = result.lines.filter((l) => l.key === 'mobilization');
    expect(materialLines.length).toBe(1);
    expect(mobilizationLines.length).toBe(1);
    expect(mobilizationLines[0].label).toContain('Short load fee');
  });

  it('does not read crewUnitsPerHour or mobilization at all — changing them must not change the result', () => {
    const alteredParams: JobParamsByKind = {
      ...JOB_PARAMS_TEST,
      volume: {
        ...JOB_PARAMS_TEST.volume,
        mobilization: tracked(1), // wildly different from the 999999 baseline
        crewUnitsPerHour: tracked(999), // wildly different from the 1e-7 baseline
      },
    };
    const baseline = estimate({ kind: 'volume', volumeCuYd: 10 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const altered = estimate({ kind: 'volume', volumeCuYd: 10 }, NATIONAL_RATE_CARD, alteredParams);
    expect(altered.total.point).toBe(baseline.total.point);
  });

  it('short-load fee steps in strictly below the threshold, not at or above it', () => {
    const threshold = JOB_PARAMS_TEST.volume.shortLoadThresholdCuYd.value;

    const below = estimate({ kind: 'volume', volumeCuYd: threshold - 0.5 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(below.lines.some((l) => l.label.includes('Short load'))).toBe(true);

    const at = estimate({ kind: 'volume', volumeCuYd: threshold }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(at.lines.some((l) => l.label.includes('Short load'))).toBe(false);

    const above = estimate({ kind: 'volume', volumeCuYd: threshold + 1 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(above.lines.some((l) => l.label.includes('Short load'))).toBe(false);

    // The step itself: the total below the threshold, minus the material difference, should be exactly one shortLoadFee more than at or above the threshold.
    const materialRate = JOB_PARAMS_TEST.volume.wasteFactor.value * NATIONAL_RATE_CARD.materialPerCuYd.value * NATIONAL_RATE_CARD.regionFactor.value;
    const materialDelta = (threshold - (threshold - 0.5)) * materialRate;
    const observedDelta = below.total.point - at.total.point;
    expect(observedDelta).toBeCloseTo(round2(JOB_PARAMS_TEST.volume.shortLoadFee.value - materialDelta), 1);
  });

  it('total = material (+ short load fee when applicable), exactly per formula', () => {
    const cuYd = 3; // below threshold(5)
    const result = estimate({ kind: 'volume', volumeCuYd: cuYd }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const material = cuYd * JOB_PARAMS_TEST.volume.wasteFactor.value * NATIONAL_RATE_CARD.materialPerCuYd.value * NATIONAL_RATE_CARD.regionFactor.value;
    const expectedTotal = material + JOB_PARAMS_TEST.volume.shortLoadFee.value;
    expect(result.total.point).toBeCloseTo(round2(expectedTotal), 2);
    expect(result.perUnit.point).toBeCloseTo(round2(expectedTotal / cuYd), 2);
  });
});

// ═══════════ 3. Block ═══════════

describe('estimate — block: material/labor formula, blockType guard', () => {
  it('material = blockCount × wasteFactor × unitMaterial (no regionFactor per the model formula)', () => {
    const blockCount = 200;
    const result = estimate({ kind: 'block', blockCount }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const material = blockCount * JOB_PARAMS_TEST.block.wasteFactor.value * JOB_PARAMS_TEST.block.unitMaterial.value;
    const materialLine = result.lines.find((l) => l.key === 'material')!;
    expect(materialLine.amount.point).toBeCloseTo(round2(material), 2);
  });

  it('labor = blockCount / crewUnitsPerHour × wage × laborBurden × quoteMultiplier', () => {
    const blockCount = 200;
    const result = estimate({ kind: 'block', blockCount }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const labor =
      (blockCount / JOB_PARAMS_TEST.block.crewUnitsPerHour.value) *
      NATIONAL_RATE_CARD.metro.wageHourly.value *
      NATIONAL_RATE_CARD.laborBurden.value *
      NATIONAL_RATE_CARD.quoteMultiplier.value;
    const laborLine = result.lines.find((l) => l.key === 'labor')!;
    expect(laborLine.amount.point).toBeCloseTo(round2(labor), 2);
  });

  it('accepts blockType=undefined and the standard-8in literal, both pricing identically', () => {
    const a = estimate({ kind: 'block', blockCount: 200 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    const b = estimate({ kind: 'block', blockCount: 200, blockType: 'standard-8in' }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(b.total.point).toBe(a.total.point);
  });

  it('throws on any other blockType instead of silently pricing it as standard', () => {
    expect(() => estimate({ kind: 'block', blockCount: 200, blockType: 'split-face' }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).toThrow(
      /split-face/,
    );
  });
});

// ═══════════ 4. Rebar: ASTM A615 table + throw outside the table ═══════════

describe('estimate — rebar: ASTM A615 pounds-per-foot table, barSize guard', () => {
  /** Isolates "pounds per foot" itself: wasteFactor=unitMaterial=1, wage=0 (labor goes to zero), mobilization=0. */
  const isolatingParams: JobParamsByKind = {
    ...JOB_PARAMS_TEST,
    rebar: { mobilization: tracked(0), wasteFactor: tracked(1), crewUnitsPerHour: tracked(100), unitMaterial: tracked(1) },
  };
  const zeroWageRates: RateCard = { ...NATIONAL_RATE_CARD, metro: { ...NATIONAL_METRO, wageHourly: tracked(0, 'sourced') } };

  it.each([
    [3, 0.376],
    [4, 0.668],
    [5, 1.043],
    [6, 1.502],
    [7, 2.044],
    [8, 2.67],
  ])('#%d rebar weighs %s lb/ft (ASTM A615)', (barSize, poundsPerFoot) => {
    // lengthFt=1000 so the $/lb=1 material line lands on a whole-cent amount — money() rounds
    // to cents for display, so isolating the weight at lengthFt=1 would lose the 3rd decimal.
    const lengthFt = 1000;
    const result = estimate({ kind: 'rebar', lengthFt, barSize }, zeroWageRates, isolatingParams);
    const material = result.lines.find((l) => l.key === 'material')!;
    expect(material.amount.point).toBeCloseTo(poundsPerFoot * lengthFt, 2);
  });

  it('throws on a barSize outside the #3–#8 table instead of guessing a weight', () => {
    expect(() => estimate({ kind: 'rebar', lengthFt: 100, barSize: 9 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).toThrow(/#9/);
    expect(() => estimate({ kind: 'rebar', lengthFt: 100, barSize: 2 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).toThrow(/#2/);
  });

  it('reports a positive bar-count secondary quantity alongside the lin-ft primary quantity', () => {
    const result = estimate({ kind: 'rebar', lengthFt: 555, barSize: 4, spacingIn: 12 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(result.secondaryQuantities?.length).toBe(2);
    expect(result.secondaryQuantities?.[0].unit).toBe('bars');
    expect(result.secondaryQuantities?.[0].value).toBe(Math.ceil(555 / 20));
    // Theoretical weight = length × ASTM A615 #4 pounds per foot (0.668), no waste
    expect(result.secondaryQuantities?.[1].unit).toBe('lb');
    expect(result.secondaryQuantities?.[1].value).toBeCloseTo(555 * 0.668, 6);
  });

  it('non-rebar kinds omit secondaryQuantities', () => {
    const result = estimate({ kind: 'slab', areaSqFt: 100, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(result.secondaryQuantities).toBeUndefined();
  });
});

// ═══════════ 4b. LineItem.key is unique ═══════════
// A UI is likely to use `key` as a React render key or to look rows up by key; two identical keys in one CostBreakdown
// make one row get overwritten or disappear while the total stays correct: a silent "total right, breakdown swallows a row" error
// (the volume short-load fee once wrongly used 'material' and collided with the material row). This checks every one of the
// 6 job kinds and every option combination exhaustively, to lock that regression down.

function expectUniqueLineKeys(result: CostBreakdown): void {
  const keys = result.lines.map((l) => l.key);
  expect(new Set(keys).size).toBe(keys.length);
}

describe('estimate — LineItem.key uniqueness across all kinds and option combinations', () => {
  it('slab/driveway/patio: no duplicate keys for any combination of reinforcement/finish/subbase/demolition/pump', () => {
    const reinforcements: Reinforcement[] = ['none', 'mesh', 'rebar'];
    const finishes: Finish[] = ['broom', 'smooth', 'stamped', 'exposed'];
    const subbaseIns = [undefined, 2];
    const removeExistingOptions = [false, true];
    const pumpRequiredOptions = [false, true];
    const kinds: Array<'slab' | 'driveway' | 'patio'> = ['slab', 'driveway', 'patio'];

    let combinationsChecked = 0;
    for (const kind of kinds) {
      for (const reinforcement of reinforcements) {
        for (const finish of finishes) {
          for (const subbaseIn of subbaseIns) {
            for (const removeExisting of removeExistingOptions) {
              for (const pumpRequired of pumpRequiredOptions) {
                const result = estimate(
                  { kind, areaSqFt: 100, thicknessIn: 4, options: { reinforcement, finish, subbaseIn, removeExisting, pumpRequired } },
                  NATIONAL_RATE_CARD,
                  JOB_PARAMS_TEST,
                );
                expectUniqueLineKeys(result);
                combinationsChecked += 1;
              }
            }
          }
        }
      }
    }
    // 3 kinds × 3 reinforcement × 4 finish × 2 subbaseIn × 2 removeExisting × 2 pumpRequired
    expect(combinationsChecked).toBe(3 * 3 * 4 * 2 * 2 * 2);
  });

  it('volume: no duplicate keys whether or not it is a short load', () => {
    const threshold = JOB_PARAMS_TEST.volume.shortLoadThresholdCuYd.value;
    for (const volumeCuYd of [threshold - 1, threshold, threshold + 1]) {
      expectUniqueLineKeys(estimate({ kind: 'volume', volumeCuYd }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST));
    }
  });

  it('block and rebar: no duplicate keys', () => {
    expectUniqueLineKeys(estimate({ kind: 'block', blockCount: 200 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST));
    expectUniqueLineKeys(estimate({ kind: 'block', blockCount: 200, blockType: 'standard-8in' }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST));
    expectUniqueLineKeys(estimate({ kind: 'rebar', lengthFt: 200, barSize: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST));
  });
});

// ═══════════ 5. JobKind exhaustiveness ═══════════

describe('estimate — JobKind exhaustiveness', () => {
  it('handles all 6 JobKind variants without throwing', () => {
    const inputs: CostInput[] = [
      { kind: 'slab', areaSqFt: 100, thicknessIn: 4 },
      { kind: 'driveway', areaSqFt: 100, thicknessIn: 4 },
      { kind: 'patio', areaSqFt: 100, thicknessIn: 4 },
      { kind: 'volume', volumeCuYd: 10 },
      { kind: 'block', blockCount: 200 },
      { kind: 'rebar', lengthFt: 100, barSize: 4 },
    ];
    for (const input of inputs) {
      expect(() => estimate(input, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).not.toThrow();
    }
  });

  /**
   * Compile-time exhaustiveness cannot be asserted with vitest (that is tsc's job): the `const _exhaustive: never = input;` at the end
   * of the `estimate()` switch in model.ts makes "a new kind added to CostInput without updating this switch" fail to compile.
   * What this adds is a defensive test of the runtime fallback path:
   * if someone bypasses the type system (`as unknown as CostInput`) and forces in an illegal kind, it still must not silently produce a result.
   */
  it('runtime defense-in-depth: an illegal kind (bypassing the type system) throws instead of silently computing', () => {
    const bogus = { kind: 'not-a-real-kind' } as unknown as CostInput;
    expect(() => estimate(bogus, NATIONAL_RATE_CARD, JOB_PARAMS_TEST)).toThrow(/not-a-real-kind/);
  });
});

// ═══════════ 6. buildRateCard: cbsa lookup, substitution conversion, dispersion combination ═══════════

describe('buildRateCard — cbsa lookup', () => {
  it('returns a national-based card (same metro/materialPerCuYd/laborBurden/quoteMultiplier) when cbsa matches the national row', () => {
    // No longer a plain `toBe(table.national)` pass-through: dispersion is now combined (see the national baseline test in the
    // "dispersion combination" section); the other fields are still inherited verbatim from national, not a separate copy.
    const result = buildRateCard(TEST_RATE_TABLE, 'US')!;
    expect(result.metro).toBe(TEST_RATE_TABLE.national.metro);
    expect(result.laborBurden).toBe(TEST_RATE_TABLE.national.laborBurden);
    expect(result.quoteMultiplier).toBe(TEST_RATE_TABLE.national.quoteMultiplier);
    expect(result.materialPerCuYd).toBe(TEST_RATE_TABLE.national.materialPerCuYd);
    expect(result.regionFactor).toBe(TEST_RATE_TABLE.national.regionFactor);
  });

  it('returns null for an unknown cbsa instead of silently falling back to national', () => {
    const result = buildRateCard(TEST_RATE_TABLE, 'not-a-real-cbsa');
    expect(result).toBeNull();
  });

  it('carries the correct regionFactor for the metro (material personalization)', () => {
    const south = buildRateCard(TEST_RATE_TABLE, METRO_SOUTH.cbsa);
    expect(south?.regionFactor).toBe(REGION_FACTORS.S);
    const midwest = buildRateCard(TEST_RATE_TABLE, METRO_SUBSTITUTED.cbsa);
    expect(midwest?.regionFactor).toBe(REGION_FACTORS.MW);
  });
});

describe('buildRateCard — occupation substitution', () => {
  it('leaves a non-substituted metro (ref = SOC 47-2051) untouched', () => {
    const result = buildRateCard(TEST_RATE_TABLE, METRO_SOUTH.cbsa)!;
    expect(result.metro.wageHourly.value).toBe(METRO_SOUTH.wageHourly.value);
    expect(result.metro.wageHourly.prov.level).toBe('sourced');
  });

  it('multiplies wageHourly/wageP25/wageP75 by the occupation ratio, downgrades level to calibrated, keeps ref', () => {
    const ratio = OCCUPATION_WAGE_RATIO['SOC 47-2061'].value;
    const result = buildRateCard(TEST_RATE_TABLE, METRO_SUBSTITUTED.cbsa)!;

    expect(result.metro.wageHourly.value).toBeCloseTo(METRO_SUBSTITUTED.wageHourly.value * ratio, 6);
    expect(result.metro.wageHourly.prov.level).toBe('calibrated');
    expect(result.metro.wageHourly.prov.ref).toBe('SOC 47-2061');
    expect(result.metro.wageHourly.prov.note).toContain('SOC 47-2061');

    expect(result.metro.wageP25?.value).toBeCloseTo(METRO_SUBSTITUTED.wageP25!.value * ratio, 6);
    expect(result.metro.wageP25?.prov.level).toBe('calibrated');
    expect(result.metro.wageP75?.value).toBeCloseTo(METRO_SUBSTITUTED.wageP75!.value * ratio, 6);
    expect(result.metro.wageP75?.prov.level).toBe('calibrated');
  });

  it('applies the other ratio (SOC 47-1011) and preserves a pre-existing fellBackFrom untouched', () => {
    const ratio = OCCUPATION_WAGE_RATIO['SOC 47-1011'].value;
    const result = buildRateCard(TEST_RATE_TABLE, METRO_BOTH_SIGNALS.cbsa)!;
    expect(result.metro.wageHourly.value).toBeCloseTo(METRO_BOTH_SIGNALS.wageHourly.value * ratio, 6);
    expect(result.metro.wageHourly.prov.level).toBe('calibrated');
    expect(result.metro.wageHourly.prov.fellBackFrom).toBe('metro');
  });
});

describe('buildRateCard — dispersion combination: merge, never replace', () => {
  it('combined value >= max(market, wage) and combined level = the weaker of the two', () => {
    const result = buildRateCard(TEST_RATE_TABLE, METRO_SOUTH.cbsa)!;
    const wageDispersion = (METRO_SOUTH.wageP75!.value - METRO_SOUTH.wageP25!.value) / (METRO_SOUTH.wageP75!.value + METRO_SOUTH.wageP25!.value);
    const marketDispersion = NATIONAL_RATE_CARD.dispersion.value;

    expect(result.dispersion.value).toBeGreaterThanOrEqual(Math.max(marketDispersion, wageDispersion));
    expect(result.dispersion.value).toBeCloseTo(Math.sqrt(marketDispersion ** 2 + wageDispersion ** 2), 6);
    // market=calibrated, wage(P25/P75)=sourced → the combination takes the weaker level: calibrated
    expect(result.dispersion.prov.level).toBe('calibrated');
  });

  it('minLevel does not care which side is weaker (market=sourced, wage P25=assumed here)', () => {
    const result = buildRateCard(TEST_RATE_TABLE_WEAK_WAGE, METRO_WEAK_WAGE_LEVEL.cbsa)!;
    // The market side is sourced this time (higher than the wage's assumed), and the result must still follow the weaker wage.
    expect(result.dispersion.prov.level).toBe('assumed');
    const wageDispersion =
      (METRO_WEAK_WAGE_LEVEL.wageP75!.value - METRO_WEAK_WAGE_LEVEL.wageP25!.value) /
      (METRO_WEAK_WAGE_LEVEL.wageP75!.value + METRO_WEAK_WAGE_LEVEL.wageP25!.value);
    expect(result.dispersion.value).toBeGreaterThanOrEqual(wageDispersion);
    expect(result.dispersion.value).toBeGreaterThanOrEqual(NATIONAL_RATE_CARD_SOURCED_MARKET.dispersion.value);
  });

  it('falls back to market dispersion alone (unchanged value and level) when the metro has no wage quantiles', () => {
    const result = buildRateCard(TEST_RATE_TABLE, METRO_GEO_FALLBACK_ONLY.cbsa)!;
    expect(result.dispersion.value).toBe(NATIONAL_RATE_CARD.dispersion.value);
    expect(result.dispersion.prov.level).toBe(NATIONAL_RATE_CARD.dispersion.prov.level);
  });

  it('occupation substitution does not change the wage-dispersion value (ratio cancels in (P75-P25)/(P75+P25))', () => {
    const south = buildRateCard(TEST_RATE_TABLE, METRO_SOUTH.cbsa)!; // not substituted
    const substituted = buildRateCard(TEST_RATE_TABLE, METRO_SUBSTITUTED.cbsa)!; // substituted, same P25/P75 spread ratio
    // Both metros have P75/P25 ratios of 1.5 (30/20=1.5, 48/32=1.5), so the wage dispersion is theoretically equal,
    // and the combined dispersion should be equal too (the market component is the same on both sides).
    expect(substituted.dispersion.value).toBeCloseTo(south.dispersion.value, 6);
  });

  /**
   * The cbsa === national pass-through branch used to return `table.national` directly,
   * so its dispersion was market-only: narrower than every metro (market ⊕ wage is always wider), while the national baseline is
   * exactly the figure a static page renders by default and a crawler sees, which would make it the narrowest range on the whole site for no reason.
   */
  it('the national passthrough combines dispersion the same way a metro does — it must not stay narrower than every metro', () => {
    const national = buildRateCard(TEST_RATE_TABLE, 'US')!;
    const marketDispersion = NATIONAL_RATE_CARD.dispersion.value; // The raw market dispersion before combining
    const wageDispersion =
      (NATIONAL_METRO.wageP75!.value - NATIONAL_METRO.wageP25!.value) / (NATIONAL_METRO.wageP75!.value + NATIONAL_METRO.wageP25!.value);

    // It cannot degrade in place to the market dispersion itself: a combination must really have happened.
    expect(national.dispersion.value).toBeGreaterThan(marketDispersion);
    expect(national.dispersion.value).toBeGreaterThanOrEqual(Math.max(marketDispersion, wageDispersion));
    // The same combination formula as the metro branch: sqrt(market² + wage²).
    expect(national.dispersion.value).toBeCloseTo(Math.sqrt(marketDispersion ** 2 + wageDispersion ** 2), 6);

    // The market component must be the original value of table.national.dispersion, not the combined result fed back into itself (which would stack the wage term twice).
    const south = buildRateCard(TEST_RATE_TABLE, METRO_SOUTH.cbsa)!;
    expect(national.dispersion.value).toBeCloseTo(south.dispersion.value, 6); // Both sides have the same wage percentile ratio (1.5x), so they should give the same number

    // national.metro itself has no substitution issue (a compound ref) and should not be touched by applyOccupationSubstitution.
    expect(national.metro.wageHourly.value).toBe(NATIONAL_METRO.wageHourly.value);
    expect(national.metro.wageHourly.prov.level).toBe(NATIONAL_METRO.wageHourly.prov.level);
  });
});

// ═══════════ 7. notices: substitution judged by ref, fellBackFrom judged independently ═══════════

describe('estimate — notices: occupation substitution and geo fallback are independent signals', () => {
  function noticesFor(cbsa: string): string[] {
    const rates = buildRateCard(TEST_RATE_TABLE, cbsa)!;
    return estimate({ kind: 'slab', areaSqFt: 100, thicknessIn: 4 }, rates, JOB_PARAMS_TEST).notices;
  }

  it('no notices for a metro with neither signal', () => {
    expect(noticesFor(METRO_SOUTH.cbsa)).toEqual([]);
  });

  it('occupation substitution alone produces exactly one notice naming the metro and the substitute occupation', () => {
    const notices = noticesFor(METRO_SUBSTITUTED.cbsa);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain(METRO_SUBSTITUTED.name);
    expect(notices[0]).toContain('47-2061');
  });

  it('geo fallback alone (ref = SOC 47-2051, but fellBackFrom set) produces exactly one notice', () => {
    const notices = noticesFor(METRO_GEO_FALLBACK_ONLY.cbsa);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain(METRO_GEO_FALLBACK_ONLY.name);
    expect(notices[0]).toContain('metro');
  });

  it('both signals together produce two independent notices, not just one derived from fellBackFrom', () => {
    const notices = noticesFor(METRO_BOTH_SIGNALS.cbsa);
    expect(notices.length).toBe(2);
    expect(notices.some((n) => n.includes('47-1011'))).toBe(true);
    expect(notices.some((n) => n.includes('metro'))).toBe(true);
  });

  it('national rate card (composite ref, not a single substitution) produces no occupation-substitution notice', () => {
    const notices = estimate({ kind: 'slab', areaSqFt: 100, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST).notices;
    expect(notices).toEqual([]);
  });
});

// ═══════════ 8. geo / asOf output fields ═══════════

describe('estimate — geo/asOf output fields', () => {
  it('reflects the metro cbsa, name, and fellBackFrom', () => {
    const rates = buildRateCard(TEST_RATE_TABLE, METRO_BOTH_SIGNALS.cbsa)!;
    const result = estimate({ kind: 'slab', areaSqFt: 100, thicknessIn: 4 }, rates, JOB_PARAMS_TEST);
    expect(result.geo.cbsa).toBe(METRO_BOTH_SIGNALS.cbsa);
    expect(result.geo.label).toBe(METRO_BOTH_SIGNALS.name);
    expect(result.geo.fellBackFrom).toBe('metro');
  });

  it('national rate card reports cbsa=null (not the literal "US")', () => {
    const result = estimate({ kind: 'slab', areaSqFt: 100, thicknessIn: 4 }, NATIONAL_RATE_CARD, JOB_PARAMS_TEST);
    expect(result.geo.cbsa).toBeNull();
  });

  /**
   * The geo fallback must show up not only in CostBreakdown.geo: the Provenance in each line's inputs must also carry
   * fellBackFrom, so an expandable source panel can show the disclosure too, not only the geo summary at the top of the page.
   * This assertion covers the LineItem.inputs level, which neither the "notices" section nor the "geo/asOf"
   * section covers, so that coverage cannot silently disappear.
   */
  it('a geo fallback is also disclosed at the line-item level: the labor line carries a Provenance with fellBackFrom set', () => {
    const rates = buildRateCard(TEST_RATE_TABLE, METRO_GEO_FALLBACK_ONLY.cbsa)!;
    const result = estimate({ kind: 'slab', areaSqFt: 100, thicknessIn: 4 }, rates, JOB_PARAMS_TEST);
    expect(result.geo.fellBackFrom).toBe('metro');
    const laborLine = result.lines.find((l) => l.key === 'labor');
    expect(laborLine?.inputs.some((p) => p.fellBackFrom === 'metro')).toBe(true);
  });
});
