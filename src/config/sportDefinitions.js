// src/config/sportDefinitions.js

// --- CHANGE START ---
// This new array defines which sports the background worker will pre-fetch.
export const HIGH_PRIORITY_SPORTS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_england_premier_league',
  'soccer_uefa_champions_league',
  'mma_ufc'
];
// --- CHANGE END ---

export const COMPREHENSIVE_SPORTS = {
  // American Football
  'americanfootball_nfl': { title: 'NFL', priority: 1, emoji: '🏈', group: 'American Football' },
  'americanfootball_ncaaf': { title: 'NCAAF', priority: 2, emoji: '🏈', group: 'American Football' },
  'americanfootball_xfl': { title: 'XFL', priority: 50, emoji: '🏈', group: 'American Football' },
  'americanfootball_usfl': { title: 'USFL', priority: 51, emoji: '🏈', group: 'American Football' },
  
  // Basketball
  'basketball_nba': { title: 'NBA', priority: 3, emoji: '🏀', group: 'Basketball' },
  'basketball_wnba': { title: 'WNBA', priority: 30, emoji: '🏀', group: 'Basketball' },
  'basketball_ncaab': { title: 'NCAAB', priority: 4, emoji: '🏀', group: 'Basketball' },
  'basketball_euroleague': { title: 'EuroLeague', priority: 60, emoji: '🏀', group: 'Basketball' },
  
  // Baseball
  'baseball_mlb': { title: 'MLB', priority: 5, emoji: '⚾', group: 'Baseball' },
  'baseball_npb': { title: 'NPB (Japan)', priority: 40, emoji: '⚾', group: 'Baseball' },
  'baseball_kbo': { title: 'KBO (Korea)', priority: 41, emoji: '⚾', group: 'Baseball' },
  
  // Hockey
  'icehockey_nhl': { title: 'NHL', priority: 6, emoji: '🏒', group: 'Hockey' },
  'icehockey_khl': { title: 'KHL', priority: 45, emoji: '🏒', group: 'Hockey' },
  'icehockey_sweden': { title: 'Swedish Hockey', priority: 46, emoji: '🏒', group: 'Hockey' },
  'icehockey_finland': { title: 'Finnish Hockey', priority: 47, emoji: '🏒', group: 'Hockey' },
  
  // Soccer
  'soccer_england_premier_league': { title: 'Premier League', priority: 7, emoji: '⚽', group: 'Soccer' },
  'soccer_spain_la_liga': { title: 'La Liga', priority: 8, emoji: '⚽', group: 'Soccer' },
  'soccer_italy_serie_a': { title: 'Serie A', priority: 9, emoji: '⚽', group: 'Soccer' },
  'soccer_germany_bundesliga': { title: 'Bundesliga', priority: 10, emoji: '⚽', group: 'Soccer' },
  'soccer_france_ligue_1': { title: 'Ligue 1', priority: 11, emoji: '⚽', group: 'Soccer' },
  'soccer_uefa_champions_league': { title: 'Champions League', priority: 12, emoji: '⚽', group: 'Soccer' },
  'soccer_uefa_europa_league': { title: 'Europa League', priority: 25, emoji: '⚽', group: 'Soccer' },
  'soccer_mls': { title: 'MLS', priority: 26, emoji: '⚽', group: 'Soccer' },
  'soccer_world_cup': { title: 'World Cup', priority: 70, emoji: '⚽', group: 'Soccer' },
  'soccer_euro': { title: 'European Championship', priority: 71, emoji: '⚽', group: 'Soccer' },
  'soccer_copa_america': { title: 'Copa America', priority: 72, emoji: '⚽', group: 'Soccer' },
  
  // Tennis
  'tennis_atp': { title: 'ATP Tennis', priority: 20, emoji: '🎾', group: 'Tennis' },
  'tennis_wta': { title: 'WTA Tennis', priority: 21, emoji: '🎾', group: 'Tennis' },
  'tennis_aus_open': { title: 'Australian Open', priority: 75, emoji: '🎾', group: 'Tennis' },
  'tennis_french_open': { title: 'French Open', priority: 76, emoji: '🎾', group: 'Tennis' },
  'tennis_wimbledon': { title: 'Wimbledon', priority: 77, emoji: '🎾', group: 'Tennis' },
  'tennis_us_open': { title: 'US Open', priority: 78, emoji: '🎾', group: 'Tennis' },
  
  // Fighting Sports
  'mma_ufc': { title: 'UFC', priority: 15, emoji: '🥊', group: 'Combat Sports' },
  'boxing': { title: 'Boxing', priority: 35, emoji: '🥊', group: 'Combat Sports' },
  
  // Motorsports
  'formula1': { title: 'Formula 1', priority: 16, emoji: '🏎️', group: 'Motorsports' },
  'motogp': { title: 'MotoGP', priority: 55, emoji: '🏍️', group: 'Motorsports' },
  'nascar': { title: 'NASCAR', priority: 56, emoji: '🏁', group: 'Motorsports' },
  'indycar': { title: 'IndyCar', priority: 57, emoji: '🏎️', group: 'Motorsports' },
  
  // Golf
  'golf_pga': { title: 'PGA Tour', priority: 17, emoji: '⛳', group: 'Golf' },
  'golf_european': { title: 'European Tour', priority: 58, emoji: '⛳', group: 'Golf' },
  'golf_liv': { title: 'LIV Golf', priority: 59, emoji: '⛳', group: 'Golf' },
  'golf_masters': { title: 'The Masters', priority: 80, emoji: '⛳', group: 'Golf' },
  'golf_us_open': { title: 'US Open', priority: 81, emoji: '⛳', group: 'Golf' },
  'golf_pga_championship': { title: 'PGA Championship', priority: 82, emoji: '⛳', group: 'Golf' },
  'golf_open_championship': { title: 'The Open', priority: 83, emoji: '⛳', group: 'Golf' },
  
  // International Sports
  'cricket_ipl': { title: 'IPL Cricket', priority: 65, emoji: '🏏', group: 'Cricket' },
  'cricket_big_bash': { title: 'Big Bash', priority: 66, emoji: '🏏', group: 'Cricket' },
  'cricket_psl': { title: 'PSL Cricket', priority: 67, emoji: '🏏', group: 'Cricket' },
  'rugby_union': { title: 'Rugby Union', priority: 42, emoji: '🏉', group: 'Rugby' },
  'rubgy_league': { title: 'Rugby League', priority: 43, emoji: '🏉', group: 'Rugby' },
  'aussie_rules_afl': { title: 'AFL', priority: 44, emoji: '🇦🇺', group: 'Aussie Rules' },
  'handball': { title: 'Handball', priority: 85, emoji: '🤾', group: 'Other Sports' },
  'volleyball': { title: 'Volleyball', priority: 86, emoji: '🏐', group: 'Other Sports' },
  'table_tennis': { title: 'Table Tennis', priority: 87, emoji: '🏓', group: 'Other Sports' },
  'badminton': { title: 'Badminton', priority: 88, emoji: '🏸', group: 'Other Sports' },
  'darts': { title: 'Darts', priority: 89, emoji: '🎯', group: 'Other Sports' },
  'snooker': { title: 'Snooker', priority: 90, emoji: '🎱', group: 'Other Sports' }
};

