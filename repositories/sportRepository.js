import { supabase } from '../config/supabaseClient.js';

/**
 * Fetches a list of distinct sport keys that have games scheduled in the future.
 * This ensures we only show users sports with active, bettable events.
 * @returns {Promise<Array<string>>} A list of sport keys (e.g., ['nfl', 'mlb']).
 */
export const getActiveSports = async () => {
    const { data, error } = await supabase
        .from('games')
        .select('sport_key')
        .gt('commence_time', new Date().toISOString()) // Filters for games in the future
        .order('commence_time', { ascending: true });

    if (error) {
        console.error('Error fetching active sports:', error);
        throw new Error('Could not retrieve active sports from database.');
    }
    
    // Use a Set to get unique sport_key values, then convert back to an array.
    const uniqueSportKeys = [...new Set(data.map(game => game.sport_key))];
    
    return uniqueSportKeys;
};
