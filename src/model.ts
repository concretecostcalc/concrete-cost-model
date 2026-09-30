/**
 * The cost model: `estimate: Estimator` and `buildRateCard: BuildRateCard`.
 *
 * This file depends only on the **shapes** in `./types` and on `OCCUPATION_WAGE_RATIO` from
 * `./occupation-ratio` (the wage ratio for substitute occupations is a structural part of the
 * formula, not a value awaiting calibration). It deliberately does not import `JOB_PARAMS`: the
 * formulas here must not depend on any concrete parameter value, only on the shape of
 * `JobParamsByKind`, so changing a parameter value never changes the logic in this file, and
 * `model.test.ts` verifies the formula structure with simple hand-made parameters.
 */
import { OCCUPATION_WAGE_RATIO } from './occupation-ratio';
import type {
  AreaJob,
  AreaJobExtras,
  BlockJob,
  BuildRateCard,
  CostBreakdown,
  Estimator,
  Finish,
  JobParams,
  LineItem,
  LineKey,
  MetroRate,
  Money,
  ParamLevel,
  Provenance,
  RateCard,
  RebarJob,
  Reinforcement,
  SecondaryQuantity,
  Tracked,
  VolumeJob,
} from './types';

// ═══════════ 0. Small shared helpers ═══════════

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** low/high come from `RateCard.dispersion` (already combined in `buildRateCard`); `estimate()` does not combine anything itself. */
function money(point: number, dispersion: number): Money {
  return {
    low: round2(point * (1 - dispersion)),
    point: round2(point),
    high: round2(point * (1 + dispersion)),
  };
}

/**
 * Line-by-line accumulation: each `amount.point` is rounded independently with round2 (for
 * display), but `total` sums the **unrounded raw values** gathered along the way and rounds once.
 * This avoids a few cents of drift between "round each line then add" and "round the total
 * directly": the total should be the rounding of one number, not a sum of separately rounded ones.
 */
function createLineBuilder(dispersion: number) {
  const lines: LineItem[] = [];
  let rawTotal = 0;
  return {
    lines,
    add(key: LineKey, label: string, rawPoint: number, inputs: Provenance[]): void {
      rawTotal += rawPoint;
      lines.push({ key, label, amount: money(rawPoint, dispersion), inputs });
    },
    total(): number {
      return rawTotal;
    },
  };
}

function geoOf(rates: RateCard): CostBreakdown['geo'] {
  return {
    level: rates.metro.wageHourly.prov.geo ?? 'metro',
    label: rates.metro.name,
    cbsa: rates.metro.cbsa === 'US' ? null : rates.metro.cbsa,
    fellBackFrom: rates.metro.wageHourly.prov.fellBackFrom ?? null,
  };
}

function asOfOf(rates: RateCard): CostBreakdown['asOf'] {
  return {
    wages: rates.metro.wageHourly.prov.asOf,
    material: rates.materialPerCuYd.prov.asOf,
    index: rates.regionFactor.prov.asOf,
  };
}

// ═══════════ 1. Notices (a substituted occupation must produce a notice; checking fellBackFrom alone is not enough) ═══════════

const OCCUPATION_SUBSTITUTION_LABEL: Record<'SOC 47-2061' | 'SOC 47-1011', string> = {
  'SOC 47-2061': 'construction laborers (SOC 47-2061)',
  'SOC 47-1011': 'first-line construction supervisors (SOC 47-1011)',
};

/** Whether a metro's wage comes from a substitute occupation: judged by `ref`, a signal independent of `fellBackFrom` (geographic fallback). */
function substitutedOccupationRef(metro: MetroRate): 'SOC 47-2061' | 'SOC 47-1011' | null {
  const ref = metro.wageHourly.prov.ref;
  return ref === 'SOC 47-2061' || ref === 'SOC 47-1011' ? ref : null;
}

