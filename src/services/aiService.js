// src/services/aiService.js - COMPLETE UPDATE (No Placeholders)
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService, { ProbabilityCalculator } from './quantitativeService.js';
import { ElitePromptService } from './elitePromptService.js';
import { toDecimalFromAmerican, toAmericanFromDecimal } from '../utils/botUtils.js';
import { TimeoutError, withTimeout } from '../utils/asyncUtils.js';
import { sentryService } from './sentryService.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 45000;
const DEFAULT_HORIZON_HOURS = 72;

// AI Model Configuration
const AI_PROVIDERS = {
    PERPLEXITY: {
        name: 'Perplexity AI',
        model: 'sonar-pro',
        apiUrl: 'https://api.perplexity.ai/chat/completions',
        buildPayload: (prompt, model) => ({
            model: model,
            messages: [
                { 
                    role: 'system', 
                    content: 'Return ONLY valid JSON matching the exact schema requested in the user prompt. No introductory text, explanations, apologies, or code fences unless the schema explicitly requires string content there.' 
                },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1 // Lower temperature for more consistent JSON
        }),
        extractContent: (responseData) => responseData?.choices?.[0]?.message?.content || '',
        getHeaders: (apiKey) => ({ 
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        })
    },
    GEMINI: {
        name: 'Google Gemini',
        model: 'gemini-1.5-flash-latest',
        apiUrl: (apiKey, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        buildPayload: (prompt) => ({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.1
            }
        }),
        extractContent: (responseData) => responseData?.candidates?.[0]?.content?.parts?.[0]?.text || '',
        getHeaders: () => ({ 'Content-Type': 'application/json' })
    }
};

// Helper to calculate parlay odds (Decimal)
function calculateParlayDecimal(legs = []) {
    const validLegs = legs.filter(leg => {
        const odds = leg.odds?.american ?? leg.price;
        return typeof odds === 'number' && Number.isFinite(odds) && odds !== 0;
    });
    
    if (validLegs.length === 0) return 1.0;

    return validLegs.reduce((acc, leg) => {
        const odds = leg.odds?.american ?? leg.price;
        const decimal = ProbabilityCalculator.americanToDecimal(odds);
        return acc * (decimal > 1 ? decimal : 1.0);
    }, 1.0);
}

// Robust JSON extraction
function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    
    let jsonString = text.trim();
    let parsed = null;

    // Remove markdown code fences
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]+?)\s*```/;
    const fenceMatch = jsonString.match(jsonBlockRegex);
    if (fenceMatch && fenceMatch[1]) {
        jsonString = fenceMatch[1];
    }

    // Try to find JSON object or array
    const firstBrace = jsonString.indexOf('{');
    const firstBracket = jsonString.indexOf('[');
    
    let startIndex = -1;
    let endChar = '';
    
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIndex = firstBrace;
        endChar = '}';
    } else if (firstBracket !== -1) {
        startIndex = firstBracket;
        endChar = ']';
    }

    if (startIndex !== -1) {
        const lastIndex = jsonString.lastIndexOf(endChar);
        if (lastIndex > startIndex) {
            jsonString = jsonString.substring(startIndex, lastIndex + 1);
        }
    }

    // Attempt parsing with error recovery
    try {
        parsed = JSON.parse(jsonString);
    } catch (initialError) {
        console.warn("⚠️ Initial JSON parse failed, attempting cleanup...");
        
        // Try to fix common JSON issues
        try {
            // Remove trailing commas
            jsonString = jsonString.replace(/,\s*([}\]])/g, '$1');
            // Fix missing quotes around keys
            jsonString = jsonString.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
            
            parsed = JSON.parse(jsonString);
        } catch (recoveryError) {
            console.error("❌ JSON extraction failed after recovery attempts:", recoveryError.message);
            console.error("--- Problematic JSON snippet ---");
            console.error(jsonString.substring(0, 500));
            sentryService.captureError(new Error(`JSON extraction failed: ${recoveryError.message}`), {
                level: "warning",
                extra: { jsonStringSample: jsonString.substring(0, 500) }
            });
            return null;
        }
    }

    return parsed;
}

// Fetches verified schedule for AI context
async function buildScheduleContextForAI(sportKey, hours) {
    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);

        if (!Array.isArray(realGames) || realGames.length === 0) {
            console.warn(`⚠️ No verified games found for ${sportKey} within ${hours}h for AI context.`);
            return `\n\n## VERIFIED SCHEDULE\nNo verified games found for ${sportKey} in the next ${hours} hours. Base analysis on typical matchups, team strengths, and standard scheduling patterns, but clearly state this limitation.`;
        }

        const gameList = realGames
            .slice(0, 20)
            .map((game, index) => {
                const timeStr = new Date(game.commence_time).toLocaleString('en-US', { 
                    timeZone: TZ, 
                    month: 'short', 
                    day: 'numeric', 
                    hour: 'numeric', 
                    minute: '2-digit', 
                    hour12: true 
                });
                return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`;
            })
            .join('\n');

        return `\n\n## VERIFIED SCHEDULE (Next ${hours} hours - ${realGames.length} total games)\n${gameList}\n\n**CRITICAL: Base your parlay legs ONLY on games from this verified list using the exact "Away Team @ Home Team" format found in the list.** Reject any other potential matchups.`;

    } catch (error) {
        console.error(`❌ Error building schedule context for ${sportKey}:`, error.message);
        sentryService.captureError(error, { 
            component: 'aiService', 
            operation: 'buildScheduleContextForAI', 
            sportKey 
        });
        return `\n\n## VERIFIED SCHEDULE\nError retrieving verified game schedule. Proceed with caution using fundamental analysis and typical matchups, stating this limitation clearly.`;
    }
}

