/**
 * Number of 80 lb bags of concrete for a given volume (80 lb bags only).
 *
 * The bag constants live in exactly one place, so the same volume cannot produce different bag
 * counts in different callers.
 *
 * The count is `Math.round(volume × BAGS_PER_CU_YD)`: **no waste allowance**, rounded to a whole bag.
 * That differs from price: the material line in a price estimate is multiplied by a waste factor
 * (`wasteFactor`) and the bag count is not, which is why the text says "no waste allowance" and
 * leaves the choice of buying a few extra bags to the reader.
 *
 * Only a bag count is given, not a bagged-concrete price: there is no public data source for it.
 *
 * This file depends only on pure constants and pure functions.
 */

/**
 * Yield of one standard 80 lb bag of ready-mix concrete, in cubic feet, once mixed. This is a
 * generic bagged-concrete industry figure (the number printed on most 80 lb bag product data
 * sheets across manufacturers), not a single brand's spec.
 */
export const BAG_YIELD_CU_FT = 0.6;

const CU_FT_PER_CU_YD = 27;

/** Bags of standard 80 lb bagged concrete needed to fill one cubic yard, rounded to a whole bag. */
export const BAGS_PER_CU_YD = Math.round(CU_FT_PER_CU_YD / BAG_YIELD_CU_FT);

/** Number of 80 lb bags needed for a volume in cubic yards: no waste allowance, rounded to a whole bag. */
export function bagsForCuYd(cuYd: number): number {
  return Math.round(cuYd * BAGS_PER_CU_YD);
}

/**
 * One line of result text, e.g. `"About 225 bags of 80-lb concrete (0.6 cu ft each, no waste allowance)"`.
 * "bags of" sits between the number and "80-lb" so two numbers are not adjacent ("225 80-lb bags"),
 * which is hard to read. A volume under half a bag would round to 0, so it reads "Less than one
 * bag" instead of "About 0 bags".
 */
export function formatBagsLine(cuYd: number): string {
  const bags = bagsForCuYd(cuYd);
  const detail = `${BAG_YIELD_CU_FT} cu ft each, no waste allowance`;
  if (bags < 1) return `Less than one bag of 80-lb concrete (${detail})`;
  return `About ${bags.toLocaleString('en-US')} ${bags === 1 ? 'bag' : 'bags'} of 80-lb concrete (${detail})`;
}
