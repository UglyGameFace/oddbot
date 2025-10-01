// src/services/sportsService.js

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

const PREFERRED_FIRST = [
  'americanfootball_nfl', 'americanfootball_ncaaf', 
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'soccer_england_premier_league', 'soccer_uefa_champions_league'
];

export function getSportEmoji(key = '') {
  const k = key.toLowerCase();
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
  return '🏆'; // Default
}

export function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    return 0;
  };
  return [...(sports || [])].sort(
    (a, b) => rank(a?.sport_key || '') - rank(b?.sport_key || '')
  );
}

export function getSportTitle(key) {
    return SPORT_TITLES[key] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}
