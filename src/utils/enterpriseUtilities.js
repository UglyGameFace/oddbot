// src/utils/enterpriseUtilities.js - COMPLETE ENHANCED VERSION WITH SCHEDULE SUPPORT

import { createHash } from 'crypto';
import CryptoJS from 'crypto-js';
import MerkleTree from 'merkletreejs';
import { getSportEmoji as getEmoji } from '../services/sportsService.js';

// --- ENHANCED TELEGRAM MARKDOWN ESCAPING ---
/**
 * Escapes characters that have special meaning in Telegram's MarkdownV2.
 * @param {string | number} text The text to escape.
 * @returns {string} The escaped text.
 */
export function escapeMarkdownV2(text) {
  // Ensure input is a string before calling .replace() to prevent errors
  const textString = String(text || '');
  // The characters to escape are: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return textString.replace(/([_*\[\]()~`>#\+\-=|{}.!])/g, '\\$1');
}

/**
 * Comprehensive message sanitizer for Telegram with length management
 * @param {string} text The text to sanitize
 * @param {number} maxLength Maximum length (default 3800 for Telegram)
 * @returns {string} Safe Telegram message
 */
export function safeTelegramMessage(text, maxLength = 3800) {
  if (!text) return '';
  
  let safeText = escapeMarkdownV2(text);
  
  // Truncate if too long
  if (safeText.length > maxLength) {
    safeText = safeText.substring(0, maxLength - 3) + '...';
  }
  
  return safeText;
}

/**
 * Format schedule context for AI prompts
 */