// Validates AI-proposed legs against verified schedule
async function validateAILegsAgainstSchedule(sportKey, proposedLegs, hours) {
    if (!Array.isArray(proposedLegs) || proposedLegs.length === 0) {
        return { validatedLegs: [], validationRate: 0, totalProposed: 0 };
    }
    
    const totalProposed = proposedLegs.length;

    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (!Array.isArray(realGames) || realGames.length === 0) {
            console.warn(`⚠️ Schedule Validation: No real games found for ${sportKey} to validate against.`);
            return {
                validatedLegs: proposedLegs.map(leg => ({ 
                    ...leg, 
                    real_game_validated: false, 
                    validation_error: "No schedule data available" 
                })),
                validationRate: 0,
                totalProposed
            };
        }

        const normalizeTeamName = (team) => {
            if (!team) return '';
            return team.toString()
                .toLowerCase()
                .trim()
                .replace(/\s+/g, ' ')
                .replace(/^\.+|\.+$/g, '')
                .replace(/\b(?:basketball|football|baseball|hockey|team|club)\b/g, '')
                .trim();
        };

        // Create lookup map with multiple normalization strategies
        const realGameLookups = new Map();
        
        realGames.forEach(game => {
            const awayNorm = normalizeTeamName(game.away_team);
            const homeNorm = normalizeTeamName(game.home_team);
            
            if (awayNorm && homeNorm) {
                // Primary key format
                const primaryKey = `${awayNorm}@${homeNorm}`;
                realGameLookups.set(primaryKey, game);
                
                // Alternative formats for flexible matching
                const altKey1 = `${homeNorm} vs ${awayNorm}`;
                const altKey2 = `${awayNorm} at ${homeNorm}`;
                const altKey3 = `${awayNorm} v ${homeNorm}`;
                
                [altKey1, altKey2, altKey3].forEach(key => {
                    if (!realGameLookups.has(key)) {
                        realGameLookups.set(key, game);
                    }
                });
            }
        });

        // Validate each proposed leg
        const validationResults = proposedLegs.map(leg => {
            if (typeof leg.event !== 'string' || leg.event.length === 0 || leg.event.toLowerCase() === 'unknown event') {
                return { 
                    ...leg, 
                    real_game_validated: false, 
                    validation_error: "Invalid or missing 'event' field from AI" 
                };
            }

            const eventStr = leg.event.trim().toLowerCase();
            let matchedGame = null;
            let validationError = null;

            // Try multiple matching strategies
            const potentialKeys = [
                eventStr,
                eventStr.replace(' vs ', ' @ '),
                eventStr.replace(' at ', ' @ '),
                eventStr.replace(' v ', ' @ ')
            ];

            for (const key of potentialKeys) {
                if (realGameLookups.has(key)) {
                    matchedGame = realGameLookups.get(key);
                    break;
                }
            }

            // Fallback: try to extract teams and create key
            if (!matchedGame) {
                const teamMatch = eventStr.match(/(.+?)\s(?:@|vs\.?|at|v)\s(.+)/);
                if (teamMatch) {
                    const away = normalizeTeamName(teamMatch[1]);
                    const home = normalizeTeamName(teamMatch[2]);
                    const constructedKey = `${away}@${home}`;
                    matchedGame = realGameLookups.get(constructedKey);
                }
            }

            const isValidated = !!matchedGame;
            
            if (!isValidated) {
                validationError = `Game "${leg.event}" not found in verified schedule`;
                console.warn(`⚠️ Schedule Validation Failed: "${leg.event}"`);
            }

            return {
                ...leg,
                real_game_validated: isValidated,
                validation_error: validationError,
                commence_time: isValidated ? matchedGame.commence_time : leg.commence_time,
                verified_event_id: isValidated ? (matchedGame.event_id || matchedGame.id) : null,
                sport_key: sportKey
            };
        });

        const validatedCount = validationResults.filter(l => l.real_game_validated).length;
        const validationRate = totalProposed > 0 ? validatedCount / totalProposed : 0;
        
        console.log(`✅ Schedule Validation Complete for ${sportKey}: ${validatedCount}/${totalProposed} legs validated (${(validationRate * 100).toFixed(1)}%).`);

        return {
            validatedLegs: validationResults,
            validationRate,
            totalProposed
        };

    } catch (error) {
        console.error(`❌ Schedule validation process failed for ${sportKey}:`, error.message);
        sentryService.captureError(error, { 
            component: 'aiService', 
            operation: 'validateAILegsAgainstSchedule', 
            sportKey 
        });
        
        return {
            validatedLegs: proposedLegs.map(leg => ({ 
                ...leg, 
                real_game_validated: false, 
                validation_error: "Internal validation error" 
            })),
            validationRate: 0,
            totalProposed
        };
    }
}

