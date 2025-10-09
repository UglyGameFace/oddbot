// src/services/providers/apiSportsProvider.js
export class ApiSportsProvider {
  constructor(apiKey, baseURL = 'https://v1.american-football.api-sports.io') {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.headers = {
      'x-rapidapi-host': 'v1.american-football.api-sports.io',
      'x-rapidapi-key': this.apiKey,
    };
  }

  async makeRequest(endpoint, params = {}) {
    try {
      const url = new URL(`${this.baseURL}/${endpoint}`);
      Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

      const response = await fetch(url, {
        method: 'GET',
        headers: this.headers,
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.errors && Object.keys(data.errors).length > 0) {
        throw new Error(`API errors: ${JSON.stringify(data.errors)}`);
      }

      return data;
    } catch (error) {
      console.error(`ApiSportsProvider request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  async getGames(date = new Date().toISOString().split('T')[0], league = 1) {
    try {
      const data = await this.makeRequest('games', {
        date: date,
        league: league
      });

      return this.#transformGamesData(data);
    } catch (error) {
      console.error('Failed to fetch games:', error);
      throw error;
    }
  }

  async getOdds(gameId, bookmaker = 1) {
    try {
      const data = await this.makeRequest('odds', {
        game: gameId,
        bookmaker: bookmaker
      });

      return this.#transformOddsData(data);
    } catch (error) {
      console.error(`Failed to fetch odds for game ${gameId}:`, error);
      throw error;
    }
  }

  async getStandings(season = new Date().getFullYear(), league = 1) {
    try {
      const data = await this.makeRequest('standings', {
        season: season,
        league: league
      });

      return this.#transformStandingsData(data);
    } catch (error) {
      console.error('Failed to fetch standings:', error);
      throw error;
    }
  }

  async getTeams(league = 1, season = new Date().getFullYear()) {
    try {
      const data = await this.makeRequest('teams', {
        league: league,
        season: season
      });

      return this.#transformTeamsData(data);
    } catch (error) {
      console.error('Failed to fetch teams:', error);
      throw error;
    }
  }

  async getInjuries(gameId = null, teamId = null) {
    try {
      const params = {};
      if (gameId) params.game = gameId;
      if (teamId) params.team = teamId;

      const data = await this.makeRequest('injuries', params);
      return this.#transformInjuriesData(data);
    } catch (error) {
      console.error('Failed to fetch injuries:', error);
      throw error;
    }
  }

  #transformGamesData(data) {
    if (!data.response || !Array.isArray(data.response)) {
      return [];
    }

    return data.response.map(game => ({
      id: game.game?.id,
      date: game.game?.date,
      time: game.game?.time,
      timestamp: game.game?.timestamp,
      timezone: game.game?.timezone,
      status: game.game?.status,
      week: game.game?.week,
      home_team: {
        id: game.teams?.home?.id,
        name: game.teams?.home?.name,
        logo: game.teams?.home?.logo
      },
      away_team: {
        id: game.teams?.away?.id,
        name: game.teams?.away?.name,
        logo: game.teams?.away?.logo
      },
      scores: {
        home: game.scores?.home,
        away: game.scores?.away
      },
      venue: {
        id: game.venue?.id,
        name: game.venue?.name,
        city: game.venue?.city
      }
    }));
  }

  #transformOddsData(data) {
    if (!data.response || !Array.isArray(data.response)) {
      return [];
    }

    const odds = [];
    data.response.forEach(gameOdds => {
      if (gameOdds.bookmakers && Array.isArray(gameOdds.bookmakers)) {
        gameOdds.bookmakers.forEach(bookmaker => {
          if (bookmaker.bets && Array.isArray(bookmaker.bets)) {
            bookmaker.bets.forEach(bet => {
              if (bet.values && Array.isArray(bet.values)) {
                bet.values.forEach(value => {
                  odds.push({
                    game_id: gameOdds.game?.id,
                    bookmaker: bookmaker.name,
                    bet_type: bet.name,
                    selection: value.value,
                    odds_american: value.odd,
                    odds_decimal: this.#americanToDecimal(value.odd),
                    updated_at: bookmaker.update
                  });
                });
              }
            });
          }
        });
      }
    });

    return odds;
  }

  #transformStandingsData(data) {
    if (!data.response || !Array.isArray(data.response)) {
      return [];
    }

    return data.response.map(standing => ({
      league: standing.league,
      conference: standing.conference,
      division: standing.division,
      position: standing.position,
      team: {
        id: standing.team?.id,
        name: standing.team?.name,
        logo: standing.team?.logo
      },
      games: {
        played: standing.games?.played,
        win: standing.games?.win,
        loss: standing.games?.loss,
        tie: standing.games?.tie
      },
      points: {
        for: standing.points?.for,
        against: standing.points?.against
      },
      records: standing.records
    }));
  }

  #transformTeamsData(data) {
    if (!data.response || !Array.isArray(data.response)) {
      return [];
    }

    return data.response.map(team => ({
      id: team.id,
      name: team.name,
      code: team.code,
      country: team.country,
      founded: team.founded,
      national: team.national,
      logo: team.logo,
      venue: {
        id: team.venue?.id,
        name: team.venue?.name,
        address: team.venue?.address,
        city: team.venue?.city,
        capacity: team.venue?.capacity,
        surface: team.venue?.surface,
        image: team.venue?.image
      }
    }));
  }

  #transformInjuriesData(data) {
    if (!data.response || !Array.isArray(data.response)) {
      return [];
    }

    return data.response.map(injury => ({
      player: {
        id: injury.player?.id,
        name: injury.player?.name,
        photo: injury.player?.photo
      },
      team: {
        id: injury.team?.id,
        name: injury.team?.name,
        logo: injury.team?.logo
      },
      game: {
        id: injury.game?.id,
        date: injury.game?.date
      },
      injury: {
        type: injury.injury?.type,
        reason: injury.injury?.reason
      },
      status: injury.status
    }));
  }

  #americanToDecimal(americanOdds) {
    if (americanOdds > 0) {
      return (americanOdds / 100) + 1;
    } else {
      return (100 / Math.abs(americanOdds)) + 1;
    }
  }

  async getPlayerStats(playerId, season = new Date().getFullYear()) {
    try {
      const data = await this.makeRequest('players', {
        id: playerId,
        season: season
      });

      return this.#transformPlayerStats(data);
    } catch (error) {
      console.error(`Failed to fetch player stats for ${playerId}:`, error);
      throw error;
    }
  }

  #transformPlayerStats(data) {
    if (!data.response || !Array.isArray(data.response)) {
      return null;
    }

    const player = data.response[0];
    return {
      player: {
        id: player.id,
        name: player.name,
        firstname: player.firstname,
        lastname: player.lastname,
        age: player.age,
        birth: player.birth,
        nationality: player.nationality,
        height: player.height,
        weight: player.weight,
        photo: player.photo
      },
      statistics: player.statistics?.map(stat => ({
        team: {
          id: stat.team?.id,
          name: stat.team?.name,
          logo: stat.team?.logo
        },
        league: {
          id: stat.league?.id,
          name: stat.league?.name,
          country: stat.league?.country,
          season: stat.league?.season
        },
        games: {
          position: stat.games?.position,
          rating: stat.games?.rating,
          captain: stat.games?.captain
        },
        shots: {
          total: stat.shots?.total,
          on: stat.shots?.on
        },
        goals: {
          total: stat.goals?.total,
          conceded: stat.goals?.conceded,
          assists: stat.goals?.assists,
          saves: stat.goals?.saves
        },
        passes: {
          total: stat.passes?.total,
          key: stat.passes?.key,
          accuracy: stat.passes?.accuracy
        },
        tackles: {
          total: stat.tackles?.total,
          blocks: stat.tackles?.blocks,
          interceptions: stat.tackles?.interceptions
        },
        duels: {
          total: stat.duels?.total,
          won: stat.duels?.won
        },
        dribbles: {
          attempts: stat.dribbles?.attempts,
          success: stat.dribbles?.success,
          past: stat.dribbles?.past
        },
        fouls: {
          drawn: stat.fouls?.drawn,
          committed: stat.fouls?.committed
        },
        cards: {
          yellow: stat.cards?.yellow,
          red: stat.cards?.red
        },
        penalty: {
          won: stat.penalty?.won,
          committed: stat.penalty?.committed,
          scored: stat.penalty?.scored,
          missed: stat.penalty?.missed,
          saved: stat.penalty?.saved
        }
      }))
    };
  }

  // Health check method
  async healthCheck() {
    try {
      const data = await this.makeRequest('status');
      return {
        healthy: true,
        requests: data.requests,
        account: data.account
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  // Rate limiting helper
  async withRateLimit(fn, delay = 1000) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        resolve(await fn());
      }, delay);
    });
  }
}

export default ApiSportsProvider;
