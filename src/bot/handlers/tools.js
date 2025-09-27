// src/bot/handlers/tools.js
import { getParlaySlip, setParlaySlip, setUserState, getUserState } from '../state.js';

const toDecimalFromAmerican = (a) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
const toAmericanFromDecimal = (d) => (d >= 2 ? (d - 1) * 100 : -100 / (d - 1));
const impliedProbability = (d) => (d > 1 ? 1 / d : 0);

export function registerTools(bot) {
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

  bot.onText(/\/stake(?:\s+(\d+(?:\.\d+)?))?/, async (msg, m) => {
    const chatId = msg.chat.id;
    const val = m[1] ? parseFloat(m[1]) : NaN;
    if (!Number.isFinite(val) || val <= 0) {
      await setUserState(chatId, 'stake_input', 120);
      return bot.sendMessage(chatId, 'Enter a stake amount (number):');
    }
    const slip = await getParlaySlip(chatId);
    slip.stake = val;
    await setParlaySlip(chatId, slip);
    const { renderParlaySlip } = await import('./custom.js');
    await renderParlaySlip(bot, chatId);
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const state = await getUserState(chatId);
    if (state === 'stake_input') {
      const amount = parseFloat(msg.text.trim());
      if (!Number.isFinite(amount) || amount <= 0) {
        await bot.sendMessage(chatId, 'Enter a positive number for stake.');
      } else {
        const slip = await getParlaySlip(chatId);
        slip.stake = amount;
        await setParlaySlip(chatId, slip);
        await bot.sendMessage(chatId, `Stake set: $${amount.toFixed(2)}`);
        const { renderParlaySlip } = await import('./custom.js');
        await renderParlaySlip(bot, chatId);
      }
      await setUserState(chatId, 'none', 1);
    }
  });
}

export function registerCommonCallbacks(_bot) {
  // Reserved for future shared callbacks
}