/** User-facing text (rendered straight into a page), not the internal `Provenance.note`. */
function occupationSubstitutionNotice(metro: MetroRate): string | null {
  const ref = substitutedOccupationRef(metro);
  if (!ref) return null;
  const ratio = OCCUPATION_WAGE_RATIO[ref].value;
  return (
    `${metro.name}: no wage data for cement masons/concrete finishers (SOC 47-2051) in this area; ` +
    `using ${OCCUPATION_SUBSTITUTION_LABEL[ref]} wages instead, adjusted by a calibrated factor of ${ratio} ` +
    `(median ratio between the two occupations across metros with both) to approximate concrete finisher pay.`
  );
}

function geoFallbackNotice(metro: MetroRate): string | null {
  const fellBackFrom = metro.wageHourly.prov.fellBackFrom;
  if (!fellBackFrom) return null;
  const landedAt = metro.wageHourly.prov.geo ?? 'a broader level';
  return `${metro.name}: wage data unavailable at the ${fellBackFrom} level; using a ${landedAt}-level estimate instead.`;
}

/** The two signals are independent and each is checked on its own: substitution (by ref) and geographic fallback (by fellBackFrom) can happen together or alone. */
function noticesOf(metro: MetroRate): string[] {
  const notices: string[] = [];
  const occNotice = occupationSubstitutionNotice(metro);
  if (occNotice) notices.push(occNotice);
  const fallbackNotice = geoFallbackNotice(metro);
  if (fallbackNotice) notices.push(fallbackNotice);
  return notices;
}

// ═══════════ 2. buildRateCard ═══════════

const PARAM_LEVEL_RANK: Record<ParamLevel, number> = { assumed: 0, calibrated: 1, sourced: 2 };

/** A derived value can be no more trustworthy than its weakest input: whichever component ranks lower, the result follows. */
function minLevel(a: ParamLevel, b: ParamLevel): ParamLevel {
  return PARAM_LEVEL_RANK[a] <= PARAM_LEVEL_RANK[b] ? a : b;
}

/**
 * For a substituted metro (`wageHourly.prov.ref` is 47-2061 or 47-1011), multiplies the wage by
 * the same-metro ratio (`OCCUPATION_WAGE_RATIO`) to bring it to "equivalent to a 47-2051 cement
 * mason". `prov.level` drops to `calibrated` (the ratio is derived, and the government does not
 * publish a cement-mason wage for this metro). `ref` is left unchanged so downstream code (notices,
 * the P25/P75 dispersion) still knows which substitute occupation was used.
 */
function adjustSubstitutedWage(tracked: Tracked<number>, ratio: Tracked<number>): Tracked<number> {
  const adjustedValue = tracked.value * ratio.value;
  return {
    value: adjustedValue,
    prov: {
      ...tracked.prov,
      level: 'calibrated',
      note:
        `Converted from the substituted occupation's raw wage of $${tracked.value.toFixed(2)}/hr ` +
        `(${tracked.prov.ref}) × ratio ${ratio.value} (${ratio.prov.source}) = $${adjustedValue.toFixed(2)}/hr, ` +
        `approximating SOC 47-2051 (cement masons/concrete finishers) pay in this area.` +
        (tracked.prov.note ? ` | ${tracked.prov.note}` : ''),
    },
  };
}

function applyOccupationSubstitution(metro: MetroRate): MetroRate {
  const ref = substitutedOccupationRef(metro);
  if (!ref) return metro;
  const ratio = OCCUPATION_WAGE_RATIO[ref];
  const wageHourly = adjustSubstitutedWage(metro.wageHourly, ratio);
  const wageP25 = metro.wageP25 ? adjustSubstitutedWage(metro.wageP25, ratio) : undefined;
  const wageP75 = metro.wageP75 ? adjustSubstitutedWage(metro.wageP75, ratio) : undefined;
  return { ...metro, wageHourly, ...(wageP25 !== undefined && { wageP25 }), ...(wageP75 !== undefined && { wageP75 }) };
}