export function formatScheduleContext(realGames, sportKey, hours) {
  if (!realGames || realGames.length === 0) {
    return `🚨 CRITICAL: NO VERIFIED ${sportKey.toUpperCase()} GAMES in next ${hours}h`;
  }
  
  const gameList = realGames.slice(0, 15).map((game, index) => {
    const date = new Date(game.commence_time);
    const timeStr = date.toLocaleString('en-US', { 
      timeZone: 'America/New_York', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
  }).join('\n');
  
  return `📅 VERIFIED REAL SCHEDULE (Next ${hours}h, ${realGames.length} games):\n${gameList}`;
}

/**
 * Generate validation summary for AI parlays
 */
export function generateValidationSummary(parlay, sportKey) {
  if (!parlay || !parlay.parlay_legs) {
    return '❌ No parlay data available for validation';
  }

  const legs = parlay.parlay_legs;
  const validatedLegs = legs.filter(leg => leg.real_game_validated).length;
  const validationRate = (validatedLegs / legs.length) * 100;

  let validationStatus = '❌ POOR';
  if (validationRate >= 80) validationStatus = '✅ EXCELLENT';
  else if (validationRate >= 60) validationStatus = '⚠️ GOOD';
  else if (validationRate >= 40) validationStatus = '⚠️ FAIR';

  return `🔍 Validation Summary:
• Real Games: ${validatedLegs}/${legs.length} legs
• Validation Rate: ${validationRate.toFixed(1)}%
• Status: ${validationStatus}

${validationRate < 50 ? '⚠️ Consider using Live mode for better verification' : '✅ Good real game coverage'}`;
}

// --- CONSOLIDATED ANALYSIS FUNCTIONS ---

/**
 * Formerly from quant.js
 * A simple quantitative analysis function.
 * @param {object[]} oddsData - The array of game odds data.
 * @returns {{totalGamesAnalyzed: number, averageH2HOdds: number}}
 */
export function analyzeQuantitative(oddsData) {
  if (!oddsData || oddsData.length === 0) return { totalGamesAnalyzed: 0, averageH2HOdds: 0 };
  const h2hOdds = oddsData.flatMap(game =>
    game.bookmakers?.flatMap(bookmaker =>
      bookmaker.markets?.filter(market => market.key === 'h2h')
        .flatMap(market => market.outcomes.map(outcome => outcome.price)) || []
    ) || []
  );
  const averageOdds = h2hOdds.reduce((sum, price) => sum + price, 0) / (h2hOdds.length || 1);
  return {
    totalGamesAnalyzed: oddsData.length,
    averageH2HOdds: Math.round(averageOdds),
  };
}

/**
 * Formerly from psychometric.js
 * A mock user profiling function.
 * @param {string | number} chatId - The user's chat ID.
 */
export const psychometric = {
    async profileUser(chatId) {
        const hash = createHash('sha256').update(String(chatId)).digest('hex');
        const riskAppetite = (parseInt(hash.substring(0, 2), 16) / 255);
        return {
            userId: chatId,
            riskAppetite: riskAppetite.toFixed(2),
            preferredStrategy: riskAppetite > 0.6 ? 'high_risk' : 'balanced',
        };
    }
};

/**
 * Formerly from advancedOddsModel.js
 * A simple model for calculating probabilities and features.
 */
export const advancedOddsModel = {
    calculateImpliedProbabilities(game) {
        const h2h = game.bookmakers?.[0]?.markets.find(m => m.key === 'h2h')?.outcomes || [];
        const home = h2h.find(o => o.name === game.home_team);
        const away = h2h.find(o => o.name === game.away_team);
        const draw = h2h.find(o => o.name === 'Draw');

        // Refactored to use existing utility functions for consistency
        const prob = (americanPrice) => {
            if (!americanPrice) return 0;
            const decimal = toDecimalFromAmerican(americanPrice);
            return impliedProbability(decimal) * 100; // Return as percentage
        };

        return { home: prob(home?.price), away: prob(away?.price), draw: prob(draw?.price) };
    },
    engineerGameFeatures(game) {
        const probs = this.calculateImpliedProbabilities(game);
        return {
            isClearFavorite: Math.abs(probs.home - probs.away) > 30,
            isCloseGame: Math.abs(probs.home - probs.away) < 10,
        };
    }
};

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
export function toAmerican(decimalOdds) {
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
  const tz = process.env.TIMEZONE || 'America/New_York';
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Groups parlay legs by their associated game.
 * @param {object[]} legs
 * @returns {object}
 */
export function groupLegsByGame(legs) {
    const grouped = {};
    for (const leg of legs) {
        if (!grouped[leg.game]) {
            grouped[leg.game] = { commence_time: leg.commence_time, picks: [] };
        }
        grouped[leg.game].picks.push(leg);
    }
    return grouped;
}

/**
 * Generates a Merkle Tree from an array of data.
 * @param {any[]} data - The data to be included in the tree.
 * @returns {MerkleTree}
 */
export function generateMerkleTree(data) {
    const leaves = data.map(x => CryptoJS.SHA256(JSON.stringify(x)));
    return new MerkleTree(leaves, CryptoJS.SHA256);
}

/**
 * Verifies a proof against a Merkle Tree.
 * @param {MerkleTree} tree - The Merkle Tree instance.
 * @param {any} leaf - The leaf data to verify.
 * @param {Buffer[]} proof - The proof generated by the tree.
 * @returns {boolean}
 */
export function verifyMerkleProof(tree, leaf, proof) {
    return tree.verify(proof, CryptoJS.SHA256(JSON.stringify(leaf)), tree.getRoot());
}

/**
 * Check if a parlay has sufficient real game validation
 */
export function hasSufficientValidation(parlay, threshold = 0.5) {
  if (!parlay || !parlay.parlay_legs) return false;
  
  const validatedLegs = parlay.parlay_legs.filter(leg => leg.real_game_validated).length;
  const validationRate = validatedLegs / parlay.parlay_legs.length;
  
  return validationRate >= threshold;
}

/**
 * Generate validation badge for display
 */
export function getValidationBadge(validationRate) {
  if (validationRate >= 0.8) return '✅';
  if (validationRate >= 0.6) return '⚠️';
  if (validationRate >= 0.4) return '🔸';
  return '❌';
}
