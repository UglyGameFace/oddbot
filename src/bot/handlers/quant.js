// src/bot/handlers/quant.js

import oddsService from '../../services/oddsService.js';
import gamesService from '../../services/gamesService.js';

export function registerQuant(bot) {
  bot.onText(/\/quant/, async (msg) => {
    const chatId = msg.chat.id;

    // Try live odds first
    let games = await oddsService.getSportOdds('americanfootball_nfl');

    // Fallback to database if live empty
    if (!games?.length) {
      games = await gamesService.getGamesForSport('americanfootball_nfl');
    }

    if (!games?.length) {
      return bot.sendMessage(
        chatId,
        'Not enough game data to run quant analysis. Try fetching data with /cache or try again later.'
      );
    }

    // Normalize bookmakers for DB/live shapes
    const getBookmakers = (g) => g?.bookmakers || g?.market_data?.bookmakers || [];

    let best = { price: Infinity, name: 'N/A', game: { away_team: 'N/A', home_team: 'N/A' } };
    games.forEach((g) => {
      const moneylineMarket = getBookmakers(g)?.[0]?.markets?.find((m) => m.key === 'h2h');
      moneylineMarket?.outcomes?.forEach((outcome) => {
        if (typeof outcome.price === 'number' && outcome.price < best.price) {
          best = { price: outcome.price, name: outcome.name, game: g };
        }
      });
    });

    if (best.price === Infinity) {
      return bot.sendMessage(chatId, 'Could not find any moneyline odds to analyze for the NFL.');
    }

    const txt =
      `⚡️ *Today's Top Quant Pick*\n\n` +
      `Based on current market data, the heaviest moneyline favorite is:\n\n` +
      `- *${best.name} ML* (${best.price})\n _${best.game.away_team} @ ${best.game.home_team}_`;
    await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
  });
}
