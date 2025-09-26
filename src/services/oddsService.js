// src/services/oddsService.js - PROVEN ODDS SERVICE WITH DYNAMIC SPORT SUPPORT + ESM named exports

import axios from 'axios';
import env from '../config/env.js';
import redis from './redisService.js';
import sentryService from './sentryService.js';

// Secondary index TTL for game-by-id lookups used by handlers (seconds)
const GAMEIDX_TTL = 120;

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
    console.log('✅ Proven Odds Service Initialized:', this.providers.map(p => p.name).join(', '));
  }

  /**
   * Fetches a list of all available sports from provider and caches for 24 hours.
   * Returns [{ key, title }]
   */
  async getSupportedSports() {
    const cacheKey = 'supported_sports_list';
    const CACHE_TTL = 86400; // 24h

    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_sports_cache_read' });
    }

    const provider = this.providers.find(p => p.name === 'the-odds-api');
    if (!provider) {
        console.error('The Odds API provider not configured for dynamic sport fetching.');
        return [];
    }

    try {
      const response = await axios.get(provider.url, { params: { apiKey: provider.apiKey } });

      if (response.data && Array.isArray(response.data)) {
        const sports = response.data
          .filter(sport => sport.active === true) // in-season sports
          .map(sport => ({ key: sport.key, title: sport.title }));

        await redis.set(cacheKey, JSON.stringify(sports), 'EX', CACHE_TTL);
        return sports;
      }
      return [];
    } catch (error) {
      sentryService.captureError(error, { component: 'odds_fetch_supported_sports' });
      console.error('Failed to fetch supported sports from API:', error.message);
      return [];
    }
  }

  /**
   * Returns the best provider's odds for the sportKey, with caching/fallbacks.
   * Normalized fields: id, home_team, away_team, commence_time, sport_key, sport_title, bookmakers
   */
  async getSportOdds(sportKey) {
    const cacheKey = `odds_${sportKey}`;
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) return JSON.parse(cachedData);
    } catch (e) {
      sentryService.captureError(e, { component: 'odds_cache_read', sportKey });
    }

    for (const provider of this.providers) {
      try {
        let games = [];
        if (provider.name === 'the-odds-api') {
          const res = await axios.get(`${provider.url}/${sportKey}/odds`, {
            params: {
              apiKey: provider.apiKey,
              regions: 'us',
              markets: 'h2h,spreads,totals',
              oddsFormat: 'american'
            }
          });
          if (Array.isArray(res.data) && res.data.length) {
            games = res.data.map(g => ({
              id: g.id,
              home_team: g.home_team,
              away_team: g.away_team,
              commence_time: g.commence_time,
              sport_key: g.sport_key,
              sport_title: g.sport_title,
              bookmakers: g.bookmakers
            }));
            await redis.set(cacheKey, JSON.stringify(games), 'EX', 300); // 5 minutes
            return games;
          }
        } else if (provider.name === 'sportradar') {
          // Example stub; adapt to your Sportradar package/feeds if used
          const endpoint = `${provider.url}/odds/${sportKey}/live.json?api_key=${provider.apiKey}`;
          const res = await axios.get(endpoint);
          if (res.data && Array.isArray(res.data.games) && res.data.games.length) {
            games = res.data.games.map(g => ({
              id: g.id,
              home_team: g.home_name,
              away_team: g.away_name,
              commence_time: g.scheduled,
              sport_key: sportKey,
              sport_title: g.sport || sportKey,
              bookmakers: g.odds
            }));
            await redis.set(cacheKey, JSON.stringify(games), 'EX', 300);
            return games;
          }
        }
      } catch (err) {
        sentryService.captureError(err, { component: `odds_${provider.name}_fetch`, sportKey });
        console.warn(`Odds fetch failed for provider ${provider.name} sportKey ${sportKey}: ${err?.message || 'Unknown error'}`);
      }
    }
    await redis.set(cacheKey, '[]', 'EX', 60); // Cache empty for 1 minute to avoid thrash
    return [];
  }

  /**
   * Aggregates/normalizes across sports and deduplicates by game identity.
   */
  async getAllSportsOdds() {
    const sports = await this.getSupportedSports();
    const allSupportedKeys = sports.map(s => s.key);

    const results = await Promise.allSettled(allSupportedKeys.map(k => this.getSportOdds(k)));

    const allOdds = results
      .filter(res => res.status === 'fulfilled' && Array.isArray(res.value) && res.value.length > 0)
      .flatMap(res => res.value);

    return this.processAndDeduplicateOdds(allOdds);
  }

  processAndDeduplicateOdds(games) {
    const deduped = new Map();
    for (const g of games) {
      const key = `${g.home_team}_${g.away_team}_${g.commence_time}`;
      if (!deduped.has(key)) deduped.set(key, g);
    }
    const uniqueGames = Array.from(deduped.values());
    uniqueGames.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    return uniqueGames;
  }
}

// Instantiate and export default (keeps your existing API)
const provenService = new ProvenOddsService();
export default provenService;

// ===== Named exports expected by handlers (ESM strict) =====
// Expose sports list as { sport_key, sport_title } to match handler imports
export async function getAvailableSportsCached() {
  // The Odds API v4 sports endpoint returns active (in-season) sports used in downstream odds endpoints
  // This maps to handler-expected names and keeps cache behavior centralized in the service methods
  const sports = await provenService.getSupportedSports();
  return (sports || []).map(s => ({
    sport_key: s.key,
    sport_title: s.title || s.key,
  }));
}

// Expose per-sport games and build a secondary Redis index by game id for detail lookups
export async function getGamesForSportCached(sportKey) {
  // v4 per-sport odds (with US region and featured markets) is what handlers expect to iterate
  const games = await provenService.getSportOdds(sportKey);
  for (const g of games || []) {
    if (g?.id) {
      await redis.set(`odds:game:${g.id}`, JSON.stringify(g), 'EX', GAMEIDX_TTL);
    }
  }
  return games || [];
}

// Expose latest game details by id via the secondary index; returns null if not seen recently
export async function getGameDetailsCached(gameId) {
  if (!gameId) return null;
  const raw = await redis.get(`odds:game:${gameId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
