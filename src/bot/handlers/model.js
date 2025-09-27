// src/bot/handlers/model.js

import oddsService from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
import { advancedOddsModel } from '../../utils/enterpriseUtilities.js';

export function registerModel(bot) {
  bot.onText(/^\/model(?: (.+))?/, async (msg, match) => {
    const sport = match[1] || 'default';
    const chatId = msg.chat.id;
    try {
      const oddsData = await oddsService.getSportOdds(sport);
      if (!oddsData || !oddsData.length) return bot.sendMessage(chatId, `No odds data for ${sport}.`);
      
      const aiCheck = await aiService.validateOdds(oddsData);
      if (!aiCheck.valid) return bot.sendMessage(chatId, `AI validation failed for ${sport} data.`);

      const modelAnalyses = oddsData.map(game => {
        const implied = advancedOddsModel.calculateImpliedProbabilities(game);
        const features = advancedOddsModel.engineerGameFeatures(game);
        return `*Game:* ${game.away_team} @ ${game.home_team}\n*Implied Probs:* home ${implied.home.toFixed(1)}%, away ${implied.away.toFixed(1)}%\n*Features:* \`${JSON.stringify(features)}\``;
      });

      await bot.sendMessage(chatId, `🤖 *Model-Generated Insights for ${sport}:*\n\n${modelAnalyses.join('\n\n')}`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Model handler error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate models.');
    }
  });
}