/**
 * Wage-side dispersion: (P75-P25)/(P75+P25), the relative width of the percentile band
 * (dimensionless; the denominator is the sum of the two ends rather than the mean, to avoid
 * introducing an extra "the distribution is symmetric" assumption). The level is the lower of P25/P75.
 *
 * Note: for a substituted metro, P25/P75 have already been scaled by the same ratio in
 * `applyOccupationSubstitution`. Numerator and denominator are multiplied by one constant, so the
 * ratio does not change and substitution does not affect the **value** of this dispersion. The
 * trust level must still inherit the `calibrated` that `applyOccupationSubstitution` set, rather
 * than pretend no substitution happened because the value happens to be unchanged.
 */
function deriveWageDispersion(metro: MetroRate): Tracked<number> | null {
  if (!metro.wageP25 || !metro.wageP75) return null;
  const p25 = metro.wageP25.value;
  const p75 = metro.wageP75.value;
  const value = (p75 - p25) / (p75 + p25);
  return {
    value,
    prov: {
      level: minLevel(metro.wageP25.prov.level, metro.wageP75.prov.level),
      source: 'ConcreteCostCalc derivation: (P75-P25)/(P75+P25)',
      ref: 'BLS OEWS P25/P75',
      asOf: metro.wageP25.prov.asOf,
      geo: metro.wageHourly.prov.geo,
      note: `Derived from ${metro.name} wage P25/P75 percentiles: (P75-P25)/(P75+P25) ≈ ${(value * 100).toFixed(1)}%`,
    },
  };
}

/**
 * Market dispersion (`RateCard.dispersion`, the spread between contractor quotes, e.g. three
 * same-county quotes for the same mix differing by 65%) and wage dispersion (the width of the local
 * wage distribution) are two uncertainties with different sources and meanings, and they are
 * **combined, not substituted**. Replacing market dispersion with wage dispersion would narrow the
 * range while still carrying a "government data" label, which is more misleading.
 *
 * The combination is **orthogonal** (each treated as an independent standard deviation, root of
 * the sum of squares): `sqrt(market² + wage²)`. Reasons: (1) mathematically `combined >= max(market, wage)`
 * always holds (the other square is non-negative), so the hard constraint "never narrower than the
 * wider component" is satisfied without an extra clamp; (2) the two sources are plausibly
 * independent, and adding independent variances is the standard statistical practice. Without wage
 * percentiles it degrades to the market dispersion itself (not a combination, just the only
 * component available).
 *
 * The level is the lowest of the two components.
 */
function combineDispersion(market: Tracked<number>, wage: Tracked<number> | null): Tracked<number> {
  if (!wage) {
    return {
      value: market.value,
      prov: {
        ...market.prov,
        note: `${market.prov.note ? `${market.prov.note} ` : ''}(no wage-quantile data at this geography — using market dispersion alone)`,
      },
    };
  }
  const value = Math.sqrt(market.value ** 2 + wage.value ** 2);
  return {
    value,
    prov: {
      level: minLevel(market.prov.level, wage.prov.level),
      source: 'concretecostcalc combination (market dispersion ⊕ wage dispersion, orthogonal)',
      asOf: wage.prov.asOf,
      geo: wage.prov.geo,
      note:
        `sqrt(market² + wage²) = sqrt(${market.value.toFixed(4)}² + ${wage.value.toFixed(4)}²) ≈ ${value.toFixed(4)}; ` +
        `market dispersion = ${market.value} (${market.prov.level}, ${market.prov.source}), ` +
        `wage dispersion = ${wage.value.toFixed(4)} (${wage.prov.level}, from P25/P75). Combined, not replaced.`,
    },
  };
}

/**
 * The contract is documented on `BuildRateCard` in types.ts: start from `national`, swap in the
 * selected metro, override regionFactor/dispersion with that metro's own values, and return null
 * (never fall back to national) when the cbsa is not found.
 *
 * The cbsa === national pass-through branch must **not** return `table.national` unchanged. Its
 * dispersion would then be market-only, narrower than every metro (market ⊕ wage is always wider),
 * which would make the default national baseline the narrowest range on the whole site for no
 * reason. The national `metro` carries its own national-level wageP25/wageP75 (a weighted
 * average), so it has a wage dispersion too and goes through the same `combineDispersion`.
 * National has no substitution problem (`ref` is a compound string that maps to no single
 * substitute occupation), so only `applyOccupationSubstitution` is skipped, not the dispersion
 * combination. The market component of `combineDispersion` **must** be the raw
 * `table.national.dispersion` (before combining); feeding it the already combined value from the
 * metro branch would stack the wage dispersion twice.
 */
