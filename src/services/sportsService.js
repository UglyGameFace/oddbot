// src/services/sportsService.js - COMPLETE FIXED VERSION
import { COMPREHENSIVE_SPORTS } from '../config/sportDefinitions.js';
import gamesService from './gamesService.js';

// Fallback sport definitions if sportDefinitions.js is missing
const FALLBACK_SPORTS = {
  americanfootball_nfl: { title: 'NFL Football', emoji: '🏈', priority: 5, group: 'american' },
  basketball_nba: { title: 'NBA Basketball', emoji: '🏀', priority: 10, group: 'american' },
  baseball_mlb: { title: 'MLB Baseball', emoji: '⚾', priority: 15, group: 'american' },
  icehockey_nhl: { title: 'NHL Hockey', emoji: '🏒', priority: 20, group: 'american' },
  soccer_england_premier_league: { title: 'Premier League', emoji: '⚽', priority: 25, group: 'soccer' }
};

const FALLBACK_SPORT_TITLES = Object.fromEntries(
  Object.entries(FALLBACK_SPORTS).map(([key, data]) => [key, data.title])
);

const FALLBACK_SPORT_EMOJIS = Object.fromEntries(
  Object.entries(FALLBACK_SPORTS).map(([key, data]) => [key, data.emoji])
);

const FALLBACK_SPORT_GROUPS = Object.fromEntries(
  Object.entries(FALLBACK_SPORTS).map(([key, data]) => [key, data.group])
);

// Use provided COMPREHENSIVE_SPORTS or fallback
const ACTIVE_SPORTS = COMPREHENSIVE_SPORTS || FALLBACK_SPORTS;
const SPORT_TITLES = Object.fromEntries(
  Object.entries(ACTIVE_SPORTS).map(([key, data]) => [key, data.title || FALLBACK_SPORT_TITLES[key] || key])
);
const SPORT_EMOJIS = Object.fromEntries(
  Object.entries(ACTIVE_SPORTS).map(([key, data]) => [key, data.emoji || FALLBACK_SPORT_EMOJIS[key] || '🏆'])
);
const SPORT_GROUPS = Object.fromEntries(
  Object.entries(ACTIVE_SPORTS).map(([key, data]) => [key, data.group || FALLBACK_SPORT_GROUPS[key] || 'other'])
);

// Verified sources for schedule validation
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

const PREFERRED_FIRST = [
  'americanfootball_nfl', 'americanfootball_ncaaf', 
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'soccer_england_premier_league', 'soccer_uefa_champions_league'
];

// Core sports service functions
export function getVerifiedSources(sportKey) {
  return VERIFIED_SCHEDULE_SOURCES[sportKey] || ['https://www.espn.com'];
}

export function getSportEmoji(key = '') {
  if (!key) return '🏆';
  const normalizedKey = String(key).toLowerCase();
  return SPORT_EMOJIS[normalizedKey] || '🏆';
}

export function getSportTitle(key) {
  if (!key) return 'Unknown Sport';
  const normalizedKey = String(key).toLowerCase();
  return SPORT_TITLES[normalizedKey] || normalizedKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

export function getSportGroup(key) {
  if (!key) return 'other';
  const normalizedKey = String(key).toLowerCase();
  return SPORT_GROUPS[normalizedKey] || 'other';
}

export function getSportPriority(key) {
  if (!key) return 100;
  const normalizedKey = String(key).toLowerCase();
  const sportConfig = ACTIVE_SPORTS[normalizedKey];
  return sportConfig?.priority || 100;
}

export function sortSports(sports) {
  if (!Array.isArray(sports)) return [];
  
  const rank = (sport) => {
    const key = sport?.sport_key || sport?.key;
    if (PREFERRED_FIRST.includes(key)) return -100;
    return getSportPriority(key);
  };
  
  return [...sports].sort((a, b) => rank(a) - rank(b));
}

export function normalizeSportData(sport) {
  if (!sport) return null;
  
  const sportKey = sport.sport_key || sport.key;
  const sportData = ACTIVE_SPORTS[sportKey] || {};
  
  return {
    key: sportKey,
    sport_key: sportKey,
    sport_title: sport.sport_title || getSportTitle(sportKey),
    emoji: sport.emoji || sportData.emoji || getSportEmoji(sportKey),
    group: sport.group || sportData.group || getSportGroup(sportKey),
    active: sport.active !== false,
    priority: sport.priority || sportData.priority || getSportPriority(sportKey),
    is_major: (sportData.priority || getSportPriority(sportKey)) <= 20,
    is_international: !['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(sportKey),
    source: sport.source || 'unknown',
    game_count: sport.game_count || 0,
    upcoming_games: sport.upcoming_games || 0,
    ...sport
  };
}

export function getAllSports() {
  return Object.entries(SPORT_TITLES).map(([key, title]) => 
    normalizeSportData({ sport_key: key, sport_title: title })
  );
}

export function getMajorSports() {
  return getAllSports().filter(sport => sport.is_major);
}

export function getSportsByGroup(group) {
  return getAllSports().filter(sport => sport.group === group);
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

export async function getActiveSports(hours = 72) {
  try {
    const allSports = await gamesService.getAvailableSports();
    const activeSports = [];
    
    // Check major sports first for performance
    const majorSports = allSports.filter(sport => sport.is_major);
    
    for (const sport of majorSports) {
      try {
        const hasGames = await hasActiveGames(sport.sport_key, hours);
        if (hasGames) {
          activeSports.push({
            ...sport,
            active_games: true,
            last_checked: new Date().toISOString()
          });
        }
      } catch (error) {
        console.warn(`Failed to check active games for ${sport.sport_key}:`, error.message);
      }
    }
    
    return activeSports;
  } catch (error) {
    console.error('❌ Active sports fetch failed:', error);
    return getMajorSports(); // Fallback to major sports
  }
}

export function isValidSport(sportKey) {
  if (!sportKey) return false;
  return Object.keys(ACTIVE_SPORTS).includes(String(sportKey).toLowerCase());
}

export function getSportConfig(sportKey) {
  if (!sportKey) return null;
  const normalizedKey = String(sportKey).toLowerCase();
  return ACTIVE_SPORTS[normalizedKey] || null;
}

// Default export for backward compatibility
export default {
  getSportEmoji,
  getSportTitle,
  getSportGroup,
  getSportPriority,
  sortSports,
  normalizeSportData,
  getAllSports,
  getMajorSports,
  getSportsByGroup,
  getVerifiedSources,
  hasActiveGames,
  getActiveSports,
  isValidSport,
  getSportConfig
};
