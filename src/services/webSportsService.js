// src/services/webSportsService.js - ABSOLUTE FINAL VERSION
import axios from 'axios';
import * as cheerio from 'cheerio';

export class WebSportsService {
  
  static async getGamesFromVerifiedSources(sportKey) {
    console.log(`🌐 Fetching ${sportKey} games from verified online sources...`);
    
    try {
      const sources = this._getVerifiedSources(sportKey);
      let allGames = [];
      
      for (const source of sources) {
        try {
          console.log(`🔍 Checking ${source.name}...`);
          const games = await this._scrapeSource(source.url, sportKey, source.parser);
          if (games && games.length > 0) {
            allGames = [...allGames, ...games];
          }
        } catch (error) {
          console.warn(`⚠️ ${source.name} failed:`, error.message);
        }
      }
      
      const uniqueGames = this._deduplicateGames(allGames);
      console.log(`🎯 Total unique ${sportKey} games found: ${uniqueGames.length}`);
      
      return uniqueGames;
      
    } catch (error) {
      console.error('❌ Web sports service failed:', error);
      return [];
    }
  }

  static _getVerifiedSources(sportKey) {
    // Sticking to a single, reliable source (ESPN) prevents conflicting data and simplifies parsing.
    const sources = {
      'basketball_nba': [{ name: 'ESPN NBA Schedule', url: 'https://www.espn.com/nba/schedule', parser: 'espn_generic' }],
      'americanfootball_nfl': [{ name: 'ESPN NFL Schedule', url: 'https://www.espn.com/nfl/schedule', parser: 'espn_generic' }],
      'baseball_mlb': [{ name: 'ESPN MLB Schedule', url: 'https://www.espn.com/mlb/schedule', parser: 'espn_generic' }],
      'icehockey_nhl': [{ name: 'ESPN NHL Schedule', url: 'https://www.espn.com/nhl/schedule', parser: 'espn_generic' }]
    };
    return sources[sportKey] || [];
  }

  static async _scrapeSource(url, sportKey, parserType) {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
    });
    const $ = cheerio.load(data);
    return this._parseESPNGeneric($, sportKey);
  }

  static _parseESPNGeneric($, sportKey) {
    const games = [];
    let currentDate = null;

    // Iterate through all schedule table titles (dates) and content rows
    $('.Table__Title, .Table__TBODY tr').each((_, element) => {
        const el = $(element);

        // Check if the element is a date heading
        if (el.is('h2') && el.hasClass('Table__Title')) {
            const dateText = el.text().trim();
            const parsedDate = this._parseDate(dateText);
            if (parsedDate) {
                currentDate = parsedDate;
            }
        } 
        // Check if the element is a game row and we have a valid current date
        else if (el.is('tr') && currentDate) {
            const teams = el.find('a[href*="/team/"]');
            const timeEl = el.find('td:nth-child(3) a');
            
            if (teams.length >= 2) {
                const awayTeam = $(teams[0]).text().trim();
                const homeTeam = $(teams[1]).text().trim();
                let gameTime = timeEl.text().trim();

                if (awayTeam && homeTeam && gameTime) {
                    const combinedDateTime = this._combineDateAndTime(currentDate, gameTime);
                    if (combinedDateTime) {
                        games.push({
                            event_id: `web_${awayTeam.replace(/\s/g, '')}_${homeTeam.replace(/\s/g, '')}_${combinedDateTime.getTime()}`,
                            event: `${awayTeam} @ ${homeTeam}`,
                            away_team: awayTeam,
                            home_team: homeTeam,
                            commence_time: combinedDateTime.toISOString(),
                            source: 'web',
                            sport_key: sportKey
                        });
                    }
                }
            }
        }
    });
    return games;
  }
  
  static _parseDate(dateText) {
      if (!dateText) return null;
      try {
          const today = new Date();
          today.setHours(0, 0, 0, 0); // Normalize to start of day
          if (dateText.toLowerCase().includes('today')) return today;
          if (dateText.toLowerCase().includes('tomorrow')) {
              today.setDate(today.getDate() + 1);
              return today;
          }
          // Handles format like "Tuesday, October 14, 2025"
          const date = new Date(dateText);
          if (!isNaN(date.getTime())) {
              date.setHours(0,0,0,0);
              return date;
          }
      } catch (e) {
          console.warn(`Could not parse date: ${dateText}`);
      }
      return null;
  }

  static _combineDateAndTime(date, timeString) {
      if (!date || !timeString) return null;
      try {
          // Handles "7:00 PM ET" or "10:30 AM"
          const [time, period] = timeString.replace(/ ET$/, '').split(' ');
          let [hours, minutes] = time.split(':').map(Number);
  
          if (period && period.toLowerCase() === 'pm' && hours < 12) {
              hours += 12;
          }
          if (period && period.toLowerCase() === 'am' && hours === 12) { // Midnight case
              hours = 0;
          }
  
          // Create a new date object to avoid mutating the original
          const newDate = new Date(date);
          
          // Assuming the times from ESPN are US Eastern Time. We convert them to UTC.
          // In October, EDT is UTC-4.
          newDate.setUTCHours(hours + 4, minutes, 0, 0); 

          return newDate;
      } catch (e) {
          console.warn(`Could not combine date and time: ${date}, ${timeString}`);
          return null;
      }
  }

  static _deduplicateGames(games) {
    const seen = new Set();
    return games.filter(game => {
      const key = `${game.away_team}|${game.home_team}|${game.commence_time}`;
      return seen.has(key) ? false : seen.add(key);
    });
  }

  static async getUpcomingGames(sportKey, hours = 72) {
    const allGames = await this.getGamesFromVerifiedSources(sportKey);
    const now = Date.now();
    const cutoff = now + hours * 60 * 60 * 1000;
    
    return allGames.filter(game => {
      try {
        const gameTime = new Date(game.commence_time).getTime();
        return gameTime > now && gameTime <= cutoff;
      } catch {
        return false;
      }
    });
  }
}