export const buildRateCard: BuildRateCard = (table, cbsa) => {
  if (cbsa === table.national.metro.cbsa) {
    return {
      ...table.national,
      dispersion: combineDispersion(table.national.dispersion, deriveWageDispersion(table.national.metro)),
    };
  }
  const rawMetro = table.metros.find((m) => m.cbsa === cbsa);
  if (!rawMetro) return null;

  const metro = applyOccupationSubstitution(rawMetro);
  const regionFactor = table.regionFactors[metro.materialRegion];
  const dispersion = combineDispersion(table.national.dispersion, deriveWageDispersion(metro));

  return { ...table.national, metro, regionFactor, dispersion };
};

/** Compile-time assertion: the shape of buildRateCard must be assignable to BuildRateCard, so a signature drift fails here first. */
export const _typeCheckBuildRateCard: BuildRateCard = buildRateCard;

// ═══════════ 3. Area jobs (slab/driveway/patio) ═══════════

/** Area (sq ft) × thickness (in, converted to feet first) ÷ 27 → cubic yards. */
function areaToCuYd(areaSqFt: number, thicknessIn: number): number {
  return (areaSqFt * (thicknessIn / 12)) / 27;
}

type AreaJobParams = JobParams & { areaExtras: AreaJobExtras; forms: Tracked<number>; defaultSubbaseIn: Tracked<number> };
type ShortLoadParams = { shortLoadThresholdCuYd: Tracked<number>; shortLoadFee: Tracked<number> };

/**
 * Pricing of the optional features of area jobs (units as documented on `AreaJobExtras`):
 * · reinforcement / finish: $/sq ft, times areaSqFt
 * · subbase: $/(sq ft·inch), times areaSqFt × subbase inches (a `defaultSubbaseIn` layer is
 *   included by default, without the user opting in; see the note on `AreaJobExtras.subbase` in types.ts)
 * · demolition: $/sq ft, times areaSqFt, charged only when `removeExisting` is true
 * · pump: a flat fee, charged only when `pumpRequired` is true
 * reinforcement/finish/demolition/pump produce a LineItem only when the amount is > 0 (or the
 * option was explicitly selected): zero-cost options such as 'none'/'broom' take no row. Subbase is
 * the one item that is present by default instead of only on request.
 */
function addAreaExtras(builder: ReturnType<typeof createLineBuilder>, input: AreaJob, params: AreaJobParams): void {
  const options = input.options ?? {};
  const areaSqFt = input.areaSqFt;
  const extras = params.areaExtras;

  const reinforcement: Reinforcement = options.reinforcement ?? 'none';
  const reinforcementRate = extras.reinforcement[reinforcement];
  if (reinforcementRate.value > 0) {
    builder.add(
      'reinforcement',
      `Reinforcement (${reinforcement})`,
      reinforcementRate.value * areaSqFt,
      [reinforcementRate.prov],
    );
  }

  const finish: Finish = options.finish ?? 'broom';
  const finishRate = extras.finish[finish];
  if (finishRate.value > 0) {
    builder.add('finish', `Finish (${finish})`, finishRate.value * areaSqFt, [finishRate.prov]);
  }

  // When the user gives no options.subbaseIn, the subbase is not skipped: a layer of
  // defaultSubbaseIn thickness is assumed (a crushed-stone subbase is standard practice for
  // residential slabs). `inputs` carries the defaultSubbaseIn provenance only when the default was
  // actually used; when the user specifies a thickness, the default took no part in the calculation.
  const subbaseIn = options.subbaseIn ?? params.defaultSubbaseIn.value;
  if (subbaseIn > 0) {
    const usedDefault = options.subbaseIn == null;
    const subbaseInputs: Provenance[] = usedDefault ? [extras.subbase.prov, params.defaultSubbaseIn.prov] : [extras.subbase.prov];
    builder.add('subbase', `Subbase (${subbaseIn} in)`, extras.subbase.value * areaSqFt * subbaseIn, subbaseInputs);
  }

  if (options.removeExisting) {
    builder.add('demolition', 'Removal of existing slab', extras.demolition.value * areaSqFt, [extras.demolition.prov]);
  }

  if (options.pumpRequired) {
    builder.add('pump', 'Concrete pump', extras.pump.value, [extras.pump.prov]);
  }
}

