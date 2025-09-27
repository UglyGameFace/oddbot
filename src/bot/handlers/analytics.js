// src/bot/handlers/analytics.js
import oddsService from '../../services/oddsService.js';
import psychometric from './psychometric.js';
import { analyzeQuantitative } from '../utils/enterpriseUtilities.js';

export function registerAnalytics(bot) {
  // Usage: /analytics [sport_key] (example: /analytics basketball_nba)
  bot.onText(/^\/analytics(?:\s+(\w+))?/, async (msg, match) => {
    const sportKey = match[1] || 'basketball_nba';
    const chatId = msg.chat.id;

    try {
      const oddsData = await oddsService.getGamesForSportCached(sportKey);

      if (!oddsData || oddsData.length === 0) {
        return bot.sendMessage(chatId, 'No odds data available for this sport at the moment.');
      }

      const moneylineOdds = oddsData.flatMap(game =>
        game.bookmakers?.[0]?.markets
        .find(m => m.key === 'h2h')?.outcomes
        .map(o => o.price) || []
      ).filter(price => typeof price === 'number');

      const quantReport = analyzeQuantitative(moneylineOdds);
      const psychoReport = await psychometric.profileUser(chatId);

      const reportText = `📊 *Quantitative Insights for ${sportKey}:*\n\`\`\`json\n${JSON.stringify(quantReport, null, 2)}\n\`\`\`\n\n🧠 *Behavioral Insights:*\n\`\`\`json\n${JSON.stringify(psychoReport, null, 2)}\n\`\`\``;

      await bot.sendMessage(chatId, reportText, { parse_mode: 'Markdown' });

    } catch (e) {
      console.error('Analytics error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate analytics.');
    }
  });
}
