// src/utils/asyncUtils.js

export const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout ${ms}ms: ${label}`)), ms)
    )
  ]);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
};

export const safeJsonParse = (str, fallback = null) => {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
};

export const safeExecute = async (fn, fallback = null, context = {}) => {
  try {
    return await fn();
  } catch (error) {
    console.error(`Safe execution failed:`, error.message, context);
    return fallback;
  }
};

export const batchProcess = async (items, processor, batchSize = 10, delayBetweenBatches = 100) => {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(item => processor(item)));
    results.push(...batchResults);
    
    if (i + batchSize < items.length && delayBetweenBatches > 0) {
      await sleep(delayBetweenBatches);
    }
  }
  return results;
};

export async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
    if (!bot) {
      console.warn('⚠️ Bot instance not provided to safeEditMessage');
      return;
    }
    try {
      const editOptions = { parse_mode: 'HTML', ...options };
      if (!editOptions.reply_markup) {
        editOptions.reply_markup = { inline_keyboard: [] };
      }
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...editOptions });
    } catch (error) {
      if (error.response?.body?.description?.includes('message is not modified')) { return; }
      if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('inline keyboard expected')) {
        return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: options.parse_mode || 'HTML', reply_markup: { inline_keyboard: [] } });
      }
      if (error.response?.body?.error_code === 400 && error.response.body.description?.includes('message to edit not found')) { return; }
      console.error('❌ Message edit failed:', error.message);
    }
}
