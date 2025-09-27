// src/bot/handlers/analytics.js

import oddsService from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
import { analyzeQuantitative } from '../../quant.js';              // src/quant.js EXPORTS THIS
import psychometric from '../../psychometric.js';                   // src/psychometric.js default export

// Optionally, add more imports as needed, always starting with '../../' for anything in /src/services/, /src/bot/, /src/utils/

export function registerAnalytics(bot) {
  // Usage: /analytics [sport_key] (example: /analytics basketball_nba)
  bot.onText(/^\/analytics(?:\s+(\w+))?/, async (msg, match) => {
    const sportKey = match[1] || 'basketball_nba';
    const chatId = msg.chat.id;
    try {
      // 1. Fetch odds for specified sport using correct API
      const oddsData = await oddsService.getSportOdds(sportKey);

      // 2. AI validation of odds data
      const aiResult = await aiService.validateOdds(oddsData);
      const validOdds = aiResult && aiResult.confidence > 0.8 ? aiResult.data : oddsData;

      // 3. Run quantitative and psychometric analyses
      const quantReport = analyzeQuantitative(validOdds);         // Can be a function, possibly async if needed
      const psychoReport = await psychometric.profileUser(chatId); // Always async

      // 4. Send combined analytics report
      await bot.sendMessage(
        chatId,
        `📊 Quantitative Insights:\n${JSON.stringify(quantReport)}\n\n🧠 Behavioral Insights:\n${JSON.stringify(psychoReport)}`
      );
    } catch (e) {
      console.error('Analytics error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate analytics.');
    }
  });
}
