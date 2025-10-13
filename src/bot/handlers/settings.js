// src/bot/handlers/settings.js - UPGRADED WITH BOOKMAKER SELECTION
import { getAIConfig, setAIConfig, getBuilderConfig, setBuilderConfig } from '../state.js';
import { safeEditMessage } from '../../bot.js';

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

    if (action === 'main') return sendMainMenu(bot, chatId, messageId);
    if (action === 'ai') return sendAiSettingsMenu(bot, chatId, messageId);
    if (action === 'builder') return sendBuilderSettingsMenu(bot, chatId, messageId);
    if (action === 'quant_help') return sendQuantHelpMenu(bot, chatId, messageId);
    if (action === 'bookmakers') return sendBookmakerMenu(bot, chatId, messageId);

    if (action === 'set') {
      const [,,, category, key, value] = parts;
      const config = category === 'ai' ? await getAIConfig(chatId) : await getBuilderConfig(chatId);
      const setConfigFunc = category === 'ai' ? setAIConfig : setBuilderConfig;

      if (key === 'bookmakers') {
        const currentBooks = new Set(config.bookmakers || []);
        if (currentBooks.has(value)) {
          currentBooks.delete(value);
        } else {
          currentBooks.add(value);
        }
        config.bookmakers = Array.from(currentBooks);
        await setConfigFunc(chatId, config);
        return sendBookmakerMenu(bot, chatId, messageId);
      }

      const numericValue = isNaN(value) ? value : Number(value);
      if (value === 'toggle') {
        config[key] = !config[key];
      } else {
        if (config[key] === numericValue) return;
        config[key] = numericValue;
      }
      await setConfigFunc(chatId, config);

      if (category === 'ai') return sendAiSettingsMenu(bot, chatId, messageId);
      if (category === 'builder') return sendBuilderSettingsMenu(bot, chatId, messageId);
    }
  });
}

async function sendMainMenu(bot, chatId, messageId = null) {
  const text = '⚙️ <b>Bot Settings</b>\n\nChoose a category to configure:';
  const keyboard = [
    [{ text: '🤖 AI Analyst Settings', callback_data: 'set_ai' }],
    [{ text: '✍️ Custom Builder Settings', callback_data: 'set_builder' }],
    [{ text: '📚 Preferred Sportsbooks', callback_data: 'set_bookmakers' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  if (messageId) await safeEditMessage(chatId, messageId, text, opts);
  else await bot.sendMessage(chatId, text, opts);
}

async function sendBookmakerMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const selectedBooks = new Set(config.bookmakers || []);
    const text = `<b>📚 Preferred Sportsbooks</b>\n\nSelect the bookmakers you use. The bot will prioritize these when fetching odds.`;
    const keyboard = [
        [{ text: `${selectedBooks.has('draftkings') ? '✅' : '☑️'} DraftKings`, callback_data: 'set_set_ai_bookmakers_draftkings' }],
        [{ text: `${selectedBooks.has('fanduel') ? '✅' : '☑️'} FanDuel`, callback_data: 'set_set_ai_bookmakers_fanduel' }],
        [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendAiSettingsMenu(bot, chatId, messageId) {
    const config = await getAIConfig(chatId);
    const text = `<b>🤖 AI Analyst Settings</b>\n\nSet your default preferences for the \`/ai\` command.`;
    const keyboard = [
      [{ text: `Default Mode: ${config.mode || 'Web Research'}`, callback_data: 'set_aimode' }],
      [{ text: `Default Bet Type: ${config.betType || 'Mixed'}`, callback_data: 'set_aibettype' }],
      [{ text: `Pro Quant Mode: ${config.proQuantMode ? '✅ On' : '❌ Off'}`, callback_data: 'set_set_ai_proQuantMode_toggle' }],
      [{ text: '❔ What is Pro Quant Mode?', callback_data: 'set_quant_help' }],
      [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendBuilderSettingsMenu(bot, chatId, messageId) {
  const config = await getBuilderConfig(chatId);
  const text = `<b>✍️ Custom Builder Settings</b>\n\nConfigure the rules for the manual \`/custom\` parlay builder.`;
  const keyboard = [
    [{ text: `Avoid Same-Game Legs: ${config.avoidSameGame ? '✅ Yes' : '❌ No'}`, callback_data: 'set_set_builder_avoidSameGame_toggle' }],
    [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
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

// These functions are included for completeness but are not modified in this step.
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
