// src/bot/handlers/custom.js
import { getBuilderConfig, getUserState, setUserState, getParlaySlip, setParlaySlip, saveToken, loadToken } from '../state.js';
import { formatGameTimeTZ, toDecimalFromAmerican, toAmerican } from '../../utils/enterpriseUtilities.js';
import { getGames, getGame } from '../../services/advancedOddsModel.js'; // Adjust to real service if needed
import { getGames as getGamesCached, getGameDetails as getGameDetailsCached } from '../../services/oddsService.js';

const INLINE_BUT_LIMIT = 10;

export function registerCustom(bot) {
  bot.onText(/\/custom/, async ({ chat }) => {
    await sendSportSelection(bot, chat.id);
  });
}

export function registerCustomCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    if (!cbq.data) return;
    const chatId = cbq.message.chat.id;

    // Common prefix-routing for custom handlers
    if (cbq.data.startsWith('c')) {
      const action = cbq.data;
      await handleCustomCallback(bot, cbq, chatId, action);
    }
  });
}

async function sendSportSelection(bot, chatId, messageId) {
  const sports = await getBuilderConfig(chatId).then(cfg => cfg.sports || []);
  const allSports = await import('../../services/oddsService.js').then(mod => mod.getCachedSports()); // replace with your method

  const buttons = (allSports || []).slice(0, INLINE_BUT_LIMIT).map((sport) => {
    return [{ text: sport.sport_title, callback_data: `c_sport_${sport.sport_key}` }];
  });

  buttons.push([{ text: '🛠️ Settings', callback_data: 'settings' }]);
  buttons.push([{ text: '🏠 Main Menu', callback_data: 'menu_main' }]);

  const opts = {
    chat_id: chatId,
    reply_markup: { inline_keyboard: buttons },
    parse_mode: 'Markdown'
  };

  if (messageId) await bot.editMessageText('Select a sport for your custom parlay:', { ...opts, message_id: messageId });
  else await bot.sendMessage(chatId, 'Select a sport for your custom parlay:', opts);
}

async function handleCustomCallback(bot, cbq, chatId, data) {
  try {
    if (data.startsWith('c_sport_')) {
      const sportKey = data.split('_')[2];
      const games = await getGamesCached(sportKey);
      if (!games.length) return bot.answerCallbackQuery(cbq.id, { text: 'No upcoming games for this sport.' });
      await sendGameSelection(bot, chatId, sportKey, games, cbq.message.message_id);
    } else if (data.startsWith('c_game_')) {
      const gameId = data.split('_')[2];
      await sendMarketSelection(bot, chatId, gameId, cbq.message.message_id);
    } else if (data.startsWith('c_market_')) {
      const [ , , gameId, marketKey ] = data.split('_');
      await sendPickSelection(bot, chatId, gameId, marketKey, cbq.message.message_id);
    } else if (data.startsWith('c_pick_')) {
      const token = data.split('_')[2];
      await addPickToSlip(bot, chatId, token, cbq.message.message_id);
    } else if (data.startsWith('c_slip')) {
      // Handle slip actions like add, remove, clear, etc.
      await handleSlipAction(bot, chatId, data, cbq.message.message_id);
    } else {
      await bot.answerCallbackQuery(cbq.id, { text: 'Action not recognized.' });
    }
  } catch (e) {
    console.error('handleCustomCallback error:', e);
    await bot.answerCallbackQuery(cbq.id, { text: 'Failed to process action.' });
  }
}

