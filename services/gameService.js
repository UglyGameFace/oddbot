// src/services/gameService.js

import * as gameRepository from '../repositories/gameRepository.js';
import { formatGameTime } from '../utils/dateFormatter.js';

const backToSportsButton = [{ text: '« Back to Sports', callback_data: 'back_to_sports' }];

/**
 * Generates the complete message object (text and keyboard) for displaying a list of games.
 * @param {string} sportKey The sport key selected by the user.
 * @returns {Promise<object>} An object containing the message text and Telegram options.
 */
export const generateGameListMessage = async (sportKey) => {
    try {
        const games = await gameRepository.getUpcomingGamesBySport(sportKey);

        if (!games || games.length === 0) {
            return {
                text: `No upcoming ${sportKey.toUpperCase()} games were found. Please check back later or select another sport.`,
                options: {
                    reply_markup: {
                        inline_keyboard: [backToSportsButton]
                    }
                }
            };
        }

        let messageText = `Here are the next ${games.length} upcoming **${sportKey.toUpperCase()}** games. Select one to analyze:\n\n`;
        
        const gameButtons = games.map(game => {
            const gameTime = formatGameTime(game.commence_time);
            // Add to the main message text
            messageText += `▫️ ${game.away_team} at ${game.home_team}\n   _${gameTime}_\n`;
            
            // Return the button object for the keyboard
            return {
                text: `${game.away_team} @ ${game.home_team}`,
                callback_data: `select_game_${game.event_id}`
            };
        });

        // Arrange game buttons into rows of 1 for clarity
        const keyboard = gameButtons.map(button => [button]);
        keyboard.push(backToSportsButton); // Add the navigation button at the end

        return {
            text: messageText,
            options: {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            }
        };

    } catch (error) {
        console.error("Error in generateGameListMessage service:", error);
        return {
            text: `An error occurred while fetching games for ${sportKey.toUpperCase()}. Please try again.`,
            options: {
                reply_markup: {
                    inline_keyboard: [backToSportsButton]
                }
            }
        };
    }
};