/** Allowed relative deviation between length × width and the area; beyond it the dimensions are treated as inconsistent with the area and the square assumption is used (see AreaJob.lengthFt). */
const DIMENSION_AREA_TOLERANCE = 0.01;

/** Form perimeter (ft): 2×(length+width) when length and width are valid and consistent with the area, otherwise 4√area. */
export function formworkPerimeterFt(input: AreaJob): number {
  const { lengthFt, widthFt, areaSqFt } = input;
  if (
    lengthFt != null &&
    widthFt != null &&
    Number.isFinite(lengthFt) &&
    Number.isFinite(widthFt) &&
    lengthFt > 0 &&
    widthFt > 0 &&
    Math.abs(lengthFt * widthFt - areaSqFt) <= DIMENSION_AREA_TOLERANCE * areaSqFt
  ) {
    return 2 * (lengthFt + widthFt);
  }
  return 4 * Math.sqrt(areaSqFt);
}

function estimateAreaJob(input: AreaJob, rates: RateCard, params: AreaJobParams, shortLoad: ShortLoadParams): CostBreakdown {
  const dispersion = rates.dispersion.value;
  const builder = createLineBuilder(dispersion);

  builder.add('mobilization', 'Mobilization (site setup & delivery)', params.mobilization.value, [
    params.mobilization.prov,
  ]);

  // ═══ Material line: ready-mix + form material + (when it applies) short-load fee, all folded into one 'material' line ═══
  // Published quotes usually count forms and subbase as "materials", not only the ready-mix.
  // Subbase has its own 'subbase' line (priced in addAreaExtras above). Form material and the
  // short-load fee are folded into this 'material' line instead of getting new LineItems: the
  // LineKey union is fixed, and area jobs already use 'mobilization', so a separate short-load row
  // under either 'mobilization' or 'material' would produce a duplicate key (the same trap the
  // volume job hit and fixed). Folding both into the existing 'material' line avoids duplicate
  // keys: amounts add up, and inputs and label accumulate, so an expandable source list still
  // shows where every cent comes from.
  const cuYd = areaToCuYd(input.areaSqFt, input.thicknessIn);
  // The volume actually ordered (waste included). The short-load threshold is tested against this,
  // not the theoretical volume, because a batch plant charges for what it actually sends out,
  // whatever the drawings say.
  const orderedCuYd = cuYd * params.wasteFactor.value;
  const materialInputs: Provenance[] = [params.wasteFactor.prov, rates.materialPerCuYd.prov, rates.regionFactor.prov];
  const materialLabelExtras: string[] = [];
  let materialPoint = orderedCuYd * rates.materialPerCuYd.value * rates.regionFactor.value;

  // Form material: perimeter × forms ($/lin ft). With a length and width (consistent with the
  // area) it uses the real rectangle's perimeter 2×(length+width); with area only it estimates the
  // perimeter as a **square** (4√area). That is a modeling assumption: a long, narrow driveway has
  // a longer perimeter than a square of the same area, so with area only the form cost comes out
  // **low**. This is a known limitation of the model, not a calculation error.
  const perimeterFt = formworkPerimeterFt(input);
  materialPoint += perimeterFt * params.forms.value;
  materialInputs.push(params.forms.prov);
  materialLabelExtras.push('forms');

  // Short-load fee for area jobs: reuses the volume job's shortLoadThresholdCuYd/shortLoadFee
  // rather than a second parameter set. Published batch-plant price lists ("$100 or the shortfall,
  // whichever is less") and homeowner reports on forums show this is the same charge a plant makes
  // when an order does not fill a truck, whether the load ends up in a slab or is sold by volume.
  // With no new evidence there is no reason for two independently calibrated thresholds and
  // amounts; that would only add an arbitrary difference.
  const isShortLoad = orderedCuYd < shortLoad.shortLoadThresholdCuYd.value;
  if (isShortLoad) {
    materialPoint += shortLoad.shortLoadFee.value;
    materialInputs.push(shortLoad.shortLoadThresholdCuYd.prov, shortLoad.shortLoadFee.prov);
    materialLabelExtras.push('short load fee');
  }

  const materialLabel =
    materialLabelExtras.length > 0 ? `Concrete material (incl. ${materialLabelExtras.join(', ')})` : 'Concrete material';
  builder.add('material', materialLabel, materialPoint, materialInputs);

  // crewUnitsPerHour is an all-in output **per worker-hour**: quantity ÷ output rate = total hours needed.
  const laborHours = input.areaSqFt / params.crewUnitsPerHour.value;
  const laborPoint = laborHours * rates.metro.wageHourly.value * rates.laborBurden.value * rates.quoteMultiplier.value;
  builder.add('labor', 'Labor & placement', laborPoint, [
    params.crewUnitsPerHour.prov,
    rates.metro.wageHourly.prov,
    rates.laborBurden.prov,
    rates.quoteMultiplier.prov,
  ]);

  addAreaExtras(builder, input, params);

  const totalPoint = builder.total();
  return {
    unit: 'sqft',
    quantity: input.areaSqFt,
    quantityLabel: `${input.areaSqFt} sq ft`,
    total: money(totalPoint, dispersion),
    perUnit: money(totalPoint / input.areaSqFt, dispersion),
    lines: builder.lines,
    geo: geoOf(rates),
    asOf: asOfOf(rates),
    notices: noticesOf(rates.metro),
  };
}

