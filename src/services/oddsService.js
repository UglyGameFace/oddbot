// src/services/oddsService.js – Multi-provider odds with real key normalization

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
    // Add more providers as needed here
    console.log('✅ Proven Odds Service Initialized with providers: ' + this.providers.map(p => p.name).join(', '));
  }

  /**
   * Returns normalized odds for a given sport, querying all available providers and deduplicating downstream.
   */
  async getSportOdds(sportKey) {
    const cacheKey = `odds_${sportKey}`;
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_read', sportKey });
    }

    // Only The Odds API needs normalization of short keys to API-specific slugs
    const oddsApiSportMap = {
      nfl: 'americanfootball_nfl',
      nba: 'basketball_nba',
      mlb: 'baseball_mlb',
      nhl: 'icehockey_nhl',
      epl: 'soccer_epl',
      atp: 'tennis_atp'
    };

    let games = [];
    for (const provider of this.providers) {
      try {
        // --- The Odds API ---
        if (provider.name === 'the-odds-api' && provider.apiKey) {
          const normalizedKey = oddsApiSportMap[sportKey] || sportKey;
          const res = await axios.get(
            `${provider.url}/${normalizedKey}/odds`,
            {
              params: {
                apiKey: provider.apiKey,
                regions: 'us',
                markets: 'h2h,spreads,totals',
                oddsFormat: 'american'
              }
            }
          );
          if (Array.isArray(res.data)) {
            games = games.concat(res.data.map(g => ({
              id: g.id,
              home_team: g.home_team,
              away_team: g.away_team,
              commence_time: g.commence_time,
              sport: normalizedKey,
              sport_title: g.sport_title,
              bookmakers: g.bookmakers
            })));
          }
        }

        // --- Sportradar Example (adapt endpoint and parsing to your feed/plan) ---
        else if (provider.name === 'sportradar' && provider.apiKey) {
          // Typical endpoint, modify for your endpoint and structure!
          const endpoint = `${provider.url}/odds/${sportKey}/live.json?api_key=${provider.apiKey}`;
          const res = await axios.get(endpoint);
          if (Array.isArray(res.data.games)) {
            games = games.concat(res.data.games.map(g => ({
              id: g.id,
              home_team: g.home_name,
              away_team: g.away_name,
              commence_time: g.scheduled,
              sport: sportKey,
              sport_title: g.sport,
              bookmakers: g.odds
            })));
          }
        }

        // --- More providers can be added here in the same pattern ---
      } catch (err) {
        sentryService.captureError(err, { component: `odds_${provider.name}_fetch`, sportKey });
        console.warn(`Odds fetch failed for provider ${provider.name} sportKey ${sportKey}: ${err?.message || err}`);
      }
    }

    // Write to cache (5min expiry)
    try {
      await redis.set(cacheKey, JSON.stringify(games), 300);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_write', sportKey });
    }
    return games;
  }

  /**
   * Processes and deduplicates games from all providers (your unchanged method)
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

  /**
   * Fetches deduplicated multi-provider odds for all major sports
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
}

export default new ProvenOddsService();
