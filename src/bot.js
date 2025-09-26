// src/bot.js – Ultimate AI + Custom Parlay Builder with Sports Multi-Select, Strict Time Filters, and Consistent Date/Time (no placeholders)

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import crypto from 'crypto';
import env, { isProduction } from './config/env.js';
import * as Sentry from '@sentry/node';
import sentryService from './services/sentryService.js';
import GamesDataService from './services/gamesService.js';
import AIService from './services/aiService.js';
import redis from './services/redisService.js';

const app = express();
app.use(express.json());

// --- Bot ---
const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: !isProduction });

// --- Webhook (optional secret) ---
const WEBHOOK_PATH = `/api/webhook/${env.TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = isProduction ? `${env.APP_URL}${WEBHOOK_PATH}` : null;
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET || '';

if (isProduction) {
  bot
    .setWebHook(WEBHOOK_URL, WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined)
    .then(() => console.log(`✅ Webhook set at ${WEBHOOK_URL}`))
    .catch((err) => console.error('❌ Failed to set webhook:', err));
  app.post(WEBHOOK_PATH, (req, res) => {
    try {
      if (WEBHOOK_SECRET) {
        const header = req.get('x-telegram-bot-api-secret-token');
        if (!header || header !== WEBHOOK_SECRET) return res.sendStatus(401);
      }
      bot.processUpdate(req.body);
      return res.sendStatus(200);
    } catch (e) {
      console.error('Webhook processUpdate error', e);
      return res.sendStatus(500);
    }
  });
} else {
  bot
    .deleteWebHook()
    .then(() => console.log('🤖 Bot running in polling mode'))
    .catch(console.error);
}

// --- Commands menu ---
bot.setMyCommands([
  { command: '/start', description: 'Welcome & Menu' },
  { command: '/parlay', description: '✨ AI Analyst Parlay' },
  { command: '/quant', description: '⚡️ Quick Quant Picks' },
  { command: '/player', description: '🤵 Parlay by Player' },
  { command: '/custom', description: '✍️ Manual Parlay Builder' },
  { command: '/settings', description: 'Builder & AI Settings' },
  { command: '/calc', description: 'Odds calculator' },
  { command: '/kelly', description: 'Kelly stake: /kelly <p> <odds>' },
  { command: '/stake', description: 'Set slip stake: /stake <amount>' },
  { command: '/exclusions', description: 'List team exclusions' },
  { command: '/exclude_team', description: 'Exclude team: /exclude_team <name>' },
  { command: '/clear_exclusions', description: 'Clear team exclusions' },
]);

// --- Rate limit helpers ---
const RATE_WINDOW_MS = 15000;
async function isRateLimited(chatId, bucket = 'default', limit = 8) {
  const key = `rl:${bucket}:${chatId}`;
  const c = await redis.incr(key);
  if (c === 1) await redis.pexpire(key, RATE_WINDOW_MS);
  return c > limit;
}

// --- Compact callback tokens (<=64 bytes) ---
async function saveToken(ns, payload, ttl = 900) {
  const tok = crypto.randomBytes(9).toString('base64url');
  await redis.set(`cb:${ns}:${tok}`, JSON.stringify(payload), 'EX', ttl);
  return tok;
}
async function loadToken(ns, tok, del = true) {
  const key = `cb:${ns}:${tok}`;
  const raw = await redis.get(key);
  if (del) await redis.del(key);
  return raw ? JSON.parse(raw) : null;
}

// --- Cached sports/games ---
const SPORTS_CACHE_KEY = 'cache:sports';
const SPORTS_CACHE_TTL = 300;
const GAMES_CACHE_TTL = 30;

async function getAvailableSportsCached() {
  const s = await redis.get(SPORTS_CACHE_KEY);
  if (s) { try { return JSON.parse(s); } catch {} }
  const sports = await GamesDataService.getAvailableSports();
  await redis.set(SPORTS_CACHE_KEY, JSON.stringify(sports || []), 'EX', SPORTS_CACHE_TTL);
  return sports || [];
}
async function getGamesForSportCached(sportKey) {
  const key = `cache:games:${sportKey}`;
  const s = await redis.get(key);
  if (s) { try { return JSON.parse(s); } catch {} }
  const games = await GamesDataService.getGamesForSport(sportKey);
  await redis.set(key, JSON.stringify(games || []), 'EX', GAMES_CACHE_TTL);
  return games || [];
}
async function getGameDetailsCached(gameId) {
  const key = `cache:game:${gameId}`;
  const s = await redis.get(key);
  if (s) { try { return JSON.parse(s); } catch {} }
  const game = await GamesDataService.getGameDetails(gameId);
  await redis.set(key, JSON.stringify(game || null), 'EX', GAMES_CACHE_TTL);
  return game || null;
}

// --- Selection cache for /custom multi-sport ---
async function getCustomSelectedSports(chatId) {
  const s = await redis.get(`custom:sports:${chatId}`);
  return s ? JSON.parse(s) : [];
}
async function setCustomSelectedSports(chatId, arr) {
  await redis.set(`custom:sports:${chatId}`, JSON.stringify(arr), 'EX', 3600);
}

// --- Config state (AI + Builder) ---
const AI_DEFAULT = { legs: 3, strategy: 'balanced', includeProps: true, sports: [] };
const BUILDER_DEFAULT = { avoidSameGame: true, cutoffHours: 24, minOdds: -2000, maxOdds: 1000, excludedTeams: [] };

async function getAIConfig(chatId) {
  const s = await redis.get(`cfg:ai:${chatId}`);
  return s ? JSON.parse(s) : { ...AI_DEFAULT };
}
async function setAIConfig(chatId, cfg) {
  await redis.set(`cfg:ai:${chatId}`, JSON.stringify(cfg), 'EX', 3600);
}
async function getBuilderConfig(chatId) {
  const s = await redis.get(`cfg:builder:${chatId}`);
  return s ? JSON.parse(s) : { ...BUILDER_DEFAULT };
}
async function setBuilderConfig(chatId, cfg) {
  await redis.set(`cfg:builder:${chatId}`, JSON.stringify(cfg), 'EX', 86400);
}

// --- Slip state ---
async function getParlaySlip(chatId) {
  const s = await redis.get(`slip:${chatId}`);
  if (!s) return { picks: [], stake: 10, messageId: null, totalOdds: 0 };
  try { return JSON.parse(s); } catch { return { picks: [], stake: 10, messageId: null, totalOdds: 0 }; }
}
async function setParlaySlip(chatId, slip) {
  await redis.set(`slip:${chatId}`, JSON.stringify(slip), 'EX', 7200);
}

// --- Utils ---
const toDecimalFromAmerican = (a) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
const toAmericanFromDecimal = (d) => (d >= 2 ? (d - 1) * 100 : -100 / (d - 1));
const impliedProbability = (d) => (d > 1 ? 1 / d : 0);
const getSportEmoji = (key) => (key.includes('americanfootball') ? '🏈' : key.includes('basketball') ? '🏀' : key.includes('baseball') ? '⚾' : key.includes('icehockey') ? '🏒' : key.includes('soccer') ? '⚽' : '🏆');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Timezone-aware formatter using env.TIMEZONE
const formatGameTime = (iso) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: env.TIMEZONE || 'America/New_York',
    timeZoneName: 'short',
  });

// Apply filters consistently everywhere
function filterGames(games, { cutoffHours, excludedTeams }) {
  const ex = (excludedTeams || []).map((t) => t.toLowerCase());
  const now = Date.now();
  const horizon = cutoffHours && cutoffHours > 0 ? now + cutoffHours * 3600 * 1000 : Number.POSITIVE_INFINITY;
  return (games || []).filter((g) => {
    const t = new Date(g.commence_time).getTime();
    if (t > horizon) return false;
    if (ex.length) {
      const a = (g.away_team || '').toLowerCase();
      const h = (g.home_team || '').toLowerCase();
      if (ex.some((e) => a.includes(e) || h.includes(e))) return false;
    }
    return true;
  });
}

// --- Main guides ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, `Welcome — build parlays via AI, quant, player props, manual legs, inline mode, and bankroll tools.\nTry /parlay, /custom, /player, /quant, /calc, /kelly, and /settings.`);
});

// --- Settings (Builder + AI) with new 6h/12h options ---
async function sendBuilderSettings(chatId, messageId = null) {
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
async function sendFilterMenu(chatId, messageId) {
  const rows = [
    [{ text: '6h', callback_data: 'bs_f_set_6' }, { text: '12h', callback_data: 'bs_f_set_12' }, { text: '24h', callback_data: 'bs_f_set_24' }],
    [{ text: '48h', callback_data: 'bs_f_set_48' }, { text: 'All', callback_data: 'bs_f_set_0' }],
    [{ text: '« Back', callback_data: 'b_settings' }],
  ];
  await bot.editMessageText('*Select game time filter:*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}
async function sendOddsMenu(chatId, messageId) {
  const rows = [
    [{ text: 'Min: Any', callback_data: 'bs_omin_-2000' }, { text: 'Min: -500', callback_data: 'bs_omin_-500' }, { text: 'Min: -200', callback_data: 'bs_omin_-200' }],
    [{ text: 'Max: +1000', callback_data: 'bs_omax_1000' }, { text: 'Max: +500', callback_data: 'bs_omax_500' }, { text: 'Max: +300', callback_data: 'bs_omax_300' }],
    [{ text: '« Back', callback_data: 'b_settings' }],
  ];
  await bot.editMessageText('*Set acceptable odds range per leg:*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

// --- AI menu with sports multi-select ---
async function sendAIConfigurationMenu(chatId, messageId = null) {
  const cfg = await getAIConfig(chatId);
  const sportsText = cfg.sports?.length ? `${cfg.sports.length} selected` : 'All';
  const text = `*✨ AI Analyst Parlay*\n\nConfigure legs/strategy/props/sports; AI will use fresh cached odds respecting your filters.`;
  const rows = [
    [{ text: `Legs: ${cfg.legs}`, callback_data: `cfg_l_menu` }, { text: `Strategy: ${cfg.strategy}`, callback_data: 'cfg_s_menu' }],
    [{ text: `Player Props: ${cfg.includeProps ? '✅ Yes' : '❌ No'}`, callback_data: 'cfg_p_tgl' }],
    [{ text: `Sports: ${sportsText}`, callback_data: 'cfg_sp_menu' }],
    [{ text: '🤖 Build My Parlay', callback_data: 'cfg_build' }],
    [{ text: '⚙️ Builder Settings', callback_data: 'b_settings' }],
  ];
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) return bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  return bot.sendMessage(chatId, text, opts);
}
async function sendAILegsMenu(chatId, messageId) {
  const legs = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const grid = [];
  for (let i = 0; i < legs.length; i += 3) grid.push(legs.slice(i, i + 3).map((n) => ({ text: `${n} legs`, callback_data: `cfg_l_set_${n}` })));
  grid.push([{ text: '« Back', callback_data: 'cfg_main' }]);
  await bot.editMessageText('*Select number of legs:*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: grid } });
}
async function sendAIStrategyMenu(chatId, messageId) {
  const strategies = ['conservative', 'balanced', 'aggressive'];
  const rows = [strategies.map((s) => ({ text: cap(s), callback_data: `cfg_s_set_${s}` })), [{ text: '« Back', callback_data: 'cfg_main' }]];
  await bot.editMessageText('*Select strategy:*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}
async function sendAISportsMenu(chatId, messageId) {
  const all = await getAvailableSportsCached();
  const cfg = await getAIConfig(chatId);
  const selected = new Set(cfg.sports || []);
  const rows = [];
  for (const s of all) {
    const active = selected.has(s.sport_key);
    const tok = await saveToken('cfgsp', { sport_key: s.sport_key });
    rows.push([{ text: `${active ? '✅' : '☑️'} ${getSportEmoji(s.sport_key)} ${s.sport_title}`, callback_data: `cfgsp_${tok}` }]);
  }
  rows.push([{ text: 'All Sports', callback_data: 'cfgsp_all' }]);
  rows.push([{ text: '« Back', callback_data: 'cfg_main' }]);
  await bot.editMessageText('*Select sports (toggle):*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

// --- AI Build (strict time filters applied) ---
const AI_BUILD_MIN_INTERVAL_MS = 60000;
async function handleAIBuild(chatId, cfg, messageId) {
  const limiter = `rl:ai:${chatId}`;
  const last = await redis.get(limiter);
  const now = Date.now();
  if (last && now - Number(last) < AI_BUILD_MIN_INTERVAL_MS) {
    await bot.sendMessage(chatId, '⏳ Please wait before requesting another AI build.');
    return;
  }
  await redis.set(limiter, now, 'EX', Math.ceil(AI_BUILD_MIN_INTERVAL_MS / 1000));

  try {
    await bot.editMessageText('🤖 Accessing current market data and running deep quantitative analysis...', { chat_id: chatId, message_id: messageId, reply_markup: null });
  } catch {}

  try {
    const allSports = await getAvailableSportsCached();
    const selectedSports = cfg.sports?.length ? cfg.sports : allSports.map((s) => s.sport_key);

    // Per-sport cached pulls
    const perSport = await Promise.all(selectedSports.map((k) => getGamesForSportCached(k)));
    let pooled = perSport.flat();

    // Builder filters for time/exclusions
    const b = await getBuilderConfig(chatId);
    pooled = filterGames(pooled, { cutoffHours: b.cutoffHours, excludedTeams: b.excludedTeams });

    if (pooled.length < cfg.legs) {
      await bot.sendMessage(chatId, `Not enough upcoming games to build a ${cfg.legs}-leg parlay with the current filters/time window.`);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      return;
    }

    const result = await AIService.buildAIParlay(cfg, pooled);
    const parlay = result.parlay;

    const totDec = parlay.legs.reduce((acc, leg) => acc * toDecimalFromAmerican(leg.odds), 1);
    const totAm = Math.round(toAmericanFromDecimal(totDec));
    parlay.total_odds = totAm;

    let out = `📈 *${parlay.title || 'AI-Generated Parlay'}*\n\n_${parlay.overall_narrative}_\n\n`;
    // Show consistent date/time per game; when multiple legs from same game, show time once
    const byGame = {};
    parlay.legs.forEach((leg) => {
      if (!byGame[leg.game]) byGame[leg.game] = { legs: [], commence_time: leg.commence_time, sport: leg.sport };
      byGame[leg.game].legs.push(leg);
      if (!byGame[leg.game].commence_time && leg.commence_time) byGame[leg.game].commence_time = leg.commence_time;
    });

    Object.entries(byGame).forEach(([game, info]) => {
      const timeStr = info.commence_time ? formatGameTime(info.commence_time) : '';
      out += `*${info.sport}* — ${game}${timeStr ? ` — ${timeStr}` : ''}\n`;
      info.legs.forEach((leg) => {
        const sOdds = leg.odds > 0 ? `+${leg.odds}` : `${leg.odds}`;
        out += `• ${leg.selection} (${sOdds})\n`;
      });
      out += `\n`;
    });

    out += `*Total Odds*: *${totAm > 0 ? '+' : ''}${totAm}*`;
    await bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
    try { await bot.deleteMessage(chatId, messageId); } catch {}
  } catch (err) {
    sentryService.captureError(err, { component: 'ai_build' });
    await bot.sendMessage(chatId, `🚨 AI analysis failed.\n\n_Error: ${err.message}_`);
    try { await bot.deleteMessage(chatId, messageId); } catch {}
  }
}

// --- Custom Builder with multi-select sports and strict filters ---
async function sendCustomSportSelection(chatId, messageId = null) {
  const sports = await getAvailableSportsCached();
  if (!sports?.length) return bot.sendMessage(chatId, 'No upcoming games found in the database.');
  const chosen = new Set(await getCustomSelectedSports(chatId));
  const rows = [];
  for (const s of sports) {
    const active = chosen.has(s.sport_key);
    const tok = await saveToken('csp', { sport_key: s.sport_key });
    rows.push([{ text: `${active ? '✅' : '☑️'} ${getSportEmoji(s.sport_key)} ${s.sport_title}`, callback_data: `csp_${tok}` }]);
  }
  rows.push([{ text: 'Proceed with selected', callback_data: 'custom_sports_proceed' }]);
  const text = '✍️ *Manual Parlay Builder*\n\nSelect sports (toggle), then proceed:';
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) return bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  return bot.sendMessage(chatId, text, opts);
}

async function sendCustomGamesFromSelected(chatId, messageId) {
  const selected = await getCustomSelectedSports(chatId);
  const sports = selected.length ? selected : (await getAvailableSportsCached()).map((s) => s.sport_key);
  const b = await getBuilderConfig(chatId);
  const perSport = await Promise.all(sports.map((k) => getGamesForSportCached(k)));
  const pooled = filterGames(perSport.flat(), { cutoffHours: b.cutoffHours, excludedTeams: b.excludedTeams });

  if (!pooled.length) {
    return bot.editMessageText('No upcoming games found for your selections/filters.', { chat_id: chatId, message_id: messageId });
  }

  // Show first 10 across all selected sports
  const rows = pooled.slice(0, 10).map((g) => [{ text: `${g.away_team} @ ${g.home_team} — ${formatGameTime(g.commence_time)}`, callback_data: `cg_${g.id}` }]);
  rows.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);
  await bot.editMessageText('Select a game:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

async function sendCustomGameSelection(chatId, sportKey, messageId) {
  const b = await getBuilderConfig(chatId);
  const games = await getGamesForSportCached(sportKey);
  const filtered = filterGames(games, { cutoffHours: b.cutoffHours, excludedTeams: b.excludedTeams });
  if (!filtered.length) {
    return bot.editMessageText('No upcoming games found for this sport with current filters.', { chat_id: chatId, message_id: messageId });
  }
  const rows = filtered.slice(0, 10).map((g) => [{ text: `${g.away_team} @ ${g.home_team} — ${formatGameTime(g.commence_time)}`, callback_data: `cg_${g.id}` }]);
  rows.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);
  await bot.editMessageText('Select a game to add:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

async function sendMarketSelection(chatId, gameId, messageId) {
  const g = await getGameDetailsCached(gameId);
  if (!g?.bookmakers?.length) return bot.editMessageText('Could not find market data.', { chat_id: chatId, message_id: messageId });
  const keys = g.bookmakers[0].markets.map((m) => m.key);
  const row = [];
  if (keys.includes('h2h')) row.push({ text: 'Moneyline', callback_data: `cm_${g.id}_h2h` });
  if (keys.includes('spreads')) row.push({ text: 'Spreads', callback_data: `cm_${g.id}_spreads` });
  if (keys.includes('totals')) row.push({ text: 'Totals', callback_data: `cm_${g.id}_totals` });
  const rows = [row, [{ text: '« Back to Games', callback_data: 'custom_sports_proceed' }]];
  await bot.editMessageText(`*${g.away_team} @ ${g.home_team}*\n${formatGameTime(g.commence_time)}\n\nSelect a market:`, {
    parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }
  });
}

async function sendPickSelection(chatId, gameId, marketKey, messageId) {
  const g = await getGameDetailsCached(gameId);
  const m = g?.bookmakers?.[0]?.markets?.find((x) => x.key === marketKey);
  if (!m) return bot.editMessageText('Market not available.', { chat_id: chatId, message_id: messageId });

  const rows = [];
  for (const o of m.outcomes || []) {
    const tok = await saveToken('cp', { gameId: g.id, marketKey, name: o.name, point: o.point ?? 0, price: o.price, gameLabel: `${g.away_team} @ ${g.home_team}` });
    const pointText = o.point ? (o.point > 0 ? `+${o.point}` : `${o.point}`) : '';
    const priceText = o.price > 0 ? `+${o.price}` : `${o.price}`;
    rows.push([{ text: `${o.name} ${pointText} (${priceText})`, callback_data: `cp_${tok}` }]);
  }
  rows.push([{ text: '« Back to Markets', callback_data: `cg_${g.id}` }]);
  await bot.editMessageText(`Select your pick for *${marketKey}*:`, { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

async function handlePickToken(chatId, tok, messageId) {
  const p = await loadToken('cp', tok);
  if (!p) return;
  const b = await getBuilderConfig(chatId);
  const slip = await getParlaySlip(chatId);

  if (b.avoidSameGame && slip.picks.some((x) => x.game === p.gameLabel)) {
    await bot.sendMessage(chatId, 'Avoiding same‑game legs (toggle in /settings).');
    return;
  }
  if (p.price < b.minOdds || p.price > b.maxOdds) {
    await bot.sendMessage(chatId, `Pick outside allowed odds range (${b.minOdds} to ${b.maxOdds}).`);
    return;
  }
  const pointText = p.point ? (p.point > 0 ? `+${p.point}` : `${p.point}`) : '';
  slip.picks.push({ game: p.gameLabel, selection: `${p.name} ${pointText}`.trim(), odds: parseInt(p.price, 10), marketKey: p.marketKey, gameId: p.gameId, commence_time: (await getGameDetailsCached(p.gameId))?.commence_time || null });
  await setParlaySlip(chatId, slip);
  try { await bot.deleteMessage(chatId, messageId); } catch {}
  await renderParlaySlip(chatId);
}

// --- Slip rendering grouped by game (show game + time once) ---
async function renderParlaySlip(chatId) {
  const slip = await getParlaySlip(chatId);
  if (!slip.messageId) {
    const sent = await bot.sendMessage(chatId, 'Initializing your parlay slip...');
    slip.messageId = sent.message_id;
  }
  if (!slip.picks.length) {
    try { await bot.editMessageText('Your parlay slip is empty. Select a sport to add a leg.', { chat_id: chatId, message_id: slip.messageId }); } catch {}
    try { await bot.deleteMessage(chatId, slip.messageId); } catch {}
    await setParlaySlip(chatId, { picks: [], stake: slip.stake || 10, messageId: null, totalOdds: 0 });
    return sendCustomSportSelection(chatId);
  }

  // Group legs by game
  const groups = {};
  for (const p of slip.picks) {
    if (!groups[p.game]) groups[p.game] = { commence_time: p.commence_time || null, picks: [] };
    groups[p.game].picks.push(p);
    if (!groups[p.game].commence_time && p.gameId) {
      const det = await getGameDetailsCached(p.gameId);
      groups[p.game].commence_time = det?.commence_time || groups[p.game].commence_time;
    }
  }

  let text = '✍️ *Your Custom Parlay*\n\n';
  let totalDecimal = 1;
  for (const p of slip.picks) totalDecimal *= toDecimalFromAmerican(p.odds);

  const totAm = Math.round(toAmericanFromDecimal(totalDecimal));
  const profit = (slip.stake || 0) * (totalDecimal - 1);
  const prob = impliedProbability(totalDecimal);
  slip.totalOdds = totAm;

  // Render grouped
  Object.entries(groups).forEach(([game, info]) => {
    const timeStr = info.commence_time ? formatGameTime(info.commence_time) : '';
    text += `*${game}*${timeStr ? ` — ${timeStr}` : ''}\n`;
    info.picks.forEach((p) => {
      text += `• ${p.selection} (${p.odds > 0 ? '+' : ''}${p.odds})\n`;
    });
    text += `\n`;
  });

  text += `*Total Legs*: ${slip.picks.length}\n*Total Odds*: ${totAm > 0 ? '+' : ''}${totAm}\n*Stake*: $${Number(slip.stake || 0).toFixed(2)}\n*Projected Profit*: $${profit.toFixed(2)}\n*Implied Prob*: ${(prob * 100).toFixed(2)}%`;

  const rows = [
    [{ text: '➕ Add Another Leg', callback_data: 'cslip_add' }],
    [{ text: '🧹 Remove a Leg', callback_data: 'cslip_manage' }, { text: `🗑️ Clear (${slip.picks.length})`, callback_data: 'cslip_clear' }],
    [{ text: '💾 Save', callback_data: 'cslip_save' }, { text: '📂 Load', callback_data: 'cslip_load' }],
    [{ text: `💵 Stake: $${Number(slip.stake || 0).toFixed(2)}`, callback_data: 'cslip_stake' }],
    [{ text: '🔄 Refresh Odds', callback_data: 'cslip_refresh' }],
  ];

  await bot.editMessageText(text, { parse_mode: 'Markdown', chat_id: chatId, message_id: slip.messageId, reply_markup: { inline_keyboard: rows } });
  await setParlaySlip(chatId, slip);
}

// --- Commands ---
bot.onText(/\/settings/, async (msg) => sendBuilderSettings(msg.chat.id));
bot.onText(/\/parlay/, async (msg) => sendAIConfigurationMenu(msg.chat.id));
bot.onText(/\/custom/, async (msg) => sendCustomSportSelection(msg.chat.id));

// Quant stays as before
bot.onText(/\/quant/, async (msg) => {
  const chatId = msg.chat.id;
  const games = await getGamesForSportCached('americanfootball_nfl');
  if (!games?.length) return bot.sendMessage(chatId, 'Not enough game data to run quant analysis. Try again later.');
  let best = { price: Infinity, name: 'N/A', game: { away_team: 'N/A', home_team: 'N/A' } };
  games.forEach((g) => {
    const m = g.bookmakers?.[0]?.markets?.find((x) => x.key === 'h2h');
    m?.outcomes?.forEach((o) => { if (typeof o.price === 'number' && o.price < best.price) best = { price: o.price, name: o.name, game: g }; });
  });
  const txt = `⚡️ *Today's Top Quant Pick*\n\nBased on current market data, the heaviest moneyline favorite is:\n\n- *${best.name} ML* (${best.price})\n   _${best.game.away_team} @ ${best.game.home_team}_`;
  await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
});

