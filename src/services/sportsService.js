PopularSports,
  searchSports
};
// src/services/sportsService.js
import { 
  COMPREHENSIVE_SPORTS, 
  SPORT_TITLES, 
  getSportConfig,
  SPORT_EMOJIS,
  SPORT_GROUPS
} from '../config/sportDefinitions.js';

// Priority sorting configuration
const PREFERRED_FIRST = [
  'americanfootball_nfl', 'americanfootball_ncaaf', 
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'soccer_england_premier_league', 'soccer_uefa_champions_league'
];

const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl'];

export function getSportEmoji(key = '') {
  if (!key) return '🏆';
  const normalizedKey = String(key).toLowerCase();
  return SPORT_EMOJIS[normalizedKey] || '🏆';
}

export function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return COMPREHENSIVE_SPORTS[k]?.priority || 100;
  };
  
  return [...(sports || [])].sort((a, b) => {
    const aKey = a?.sport_key || a?.key || '';
    const bKey = b?.sport_key || b?.key || '';
    return rank(aKey) - rank(bKey);
  });
}

export function getSportTitle(key) {
  if (!key) return 'Unknown Sport';
  return SPORT_TITLES[key] || String(key).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

export function normalizeSportData(sport) {
  if (!sport) return null;
  
  const sportKey = sport.sport_key || sport.key;
  const sportTitle = sport.sport_title || sport.title || getSportTitle(sportKey);
  const sportData = COMPREHENSIVE_SPORTS[sportKey] || {};
  
  return {
    sport_key: sportKey,
    sport_title: sportTitle,
    key: sportKey,
    title: sportTitle,
    emoji: sportData.emoji || getSportEmoji(sportKey),
    group: sport.group || sportData.group || inferSportGroup(sportKey),
    active: sport.active !== false,
    has_outrights: sport.has_outrights || false,
    priority: sportData.priority || 100,
    source: sport.source || 'sports_service',
    // Additional metadata
    is_major: (sportData.priority || 100) <= 20,
    is_international: !['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(sportKey),
    config: getSportConfig(sportKey)
  };
}

export function getAllSports() {
  return Object.entries(SPORT_TITLES).map(([sport_key, sport_title]) => 
    normalizeSportData({ sport_key, sport_title })
  );
}

export function filterSports(sports, options = {}) {
  const {
    activeOnly = true,
    groups = [],
    searchTerm = '',
    includeInternational = true,
    minPriority = 0,
    maxPriority = 100
  } = options;
  
  let filtered = sports || [];
  
  if (activeOnly) {
    filtered = filtered.filter(sport => sport.active !== false);
  }
  
  if (groups.length > 0) {
    filtered = filtered.filter(sport => 
      groups.includes(sport.group)
    );
  }
  
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter(sport => 
      sport.sport_title.toLowerCase().includes(term) ||
      sport.sport_key.toLowerCase().includes(term) ||
      sport.group.toLowerCase().includes(term)
    );
  }
  
  if (!includeInternational) {
    filtered = filtered.filter(sport => !sport.is_international);
  }
  
  filtered = filtered.filter(sport => 
    (sport.priority >= minPriority) && (sport.priority <= maxPriority)
  );
  
  return sortSports(filtered);
}

function inferSportGroup(sportKey) {
  for (const [group, sports] of Object.entries(SPORT_GROUPS)) {
    if (sports.includes(sportKey)) {
      return group;
    }
  }
  
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

export function hasPlayerProps(sportKey) {
  const propsSports = [
    'basketball_nba', 'basketball_wnba', 'basketball_ncaab',
    'americanfootball_nfl', 'americanfootball_ncaaf',
    'baseball_mlb', 'icehockey_nhl'
  ];
  return propsSports.includes(sportKey);
}

export function getSportsByGroup() {
  const groups = {};
  
  Object.entries(SPORT_GROUPS).forEach(([groupName, sportKeys]) => {
    groups[groupName] = sportKeys.map(sportKey => 
      normalizeSportData({ sport_key: sportKey })
    ).filter(sport => sport !== null);
  });
  
  return groups;
}

export function getPopularSports(limit = 10) {
  const allSports = getAllSports();
  return allSports
    .filter(sport => sport.is_major)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, limit);
}

export function searchSports(query, options = {}) {
  const {
    searchInTitles = true,
    searchInKeys = true,
    searchInGroups = true,
    limit = 20
  } = options;
  
  const allSports = getAllSports();
  const term = query.toLowerCase().trim();
  
  if (!term) return allSports.slice(0, limit);
  
  return allSports.filter(sport => {
    if (searchInTitles && sport.sport_title.toLowerCase().includes(term)) return true;
    if (searchInKeys && sport.sport_key.toLowerCase().includes(term)) return true;
    if (searchInGroups && sport.group.toLowerCase().includes(term)) return true;
    return false;
  }).slice(0, limit);
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
  getSportConfig,
  getSportsByGroup,
  getPopularSports,
  searchSports
};
