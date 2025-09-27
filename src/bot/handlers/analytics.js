// src/bot/handlers/analytics.js

import oddsService from '../../services/oddsService.js'; // <-- default export, not named getOdds
import aiService from '../../services/aiService.js';
import { analyzeQuantitative } from '../../quant.js'; // assuming you export this function
import psychometric from '../../psychometric.js'; // default export

// EXAMPLE: Usage
export async function analyzeAll(sportKey, tg_id) {
    // Get odds via the oddsService
    const games = await oddsService.getSportOdds(sportKey);

    // AI Quantitative analysis
    const quantResult = analyzeQuantitative ? await analyzeQuantitative(games) : null;

    // Do something with aiService if needed
    // const aiResult = await aiService.someMethod(...);

    // Psychometric analysis (example: profile a user/thread)
    const psychoProfile = await psychometric.profileUser(tg_id);

    return {
        quantResult,
        // aiResult,
        psychoProfile,
    };
}
