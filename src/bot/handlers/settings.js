// src/bot/handlers/settings.js

import { getAIConfig, setAIConfig, getBuilderConfig, setBuilderConfig } from '../state.js';
import { safeEditMessage } from '../../bot.js';

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

    // AI Settings Submenus
    if (action === 'aimode') return sendAiModeMenu(bot, chatId, messageId);
    if (action === 'aimodel') return sendAiModelMenu(bot, chatId, messageId);
    if (action === 'aibettype') return sendAiBetTypeMenu(bot, chatId, messageId);
    if (action === 'aihorizon') return sendAiTimeHorizonMenu(bot, chatId, messageId);

    // Builder Settings Submenus
    if (action === 'bldodds') return sendBuilderOddsMenu(bot, chatId, messageId);
    if (action === 'bldcutoff') return sendBuilderCutoffMenu(bot, chatId, messageId);
    
    // Toggle Actions
    if (action === 'set' && parts[4] === 'toggle') {
        const [,, category, key] = parts;
        const config = category === 'ai' ? await getAIConfig(chatId) : await getBuilderConfig(chatId);
        const setConfigFunc = category === 'ai' ? setAIConfig : setBuilderConfig;
        
        config[key] = !config[key];
        await setConfigFunc(chatId, config);

        if (category === 'ai') return sendAiSettingsMenu(bot, chatId, messageId);
        return sendBuilderSettingsMenu(bot, chatId, messageId);
    }

    // Set Value Actions
    if (action === 'set') {
        const [,, category, key, value] = parts;
        const config = category === 'ai' ? await getAIConfig(chatId) : await getBuilderConfig(chatId);
        const setConfigFunc = category === 'ai' ? setAIConfig : setBuilderConfig;
        
        const numericValue = isNaN(value) ? value : Number(value);
  
        if (config[key] !== numericValue) {
          config[key] = numericValue;
          await setConfigFunc(chatId, config);
        }

        // Return to the correct submenu
        if (category === 'ai') {
            if (key === 'horizonHours') return sendAiTimeHorizonMenu(bot, chatId, messageId);
            return sendAiSettingsMenu(bot, chatId, messageId);
        }
        if (category === 'builder') {
            if (key.includes('Odds')) return sendBuilderOddsMenu(bot, chatId, messageId);
            if (key.includes('cutoff')) return sendBuilderCutoffMenu(bot, chatId, messageId);
            return sendBuilderSettingsMenu(bot, chatId, messageId);
        }
      }
  });
}

// --- Menus ---

