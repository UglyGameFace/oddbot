// src/bot/handlers/custom.js

import env from '../../config/env.js';
import {
  getBuilderConfig,
  getParlaySlip, setParlaySlip,
  saveToken, loadToken,
} from '../state.js';
import gamesService from '../../services/gamesService.js';
import redis from '../../services/redisService.js';
import {
  formatGameTimeTZ,
  toDecimalFromAmerican,
  toAmerican as toAmericanFromDecimal,
  impliedProbability,
} from '../../utils/enterpriseUtilities.js';

const tz = env.TIMEZONE || 'America/New_York';

const SPORT_TITLES = {
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA',
  baseball_mlb: 'MLB',
  football_nfl: 'NFL',
  hockey_nhl: 'NHL',
  icehockey_nhl: 'NHL',
  football_ncaaf: 'NCAAF',
  americanfootball_ncaaf: 'NCAAF',
};

const PREFERRED_FIRST = ['football_ncaaf', 'americanfootball_ncaaf'];
const DEPRIORITIZE_LAST = ['hockey_nhl', 'icehockey_nhl'];

const getSportEmoji = (key = '') =>
  key.includes('americanfootball') ? '🏈'
  : key.includes('basketball') ? '🏀'
  : key.includes('baseball') ? '⚾'
  : key.includes('icehockey') || key.includes('hockey') ? '🏒'
  : key.includes('soccer') ? '⚽'
  : '🏆';

function sortSports(sports) {
  const rank = (k) => {
    if (PREFERRED_FIRST.includes(k)) return -100;
    if (DEPRIORITIZE_LAST.includes(k)) return 100;
    return 0;
  };
  return [...(sports || [])].sort(
    (a, b) => rank(a?.sport_key || '') - rank(b?.sport_key || '')
  );
}

function applyFilters(games, { cutoffHours, excludedTeams }) {
  const ex = (excludedTeams || []).map((t) => t.toLowerCase());
  const now = Date.now();
  const horizon = cutoffHours && cutoffHours > 0 ? now + cutoffHours * 3600 * 1000 : Number.POSITIVE_INFINITY;
  return (games || []).filter((g) => {
    const t = new Date(g.commence_time).getTime();
    if (Number.isFinite(t) && t > horizon) return false;
    if (ex.length) {
      const a = (g.away_team || '').toLowerCase();
      const h = (g.home_team || '').toLowerCase();
      if (ex.some((e) => a.includes(e) || h.includes(e))) return false;
    }
    return true;
  });
}

// Normalize bookmakers whether coming straight from live odds or DB row
function getBookmakers(g) {
  return g?.bookmakers || g?.market_data?.bookmakers || [];
}

async function getCustomSelectedSports(chatId) {
  const redisClient = await redis;
  const s = await redisClient.get(`custom:sports:${chatId}`);
  return s ? JSON.parse(s) : [];
}

async function setCustomSelectedSports(chatId, arr) {
  const redisClient = await redis;
  await redisClient.set(`custom:sports:${chatId}`, JSON.stringify(arr), 'EX', 3600);
}

export function registerCustom(bot) {
  bot.onText(/\/custom/, async (msg) => sendCustomSportSelection(bot, msg.chat.id));
}

export function registerCustomCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('c')) return;
    const chatId = message.chat.id;
    try { await bot.answerCallbackQuery(cbq.id); } catch {}

    if (data === 'cback_sports') return sendCustomSportSelection(bot, chatId, message.message_id);

    if (data.startsWith('csp_')) {
      const tok = data.substring(4);
      const payload = await loadToken('csp', tok);
      if (payload?.sport_key) {
        const selected = new Set(await getCustomSelectedSports(chatId));
        if (selected.has(payload.sport_key)) selected.delete(payload.sport_key);
        else selected.add(payload.sport_key);
        await setCustomSelectedSports(chatId, Array.from(selected));
      }
      return sendCustomSportSelection(bot, chatId, message.message_id);
    }

    if (data === 'custom_sports_proceed') {
      return sendCustomGamesFromSelected(bot, chatId, message.message_id);
    }

    if (data.startsWith('cg_')) {
      const eventId = data.substring(3);
      return sendMarketSelection(bot, chatId, eventId, message.message_id);
    }

    if (data.startsWith('cm_')) {
      // cm_<eventId>_<marketKey or props>
      const parts = data.split('_');
      const eventId = parts[1];
      const marketKey = parts.slice(2).join('_');
      return sendPickSelection(bot, chatId, eventId, marketKey, message.message_id);
    }

    if (data.startsWith('cp_')) {
      const tok = data.substring(3);
      return handlePickToken(bot, chatId, tok, message.message_id);
    }

    if (data.startsWith('cslip_')) {
      const action = data.substring(6);
      const slip = await getParlaySlip(chatId);

      if (action === 'add') {
        try { if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId); } catch {}
        await setParlaySlip(chatId, { ...slip, messageId: null });
        return sendCustomSportSelection(bot, chatId);
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

      if (action === 'back') return renderParlaySlip(bot, chatId);

      if (data.startsWith('cslip_rm_')) {
        const idx = parseInt(data.substring('cslip_rm_'.length), 10);
        const slip2 = await getParlaySlip(chatId);
        if (Number.isInteger(idx) && idx >= 0 && idx < slip2.picks.length) {
          slip2.picks.splice(idx, 1);
          await setParlaySlip(chatId, slip2);
        }
        return renderParlaySlip(bot, chatId);
      }
    }
  });
}

