// src/bot.js – THE DEFINITIVE & COMPLETE SCRIPT WITH ALL FEATURES (max customization, no placeholders)

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

const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: !isProduction });

const WEBHOOK_PATH = `/api/webhook/${env.TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = isProduction ? `${env.APP_URL}${WEBHOOK_PATH}` : null;
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET || null;

if (isProduction) {
  bot
    .setWebHook(WEBHOOK_URL, WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined)
    .then(() => console.log(`✅ Webhook set`))
    .catch((err) => console.error('❌ Failed to set webhook:', err));
  app.post(WEBHOOK_PATH, (req, res) => {
    try {
      if (WEBHOOK_SECRET) {
        const header = req.get('x-telegram-bot-api-secret-token');
        if (!header || header !== WEBHOOK_SECRET) return res.sendStatus(401);
      }
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.error('Webhook processUpdate error:', err);
      res.sendStatus(500);
    }
  });
} else {
  bot
    .deleteWebHook()
    .then(() => console.log('🤖 Bot is running in local development mode (polling)...'))
    .catch((err) => console.error('❌ Local webhook delete error:', err));
}

// --- Commands (global) ---
bot.setMyCommands([
  { command: '/start', description: 'Welcome & Menu' },
  { command: '/parlay', description: '✨ AI Analyst Parlay' },
  { command: '/quant', description: '⚡️ Quick Quant Picks' },
  { command: '/player', description: '🤵 Parlay by Player' },
  { command: '/custom', description: '✍️ Manual Builder' },
  { command: '/settings', description: 'Builder & AI Settings' },
  { command: '/calc', description: 'Odds calculator' },
  { command: '/kelly', description: 'Kelly stake: /kelly <p> <odds>' },
  { command: '/stake', description: 'Set slip stake: /stake <amount>' },
  { command: '/help', description: 'How this bot works' },
  { command: '/exclusions', description: 'List team exclusions' },
  { command: '/exclude_team', description: 'Exclude team: /exclude_team <name>' },
  { command: '/clear_exclusions', description: 'Clear exclusions' },
]);

// --- State & Storage ---
const defaultAI = { legs: 3, strategy: 'balanced', includeProps: true };
const defaultBuilder = {
  filterHours: 0, // 0=All, 24, 48
  avoidSameGame: true,
  minOdds: -2000,
  maxOdds: 1000,
  excludedTeams: [],
};
const getAIConfig = async (chatId) => {
  const s = await redis.get(`ai_config:${chatId}`);
  return s ? JSON.parse(s) : { ...defaultAI };
};
const setAIConfig = async (chatId, cfg) => {
  await redis.set(`ai_config:${chatId}`, JSON.stringify(cfg), 'EX', 1200);
};
const getBuilderConfig = async (chatId) => {
  const s = await redis.get(`builder_config:${chatId}`);
  return s ? JSON.parse(s) : { ...defaultBuilder };
};
const setBuilderConfig = async (chatId, cfg) => {
  await redis.set(`builder_config:${chatId}`, JSON.stringify(cfg), 'EX', 86400);
};
const getParlaySlip = async (chatId) => {
  const s = await redis.get(`parlay_slip:${chatId}`);
  return s ? JSON.parse(s) : { picks: [], messageId: null, totalOdds: 0, stake: 10 };
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

// --- Rate Limiter ---
const hitRateLimit = async (chatId, bucket, limit = 8, windowSec = 10) => {
  const key = `rl:${bucket}:${chatId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n > limit;
};

// --- Compact Callback Tokens ---
const saveCallbackPayload = async (ns, payload, ttlSec = 600) => {
  const token = crypto.randomBytes(9).toString('base64url');
  await redis.set(`cb:${ns}:${token}`, JSON.stringify(payload), 'EX', ttlSec);
  return token;
};
const loadCallbackPayload = async (ns, token, del = true) => {
  const key = `cb:${ns}:${token}`;
  const raw = await redis.get(key);
  if (del) await redis.del(key);
  return raw ? JSON.parse(raw) : null;
};

// --- Utils ---
const formatGameTime = (iso) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
const getSportEmoji = (k) => {
  if (k.includes('americanfootball')) return '🏈';
  if (k.includes('basketball')) return '🏀';
  if (k.includes('baseball')) return '⚾';
  if (k.includes('icehockey')) return '🏒';
  if (k.includes('soccer')) return '⚽';
  return '🏆';
};
const toDecimalFromAmerican = (a) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
const toAmericanFromDecimal = (d) => (d >= 2 ? (d - 1) * 100 : -100 / (d - 1));
const impliedProbability = (d) => (d > 1 ? 1 / d : 0);
const withinOddsRange = (price, minA, maxA) => price >= minA && price <= maxA;
const sameGameConflict = (slip, gameStr) => slip.picks.some((p) => p.game === gameStr);
const filterByCommence = (games, hours) => {
  if (!hours || hours <= 0) return games;
  const now = Date.now();
  const horizon = now + hours * 3600 * 1000;
  return games.filter((g) => {
    const t = new Date(g.commence_time).getTime();
    return t <= horizon;
  });
};
const filterByExclusions = (games, excludeList) => {
  if (!excludeList?.length) return games;
  const lowered = excludeList.map((s) => s.toLowerCase());
  return games.filter((g) => {
    const a = g.away_team?.toLowerCase() || '';
    const h = g.home_team?.toLowerCase() || '';
    return !lowered.some((x) => a.includes(x) || h.includes(x));
  });
};