class AIService {
    _getAIProviderConfig() {
        const apiKeyStatus = env.API_KEY_STATUS || {};
        
        // Check Perplexity availability
        const isPerplexityValid = env.PERPLEXITY_API_KEY && 
            !apiKeyStatus.criticalErrors?.some(e => e.includes('PERPLEXITY_API_KEY')) && 
            !apiKeyStatus.warnings?.some(e => e.includes('PERPLEXITY_API_KEY'));
        
        // Check Gemini availability  
        const isGeminiValid = env.GOOGLE_GEMINI_API_KEY && 
            !apiKeyStatus.criticalErrors?.some(e => e.includes('GOOGLE_GEMINI_API_KEY'));

        if (isPerplexityValid) {
            console.log("🤖 Using Perplexity AI provider.");
            return { config: AI_PROVIDERS.PERPLEXITY, apiKey: env.PERPLEXITY_API_KEY };
        } else if (isGeminiValid) {
            console.log("🤖 Using Google Gemini provider.");
            return { config: AI_PROVIDERS.GEMINI, apiKey: env.GOOGLE_GEMINI_API_KEY };
        } else {
            console.error("❌ No valid AI API key found. AI service disabled.");
            return { config: null, apiKey: null };
        }
    }

    async _callAIProvider(prompt, requestedModel = null) {
        const { config: providerConfig, apiKey } = this._getAIProviderConfig();

        if (!providerConfig || !apiKey) {
            throw new Error('No valid AI provider configured or API key available.');
        }

        const modelToUse = requestedModel || providerConfig.model;
        const apiUrl = typeof providerConfig.apiUrl === 'function'
            ? providerConfig.apiUrl(apiKey, modelToUse)
            : providerConfig.apiUrl;
            
        const payload = providerConfig.buildPayload(prompt, modelToUse);
        const headers = providerConfig.getHeaders(apiKey);

        console.log(`📡 Calling ${providerConfig.name} (Model: ${modelToUse})...`);

        try {
            const response = await withTimeout(
                axios.post(apiUrl, payload, { headers, timeout: WEB_TIMEOUT_MS }),
                WEB_TIMEOUT_MS + 2000,
                `${providerConfig.name}_API_Call`
            );

            const responseText = providerConfig.extractContent(response.data);

            // Log raw response for debugging
            console.info(`---------- RAW AI RESPONSE (${providerConfig.name}) ----------`);
            console.info(responseText.substring(0, 1000) + (responseText.length > 1000 ? '...' : ''));
            console.info(`---------------------------------------------------------`);

            if (!responseText) {
                console.error(`❌ ${providerConfig.name} returned empty response content.`);
                throw new Error(`${providerConfig.name} returned empty or invalid response structure.`);
            }

            const parsedJson = extractJSON(responseText);
            if (!parsedJson) {
                throw new Error(`AI response from ${providerConfig.name} did not contain parseable JSON.`);
            }

            console.log(`✅ ${providerConfig.name} call successful.`);
            return parsedJson;

        } catch (error) {
            const status = error.response?.status;
            let errorMessage = error.message || 'Unknown AI Provider Error';

            if (error instanceof TimeoutError) {
                errorMessage = `${providerConfig.name} API request timed out after ${WEB_TIMEOUT_MS / 1000}s.`;
            } else if (status === 401 || status === 403) {
                errorMessage = `${providerConfig.name} API key invalid or lacks permissions (${status}).`;
            } else if (status === 429) {
                errorMessage = `${providerConfig.name} API rate limit exceeded (Status 429).`;
            } else if (status === 400) {
                errorMessage = `${providerConfig.name} API Bad Request (Status 400). Check prompt structure.`;
            } else if (error.code === 'ECONNABORTED') {
                errorMessage = `${providerConfig.name} API request connection timed out.`;
            }

            console.error(`❌ ${providerConfig.name} API Error:`, errorMessage);
            
            sentryService.captureError(error, {
                component: 'aiService',
                operation: '_callAIProvider',
                provider: providerConfig.name,
                model: modelToUse,
                status: status,
                level: 'error'
            });

            throw new Error(errorMessage);
        }
    }

