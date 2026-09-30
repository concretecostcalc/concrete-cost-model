# concrete-cost-model

The cost model behind [concretecostcalc.com](https://concretecostcalc.com): a small, pure TypeScript library that estimates residential concrete work (slab, driveway, patio, ready-mix volume, block wall, rebar) as a **price range** that changes with location, where every parameter carries its source and date. The full method is described at [concretecostcalc.com/methodology](https://concretecostcalc.com/methodology).

- No I/O, no globals, no runtime dependencies: `estimate(input, rateCard, jobParams)` is a synchronous pure function.
- Every price is a `low / point / high` range, never a single number.
- Every parameter is a `Tracked<number>`: a value plus its level (`sourced` / `calibrated` / `assumed`), source, reference and as-of date.

## The formula

```
total = fixed mobilization + area × marginal rate
```

More precisely, for a slab, driveway or patio:

| Component | How it is computed |
|---|---|
| Mobilization | A fixed fee per job kind (arrival, layout, small equipment). Does not scale with area. |
| Material | Ready-mix volume (area × thickness ÷ 27, times a waste factor) × regional $/cu yd, plus form material along the perimeter, plus a short-load fee when the ordered volume is below a truck. |
| Labor | Area ÷ all-in output per worker-hour × local hourly wage × labor burden × quote multiplier. The wage comes from the metro area. |
| Add-ons | Crushed-stone subbase (on by default), reinforcement, finish, removal of an existing slab, pump. |
| Range | `low` and `high` are `point × (1 ∓ dispersion)`, where dispersion combines quote spread and local wage spread as `sqrt(market² + wage²)`. |

**Why not `area × price`?** A flat $/sq ft rate is fitted to mid-sized jobs. On a small job the fixed costs (getting a crew and a truck to the site) dominate, so the price per square foot explodes, and a linear model prices it far too low. With the bundled national sample data, a 4 in slab comes out as:

| Job | Total | Per sq ft |
|---|---|---|
| 40 sq ft | $1,120 – $2,230 | $28.00 – $55.66 |
| 400 sq ft | $3,010 – $5,990 | $7.53 – $14.97 |

Taking the 400 sq ft typical rate ($11.25/sq ft) and multiplying by 40 sq ft gives about $450, while the model's typical figure for the 40 sq ft job is about $1,670, roughly 3.7 times higher.

These numbers are produced by the code itself (`estimate` with `examples/rates.sample.json`, national card, `JOB_PARAMS`, formatted with `formatRange` / `formatUnitRange`) and are pinned in `test/readme-examples.test.ts`, so they cannot drift from the code.

## Quick start

```ts
import rates from './examples/rates.sample.json';
import { allocateDisplay } from './src/breakdown-display';
import { buildRateCard, estimate } from './src/model';
import { JOB_PARAMS } from './src/params';
import type { RateTable } from './src/types';

// 26420 = Houston. buildRateCard returns null for an unknown CBSA; it never falls back to national.
const card = buildRateCard(rates as unknown as RateTable, '26420');
if (!card) throw new Error('unknown CBSA');

const breakdown = estimate({ kind: 'slab', areaSqFt: 400, thicknessIn: 4 }, card, JOB_PARAMS);
const display = allocateDisplay(breakdown); // whole dollars; line items add up to the total

console.log(display.total.rangeWithTypicalText); // $2,750 – $5,500 (typical ≈ $4,130)
for (const line of display.lines) console.log(line.label, line.rangeText);
// Mobilization (site setup & delivery) $800 – $1,600
// Concrete material (incl. forms) $580 – $1,170
// Labor & placement $1,230 – $2,450
// Subbase (4 in) $140 – $280
```

The same 400 sq ft slab in the sample data: national $3,010 – $5,990, Houston $2,750 – $5,500, Seattle $3,320 – $7,770, Columbus OH $3,140 – $6,490. Labor changes with the metro's wage, materials with the region's price index, and the range width with the local wage spread.

Other job kinds: `{ kind: 'volume', volumeCuYd }`, `{ kind: 'block', blockCount }`, `{ kind: 'rebar', lengthFt, barSize }`. Optional inputs for area jobs include `lengthFt` / `widthFt` (real form perimeter instead of a square assumption), `reinforcement`, `finish`, `subbaseIn`, `removeExisting` and `pumpRequired`.

Each line item lists the provenance of every parameter it used (`line.inputs`), and `breakdown.notices` carries fallbacks such as a substituted occupation or a state-level wage that a UI should show.

## Parameter levels

Every parameter in `src/params.ts` is labeled with how much evidence stands behind it:

| Level | Meaning |
|---|---|
| `sourced` | Taken directly from a public data series (for example a BLS wage or a PPI index) or a physical standard (ASTM A615 rebar weights). |
| `calibrated` | A multiplier or rate we derived from public data or published guides, with the derivation in `ref` / `note`. |
| `assumed` | No public data supports it; kept as a stated assumption and never presented as data. |

Derived values inherit the weakest level of their inputs. Because we apply extrapolation and multipliers to public data, a value is never presented as if it came unmodified from the original source.

## Data

`examples/rates.sample.json` is a sample rate table: the national baseline, three metro areas (Houston 26420, Seattle 42660, Columbus OH 18140), and the four regional material factors. It has the shape of the `RateTable` type in `src/types.ts`.

It was derived by ConcreteCostCalc from BLS OEWS wages (May 2025), BLS PPI material indexes, BLS ECEC compensation costs, and the U.S. Census Bureau 2022 Economic Census, with extrapolation and multiplier calculations applied. It is a sample for trying the model, not an official statistic of any of those agencies.

- This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.
- This project is not endorsed or certified by the Bureau of Labor Statistics.
- No agency logos or seals are used.

The full rate table for all 393 metropolitan areas and the data ingestion pipeline are not part of this repository.

## Limitations

This is a planning estimate, not a quote. Wages come from an annual release with roughly a 12-month lag and are a three-year rolling average; materials come from a 2022 Census baseline extrapolated with PPI at national and four-region granularity, coarser than the metro-level labor; the wage-to-price multiplier is a calibrated value where industry sources disagree. Known limitations are listed at [concretecostcalc.com/methodology](https://concretecostcalc.com/methodology).

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
```

Layout: `src/model.ts` (the estimator and `buildRateCard`), `src/types.ts` (contract), `src/params.ts` (parameters with provenance), `src/occupation-ratio.ts` (wage ratios for substitute occupations), `src/money.ts` and `src/breakdown-display.ts` (range formatting and whole-dollar allocation), `src/bags.ts` (80 lb bag counts).

## License

[MIT](LICENSE)
