import { getOdds } from '../../services/oddsService.js';
import aiService from '../../services/aiService.js';
import { analyzeQuantitative } from '../../quant.js';
import { psychometricAnalysis } from '../../psychometric.js';

export function registerAnalytics(bot) {
  bot.onText(/^\/analytics(?: (.+))?/, async (msg, match) => {
    const query = match[1] || '';
    const chatId = msg.chat.id;
    try {
      // 1. Fetch odds data
      const oddsData = await getOdds(query);
      // 2. AI validation
      const aiResult = await aiService.validateOdds(oddsData);
      const validOdds = aiResult.confidence > 0.8 ? aiResult.data : oddsData;
      // 3. Quantitative & psychometric analysis
      const quantReport = analyzeQuantitative(validOdds);
      const psychoReport = psychometricAnalysis(validOdds);
      // Send combined report
      await bot.sendMessage(chatId, `📊 Quantitative Insights:\n${quantReport}\n\n🧠 Behavioral Insights:\n${psychoReport}`);
    } catch (e) {
      console.error('Analytics error:', e);
      await bot.sendMessage(chatId, '❌ Failed to generate analytics.');
    }
  });
}
