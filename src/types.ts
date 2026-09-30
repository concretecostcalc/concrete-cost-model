/**
 * Type contract for the cost model.
 *
 * The model is a pure, synchronous function: `(input, rateCard, jobParams) => CostBreakdown`.
 * No I/O, no globals. Everything it needs is injected through the types below.
 */

// ═══════════ 1. Provenance envelope ═══════════
// Every parameter carries its own provenance. We apply extrapolation and multipliers to public
// data, so a value must never be presented as if it came unmodified from the original source.

/** Trust level of a parameter: taken directly from government data / a multiplier we calibrated / an assumption with no data behind it. */
export type ParamLevel = 'sourced' | 'calibrated' | 'assumed';

/** Geographic granularity at which a value actually applies. */
export type GeoLevel = 'metro' | 'state' | 'region' | 'national';

export interface Provenance {
  level: ParamLevel;
  /** e.g. 'BLS OEWS' | 'Census EC2200' | 'BLS PPI' | 'Derived by ConcreteCostCalc from BLS OEWS' */
  source: string;
  /** e.g. 'SOC 47-2051' | 'PCU327320327320' | 'EC2200NAPCSINDPRD' */
  ref?: string;
  /** Date of the data (not the date it was fetched): '2025-05' | '2022' */
  asOf: string;
  /** Geographic level at which the value actually applies */
  geo?: GeoLevel;
  /**
   * Non-empty means a fallback happened and a UI must surface it (coverage for the main
   * occupation is 336 of 393 metros, and the rest is disclosed rather than hidden).
   * The value is the level we wanted but could not get; `geo` says where we actually landed.
   */
  fellBackFrom?: GeoLevel;
  /** e.g. 'No SOC 47-2051 data for this metro; SOC 47-2061 used as a substitute' */
  note?: string;
}

export interface Tracked<T = number> {
  value: T;
  prov: Provenance;
}

// ═══════════ 2. Prices: never a single number ═══════════
// Same-county, same-day, same-strength ready-mix quotes have been observed at $173 / $200 / $285,
// a 65% spread. A point value is wrong even when it is geographically exact, so every price is a range.

export interface Money {
  low: number;
  /**
   * Central estimate.
   * A UI must show it together with low/high and must never present it alone as "the price".
   */
  point: number;
  high: number;
}

// ═══════════ 3. Input: six job kinds, four pricing units ═══════════

export type JobKind =
  | 'slab' // sq ft
  | 'driveway'
  | 'patio'
  | 'volume' // cu yd
  | 'block' // block
  | 'rebar'; // lin ft

export type Unit = 'sqft' | 'cuyd' | 'block' | 'lnft';

export type Reinforcement = 'none' | 'mesh' | 'rebar';
export type Finish = 'broom' | 'smooth' | 'stamped' | 'exposed';

export interface AreaJob {
  kind: 'slab' | 'driveway' | 'patio';
  areaSqFt: number;
  /**
   * Optional length and width (ft). Used only when **both are given, both > 0, and
   * `lengthFt × widthFt` is within 1% of `areaSqFt`**. In that case the form perimeter is the real
   * rectangle's `2 × (length + width)`; otherwise it falls back to a square assumption, `4 × √area`.
   * Callers that only know the area are unaffected.
   * When length/width disagree with the area, the area wins: it drives concrete, labor, subbase and
   * nearly every other line, so it is the primary input. The model falls back instead of throwing,
   * because it runs on user-entered values and an inconsistent optional hint should not crash the estimate.
   */
  lengthFt?: number;
  widthFt?: number;
  thicknessIn: number;
  options?: {
    reinforcement?: Reinforcement;
    finish?: Finish;
    subbaseIn?: number;
    removeExisting?: boolean;
    pumpRequired?: boolean;
  };
}
export interface VolumeJob {
  kind: 'volume';
  volumeCuYd: number;
}
export interface BlockJob {
  kind: 'block';
  blockCount: number;
  blockType?: string;
}
export interface RebarJob {
  kind: 'rebar';
  lengthFt: number;
  barSize: number;
  spacingIn?: number;
}

export type CostInput = AreaJob | VolumeJob | BlockJob | RebarJob;

// ═══════════ 4. Injected data ═══════════

