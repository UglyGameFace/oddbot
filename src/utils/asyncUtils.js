// src/utils/asyncUtils.js
export const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout ${ms}ms: ${label}`)), ms)
    )
  ]);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
    if (!bot) {
      console.warn('⚠️ Bot instance not provided to safeEditMessage');
      return;
    }
    try {
      const editOptions = { parse_mode: 'HTML', ...options, chat_id: chatId, message_id: messageId };
      return await bot.editMessageText(text, editOptions);
    } catch (error) {
      if (error.response?.body?.description?.includes('message is not modified')) { return; }
      if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('message to edit not found')) { return; }
      console.error('❌ Message edit failed:', error.message);
    }
}
