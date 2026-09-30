/**
 * Every parameter of the model, in one place. Each value is labeled `sourced`, `calibrated` or
 * `assumed` according to how much evidence stands behind it, and carries its source, reference and
 * date. The `note` field holds a summary of how the value was set.
 *
 * What is here:
 * · The three RateCard-level multipliers (`LABOR_BURDEN` / `QUOTE_MULTIPLIER` / `NATIONAL_DISPERSION`),
 *   used as defaults when building a rate table without a better data source.
 * · The per-job parameters (`JOB_PARAMS: JobParamsByKind`).
 * This file is pure data: it touches neither a database nor the file system.
 *
 * No fitting: the rule for each value is fixed first and the value computed from it, and a value is
 * never adjusted because an acceptance result for some job kind happens to look good or bad. A
 * value set from evidence that conflicts with an expected range is a finding to report, not a bug
 * to quietly patch here.
 */
import type { AreaJobExtras, JobParamsByKind, Tracked } from './types';

// ═══════════ 1. The three RateCard-level multipliers ═══════════

export const LABOR_BURDEN: Tracked<number> = {
  value: 1.438,
  prov: {
    level: 'sourced',
    source: 'BLS ECEC, construction (private industry, NAICS 23)',
    ref: 'Total compensation CMU2012300000000D ÷ wages and salaries CMU2022300000000D',
    asOf: '2026-Q2',
    geo: 'national',
    note:
      '$51.96/h ÷ $36.13/h = 1.438. Total compensation includes paid leave, supplemental pay, ' +
      "employee insurance, retirement and legally required benefits; it excludes the contractor's own " +
      'business insurance (general liability, commercial auto, etc.), a definitional gap disclosed in the methodology.',
  },
};

export const QUOTE_MULTIPLIER: Tracked<number> = {
  value: 1.995,
  prov: {
    level: 'calibrated',
    source: 'Derived from the U.S. Census Bureau 2022 Economic Census, NAICS 238110 (poured concrete foundation and structure contractors), ÷ LABOR_BURDEN',
    ref: '(RCPTOT 78,743,872 − CSTMPRT 27,191,628) ÷ PAYANN 17,968,785 = 2.869 (thousand USD); 2.869 ÷ 1.438 = 1.995',
    asOf: '2022(Census EC2223BASIC)/2026-Q2(ECEC, used for the split)',
    geo: 'national',
    note:
      'The end-to-end wage-to-price multiplier 2.869 is split into laborBurden (1.438) × quoteMultiplier (1.995). ' +
      'Higher than what public contractor hourly billing rates divided by OEWS wages suggest ' +
      '(NY 1.4-2.8x, LA 1.55-2.59x, Chicago 1.28-1.66x): same direction, but above the top of the observed range.',
  },
};

export const NATIONAL_DISPERSION: Tracked<number> = {
  value: 0.28,
  prov: {
    level: 'calibrated',
    source: 'Steuben County, NY public procurement record PW-26-019-B',
    ref: 'Three same-county, same-day, same-strength quotes: $173 / $200 / $285',
    asOf: '2026-02',
    geo: 'national',
    note:
      '(285−173)÷(2×200) = 0.28 (half-width ÷ central estimate, with the median of the three quotes as the center). ' +
      'One jurisdiction and three quotes: the only public evidence available for quote dispersion (as opposed to wage dispersion), ' +
      'so the sample is thin and confidence is limited.',
  },
};

// ═══════════ 1b. Wage ratios for substitute occupations live in ./occupation-ratio.ts; re-exported here ═══════════
export { OCCUPATION_WAGE_RATIO } from './occupation-ratio';

// ═══════════ 2. Per-job parameters ═══════════

/** For values with no public evidence: the level is always `assumed`, and is never upgraded because a number "looks familiar". */
function assumedParam(value: number, note: string): Tracked<number> {
  return {
    value,
    prov: { level: 'assumed', source: 'concretecostcalc assumption (no public data behind it)', asOf: '2026-09', note },
  };
}