// Player props flow
bot.onText(/\/player/, async (msg) => {
  await redis.set(`user:state:${msg.chat.id}`, 'awaiting_player', 'EX', 300);
  await bot.sendMessage(msg.chat.id, '🤵 Which player is needed?');
});
async function handlePlayerSearch(chatId, q) {
  const waiting = await bot.sendMessage(chatId, `🔍 Searching for all available prop bets for *${q}*...`, { parse_mode: 'Markdown' });
  try {
    const result = await AIService.findPlayerProps(q);
    if (!result?.props?.length) {
      return bot.editMessageText(`No prop bets found for *${q}*.`, { chat_id: chatId, message_id: waiting.message_id, parse_mode: 'Markdown' });
    }
    await redis.set(`player_props:${chatId}`, JSON.stringify(result), 'EX', 600);
    const rows = result.props.slice(0, 25).map((p, i) => [{ text: `${p.selection} (${p.odds})`, callback_data: `pp_${i}` }]);
    await bot.editMessageText(`*Available Props for ${result.player_name}*\n_Game: ${result.game}_\n\nSelect props to add to your parlay slip:`, { chat_id: chatId, message_id: waiting.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  } catch (e) {
    await bot.editMessageText(`Could not find player props. Error: ${e.message}`, { chat_id: chatId, message_id: waiting.message_id });
  }
}

// Odds calculator + Kelly + stake (unchanged)
bot.onText(/\/calc(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args = (match[1] || '').trim();
  if (!args) return bot.sendMessage(chatId, 'Usage: /calc <odds...>\nExample: /calc +200 -150 +120');
  const parts = args.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  if (!parts.length) return bot.sendMessage(chatId, 'No valid American odds detected.');
  const decs = parts.map(toDecimalFromAmerican);
  const totalDec = decs.reduce((a, b) => a * b, 1);
  const totalAm = Math.round(toAmericanFromDecimal(totalDec));
  const prob = impliedProbability(totalDec);
  await bot.sendMessage(chatId, `Combined: ${totalAm > 0 ? '+' : ''}${totalAm}\nImplied Probability: ${(prob * 100).toFixed(2)}%`);
});
bot.onText(/\/kelly(?:\s+([0-9]*\.?[0-9]+))?(?:\s+(-?\d+))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const pRaw = m[1] ? parseFloat(m[1]) : NaN;
  const odds = m[2] ? parseInt(m[2], 10) : NaN;
  if (!Number.isFinite(pRaw) || !Number.isFinite(odds)) return bot.sendMessage(chatId, 'Usage: /kelly <probability> <odds>\nExamples:\n/kelly 0.55 -110\n/kelly 55 -110');
  const p = pRaw > 1 ? pRaw / 100 : pRaw;
  const dec = toDecimalFromAmerican(odds);
  const b = dec - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  const frac = Math.max(0, Math.min(1, f));
  await bot.sendMessage(chatId, `Kelly fraction: ${(frac * 100).toFixed(2)}%\nNote: bet only if positive; negative/zero implies no bet.`);
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

// Team exclusions
bot.onText(/\/exclude_team(?:\s+(.+))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const name = (m[1] || '').trim();
  if (!name) return bot.sendMessage(chatId, 'Usage: /exclude_team <name>');
  const b = await getBuilderConfig(chatId);
  if (!b.excludedTeams.includes(name)) b.excludedTeams.push(name);
  await setBuilderConfig(chatId, b);
  await bot.sendMessage(chatId, `Excluded: ${name}`);
});
bot.onText(/\/exclusions/, async (msg) => {
  const chatId = msg.chat.id;
  const b = await getBuilderConfig(chatId);
  await bot.sendMessage(chatId, b.excludedTeams.length ? `Exclusions: ${b.excludedTeams.join(', ')}` : 'No team exclusions set.');
});
bot.onText(/\/clear_exclusions/, async (msg) => {
  const chatId = msg.chat.id;
  const b = await getBuilderConfig(chatId);
  b.excludedTeams = [];
  await setBuilderConfig(chatId, b);
  await bot.sendMessage(chatId, 'Cleared team exclusions.');
});

// --- Message state handler ---
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const state = await redis.get(`user:state:${chatId}`);
  if (state === 'awaiting_player') {
    await redis.set(`user:state:${chatId}`, 'none', 'EX', 1);
    return handlePlayerSearch(chatId, msg.text.trim());
  }
  if (state === 'stake_input') {
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
    await redis.set(`user:state:${chatId}`, 'none', 'EX', 1);
  }
});

