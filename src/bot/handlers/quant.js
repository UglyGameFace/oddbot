// src/bot/handlers/quant.js

import oddsService from '../../services/oddsService.js';

export function registerQuant(bot) {
  bot.onText(/\/quant/, async (msg) => {
    const chatId = msg.chat.id;

    const games = await oddsService.getSportOdds('americanfootball_nfl');

    if (!games?.length) {
      return bot.sendMessage(
        chatId,
        'Not enough game data to run quant analysis. Try fetching data with /cache or check the logs.'
      );
    }

    let best = { price: Infinity, name: 'N/A', game: { away_team: 'N/A', home_team: 'N/A' } };

    games.forEach((g) => {
      // Find the h2h (moneyline) market from the first bookmaker
      const moneylineMarket = g.bookmakers?.[0]?.markets?.find((market) => market.key === 'h2h');
      moneylineMarket?.outcomes?.forEach((outcome) => {
        if (typeof outcome.price === 'number' && outcome.price < best.price) {
          best = {
            price: outcome.price,
            name: outcome.name,
            game: g,
          };
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
