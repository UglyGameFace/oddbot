// src/services/advancedOddsModel.js - REAL IMPROVEMENTS FOR AI/BETTING ANALYSIS

export default {
  /**
   * Calculates implied probabilities for all main outcomes (home, draw, away)
   * from the best available decimal odds among all bookmakers.
   * Returns { home: x, draw: y, away: z } where values are probabilities (0-1).
   */
  calculateImpliedProbabilities(game) {
    if (!game.bookmakers || !Array.isArray(game.bookmakers)) return {};
    const bestOdds = { home: Infinity, draw: Infinity, away: Infinity };

    for (const bm of game.bookmakers) {
      for (const market of bm.markets) {
        if (market.key === 'h2h') {
          for (const outcome of market.outcomes) {
            if (/home/i.test(outcome.name) && outcome.price < bestOdds.home) {
              bestOdds.home = outcome.price;
            } else if (/draw/i.test(outcome.name) && outcome.price < bestOdds.draw) {
              bestOdds.draw = outcome.price;
            } else if (/away/i.test(outcome.name) && outcome.price < bestOdds.away) {
              bestOdds.away = outcome.price;
            }
          }
        }
      }
    }
    const impliedProbs = {};
    if (bestOdds.home !== Infinity) impliedProbs.home = +(1 / bestOdds.home).toFixed(4);
    if (bestOdds.draw !== Infinity) impliedProbs.draw = +(1 / bestOdds.draw).toFixed(4);
    if (bestOdds.away !== Infinity) impliedProbs.away = +(1 / bestOdds.away).toFixed(4);
    return impliedProbs;
  },

  /**
   * Feature-engineers useful metrics for each game object.
   * Returns { daysUntil, spread, totalPoints }
   */
  engineerGameFeatures(game) {
    const now = new Date();
    const gameDate = new Date(game.commence_time);
    const daysUntil = Math.max(0, (gameDate - now) / (1000 * 60 * 60 * 24));
    const spread = this.extractSpread(game);
    const totalPoints = this.extractTotalPoints(game);
    return { daysUntil, spread, totalPoints };
  },

  extractSpread(game) {
    if (!game.bookmakers) return null;
    let bestSpread = null;
    for (const bm of game.bookmakers) {
      for (const market of bm.markets) {
        if (market.key === 'spreads') {
          for (const outcome of market.outcomes) {
            if (bestSpread === null || Math.abs(outcome.point) < Math.abs(bestSpread)) {
              bestSpread = outcome.point;
            }
          }
        }
      }
    }
    return bestSpread;
  },

  extractTotalPoints(game) {
    if (!game.bookmakers) return null;
    for (const bm of game.bookmakers) {
      for (const market of bm.markets) {
        if (market.key === 'totals') {
          for (const outcome of market.outcomes) {
            if (/over/i.test(outcome.name) && outcome.point) {
              return outcome.point;
            }
          }
        }
      }
    }
    return null;
  }
};
