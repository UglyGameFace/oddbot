// src/bot/handlers/model.js

import oddsService from '../../services/oddsService.js';
import gamesService from '../../services/gamesService.js';
import aiService from '../../services/aiService.js';
import { advancedOddsModel } from '../../utils/enterpriseUtilities.js';

export function registerModel(bot) {
  bot.onText(/^\/model(?: (.+))?/, async (msg, match) => {
    const sport = match?.[1] || 'basketball_nba';
    const chatId = msg.chat.id;

    try {
      // Live first
      let oddsData = await oddsService.getSportOdds(sport);

      // DB fallback
      if (!oddsData?.length) {
        oddsData = await gamesService.getGamesForSport(sport);
      }

      if (!oddsData?.length) {
        return bot.sendMessage(chatId, `No odds data for ${sport}.\n\n_Run /cache to fetch the latest odds._`, { parse_mode: 'Markdown' });
      }

      // Normalize bookmakers for model
      const normalized = (oddsData || []).map((g) => ({
        ...g,
        bookmakers: g.bookmakers || g.market_data?.bookmakers || [],
      }));

      const aiCheck = await aiService.validateOdds(normalized);
      if (!aiCheck.valid) return bot.sendMessage(chatId, `AI validation failed for ${sport} data.`);

      const modelAnalyses = normalized.map(game => {
        const implied = advancedOddsModel.calculateImpliedProbabilities(game);
        const features = advancedOddsModel.engineerGameFeatures(game);
        return `*Game:* ${game.away_team} @ ${game.home_team}\n*Implied Probs:* home ${implied.home.toFixed(1)}%, away ${implied.away.toFixed(1)}%\n*Features:* \`${JSON.stringify(features)}\``;
      });

      const messageText = `🤖 *Model-Generated Insights for ${sport}:*\n\n${modelAnalyses.join('\n\n')}\n\n_Note: Data is based on the latest available odds. Run /cache for freshest odds._`;
      await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Model handler error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate models.');
    }
  });
}
