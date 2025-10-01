// src/services/sportsService.js - UPDATED TO ALIGN WITH DATABASE SCHEMA

// This is the single source of truth for all sports information.
export const SPORT_TITLES = {
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  americanfootball_xfl: 'XFL',
  americanfootball_usfl: 'USFL',
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA',
  basketball_ncaab: 'NCAAB',
  basketball_euroleague: 'EuroLeague',
  baseball_mlb: 'MLB',
  baseball_npb: 'NPB (Japan)',
  baseball_kbo: 'KBO (Korea)',
  icehockey_nhl: 'NHL',
  icehockey_khl: 'KHL',
  icehockey_sweden: 'Swedish Hockey',
  icehockey_finland: 'Finnish Hockey',
  soccer_england_premier_league: 'Premier League',
  soccer_spain_la_liga: 'La Liga',
  soccer_italy_serie_a: 'Serie A',
  soccer_germany_bundesliga: 'Bundesliga',
  soccer_france_ligue_1: 'Ligue 1',
  soccer_uefa_champions_league: 'Champions League',
  soccer_uefa_europa_league: 'Europa League',
  soccer_mls: 'MLS',
  soccer_world_cup: 'World Cup',
  soccer_euro: 'European Championship',
  soccer_copa_america: 'Copa America',
  tennis_atp: 'ATP Tennis',
  tennis_wta: 'WTA Tennis',
  tennis_aus_open: 'Australian Open',
  tennis_french_open: 'French Open',
  tennis_wimbledon: 'Wimbledon',
  tennis_us_open: 'US Open',
  mma_ufc: 'UFC',
  boxing: 'Boxing',
  formula1: 'Formula 1',
  motogp: 'MotoGP',
  nascar: 'NASCAR',
  indycar: 'IndyCar',
  golf_pga: 'PGA Tour',
  golf_european: 'European Tour',
  golf_liv: 'LIV Golf',
  golf_masters: 'The Masters',
  golf_us_open: 'US Open',
  golf_pga_championship: 'PGA Championship',
  golf_open_championship: 'The Open',
  cricket_ipl: 'IPL Cricket',
  cricket_big_bash: 'Big Bash',
  cricket_psl: 'PSL Cricket',
  rugby_union: 'Rugby Union',
  rugby_league: 'Rugby League',
  aussie_rules_afl: 'AFL',
  handball: 'Handball',
  volleyball: 'Volleyball',
  table_tennis: 'Table Tennis',
  badminton: 'Badminton',
  darts: 'Darts',
  snooker: 'Snooker'
};

// Priority sorting configuration - aligns with ai.js
const PREFERRED_FIRST = [
  'americanfootball_nfl', 'americanfootball_ncaaf', 
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'soccer_england_premier_league', 'soccer_uefa_champions_league'
];

const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl'];

/**
 * Get sport emoji based on sport key
 */
export function getSportEmoji(key = '') {
  const k = String(key).toLowerCase();
  if (k.includes('americanfootball')) return '🏈';
  if (k.includes('basketball')) return '🏀';
  if (k.includes('baseball')) return '⚾';
  if (k.includes('icehockey') || k.includes('hockey')) return '🏒';
  if (k.includes('soccer')) return '⚽';
  if (k.includes('tennis')) return '🎾';
  if (k.includes('mma') || k.includes('ufc') || k.includes('boxing')) return '🥊';
  if (k.includes('formula1') || k.includes('nascar') || k.includes('indycar')) return '🏎️';
  if (k.includes('golf')) return '⛳';
  if (k.includes('cricket')) return '🏏';
  if (k.includes('rugby')) return '🏉';
  if (k.includes('aussie_rules')) return '🇦🇺';
  if (k.includes('handball')) return '🤾';
  if (k.includes('volleyball')) return '🏐';
  if (k.includes('table_tennis')) return '🏓';
  if (k.includes('badminton')) return '🏸';
  if (k.includes('darts')) return '🎯';
  if (k.includes('snooker')) return '🎱';
  return '🏆'; // Default
}

/**
 * Sort sports array with priority ordering
 * Aligns with ai.js sorting logic
 */
export function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return 0;
  };
  
  return [...(sports || [])].sort((a, b) => {
    const aKey = a?.sport_key || a?.key || '';
    const bKey = b?.sport_key || b?.key || '';
    return rank(aKey) - rank(bKey);
  });
}