export interface MetroRate {
  /** e.g. '26420'; the national baseline uses 'US' */
  cbsa: string;
  /** e.g. 'Houston-The Woodlands-Sugar Land, TX' */
  name: string;
  state: string | null;
  /** Mean hourly wage (BLS OEWS) */
  wageHourly: Tracked<number>;
  /**
   * Macro region used for material pricing: only these four (plus `'US'` for the national baseline).
   * Material prices come from a national Census baseline plus BLS PPI indexes for the four Census
   * regions; state-level material data is suppressed for confidentiality, so material precision is
   * inherently coarser than labor's metro-level precision. That is a known limitation.
   *
   * Do not confuse this with `'region'` in {@link GeoLevel}: `GeoLevel` is the geographic fallback
   * ladder (metro → state → region → national), while this is the administrative region used for
   * material pricing. The type system catches a wrong assignment but not confusion in prose, which
   * is why the field is deliberately not named `region`.
   */
  materialRegion: 'NE' | 'MW' | 'S' | 'W' | 'US';
  /**
   * OEWS wage percentiles (25th / 75th percentile hourly wage).
   *
   * Used as the `sourced` basis for the labor price range: instead of a width driven only by our
   * own calibrated `RateCard.dispersion` multiplier, the labor part of the range can come directly
   * from government data. In our measurements the P75/P25 ratio was stable across metros
   * (median about 1.35 for both SOC 47-2051 and 47-2061).
   *
   * Optional because (1) a metro that fell back to another geography may not have percentiles, and
   * (2) there is no equivalent for materials. Labor and materials therefore get their spread from
   * different places and one coefficient cannot serve both.
   */
  wageP25?: Tracked<number>;
  wageP75?: Tracked<number>;
}

export interface RateCard {
  metro: MetroRate;
  /** Wage → cost of employment */
  laborBurden: Tracked<number>;
  /** Cost of employment → price actually paid (industry sources disagree, 1.8-4x; we use a calibrated value and disclose it) */
  quoteMultiplier: Tracked<number>;
  /** Census baseline extrapolated to the current period with PPI */
  materialPerCuYd: Tracked<number>;
  /** Regional material factor */
  regionFactor: Tracked<number>;
  /**
   * Quote dispersion → determines the width of low/high.
   * It lives on the RateCard rather than on each LineItem: summing per-line ranges would overstate
   * the spread (it implicitly assumes perfectly correlated lines). How dispersion is combined across
   * lines is a modeling question that the contract does not prescribe.
   */
  dispersion: Tracked<number>;
}

/** A rate table export has exactly this shape: a national baseline plus one row per metro. */
export interface RateTable {
  generatedAt: string;
  national: RateCard;
  /** One row per metropolitan area */
  metros: MetroRate[];
  /**
   * Material factors for the four regions (plus the national baseline). `MetroRate.materialRegion`
   * points into this table.
   *
   * Why it exists: material prices move with BLS PPI's four regional indexes, but
   * `RateCard.regionFactor` is a **single value** that only the `national` RateCard can hold.
   * Without this table every metro built by `buildRateCard` would inherit the national factor,
   * `materialRegion` would be decorative, and switching city would change only labor while materials
   * stayed put: the "national average plus a place-name label" behavior this model exists to avoid.
   *
   * Deliberately a `Record` keyed by a literal union rather than by open strings: a missing region
   * is a compile error, not a silent `undefined` at runtime.
   */
  regionFactors: Record<MetroRate['materialRegion'], Tracked<number>>;
}

/**
 * Builds a full `RateCard` from a `RateTable` and a CBSA code.
 *
 * `RateTable` provides `national` (one complete RateCard) plus `metros` (only wage and material
 * region). How to compose them on a city switch has to be defined once, or every caller would
 * assemble its own version without any error.
 *
 * Contract (implementations must follow it):
 * 1. Start from `national` and inherit field by field.
 * 2. Replace `metro` with the selected `MetroRate`.
 * 3. Override the fields that depend on the metro (at least `metro.wageHourly`; `dispersion`
 *    should be derived from the percentiles when the metro has them, with `prov.level` marked `'sourced'`).
 * 4. When the `cbsa` is not found, return `null`. Never silently fall back to `national`: that would
 *    let a user believe they are seeing local prices while seeing national ones.
 *
 * How `dispersion` is derived from the percentiles is a modeling choice that the contract leaves to the implementation.
 */
export type BuildRateCard = (table: RateTable, cbsa: string) => RateCard | null;

/**
 * Pricing parameters for optional features of area jobs (slab / driveway / patio).
 *
 * A `Record` keyed by a literal union, rather than by arbitrary strings, is deliberate: every
 * value in the union must have a parameter and a missing one is a compile error. With open string
 * keys, `options.finish = 'stamped'` could find no price and silently cost $0: no error, a total
 * that looks fine but is too low.
 *
 * The contract only guarantees that every option value has a parameter. Whether it is $/sq ft,
 * $/(sq ft·inch) or a flat fee is decided by the implementation and documented there.
 */
export interface AreaJobExtras {
  reinforcement: Record<Reinforcement, Tracked<number>>;
  finish: Record<Finish, Tracked<number>>;
  /**
   * $/(sq ft·inch) of crushed-stone subbase, per inch.
   * A compacted stone subbase is standard practice for residential slabs, driveways and patios,
   * so the baseline scenario already includes one at `JobParams.defaultSubbaseIn` thickness, and
   * `options.subbaseIn`, when present, overrides that thickness. This one rate serves both cases.
   */
  subbase: Tracked<number>;
  demolition: Tracked<number>;
  pump: Tracked<number>;
}

