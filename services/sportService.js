 import * as sportRepository from '../repositories/sportRepository.js';

// A mapping to make sport keys user-friendly. This can be expanded easily.
const SPORT_NAME_MAP = {
    'nfl': '🏈 NFL',
    'nba': '🏀 NBA',
    'mlb': '⚾ MLB',
    'nhl': '🏒 NHL',
    'epl': '⚽ EPL',
    'uefa_champions_league': '⚽ Champions League',
    // Add other sports here
};

/**
 * Generates an inline keyboard object for selecting an active sport.
 * @returns {Promise<object>} A Telegram inline keyboard markup object.
 */
export const generateSportSelectionKeyboard = async () => {
    try {
        const activeSports = await sportRepository.getActiveSports();

        if (activeSports.length === 0) {
            return {
                text: "There are currently no upcoming games available to analyze. Please check back later.",
                options: {}
            };
        }

        const keyboardButtons = activeSports.map(key => {
            return {
                text: SPORT_NAME_MAP[key] || key.toUpperCase(), // Fallback to uppercase key if not in map
                callback_data: `select_sport_${key}`
            };
        });

        // Arrange buttons into rows of 2 for a clean look
        const rows = [];
        for (let i = 0; i < keyboardButtons.length; i += 2) {
            rows.push(keyboardButtons.slice(i, i + 2));
        }

        return {
            text: "Excellent. Let's find an edge. Select a sport below to see upcoming games:",
            options: {
                reply_markup: {
                    inline_keyboard: rows
                }
            }
        };

    } catch (error) {
        console.error("Error generating sport selection keyboard:", error);
        // Return a user-facing error message and an empty keyboard
        return {
            text: "I'm having trouble fetching the list of available sports right now. Please try again in a moment.",
            options: {}
        };
    }
};