// --- AI Analyst (/parlay) ---
const sendAIConfigurationMenu = async (chatId, messageId = null) => {
  const config = await getAIConfig(chatId);
  const text =
    `*✨ AI Analyst Parlay*\n\n` +
    `Configure the AI's parameters and let it build a deeply researched parlay for you.`;
  const keyboard = [
    [
      { text: `Legs: ${config.legs}`, callback_data: `cfg_l_menu` },
      { text: `Strategy: ${config.strategy}`, callback_data: 'cfg_s_menu' },
    ],
    [{ text: `Player Props: ${config.includeProps ? '✅ Yes' : '❌ No'}`, callback_data: 'cfg_p_tgl' }],
    [{ text: '🤖 Build My Parlay', callback_data: 'cfg_build' }],
    [{ text: '⚙️ Builder Settings', callback_data: 'b_settings' }],
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
  try {
    if (messageId) await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
    else await bot.sendMessage(chatId, text, opts);
  } catch {
    try {
      await bot.sendMessage(chatId, text, opts);
    } catch {}
  }
};
const sendAILegsMenu = async (chatId, messageId) => {
  const legs = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const rows = [];
  for (let i = 0; i < legs.length; i += 3) {
    rows.push(legs.slice(i, i + 3).map((n) => ({ text: `${n} legs`, callback_data: `cfg_l_set_${n}` })));
  }
  rows.push([{ text: '« Back', callback_data: 'cfg_main' }]);
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
  const rows = [strategies.map((s) => ({ text: s.label, callback_data: `cfg_s_set_${s.key}` }))];
  rows.push([{ text: '« Back', callback_data: 'cfg_main' }]);
  await bot.editMessageText('*Select strategy:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
};
const handleAIBuildRequest = async (chatId, config, messageId) => {
  try {
    await bot.editMessageText(
      '🤖 Accessing real-time market data and running deep quantitative analysis...',
      { chat_id: chatId, message_id: messageId, reply_markup: null }
    );
  } catch {}
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch {}
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
      } catch {}
      return;
    }

    const result = await AIService.buildAIParlay(config, availableGames);
    const { parlay } = result;

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
    } catch {}
  } catch (error) {
    sentryService.captureError(error, { component: 'ai_build_request' });
    await bot.sendMessage(chatId, `🚨 AI analysis failed.\n\n_Error: ${error.message}_`);
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch {}
  }
};

