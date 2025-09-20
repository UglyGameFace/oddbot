 
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('FATAL ERROR: Supabase URL or Service Key is not defined.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
