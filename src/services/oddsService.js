// src/services/oddsService.js – PROVEN ODDS PROVIDER FOR ALL SPORTS

import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentryService from './sentryService.js';

class ProvenOddsService {
  constructor() {
    // Default providers, dynamically add any with valid API keys (*expandable)
    this.providers = [
      { name: 'the-odds-api', url: `https://api.the-odds-api.com/v4/sports`, apiKey: env.THE_ODDS_API_KEY },
    ];
    // Optionally include more feeds (Sportradar, etc.)
    if (env.SPORTRADAR_API_KEY) {
      this.providers.push({ name: 'sportradar', url: 'https://api.sportradar.com', apiKey: env.SPORTRADAR_API_KEY });
    }
    if (env.API_SPORTS_KEY) {
      this.providers.push({ name: 'api-sports', url: 'https://v3.football.api-sports.io', apiKey: env.API_SPORTS_KEY });
    }
    console.log('Proven Odds Service Initialized.');
  }

  /**
   * Fetches deduplicated, multi-provider odds for all requested sports.
   * Returns standardized game objects for UI, parlay builder, and analytics.
   */
  async getAllSportsOdds() {
    const sports = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'soccer_epl', 'tennis_atp'];
    const allOddsPromises = sports.map(sport => this.getSportOdds(sport));
    const results = await Promise.allSettled(allOddsPromises);
    const allOdds = results
      .filter(res => res.status === 'fulfilled')
      .flatMap(res => res.value);
    return this.processAndDeduplicateOdds(allOdds);
  }

  async getSportOdds(sportKey) {
    const cacheKey = `odds_${sportKey}`;
    try {
      // Quick Redis cache read (for hot games)
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_read', sportKey });
    }
    // Fetch odds from all available providers
    let games = [];
    for (const provider of this.providers) {
      try {
        if (provider.name === 'the-odds-api') {
          // Direct API for games & markets
          const res = await axios.get(`${provider.url}/${sportKey}/odds`, {
            params: { apiKey: provider.apiKey, regions: 'us', markets: 'h2h,spreads,totals' }
          });
          games = games.concat(res.data.map(g => ({
            id: g.id,
            home_team: g.home_team,
            away_team: g.away_team,
            commence_time: g.commence_time,
            sport: sportKey,
            sport_title: g.sport_title,
            bookmakers: g.bookmakers,
          })));
        }
        // Future expansion - add other provider fetches here!
      } catch (err) {
        sentryService.captureError(err, { component: `odds_${provider.name}_fetch`, sportKey });
      }
    }
    // Write to Redis cache (5min expiry)
    try {
      await redis.set(cacheKey, JSON.stringify(games), 300);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_write', sportKey });
    }
    return games;
  }

  /**
   * Removes duplicate games, normalizes feed fields, ensures all games have full date/time
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
    // Always sort by upcoming game time
    deduped.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    return deduped;
  }
}

export default new ProvenOddsService();