/** Default parameters per job kind */
export interface JobParams {
  /** Fixed mobilization fee: the reason small jobs have an exploding unit price */
  mobilization: Tracked<number>;
  wasteFactor: Tracked<number>;
  /**
   * All-in output **per worker-hour** (form setting, prep, placing, finishing, stripping),
   * not per crew-hour. Reading the same number as "per worker" versus "per 4-person crew" changes
   * the labor line of a 400 sq ft slab by 4x, and both readings compile, so the unit matters.
   *
   * The unit varies by job kind and the contract does not unify it:
   * sq ft/hr for slab/driveway/patio, cu yd/hr for volume, blocks/hr for block, lin ft/hr for rebar.
   * An implementation must interpret it per `kind`; values must not be compared or summed across kinds.
   *
   * `volume` jobs are priced as delivered concrete only and use no labor. The field still exists
   * on `volume` (`JobParams` is the shared base shape) but the model must not read it there.
   */
  crewUnitsPerHour: Tracked<number>;
}

/**
 * Area jobs (slab/driveway/patio) must also carry `areaExtras`; other kinds do not have that field.
 * Forgetting it is a compile error, not a silent $0.
 *
 * Kind-specific additions, following the same principle:
 * · `block` / `rebar` add `unitMaterial`: $/block for block, $/lb for rebar (converted to $/lin ft
 *   with the ASTM A615 weight per foot).
 * · `volume` adds `shortLoadThresholdCuYd` and `shortLoadFee`. The volume page prices delivered
 *   concrete only, with no labor; these two parameters are the source of its nonlinearity
 *   (a surcharge for small orders).
 * · `slab` / `driveway` / `patio` add `forms` and `defaultSubbaseIn`. Quoted "materials" usually include
 *   forms and subbase, not only ready-mix, and both are standard practice:
 *   - `forms: Tracked<number>`: form **material**, $/linear ft along the perimeter. Form **labor** is
 *     already inside the all-in `crewUnitsPerHour`, so do not count it again elsewhere.
 *   - `defaultSubbaseIn: Tracked<number>`: crushed-stone subbase thickness (inches) used when the user
 *     gives no `options.subbaseIn`; priced with `AreaJobExtras.subbase`.
 */
export type JobParamsByKind = {
  [K in JobKind]: K extends 'slab' | 'driveway' | 'patio'
    ? JobParams & { areaExtras: AreaJobExtras; forms: Tracked<number>; defaultSubbaseIn: Tracked<number> }
    : K extends 'volume'
      ? JobParams & { shortLoadThresholdCuYd: Tracked<number>; shortLoadFee: Tracked<number> }
      : K extends 'block' | 'rebar'
        ? JobParams & { unitMaterial: Tracked<number> }
        : JobParams;
};

// ═══════════ 5. Output ═══════════

export type LineKey =
  | 'material'
  | 'labor'
  | 'mobilization'
  | 'subbase'
  | 'reinforcement'
  | 'finish'
  | 'pump'
  | 'demolition';

export interface LineItem {
  key: LineKey;
  label: string;
  amount: Money;
  /** Every parameter this line used, so a UI can expand each line into its sources */
  inputs: Provenance[];
}

/**
 * Secondary quantity. The same job often has a second way of counting that people care about:
 * rebar as bars, not only feet; volume as truckloads; block as pallets.
 * Omitted when a job kind has only one way of counting.
 *
 * `unit` is free text and is not part of the `Unit` union, which only covers pricing units
 * (the denominator of `perUnit`).
 */
export interface SecondaryQuantity {
  label: string; // '#4 bars @ 20 ft'
  value: number; // 12
  unit: string; // 'bars'
}

export interface CostBreakdown {
  unit: Unit;
  /** Quantity being priced (4.9 CY / 37 #4 bars / 420 blocks) */
  quantity: number;
  quantityLabel: string;
  total: Money;
  /** total / quantity */
  perUnit: Money;
  lines: LineItem[];
  geo: { level: GeoLevel; label: string; cbsa: string | null; fellBackFrom: GeoLevel | null };
  asOf: { wages: string; material: string; index: string };
  /** Fallbacks, substitutions and suppressions that must be shown to the user */
  notices: string[];
  /** Second way of counting for this job kind (e.g. number of rebar bars). Omitted = only one way. */
  secondaryQuantities?: SecondaryQuantity[];
}

// ═══════════ 6. The one entry point: pure, synchronous, zero I/O ═══════════

export type Estimator = (input: CostInput, rates: RateCard, params: JobParamsByKind) => CostBreakdown;