async function sendCustomSportSelection(bot, chatId, messageId = null) {
  const sportsRaw = await gamesService.getAvailableSports();
  const sports = sortSports((sportsRaw || []).filter(s => s?.sport_key));
  if (!sports?.length) return bot.sendMessage(chatId, 'No upcoming games found. Please try again later.');

  const chosen = new Set(await getCustomSelectedSports(chatId));
  const rows = [];
  for (const s of sports) {
    const active = chosen.has(s.sport_key);
    const tok = await saveToken('csp', { sport_key: s.sport_key });
    const safeTitle = s?.sport_title ?? SPORT_TITLES[s.sport_key] ?? s.sport_key;
    const label = `${active ? '✅' : '☑️'} ${getSportEmoji(s.sport_key)} ${safeTitle}`;
    rows.push([{ text: label, callback_data: `csp_${tok}` }]);
  }
  rows.push([{ text: 'Proceed with selected', callback_data: 'custom_sports_proceed' }]);

  const text = '✍️ *Manual Parlay Builder*\n\nSelect sports (toggle), then proceed:';
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) return bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId });
  return bot.sendMessage(chatId, text, opts);
}

async function sendCustomGamesFromSelected(bot, chatId, messageId) {
  const selected = await getCustomSelectedSports(chatId);
  const sports = selected.length ? selected : (await gamesService.getAvailableSports()).map((s) => s.sport_key);
  const b = await getBuilderConfig(chatId);

  const perSport = await Promise.all(sports.map((k) => gamesService.getGamesForSport(k)));
  const pooled = applyFilters(perSport.flat(), { cutoffHours: b.cutoffHours, excludedTeams: b.excludedTeams });

  if (!pooled.length) {
    return bot.editMessageText('No upcoming games found for your selections/filters.', { chat_id: chatId, message_id: messageId });
  }

  const rows = pooled.slice(0, 10).map((g) => [{
    text: `${g.away_team} @ ${g.home_team} — ${formatGameTimeTZ(g.commence_time)}`,
    callback_data: `cg_${g.event_id || g.id || g.game_id}`
  }]);
  rows.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);

  await bot.editMessageText('Select a game:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
}

async function sendMarketSelection(bot, chatId, eventId, messageId) {
  const g = await gamesService.getGameDetails(eventId);
  const bks = getBookmakers(g);
  if (!bks?.length) {
    return bot.editMessageText('Could not find market data.', { chat_id: chatId, message_id: messageId });
  }
  const keys = (bks[0]?.markets || []).map((m) => m.key);
  const row = [];
  if (keys.includes('h2h')) row.push({ text: 'Moneyline', callback_data: `cm_${g.event_id}_h2h` });
  if (keys.includes('spreads')) row.push({ text: 'Spreads', callback_data: `cm_${g.event_id}_spreads` });
  if (keys.includes('totals')) row.push({ text: 'Totals', callback_data: `cm_${g.event_id}_totals` });

  const rows = [row, [{ text: '« Back to Games', callback_data: 'custom_sports_proceed' }]];
  await bot.editMessageText(
    `*${g.away_team} @ ${g.home_team}*\n${formatGameTimeTZ(g.commence_time)}\n\nSelect a market:`,
    { parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }
  );
}