// --- Builder Settings UI ---
const sendBuilderSettings = async (chatId, messageId = null) => {
  const cfg = await getBuilderConfig(chatId);
  const text =
    `*⚙️ Builder Settings*\n\n` +
    `• Filter: ${cfg.filterHours === 0 ? 'All' : `${cfg.filterHours}h`}\n` +
    `• Avoid Same Game: ${cfg.avoidSameGame ? '✅' : '❌'}\n` +
    `• Odds Range: ${cfg.minOdds} to ${cfg.maxOdds}\n` +
    `• Exclusions: ${cfg.excludedTeams.length ? cfg.excludedTeams.join(', ') : 'None'}`;
  const rows = [
    [
      { text: `Filter: ${cfg.filterHours === 0 ? 'All' : `${cfg.filterHours}h`}`, callback_data: 'bs_f_menu' },
      { text: `SGP Avoid: ${cfg.avoidSameGame ? 'On' : 'Off'}`, callback_data: 'bs_sgp_tgl' },
    ],
    [{ text: `Odds Range`, callback_data: 'bs_odds_menu' }],
    [{ text: '« Back', callback_data: 'cfg_main' }],
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId)
    return bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  return bot.sendMessage(chatId, text, opts);
};
const sendFilterMenu = async (chatId, messageId) => {
  const rows = [
    [{ text: 'All', callback_data: 'bs_f_set_0' }, { text: '24h', callback_data: 'bs_f_set_24' }, { text: '48h', callback_data: 'bs_f_set_48' }],
    [{ text: '« Back', callback_data: 'b_settings' }],
  ];
  await bot.editMessageText('*Select game time filter:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
};
const sendOddsMenu = async (chatId, messageId) => {
  const rows = [
    [
      { text: 'Min: Any', callback_data: 'bs_omin_-2000' },
      { text: 'Min: -500', callback_data: 'bs_omin_-500' },
      { text: 'Min: -200', callback_data: 'bs_omin_-200' },
    ],
    [
      { text: 'Max: +1000', callback_data: 'bs_omax_1000' },
      { text: 'Max: +500', callback_data: 'bs_omax_500' },
      { text: 'Max: +300', callback_data: 'bs_omax_300' },
    ],
    [{ text: '« Back', callback_data: 'b_settings' }],
  ];
  await bot.editMessageText('*Set acceptable odds range per leg:*', {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
};

// --- Quant Picks (/quant) ---
const sendQuantPickSelection = async (chatId) => {
  if (await hitRateLimit(chatId, 'msg', 8, 10)) return bot.sendMessage(chatId, '⏳ Slow down a bit and try again.');
  const games = await GamesDataService.getGamesForSport('americanfootball_nfl');
  if (!games || games.length < 3) {
    return bot.sendMessage(chatId, 'Not enough game data to run quant analysis. Try again later.');
  }
  let best = { price: Infinity, name: 'N/A', game: { away_team: 'N/A', home_team: 'N/A' } };
  games.forEach((game) => {
    const m = game.bookmakers?.[0]?.markets?.find((x) => x.key === 'h2h');
    if (!m) return;
    m.outcomes?.forEach((o) => {
      if (typeof o.price === 'number' && o.price < best.price) best = { price: o.price, name: o.name, game };
    });
  });
  const msg =
    `⚡️ *Today's Top Quant Pick*\n\n` +
    `Based on current market data, the heaviest moneyline favorite is:\n\n` +
    `- *${best.name} ML* (${best.price})\n   _${best.game.away_team} @ ${best.game.home_team}_`;
  bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
};

// --- Player Props (/player) ---
const handlePlayerSearch = async (chatId, playerName) => {
  const waiting = await bot.sendMessage(chatId, `🔍 Searching for all available prop bets for *${playerName}*...`, {
    parse_mode: 'Markdown',
  });
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch {}
  try {
    const result = await AIService.findPlayerProps(playerName);
    if (!result?.props?.length) {
      return bot.editMessageText(
        `No prop bets found for *${playerName}*. They may not have an upcoming game or lines have not been posted.`,
        { chat_id: chatId, message_id: waiting.message_id, parse_mode: 'Markdown' }
      );
    }
    await redis.set(`player_props:${chatId}`, JSON.stringify(result), 'EX', 600);
    const text = `*Available Props for ${result.player_name}*\n_Game: ${result.game}_\n\nSelect props to add to your parlay slip:`;
    const keyboard = result.props.slice(0, 25).map((p, i) => [{ text: `${p.selection} (${p.odds})`, callback_data: `pp_${i}` }]);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: waiting.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (error) {
    await bot.editMessageText(`Could not find player props. Error: ${error.message}`, {
      chat_id: chatId,
      message_id: waiting.message_id,
    });
  }
};

// --- Manual Builder (/custom) ---
const sendCustomSportSelection = async (chatId) => {
  if (await hitRateLimit(chatId, 'msg', 8, 10)) return bot.sendMessage(chatId, '⏳ Slow down a bit and try again.');
  const sports = await GamesDataService.getAvailableSports();
  if (!sports?.length) return bot.sendMessage(chatId, 'No upcoming games found in the database.');
  const keyboard = sports.map((s) => [{ text: `${getSportEmoji(s.sport_key)} ${s.sport_title}`, callback_data: `cs_${s.sport_key}` }]);
  await bot.sendMessage(chatId, '✍️ *Manual Parlay Builder*\n\nSelect a sport:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
};
const sendCustomGameSelection = async (chatId, sportKey, messageId) => {
  const cfg = await getBuilderConfig(chatId);
  let games = await GamesDataService.getGamesForSport(sportKey);
  games = filterByCommence(games || [], cfg.filterHours);
  games = filterByExclusions(games, cfg.excludedTeams);
  if (!games?.length)
    return bot.editMessageText('No upcoming games found for this selection.', { chat_id: chatId, message_id: messageId });
  const keyboard = games.slice(0, 8).map((g) => [{ text: `${g.away_team} @ ${g.home_team}`, callback_data: `cg_${g.id}` }]);
  keyboard.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);
  await bot.editMessageText('Select a game to add:', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
};
const sendMarketSelection = async (chatId, gameId, messageId) => {
  const g = await GamesDataService.getGameDetails(gameId);
  if (!g?.bookmakers?.length) return bot.editMessageText('Could not find market data.', { chat_id: chatId, message_id: messageId });
  const ks = g.bookmakers[0].markets.map((m) => m.key);
  const row = [];
  if (ks.includes('h2h')) row.push({ text: 'Moneyline', callback_data: `cm_${g.id}_h2h` });
  if (ks.includes('spreads')) row.push({ text: 'Spreads', callback_data: `cm_${g.id}_spreads` });
  if (ks.includes('totals')) row.push({ text: 'Totals', callback_data: `cm_${g.id}_totals` });
  const keyboard = [row, [{ text: '« Back to Games', callback_data: `cback_games_${g.sport_key}` }]];
  await bot.editMessageText(`*${g.away_team} @ ${g.home_team}*\n${formatGameTime(g.commence_time)}\n\nSelect a market:`, {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
};
const sendPickSelection = async (chatId, gameId, marketKey, messageId) => {
  const g = await GamesDataService.getGameDetails(gameId);
  const m = g?.bookmakers?.[0]?.markets?.find((x) => x.key === marketKey);
  if (!m) return bot.editMessageText('Market not available.', { chat_id: chatId, message_id: messageId });
  const keyboard = [];
  for (const o of m.outcomes || []) {
    const pointText = o.point ? (o.point > 0 ? `+${o.point}` : o.point) : '';
    const priceText = o.price > 0 ? `+${o.price}` : o.price;
    const token = await saveCallbackPayload('cp', {
      gameId: g.id,
      mk: marketKey,
      name: o.name,
      point: o.point ?? 0,
      price: o.price,
      gameLabel: `${g.away_team} @ ${g.home_team}`,
    });
    keyboard.push([{ text: `${o.name} ${pointText} (${priceText})`, callback_data: `cp_${token}` }]);
  }
  keyboard.push([{ text: '« Back to Markets', callback_data: `cg_${g.id}` }]);
  await bot.editMessageText(`Select your pick for *${marketKey}*:`, {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
};

// --- Slip rendering & controls ---
const renderParlaySlip = async (chatId) => {
  const slip = await getParlaySlip(chatId);
  if (!slip.messageId) {
    const sent = await bot.sendMessage(chatId, 'Initializing your parlay slip...');
    slip.messageId = sent.message_id;
  }
  if (!slip.picks.length) {
    try {
      await bot.editMessageText('Your parlay slip is empty. Select a sport to add a leg.', {
        chat_id: chatId,
        message_id: slip.messageId,
      });
    } catch {}
    try {
      await bot.deleteMessage(chatId, slip.messageId);
    } catch {}
    await setParlaySlip(chatId, { picks: [], messageId: null, totalOdds: 0, stake: slip.stake || 10 });
    return sendCustomSportSelection(chatId);
  }

  let body = '✍️ *Your Custom Parlay*\n\n';
  let totalDecimal = 1;
  slip.picks.forEach((p, i) => {
    const d = toDecimalFromAmerican(p.odds);
    totalDecimal *= d;
    body += `*${i + 1}*: ${p.selection} (${p.odds > 0 ? '+' : ''}${p.odds})\n   _${p.game}_\n`;
  });
  const american = Math.round(toAmericanFromDecimal(totalDecimal));
  slip.totalOdds = american;
  const payout = slip.stake * (totalDecimal - 1);
  const prob = impliedProbability(totalDecimal);
  body += `\n*Total Legs*: ${slip.picks.length}\n*Total Odds*: ${american > 0 ? '+' : ''}${american}\n*Stake*: $${Number(slip.stake).toFixed(2)}\n*Projected Profit*: $${payout.toFixed(2)}\n*Implied Prob*: ${(prob * 100).toFixed(2)}%`;

  const kb = [
    [{ text: '➕ Add Another Leg', callback_data: 'sl_add' }],
    [
      { text: '🧹 Remove a Leg', callback_data: 'sl_manage' },
      { text: `🗑️ Clear (${slip.picks.length})`, callback_data: 'sl_clear' },
    ],
    [{ text: '🔄 Refresh Odds', callback_data: 'sl_refresh' }],
    [
      { text: '💾 Save', callback_data: 'sl_save' },
      { text: '📂 Load', callback_data: 'sl_load' },
    ],
    [{ text: `💵 Stake: $${Number(slip.stake).toFixed(2)}`, callback_data: 'sl_stake' }],
  ];
  await bot.editMessageText(body, {
    parse_mode: 'Markdown',
    chat_id: chatId,
    message_id: slip.messageId,
    reply_markup: { inline_keyboard: kb },
  });
  await setParlaySlip(chatId, slip);
};

// --- Commands ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (await hitRateLimit(chatId, 'msg', 8, 10)) return bot.sendMessage(chatId, '⏳ Slow down a bit and try again.');
  await bot.sendMessage(
    chatId,
    `Welcome — build parlays via AI, quant, player props, manual legs, inline mode, and bankroll tools.\nTry /parlay, /custom, /player, /quant, /calc, /kelly, and /settings.`
  );
});
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    `Help\n• /parlay — AI: legs/strategy/props + build\n• /custom — manual builder with per‑leg control\n• /player — search a player and add props\n• /quant — heaviest ML favorite today\n• /calc <odds...> — combine odds & probability\n• /kelly <p> <odds> — stake fraction by Kelly\n• /stake <amount> — set current slip stake\n• /settings — filters, SGP avoid, odds range\nInline: type @YourBot <player> to share props instantly (<=50 results).`
  );
});
bot.onText(/\/settings/, async (msg) => sendBuilderSettings(msg.chat.id));
bot.onText(/\/parlay/, async (msg) => sendAIConfigurationMenu(msg.chat.id));
bot.onText(/\/quant/, async (msg) => sendQuantPickSelection(msg.chat.id));
bot.onText(/\/custom/, async (msg) => sendCustomSportSelection(msg.chat.id));
bot.onText(/\/player/, async (msg) => {
  await setUserState(msg.chat.id, 'awaiting_player_name');
  await bot.sendMessage(msg.chat.id, '🤵 Which player is needed?');
});
bot.onText(/\/stake(?:\s+(\d+(?:\.\d+)?))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const val = m[1] ? parseFloat(m[1]) : NaN;
  if (!Number.isFinite(val) || val <= 0) return bot.sendMessage(chatId, 'Usage: /stake <amount>, e.g., /stake 25');
  const slip = await getParlaySlip(chatId);
  slip.stake = val;
  await setParlaySlip(chatId, slip);
  await renderParlaySlip(chatId);
});
bot.onText(/\/exclude_team(?:\s+(.+))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const name = (m[1] || '').trim();
  if (!name) return bot.sendMessage(chatId, 'Usage: /exclude_team <name>');
  const cfg = await getBuilderConfig(chatId);
  if (!cfg.excludedTeams.includes(name)) cfg.excludedTeams.push(name);
  await setBuilderConfig(chatId, cfg);
  await bot.sendMessage(chatId, `Excluded: ${name}`);
});
bot.onText(/\/exclusions/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getBuilderConfig(chatId);
  await bot.sendMessage(chatId, cfg.excludedTeams.length ? `Exclusions: ${cfg.excludedTeams.join(', ')}` : 'No team exclusions set.');
});
bot.onText(/\/clear_exclusions/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getBuilderConfig(chatId);
  cfg.excludedTeams = [];
  await setBuilderConfig(chatId, cfg);
  await bot.sendMessage(chatId, 'Cleared team exclusions.');
});