    _ensureLegsHaveOdds(legs = []) {
        if (!Array.isArray(legs)) {
            console.warn("⚠️ _ensureLegsHaveOdds: Input 'legs' is not an array.");
            return [];
        }

        const validLegs = legs.filter((leg, index) => {
            if (!leg || typeof leg !== 'object') {
                console.warn(`⚠️ Skipping invalid leg at index ${index}: not an object.`);
                return false;
            }

            // Handle both odds.american and price fields
            let americanOdds = null;
            if (leg.odds && typeof leg.odds.american === 'number' && Number.isFinite(leg.odds.american)) {
                americanOdds = leg.odds.american;
            } else if (typeof leg.price === 'number' && Number.isFinite(leg.price)) {
                americanOdds = leg.price;
                // Ensure odds structure exists
                if (!leg.odds) leg.odds = {};
                leg.odds.american = americanOdds;
            }

            // Validate required fields
            const isValidSelection = leg.selection && typeof leg.selection === 'string' && leg.selection.length > 0;
            const isValidEvent = leg.event && typeof leg.event === 'string' && leg.event.length > 0;
            const hasValidOdds = americanOdds !== null && Number.isFinite(americanOdds);

            if (!isValidSelection || !isValidEvent || !hasValidOdds) {
                console.warn(`⚠️ Skipping invalid leg at index ${index}:`, {
                    selection: isValidSelection ? 'valid' : 'invalid',
                    event: isValidEvent ? 'valid' : 'invalid', 
                    odds: hasValidOdds ? 'valid' : 'invalid'
                });
                return false;
            }

            // Ensure derived odds fields
            const decimalOdds = ProbabilityCalculator.americanToDecimal(americanOdds);
            const impliedProb = ProbabilityCalculator.impliedProbability(decimalOdds);
            
            leg.odds = {
                american: americanOdds,
                decimal: decimalOdds,
                implied_probability: impliedProb
            };

            return true;
        });

        if (validLegs.length < legs.length) {
            console.warn(`⚠️ Filtered out ${legs.length - validLegs.length} invalid leg(s).`);
        }

        return validLegs;
    }

    // ** IMPLEMENTED: _findBestValuePlays method **
    async _findBestValuePlays(games, maxPlays = 10) {
        if (!Array.isArray(games) || games.length === 0) {
            console.warn("⚠️ _findBestValuePlays: No games provided.");
            return [];
        }

        const valuePlays = [];

        try {
            for (const game of games) {
                if (!game.bookmakers || !Array.isArray(game.bookmakers)) {
                    continue;
                }

                // Analyze each bookmaker's markets
                for (const bookmaker of game.bookmakers) {
                    if (!bookmaker.markets || !Array.isArray(bookmaker.markets)) {
                        continue;
                    }

                    for (const market of bookmaker.markets) {
                        if (!market.outcomes || !Array.isArray(market.outcomes)) {
                            continue;
                        }

                        // Calculate no-vig probabilities for the market
                        const outcomesWithProbabilities = this._calculateMarketProbabilities(market.outcomes);
                        
                        // Find +EV plays in this market
                        for (const outcome of outcomesWithProbabilities) {
                            if (outcome.ev > 0 && outcome.model_probability > 0.1) { // Basic EV filter
                                valuePlays.push({
                                    game,
                                    bookmaker: bookmaker.key || bookmaker.title,
                                    market: market.key,
                                    outcome,
                                    noVigProb: outcome.model_probability,
                                    ev: outcome.ev
                                });
                            }
                        }
                    }
                }
            }

            // Sort by EV descending and limit results
            return valuePlays
                .sort((a, b) => b.ev - a.ev)
                .slice(0, maxPlays);

        } catch (error) {
            console.error("❌ Error in _findBestValuePlays:", error);
            sentryService.captureError(error, {
                component: 'aiService',
                operation: '_findBestValuePlays',
                level: 'error'
            });
            return [];
        }
    }

    // ** NEW: Helper method for market probability calculations **
    _calculateMarketProbabilities(outcomes) {
        if (!Array.isArray(outcomes) || outcomes.length === 0) {
            return [];
        }

        // Convert to decimal odds and calculate implied probabilities
        const outcomesWithData = outcomes.map(outcome => {
            const decimalOdds = ProbabilityCalculator.americanToDecimal(outcome.price);
            const impliedProb = ProbabilityCalculator.impliedProbability(decimalOdds);
            
            return {
                ...outcome,
                decimal_odds: decimalOdds,
                implied_probability: impliedProb
            };
        });

        // Calculate total implied probability (vig)
        const totalImpliedProb = outcomesWithData.reduce((sum, outcome) => sum + outcome.implied_probability, 0);
        
        // Calculate no-vig probabilities
        return outcomesWithData.map(outcome => {
            const noVigProb = totalImpliedProb > 0 ? outcome.implied_probability / totalImpliedProb : 0;
            const ev = (noVigProb * outcome.decimal_odds - 1) * 100; // EV percentage
            
            return {
                ...outcome,
                model_probability: noVigProb,
                ev: ev
            };
        });
    }

