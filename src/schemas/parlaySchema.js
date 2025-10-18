// src/schemas/parlaySchema.js
export function isValidParlay(obj, minLegs = 1) {
  if (!obj || typeof obj !== 'object') return false;
  const legs = obj.legs;
  if (!Array.isArray(legs) || legs.length < minLegs) return false;
  for (const l of legs) {
    if (!l || typeof l !== 'object') return false;
    if (typeof l.game_id !== 'string') return false;
    if (typeof l.market !== 'string') return false;
    if (typeof l.selection !== 'string') return false;
    if (typeof l.price_american !== 'number') return false;
  }
  return true;
}
