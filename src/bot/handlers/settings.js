// src/bot/handlers/settings.js
import { getBuilderConfig, setBuilderConfig } from '../state.js';

export function registerSettings(bot) {
  bot.onText(/\/settings/, async (msg) => sendBuilderSettings(bot, msg.chat.id));
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message) return;
    const chatId = message.chat.id;

    try { await bot.answerCallbackQuery(cbq.id); } catch {}

    if (data === 'b_settings') return sendBuilderSettings(bot, chatId, message.message_id);
    if (data === 'bs_f_menu') return sendFilterMenu(bot, chatId, message.message_id);

    if (data.startsWith('bs_f_set_')) {
      const v = parseInt(data.split('_').pop(), 10);
      const b = await getBuilderConfig(chatId);
      b.cutoffHours = Number.isFinite(v) ? v : b.cutoffHours;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(bot, chatId, message.message_id);
    }

    if (data === 'bs_sgp_tgl') {
      const b = await getBuilderConfig(chatId);
      b.avoidSameGame = !b.avoidSameGame;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(bot, chatId, message.message_id);
    }

    if (data === 'bs_odds_menu') return sendOddsMenu(bot, chatId, message.message_id);

    if (data.startsWith('bs_omin_')) {
      const v = parseInt(data.split('_').pop(), 10);
      const b = await getBuilderConfig(chatId);
      b.minOdds = Number.isFinite(v) ? v : b.minOdds;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(bot, chatId, message.message_id);
    }

    if (data.startsWith('bs_omax_')) {
      const v = parseInt(data.split('_').pop(), 10);
      const b = await getBuilderConfig(chatId);
      b.maxOdds = Number.isFinite(v) ? v : b.maxOdds;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(bot, chatId, message.message_id);
    }
  });
}

async function sendBuilderSettings(bot, chatId, messageId = null) {
  const b = await getBuilderConfig(chatId);
  const text =
    `*⚙️ Builder Settings*\n\n` +
    `• Filter: ${b.cutoffHours === 0 ? 'All' : `${b.cutoffHours}h`}\n` +
    `• Avoid Same Game: ${b.avoidSameGame ? '✅' : '❌'}\n` +
    `• Odds Range: ${b.minOdds} to ${b.maxOdds}\n` +
    `• Exclusions: ${b.excludedTeams.length ? b.excludedTeams.join(', ') : 'None'}`;

  const rows = [
    [{ text: `Filter: ${b.cutoffHours === 0 ? 'All' : `${b.cutoffHours}h`}`, callback_data: 'bs_f_menu' }, { text: `SGP Avoid: ${b.avoidSameGame ? 'On' : 'Off'}`, callback_data: 'bs_sgp_tgl' }],
    [{ text: `Odds Range`, callback_data: 'bs_odds_menu' }],
    [{ text: '« Back', callback_data: 'cfg_main' }],
  ];

  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) return bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  return bot.sendMessage(chatId, text, opts);
}

async function sendFilterMenu(bot, chatId, messageId) {
  const rows = [
    [{ text: '6h', callback_data: 'bs_f_set_6' }, { text: '12h', callback_data: 'bs_f_set_12' }, { text: '24h', callback_data: 'bs_f_set_24' }],
    [{ text: '48h', callback_data: 'bs_f_set_48' }, { text: 'All', callback_data: 'bs_f_set_0' }],
    [{ text: '« Back', callback_data: 'b_settings' }],
  ];
  await bot.editMessageText('*Select game time filter:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendOddsMenu(bot, chatId, messageId) {
  const rows = [
    [{ text: 'Min: Any', callback_data: 'bs_omin_-2000' }, { text: 'Min: -500', callback_data: 'bs_omin_-500' }, { text: 'Min: -200', callback_data: 'bs_omin_-200' }],
    [{ text: 'Max: +1000', callback_data: 'bs_omax_1000' }, { text: 'Max: +500', callback_data: 'bs_omax_500' }, { text: 'Max: +300', callback_data: 'bs_omax_300' }],
    [{ text: '« Back', callback_data: 'b_settings' }],
  ];
  await bot.editMessageText('*Set acceptable odds range per leg:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
}
