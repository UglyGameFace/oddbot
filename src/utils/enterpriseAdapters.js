// src/utils/enterpriseAdapters.js
// Minimal, handler-facing helpers that custom.js expects as named exports.
// ESM named exports must match import names exactly on Linux/Node 20.

import env from '../config/env.js';

export function formatGameTimeTZ(iso, tz = env.TIMEZONE || 'America/New_York') {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short',
    });
  } catch {
    return '';
  }
}

export function toDecimalFromAmerican(a) {
  const n = Number(a);
  if (!Number.isFinite(n)) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

export function toAmerican(decimalOdds) {
  const d = Number(decimalOdds);
  if (!Number.isFinite(d) || d <= 1) return 0;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

export function impliedProbability(decimalOdds) {
  const d = Number(decimalOdds);
  return d > 1 ? 1 / d : 0;
}

export function groupLegsByGame(legs) {
  const by = {};
  for (const leg of legs || []) {
    if (!by[leg.game]) by[leg.game] = { legs: [], commence_time: leg.commence_time || null, sport: leg.sport || '' };
    by[leg.game].legs.push(leg);
    if (!by[leg.game].commence_time && leg.commence_time) by[leg.game].commence_time = leg.commence_time;
  }
  return by;
}