// ═══════════ 4. Volume jobs (delivered price only) ═══════════

/**
 * Volume jobs price the delivered concrete only, **with no labor and no mobilization fee**: they do
 * not read `params.crewUnitsPerHour` (even though the field exists structurally, see the note on
 * volume in types.ts) or `params.mobilization`. The nonlinearity comes from the short-load fee: a
 * volume strictly below the threshold adds a flat shortLoadFee.
 *
 * The short-load row's `key` must not reuse `'material'`: `LineKey` is a row's identity, a UI is
 * likely to use it as a React key or to look rows up by key, and two `'material'` rows in one
 * `lines` array would make one overwrite or swallow the other (the total stays right while the
 * breakdown silently loses a row). It uses `'mobilization'` instead, which is what a fixed charge
 * independent of quantity is; the label is unchanged.
 */
function estimateVolumeJob(
  input: VolumeJob,
  rates: RateCard,
  params: JobParams & { shortLoadThresholdCuYd: Tracked<number>; shortLoadFee: Tracked<number> },
): CostBreakdown {
  const dispersion = rates.dispersion.value;
  const builder = createLineBuilder(dispersion);
  const cuYd = input.volumeCuYd;

  const materialPoint = cuYd * params.wasteFactor.value * rates.materialPerCuYd.value * rates.regionFactor.value;
  builder.add('material', 'Ready-mix concrete material (delivered)', materialPoint, [
    params.wasteFactor.prov,
    rates.materialPerCuYd.prov,
    rates.regionFactor.prov,
  ]);

  const isShortLoad = cuYd < params.shortLoadThresholdCuYd.value;
  if (isShortLoad) {
    builder.add(
      'mobilization',
      `Short load fee (below ${params.shortLoadThresholdCuYd.value} cu yd minimum)`,
      params.shortLoadFee.value,
      [params.shortLoadThresholdCuYd.prov, params.shortLoadFee.prov],
    );
  }

  const totalPoint = builder.total();
  return {
    unit: 'cuyd',
    quantity: cuYd,
    quantityLabel: `${cuYd} cu yd`,
    total: money(totalPoint, dispersion),
    perUnit: money(totalPoint / cuYd, dispersion),
    lines: builder.lines,
    geo: geoOf(rates),
    asOf: asOfOf(rates),
    notices: noticesOf(rates.metro),
  };
}

