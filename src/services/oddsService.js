import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentryService from './sentryService.js';

class ProvenOddsService {
  constructor() {
    this.providers = [];
    if (env.THE_ODDS_API_KEY) {
      this.providers.push({
        name: 'the-odds-api',
        url: 'https://api.the-odds-api.com/v4/sports',
        apiKey: env.THE_ODDS_API_KEY
      });
    }
    if (env.SPORTRADAR_API_KEY) {
      this.providers.push({
        name: 'sportradar',
        url: 'https://api.sportradar.com',
        apiKey: env.SPORTRADAR_API_KEY
      });
    }
    // Add or enable more providers as needed here.
    console.log('✅ Proven Odds Service Initialized:', this.providers.map(p => p.name).join(', '));
  }

  /**
   * Returns the best provider's odds for the sportKey, or falls back to alternatives as needed.
   * Supported sport keys (by The Odds API): nfl, nba, wnba, mlb, nhl, ncaaf, ncaab, epl, atp, etc.
   */
  async getSportOdds(sportKey) {
    const cacheKey = `odds_${sportKey}`;
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_read', sportKey });
    }

    // Map input keys to provider-specific slugs; add more as needed
    const oddsApiSportMap = {
      nfl: 'americanfootball_nfl',
      nba: 'basketball_nba',
      wnba: 'basketball_wnba',
      mlb: 'baseball_mlb',
      nhl: 'icehockey_nhl',
      ncaab: 'basketball_ncaab',
      ncaaf: 'americanfootball_ncaaf',
      epl: 'soccer_epl',
      atp: 'tennis_atp',
      // add more mappings as supported by your APIs
    };

    // Try each provider in order, stop as soon as one returns games
    for (const provider of this.providers) {
      try {
        let games = [];
        if (provider.name === 'the-odds-api') {
          const mapped = oddsApiSportMap[sportKey] || sportKey;
          const res = await axios.get(
            `${provider.url}/${mapped}/odds`,
            {
              params: {
                apiKey: provider.apiKey,
                regions: 'us',
                markets: 'h2h,spreads,totals',
                oddsFormat: 'american'
              }
            }
          );
          if (Array.isArray(res.data) && res.data.length) {
            games = res.data.map(g => ({
              id: g.id,
              home_team: g.home_team,
              away_team: g.away_team,
              commence_time: g.commence_time,
              sport: mapped,
              sport_title: g.sport_title,
              bookmakers: g.bookmakers
            }));
            // Cache and return on successful fetch
            await redis.set(cacheKey, JSON.stringify(games), 300);
            return games;
          }
        } else if (provider.name === 'sportradar') {
          // Example endpoint: adjust this to your specific feed (prematch/live, sport path etc)
          const endpoint = `${provider.url}/odds/${sportKey}/live.json?api_key=${provider.apiKey}`;
          const res = await axios.get(endpoint);
          if (res.data && Array.isArray(res.data.games) && res.data.games.length) {
            games = res.data.games.map(g => ({
              id: g.id,
              home_team: g.home_name,
              away_team: g.away_name,
              commence_time: g.scheduled,
              sport: sportKey,
              sport_title: g.sport || sportKey,
              bookmakers: g.odds
            }));
            await redis.set(cacheKey, JSON.stringify(games), 300);
            return games;
          }
        }
        // Add additional providers here as needed (same fallback logic)
      } catch (err) {
        sentryService.captureError(err, { component: `odds_${provider.name}_fetch`, sportKey });
        console.warn(`Odds fetch failed for provider ${provider.name} sportKey ${sportKey}: ${err?.message || err}`);
        // fallback to next provider in list
      }
    }
    // If all fail: return empty array and cache for very short time
    await redis.set(cacheKey, '[]', 60);
    return [];
  }

  /**
   * Returns a flat, deduplicated odds list for all popular US sports/leagues.
   * Add/remove from this list as new APIs or sports/leagues are needed.
   */
  async getAllSportsOdds() {
    const allSupported = [
      'nfl', 'nba', 'wnba', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'epl', 'atp'
      // Add more keys as supported by your APIs
    ];
    const promises = allSupported.map(sport => this.getSportOdds(sport));
    const results = await Promise.allSettled(promises);
    const allOdds = results
      .filter(res => res.status === 'fulfilled')
      .flatMap(res => res.value || []);
    return this.processAndDeduplicateOdds(allOdds);
  }

  /**
   * Deduplicate and sort games as before.
   */
  processAndDeduplicateOdds(games) {
    const deduped = [];
    const seen = new Set();
    for (const g of games) {
      const key = `${g.home_team}_${g.away_team}_${g.commence_time}_${g.sport}`;
      if (!seen.has(key)) {
        deduped.push({
          id: g.id,
          home_team: g.home_team,
          away_team: g.away_team,
          commence_time: g.commence_time,
          sport: g.sport,
          sport_title: g.sport_title,
          bookmakers: g.bookmakers
        });
        seen.add(key);
      }
    }
    deduped.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    return deduped;
  }
}

export default new ProvenOddsService();