    // ** IMPROVED: DB Quant Parlay Generation **
    async _generateDbQuantParlay(sportKey, numLegs, betType, horizonHours) {
        try {
            const allGames = await gamesService.getGamesForSport(sportKey, {
                hoursAhead: horizonHours,
                includeOdds: true,
                useCache: false,
            });

            if (!Array.isArray(allGames) || allGames.length === 0) {
                console.warn(`⚠️ DB Quant: No games found for ${sportKey}.`);
                return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', "No games available in database.");
            }

            console.log(`🔍 DB Quant: Scanning ${allGames.length} ${sportKey} games for +EV plays...`);
            
            const bestPlays = await this._findBestValuePlays(allGames, numLegs * 2); // Get extra for filtering
            
            if (!Array.isArray(bestPlays) || bestPlays.length === 0) {
                console.log(`🚫 DB Quant: No +EV plays found for ${sportKey}.`);
                return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `No profitable (+EV) bets found among ${allGames.length} games.`);
            }

            console.log(`✅ DB Quant: Found ${bestPlays.length} +EV plays. Selecting top ${Math.min(numLegs, bestPlays.length)}.`);
            
            const topPlays = bestPlays.slice(0, numLegs);
            const parlayLegs = topPlays.map(play => this._formatPlayAsLeg(play, sportKey)).filter(Boolean);

            if (parlayLegs.length < 2) {
                console.warn(`⚠️ DB Quant: Fewer than 2 valid +EV legs found.`);
                return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `Fewer than 2 valid +EV legs found.`);
            }

            const sportTitle = this._formatSportTitle(sportKey);