// Odds calculator: /calc +200 -150 +120
bot.onText(/\/calc(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args = (match[1] || '').trim();
  if (!args) return bot.sendMessage(chatId, 'Usage: /calc <odds...>\nExample: /calc +200 -150 +120');
  const parts = args.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  if (!parts.length) return bot.sendMessage(chatId, 'No valid American odds detected.');
  const decimals = parts.map(toDecimalFromAmerican);
  const totalDecimal = decimals.reduce((a, b) => a * b, 1);
  const totalAmerican = Math.round(toAmericanFromDecimal(totalDecimal));
  const prob = impliedProbability(totalDecimal);
  await bot.sendMessage(chatId, `Combined: ${totalAmerican > 0 ? '+' : ''}${totalAmerican}\nImplied Probability: ${(prob * 100).toFixed(2)}%`);
});

// Kelly staking: /kelly <p> <odds>   p as 0.55 or 55
bot.onText(/\/kelly(?:\s+([0-9]*\.?[0-9]+))?(?:\s+(-?\d+))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const pRaw = m[1] ? parseFloat(m[1]) : NaN;
  const odds = m[2] ? parseInt(m[2], 10) : NaN;
  if (!Number.isFinite(pRaw) || !Number.isFinite(odds)) {
    return bot.sendMessage(chatId, 'Usage: /kelly <probability> <odds>\nExamples:\n/kelly 0.55 -110\n/kelly 55 -110');
  }
  const p = pRaw > 1 ? pRaw / 100 : pRaw;
  const dec = toDecimalFromAmerican(odds);
  const b = dec - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  const frac = Math.max(0, Math.min(1, f));
  await bot.sendMessage(chatId, `Kelly fraction: ${(frac * 100).toFixed(2)}%\nNote: bet only if positive; negative/zero implies no bet.`);
});

