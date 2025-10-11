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
    if (action === 'quant_help') return sendQuantHelpMenu(bot, chatId, messageId);


    // AI Settings
    if (action === 'aimode') return sendAiModeMenu(bot, chatId, messageId);
    if (action === 'aimodel') return sendAiModelMenu(bot, chatId, messageId);
    if (action === 'aibettype') return sendAiBetTypeMenu(bot, chatId, messageId);
    if (action === 'aihorizon') return sendAiTimeHorizonMenu(bot, chatId, messageId);

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
        
        const numericValue = isNaN(value) ? value : Number(value);
  
        if (value === 'toggle') {
          config[key] = !config[key];
        } else {
          // *** FIX: Only update and redraw if the value has changed ***
          if (config[key] === numericValue) {
              return; // Do nothing if the value is already the same
          }
    
          config[key] = numericValue;
        }
        await setConfigFunc(chatId, config);
  
        // Return to the correct menu after setting a value
        if (category === 'ai' && key === 'horizonHours') return sendAiTimeHorizonMenu(bot, chatId, messageId);
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
      [{ text: `Default Mode: ${config.mode || 'Web Research'}`, callback_data: 'set_aimode' }],
      [{ text: `Default Web AI: ${config.model || 'Perplexity'}`, callback_data: 'set_aimodel' }],
      [{ text: `Default Bet Type: ${config.betType || 'Mixed'}`, callback_data: 'set_aibettype' }],
      [{ text: `Time Horizon: ${config.horizonHours || 72} hours`, callback_data: 'set_aihorizon' }],
      [{ text: `Pro Quant Mode: ${config.proQuantMode ? '✅ On' : '❌ Off'}`, callback_data: 'set_set_ai_proQuantMode_toggle' }],
      [{ text: '❔ What is Pro Quant Mode?', callback_data: 'set_quant_help' }],
      [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  }

// NEW MENU for Time Horizon
async function sendAiTimeHorizonMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = `*Set AI Time Horizon*\n\nCurrent: ${config.horizonHours || 72} hours\n\nSelect the time window for the AI to search for games. Shorter times are faster and more focused on immediate opportunities.`;
    const keyboard = [
        [{ text: `Next 12 Hours ${config.horizonHours === 12 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_12' }],
        [{ text: `Next 24 Hours ${config.horizonHours === 24 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_24' }],
        [{ text: `Next 48 Hours ${config.horizonHours === 48 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_48' }],
        [{ text: `Next 72 Hours ${config.horizonHours === 72 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_72' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendAiModeMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = 'Select your preferred default analysis mode for the AI:';
    const keyboard = [
        [{ text: `📡 Live API (Best) ${config.mode === 'live' ? '✅' : ''}`, callback_data: 'set_set_ai_mode_live' }],
        [{ text: `🌐 Web Research ${config.mode === 'web' ? '✅' : ''}`, callback_data: 'set_set_ai_mode_web' }],
        [{ text: `💾 Database Fallback ${config.mode === 'db' ? '✅' : ''}`, callback_data: 'set_set_ai_mode_db' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiModelMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = 'Select your default AI for the "Web Research" mode:';
    const keyboard = [
        [{ text: `🧠 Gemini (Creative) ${config.model === 'gemini' ? '✅' : ''}`, callback_data: 'set_set_ai_model_gemini' }],
        [{ text: `⚡️ Perplexity (Data-Focused) ${config.model === 'perplexity' ? '✅' : ''}`, callback_data: 'set_set_ai_model_perplexity' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiBetTypeMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = 'Select the default type of parlay the AI should build:';
    const keyboard = [
        [{ text: `🔥 Player Props Only ${config.betType === 'props' ? '✅' : ''}`, callback_data: 'set_set_ai_betType_props' }],
        [{ text: `🧩 Any Bet Type (Mixed) ${config.betType === 'mixed' ? '✅' : ''}`, callback_data: 'set_set_ai_betType_mixed' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
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
    const config = await getBuilderConfig(chatId);
    const text = 'Select the maximum time horizon for games to appear in the custom builder:';
    const keyboard = [
        [{ text: `Next 6 Hours ${config.cutoffHours === 6 ? '✅' : ''}`, callback_data: 'set_set_builder_cutoffHours_6' }],
        [{ text: `Next 12 Hours ${config.cutoffHours === 12 ? '✅' : ''}`, callback_data: 'set_set_builder_cutoffHours_12' }],
        [{ text: `Next 24 Hours ${config.cutoffHours === 24 ? '✅' : ''}`, callback_data: 'set_set_builder_cutoffHours_24' }],
        [{ text: `Next 48 Hours ${config.cutoffHours === 48 ? '✅' : ''}`, callback_data: 'set_set_builder_cutoffHours_48' }],
        [{ text: '« Back to Builder Settings', callback_data: 'set_builder' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}

async function sendQuantHelpMenu(bot, chatId, messageId) {
    const text = `*❔ Pro Quant Mode Explained*\n\nThis mode enables advanced quantitative analysis features for more sophisticated betting strategies:\n\n` +
      `*No-Vig Per-Leg Edges:*\nCalculates the "true" odds by removing the bookmaker's commission (vig), revealing the real probability and edge for each leg of the parlay.\n\n` +
      `*CLV Gating:*\nStands for Closing Line Value. This feature ensures that the odds you get are better than the final odds before the game starts, which is a strong indicator of a profitable bet.\n\n` +
      `*Correlation Caps:*\nReduces the risk of having too many bets in the same game or that are closely related, which can increase the overall risk of the parlay.\n\n` +
      `*Parlay Safety Margin:*\nA conservative adjustment to the parlay's total probability to account for unpredictable factors, making the expected value more realistic.\n\n` +
      `*Calibrated Probability Checks:*\nAdjusts the AI's confidence to be more realistic, preventing over-optimistic predictions.\n\n` +
      `*Ranking by Calibrated EV & Kelly Criterion:*\nParlays are ranked by their calibrated Expected Value (EV). In case of a tie, the Kelly Criterion is used to recommend the optimal bet size, favoring the parlay with better risk-adjusted returns.`;

    const keyboard = [
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
}
