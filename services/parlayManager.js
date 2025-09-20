// src/services/parlayManager.js

// A Map to store pending parlays, with the user's Telegram ID as the key.
const pendingParlays = new Map();

/**
 * Adds a bet (leg) to a user's pending parlay slip.
 * @param {number} userId The user's Telegram ID.
 * @param {object} leg The leg object to add.
 * @returns {object} The updated parlay slip.
 */
export const addLegToSlip = (userId, leg) => {
    const slip = pendingParlays.get(userId) || { legs: [], totalDecimalOdds: 1.0 };

    // Prevent adding the exact same leg twice
    const existingLeg = slip.legs.find(l => l.eventId === leg.eventId && l.selection === leg.selection);
    if (existingLeg) {
        return slip; // Or you could return an error/message
    }

    slip.legs.push(leg);

    // Calculate new total odds
    const legDecimalOdds = leg.odds > 0 ? (leg.odds / 100) + 1 : (100 / Math.abs(leg.odds)) + 1;
    slip.totalDecimalOdds *= legDecimalOdds;

    pendingParlays.set(userId, slip);
    return slip;
};

/**
 * Retrieves a user's pending parlay slip.
 * @param {number} userId The user's Telegram ID.
 * @returns {object|undefined} The user's slip or undefined if none exists.
 */
export const getSlip = (userId) => {
    return pendingParlays.get(userId);
};

/**
 * Clears a user's pending parlay slip from memory.
 * @param {number} userId The user's Telegram ID.
 */
export const clearSlip = (userId) => {
    pendingParlays.delete(userId);
};
