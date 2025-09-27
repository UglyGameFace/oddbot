// src/utils/enterpriseUtilities.js

import { createHash } from 'crypto';
import CryptoJS from 'crypto-js';
import MerkleTree from 'merkletreejs';

/**
 * NEW: Centralized function to get a consistent emoji for any sport key.
 * This includes professional and college leagues as requested.
 */
export function getSportEmoji(key = '') {
  const k = key.toLowerCase();
  if (k.includes('americanfootball_nfl')) return '🏈';
  if (k.includes('americanfootball_ncaaf')) return '🎓'; // College Football
  if (k.includes('basketball_nba')) return '🏀';
  if (k.includes('basketball_wnba')) return '🙋🏽‍♀️🏀'; // WNBA
  if (k.includes('basketball_ncaab')) return '🎓'; // College Basketball
  if (k.includes('baseball_mlb')) return '⚾';
  if (k.includes('icehockey_nhl')) return '🏒';
  if (k.includes('soccer')) return '⚽';
  return '🏆'; // Default
}

export function toDecimalFromAmerican(americanOdds) {
  if (americanOdds > 0) {
    return (americanOdds / 100) + 1;
  }
  return (100 / Math.abs(americanOdds)) + 1;
}

export function toAmerican(decimalOdds) {
    if (decimalOdds >= 2) {
        return (decimalOdds - 1) * 100;
    }
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
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function groupLegsByGame(legs) {
    const grouped = {};
    for (const leg of legs) {
        if (!grouped[leg.game]) {
            grouped[leg.game] = {
                commence_time: leg.commence_time,
                picks: [],
            };
        }
        grouped[leg.game].picks.push(leg);
    }
    return grouped;
}

export function generateMerkleTree(data) {
    const leaves = data.map(x => CryptoJS.SHA256(JSON.stringify(x)));
    const tree = new MerkleTree(leaves, CryptoJS.SHA256);
    return tree;
}

export function verifyMerkleProof(tree, leaf, proof) {
    return tree.verify(proof, CryptoJS.SHA256(JSON.stringify(leaf)), tree.getRoot());
}
