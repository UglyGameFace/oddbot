// src/bot/handlers/ai.js
// Complete handler with verified-game gating, strict rendering guard, and safe edit utilities.
// This file is designed to be a drop-in replacement that preserves existing UX and improves robustness.

import quantumAIService from '../../services/aiService.js';
import gamesService from '../../services/gamesService.js';
import * as sportsSvc from '../../services/sportsService.js';
import { sentryService } from '../../services/sentryService.js';

// Fallback title resolver if services/sportsService.js does not export getSportTitle
const getSportTitle =
  sportsSvc.getSportTitle ||
  ((sportKey) => {
    if (!sportKey || typeof sportKey !== 'string') return 'Sports';
    return sportKey
      .replace(/^.*?_/, '') // drop leading group if present (e.g., "americanfootball_nfl" -> "nfl")
      .replace(/_/g, ' ')
      .toUpperCase();
  });

// Minimal HTML escaper for Telegram
const escapeHTML = (t) =>
  String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Safe message edit wrapper with common Telegram failure handling
async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    });
  } catch (err) {
    const msg = err?.response?.body || err?.message || String(err);
    // Message not modified: ignore
    if (typeof msg === 'string' && msg.toLowerCase().includes('message is not modified')) {
      return null;
    }
    // If the message to edit no longer exists, send a new message instead of failing
    if (typeof msg === 'string' && msg.toLowerCase().includes('message to edit not found')) {
      return await bot.sendMessage(chatId, text, options);
    }
    // Fallback: rethrow so upstream can capture/report
    throw err;
  }
}

// Gate AI legs to verified events before rendering
async function gateLegsToVerified(legs, sportKey, horizonHours, gameContext) {
  const verified = await gamesService.getVerifiedRealGames(sportKey, horizonHours || 72);
  if (!Array.isArray(verified) || verified.length === 0) return [];

  const idSet = new Set(
    verified
      .map((g) => g.event_id ?? g.id)
      .filter((x) => typeof x === 'string' || typeof x === 'number')
  );
  const nameSet = new Set(
    verified.map((g) => `${g.away_team} @ ${g.home_team}`.toLowerCase())
  );

  const filtered = (legs || []).filter((l) => {
    // Prefer explicit id match
    if (typeof l.game_id === 'string' || typeof l.game_id === 'number') {
      return idSet.has(l.game_id);
    }
    // Fallback to event-name match
    if (typeof l.event === 'string' && l.event.trim().length > 0) {
      return nameSet.has(l.event.toLowerCase());
    }
    // If a focused game was selected by the user, allow AI to auto-assign
    if (gameContext && typeof l.selection === 'string') {
      return true;
    }
    return false;
  });

  // Normalize any legs missing event name when a focused context exists
  if (gameContext) {
    for (const leg of filtered) {
      if (!leg.event || leg.event.trim() === '') {
        leg.event = `${gameContext.away_team} @ ${gameContext.home_team}`;
      }
      if (!leg.commence_time && gameContext.commence_time) {
        leg.commence_time = gameContext.commence_time;
      }
    }
  }

  return filtered;
}

// Format a parlay for Telegram output
function formatParlayText(parlay, sportKey, numLegs) {
  const {
    legs = [],
    parlay_price_american,
    quantitative_analysis,
    research_metadata,
    portfolio_construction,
    validation,
  } = parlay;

  const sportTitle = getSportTitle(sportKey);
  const lines = [];

  lines.push(`🎯 <b>${escapeHTML(sportTitle)} Parlay</b> (${legs.length} legs)`);
  if (Number.isFinite(Number(parlay_price_american))) {
    const pa = Number(parlay_price_american);
    lines.push(`📈 Price: ${pa > 0 ? '+' : ''}${pa}`);
  }
  if (validation?.qualityScore != null) {
    lines.push(`✅ Validation quality: ${Math.round(validation.qualityScore)}%`);
  }

  if (legs.length > 0) lines.push('');
  legs.forEach((leg, i) => {
    const price = Number(leg.odds?.american);
    const priceStr = Number.isFinite(price) ? (price > 0 ? `+${price}` : `${price}`) : 'N/A';
    const market = typeof leg.market === 'string' ? leg.market : 'market';
    const selection = typeof leg.selection === 'string' ? leg.selection : 'selection';
    const event = typeof leg.event === 'string' ? leg.event : '';
    lines.push(
      `${i + 1}) ${escapeHTML(event)}
   • ${escapeHTML(market)} — ${escapeHTML(selection)} (${priceStr})`
    );
  });

  if (quantitative_analysis?.note) {
    lines.push('');
    lines.push(`🧮 ${escapeHTML(quantitative_analysis.note)}`);
  }

  if (portfolio_construction?.overall_thesis) {
    lines.push('');
    lines.push(`📚 ${escapeHTML(portfolio_construction.overall_thesis)}`);
  }

  if (research_metadata?.generation_strategy) {
    lines.push('');
    lines.push(`🧭 Strategy: ${escapeHTML(research_metadata.generation_strategy)}`);
  }

  return lines.join('\n');
}

