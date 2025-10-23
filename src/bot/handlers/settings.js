// src/bot/handlers/settings.js - FIX FOR CHECKMARKS

import { getAIConfig, setAIConfig, getBuilderConfig, setBuilderConfig } from '../state.js';
import { safeEditMessage } from '../../bot.js'; // Ensure safeEditMessage is imported

// Helper to add checkmark
const check = (condition) => (condition ? '✅' : ''); // Use a simple checkmark or empty string

export function registerSettings(bot) {
  bot.onText(/^\/settings$/, async (msg) => {
    // Fetch configs *before* sending menu if needed immediately,
    // otherwise fetch within each specific menu function.
    await sendMainMenu(bot, msg.chat.id);
  });
}

export function registerSettingsCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('set_')) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    // Answer immediately
    await bot.answerCallbackQuery(cbq.id).catch(() => {}); // Catch potential "query is too old"

    const parts = data.split('_');
    const action = parts[1];

    // --- Navigation ---
    if (action === 'main') return sendMainMenu(bot, chatId, messageId);
    if (action === 'ai') return sendAiSettingsMenu(bot, chatId, messageId);
    if (action === 'builder') return sendBuilderSettingsMenu(bot, chatId, messageId);
    if (action === 'quant_help') return sendQuantHelpMenu(bot, chatId, messageId);
    if (action === 'bookmakers') return sendBookmakerMenu(bot, chatId, messageId);
    if (action === 'aimode') return sendAiModeMenu(bot, chatId, messageId);
    if (action === 'aibettype') return sendAiBetTypeMenu(bot, chatId, messageId);
    if (action === 'aihorizon') return sendAiHorizonMenu(bot, chatId, messageId);

    // --- Setting Values ---
    if (action === 'set') {
      // Destructure: set_set_<category>_<key>_<value>
      const [, , category, key, ...valueParts] = parts;
      const value = valueParts.join('_'); // Rejoin value if it contained underscores

      if (!category || !key || value === undefined) {
        console.error('Invalid settings callback data structure:', data);
        await safeEditMessage(chatId, messageId, '❌ Error: Invalid setting option.');
        return;
      }

      try {
        const isAI = category === 'ai';
        const getConfigFunc = isAI ? getAIConfig : getBuilderConfig;
        const setConfigFunc = isAI ? setAIConfig : setBuilderConfig;

        // Fetch current config FRESHLY before modifying
        let config = await getConfigFunc(chatId);

        if (key === 'bookmakers') {
          // Handle multi-select for bookmakers
          const currentBooks = new Set(config.bookmakers || []);
          if (value === 'clearall') { // Optional: Add a clear all button if needed
            currentBooks.clear();
          } else if (currentBooks.has(value)) {
            currentBooks.delete(value);
          } else {
            currentBooks.add(value);
          }
          config = { ...config, bookmakers: Array.from(currentBooks) }; // Create new object
          await setConfigFunc(chatId, { bookmakers: config.bookmakers }); // Only save the changed part
          console.log(`✅ Updated bookmakers: ${config.bookmakers.join(', ')}`);
          // Re-render the bookmaker menu to show changes
          return sendBookmakerMenu(bot, chatId, messageId);

        } else if (value === 'toggle') {
          // Handle boolean toggles
          const currentValue = config[key] || false; // Default to false if undefined
          const newValue = !currentValue;
          await setConfigFunc(chatId, { [key]: newValue }); // Save only the changed key
          console.log(`✅ Updated ${category} setting: ${key} = ${newValue}`);

        } else {
          // Handle specific value selection (numeric or string)
          const numericValue = isNaN(value) ? value : Number(value);
          if (config[key] === numericValue) {
            // No change needed, maybe answer callback differently?
             // console.log(`No change needed for ${key}`);
             // Re-render the menu anyway to ensure consistency, especially after potential errors
          } else {
              await setConfigFunc(chatId, { [key]: numericValue }); // Save only the changed key
              console.log(`✅ Updated ${category} setting: ${key} = ${numericValue}`);
          }
        }

        // Re-render the appropriate settings menu after saving
        if (isAI) return sendAiSettingsMenu(bot, chatId, messageId);
        else return sendBuilderSettingsMenu(bot, chatId, messageId);

      } catch (error) {
        console.error(`❌ Error processing setting callback ${data}:`, error);
        sentryService.captureError(error, { component: 'settings_handler', operation: `callback_${action}`, chatId, data });
        await safeEditMessage(chatId, messageId, '❌ Error saving setting. Please try again.');
      }
    }
  });
}

// --- Menu Rendering Functions (WITH CHECKMARKS ADDED) ---

