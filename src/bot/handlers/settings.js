// src/bot/handlers/settings.js

import { getAIConfig, setAIConfig, getBuilderConfig, setBuilderConfig, setUserState } from '../state.js';

// --- Main Command and Callback Router ---

export function registerSettings(bot) {
  bot.onText(/^\/settings$/, async (msg) => {
    await sendMainMenu(bot, msg.chat.id);
  });
}

export function registerSettingsCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('set_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    await bot.answerCallbackQuery(cbq.id);

    const parts = data.split('_');
    const action = parts[1];

    // Main Menu Navigation
    if (action === 'main') return sendMainMenu(bot, chatId, messageId);
    if (action === 'ai') return sendAiSettingsMenu(bot, chatId, messageId);
    if (action === 'builder') return sendBuilderSettingsMenu(bot, chatId, messageId);

    // AI Settings
    if (action === 'aimode') return sendAiModeMenu(bot, chatId, messageId);
    if (action === 'aimodel') return sendAiModelMenu(bot, chatId, messageId);
    if (action === 'aibettype') return sendAiBetTypeMenu(bot, chatId, messageId);
    
    // Builder Settings
    if (action === 'bldodds') return sendBuilderOddsMenu(bot, chatId, messageId);
    if (action === 'bldcutoff') return sendBuilderCutoffMenu(bot, chatId, messageId);
    if (action === 'bldsamegame') {
        const config = await getBuilderConfig(chatId);
        config.avoidSameGame = !config.avoidSameGame;
        await setBuilderConfig(chatId, config);
        return sendBuilderSettingsMenu(bot, chatId, messageId);
    }
    
    // Set Value Actions
    if (action === 'set') {
      const [,, category, key, value] = parts;
      let config, setConfigFunc;

      if (category === 'ai') {
        config = await getAIConfig(chatId);
        setConfigFunc = setAIConfig;
      } else { // builder
        config = await getBuilderConfig(chatId);
        setConfigFunc = setBuilderConfig;
      }
      
      config[key] = isNaN(value) ? value : Number(value);
      await setConfigFunc(chatId, config);

      if (category === 'ai') return sendAiSettingsMenu(bot, chatId, messageId);
      if (category === 'builder' && key.includes('Odds')) return sendBuilderOddsMenu(bot, chatId, messageId);
      if (category === 'builder' && key.includes('cutoff')) return sendBuilderCutoffMenu(bot, chatId, messageId);
    }
  });
}

// --- Main Menu ---

async function sendMainMenu(bot, chatId, messageId = null) {
  const text = '⚙️ *Bot Settings*\n\nChoose a category to configure:';
  const keyboard = [
    [{ text: '🤖 AI Analyst Settings', callback_data: 'set_ai' }],
    [{ text: '✍️ Custom Builder Settings', callback_data: 'set_builder' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  else await bot.sendMessage(chatId, text, opts);
}

// --- AI Analyst Settings Menus ---

async function sendAiSettingsMenu(bot, chatId, messageId) {
  const config = await getAIConfig(chatId);
  const text = `*🤖 AI Analyst Settings*\n\nSet your default preferences for the \`/ai\` command.`;
  const keyboard = [
    [{ text: `Default Mode: ${config.mode || 'Live API'}`, callback_data: 'set_aimode' }],
    [{ text: `Default Web AI: ${config.model || 'Gemini'}`, callback_data: 'set_aimodel' }],
    [{ text: `Default Bet Type: ${config.betType || 'Mixed'}`, callback_data: 'set_aibettype' }],
    [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendAiModeMenu(bot, chatId, messageId) {
    const text = 'Select your preferred default analysis mode for the AI:';
    const keyboard = [
        [{ text: '📡 Live API (Best)', callback_data: 'set_set_ai_mode_live' }],
        [{ text: '🌐 Web Research', callback_data: 'set_set_ai_mode_web' }],
        [{ text: '💾 Database Fallback', callback_data: 'set_set_ai_mode_db' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiModelMenu(bot, chatId, messageId) {
    const text = 'Select your default AI for the "Web Research" mode:';
    const keyboard = [
        [{ text: '🧠 Gemini (Creative)', callback_data: 'set_set_ai_model_gemini' }],
        [{ text: '⚡ Perplexity (Data-Focused)', callback_data: 'set_set_ai_model_perplexity' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiBetTypeMenu(bot, chatId, messageId) {
    const text = 'Select the default type of parlay the AI should build:';
    const keyboard = [
        [{ text: '🔥 Player Props Only', callback_data: 'set_set_ai_betType_props' }],
        [{ text: '🧩 Any Bet Type (Mixed)', callback_data: 'set_set_ai_betType_mixed' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

// --- Custom Builder Settings Menus ---

async function sendBuilderSettingsMenu(bot, chatId, messageId) {
  const config = await getBuilderConfig(chatId);
  const text = `*✍️ Custom Builder Settings*\n\nConfigure the rules for the manual \`/custom\` parlay builder.`;
  const keyboard = [
    [{ text: `Odds Range: ${config.minOdds} to ${config.maxOdds}`, callback_data: 'set_bldodds' }],
    [{ text: `Time Cutoff: ${config.cutoffHours} hours`, callback_data: 'set_bldcutoff' }],
    [{ text: `Avoid Same-Game Legs: ${config.avoidSameGame ? '✅ Yes' : '❌ No'}`, callback_data: 'set_bldsamegame' }],
    [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendBuilderOddsMenu(bot, chatId, messageId) {
    const config = await getBuilderConfig(chatId);
    const text = `*Set Odds Range*\n\nCurrent: ${config.minOdds} to ${config.maxOdds}\n\nSelect a minimum and maximum odds value for legs in the custom builder.`;
    const keyboard = [
        [{ text: 'Min Odds: -500', callback_data: 'set_set_builder_minOdds_-500' }, { text: 'Max Odds: +500', callback_data: 'set_set_builder_maxOdds_500' }],
        [{ text: 'Min Odds: -200', callback_data: 'set_set_builder_minOdds_-200' }, { text: 'Max Odds: +200', callback_data: 'set_set_builder_maxOdds_200' }],
        [{ text: 'Min Odds: +100', callback_data: 'set_set_builder_minOdds_100' }, { text: 'Max Odds: +1000', callback_data: 'set_set_builder_maxOdds_1000' }],
        [{ text: '« Back to Builder Settings', callback_data: 'set_builder' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendBuilderCutoffMenu(bot, chatId, messageId) {
    const text = 'Select the maximum time horizon for games to appear in the custom builder:';
    const keyboard = [
        [{ text: 'Next 6 Hours', callback_data: 'set_set_builder_cutoffHours_6' }],
        [{ text: 'Next 12 Hours', callback_data: 'set_set_builder_cutoffHours_12' }],
        [{ text: 'Next 24 Hours', callback_data: 'set_set_builder_cutoffHours_24' }],
        [{ text: 'Next 48 Hours', callback_data: 'set_set_builder_cutoffHours_48' }],
        [{ text: '« Back to Builder Settings', callback_data: 'set_builder' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}
