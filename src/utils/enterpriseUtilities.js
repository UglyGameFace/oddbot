// src/utils/enterpriseUtilities.js

import { createHash } from 'crypto';
import CryptoJS from 'crypto-js';
import MerkleTree from 'merkletreejs';

// --- NEW FUNCTION TO PREVENT TELEGRAM FORMATTING ERRORS ---
/**
 * Escapes characters that have special meaning in Telegram's MarkdownV2.
 * @param {string} text The text to escape.
 * @returns {string} The escaped text.
 */
export function escapeMarkdownV2(text) {
  // Ensure input is a string before calling .replace() to prevent errors
  const textString = String(text || '');
  // The characters to escape are: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return textString.replace(/([_*\[\]()~`>#\+\-=|{}.!])/g, '\\$1');
}


// --- CONSOLIDATED ANALYSIS FUNCTIONS ---

/**
 * Formerly from quant.js
 * A simple quantitative analysis function.
 */
export function analyzeQuantitative(oddsData) {
  if (!oddsData || oddsData.length === 0) return { totalGames: 0, averageOdds: 0 };
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
        const prob = (price) => price ? (1 / toDecimalFromAmerican(price)) * 100 : 0;
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


// --- EXISTING UTILITY FUNCTIONS ---

export function getSportEmoji(key = '') {
  const k = key.toLowerCase();
  if (k.includes('americanfootball_nfl')) return 'ðŸˆ';
  if (k.includes('americanfootball_ncaaf')) return 'ðŸŽ“ðŸˆ';
  if (k.includes('basketball_nba')) return 'ðŸ€';
  if (k.includes('basketball_wnba')) return 'ðŸ™‹ðŸ½â€â™€ï¸ðŸ€';
  if (k.includes('basketball_ncaab')) return 'ðŸŽ“';
  if (k.includes('baseball_mlb')) return 'âš¾';
  if (k.includes('icehockey_nhl')) return 'ðŸ’';
  if (k.includes('soccer')) return 'âš½';
  return 'ðŸ†';
}

export function toDecimalFromAmerican(americanOdds) {
  if (americanOdds > 0) return (americanOdds / 100) + 1;
  return (100 / Math.abs(americanOdds)) + 1;
}

export function toAmerican(decimalOdds) {
    if (decimalOdds >= 2) return (decimalOdds - 1) * 100;
    return -100 / (decimalOdds - 1);
}

export function impliedProbability(decimalOdds) {
  return 1 / decimalOdds;
}

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

export function generateMerkleTree(data) {
    const leaves = data.map(x => CryptoJS.SHA256(JSON.stringify(x)));
    return new MerkleTree(leaves, CryptoJS.SHA256);
}

export function verifyMerkleProof(tree, leaf, proof) {
    return tree.verify(proof, CryptoJS.SHA256(JSON.stringify(leaf)), tree.getRoot());
}