async function sendPickSelection(bot, chatId, eventId, marketKey, messageId) {
  const g = await gamesService.getGameDetails(eventId);
  const bks = getBookmakers(g);
  const m = bks?.[0]?.markets?.find((x) => x.key === marketKey);
  if (!m) {
    return bot.editMessageText('Market not available.', { chat_id: chatId, message_id: messageId });
  }

  const rows = [];
  for (const o of m.outcomes || []) {
    const tok = await saveToken('cp', {
      gameId: g.event_id, marketKey, name: o.name, point: o.point ?? 0, price: o.price,
      gameLabel: `${g.away_team} @ ${g.home_team}`, commence_time: g.commence_time || null
    });
    const pointText = o.point ? (o.point > 0 ? `+${o.point}` : `${o.point}`) : '';
    const priceText = o.price > 0 ? `+${o.price}` : `${o.price}`;
    rows.push([{ text: `${o.name} ${pointText} (${priceText})`, callback_data: `cp_${tok}` }]);
  }
  rows.push([{ text: '« Back to Markets', callback_data: `cg_${g.event_id}` }]);

  await bot.editMessageText(`Select your pick for *${marketKey}*:`, {
    parse_mode: 'Markdown', chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }
  });
}

async function handlePickToken(bot, chatId, tok, messageId) {
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
  slip.picks.push({
    game: p.gameLabel, selection: `${p.name} ${pointText}`.trim(), odds: parseInt(p.price, 10),
    marketKey: p.marketKey, gameId: p.gameId, commence_time: p.commence_time || null
  });

  await setParlaySlip(chatId, slip);
  try { await bot.deleteMessage(chatId, messageId); } catch {}
  await renderParlaySlip(bot, chatId);
}

async function renderParlaySlip(bot, chatId) {
  const slip = await getParlaySlip(chatId);
  if (!slip.messageId) {
    const sent = await bot.sendMessage(chatId, 'Initializing your parlay slip...');
    slip.messageId = sent.message_id;
  }

  if (!slip.picks.length) {
    try { await bot.deleteMessage(chatId, slip.messageId); } catch {}
    await setParlaySlip(chatId, { picks: [], stake: slip.stake || 10, messageId: null, totalOdds: 0 });
    return sendCustomSportSelection(bot, chatId);
  }

  const groups = {};
  for (const p of slip.picks) {
    if (!groups[p.game]) groups[p.game] = { commence_time: p.commence_time || null, picks: [] };
    groups[p.game].picks.push(p);
    if (!groups[p.game].commence_time && p.gameId) {
      const det = await gamesService.getGameDetails(p.gameId);
      groups[p.game].commence_time = det?.commence_time || groups[p.game].commence_time;
    }
  }

  let text = '✍️ *Your Custom Parlay*\n\n';
  let totalDecimal = 1;
  slip.picks.forEach((p) => { totalDecimal *= toDecimalFromAmerican(p.odds); });
  const totAm = Math.round(toAmericanFromDecimal(totalDecimal));
  const profit = (slip.stake || 0) * (totalDecimal - 1);
  const prob = impliedProbability(totalDecimal);
  slip.totalOdds = totAm;

  Object.entries(groups).forEach(([game, info]) => {
    const timeStr = info.commence_time ? formatGameTimeTZ(info.commence_time) : '';
    text += `*${game}*${timeStr ? ` — ${timeStr}` : ''}\n`;
    info.picks.forEach((p) => { text += `• ${p.selection} (${p.odds > 0 ? '+' : ''}${p.odds})\n`; });
    text += `\n`;
  });

  text += `*Total Legs*: ${slip.picks.length}\n*Total Odds*: ${totAm > 0 ? '+' : ''}${totAm}\n*Stake*: $${Number(slip.stake || 0).toFixed(2)}\n*Projected Profit*: $${profit.toFixed(2)}\n*Implied Prob*: ${(prob * 100).toFixed(2)}%`;

  const rows = [
    [{ text: '➕ Add Another Leg', callback_data: 'cslip_add' }],
    [{ text: '🧹 Remove a Leg', callback_data: 'cslip_manage' }, { text: `🗑️ Clear (${slip.picks.length})`, callback_data: 'cslip_clear' }],
    [{ text: `💵 Stake: $${Number(slip.stake || 0).toFixed(2)}`, callback_data: 'cslip_stake' }],
  ];

  await bot.editMessageText(text, { parse_mode: 'Markdown', chat_id: chatId, message_id: slip.messageId, reply_markup: { inline_keyboard: rows } });
  await setParlaySlip(chatId, slip);
}