            return {
                legs: parlayLegs,
                parlay_metadata: {
                    sport: sportTitle,
                    sport_key: sportKey,
                    legs_count: parlayLegs.length,
                    bet_type: betType,
                    analyst_tier: "QUANTITATIVE (DB Scan)",
                    generated_at: new Date().toISOString(),
                    data_sources_used: ["Internal Database", "Quantitative Analysis"],
                    model_version: "db-ev-scanner-v1"
                },
                portfolio_construction: {
                    overall_thesis: `Constructed from the top ${parlayLegs.length} +EV bets identified via quantitative database analysis.`,
                    key_risk_factors: ["Based on cached odds - verify live prices", "Market efficiency may reduce edge over time"],
                    clv_plan: "Verify odds match or beat calculated price before betting."
                },
                research_metadata: {
                    mode: 'db',
                    generationStrategy: 'database_quant_ev',
                    games_scanned: allGames.length,
                    ev_plays_found: bestPlays.length,
                    legs_used: parlayLegs.length,
                }
            };

        } catch (error) {
            console.error(`❌ DB Quant mode failed for ${sportKey}:`, error);
            sentryService.captureError(error, {
                component: 'aiService',
                operation: '_generateDbQuantParlay',
                sportKey,
                level: 'error'
            });
            
            return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `Error during database analysis: ${error.message}`);
        }
    }

    // ** NEW: Helper method for sport title formatting **
    _formatSportTitle(sportKey) {
        if (typeof sportKey !== 'string') return 'Unknown Sport';
        
        return sportKey
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    // ** IMPROVED: Format play as leg with better error handling **
    _formatPlayAsLeg(play, sportKey) {
        if (!play || !play.outcome || !play.game) {
            console.warn("⚠️ _formatPlayAsLeg: Invalid play data structure");
            return null;
        }

        const { game, outcome, noVigProb, ev, bookmaker, market } = play;
        
        // Validate required fields
        if (typeof outcome.price !== 'number' || !Number.isFinite(outcome.price) ||
            typeof noVigProb !== 'number' || !Number.isFinite(noVigProb) ||
            !game.away_team || !game.home_team || !outcome.name) {
            console.warn("⚠️ _formatPlayAsLeg: Missing required play data");
            return null;
        }

        const decimalOdds = ProbabilityCalculator.americanToDecimal(outcome.price);
        const impliedProb = ProbabilityCalculator.impliedProbability(decimalOdds);
        
        if (impliedProb <= 0) {
            console.warn(`⚠️ _formatPlayAsLeg: Invalid implied probability for price ${outcome.price}`);
            return null;
        }

        const edge = (noVigProb / impliedProb - 1) * 100;
        const calculatedEv = ProbabilityCalculator.calculateEVPercentage(decimalOdds, noVigProb);

        return {
            event: `${game.away_team} @ ${game.home_team}`,
            selection: outcome.point ? `${outcome.name} ${outcome.point}`.trim() : outcome.name,
            sportsbook: bookmaker || 'Database Odds',
            market_type: market || 'h2h',
            line: outcome.point || null,
            price: outcome.price,
            region: 'us',
            timestamp: game.last_updated || new Date().toISOString(),
            implied_probability: parseFloat(impliedProb.toFixed(4)),
            model_probability: parseFloat(noVigProb.toFixed(4)),
            edge_percent: parseFloat(edge.toFixed(2)),
            ev_per_100: parseFloat((calculatedEv * 100).toFixed(2)),
            kelly_fraction_full: parseFloat(ProbabilityCalculator.kellyFraction(decimalOdds, noVigProb).toFixed(4)),
            clv_target_price: null,
            injury_gates: null,
            market_signals: null,
            correlation_notes: "Assumed low correlation (cross-game).",
            odds: {
                american: outcome.price,
                decimal: decimalOdds,
                implied_probability: parseFloat(impliedProb.toFixed(4))
            },
            commence_time: game.commence_time,
            gameId: game.event_id || game.id,
            sport_key: sportKey,
            real_game_validated: true
        };
    }

    // ** COMPLETE: Main parlay generation method **
    async generateParlay(sportKey, numLegs, mode, aiModel, betType, options = {}) {
        const requestId = `parlay_${sportKey}_${Date.now()}`;
        let generationStrategy = 'unknown';

        console.log(`🎯 Starting EV-Driven Parlay Generation [${requestId}] | Sport: ${sportKey} | Legs: ${numLegs} | Mode: ${mode} | Type: ${betType}`);
        
        // Input validation
        if (!sportKey || typeof sportKey !== 'string') {
            throw new Error("Invalid sportKey provided.");
        }
        if (!numLegs || typeof numLegs !== 'number' || numLegs < 2 || numLegs > 8) {
            throw new Error("Invalid number of legs (must be 2-8).");
        }
        if (!['web', 'live', 'db'].includes(mode)) {
            console.warn(`⚠️ Invalid mode "${mode}", defaulting to 'web'.`);
            mode = 'web';
        }

        // Prepare context
        const horizonHours = options.horizonHours || DEFAULT_HORIZON_HOURS;
        const userConfig = options.userConfig || null;
        const scheduleContext = (mode === 'web' || mode === 'live') ? await buildScheduleContextForAI(sportKey, horizonHours) : null;
        const promptContext = { scheduleInfo: scheduleContext, injuryReport: null, userConfig };

        try {
            let rawAIParlayData;
            
            if (mode === 'web' || mode === 'live') {
                console.log(`🖥️ Using Web Research strategy (Mode: ${mode})`);
                generationStrategy = 'quantum_web_ev';
                const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, promptContext);
                rawAIParlayData = await this._callAIProvider(prompt);
            } else {
                console.log(`💾 Using Database (+EV Scan) strategy (Mode: ${mode})`);
                generationStrategy = 'database_quant_ev';
                rawAIParlayData = await this._generateDbQuantParlay(sportKey, numLegs, betType, horizonHours);
            }

            // Validate response structure
            if (!rawAIParlayData || typeof rawAIParlayData !== 'object') {
                throw new Error('AI/DB function failed to return valid data structure.');
            }

            if (generationStrategy === 'database_quant_ev' && (!rawAIParlayData.legs || rawAIParlayData.legs.length === 0)) {
                console.log("✅ DB Quant: No +EV legs found meeting criteria.");
                return rawAIParlayData;
            }

            if (!Array.isArray(rawAIParlayData.legs)) {
                throw new Error('AI/DB response missing valid legs array.');
            }

            // Process and validate legs
            let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);
            let validationRate = 1.0;
            let finalLegs = processedLegs;
            let validationResult = { validatedLegs: processedLegs, validationRate: 1.0, totalProposed: rawAIParlayData.legs.length };
            const originalAICount = rawAIParlayData.legs.length;
            const processedLegCount = processedLegs.length;

            if (generationStrategy === 'quantum_web_ev') {
                validationResult = await validateAILegsAgainstSchedule(sportKey, processedLegs, horizonHours);
                validationRate = validationResult.validationRate;
                finalLegs = validationResult.validatedLegs.filter(leg => leg.real_game_validated);

                if (processedLegCount < originalAICount) {
                    console.warn(`⚠️ Initial processing removed ${originalAICount - processedLegCount} invalid leg(s).`);
                }

                const removedByValidation = processedLegCount - finalLegs.length;
                if (removedByValidation > 0) {
                    console.warn(`⚠️ ${removedByValidation} leg(s) removed by schedule validation.`);
                }

                if (finalLegs.length < 2) {
                    console.error(`❌ Insufficient valid legs (${finalLegs.length}) after validation.`);
                    return this._createValidationFailureResponse(rawAIParlayData, validationResult.validatedLegs, generationStrategy, "Insufficient legs passed schedule validation.");
                }
            } else {
                validationResult.totalProposed = originalAICount;
                if (processedLegCount < originalAICount) {
                    console.warn(`⚠️ Initial processing removed ${originalAICount - processedLegCount} invalid leg(s) from DB.`);
                }
                if (finalLegs.length < 2) {
                    return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', "Fewer than 2 valid legs found in DB.");
                }
            }

            // Quantitative evaluation
            console.log(`🔬 Performing quantitative evaluation on ${finalLegs.length} leg(s)...`);
            const evaluationResult = await quantitativeService.evaluateParlay(finalLegs);

            if (evaluationResult.error || evaluationResult.summary?.verdict === 'REJECTED') {
                const reason = evaluationResult.error || evaluationResult.summary?.primaryAction || 'Quantitative rejection';
                console.warn(`❌ Parlay REJECTED by Quant Service: ${reason}`);
                return {
                    ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
                    legs: validationResult.validatedLegs,
                    ...evaluationResult,
                    research_metadata: {
                        ...(rawAIParlayData.research_metadata || {}),
                        quantitative_rejection: true,
                        generationStrategy,
                        validationRate: parseFloat(validationRate.toFixed(2)),
                        originalAICount
                    }
                };
            }

            // Assemble successful result
            const finalResult = {
                ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
                legs: finalLegs,
                combined_parlay_metrics: evaluationResult.combined_parlay_metrics,
                riskAssessment: evaluationResult.riskAssessment,
                recommendations: evaluationResult.recommendations,
                summary: evaluationResult.summary,
                research_metadata: {
                    ...(rawAIParlayData.research_metadata || {}),
                    generationStrategy,
                    mode,
                    validationRate: parseFloat(validationRate.toFixed(2)),
                    finalLegCount: finalLegs.length,
                    originalAICount
                },
                portfolio_construction: rawAIParlayData.portfolio_construction || evaluationResult.recommendations
            };

            if (finalResult.parlay_metadata) {
                finalResult.parlay_metadata.legs_count = finalLegs.length;
            }

            console.log(`✅ Successfully generated EV Parlay [${requestId}]. Verdict: ${finalResult.summary?.verdict}`);
            return finalResult;

        } catch (error) {
            console.error(`❌ EV Parlay Gen Failed [${requestId}]:`, error.message);
            sentryService.captureError(error, {
                component: 'aiService',
                operation: 'generateParlay',
                sportKey,
                mode,
                numLegs,
                generationStrategy,
                level: 'error'
            });

            // Attempt fallback
            if (generationStrategy !== 'quantum_fallback_ev') {
                console.log(`🔄 Attempting FALLBACK for [${requestId}]...`);
                try {
                    return await this._generateFallbackParlay(sportKey, numLegs, betType, promptContext);
                } catch (fallbackError) {
                    console.error(`❌ FALLBACK ALSO FAILED [${requestId}]:`, fallbackError.message);
                    throw new Error(`Primary (${generationStrategy}) failed: "${error.message}". Fallback failed: "${fallbackError.message}".`);
                }
            } else {
                throw new Error(`AI fallback analysis failed: ${error.message}`);
            }
        }
    }

    // ** COMPLETE: Fallback parlay generation **
    async _generateFallbackParlay(sportKey, numLegs, betType, context = {}) {
        console.warn(`⚠️ Triggering FALLBACK generation for ${sportKey} (${numLegs} legs, ${betType})`);
        const generationStrategy = 'quantum_fallback_ev';
        const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, context);

        try {
            const rawAIParlayData = await this._callAIProvider(prompt);

            if (!rawAIParlayData || !Array.isArray(rawAIParlayData.legs) || rawAIParlayData.legs.length === 0) {
                throw new Error('Fallback AI failed to provide valid legs.');
            }

            let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);
            processedLegs = processedLegs.slice(0, numLegs).map(leg => ({
                ...leg,
                real_game_validated: false,
                timestamp: new Date().toISOString()
            }));

            if (processedLegs.length < 2) {
                throw new Error('Fallback generated insufficient valid legs.');
            }

            console.log(`🔬 Evaluating FALLBACK parlay with ${processedLegs.length} leg(s)...`);
            const evaluationResult = await quantitativeService.evaluateParlay(processedLegs);

            if (evaluationResult.error) {
                return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'fallback', `Quant analysis failed: ${evaluationResult.error}`);
            }

            const finalResult = {
                ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}),
                legs: processedLegs,
                combined_parlay_metrics: evaluationResult.combined_parlay_metrics,
                riskAssessment: evaluationResult.riskAssessment,
                recommendations: evaluationResult.recommendations,
                summary: evaluationResult.summary,
                portfolio_construction: rawAIParlayData.portfolio_construction || evaluationResult.recommendations,
                research_metadata: {
                    ...(rawAIParlayData.research_metadata || {}),
                    fallback_used: true,
                    generationStrategy,
                    validationRate: 0.00,
                    finalLegCount: processedLegs.length,
                    note: 'Generated using fundamental analysis & ESTIMATED odds/probabilities without real-time validation.'
                }
            };

            // Adjust for fallback context
            if (finalResult.parlay_metadata) {
                finalResult.parlay_metadata.analysis_mode = "FALLBACK";
                finalResult.parlay_metadata.legs_count = processedLegs.length;
            }
            if (finalResult.summary) {
                finalResult.summary.confidence = 'LOW';
                if (finalResult.summary.verdict === 'POSITIVE_EV') {
                    finalResult.summary.verdict = 'FALLBACK_POSITIVE_EV';
                }
            }
            if (finalResult.riskAssessment && finalResult.riskAssessment.overallRisk !== 'REJECTED') {
                finalResult.riskAssessment.overallRisk = 'HIGH';
                finalResult.riskAssessment.risks.push({
                    type: 'DATA_SOURCE',
                    severity: 'HIGH',
                    message: 'Parlay generated in fallback mode with estimated data.',
                    impact: 'EV and probabilities are estimates, actual risk may be higher.'
                });
            }

            console.log(`✅ Fallback generation completed for ${sportKey}.`);
            return finalResult;

        } catch (error) {
            console.error(`❌ Fallback generation failed:`, error.message);
            return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'fallback', `Fallback AI analysis failed: ${error.message}`);
        }
    }

    // ** COMPLETE: Response helper methods **
    _createEmptyParlayResponse(sportKey, numLegs, betType, mode, reason) {
        const formattedSport = this._formatSportTitle(sportKey);
        return {
            legs: [],
            parlay_metadata: {
                sport: formattedSport,
                sport_key: sportKey,
                legs_count: 0,
                bet_type: betType,
                analysis_mode: mode,
                generated_at: new Date().toISOString()
            },
            combined_parlay_metrics: null,
            riskAssessment: {
                overallRisk: 'REJECTED',
                risks: [{ type: 'GENERATION', severity: 'CRITICAL', message: reason }]
            },
            recommendations: { primaryAction: `DO NOT BET. ${reason}` },
            summary: { verdict: 'REJECTED', primaryAction: reason },
            portfolio_construction: { overall_thesis: reason },
            research_metadata: {
                mode,
                generationStrategy: mode === 'db' ? 'database_quant_ev' : 'unknown',
                generation_failed_reason: reason
            }
        };
    }

    _createValidationFailureResponse(originalData, validatedLegsWithFlags, generationStrategy, reason) {
        return {
            ...(originalData.parlay_metadata ? { parlay_metadata: originalData.parlay_metadata } : {}),
            legs: validatedLegsWithFlags,
            combined_parlay_metrics: null,
            riskAssessment: {
                overallRisk: 'REJECTED',
                risks: [{ type: 'VALIDATION', severity: 'CRITICAL', message: reason }]
            },
            recommendations: { primaryAction: `DO NOT BET. ${reason}` },
            summary: { verdict: 'REJECTED', primaryAction: reason },
            research_metadata: {
                ...(originalData.research_metadata || {}),
                validation_failed_insufficient_legs: true,
                generationStrategy
            }
        };
    }

    // ** COMPLETE: Generic chat function **
    async genericChat(modelIdentifier, messages) {
        console.log(`💬 Generic chat with model: ${modelIdentifier}`);
        
        try {
            const systemPrompt = "You are a helpful sports betting analyst assistant.";
            const chatHistory = messages.map(m => `${m.role}: ${m.content}`).join('\n');
            const fullPrompt = `${systemPrompt}\n\nConversation History:\n${chatHistory}\n\nassistant:`;

            const response = await this._callAIProvider(fullPrompt);
            
            // Handle different response formats
            if (typeof response === 'string') {
                return response;
            } else if (response && (response.text || response.content)) {
                return response.text || response.content;
            } else if (response && response.answer) {
                return response.answer;
            } else {
                return JSON.stringify(response) || 'Response received but format unexpected.';
            }
        } catch (error) {
            console.error(`❌ Generic chat failed: ${error.message}`);
            return `Sorry, I encountered an error: ${error.message}`;
        }
    }

    // ** COMPLETE: Odds validation **
    async validateOdds(oddsData) {
        if (!Array.isArray(oddsData)) {
            return { valid: false, message: "Input must be an array." };
        }

        const validationResults = oddsData.map((game, index) => {
            const hasBookmakers = Array.isArray(game.bookmakers) && game.bookmakers.length > 0;
            const hasMarkets = hasBookmakers && game.bookmakers.some(bm => 
                Array.isArray(bm.markets) && bm.markets.length > 0
            );
            const hasOutcomes = hasMarkets && game.bookmakers.some(bm =>
                bm.markets.some(market =>
                    Array.isArray(market.outcomes) && market.outcomes.length > 0
                )
            );

            return {
                gameId: game.id || game.event_id || `game_${index}`,
                valid: hasOutcomes,
                bookmakersCount: hasBookmakers ? game.bookmakers.length : 0,
                marketsCount: hasMarkets ? game.bookmakers.reduce((count, bm) => count + bm.markets.length, 0) : 0
            };
        });

        const validGames = validationResults.filter(r => r.valid).length;
        const totalGames = validationResults.length;

        return {
            valid: validGames > 0,
            message: `${validGames}/${totalGames} games have valid odds data.`,
            details: validationResults,
            summary: {
                totalGames,
                validGames,
                validationRate: totalGames > 0 ? (validGames / totalGames) : 0
            }
        };
    }
}

export default new AIService();
