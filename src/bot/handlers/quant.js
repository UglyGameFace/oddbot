// src/bot/handlers/quant.js
import { getGamesForSportCached } from '../../services/oddsService.js';

export function registerQuant(bot) {
  bot.onText(/\/quant/, async (msg) => {
    const chatId = msg.chat.id;
    const games = await getGamesForSportCached('americanfootball_nfl');
    if (!games?.length) return bot.sendMessage(chatId, 'Not enough game data to run quant analysis. Try again later.');

    let best = { price: Infinity, name: 'N/A', game: { away_team: 'N/A', home_team: 'N/A' } };
    games.forEach((g) => {
      const m = g.bookmakers?.[0]?.markets?.find((x) => x.key === 'h2h');
      m?.outcomes?.forEach((o) => { if (typeof o.price === 'number' && o.price < best.price) best = { price: o.price, name: o.name, game: g }; });
    });

    const txt =
      `⚡️ *Today's Top Quant Pick*\n\n` +
      `Based on current market data, the heaviest moneyline favorite is:\n\n` +
      `- *${best.name} ML* (${best.price})\n   _${best.game.away_team} @ ${best.game.home_team}_`;
    await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
  });
}
