// src/bot.js – THE DEFINITIVE & COMPLETE SCRIPT WITH ALL FEATURES (fixed)

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import crypto from 'crypto';
import env, { isProduction } from './config/env.js';
import sentryService from './services/sentryService.js';
import GamesDataService from './services/gamesService.js';
import EnterpriseHealthService from './services/healthService.js';
import redis from './services/redisService.js';
import AIService from './services/aiService.js';

const app = express();
app.use(express.json());

// --- Health Check & Webhook Setup ---
const healthService = new EnterpriseHealthService(app);
healthService.initializeHealthCheckEndpoints();

// Create bot with polling in dev only (avoid double start)
const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: !isProduction });

if (isProduction) {
  const webhookUrl = `${env.APP_URL}/api/webhook/${env.TELEGRAM_BOT_TOKEN}`;
  bot
    .setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook set`))
    .catch((err) => console.error('❌ Failed to set webhook:', err));
  app.post(`/api/webhook/${env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
    try {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.error('Webhook processUpdate error:', err);
      res.sendStatus(500);
    }
  });
} else {
  // Ensure webhook is removed; polling was enabled in constructor
  bot
    .deleteWebHook()
    .then(() => console.log('🤖 Bot is running in local development mode (polling)...'))
    .catch((err) => console.error('❌ Local webhook delete error:', err));
}

// --- Setup Persistent Quick Access Menu ---
bot.setMyCommands([
  { command: '/parlay', description: '✨ AI Analyst Parlay' },
  { command: '/quant', description: '⚡️ Quick Quant Picks' },
  { command: '/player', description: '🤵 Parlay by Player' },
  { command: '/custom', description: '✍️ Build Your Own Parlay' },
]);

// --- State Management ---
const getAIConfig = async (chatId) => {
  const configStr = await redis.get(`ai_config:${chatId}`);
  return configStr ? JSON.parse(configStr) : { legs: 3, strategy: 'balanced', includeProps: true };
};
const setAIConfig = async (chatId, config) => {
  await redis.set(`ai_config:${chatId}`, JSON.stringify(config), 'EX', 600);
};
const getParlaySlip = async (chatId) => {
  const slipStr = await redis.get(`parlay_slip:${chatId}`);
  return slipStr ? JSON.parse(slipStr) : { picks: [], messageId: null, totalOdds: 0 };
};
const setParlaySlip = async (chatId, slip) => {
  await redis.set(`parlay_slip:${chatId}`, JSON.stringify(slip), 'EX', 7200);
};
const setUserState = async (chatId, state, expiry = 300) => {
  await redis.set(`user_state:${chatId}`, state, 'EX', expiry);
};
const getUserState = async (chatId) => {
  return await redis.get(`user_state:${chatId}`);
};

// --- Callback Token Helpers (keeps callback_data under 64 bytes) ---
const saveCallbackPayload = async (namespace, payload, ttlSec = 600) => {
  const token = crypto.randomBytes(9).toString('base64url'); // ~12 chars
  const key = `cb:${namespace}:${token}`;
  await redis.set(key, JSON.stringify(payload), 'EX', ttlSec);
  return token;
};
const loadCallbackPayload = async (namespace, token, del = true) => {
  const key = `cb:${namespace}:${token}`;
  const raw = await redis.get(key);
  if (del) await redis.del(key);
  return raw ? JSON.parse(raw) : null;
};

// --- UTILITY FUNCTIONS ---
const formatGameTime = (isoString) =>
  new Date(isoString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
const getSportEmoji = (sportKey) => {
  if (sportKey.includes('americanfootball')) return '🏈';
  if (sportKey.includes('basketball')) return '🏀';
  if (sportKey.includes('baseball')) return '⚾';
  if (sportKey.includes('icehockey')) return '🏒';
  if (sportKey.includes('soccer')) return '⚽';
  return '🏆';
};
const toDecimalFromAmerican = (american) =>
  american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
const toAmericanFromDecimal = (decimal) =>
  decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);