async function sendMainMenu(bot, chatId, messageId = null) {
  // Main menu doesn't show specific settings, no change needed here
  const text = '⚙️ <b>Bot Settings</b>\n\nChoose a category to configure:';
  const keyboard = [
    [{ text: '🤖 AI Analyst Settings', callback_data: 'set_ai' }],
    [{ text: '✍️ Custom Builder Settings', callback_data: 'set_builder' }],
    // [{ text: '📚 Preferred Sportsbooks', callback_data: 'set_bookmakers' }] // Consider moving bookmakers under AI?
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  if (messageId) await safeEditMessage(chatId, messageId, text, opts);
  else await bot.sendMessage(chatId, text, opts);
}

// Example: sendAiSettingsMenu with checkmarks
async function sendAiSettingsMenu(bot, chatId, messageId) {
    // FETCH the config HERE, right before rendering
    const config = await getAIConfig(chatId);
    const text = `<b>🤖 AI Analyst Settings</b>\n\nSet your default preferences for the \`/ai\` command.`;

    // Use the 'check' helper function
    const keyboard = [
      [{ text: `Default Mode: ${config.mode || 'Web'}`, callback_data: 'set_aimode' }],
      [{ text: `Default Bet Type: ${config.betType || 'Mixed'}`, callback_data: 'set_aibettype' }],
      [{ text: `Game Horizon: ${config.horizonHours || 72} hours`, callback_data: 'set_aihorizon' }],
       // Correctly display toggle status
      [{ text: `Pro Quant Mode: ${config.proQuantMode ? '✅ On' : '❌ Off'}`, callback_data: 'set_set_ai_proQuantMode_toggle' }],
      [{ text: '❔ What is Pro Quant Mode?', callback_data: 'set_quant_help' }],
      [{ text: '📚 Preferred Sportsbooks', callback_data: 'set_bookmakers' }], // Added bookmakers here
      [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
    ];
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    await safeEditMessage(chatId, messageId, text, opts);
}

async function sendBuilderSettingsMenu(bot, chatId, messageId) {
  // FETCH the config HERE
  const config = await getBuilderConfig(chatId);
  const text = `<b>✍️ Custom Builder Settings</b>\n\nConfigure the rules for the manual \`/custom\` parlay builder.`;
  const keyboard = [
     // Correctly display toggle status
    [{ text: `Avoid Same-Game Legs: ${config.avoidSameGame ? '✅ Yes' : '❌ No'}`, callback_data: 'set_set_builder_avoidSameGame_toggle' }],
    // Add other builder settings here if they exist
    [{ text: '« Back to Main Menu', callback_data: 'set_main' }]
  ];
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeEditMessage(chatId, messageId, text, opts);
}

// --- Sub-menus need checkmarks too ---

async function sendAiModeMenu(bot, chatId, messageId) {
    // FETCH config
    const config = await getAIConfig(chatId);
    const text = 'Select your preferred default analysis mode for the AI:';
    const keyboard = [
        [{ text: `${check(config.mode === 'live')} 📡 Live API (Best)`, callback_data: 'set_set_ai_mode_live' }],
        [{ text: `${check(config.mode === 'web')} 🌐 Web Research`, callback_data: 'set_set_ai_mode_web' }],
        [{ text: `${check(config.mode === 'db')} 💾 Database Fallback`, callback_data: 'set_set_ai_mode_db' }],
        [{ text: '« Back', callback_data: 'set_ai' }] // Back to AI Settings
    ];
    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendAiBetTypeMenu(bot, chatId, messageId) {
    // FETCH config
    const config = await getAIConfig(chatId);
    const text = 'Select the default type of parlay the AI should build:';
    const keyboard = [
        // Example for props, adjust others similarly
        [{ text: `${check(config.betType === 'props')} 🔥 Player Props Only`, callback_data: 'set_set_ai_betType_props' }],
        [{ text: `${check(config.betType === 'mixed')} 🧩 Any Bet Type (Mixed)`, callback_data: 'set_set_ai_betType_mixed' }],
         [{ text: `${check(config.betType === 'moneyline')} 🎯 Moneyline`, callback_data: 'set_set_ai_betType_moneyline' }],
         [{ text: `${check(config.betType === 'spreads')} 📊 Spreads`, callback_data: 'set_set_ai_betType_spreads' }],
         [{ text: `${check(config.betType === 'totals')} 📈 Totals`, callback_data: 'set_set_ai_betType_totals' }],
        [{ text: '« Back', callback_data: 'set_ai' }] // Back to AI Settings
    ];
    // Simple layout adjustment if too many buttons
    const finalKeyboard = keyboard.reduce((acc, val, index) => {
        if (index % 2 === 0) acc.push([val[0]]); else acc[acc.length - 1].push(val[0]);
        return acc;
    }, []);
    finalKeyboard.push(keyboard[keyboard.length-1]); // Add back button row


    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: finalKeyboard } });
}

async function sendAiHorizonMenu(bot, chatId, messageId) {
    // FETCH config
    const config = await getAIConfig(chatId);
    const text = 'Select the time window for finding games (how far ahead the AI looks):';
    const keyboard = [
        [{ text: `${check(config.horizonHours === 24)} 24 Hours`, callback_data: 'set_set_ai_horizonHours_24' }],
        [{ text: `${check(config.horizonHours === 48)} 48 Hours`, callback_data: 'set_set_ai_horizonHours_48' }],
        [{ text: `${check(config.horizonHours === 72)} 72 Hours`, callback_data: 'set_set_ai_horizonHours_72' }],
        [{ text: '« Back', callback_data: 'set_ai' }] // Back to AI Settings
    ];
    await safeEditMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendBookmakerMenu(bot, chatId, messageId) {
    // FETCH config
    const config = await getAIConfig(chatId); // Bookmakers are stored in AI config
    const selectedBooks = new Set(config.bookmakers || []);
    const text = `<b>📚 Preferred Sportsbooks</b>\n\nSelect the bookmakers you use. The AI will try to use odds from these books when available.`;

    // Define available bookmakers and their callback values
    const availableBooks = [
        { name: 'DraftKings', key: 'draftkings' },
        { name: 'FanDuel', key: 'fanduel' },
        { name: 'BetMGM', key: 'betmgm' },
        { name: 'Caesars', key: 'caesars' },
        // Add more books here as needed
    ];

    const keyboardRows = availableBooks.map(book => ([
        {
            text: `${selectedBooks.has(book.key) ? '✅' : '☑️'} ${book.name}`,
            callback_data: `set_set_ai_bookmakers_${book.key}` // Correct callback format
        }
    ]));

    keyboardRows.push([{ text: '« Back', callback_data: 'set_ai' }]); // Back to AI Settings menu

    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } };
    await safeEditMessage(chatId, messageId, text, opts);
}


// sendQuantHelpMenu doesn't need changes as it's informational
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