// ═══════════ 5. Block ═══════════

/**
 * Only the standard 8"x8"x16" CMU is priced. `blockType` is an open string on `BlockJob`;
 * `undefined` means "not given, treat as the standard block". Any other explicit value throws
 * rather than silently pricing as standard, to avoid the trap where an unknown open-string key
 * quietly falls back to a default price (failing while looking like success).
 */
const STANDARD_BLOCK_TYPE = 'standard-8in';

function assertStandardBlockType(blockType: string | undefined): void {
  if (blockType === undefined || blockType === STANDARD_BLOCK_TYPE) return;
  throw new Error(
    `estimate: unsupported blockType "${blockType}" — only the standard 8" CMU is priced ` +
      `(omit blockType, or pass "${STANDARD_BLOCK_TYPE}"). Refusing to silently price it as standard.`,
  );
}

function estimateBlockJob(input: BlockJob, rates: RateCard, params: JobParams & { unitMaterial: Tracked<number> }): CostBreakdown {
  assertStandardBlockType(input.blockType);
  const dispersion = rates.dispersion.value;
  const builder = createLineBuilder(dispersion);

  builder.add('mobilization', 'Mobilization (site setup & delivery)', params.mobilization.value, [
    params.mobilization.prov,
  ]);

  const materialPoint = input.blockCount * params.wasteFactor.value * params.unitMaterial.value;
  builder.add('material', 'CMU block material', materialPoint, [params.wasteFactor.prov, params.unitMaterial.prov]);

  const laborHours = input.blockCount / params.crewUnitsPerHour.value;
  const laborPoint = laborHours * rates.metro.wageHourly.value * rates.laborBurden.value * rates.quoteMultiplier.value;
  builder.add('labor', 'Labor & placement', laborPoint, [
    params.crewUnitsPerHour.prov,
    rates.metro.wageHourly.prov,
    rates.laborBurden.prov,
    rates.quoteMultiplier.prov,
  ]);

  const totalPoint = builder.total();
  return {
    unit: 'block',
    quantity: input.blockCount,
    quantityLabel: `${input.blockCount} block${input.blockCount === 1 ? '' : 's'}`,
    total: money(totalPoint, dispersion),
    perUnit: money(totalPoint / input.blockCount, dispersion),
    lines: builder.lines,
    geo: geoOf(rates),
    asOf: asOfOf(rates),
    notices: noticesOf(rates.metro),
  };
}

// ═══════════ 6. Rebar ═══════════

function astmA615Weight(value: number): Tracked<number> {
  return {
    value,
    prov: {
      level: 'sourced',
      source: 'ASTM A615 standard rebar weight table (physical specification, not market data)',
      ref: 'ASTM A615',
      asOf: 'n/a (physical specification, not a time series)',
    },
  };
}

/**
 * ASTM A615 standard rebar weight in pounds per foot (#3–#8), checked against the industry
 * standard table. A barSize outside the table throws explicitly in `estimateRebarJob`; it is never
 * silently estimated from a neighboring size or treated as 0.
 */
const REBAR_POUNDS_PER_FOOT: ReadonlyMap<number, Tracked<number>> = new Map([
  [3, astmA615Weight(0.376)],
  [4, astmA615Weight(0.668)],
  [5, astmA615Weight(1.043)],
  [6, astmA615Weight(1.502)],
  [7, astmA615Weight(2.044)],
  [8, astmA615Weight(2.67)],
]);