/**
 * Uses the itemized prices in published home-improvement cost guides as **calibration evidence**.
 * `source` is a fixed sentence and names no site; `ref` and `note` describe what the value is
 * calibrated to.
 */
function guideCalibratedParam(value: number, opts: { ref: string; asOf: string; note: string }): Tracked<number> {
  return {
    value,
    prov: {
      level: 'calibrated',
      source: 'Published home-improvement cost guides (used for calibration only)',
      ref: opts.ref,
      asOf: opts.asOf,
      note: opts.note,
    },
  };
}

/**
 * All-in output = billed labor rate ÷ published labor $/sq ft.
 * Billed labor rate = national wage $28.40/h × end-to-end multiplier 2.869 ≈ $81.48/h
 * (cross-checked against QUOTE_MULTIPLIER). slab/driveway/patio share one labor $/sq ft figure:
 * the evidence is not broken down by job kind, and the three kinds also share one `AREA_EXTRAS`.
 */
const AREA_CREW_UNITS_PER_HOUR = guideCalibratedParam(14.81, {
  ref: 'Median of the midpoints of two independent published labor ranges ($5 and $6 per sq ft): $5.5',
  asOf: '2026',
  note: 'sq ft per worker-hour, all-in. $81.48 ÷ $5.5 = 14.81',
});

/**
 * `forms` (form material, $/lin ft). Only one independent source matches the contract's unit
 * ($/linear ft, material only). Another gives $/sq ft, which cannot be converted without assuming
 * a perimeter-to-area ratio, so it is not used. Three more quote installed prices (labor
 * included); form labor is already inside the all-in `crewUnitsPerHour`, so using them would count
 * it twice. The three area kinds share one value because the evidence is not broken down by job kind.
 */
const AREA_FORMS = guideCalibratedParam(2.5, {
  ref: 'One published cost guide: $2-3 per lin ft, material only; midpoint 2.5 (the only independent source that matches in unit and scope)',
  asOf: '2026',
  note:
    '$/lin ft of form material (along the perimeter). Only one source matches the unit and scope ' +
    '($/linear ft, material only); $/sq ft and installed-price sources were not used ' +
    '(installed prices include labor and would double-count the all-in crewUnitsPerHour)',
});

/**
 * The evidence for the default subbase thickness is **technical documentation** (a trade
 * association guide, a supplier's installation guide), not cost sites, so it uses this helper
 * instead of `guideCalibratedParam`.
 */
function technicalGuideParam(value: number, opts: { ref: string; asOf: string; note: string }): Tracked<number> {
  return {
    value,
    prov: {
      level: 'calibrated',
      source: 'Industry technical guides (trade association and building-materials supplier installation guides; not cost sites)',
      ref: opts.ref,
      asOf: opts.asOf,
      note: opts.note,
    },
  };
}

/**
 * `defaultSubbaseIn` (default crushed-stone subbase thickness, in). Three independent non-cost
 * sources apply to different scopes: general guidance (ACPA/PCA) applies to all three kinds; one
 * supplier guide is driveway-specific and recommends leaning toward 6 in; one installer guide is
 * patio-specific. Rule: match each source to the job kinds it covers, then take the median of the midpoints.
 * · slab: only the general source applies (4 in)
 * · driveway: general (4) + driveway-specific (6); median (mean of two) = 5
 * · patio: general (4) + patio-specific (4); median (mean of two) = 4
 */
