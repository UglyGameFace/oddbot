// src/repositories/gameRepository.js

import { supabase } from '../config/supabaseClient.js';

/**
 * Fetches upcoming games for a specific sport, ordered by their start time.
 * @param {string} sportKey The key for the sport (e.g., 'nfl').
 * @param {number} limit The maximum number of games to return.
 * @returns {Promise<Array<object>>} A list of game objects.
 */
export const getUpcomingGamesBySport = async (sportKey, limit = 10) => {
    const { data, error } = await supabase
        .from('games')
        .select('event_id, home_team, away_team, commence_time')
        .eq('sport_key', sportKey)
        .gt('commence_time', new Date().toISOString())
        .order('commence_time', { ascending: true })
        .limit(limit);

    if (error) {
        console.error(`Error fetching upcoming games for ${sportKey}:`, error);
        throw new Error('Could not retrieve upcoming games from the database.');
    }

    return data;
};