function estimateRebarJob(input: RebarJob, rates: RateCard, params: JobParams & { unitMaterial: Tracked<number> }): CostBreakdown {
  const poundsPerFoot = REBAR_POUNDS_PER_FOOT.get(input.barSize);
  if (!poundsPerFoot) {
    throw new Error(
      `estimate: unsupported rebar barSize #${input.barSize} — only #${[...REBAR_POUNDS_PER_FOOT.keys()].join(', #')} ` +
        `are priced (ASTM A615 table in model.ts). Refusing to silently guess a weight.`,
    );
  }
  // spacingIn (an optional field of RebarJob) does not enter pricing: the formula uses only
  // lengthFt. spacingIn is an input for whoever converts a spacing into a total length in feet
  // upstream (a UI or the user), not a pricing basis here.
  const dispersion = rates.dispersion.value;
  const builder = createLineBuilder(dispersion);

  builder.add('mobilization', 'Mobilization (site setup & delivery)', params.mobilization.value, [
    params.mobilization.prov,
  ]);

  const materialPoint = input.lengthFt * poundsPerFoot.value * params.wasteFactor.value * params.unitMaterial.value;
  builder.add('material', `#${input.barSize} rebar material`, materialPoint, [
    poundsPerFoot.prov,
    params.wasteFactor.prov,
    params.unitMaterial.prov,
  ]);

  const laborHours = input.lengthFt / params.crewUnitsPerHour.value;
  const laborPoint = laborHours * rates.metro.wageHourly.value * rates.laborBurden.value * rates.quoteMultiplier.value;
  builder.add('labor', 'Labor & placement', laborPoint, [
    params.crewUnitsPerHour.prov,
    rates.metro.wageHourly.prov,
    rates.laborBurden.prov,
    rates.quoteMultiplier.prov,
  ]);

  const totalPoint = builder.total();
  const REBAR_STICK_LENGTH_FT = 20; // Common retail / job-site stock length; used only to convert to the "how many bars" secondary quantity.
  const bars = Math.ceil(input.lengthFt / REBAR_STICK_LENGTH_FT);
  const secondaryQuantities: SecondaryQuantity[] = [
    { label: `#${input.barSize} bars @ ${REBAR_STICK_LENGTH_FT} ft`, value: bars, unit: 'bars' },
    // Theoretical weight (no waste): ASTM A615 lb/ft × length. Emitted so a rebar page can show
    // pounds first, instead of back-computing them from the material-line point by dividing out the
    // unit price and waste, which would tie a physical quantity to the pricing formula.
    { label: 'total weight', value: input.lengthFt * poundsPerFoot.value, unit: 'lb' },
  ];

  return {
    unit: 'lnft',
    quantity: input.lengthFt,
    quantityLabel: `${input.lengthFt} lin ft (#${input.barSize} rebar)`,
    total: money(totalPoint, dispersion),
    perUnit: money(totalPoint / input.lengthFt, dispersion),
    lines: builder.lines,
    geo: geoOf(rates),
    asOf: asOfOf(rates),
    notices: noticesOf(rates.metro),
    secondaryQuantities,
  };
}

// ═══════════ 7. The one entry point ═══════════

export const estimate: Estimator = (input, rates, params) => {
  switch (input.kind) {
    case 'slab':
    case 'driveway':
    case 'patio':
      return estimateAreaJob(input, rates, params[input.kind], params.volume);
    case 'volume':
      return estimateVolumeJob(input, rates, params.volume);
    case 'block':
      return estimateBlockJob(input, rates, params.block);
    case 'rebar':
      return estimateRebarJob(input, rates, params.rebar);
    default: {
      // JobKind is exhaustive: if a new kind is added to CostInput and this switch is not updated,
      // `_exhaustive: never` fails to compile here (found at build time, not at runtime).
      const _exhaustive: never = input;
      throw new Error(`estimate: unhandled CostInput kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Compile-time assertion: the shape of estimate must be assignable to Estimator, so a signature drift fails here first. */
export const _typeCheckEstimate: Estimator = estimate;
