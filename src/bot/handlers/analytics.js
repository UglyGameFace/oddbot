// src/bot/handlers/analytics.js

import oddsService from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
// FIX: Corrected the import path to point to the actual file containing this function.
import { analyzeQuantitative } from '../../quant.js'; 
// FIX: Corrected the import path for the psychometric module.
import psychometric from '../../psychometric.js';

export function registerAnalytics(bot) {
  // Usage: /analytics [sport_key] (example: /analytics basketball_nba)
  bot.onText(/^\/analytics(?:\s+(\w+))?/, async (msg, match) => {
    const sportKey = match[1] || 'basketball_nba';
    const chatId = msg.chat.id;
    try {
      // 1. Fetch odds for specified sport
      const oddsData = await oddsService.getSportOdds(sportKey);
      if (!oddsData || !oddsData.length) {
          return bot.sendMessage(chatId, `No odds data available for ${sportKey} at the moment.`);
      }

      // 2. AI validation of odds data (optional but good practice)
      const aiValidation = await aiService.validateOdds(oddsData);
      const validOdds = aiValidation.valid ? oddsData : [];

       if (!validOdds.length) {
          return bot.sendMessage(chatId, `AI validation failed for ${sportKey} data. Cannot proceed with analysis.`);
      }

      // 3. Run quantitative and psychometric analyses
      const quantReport = analyzeQuantitative(validOdds);
      const psychoReport = await psychometric.profileUser(chatId);

      // 4. Send combined analytics report
      const reportText = `
        *📊 Quantitative Insights for ${sportKey}:*\n\`\`\`json\n${JSON.stringify(quantReport, null, 2)}\n\`\`\`\n
        *🧠 Behavioral Insights for your profile:*\n\`\`\`json\n${JSON.stringify(psychoReport, null, 2)}\n\`\`\`
      `;

      await bot.sendMessage(chatId, reportText, { parse_mode: 'Markdown' });

    } catch (e) {
      console.error('Analytics handler error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate analytics report. An internal error occurred.');
    }
  });
}