// Render or fail closed with a retry CTA
async function renderOrRetry(bot, chatId, messageId, sportKey, numLegs, parlay, state) {
  const { horizonHours, gameContext } = state;
  const gatedLegs = await gateLegsToVerified(parlay.legs || [], sportKey, horizonHours, gameContext);

  if (!gatedLegs || gatedLegs.length < numLegs) {
    const errorText = `❌ Could not verify enough real games to construct a ${numLegs}-leg parlay for ${escapeHTML(
      getSportTitle(sportKey)
    )}. Please try again shortly.`;
    await safeEditMessage(bot, chatId, messageId, errorText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: `ai_retry_${sportKey}` }],
          [{ text: '« Change Game', callback_data: 'ai_back_game' }],
        ],
      },
    });
    return;
  }

  // Replace legs with gated subset before formatting
  const finalParlay = { ...parlay, legs: gatedLegs };
  const text = formatParlayText(finalParlay, sportKey, numLegs);
  await safeEditMessage(bot, chatId, messageId, text, { parse_mode: 'HTML' });
}

// Exported registration function
export function registerAI(bot) {
  // Slash command entry point
  bot.onText(/\/(?:ai|parlay)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const query = (match && match[1]) || '';

    // Basic defaults; in your app, this likely comes from stateManager/getAIConfig
    const state = {
      sportKey: 'americanfootball_nfl',
      numLegs: 3,
      horizonHours: 72,
      gameContext: null, // Fill when the user selects a specific matchup
    };

    try {
      const waiting = await bot.sendMessage(chatId, '🔎 Building a strictly verified parlay...', {
        reply_to_message_id: messageId,
      });

      const parlay = await quantumAIService.generateParlay(
        state.sportKey,
        state.numLegs,
        'web', // mode
        'sonar-pro', // model tag for provider-side routing
        'mixed', // betType
        { chatId, horizonHours: state.horizonHours, gameContext: state.gameContext }
      );

      await renderOrRetry(bot, chatId, waiting.message_id, state.sportKey, state.numLegs, parlay, state);
    } catch (error) {
      try {
        sentryService.captureException?.(error);
      } catch (_) {
        // no-op
      }
      const errorMessage = `❌ ${escapeHTML(error?.message || 'AI generation failed')}`;
      await safeEditMessage(bot, chatId, messageId, errorMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: `ai_back` }],
            [{ text: '« Change Game', callback_data: 'ai_back_game' }],
          ],
        },
      });
    }
  });
}

// ** NEW FUNCTION TO HANDLE CALLBACKS **
export function registerAICallbacks(bot) {
  bot.on('callback_query', async (cq) => {
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    const data = cq.data || '';

    if (!chatId || !messageId || !data) return;

    if (data.startsWith('ai_retry_')) {
      const sportKey = data.replace('ai_retry_', '') || 'americanfootball_nfl';
      const state = {
        sportKey,
        numLegs: 3,
        horizonHours: 72,
        gameContext: null,
      };

      try {
        await safeEditMessage(bot, chatId, messageId, '🔄 Retrying with strict verification...', {
          parse_mode: 'HTML',
        });

        const parlay = await quantumAIService.generateParlay(
          state.sportKey,
          state.numLegs,
          'web',
          'sonar-pro',
          'mixed',
          { chatId, horizonHours: state.horizonHours, gameContext: state.gameContext }
        );

        await renderOrRetry(bot, chatId, messageId, state.sportKey, state.numLegs, parlay, state);
      } catch (error) {
        try {
          sentryService.captureException?.(error);
        } catch (_) {
          // no-op
        }
        const errorMessage = `❌ ${escapeHTML(error?.message || 'Retry failed')}`;
        await safeEditMessage(bot, chatId, messageId, errorMessage, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: `ai_retry_${sportKey}` }],
              [{ text: '« Change Game', callback_data: 'ai_back_game' }],
            ],
          },
        });
      }
    }
    // You can add more 'if' conditions here for other AI-related callbacks like 'ai_back_game'
  });
}

// ** UPDATED DEFAULT EXPORT **
export default {
  registerAI,
  registerAICallbacks, // Add the new function here
};
