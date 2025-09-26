// src/bot/handlers/player.js
import {
  getBuilderConfig, getParlaySlip, setParlaySlip,
  setUserState, getUserState,
} from '../state.js';
import AIService from '../../services/aiService.js';
import redis from '../../services/redisService.js';

export function registerPlayer(bot) {
  bot.onText(/\/player/, async (msg) => {
    await setUserState(msg.chat.id, 'awaiting_player', 300);
    await bot.sendMessage(msg.chat.id, '🤵 Which player is needed?');
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const state = await getUserState(chatId);
    if (state !== 'awaiting_player') return;

    await setUserState(chatId, 'none', 1);
    const waiting = await bot.sendMessage(chatId, `🔍 Searching for all available prop bets for *${msg.text.trim()}*...`, { parse_mode: 'Markdown' });
    try {
      const result = await AIService.findPlayerProps(msg.text.trim());
      if (!result?.props?.length) {
        return bot.editMessageText(`No prop bets found for *${msg.text.trim()}*.`, {
          chat_id: chatId, message_id: waiting.message_id, parse_mode: 'Markdown'
        });
      }
      await redis.set(`player_props:${chatId}`, JSON.stringify(result), 'EX', 600);
      const rows = result.props.slice(0, 25).map((p, i) => [{ text: `${p.selection} (${p.odds})`, callback_data: `pp_${i}` }]);
      await bot.editMessageText(`*Available Props for ${result.player_name}*\n_Game: ${result.game}_\n\nSelect props to add to your parlay slip:`, {
        chat_id: chatId, message_id: waiting.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows }
      });
    } catch (e) {
      await bot.editMessageText(`Could not find player props. Error: ${e.message}`, {
        chat_id: chatId, message_id: waiting.message_id
      });
    }
  });

  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message) return;
    if (!data.startsWith('pp_')) return;

    const chatId = message.chat.id;
    try { await bot.answerCallbackQuery(cbq.id); } catch {}

    const idx = parseInt(data.substring(3), 10);
    const raw = await redis.get(`player_props:${chatId}`);
    if (!raw) return;
    const result = JSON.parse(raw);
    const chosen = result.props[idx];
    if (!chosen) return;

    const b = await getBuilderConfig(chatId);
    const slip = await getParlaySlip(chatId);

    if (b.avoidSameGame && slip.picks.some((p) => p.game === result.game)) {
      return bot.sendMessage(chatId, 'Avoiding same‑game legs (toggle in /settings).');
    }
    const price = parseInt(chosen.odds, 10);
    if (price < b.minOdds || price > b.maxOdds) {
      return bot.sendMessage(chatId, `Pick outside allowed odds range (${b.minOdds} to ${b.maxOdds}).`);
    }

    slip.picks.push({ game: result.game, selection: chosen.selection, odds: price, marketKey: 'prop', gameId: null, commence_time: null });
    await setParlaySlip(chatId, slip);
    try { await bot.deleteMessage(chatId, message.message_id); } catch {}
    const { renderParlaySlip } = await import('./custom.js');
    return renderParlaySlip(bot, chatId);
  });
}