async function sendMainMenu(bot, chatId, messageId = null) {
  const text = '⚙️ <b>Bot Settings</b>\n\nChoose a category to configure:';
  const keyboard = [
    [{ text: '🤖 AI Analyst Settings', callback_data: 'set_ai' }],
    [{ text: '✍️ Custom Builder Settings', callback_data: 'set_builder' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) await safeEditMessage(chatId, messageId, text, opts);
  else await bot.sendMessage(chatId, text, opts);
}

async function sendAiSettingsMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = `<b>🤖 AI Analyst Settings</b>\n\nSet your default preferences for the \`/ai\` command.`;
    const keyboard = [
      [{ text: `Default Mode: ${config.mode || 'Web Research'}`, callback_data: 'set_aimode' }],
      [{ text: `Default Web AI: ${config.model || 'Perplexity'}`, callback_data: 'set_aimodel' }],
      [{ text: `Default Bet Type: ${config.betType || 'Mixed'}`, callback_data: 'set_aibettype' }],
      [{ text: `Time Horizon: ${config.horizonHours || 72} hours`, callback_data: 'set_aihorizon' }],
      [{ text: `Pro Quant Mode: ${config.proQuantMode ? '✅ On' : '❌ Off'}`, callback_data: 'set_set_ai_proQuantMode_toggle' }],
      [{ text: '❔ What is Pro Quant Mode?', callback_data: 'set_quant_help' }],
      [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendAiTimeHorizonMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = `<b>Set AI Time Horizon</b>\n\nCurrent: ${config.horizonHours || 72} hours\n\nSelect the time window for the AI to search for games.`;
    const keyboard = [
        [{ text: `Next 12 Hours ${config.horizonHours === 12 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_12' }],
        [{ text: `Next 24 Hours ${config.horizonHours === 24 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_24' }],
        [{ text: `Next 48 Hours ${config.horizonHours === 48 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_48' }],
        [{ text: `Next 72 Hours ${config.horizonHours === 72 ? '✅' : ''}`, callback_data: 'set_set_ai_horizonHours_72' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
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
    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiModelMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = 'Select your default AI for the "Web Research" mode:';
    const keyboard = [
        [{ text: `⚡️ Perplexity (Data-Focused) ${config.model === 'perplexity' ? '✅' : ''}`, callback_data: 'set_set_ai_model_perplexity' }],
        [{ text: `🧠 Gemini (Creative) ${config.model === 'gemini' ? '✅' : ''}`, callback_data: 'set_set_ai_model_gemini' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiBetTypeMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = 'Select the default type of parlay the AI should build:';
    const keyboard = [
        [{ text: `🔥 Player Props Only ${config.betType === 'props' ? '✅' : ''}`, callback_data: 'set_set_ai_betType_props' }],
        [{ text: `🧩 Any Bet Type (Mixed) ${config.betType === 'mixed' ? '✅' : ''}`, callback_data: 'set_set_ai_betType_mixed' }],
        [{ text: '« Back to AI Settings', callback_data: 'set_ai' }]
    ];
    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendBuilderSettingsMenu(bot, chatId, messageId) {
  const config = await getBuilderConfig(chatId);
  const text = `<b>✍️ Custom Builder Settings</b>\n\nConfigure the rules for the manual \`/custom\` parlay builder.`;
  const keyboard = [
    [{ text: `Odds Range: ${config.minOdds} to ${config.maxOdds}`, callback_data: 'set_bldodds' }],
    [{ text: `Time Cutoff: ${config.cutoffHours} hours`, callback_data: 'set_bldcutoff' }],
    [{ text: `Avoid Same-Game Legs: ${config.avoidSameGame ? '✅ Yes' : '❌ No'}`, callback_data: 'set_set_builder_avoidSameGame_toggle' }],
    [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

async function sendBuilderOddsMenu(bot, chatId, messageId) {
    const config = await getBuilderConfig(chatId);
    const text = `<b>Set Odds Range</b>\n\nCurrent: ${config.minOdds} to ${config.maxOdds}\n\nSelect a minimum and maximum odds value for legs.`;
    const keyboard = [
        [{ text: 'Min Odds: -500', callback_data: 'set_set_builder_minOdds_-500' }, { text: 'Max Odds: +500', callback_data: 'set_set_builder_maxOdds_500' }],
        [{ text: 'Min Odds: -200', callback_data: 'set_set_builder_minOdds_-200' }, { text: 'Max Odds: +200', callback_data: 'set_set_builder_maxOdds_200' }],
        [{ text: 'Min Odds: +100', callback_data: 'set_set_builder_minOdds_100' }, { text: 'Max Odds: +1000', callback_data: 'set_set_builder_maxOdds_1000' }],
        [{ text: '« Back to Builder Settings', callback_data: 'set_builder' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
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
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendQuantHelpMenu(bot, chatId, messageId) {
    const text = `<b>❔ Pro Quant Mode Explained</b>\n\nThis mode enables advanced quantitative analysis for more sophisticated betting strategies:\n\n` +
      `<b>No-Vig Per-Leg Edges:</b> Calculates "true" odds by removing the bookmaker's commission (vig).\n\n` +
      `<b>CLV Gating:</b> Stands for Closing Line Value. Ensures odds are better than the final odds before the game starts.\n\n` +
      `<b>Correlation Caps:</b> Reduces risk by avoiding too many related bets in the same parlay.\n\n` +
      `<b>Parlay Safety Margin:</b> A conservative adjustment to account for unpredictable factors.\n\n` +
      `<b>Calibrated Probability:</b> Adjusts the AI's confidence to be more realistic.\n\n` +
      `<b>Ranking by Calibrated EV & Kelly Criterion:</b> Ranks parlays by their calibrated Expected Value (EV) and recommends optimal bet size.`;

    const keyboard = [[{ text: '« Back to AI Settings', callback_data: 'set_ai' }]];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}