async function sendGameSelection(bot, chatId, sportKey, games, messageId) {
  const buttons = games.slice(0, INLINE_BUT_LIMIT).map(g => [{ text: `${g.away_team} @ ${g.home_team}`, callback_data: `c_game_${g.id}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'c_back_sports' }]);
  await bot.editMessageText('Select a game:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
}

async function sendMarketSelection(bot, chatId, gameId, messageId) {
  const game = await getGameDetailsCached(gameId);
  if (!game) return bot.answerCallbackQuery(null, { text: 'Game not found or no market data.' });
  const markets = game.bookmakers?.[0]?.markets || [];
  const buttons = markets.map(m => [{ text: m.key.charAt(0).toUpperCase() + m.key.slice(1), callback_data: `c_market_${gameId}_${m.key}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: `c_game_back_${game.sport_key}` }]);
  await bot.editMessageText(`Select market on ${game.away_team} @ ${game.home_team}:`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
}

async function sendPickSelection(bot, chatId, gameId, marketKey, messageId) {
  const game = await getGameDetailsCached(gameId);
  const market = game.bookmakers?.[0]?.markets.find(m => m.key === marketKey);
  if (!market) return bot.answerCallbackQuery(null, { text: 'Market not found.' });

  const buttons = market.outcomes.map(outcome => {
    return [{
      text: `${outcome.name} (${outcome.point || ''} ${outcome.price > 0 ? '+' + outcome.price : outcome.price})`.trim(),
      callback_data: '' // will be set below
    }];
  });

  // Generate tokens and assign to buttons to keep callback_data short
  for (let i = 0; i < buttons.length; i++) {
    const outcome = market.outcomes[i];
    const token = await saveToken('custom_pick', {
      gameId, marketKey, name: outcome.name, point: outcome.point, price: outcome.price,
      gameLabel: `${game.away_team} @ ${game.home_team}`
    });
    buttons[i][0].callback_data = `c_pick_${token}`;
  }
  buttons.push([{ text: '🔙 Back', callback_data: `c_market_back_${gameId}` }]);
  await bot.editMessageText(`Choose pick from ${marketKey} market:`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
}

async function addPickToSlip(bot, chatId, token, messageId) {
  const pick = await loadToken('custom_pick', token);
  if (!pick) return;
  const cfg = await getBuilderConfig(chatId);
  const slip = await getParlaySlip(chatId);

  if (cfg.avoidGame && slip.picks.some(p => p.game === pick.gameLabel)) {
    await bot.answerCallbackQuery(null, { text: 'Avoiding multiple picks from one game. Change in settings.' });
    return;
  }
  if (pick.price < cfg.minOdds || pick.price > cfg.maxOdds) {
    await bot.answerCallbackQuery(null, { text: 'Pick outside odds range.' });
    return;
  }

  slip.picks.push({
    game: pick.gameLabel,
    selection: `${pick.name} ${pick.point || ''}`.trim(),
    odds: pick.price,
    marketKey: pick.marketKey,
    gameId: pick.gameId || null
  });
  await setParlaySlip(chatId, slip);
  try { await bot.deleteMessage(messageId.chat.id, messageId.message_id); } catch {}
  await renderSlip(bot, chatId);
}

async function handleSlipAction(bot, chatId, data, messageId) {
  const slip = await getParlaySlip(chatId);
  if (data === 'c_slip_add') {
    try { await bot.deleteMessage(chatId, messageId); } catch {}
    await sendSportSelection(bot, chatId);
  } else if (data === 'c_slip_clear') {
    slip.picks = [];
    await setParlaySlip(chatId, slip);
    await bot.editMessageText('Slip cleared.', { chat_id: chatId, message_id: messageId });
  } else if (data.startsWith('c_slip_remove_')) {
    const idx = parseInt(data.split('_').pop(), 10);
    if (!isNaN(idx) && slip.picks[idx]) {
      slip.picks.splice(idx, 1);
      await setParlaySlip(chatId, slip);
      await renderSlip(bot, chatId);
    }
  } else if (data === 'c_slip_refresh') {
    // refresh odds logic
    for (const p of slip.picks) {
      if (!p.gameId || !p.marketKey) continue;
      try {
        const game = await getGameDetailsCached(p.gameId);
        const market = game.bookmakers?.[0]?.markets.find(m => m.key === p.marketKey);
        const outcome = market?.outcomes.find(o => o.name === p.selection || o.name + (o.point ? ` ${o.point}` : '') === p.selection);
        if (outcome) p.odds = outcome.price;
      } catch {}
    }
    await setParlaySlip(chatId, slip);
    await renderSlip(bot, chatId);
  }
}

async function renderSlip(bot, chatId) {
  const slip = await getParlaySlip(chatId);
  if (!slip.picks.length) return bot.sendMessage(chatId, 'Slip empty. Add picks!');
  let totalOddsDec = 1;
  let grouped = {};
  for (const p of slip.picks) {
    grouped[p.game] = grouped[p.game] || { picks: [], time: null };
    grouped[p.game].picks.push(p);
  }
  for (const game in grouped) {
    const anyPick = grouped[game].picks[0];
    if (anyPick.gameId) {
      const gameDetails = await getGameDetailsCached(anyPick.gameId);
      grouped[game].time = gameDetails?.commence_time || null;
    }
  }
  for (const p of slip.picks) {
    totalOddsDec *= toDecimalFromAmerican(p.odds);
  }
  const totalOdds = toAmerican(totalOddsDec);
  let text = '*Your Parlay Slip:*\n\n';
  for (const [game, { picks, time }] of Object.entries(grouped)) {
    text += `*${game}* - ${time ? formatGameTimeTZ(time) : 'Time unknown'}\n`;
    for (const pick of picks) {
      text += `- ${pick.selection} (${pick.odds > 0 ? '+' : ''}${pick.odds})\n`;
    }
    text += '\n';
  }
  text += `*Total Odds:* ${totalOdds > 0 ? '+' : ''}${totalOdds}\n*Stake:* ${slip.stake || 10}\n`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}
