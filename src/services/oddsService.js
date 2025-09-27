// src/bot/handlers/ai.js
import env from '../config/env.js';
import AIService from '../services/aiService.js';
import { getAIConfig, setAIConfig, getBuilderConfig } from '../../state.js';
import oddsService from '../services/oddsService.js';

const tz = env.TIMEZONE || 'America/New_York';
const formatGameTimeTZ = (iso) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
});
const toDecimalFromAmerican = (a) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
const toAmericanFromDecimal = (d) => (d >= 2 ? (d - 1) * 100 : -100 / (d - 1));

function applyFilters(games, { cutoffHours, excludedTeams }) {
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

export function registerAI(bot) {
  bot.onText(/\/parlay/, async (msg) => sendAIConfigurationMenu(bot, msg.chat.id));
}

export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message) return;
    const chatId = message.chat.id;

    try { await bot.answerCallbackQuery(cbq.id); } catch {}

    if (data === 'cfg_main') return sendAIConfigurationMenu(bot, chatId, message.message_id);
    if (data === 'cfg_l_menu') return sendAILegsMenu(bot, chatId, message.message_id);
    if (data.startsWith('cfg_l_set_')) {
      const n = parseInt(data.split('_').pop(), 10);
      const cfg = await getAIConfig(chatId);
      if (Number.isFinite(n) && n >= 2 && n <= 20) cfg.legs = n;
      await setAIConfig(chatId, cfg);
      return sendAIConfigurationMenu(bot, chatId, message.message_id);
    }
    if (data === 'cfg_s_menu') return sendAIStrategyMenu(bot, chatId, message.message_id);
    if (data.startsWith('cfg_s_set_')) {
      const st = data.split('_').slice(3).join('_');
      const cfg = await getAIConfig(chatId);
      if (['conservative', 'balanced', 'aggressive'].includes(st)) cfg.strategy = st;
      await setAIConfig(chatId, cfg);
      return sendAIConfigurationMenu(bot, chatId, message.message_id);
    }
    if (data === 'cfg_p_tgl') {
      const cfg = await getAIConfig(chatId);
      cfg.includeProps = !cfg.includeProps;
      await setAIConfig(chatId, cfg);
      return sendAIConfigurationMenu(bot, chatId, message.message_id);
    }
    if (data === 'cfg_sp_menu') return sendAISportsMenu(bot, chatId, message.message_id);
    if (data === 'cfgsp_all') {
      const cfg = await getAIConfig(chatId);
      cfg.sports = [];
      await setAIConfig(chatId, cfg);
      return sendAISportsMenu(bot, chatId, message.message_id);
    }
    if (data === 'cfg_build') {
      const cfg = await getAIConfig(chatId);
      return handleAIBuild(bot, chatId, cfg, message.message_id);
    }
  });
}

async function sendAIConfigurationMenu(bot, chatId, messageId = null) {
  const cfg = await getAIConfig(chatId);
  const sportsText = cfg.sports?.length ? `${cfg.sports.length} selected` : 'All';
  const text = `*✨ AI Analyst Parlay*\n\nConfigure legs/strategy/props/sports; AI uses fresh cached odds respecting your filters.`;
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

async function sendAILegsMenu(bot, chatId, messageId) {
  const legs = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const grid = [];
  for (let i = 0; i < legs.length; i += 3) grid.push(legs.slice(i, i + 3).map((n) => ({ text: `${n} legs`, callback_data: `cfg_l_set_${n}` })));
  grid.push([{ text: '« Back', callback_data: 'cfg_main' }]);
  await bot.editMessageText('*Select number of legs:*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: grid } });
}

async function sendAIStrategyMenu(bot, chatId, messageId) {
  const strategies = ['conservative', 'balanced', 'aggressive'];
  const rows = [strategies.map((s) => ({ text: s[0].toUpperCase() + s.slice(1), callback_data: `cfg_s_set_${s}` })), [{ text: '« Back', callback_data: 'cfg_main' }]];
  await bot.editMessageText('*Select strategy:*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

async function sendAISportsMenu(bot, chatId, messageId) {
  const all = await oddsService.getAvailableSportsCached();
  const cfg = await getAIConfig(chatId);
  const selected = new Set(cfg.sports || []);
  const rows = [];
  for (const s of all) {
    const active = selected.has(s.sport_key);
    rows.push([{ text: `${active ? '✅' : '☑️'} ${s.sport_title}`, callback_data: `cfgsp_toggle_${s.sport_key}` }]);
  }
  rows.push([{ text: 'All Sports', callback_data: 'cfgsp_all' }]);
  rows.push([{ text: '« Back', callback_data: 'cfg_main' }]);
  await bot.editMessageText('*Select sports (toggle):*', { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

const AI_BUILD_MIN_INTERVAL_MS = 60000;

async function handleAIBuild(bot, chatId, cfg, messageId) {
  const limKey = `rl:ai:${chatId}`;
  const { default: r } = await import('../../services/redisService.js');
  const last = Number(await r.get(limKey));
  const now = Date.now();
  if (last && now - last < AI_BUILD_MIN_INTERVAL_MS) {
    await bot.sendMessage(chatId, '⏳ Please wait before requesting another AI build.');
    return;
  }
  await r.set(limKey, now, 'EX', Math.ceil(AI_BUILD_MIN_INTERVAL_MS / 1000));

  try {
    await bot.editMessageText('🤖 Accessing current market data and running deep quantitative analysis...', { chat_id: chatId, message_id: messageId, reply_markup: null });
  } catch {}

  try {
    const allSports = await oddsService.getAvailableSportsCached();
    const sportKeys = cfg.sports?.length ? cfg.sports : allSports.map((s) => s.sport_key);
    const perSport = await Promise.all(sportKeys.map((k) => oddsService.getGamesForSportCached(k)));
    let pooled = perSport.flat();

    const b = await getBuilderConfig(chatId);
    pooled = applyFilters(pooled, { cutoffHours: b.cutoffHours, excludedTeams: b.excludedTeams });

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

    const byGame = {};
    parlay.legs.forEach((leg) => {
      if (!byGame[leg.game]) byGame[leg.game] = { legs: [], commence_time: leg.commence_time, sport: leg.sport };
      byGame[leg.game].legs.push(leg);
      if (!byGame[leg.game].commence_time && leg.commence_time) byGame[leg.game].commence_time = leg.commence_time;
    });

    let out = `📈 *${parlay.title || 'AI-Generated Parlay'}*\n\n_${parlay.overall_narrative}_\n\n`;
    Object.entries(byGame).forEach(([game, info]) => {
      const timeStr = info.commence_time ? formatGameTimeTZ(info.commence_time) : '';
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
    await bot.sendMessage(chatId, `🚨 AI analysis failed.\n\n_Error: ${err.message}_`);
    try { await bot.deleteMessage(chatId, messageId); } catch {}
  }
}
