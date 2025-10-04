// src/services/sportsService.js - UPDATED WITH VERIFIED SCHEDULE SOURCES
import { 
  COMPREHENSIVE_SPORTS, 
  SPORT_TITLES, 
  getSportConfig,
  SPORT_EMOJIS,
  SPORT_GROUPS
} from '../config/sportDefinitions.js';
import gamesService from './gamesService.js';

// ✅ ADDED: Centralized list of verified sources for prompt engineering
const VERIFIED_SCHEDULE_SOURCES = {
  americanfootball_nfl: ['https://www.nfl.com/schedules/', 'https://www.espn.com/nfl/schedule'],
  americanfootball_ncaaf: ['https://www.espn.com/college-football/schedule'],
  basketball_nba: ['https://www.nba.com/schedule', 'https://www.espn.com/nba/schedule'],
  basketball_wnba: ['https://www.wnba.com/schedule', 'https://www.espn.com/wnba/schedule'],
  basketball_ncaab: ['https://www.espn.com/mens-college-basketball/schedule'],
  baseball_mlb: ['https://www.mlb.com/schedule', 'https://www.espn.com/mlb/schedule'],
  icehockey_nhl: ['https://www.nhl.com/schedule', 'https://www.espn.com/nhl/schedule'],
  soccer_england_premier_league: ['https://www.premierleague.com/fixtures', 'https://www.espn.com/soccer/schedule'],
  soccer_uefa_champions_league: ['https://www.uefa.com/uefachampionsleague/fixtures-results/'],
  tennis_atp: ['https://www.atptour.com/en/schedule'],
  tennis_wta: ['https://www.wtatennis.com/schedule'],
  mma_ufc: ['https://www.ufc.com/schedule'],
  golf_pga: ['https://www.pgatour.com/schedule.html'],
  formula1: ['https://www.formula1.com/en/racing/2024.html']
};

export function getVerifiedSources(sportKey) {
    return VERIFIED_SCHEDULE_SOURCES[sportKey] || [];
}

const PREFERRED_FIRST = [
  'americanfootball_nfl', 'americanfootball_ncaaf', 
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'soccer_england_premier_league', 'soccer_uefa_champions_league'
];

export function getSportEmoji(key = '') {
  if (!key) return '🏆';
  return SPORT_EMOJIS[String(key).toLowerCase()] || '🏆';
}

export function sortSports(sports) {
  const rank = (k) => PREFERRED_FIRST.includes(k) ? -100 : COMPREHENSIVE_SPORTS[k]?.priority || 100;
  return [...(sports || [])].sort((a, b) => rank(a?.sport_key || a?.key) - rank(b?.sport_key || b?.key));
}

export function getSportTitle(key) {
  if (!key) return 'Unknown Sport';
  return SPORT_TITLES[key] || String(key).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

export function normalizeSportData(sport) {
    if (!sport) return null;
    const sportKey = sport.sport_key || sport.key;
    const sportData = COMPREHENSIVE_SPORTS[sportKey] || {};
    return {
        key: sportKey,
        title: sport.sport_title || getSportTitle(sportKey),
        emoji: sportData.emoji || getSportEmoji(sportKey),
        group: sport.group || sportData.group,
        active: sport.active !== false,
        priority: sportData.priority || 100,
        is_major: (sportData.priority || 100) <= 20,
        ...sport
    };
}

export function getAllSports() {
  return Object.entries(SPORT_TITLES).map(([key, title]) => 
    normalizeSportData({ sport_key: key, sport_title: title })
  );
}

export async function hasActiveGames(sportKey, hours = 72) {
  try {
    const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
    return realGames.length > 0;
  } catch (error) {
    console.error(`❌ Active games check failed for ${sportKey}:`, error);
    return false;
  }
}

export default {
  getSportEmoji,
  getSportTitle,
  sortSports,
  normalizeSportData,
  getAllSports,
  getVerifiedSources,
  hasActiveGames
};