export const SPORT_TITLES = Object.fromEntries(
  Object.entries(COMPREHENSIVE_SPORTS).map(([key, data]) => [key, data.title])
);

export const getSportConfig = (sportKey) => {
  const configs = {
    americanfootball_nfl: { volatility: 'high', analysis_depth: 'deep', prop_availability: 'high' },
    basketball_nba: { volatility: 'medium', analysis_depth: 'deep', prop_availability: 'high' },
    baseball_mlb: { volatility: 'low', analysis_depth: 'medium', prop_availability: 'medium' },
    icehockey_nhl: { volatility: 'high', analysis_depth: 'medium', prop_availability: 'medium' },
    soccer_england_premier_league: { volatility: 'medium', analysis_depth: 'deep', prop_availability: 'low' }
  };
  return configs[sportKey] || { volatility: 'medium', analysis_depth: 'basic', prop_availability: 'low' };
};

export const SPORT_EMOJIS = Object.fromEntries(
  Object.entries(COMPREHENSIVE_SPORTS).map(([key, data]) => [key, data.emoji])
);

export const SPORT_GROUPS = {
  'American Football': ['americanfootball_nfl', 'americanfootball_ncaaf', 'americanfootball_xfl', 'americanfootball_usfl'],
  'Basketball': ['basketball_nba', 'basketball_wnba', 'basketball_ncaab', 'basketball_euroleague'],
  'Baseball': ['baseball_mlb', 'baseball_npb', 'baseball_kbo'],
  'Hockey': ['icehockey_nhl', 'icehockey_khl', 'icehockey_sweden', 'icehockey_finland'],
  'Soccer': ['soccer_england_premier_league', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_1', 'soccer_uefa_champions_league', 'soccer_uefa_europa_league', 'soccer_mls', 'soccer_world_cup', 'soccer_euro', 'soccer_copa_america'],
  'Tennis': ['tennis_atp', 'tennis_wta', 'tennis_aus_open', 'tennis_french_open', 'tennis_wimbledon', 'tennis_us_open'],
  'Combat Sports': ['mma_ufc', 'boxing'],
  'Motorsports': ['formula1', 'motogp', 'nascar', 'indycar'],
  'Golf': ['golf_pga', 'golf_european', 'golf_liv', 'golf_masters', 'golf_us_open', 'golf_pga_championship', 'golf_open_championship'],
  'Cricket': ['cricket_ipl', 'cricket_big_bash', 'cricket_psl'],
  'Rugby': ['rugby_union', 'rubgy_league'],
  'Aussie Rules': ['aussie_rules_afl'],
  'Other Sports': ['handball', 'volleyball', 'table_tennis', 'badminton', 'darts', 'snooker']
};
