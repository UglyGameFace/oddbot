// src/bot/handlers/model.js

import oddsService from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
// FIX: Corrected the import path for the advanced model.
import advancedOddsModel from '../../advancedOddsModel.js';
// FIX: Ensured utility functions are imported from the correct, single source.
import { formatGameTimeTZ, toDecimalFromAmerican, toAmerican, impliedProbability, groupLegsByGame } from '../../utils/enterpriseUtilities.js';

export function registerModel(bot) {
  bot.onText(/^\/model(?: (.+))?/, async (msg, match) => {
    const sport = match[1] || 'default';
    const chatId = msg.chat.id;
    try {
      const oddsData = await oddsService.getSportOdds(sport);
      if (!oddsData || !oddsData.length) {
        return bot.sendMessage(chatId, `No odds data available for ${sport}.`);
      }

      const aiCheck = await aiService.validateOdds(oddsData);
      const sourceData = aiCheck.valid ? oddsData : [];

      if (!sourceData.length) {
          return bot.sendMessage(chatId, `AI validation failed for ${sport} data. Cannot build model.`);
      }

      // Produce model analytics for each game:
      const modelAnalyses = sourceData.map(game => {
        const implied = advancedOddsModel.calculateImpliedProbabilities(game);
        const features = advancedOddsModel.engineerGameFeatures(game);
        return [
          `*Game:* ${game.away_team} @ ${game.home_team}`,
          `*Implied Probs:* home ${implied.home.toFixed(2)}%, away ${implied.away.toFixed(2)}%, draw ${implied.draw.toFixed(2)}%`,
          `*Features:* \`${JSON.stringify(features)}\``
        ].join('\n');
      });

      await bot.sendMessage(chatId, `🤖 *Model-Generated Insights for ${sport}:*\n\n${modelAnalyses.join('\n\n')}`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Model handler error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate models.');
    }
  });
}
