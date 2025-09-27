// src/bot/handlers/model.js

import oddsService from '../../services/oddsService.js'; // use the default export for oddsService methods
import aiService from '../../services/aiService.js';
import advancedOddsModel from '../../advancedOddsModel.js';
import { formatGameTimeTZ, toDecimalFromAmerican, toAmerican, impliedProbability, groupLegsByGame } from '../../utils/enterpriseAdapters.js';

export function registerModel(bot) { ... }
  bot.onText(/^\/model(?: (.+))?/, async (msg, match) => {
    const sport = match[1] || 'default';
    const chatId = msg.chat.id;
    try {
      // oddsService must have a function to get odds for a sport:
      const oddsData = await oddsService.getSportOdds(sport);

      const aiCheck = await aiService.validateOdds(oddsData);
      const sourceData = aiCheck.confidence > 0.8 ? aiCheck.data : oddsData;

      // Produce model analytics for each game:
      const modelAnalyses = sourceData.map(game => {
        const implied = advancedOddsModel.calculateImpliedProbabilities(game);
        const features = advancedOddsModel.engineerGameFeatures(game);
        // You can add more analytics or reformat as needed here
        return [
          `Game: ${game.away_team} @ ${game.home_team}`,
          `Implied probs: home ${implied.home || '?'}, away ${implied.away || '?'}, draw ${implied.draw || '?'}`,
          `Features: ${JSON.stringify(features)}`
        ].join('\n');
      });

      await bot.sendMessage(chatId, `🤖 Model-Generated Parlays:\n${modelAnalyses.join('\n\n')}`);
    } catch (e) {
      console.error('Model error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate models.');
    }
  });
}
