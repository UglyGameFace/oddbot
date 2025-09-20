import { supabase } from '../config/supabaseClient.js';

export const findUserById = async (telegramId) => {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('tg_id', telegramId)
        .single();
    
    // 'PGRST116' means no rows found, which is not a server error.
    if (error && error.code !== 'PGRST116') throw error;
    return data;
};

export const createUser = async (userInfo) => {
    const { id, first_name, username } = userInfo;
    const { data, error } = await supabase
        .from('users')
        .insert([
            {
                tg_id: id,
                username: username,
                // We'll add a default preferences object upon creation
                preferences: {
                    "timezone": "America/New_York",
                    "bankroll_management": {"unit_size": 10, "current_bankroll": 1000},
                    "followed_entities": []
                }
            }
        ])
        .select()
        .single();
    
    if (error) throw error;
    return data;
};