/**
 * Get sport title - uses sport_title from database schema
 */
export function getSportTitle(key) {
  if (!key) return 'Unknown Sport';
  return SPORT_TITLES[key] || String(key).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Normalize sport data to ensure consistent structure
 * Converts between different sport object formats used across services
 */
export function normalizeSportData(sport) {
  if (!sport) return null;
  
  const sportKey = sport.sport_key || sport.key;
  const sportTitle = sport.sport_title || sport.title || getSportTitle(sportKey);
  
  return {
    sport_key: sportKey,
    sport_title: sportTitle,
    key: sportKey, // Backward compatibility
    title: sportTitle, // Backward compatibility
    emoji: getSportEmoji(sportKey),
    group: sport.group || inferSportGroup(sportKey),
    active: sport.active !== false,
    has_outrights: sport.has_outrights || false,
    source: sport.source || 'sports_service'
  };
}

/**
 * Get all available sports in normalized format
 */
export function getAllSports() {
  return Object.entries(SPORT_TITLES).map(([sport_key, sport_title]) => 
    normalizeSportData({ sport_key, sport_title })
  );
}

/**
 * Filter sports by activity status and group
 */
export function filterSports(sports, options = {}) {
  const {
    activeOnly = true,
    groups = [],
    searchTerm = ''
  } = options;
  
  let filtered = sports || [];
  
  if (activeOnly) {
    filtered = filtered.filter(sport => sport.active !== false);
  }
  
  if (groups.length > 0) {
    filtered = filtered.filter(sport => 
      groups.includes(inferSportGroup(sport.sport_key))
    );
  }
  
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter(sport => 
      sport.sport_title.toLowerCase().includes(term) ||
      sport.sport_key.toLowerCase().includes(term)
    );
  }
  
  return sortSports(filtered);
}

/**
 * Infer sport group from sport key
 */
function inferSportGroup(sportKey) {
  const key = String(sportKey).toLowerCase();
  
  if (key.includes('americanfootball')) return 'American Football';
  if (key.includes('basketball')) return 'Basketball';
  if (key.includes('baseball')) return 'Baseball';
  if (key.includes('icehockey') || key.includes('hockey')) return 'Hockey';
  if (key.includes('soccer')) return 'Soccer';
  if (key.includes('tennis')) return 'Tennis';
  if (key.includes('mma') || key.includes('ufc') || key.includes('boxing')) return 'Combat Sports';
  if (key.includes('formula1') || key.includes('nascar') || key.includes('indycar') || key.includes('motogp')) return 'Motorsports';
  if (key.includes('golf')) return 'Golf';
  if (key.includes('cricket')) return 'Cricket';
  if (key.includes('rugby')) return 'Rugby';
  if (key.includes('aussie_rules')) return 'Aussie Rules';
  return 'Other Sports';
}

/**
 * Check if sport has player props available
 */
export function hasPlayerProps(sportKey) {
  const propsSports = [
    'basketball_nba', 'basketball_wnba', 'basketball_ncaab',
    'americanfootball_nfl', 'americanfootball_ncaaf',
    'baseball_mlb', 'icehockey_nhl'
  ];
  return propsSports.includes(sportKey);
}

/**
 * Get sport configuration for AI analysis
 */
export function getSportConfig(sportKey) {
  const configs = {
    americanfootball_nfl: { volatility: 'high', analysis_depth: 'deep', prop_availability: 'high' },
    basketball_nba: { volatility: 'medium', analysis_depth: 'deep', prop_availability: 'high' },
    baseball_mlb: { volatility: 'low', analysis_depth: 'medium', prop_availability: 'medium' },
    icehockey_nhl: { volatility: 'high', analysis_depth: 'medium', prop_availability: 'medium' },
    soccer_england_premier_league: { volatility: 'medium', analysis_depth: 'deep', prop_availability: 'low' }
  };
  
  return configs[sportKey] || { volatility: 'medium', analysis_depth: 'basic', prop_availability: 'low' };
}

export default {
  SPORT_TITLES,
  getSportEmoji,
  getSportTitle,
  sortSports,
  normalizeSportData,
  getAllSports,
  filterSports,
  hasPlayerProps,
  getSportConfig
};
