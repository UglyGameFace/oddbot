// src/utils/botUtils.js

const TZ = process.env.TIMEZONE || 'America/New_York';

/**
 * Converts American odds to decimal odds.
 * @param {number} americanOdds - e.g., -110 or 200
 * @returns {number}
 */
export function toDecimalFromAmerican(americanOdds) {
  if (americanOdds > 0) return (americanOdds / 100) + 1;
  return (100 / Math.abs(americanOdds)) + 1;
}

/**
 * Converts decimal odds to American odds.
 * @param {number} decimalOdds - e.g., 1.91 or 3.00
 * @returns {number}
 */
export function toAmericanFromDecimal(decimalOdds) {
    if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
    return Math.round(-100 / (decimalOdds - 1));
}

/**
 * Calculates the implied probability from decimal odds.
 * @param {number} decimalOdds
 * @returns {number} - Probability as a fraction (e.g., 0.52)
 */
export function impliedProbability(decimalOdds) {
  if (decimalOdds <= 0) return 0;
  return 1 / decimalOdds;
}

/**
 * Formats an ISO date string to a user-friendly string in a specific timezone.
 * @param {string} isoString
 * @returns {string}
 */
export function formatGameTimeTZ(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone: TZ,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}