// --- METHOD 1: AI Analyst (`/parlay`) ---
const sendAIConfigurationMenu = async (chatId, messageId = null) => {
  const config = await getAIConfig(chatId);
  const text = `*✨ AI Analyst Parlay*\n\nConfigure the AI's parameters and let it build a deeply researched parlay for you.`;
  const keyboard = [
    [
      { text: `Legs: ${config.legs}`, callback_data: `config_legs_menu` },
      { text: `Strategy: ${config.strategy}`, callback_data: 'config_strategy_menu' },
    ],
    [{ text: `Player Props: ${config.includeProps ? '✅ Yes' : '❌ No'}`, callback_data: 'config_props_toggle' }],
    [{ text: '🤖 Build My Parlay', callback_data: 'config_build' }],
  ];
  const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  try {
    if (messageId) await bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
    else await bot.sendMessage(chatId, text, options);
  } catch (error) {
    try {
      await bot.sendMessage(chatId, text, options);
    } catch (_) {}
  }
};

const sendAILegsMenu = async (chatId, messageId) => {
  const legs = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const rows = [];
  for (let i = 0; i < legs.length; i += 3) {
    rows.push(
      legs.slice(i, i + 3).map((n) => ({
        text: `${n} legs`,
        callback_data: `config_legs_set_${n}`,
      }))
    );
  }
  rows.push([{ text: '« Back', callback_data: 'config_main' }]);
  await bot.editMessageText('*Select number of legs:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
};

const sendAIStrategyMenu = async (chatId, messageId) => {
  const strategies = [
    { key: 'conservative', label: 'Conservative' },
    { key: 'balanced', label: 'Balanced' },
    { key: 'aggressive', label: 'Aggressive' },
  ];
  const rows = [strategies.map((s) => ({ text: s.label, callback_data: `config_strategy_set_${s.key}` }))];
  rows.push([{ text: '« Back', callback_data: 'config_main' }]);
  await bot.editMessageText('*Select strategy:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
};

const handleAIBuildRequest = async (chatId, config, messageId) => {
  await bot.editMessageText('🤖 Accessing real-time market data and running deep quantitative analysis...', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: null,
  });
  try {
    const popularLeagues = ['americanfootball_nfl', 'basketball_nba', 'soccer_epl', 'icehockey_nhl'];
    const promises = popularLeagues.map((key) => GamesDataService.getGamesForSport(key));
    const results = await Promise.allSettled(promises);
    const availableGames = results
      .filter((res) => res.status === 'fulfilled' && res.value?.length > 0)
      .flatMap((res) => res.value);

    if (availableGames.length < config.legs) {
      await bot.sendMessage(
        chatId,
        `There aren't enough upcoming games to build a ${config.legs}-leg parlay right now.`
      );
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (_) {}
      return;
    }

    const result = await AIService.buildAIParlay(config, availableGames);
    const { parlay } = result;

    // Odds aggregation
    const totalDecimalOdds = parlay.legs.reduce((acc, leg) => acc * toDecimalFromAmerican(leg.odds), 1);
    const totalAmericanOdds = toAmericanFromDecimal(totalDecimalOdds);
    parlay.total_odds = Math.round(totalAmericanOdds);

    let messageText = `📈 *${parlay.title || 'AI-Generated Parlay'}*\n\n_${parlay.overall_narrative}_\n\n`;
    parlay.legs.forEach((leg) => {
      const signOdds = leg.odds > 0 ? `+${leg.odds}` : `${leg.odds}`;
      const conf = Math.max(0, Math.min(5, Math.round(leg.confidence_score / 2)));
      messageText += `*Leg ${leg.leg_number}*: ${leg.sport} — ${leg.game}\n*Pick*: *${leg.selection} (${signOdds})*\n*Confidence*: ${'🟢'.repeat(conf)}${'⚪'.repeat(5 - conf)}\n*Justification*: _${leg.justification}_\n\n`;
    });
    messageText += `*Total Odds*: *${parlay.total_odds > 0 ? '+' : ''}${parlay.total_odds}*`;

    await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  } catch (error) {
    sentryService.captureError(error, { component: 'ai_build_request' });
    await bot.sendMessage(chatId, `🚨 AI analysis failed.\n\n_Error: ${error.message}_`);
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  }
};

// --- METHOD 2: Quant Picks (`/quant`) ---
const sendQuantPickSelection = async (chatId) => {
  const games = await GamesDataService.getGamesForSport('americanfootball_nfl');
  if (!games || games.length < 3) {
    return bot.sendMessage(chatId, 'Not enough game data to run quant analysis. Try again later.');
  }

  // Find most negative moneyline (heaviest favorite)
  let heaviestFavorite = {
    price: Infinity, // we want the minimum price (most negative)
    name: 'N/A',
    game: { away_team: 'N/A', home_team: 'N/A' },
  };

  games.forEach((game) => {
    const market = game.bookmakers?.[0]?.markets?.find((m) => m.key === 'h2h');
    if (!market) return;
    market.outcomes?.forEach((outcome) => {
      if (typeof outcome.price === 'number' && outcome.price < heaviestFavorite.price) {
        heaviestFavorite = { price: outcome.price, name: outcome.name, game };
      }
    });
  });

  const message = `⚡️ *Today's Top Quant Pick*\n\nBased on current market data, the heaviest moneyline favorite is:\n\n- *${heaviestFavorite.name} ML* (${heaviestFavorite.price})\n   _${heaviestFavorite.game.away_team} @ ${heaviestFavorite.game.home_team}_`;
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
};

// --- METHOD 3: Parlay by Player (`/player`) ---
const handlePlayerSearch = async (chatId, playerName) => {
  const waitingMessage = await bot.sendMessage(
    chatId,
    `🔍 Searching for all available prop bets for *${playerName}*...`,
    { parse_mode: 'Markdown' }
  );
  try {
    const result = await AIService.findPlayerProps(playerName);
    if (!result.props || result.props.length === 0) {
      return bot.editMessageText(
        `No prop bets found for *${playerName}*. They may not have an upcoming game or lines have not been posted.`,
        { chat_id: chatId, message_id: waitingMessage.message_id, parse_mode: 'Markdown' }
      );
    }

    // Cache the props list for safe, short callbacks
    const cacheKey = `player_props:${chatId}`;
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);

    let text = `*Available Props for ${result.player_name}*\n_Game: ${result.game}_\n\nSelect props to add to your parlay slip:`;
    const keyboard = result.props.map((prop, idx) => [
      { text: `${prop.selection} (${prop.odds})`, callback_data: `pp_${idx}` },
    ]);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: waitingMessage.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (error) {
    await bot.editMessageText(`Could not find player props. Error: ${error.message}`, {
      chat_id: chatId,
      message_id: waitingMessage.message_id,
    });
  }
};

// --- METHOD 4: Manual Builder (`/custom`) ---
const sendCustomSportSelection = async (chatId) => {
  const sports = await GamesDataService.getAvailableSports();
  if (!sports || sports.length === 0) {
    return bot.sendMessage(chatId, 'No upcoming games found in the database.');
  }
  const keyboard = sports.map((sport) => [
    { text: `${getSportEmoji(sport.sport_key)} ${sport.sport_title}`, callback_data: `cs_${sport.sport_key}` },
  ]);
  await bot.sendMessage(chatId, '✍️ *Manual Parlay Builder*\n\nSelect a sport:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
};

const sendCustomGameSelection = async (chatId, sportKey, messageId) => {
  const games = await GamesDataService.getGamesForSport(sportKey);
  if (!games || games.length === 0)
    return bot.editMessageText('No upcoming games found for this sport.', {
      chat_id: chatId,
      message_id: messageId,
    });
  const keyboard = games.slice(0, 8).map((game) => [
    { text: `${game.away_team} @ ${game.home_team}`, callback_data: `cg_${game.id}` },
  ]);
  keyboard.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);
  await bot.editMessageText('Select a game to add:', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
};

const sendMarketSelection = async (chatId, gameId, messageId) => {
  const game = await GamesDataService.getGameDetails(gameId);
  if (!game || !game.bookmakers || game.bookmakers.length === 0)
    return bot.editMessageText('Could not find market data.', { chat_id: chatId, message_id: messageId });

  const availableMarkets = game.bookmakers[0].markets.map((market) => market.key);
  const keyboardRow = [];
  if (availableMarkets.includes('h2h')) keyboardRow.push({ text: 'Moneyline', callback_data: `cm_${game.id}_h2h` });
  if (availableMarkets.includes('spreads')) keyboardRow.push({ text: 'Spreads', callback_data: `cm_${game.id}_spreads` });
  if (availableMarkets.includes('totals')) keyboardRow.push({ text: 'Totals', callback_data: `cm_${game.id}_totals` });

  const keyboard = [keyboardRow, [{ text: '« Back to Games', callback_data: `cback_games_${game.sport_key}` }]];
  await bot.editMessageText(
    `*${game.away_team} @ ${game.home_team}*\n${formatGameTime(game.commence_time)}\n\nSelect a market:`,
    { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } }
  );
};

const sendPickSelection = async (chatId, gameId, marketKey, messageId) => {
  const game = await GamesDataService.getGameDetails(gameId);
  const market = game?.bookmakers?.[0]?.markets?.find((m) => m.key === marketKey);
  if (!market)
    return bot.editMessageText('Market not available.', { chat_id: chatId, message_id: messageId });

  // Use compact callback tokens for each selection
  const keyboard = [];
  for (const outcome of market.outcomes || []) {
    const pointText = outcome.point ? (outcome.point > 0 ? `+${outcome.point}` : outcome.point) : '';
    const priceText = outcome.price > 0 ? `+${outcome.price}` : outcome.price;
    const token = await saveCallbackPayload('cp', {
      gameId: game.id,
      marketKey,
      name: outcome.name,
      point: outcome.point ?? 0,
      price: outcome.price,
    });
    keyboard.push([{ text: `${outcome.name} ${pointText} (${priceText})`, callback_data: `cp_${token}` }]);
  }
  keyboard.push([{ text: '« Back to Markets', callback_data: `cg_${game.id}` }]);
  await bot.editMessageText(`Select your pick for *${marketKey}*:`, {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
};

const renderParlaySlip = async (chatId) => {
  const slip = await getParlaySlip(chatId);
  if (!slip.messageId) {
    const sentMessage = await bot.sendMessage(chatId, 'Initializing your parlay slip...');
    slip.messageId = sentMessage.message_id;
  }
  if (slip.picks.length === 0) {
    try {
      await bot.editMessageText('Your parlay slip is empty. Select a sport to add a leg.', {
        chat_id: chatId,
        message_id: slip.messageId,
      });
    } catch (_) {}
    try {
      await bot.deleteMessage(chatId, slip.messageId);
    } catch (_) {}
    await setParlaySlip(chatId, { picks: [], messageId: null, totalOdds: 0 });
    return sendCustomSportSelection(chatId);
  }

  let slipText = '✍️ *Your Custom Parlay*\n\n';
  let totalDecimal = 1;
  slip.picks.forEach((pick, index) => {
    const dec = toDecimalFromAmerican(pick.odds);
    totalDecimal *= dec;
    slipText += `*${index + 1}*: ${pick.selection} (${pick.odds > 0 ? '+' : ''}${pick.odds})\n   _${pick.game}_\n`;
  });
  const finalAmerican = Math.round(toAmericanFromDecimal(totalDecimal));
  slip.totalOdds = finalAmerican;
  slipText += `\n*Total Legs*: ${slip.picks.length}\n*Total Odds*: ≈ ${slip.totalOdds > 0 ? '+' : ''}${slip.totalOdds}`;

  const keyboard = [
    [{ text: '➕ Add Another Leg', callback_data: 'cslip_add' }],
    [{ text: `🗑️ Clear Slip (${slip.picks.length})`, callback_data: 'cslip_clear' }],
  ];
  await bot.editMessageText(slipText, {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: slip.messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
  await setParlaySlip(chatId, slip);
};

// --- Bot Command & Message Handlers ---
bot.onText(/\/parlay/, (msg) => sendAIConfigurationMenu(msg.chat.id));
bot.onText(/\/quant/, (msg) => sendQuantPickSelection(msg.chat.id));
bot.onText(/\/custom/, (msg) => sendCustomSportSelection(msg.chat.id));
bot.onText(/\/player/, async (msg) => {
  await setUserState(msg.chat.id, 'awaiting_player_name');
  await bot.sendMessage(msg.chat.id, '🤵 Which player is needed?');
});

bot.on('message', async (msg) => {
  // Ignore commands and non-text messages
  if (!msg.text || msg.text.startsWith('/')) return;
  const state = await getUserState(msg.chat.id);
  if (state === 'awaiting_player_name') {
    await setUserState(msg.chat.id, 'none'); // Clear state
    await handlePlayerSearch(msg.chat.id, msg.text.trim());
  }
});

bot.on('callback_query', async (cbq) => {
  const { data, message } = cbq;
  const chatId = message.chat.id;
  try {
    await bot.answerCallbackQuery(cbq.id);
  } catch (_) {}

  try {
    if (data.startsWith('config_')) {
      const config = await getAIConfig(chatId);

      if (data === 'config_legs_menu') {
        return sendAILegsMenu(chatId, message.message_id);
      }
      if (data === 'config_strategy_menu') {
        return sendAIStrategyMenu(chatId, message.message_id);
      }
      if (data.startsWith('config_legs_set_')) {
        const n = parseInt(data.split('_').pop(), 10);
        if (Number.isFinite(n) && n >= 2 && n <= 20) config.legs = n;
        await setAIConfig(chatId, config);
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
      if (data.startsWith('config_strategy_set_')) {
        const strategy = data.split('_').slice(3).join('_'); // in case of underscores
        if (['conservative', 'balanced', 'aggressive'].includes(strategy)) config.strategy = strategy;
        await setAIConfig(chatId, config);
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
      if (data === 'config_props_toggle') {
        config.includeProps = !config.includeProps;
        await setAIConfig(chatId, config);
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
      if (data === 'config_build') {
        return handleAIBuildRequest(chatId, config, message.message_id);
      }
      if (data === 'config_main') {
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
    } else if (data.startsWith('cback_sports')) {
      await bot.deleteMessage(chatId, message.message_id);
      await sendCustomSportSelection(chatId);
    } else if (data.startsWith('cback_games_')) {
      const sportKey = data.substring('cback_games_'.length);
      await sendCustomGameSelection(chatId, sportKey, message.message_id);
    } else if (data.startsWith('cs_')) {
      await sendCustomGameSelection(chatId, data.substring(3), message.message_id);
    } else if (data.startsWith('cg_')) {
      await sendMarketSelection(chatId, data.substring(3), message.message_id);
    } else if (data.startsWith('cm_')) {
      const parts = data.split('_');
      const gameId = parts[1];
      const marketKey = parts.slice(2).join('_'); // robust if underscores appear
      await sendPickSelection(chatId, gameId, marketKey, message.message_id);
    } else if (data.startsWith('cp_')) {
      // Compact pick via token
      const token = data.substring(3);
      const payload = await loadCallbackPayload('cp', token);
      if (!payload) return;
      const { gameId, marketKey, name, point, price } = payload;
      const slip = await getParlaySlip(chatId);
      const game = await GamesDataService.getGameDetails(gameId);
      const pointText = parseFloat(point) !== 0 ? (parseFloat(point) > 0 ? `+${point}` : `${point}`) : '';
      slip.picks.push({
        game: `${game.away_team} @ ${game.home_team}`,
        selection: `${name} ${pointText}`.trim(),
        odds: parseInt(price, 10),
      });
      try {
        await bot.deleteMessage(chatId, message.message_id);
      } catch (_) {}
      await renderParlaySlip(chatId);
    } else if (data.startsWith('cslip_')) {
      const action = data.substring(6);
      const slip = await getParlaySlip(chatId);
      if (action === 'add') {
        try {
          if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId);
        } catch (_) {}
        await setParlaySlip(chatId, { picks: slip.picks, messageId: null, totalOdds: slip.totalOdds || 0 });
        await sendCustomSportSelection(chatId);
      } else if (action === 'clear') {
        try {
          if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId);
        } catch (_) {}
        await setParlaySlip(chatId, { picks: [], messageId: null, totalOdds: 0 });
        await bot.sendMessage(chatId, 'Parlay slip cleared.');
      }
    } else if (data.startsWith('pp_')) {
      // Player Prop Pick via index in cached props
      const idx = parseInt(data.substring(3), 10);
      const raw = await redis.get(`player_props:${chatId}`);
      if (!raw) return;
      const result = JSON.parse(raw);
      const chosen = result.props[idx];
      if (!chosen) return;
      const slip = await getParlaySlip(chatId);
      slip.picks.push({ game: result.game, selection: chosen.selection, odds: parseInt(chosen.odds, 10) });
      try {
        await bot.deleteMessage(chatId, message.message_id);
      } catch (_) {}
      await renderParlaySlip(chatId);
    }
  } catch (err) {
    sentryService.captureError(err, { component: 'callback_query', data });
  }
});

// --- Error Handling & Server Start ---
process.on('unhandledRejection', (reason) => {
  sentryService.captureError(new Error('Unhandled Rejection'), { extra: { reason } });
});
process.on('uncaughtException', (error) => {
  sentryService.captureError(error, { component: 'uncaught_exception' });
  process.exit(1);
});

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));
