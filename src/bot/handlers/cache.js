import cron from 'node-cron';
import '../../oddsCacheAdapters.js';
import redisService from '../../services/redisService.js';

export function someCacheHandler() {
  // On command
  bot.onText(/^\/cache refresh$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await refreshCache();
      await bot.sendMessage(chatId, '✅ Cache refreshed.');
    } catch (e) {
      console.error('Cache refresh error:', e);
      await bot.sendMessage(chatId, '❌ Cache refresh failed.');
    }
  });

  // Scheduled every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await refreshCache();
      console.log('🗄️ Cache auto-refreshed.');
    } catch (e) {
      console.error('Auto cache refresh error:', e);
    }
  });
}
