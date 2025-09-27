// src/bot/handlers/analytics.js

import oddsService from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
import { analyzeQuantitative, psychometric } from '../../utils/enterpriseUtilities.js';

export function registerAnalytics(bot) {
  bot.onText(/^\/analytics(?:\s+(\w+))?/, async (msg, match) => {
    const sportKey = match[1] || 'basketball_nba';
    const chatId = msg.chat.id;
    try {
      const oddsData = await oddsService.getSportOdds(sportKey);
      if (!oddsData || !oddsData.length) return bot.sendMessage(chatId, `No odds data available for ${sportKey}.`);

      const aiValidation = await aiService.validateOdds(oddsData);
      if (!aiValidation.valid) return bot.sendMessage(chatId, `AI validation failed for ${sportKey} data.`);

      const quantReport = analyzeQuantitative(oddsData);
      const psychoReport = await psychometric.profileUser(chatId);

      const reportText = `*📊 Quantitative Insights for ${sportKey}:*\n\`\`\`json\n${JSON.stringify(quantReport, null, 2)}\n\`\`\`\n\n*🧠 Behavioral Insights for your profile:*\n\`\`\`json\n${JSON.stringify(psychoReport, null, 2)}\n\`\`\``;
      await bot.sendMessage(chatId, reportText, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Analytics handler error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate analytics report.');
    }
  });
}
