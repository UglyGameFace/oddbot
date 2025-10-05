// src/bot/handlers/custom.js - FULLY IMPLEMENTED
import env from '../../config/env.js';
import { getBuilderConfig, getParlaySlip, setParlaySlip, saveToken, loadToken } from '../state.js';
import gamesService from '../../services/gamesService.js';
import redis from '../../services/redisService.js';
import { getSportEmoji, getSportTitle, sortSports } from '../../services/sportsService.js';
import { formatGameTimeTZ, toDecimalFromAmerican, toAmericanFromDecimal } from '../../utils/botUtils.js';
import { safeEditMessage } from '../../utils/asyncUtils.js';

const tz = env.TIMEZONE || 'America/New_York';

function applyFilters(games, { cutoffHours, excludedTeams }) {
    const ex = (excludedTeams || []).map((t) => t.toLowerCase());
    const now = Date.now();
    const horizon = cutoffHours && cutoffHours > 0 ? now + cutoffHours * 3600 * 1000 : Infinity;
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
    bot.onText(/\/custom/, (msg) => sendCustomSportSelection(bot, msg.chat.id));
}

export function registerCustomCallbacks(bot) {
    bot.on('callback_query', async (cbq) => {
        const { data, message } = cbq || {};
        if (!data || !message || !data.startsWith('c')) return;
        const chatId = message.chat.id;
        await bot.answerCallbackQuery(cbq.id).catch(() => {});

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
                if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId).catch(() => {});
                await setParlaySlip(chatId, { ...slip, messageId: null });
                return sendCustomSportSelection(bot, chatId);
            }
            if (action === 'clear') {
                if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId).catch(() => {});
                await setParlaySlip(chatId, { picks: [], messageId: null, stake: slip.stake || 10 });
                return bot.sendMessage(chatId, 'Parlay slip cleared.');
            }
            if (action.startsWith('rm_')) {
                const idx = parseInt(action.substring(3), 10);
                if (Number.isInteger(idx) && idx >= 0 && idx < slip.picks.length) {
                    slip.picks.splice(idx, 1);
                    await setParlaySlip(chatId, slip);
                }
                return renderParlaySlip(bot, chatId);
            }
        }
    });
}

async function sendCustomSportSelection(bot, chatId, messageId = null) {
    const sportsRaw = await gamesService.getAvailableSports();
    const sports = sortSports((sportsRaw || []).filter(s => s?.sport_key));
    if (!sports?.length) return bot.sendMessage(chatId, 'No upcoming games found.');

    const chosen = new Set(await getCustomSelectedSports(chatId));
    const rows = [];
    for (const s of sports) {
        const tok = await saveToken('csp', { sport_key: s.sport_key });
        rows.push([{ text: `${chosen.has(s.sport_key) ? '✅' : '☑️'} ${getSportEmoji(s.sport_key)} ${getSportTitle(s.sport_key)}`, callback_data: `csp_${tok}` }]);
    }
    rows.push([{ text: `▶️ Proceed (${chosen.size} Selected)`, callback_data: 'custom_sports_proceed' }]);
    const text = '✍️ *Manual Parlay Builder*\n\nSelect sports, then proceed:';
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
    if (messageId) return safeEditMessage(bot, chatId, messageId, text, opts);
    return bot.sendMessage(chatId, text, opts);
}

async function sendCustomGamesFromSelected(bot, chatId, messageId) {
    const selected = await getCustomSelectedSports(chatId);
    if (selected.length === 0) {
        return safeEditMessage(bot, chatId, messageId, 'You must select at least one sport.', { reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'cback_sports' }]] } });
    }
    const config = await getBuilderConfig(chatId);
    const allGames = (await Promise.all(selected.map(k => gamesService.getGamesForSport(k)))).flat();
    const filteredGames = applyFilters(allGames, { cutoffHours: config.cutoffHours });

    if (!filteredGames.length) {
        return safeEditMessage(bot, chatId, messageId, 'No games found for your selected sports/filters.', { reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'cback_sports' }]] } });
    }
    const rows = filteredGames.slice(0, 20).map(g => ([{
        text: `${g.away_team} @ ${g.home_team} | ${formatGameTimeTZ(g.commence_time)}`,
        callback_data: `cg_${g.id || g.event_id}`
    }]));
    rows.push([{ text: '« Back to Sports', callback_data: 'cback_sports' }]);
    await safeEditMessage(bot, chatId, messageId, 'Select a game:', { reply_markup: { inline_keyboard: rows } });
}