const SLAB_DEFAULT_SUBBASE_IN = technicalGuideParam(4, {
  ref: 'ACPA "Subgrades and Subbases for Concrete Pavements" EB204P (hosted by PCA), general minimum 4 in',
  asOf: '2024-08',
  note:
    'in, default crushed-stone subbase thickness. No slab-specific source; only one general technical source (not a cost site) applies, so its value 4 is used',
});
const DRIVEWAY_DEFAULT_SUBBASE_IN = technicalGuideParam(5, {
  ref: 'Mean of ACPA EB204P (general, 4 in) and a building-materials supplier technical guide (driveway-specific, recommends leaning toward 6 in)',
  asOf: '2024-08 / 2025',
  note:
    'in, default crushed-stone subbase thickness. A driveway-specific source recommends a thicker base, ' +
    'so the mean of the general source (4) and the driveway-specific recommendation (6) = 5 is used',
});
const PATIO_DEFAULT_SUBBASE_IN = technicalGuideParam(4, {
  ref: 'Mean of ACPA EB204P (general, 4 in) and a manufacturer patio installation guide (patio-specific, 4 in base)',
  asOf: '2024-08 / 2026',
  note: 'in, default crushed-stone subbase thickness. Both sources say 4, so the mean is 4',
});

/** slab/driveway/patio share one set of optional-feature prices (all three kinds use the same values). */
const AREA_EXTRAS: AreaJobExtras = {
  reinforcement: {
    none: assumedParam(0, 'Baseline option (no reinforcement), defined as $0; not market evidence and needs none'),
    mesh: assumedParam(
      0.55,
      '$/sq ft surcharge for wire-mesh reinforcement. No public price difference for mesh was found; the prior estimate is kept',
    ),
    rebar: assumedParam(1.35, '$/sq ft surcharge for rebar reinforcement. As above, no public price difference was found; the prior estimate is kept'),
  },
  finish: {
    broom: assumedParam(0, 'Baseline finish (standard broom finish), defined as $0; needs no evidence'),
    smooth: assumedParam(0.3, '$/sq ft surcharge for a smooth finish. No public figure was found; the prior estimate is kept'),
    stamped: guideCalibratedParam(5.0, {
      ref: 'One published cost guide: stamped all-in $12-18/sq ft, midpoint 15, minus broom all-in $8-12/sq ft, midpoint 10 (difference of two all-in tiers from the same source)',
      asOf: '2026',
      note:
        '$/sq ft surcharge for a stamped finish. The guide publishes all-in prices including the slab, not surcharges, ' +
        'so the value is the difference between the midpoints of two tiers from the same source rather than a copied figure. ' +
        'The two tiers are not paired quotes for the same job, so confidence is limited',
    }),
    exposed: assumedParam(
      2.4,
      '$/sq ft surcharge for an exposed-aggregate finish. The same differencing gives $0 ' +
        '(exposed and broom have the same $8-12 range), which contradicts the expectation that exposed aggregate costs more than broom, ' +
        'so that conversion was judged unreliable and not used; no other independent source exists, so the prior estimate is kept and labeled assumed',
    ),
  },
  subbase: guideCalibratedParam(0.134, {
    ref:
      'One published cost guide: road base $25-62 per cu yd (crush-and-run around $50 per cu yd falls inside this range), ' +
      'midpoint $43.5 per cu yd ÷ 324 (1 cu yd = 27 cu ft; 1 sq ft × 1 in = 1/12 cu ft, so 1 sq ft-in = 1/324 cu yd) = $0.134 per sq ft-in',
    asOf: '2026',
    note:
      '$/(sq ft·inch) of subbase **material**, delivered price. An earlier value of 1.25, derived from a $12-18 per cu ft figure, ' +
      'was about 10x higher than what actual crushed-stone market prices ($25-62 per cu yd, about $0.93-2.30 per cu ft) imply ' +
      '($0.08-0.19 per sq ft-in), so that figure was judged unreliable and dropped in favor of road-base pricing that ' +
      'is cross-checked against market prices. Generic crushed-stone delivered prices and seller-run sites were not used ' +
      '(not the road-base / crush-and-run grade used for subbase, or seller-biased). ' +
      'Scope: this is the **material** delivered price. It does not include spreading and compacting labor: the all-in ' +
      'crewUnitsPerHour covers forming, placing, finishing and stripping but not subbase grading and compaction, and there ' +
      'is no independent labor source for it, so the gap is stated rather than filled with an invented labor multiplier',
  }),
  demolition: guideCalibratedParam(4.0, {
    ref: 'One published cost guide: old-driveway removal $2-6 per sq ft, midpoint 4.0',
    asOf: '2026',
    note: '$/sq ft, demolition and haul-away of an existing slab. One source only',
  }),
  pump: assumedParam(
    650,
    'Flat fee for a concrete pump. No public price difference for pumping was found; the prior estimate is kept and labeled assumed',
  ),
};

