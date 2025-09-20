// src/handlers/callbackHandler.js

import { bot } from '../config/botClient.js';
import { generateSportSelectionKeyboard } from '../services/sportService.js';
import { generateGameListMessage } from '../services/gameService.js';

const verifiedUsers = new Set(); // This will be replaced by a database check.

const handleAgeGateCallback = async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    bot.answerCallbackQuery(callbackQuery.id);
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msg.message_id });

    if (callbackQuery.data === 'age_gate_yes') {
        verifiedUsers.add(userId);
        const { text, options } = await generateSportSelectionKeyboard();
        bot.sendMessage(chatId, text, options);
    } else {
        bot.sendMessage(chatId, "You must be of legal age to use this bot. Access is restricted.");
    }
};

const handleNavigationCallback = async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    bot.answerCallbackQuery(callbackQuery.id);
    
    if (callbackQuery.data === 'back_to_sports') {
        const { text, options } = await generateSportSelectionKeyboard();
        bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, ...options });
    }
};

const handleSportSelectionCallback = async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const sportKey = callbackQuery.data.split('_')[2];
    bot.answerCallbackQuery(callbackQuery.id, { text: `Fetching ${sportKey.toUpperCase()} games...` });
    
    const { text, options } = await generateGameListMessage(sportKey);
    bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, ...options });
};

const handleGameSelectionCallback = async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const eventId = callbackQuery.data.substring('select_game_'.length);
    bot.answerCallbackQuery(callbackQuery.id);

    // This is the entry point for the AI analysis feature.
    // The message is edited to show the user their selection is being processed.
    const loadingText = `${msg.text}\n\n---\n**Analyzing game...**`;
    bot.editMessageText(loadingText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] } // Remove buttons while processing
    });
    
    // In the next phase, this will trigger the dual-AI analysis.
    // For now, it confirms the action is complete.
    // This will be replaced by the actual AI analysis result.
    setTimeout(() => {
        bot.sendMessage(chatId, `AI analysis for game ID ${eventId} would appear here.`);
    }, 1000);
};

export const initializeCallbackHandlers = () => {
    bot.on('callback_query', (callbackQuery) => {
        const data = callbackQuery.data;
        if (data.startsWith('age_gate_')) {
            handleAgeGateCallback(callbackQuery);
        } else if (data.startsWith('select_sport_')) {
            handleSportSelectionCallback(callbackQuery);
        } else if (data.startsWith('select_game_')) {
            handleGameSelectionCallback(callbackQuery);
        } else if (data.startsWith('back_to_')) {
            handleNavigationCallback(callbackQuery);
        }
    });
    console.log("Callback query handlers initialized.");
};

export const isUserVerified = (userId) => {
    return verifiedUsers.has(userId);
};