async function sendMarketSelection(bot, chatId, eventId, messageId) {
    const games = await gamesService.getGamesForSport(null);
    const game = games.find(g => (g.id || g.event_id) === eventId);
    if (!game) return safeEditMessage(bot, chatId, messageId, 'Game not found.');

    const bks = getBookmakers(game);
    if (!bks?.length) return safeEditMessage(bot, chatId, messageId, 'No market data found for this game.');
    
    const marketKeys = new Set(bks.flatMap(b => b.markets?.map(m => m.key) || []));
    const keyboard = [];
    if (marketKeys.has('h2h')) keyboard.push([{ text: 'Moneyline', callback_data: `cm_${eventId}_h2h` }]);
    if (marketKeys.has('spreads')) keyboard.push([{ text: 'Spreads', callback_data: `cm_${eventId}_spreads` }]);
    if (marketKeys.has('totals')) keyboard.push([{ text: 'Totals', callback_data: `cm_${eventId}_totals` }]);
    keyboard.push([{ text: '« Back to Games', callback_data: 'custom_sports_proceed' }]);

    const text = `*${game.away_team} @ ${game.home_team}*\nSelect a market:`;
    await safeEditMessage(bot, chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

async function sendPickSelection(bot, chatId, eventId, marketKey, messageId) {
    const games = await gamesService.getGamesForSport(null);
    const game = games.find(g => (g.id || g.event_id) === eventId);
    if (!game) return safeEditMessage(bot, chatId, messageId, 'Game not found.');
    
    const bks = getBookmakers(game);
    const market = bks[0]?.markets?.find(m => m.key === marketKey);
    if (!market?.outcomes) return safeEditMessage(bot, chatId, messageId, 'Market outcomes not available.');

    const rows = [];
    for (const o of market.outcomes) {
        const payload = {
            gameId: eventId, marketKey, name: o.name, point: o.point, price: o.price,
            gameLabel: `${game.away_team} @ ${game.home_team}`, commence_time: game.commence_time
        };
        const token = await saveToken('cp', payload, 600);
        const pointText = o.point ? (o.point > 0 ? `+${o.point}` : o.point) : '';
        const priceText = o.price > 0 ? `+${o.price}` : o.price;
        rows.push([{ text: `${o.name} ${pointText} (${priceText})`, callback_data: `cp_${token}` }]);
    }
    rows.push([{ text: '« Back to Markets', callback_data: `cg_${eventId}` }]);
    await safeEditMessage(bot, chatId, messageId, `Select your pick for *${marketKey}*:`, {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows }
    });
}

async function handlePickToken(bot, chatId, tok, messageId) {
    const p = await loadToken('cp', tok);
    if (!p) return bot.sendMessage(chatId, 'Selection expired. Please choose again.');

    const config = await getBuilderConfig(chatId);
    const slip = await getParlaySlip(chatId);

    if (config.avoidSameGame && slip.picks.some(pick => pick.gameId === p.gameId)) {
        return bot.sendMessage(chatId, 'Same-game legs are disabled (see /settings).');
    }

    const pointText = p.point ? (p.point > 0 ? `+${p.point}` : p.point) : '';
    slip.picks.push({
        game: p.gameLabel,
        selection: `${p.name} ${pointText}`.trim(),
        odds: parseInt(p.price, 10),
        marketKey: p.marketKey,
        gameId: p.gameId,
        commence_time: p.commence_time
    });
    await setParlaySlip(chatId, slip);
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    await renderParlaySlip(bot, chatId);
}

async function renderParlaySlip(bot, chatId) {
    const slip = await getParlaySlip(chatId);
    if (slip.messageId) await bot.deleteMessage(chatId, slip.messageId).catch(() => {});
    
    if (!slip.picks.length) {
        await setParlaySlip(chatId, { picks: [], stake: slip.stake || 10, messageId: null });
        return sendCustomSportSelection(bot, chatId);
    }

    let totalDecimal = 1;
    slip.picks.forEach(p => { totalDecimal *= toDecimalFromAmerican(p.odds); });
    const totalAmerican = Math.round(toAmericanFromDecimal(totalDecimal));
    const profit = (slip.stake || 10) * (totalDecimal - 1);
    
    let text = '✍️ *Your Custom Parlay*\n\n';
    slip.picks.forEach((p, i) => {
        text += `*Leg ${i+1}:* ${p.game}\n  • ${p.selection} (${p.odds > 0 ? '+' : ''}${p.odds})\n`;
    });
    text += `\n*Total Odds*: ${totalAmerican > 0 ? '+' : ''}${totalAmerican}\n*Potential Profit*: $${profit.toFixed(2)}`;

    const keyboard = [
        [{ text: '➕ Add Another Leg', callback_data: 'cslip_add' }],
        ...slip.picks.map((p, i) => ([{ text: `❌ Remove: ${p.selection.slice(0, 20)}...`, callback_data: `cslip_rm_${i}` }])),
        [{ text: '🗑️ Clear All', callback_data: 'cslip_clear' }]
    ];
    
    const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    await setParlaySlip(chatId, { ...slip, messageId: sent.message_id });
}
