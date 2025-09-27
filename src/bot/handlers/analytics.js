// src/bot/handlers/analytics.js

import oddsService from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
// FIX: All analysis functions are now imported from the central utility file.
import { analyzeQuantitative, psychometric } from '../../utils/enterpriseUtilities.js';

export function registerAnalytics(bot) {
  bot.onText(/^\/analytics(?:\s+(\w+))?/, async (msg, match) => {
    const sportKey = match[1] || 'basketball_nba';
    const chatId = msg.chat.id;
    try {
      const oddsData = await oddsService.getSportOdds(sportKey);
      if (!oddsData || !oddsData.length) {
          return bot.sendMessage(chatId, `No odds data available for ${sportKey} at the moment.`);
      }

      const aiValidation = await aiService.validateOdds(oddsData);
      if (!aiValidation.valid) {
          return bot.sendMessage(chatId, `AI validation failed for ${sportKey} data. Cannot proceed.`);
      }

      const quantReport = analyzeQuantitative(oddsData);
      const psychoReport = await psychometric.profileUser(chatId);

      const reportText = `
*📊 Quantitative Insights for ${sportKey}:*
\`\`\`json
${JSON.stringify(quantReport, null, 2)}
\`\`\`

*🧠 Behavioral Insights for your profile:*
\`\`\`json
${JSON.stringify(psychoReport, null, 2)}
\`\`\`
      `;
      await bot.sendMessage(chatId, reportText, { parse_mode: 'Markdown' });

    } catch (e) {
      console.error('Analytics handler error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate analytics report.');
    }
  });
}