export const JOB_PARAMS: JobParamsByKind = {
  slab: {
    mobilization: assumedParam(
      1200,
      'Fixed mobilization fee covering arrival, layout and small equipment. Traceable public mobilization data is almost nonexistent ' +
        '(only two non-comparable small-job cases), and back-solving from small jobs would amount to fitting the model to them. ' +
        'The prior estimate is kept and labeled assumed',
    ),
    wasteFactor: assumedParam(1.05, 'Waste factor. No public figure was found; the prior estimate is kept'),
    crewUnitsPerHour: AREA_CREW_UNITS_PER_HOUR,
    areaExtras: AREA_EXTRAS,
    forms: AREA_FORMS,
    defaultSubbaseIn: SLAB_DEFAULT_SUBBASE_IN,
  },
  driveway: {
    mobilization: assumedParam(1450, 'As for slab: no usable mobilization data; the prior estimate is kept and labeled assumed'),
    wasteFactor: assumedParam(1.07, 'Waste factor. No public figure was found; the prior estimate is kept'),
    crewUnitsPerHour: AREA_CREW_UNITS_PER_HOUR,
    areaExtras: AREA_EXTRAS,
    forms: AREA_FORMS,
    defaultSubbaseIn: DRIVEWAY_DEFAULT_SUBBASE_IN,
  },
  patio: {
    mobilization: assumedParam(1100, 'As for slab: no usable mobilization data; the prior estimate is kept and labeled assumed'),
    wasteFactor: assumedParam(1.05, 'Waste factor. No public figure was found; the prior estimate is kept'),
    crewUnitsPerHour: AREA_CREW_UNITS_PER_HOUR,
    areaExtras: AREA_EXTRAS,
    forms: AREA_FORMS,
    defaultSubbaseIn: PATIO_DEFAULT_SUBBASE_IN,
  },
  volume: {
    mobilization: assumedParam(900, 'Volume jobs price delivered concrete only, so this is not used in pricing: a placeholder whose value enters no calculation'),
    wasteFactor: assumedParam(
      1.03,
      'Waste factor. The volume formula includes wasteFactor (cu yd × wasteFactor × materialPerCuYd × regionFactor), ' +
        'so this value does enter pricing; no public figure was found and the prior estimate is kept',
    ),
    // Volume jobs use no labor pricing. The field must still be filled (JobParams is the shared
    // base shape), but the volume pricing in model.ts must not read it.
    crewUnitsPerHour: assumedParam(3.2, 'Volume jobs price delivered concrete only, so this is not used in pricing: a placeholder whose value enters no calculation'),
    // The short-load threshold is a physical quantity (cu yd) and is unaffected by currency vintage,
    // so both older and newer evidence enter the median. The fee is a dollar amount and is subject
    // to inflation, so older dollar figures are directional reference only and are excluded from
    // the median of amounts.
    //
    // The threshold is taken source by source, not from a compiled summary such as "3-7 yd, median
    // about 5 yd", which is a loose paraphrase and not an independent source. One guide says the
    // markup applies to loads under a full truck (about 10 yd), so its threshold is the truck
    // capacity, 10 yd, and counts; another guide gives a per-yard markup with no threshold and does
    // not count; a contractor-estimating source says "under 3 yd" and counts; two homeowner forum
    // reports (<2.5 yd, <4 yd) count. Four independent thresholds {10, 3, 2.5, 4} sort to
    // [2.5, 3, 4, 10], and the median (mean of the two middle values) = (3+4)/2 = 3.5.
    shortLoadThresholdCuYd: guideCalibratedParam(3.5, {
      ref:
        'Four independent thresholds, taken source by source: "under a full truck (about 10 yd)", "under 3 yd", ' +
        'two homeowner reports (<2.5 yd, <4 yd). A source that gives only a markup amount and no threshold is excluded. ' +
        'Sorted {2.5, 3, 4, 10}, median (mean of the two middle values) = (3+4)/2 = 3.5',
      asOf: '2026',
      note:
        'cu yd; a load below this volume counts as a short load and triggers shortLoadFee. ' +
        'Taken source by source rather than from a compiled summary, which is not an independent source',
    }),
    shortLoadFee: guideCalibratedParam(100, {
      ref:
        'A contractor-estimating source: about $100 per truck (under 3 yd), plus a ready-mix plant\'s actual posted price ' +
        '"$100 or the shortfall, whichever is less" (a real supplier\'s current price, more authoritative than a cost blog). ' +
        'Both say $100, a flat fee in the matching unit. Older homeowner-forum reports of a flat $50 are directional only ' +
        '(dollar amounts have a vintage and inflation problem) and are excluded from the median',
      asOf: '2026',
      note:
        '$, a flat fee charged when the volume is below the threshold. The contract unit is a flat fee, so sources in the same unit are preferred; ' +
        'per-cu-yd surcharges ($40-60 and about $53 per yd) would need an assumed representative small volume to convert ' +
        '(an extra unsupported assumption) and were not used; the converted magnitude would be clearly higher',
    }),
  },
  block: {
    mobilization: assumedParam(650, 'No usable mobilization data; the prior estimate is kept and labeled assumed'),
    wasteFactor: assumedParam(1.02, 'Waste factor. No public figure was found; the prior estimate is kept'),
    crewUnitsPerHour: guideCalibratedParam(10.86, {
      ref: 'One published cost guide: CMU installed price $5.70-11.50 per block (labor $5-10 per block), midpoint 7.5',
      asOf: '2026',
      note:
        'blocks per worker-hour. $81.48 ÷ $7.5 = 10.86. This guide is the only one that prices labor directly in $/block, ' +
        'matching the contract unit, so it is preferred; sources that price per wall area (about $13-18 per block) serve as a cross-check',
    }),
    unitMaterial: guideCalibratedParam(2.0, {
      ref: 'Median of the midpoints of three independent published ranges ($1.25-2.50, $1.00-3.00, $1.50-3.00)',
      asOf: '2026',
      note: '$/block, standard 8-inch CMU material. Midpoints 1.875 / 2.0 / 2.25, median 2.0',
    }),
  },
  rebar: {
    mobilization: assumedParam(500, 'No usable mobilization data; the prior estimate is kept and labeled assumed'),
    wasteFactor: assumedParam(1.08, 'Waste factor. No public figure was found; the prior estimate is kept'),
    crewUnitsPerHour: guideCalibratedParam(118.28, {
      ref: 'One published cost guide: installed price for footing rebar per foot, $0.50-2.00 per lin ft, midpoint minus material cost (unitMaterial × ASTM #4 pounds per foot)',
      asOf: '2026',
      note:
        'lin ft per worker-hour. Installed midpoint $1.25/ft − material 0.84×0.668 = $0.56112/ft = labor $0.68888/ft; ' +
        '$81.48 ÷ $0.68888 ≈ 118.28. One source only, and its scope is footing rebar per foot rather than rebar work in general, so confidence is low',
    }),
    // $/lb; converted to $/lin ft with the ASTM A615 pounds per foot in model.ts.
    unitMaterial: guideCalibratedParam(0.84, {
      ref:
        'Two published $/lb ranges ($0.50-1.00, $0.65-1.00) and two $/ft ranges for #4 bar ($0.60/ft, $0.40-0.75/ft, ' +
        'converted to $/lb with ASTM A615 #4 = 0.668 lb/ft); median of the midpoints of the four independent sources',
      asOf: '2026',
      note: '$/lb of rebar material. Midpoints 0.75 / 0.825 / 0.861 / 0.898, median (0.825+0.861)/2 = 0.84',
    }),
  },
};