// --- Callback router ---
bot.on('callback_query', async (cbq) => {
  const { data, message } = cbq;
  const chatId = message.chat.id;
  try { await bot.answerCallbackQuery(cbq.id); } catch {}

  try {
    // Builder settings
    if (data === 'cfg_main') return sendAIConfigurationMenu(chatId, message.message_id);
    if (data === 'b_settings') return sendBuilderSettings(chatId, message.message_id);
    if (data === 'bs_f_menu') return sendFilterMenu(chatId, message.message_id);
    if (data.startsWith('bs_f_set_')) {
      const v = parseInt(data.split('_').pop(), 10);
      const b = await getBuilderConfig(chatId);
      b.cutoffHours = Number.isFinite(v) ? v : b.cutoffHours;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(chatId, message.message_id);
    }
    if (data === 'bs_sgp_tgl') {
      const b = await getBuilderConfig(chatId);
      b.avoidSameGame = !b.avoidSameGame;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(chatId, message.message_id);
    }
    if (data === 'bs_odds_menu') return sendOddsMenu(chatId, message.message_id);
    if (data.startsWith('bs_omin_')) {
      const v = parseInt(data.split('_').pop(), 10);
      const b = await getBuilderConfig(chatId);
      b.minOdds = Number.isFinite(v) ? v : b.minOdds;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(chatId, message.message_id);
    }
    if (data.startsWith('bs_omax_')) {
      const v = parseInt(data.split('_').pop(), 10);
      const b = await getBuilderConfig(chatId);
      b.maxOdds = Number.isFinite(v) ? v : b.maxOdds;
      await setBuilderConfig(chatId, b);
      return sendBuilderSettings(chatId, message.message_id);
    }

    // AI config
    if (data === 'cfg_l_menu') return sendAILegsMenu(chatId, message.message_id);
    if (data.startsWith('cfg_l_set_')) {
      const n = parseInt(data.split('_').pop(), 10);
      const cfg = await getAIConfig(chatId);
      if (Number.isFinite(n) && n >= 2 && n <= 20) cfg.legs = n;
      await setAIConfig(chatId, cfg);
      return sendAIConfigurationMenu(chatId, message.message_id);
    }
    if (data === 'cfg_s_menu') return sendAIStrategyMenu(chatId, message.message_id);
    if (data.startsWith('cfg_s_set_')) {
      const st = data.split('_').slice(3).join('_');
      const cfg = await getAIConfig(chatId);
      if (['conservative', 'balanced', 'aggressive'].includes(st)) cfg.strategy = st;
      await setAIConfig(chatId, cfg);
      return sendAIConfigurationMenu(chatId, message.message_id);
    }
    if (data === 'cfg_p_tgl') {
      const cfg = await getAIConfig(chatId);
      cfg.includeProps = !cfg.includeProps;
      await setAIConfig(chatId, cfg);
      return sendAIConfigurationMenu(chatId, message.message_id);
    }
    if (data === 'cfg_sp_menu') return sendAISportsMenu(chatId, message.message_id);
    if (data === 'cfgsp_all') {
      const cfg = await getAIConfig(chatId);
      cfg.sports = [];
      await setAIConfig(chatId, cfg);
      return sendAISportsMenu(chatId, message.message_id);
    }
    if (data.startsWith('cfgsp_')) {
      const tok = data.substring(6);
      const payload = await loadToken('cfgsp', tok);
      if (payload?.sport_key) {
        const cfg = await getAIConfig(chatId);
        const set = new Set(cfg.sports || []);
        if (set.has(payload.sport_key)) set.delete(payload.sport_key);
        else set.add(payload.sport_key);
        cfg.sports = Array.from(set);
        await setAIConfig(chatId, cfg);
      }
      return sendAISportsMenu(chatId, message.message_id);
    }
    if (data === 'cfg_build') {
      const cfg = await getAIConfig(chatId);
      return handleAIBuild(chatId, cfg, message.message_id);
    }

    // Custom sports multi-select
    if (data.startsWith('csp_')) {
      const tok = data.substring(4);
      const payload = await loadToken('csp', tok);
      if (payload?.sport_key) {
        const selected = new Set(await getCustomSelectedSports(chatId));
        if (selected.has(payload.sport_key)) selected.delete(payload.sport_key);
        else selected.add(payload.sport_key);
        await setCustomSelectedSports(chatId, Array.from(selected));
      }
      return sendCustomSportSelection(chatId, message.message_id);
    }
    if (data === 'custom_sports_proceed') {
      return sendCustomGamesFromSelected(chatId, message.message_id);
    }

    // Custom navigation
    if (data === 'cback_sports') return sendCustomSportSelection(chatId, message.message_id);
    if (data.startsWith('cg_')) return sendMarketSelection(chatId, data.substring(3), message.message_id);
    if (data.startsWith('cm_')) {
      const parts = data.split('_');
      const gameId = parts[1];
      const marketKey = parts.slice(2).join('_');
      return sendPickSelection(chatId, gameId, marketKey, message.message_id);
    }
    if (data.startsWith('cp_')) {
      return handlePickToken(chatId, data.substring(3), message.message_id);
    }

    // Slip
    if (data.startsWith('cslip_')) {
      const action = data.substring(6);
      const slip = await getParlaySlip(chatId);
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
        const rows = slip.picks.map((_, i) => [{ text: `Remove #${i + 1}`, callback_data: `cslip_rm_${i}` }]);
        rows.push([{ text: '« Back', callback_data: 'cslip_back' }]);
        return bot.sendMessage(chatId, 'Select a leg to remove:', { reply_markup: { inline_keyboard: rows } });
      }
      if (action === 'save') {
        const rows = [[{ text: 'Save to Slot 1', callback_data: 'cslip_save_1' }], [{ text: 'Save to Slot 2', callback_data: 'cslip_save_2' }], [{ text: 'Save to Slot 3', callback_data: 'cslip_save_3' }]];
        return bot.sendMessage(chatId, 'Choose a slot to save the current slip:', { reply_markup: { inline_keyboard: rows } });
      }
      if (action === 'load') {
        const rows = [[{ text: 'Load Slot 1', callback_data: 'cslip_load_1' }], [{ text: 'Load Slot 2', callback_data: 'cslip_load_2' }], [{ text: 'Load Slot 3', callback_data: 'cslip_load_3' }]];
        return bot.sendMessage(chatId, 'Choose a slot to load:', { reply_markup: { inline_keyboard: rows } });
      }
      if (action === 'stake') {
        await redis.set(`user:state:${chatId}`, 'stake_input', 'EX', 120);
        return bot.sendMessage(chatId, 'Enter a stake amount (number):');
      }
      if (action === 'refresh') {
        for (const p of slip.picks) {
          if (!p.gameId || !p.marketKey) continue;
          try {
            const g = await getGameDetailsCached(p.gameId);
            const m = g?.bookmakers?.[0]?.markets?.find((x) => x.key === p.marketKey);
            if (!m?.outcomes) continue;
            const found = m.outcomes.find((o) => {
              const pt = o.point ? (o.point > 0 ? `+${o.point}` : `${o.point}`) : '';
              const sel = `${o.name} ${pt}`.trim();
                            return sel === p.selection;
            });
            if (found && typeof found.price === 'number') {
              p.odds = parseInt(found.price, 10);
            }
          } catch {}
        }
        await setParlaySlip(chatId, slip);
        return renderParlaySlip(chatId);
      }
      if (action === 'back') {
        return renderParlaySlip(chatId);
      }
    }

    // Remove leg (manage menu)
    if (data.startsWith('cslip_rm_')) {
      const idx = parseInt(data.substring('cslip_rm_'.length), 10);
      const slip = await getParlaySlip(chatId);
      if (Number.isInteger(idx) && idx >= 0 && idx < slip.picks.length) {
        slip.picks.splice(idx, 1);
        await setParlaySlip(chatId, slip);
      }
      return renderParlaySlip(chatId);
    }

    // Player props selection buttons
    if (data.startsWith('pp_')) {
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

      slip.picks.push({
        game: result.game,
        selection: chosen.selection,
        odds: price,
        marketKey: 'prop',
        gameId: null,
        commence_time: null,
      });
      await setParlaySlip(chatId, slip);
      try { await bot.deleteMessage(chatId, message.message_id); } catch {}
      return renderParlaySlip(chatId);
    }
  } catch (e) {
    sentryService.captureError(e, { component: 'callback_query', data });
  }
});