// --- Message & Callback with throttling ---
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  if (await hitRateLimit(chatId, 'msg', 8, 10)) return bot.sendMessage(chatId, '⏳ Slow down a bit and try again.');
  const state = await getUserState(chatId);
  if (state === 'awaiting_player_name') {
    await setUserState(chatId, 'none');
    await handlePlayerSearch(chatId, msg.text.trim());
  } else if (state?.startsWith('stake_input')) {
    const amount = parseFloat(msg.text.trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      await bot.sendMessage(chatId, 'Enter a positive number for stake.');
    } else {
      const slip = await getParlaySlip(chatId);
      slip.stake = amount;
      await setParlaySlip(chatId, slip);
      await bot.sendMessage(chatId, `Stake set: $${amount.toFixed(2)}`);
      await renderParlaySlip(chatId);
    }
    await setUserState(chatId, 'none');
  }
});

bot.on('callback_query', async (cbq) => {
  const { data, message } = cbq;
  const chatId = message.chat.id;
  const limited = await hitRateLimit(chatId, 'cb', 15, 10);
  try {
    await bot.answerCallbackQuery(cbq.id, limited ? { text: '⏳ Slow down a bit and try again.', show_alert: false } : undefined);
  } catch {}
  if (limited) return;

  try {
    // AI config & builder settings
    if (data.startsWith('cfg_') || data.startsWith('b_') || data.startsWith('bs_')) {
      const ai = await getAIConfig(chatId);
      const bld = await getBuilderConfig(chatId);

      if (data === 'cfg_l_menu') return sendAILegsMenu(chatId, message.message_id);
      if (data === 'cfg_s_menu') return sendAIStrategyMenu(chatId, message.message_id);
      if (data.startsWith('cfg_l_set_')) {
        const n = parseInt(data.split('_').pop(), 10);
        if (Number.isFinite(n) && n >= 2 && n <= 20) ai.legs = n;
        await setAIConfig(chatId, ai);
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
      if (data.startsWith('cfg_s_set_')) {
        const strategy = data.split('_').slice(3).join('_');
        if (['conservative', 'balanced', 'aggressive'].includes(strategy)) ai.strategy = strategy;
        await setAIConfig(chatId, ai);
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
      if (data === 'cfg_p_tgl') {
        ai.includeProps = !ai.includeProps;
        await setAIConfig(chatId, ai);
        return sendAIConfigurationMenu(chatId, message.message_id);
      }
      if (data === 'cfg_build') return handleAIBuildRequest(chatId, ai, message.message_id);
      if (data === 'cfg_main') return sendAIConfigurationMenu(chatId, message.message_id);

      if (data === 'b_settings') return sendBuilderSettings(chatId, message.message_id);
      if (data === 'bs_f_menu') return sendFilterMenu(chatId, message.message_id);
      if (data.startsWith('bs_f_set_')) {
        bld.filterHours = parseInt(data.split('_').pop(), 10);
        await setBuilderConfig(chatId, bld);
        return sendBuilderSettings(chatId, message.message_id);
      }
      if (data === 'bs_sgp_tgl') {
        bld.avoidSameGame = !bld.avoidSameGame;
        await setBuilderConfig(chatId, bld);
        return sendBuilderSettings(chatId, message.message_id);
      }
      if (data === 'bs_odds_menu') return sendOddsMenu(chatId, message.message_id);
      if (data.startsWith('bs_omin_')) {
        bld.minOdds = parseInt(data.split('_').pop(), 10);
        await setBuilderConfig(chatId, bld);
        return sendBuilderSettings(chatId, message.message_id);
      }
      if (data.startsWith('bs_omax_')) {
        bld.maxOdds = parseInt(data.split('_').pop(), 10);
        await setBuilderConfig(chatId, bld);
        return sendBuilderSettings(chatId, message.message_id);
      }
    }
    // Manual builder navigation
    else if (data === 'cback_sports') {
      try { await bot.deleteMessage(chatId, message.message_id); } catch {}
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
      const marketKey = parts.slice(2).join('_');
      await sendPickSelection(chatId, gameId, marketKey, message.message_id);
    } else if (data.startsWith('cp_')) {
      // Add pick with constraints
      const payload = await loadCallbackPayload('cp', data.substring(3));
      if (!payload) return;
      const { gameId, mk, name, point, price, gameLabel } = payload;
      const cfg = await getBuilderConfig(chatId);
      const slip = await getParlaySlip(chatId);

      if (cfg.avoidSameGame && sameGameConflict(slip, gameLabel)) {
        return bot.sendMessage(chatId, 'Avoiding same‑game legs (toggle in Settings).');
      }
      if (!withinOddsRange(price, cfg.minOdds, cfg.maxOdds)) {
        return bot.sendMessage(chatId, `Pick outside allowed odds range (${cfg.minOdds} to ${cfg.maxOdds}).`);
      }

      const pointText = parseFloat(point) !== 0 ? (parseFloat(point) > 0 ? `+${point}` : `${point}`) : '';
      slip.picks.push({ game: gameLabel, selection: `${name} ${pointText}`.trim(), odds: parseInt(price, 10), mk });
      try { await bot.deleteMessage(chatId, message.message_id); } catch {}
      await setParlaySlip(chatId, slip);
      await renderParlaySlip(chatId);
    }
    // Slip actions
    else if (data.startsWith('sl_')) {
      const slip = await getParlaySlip(chatId);
      const action = data.substring(3);

      if (action === 'add') {
        try { if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId); } catch {}
        await setParlaySlip(chatId, { ...slip, messageId: null });
        return sendCustomSportSelection(chatId);
      }
      if (action === 'clear') {
        try { if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId); } catch {}
        await setParlaySlip(chatId, { picks: [], messageId: null, totalOdds: 0, stake: slip.stake || 10 });
        return bot.sendMessage(chatId, 'Parlay slip cleared.');
      }
      if (action === 'manage') {
        const rows = slip.picks.map((_, i) => [{ text: `Remove #${i + 1}`, callback_data: `slrm_${i}` }]);
        rows.push([{ text: '« Back', callback_data: 'sl_back' }]);
        return bot.sendMessage(chatId, 'Select a leg to remove:', { reply_markup: { inline_keyboard: rows } });
      }
      if (action === 'save') {
        const rows = [
          [{ text: 'Save to Slot 1', callback_data: 'sls_1' }],
          [{ text: 'Save to Slot 2', callback_data: 'sls_2' }],
          [{ text: 'Save to Slot 3', callback_data: 'sls_3' }],
        ];
        return bot.sendMessage(chatId, 'Choose a slot to save the current slip:', { reply_markup: { inline_keyboard: rows } });
      }
      if (action === 'load') {
        const rows = [
          [{ text: 'Load Slot 1', callback_data: 'sll_1' }],
          [{ text: 'Load Slot 2', callback_data: 'sll_2' }],
          [{ text: 'Load Slot 3', callback_data: 'sll_3' }],
        ];
        return bot.sendMessage(chatId, 'Choose a slot to load:', { reply_markup: { inline_keyboard: rows } });
      }
      if (action === 'stake') {
        const rows = [
          [{ text: '+$5', callback_data: 'slk_add_5' }, { text: '+$10', callback_data: 'slk_add_10' }, { text: '×2', callback_data: 'slk_mul_2' }],
          [{ text: '÷2', callback_data: 'slk_div_2' }, { text: 'Set...', callback_data: 'slk_set' }],
          [{ text: '« Back', callback_data: 'sl_back' }],
        ];
        return bot.sendMessage(chatId, `Stake controls (current $${Number(slip.stake).toFixed(2)}):`, {
          reply_markup: { inline_keyboard: rows },
        });
      }
      if (action === 'refresh') {
        // Re-fetch current prices for existing picks
        for (const p of slip.picks) {
          // p.mk holds marketKey; find price again if possible
          const [away, home] = p.game.split(' @ ');
          // Try to infer game via recent sports lists (fallback to keep odds if not found)
          // If we had gameId stored we could be exact; for now, keep existing odds when not resolvable
          // Best-effort refresh via builder filters across popular leagues
          const leagues = ['americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'soccer_epl'];
          for (const sk of leagues) {
            try {
              const gs = await GamesDataService.getGamesForSport(sk);
              const match = (gs || []).find((g) => g.away_team === away && g.home_team === home);
              if (!match?.bookmakers?.[0]?.markets) continue;
              const m = match.bookmakers[0].markets.find((x) => x.key === p.mk);
              if (!m?.outcomes) continue;
              const found = m.outcomes.find((o) => {
                const pt = o.point ? (o.point > 0 ? `+${o.point}` : `${o.point}`) : '';
                const sel = `${o.name} ${pt}`.trim();
                return sel === p.selection;
              });
              if (found?.price) p.odds = parseInt(found.price, 10);
              break;
            } catch {}
          }
        }
        await setParlaySlip(chatId, slip);
        return renderParlaySlip(chatId);
      }
      if (action === 'back') return renderParlaySlip(chatId);
    } else if (data.startsWith('slrm_')) {
      const idx = parseInt(data.substring(5), 10);
      const slip = await getParlaySlip(chatId);
      if (idx >= 0 && idx < slip.picks.length) slip.picks.splice(idx, 1);
      await setParlaySlip(chatId, slip);
      await renderParlaySlip(chatId);
    } else if (data.startsWith('sls_')) {
      const slot = parseInt(data.substring(4), 10);
      if ([1, 2, 3].includes(slot)) {
        const slip = await getParlaySlip(chatId);
        await redis.set(`slip_save:${chatId}:${slot}`, JSON.stringify({ picks: slip.picks, stake: slip.stake }), 'EX', 86400);
        await bot.sendMessage(chatId, `Saved current slip to Slot ${slot}.`);
      }
    } else if (data.startsWith('sll_')) {
      const slot = parseInt(data.substring(4), 10);
      if ([1, 2, 3].includes(slot)) {
        const raw = await redis.get(`slip_save:${chatId}:${slot}`);
        if (!raw) return bot.sendMessage(chatId, `No slip saved in Slot ${slot}.`);
        const { picks, stake } = JSON.parse(raw);
        const existing = await getParlaySlip(chatId);
        await setParlaySlip(chatId, { picks, stake: stake || existing.stake || 10, messageId: existing.messageId, totalOdds: 0 });
        await renderParlaySlip(chatId);
      }
    } else if (data.startsWith('slk_')) {
      const slip = await getParlaySlip(chatId);
      if (data === 'slk_set') {
        await setUserState(chatId, 'stake_input');
        return bot.sendMessage(chatId, 'Enter a stake amount (number):');
      }
      if (data === 'slk_add_5') slip.stake = Number(slip.stake || 0) + 5;
      if (data === 'slk_add_10') slip.stake = Number(slip.stake || 0) + 10;
      if (data === 'slk_mul_2') slip.stake = Number(slip.stake || 0) * 2;
      if (data === 'slk_div_2') slip.stake = Math.max(0.01, Number(slip.stake || 0) / 2);
      await setParlaySlip(chatId, slip);
      await renderParlaySlip(chatId);
    }
    // Player props pick
    else if (data.startsWith('pp_')) {
      const idx = parseInt(data.substring(3), 10);
      const raw = await redis.get(`player_props:${chatId}`);
      if (!raw) return;
      const result = JSON.parse(raw);
      const chosen = result.props[idx];
      if (!chosen) return;
      const cfg = await getBuilderConfig(chatId);
      const slip = await getParlaySlip(chatId);
      if (cfg.avoidSameGame && sameGameConflict(slip, result.game)) {
        return bot.sendMessage(chatId, 'Avoiding same‑game legs (toggle in Settings).');
      }
      if (!withinOddsRange(parseInt(chosen.odds, 10), cfg.minOdds, cfg.maxOdds)) {
        return bot.sendMessage(chatId, `Pick outside allowed odds range (${cfg.minOdds} to ${cfg.maxOdds}).`);
      }
      slip.picks.push({ game: result.game, selection: chosen.selection, odds: parseInt(chosen.odds, 10), mk: 'prop' });
      try { await bot.deleteMessage(chatId, message.message_id); } catch {}
      await setParlaySlip(chatId, slip);
      await renderParlaySlip(chatId);
    }
  } catch (err) {
    sentryService.captureError(err, { component: 'callback_query', data });
  }
});

// --- INLINE MODE: @Bot <player> -> inline results (<=50) ---
bot.on('inline_query', async (iq) => {
  const q = (iq.query || '').trim();
  if (!q) {
    try { await bot.answerInlineQuery(iq.id, [], { cache_time: 5, is_personal: true }); } catch {}
    return;
  }
  try {
    const result = await AIService.findPlayerProps(q);
    if (!result?.props?.length) {
      const article = {
        type: 'article',
        id: 'no-results',
        title: `No props found for "${q}"`,
        input_message_content: {
          message_text: `No props found for "${q}". Try /player and select from the in-chat menu.`,
          parse_mode: 'Markdown',
        },
        description: 'Open the bot and search with /player',
      };
      return bot.answerInlineQuery(iq.id, [article], { cache_time: 5, is_personal: true });
    }
    const articles = result.props.slice(0, 10).map((p, idx) => {
      const title = `${result.player_name}: ${p.selection} (${p.odds > 0 ? '+' : ''}${p.odds})`;
      const msg = `Parlay Pick: *${p.selection}* (${p.odds > 0 ? '+' : ''}${p.odds})\n${result.game}`;
      return {
        type: 'article',
        id: `prop-${idx}`,
        title,
        input_message_content: { message_text: msg, parse_mode: 'Markdown' },
        description: `${result.game}`,
      };
    });
    await bot.answerInlineQuery(iq.id, articles, { cache_time: 10, is_personal: true });
  } catch (err) {
    sentryService.captureError(err, { component: 'inline_query', q });
    try { await bot.answerInlineQuery(iq.id, [], { cache_time: 5, is_personal: true }); } catch {}
  }
});

// Replace existing listen line to capture the server handle
const PORT = env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));

// Graceful shutdown: close HTTP server, Redis, and bot (polling only in dev)
const closeRedis = async () => {
  try {
    if (redis?.quit) await redis.quit();
    else if (redis?.disconnect) await redis.disconnect();
    console.log('✅ Redis connection closed.');
  } catch (e) {
    console.error('Redis close error:', e?.message);
  }
};
const shutdown = async (signal) => {
  try {
    console.log(`🔻 Received ${signal}, draining...`);
    if (!isProduction) {
      try { await bot.stopPolling(); } catch {}
    }
    // Stop accepting new HTTP connections
    await new Promise((resolve) => server.close(resolve));
    await closeRedis();
    console.log('✅ Clean shutdown complete.');
    process.exit(0);
  } catch (e) {
    console.error('Shutdown error, forcing exit:', e?.message);
    process.exit(1);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
