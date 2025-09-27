// src/bot/handlers/model.js

import { getOdds } from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
import { generateModels } from '../../advancedOddsModel.js';
import { adaptEnterprise } from '../../utils/enterpriseAdapters.js';

export function registerModel(bot) {
  bot.onText(/^\/model(?: (.+))?/, async (msg, match) => {
    const sport = match[1] || 'default';
    const chatId = msg.chat.id;
    try {
      const oddsData = await getOdds(sport);
      const aiCheck = await aiService.validateOdds(oddsData);
      const sourceData = aiCheck.confidence > 0.8 ? aiCheck.data : oddsData;
      const models = generateModels(sourceData);
      const enterpriseModels = adaptEnterprise(models);
      await bot.sendMessage(chatId, `🤖 Model-Generated Parlays:\n${enterpriseModels.join('\n')}`);
    } catch (e) {
      console.error('Model error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate models.');
    }
  });
}