// --- Inline mode: quick prop sharing with up to 10 results ---
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
    const articles = result.props.slice(0, 10).map((p, i) => {
      const title = `${result.player_name}: ${p.selection} (${p.odds > 0 ? '+' : ''}${p.odds})`;
      const msg = `Parlay Pick: *${p.selection}* (${p.odds > 0 ? '+' : ''}${p.odds})\n${result.game}`;
      return {
        type: 'article',
        id: `prop-${i}`,
        title,
        input_message_content: { message_text: msg, parse_mode: 'Markdown' },
        description: `${result.game}`,
      };
    });
    await bot.answerInlineQuery(iq.id, articles, { cache_time: 10, is_personal: true });
  } catch (e) {
    sentryService.captureError(e, { component: 'inline_query', q });
    try { await bot.answerInlineQuery(iq.id, [], { cache_time: 5, is_personal: true }); } catch {}
  }
});

// --- Graceful shutdown & server start ---
const PORT = env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`✅ Parlay Bot HTTP server live on port ${PORT}`));

async function closeRedis() {
  try {
    if (redis?.quit) await redis.quit();
    else if (redis?.disconnect) await redis.disconnect();
    console.log('✅ Redis connection closed.');
  } catch (e) {
    console.error('Redis close error:', e?.message);
  }
}
async function shutdown(signal) {
  try {
    console.log(`🔻 Received ${signal}, draining...`);
    if (!isProduction) {
      try { await bot.stopPolling(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
    await closeRedis();
    console.log('✅ Clean shutdown complete.');
    process.exit(0);
  } catch (e) {
    console.error('Shutdown error, forcing exit:', e?.message);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
