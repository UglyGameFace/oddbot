// src/services/aiService.js - EV-DRIVEN UPDATE
import axios from 'axios';
import env from '../config/env.js';
import gamesService from './gamesService.js';
import quantitativeService from './quantitativeService.js'; // Updated version
import { ElitePromptService } from './elitePromptService.js'; // Updated version
import { toDecimalFromAmerican, toAmericanFromDecimal } from '../utils/botUtils.js'; // Use shared utils
import { TimeoutError, withTimeout } from '../utils/asyncUtils.js'; // Import withTimeout
import { sentryService } from './sentryService.js';

const TZ = env.TIMEZONE || 'America/New_York';
const WEB_TIMEOUT_MS = 45000; // Increased timeout for potentially complex AI responses
const DEFAULT_HORIZON_HOURS = 72; // Default time horizon for fetching games

// AI Model Configuration (Centralized)
const AI_PROVIDERS = {
    PERPLEXITY: {
        name: 'Perplexity AI',
        model: 'sonar-pro', // Or 'sonar-small-online' for faster/cheaper web research
        apiUrl: 'https://api.perplexity.ai/chat/completions',
        buildPayload: (prompt, model) => ({
             model: model,
             // Stricter system prompt for JSON adherence
             messages: [
                 { role: 'system', content: 'Return ONLY valid JSON matching the exact schema requested in the user prompt. No introductory text, explanations, apologies, or code fences unless the schema explicitly requires string content there.' },
                 { role: 'user', content: prompt }
             ]
         }),
        extractContent: (responseData) => responseData?.choices?.[0]?.message?.content || '',
        getHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` })
    },
    GEMINI: {
        name: 'Google Gemini',
        // Use a model capable of function calling/strict output if needed, Flash might work for JSON
        model: 'gemini-1.5-flash-latest',
        apiUrl: (apiKey, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        buildPayload: (prompt /*, model */) => ({ // Model included in URL for Gemini
            // Ensure prompt structure adheres to Gemini's content format
             contents: [{ parts: [{ text: prompt }] }],
             // Enforce JSON output using Gemini's specific feature
             generationConfig: {
                responseMimeType: "application/json",
             }
         }),
        extractContent: (responseData) => responseData?.candidates?.[0]?.content?.parts?.[0]?.text || '',
        getHeaders: (/* apiKey */) => ({ 'Content-Type': 'application/json' }) // API key is in URL
    }
    // Add other providers here if needed
};


// Helper to calculate parlay odds (Decimal)
function calculateParlayDecimal(legs = []) {
    // Filter out legs without valid numeric American odds before calculating
    const validLegs = legs.filter(leg => typeof leg?.odds?.american === 'number' && Number.isFinite(leg.odds.american));
    if (validLegs.length === 0) return 1.0; // Return 1.0 (even money) if no valid legs

    return validLegs.reduce((acc, leg) => {
        const decimal = ProbabilityCalculator.americanToDecimal(leg.odds.american); // Use calculator from quant service
        // If conversion results in invalid decimal (e.g., from odds=0), treat as 1.0 multiplier
        return acc * (decimal > 1 ? decimal : 1.0);
    }, 1.0); // Start accumulator at 1.0
}

// Robust JSON extraction
function extractJSON(text = '') {
    if (!text || typeof text !== 'string') return null;
    text = text.trim();

    // 1. Check if the entire string is valid JSON
    try {
        // Attempt to parse the whole string first - Gemini might return pure JSON with mime type enforcement
        return JSON.parse(text);
    } catch { /* Ignore */ }

    // 2. Look for Markdown code fences (```json ... ```)
    const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
    const match = text.match(jsonBlockRegex);
    if (match && match[1]) {
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            console.warn("⚠️ Failed to parse content within JSON code fence:", e.message);
            // Continue trying other methods
        }
    }

    // 3. Look for the outermost '{' and '}' brackets
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
            return JSON.parse(text.substring(firstBrace, lastBrace + 1));
        } catch (e) {
            console.warn("⚠️ Failed to parse content between first and last braces:", e.message);
        }
    }

    // 4. If all else fails, log the failure and return null
    console.error("❌ Failed to extract valid JSON from AI response. Response start:", text.substring(0, 200));
    sentryService.captureMessage("Failed JSON Extraction from AI", { level: "warning", extra: { responseSample: text.substring(0, 500) } });
    return null;
}


// Fetches verified schedule to provide context to the AI
async function buildScheduleContextForAI(sportKey, hours) {
    try {
        // Use gamesService to get verified games (handles internal fallbacks)
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);

        if (!Array.isArray(realGames) || realGames.length === 0) {
            console.warn(`⚠️ No verified games found for ${sportKey} within ${hours}h for AI context.`);
            // Provide a clear note for the AI
            return `\n\n## VERIFIED SCHEDULE\nNo verified games found for ${sportKey} in the next ${hours} hours. Base analysis on typical matchups, team strengths, and standard scheduling patterns, but clearly state this limitation.`;
        }

        const gameList = realGames
            .slice(0, 20) // Limit context size
            .map((game, index) => {
                const timeStr = new Date(game.commence_time).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                // Include event ID if available and potentially useful for AI mapping
                // const eventId = game.event_id || game.id;
                return `${index + 1}. ${game.away_team} @ ${game.home_team} - ${timeStr}`; // - ID: ${eventId}
            })
            .join('\n');

        return `\n\n## VERIFIED SCHEDULE (Next ${hours} hours - ${realGames.length} total games)\n${gameList}\n\n**CRITICAL: Base your parlay legs ONLY on games from this verified list.** Reject any other potential matchups.`;

    } catch (error) {
        console.error(`❌ Error building schedule context for ${sportKey}:`, error.message);
        sentryService.captureError(error, { component: 'aiService', operation: 'buildScheduleContextForAI', sportKey });
        // Provide a fallback message indicating the data issue
        return `\n\n## VERIFIED SCHEDULE\nError retrieving verified game schedule. Proceed with caution using fundamental analysis and typical matchups, stating this limitation clearly.`;
    }
}

// Validates AI-proposed legs against the verified schedule
async function validateAILegsAgainstSchedule(sportKey, proposedLegs, hours) {
     if (!Array.isArray(proposedLegs) || proposedLegs.length === 0) {
        return { validatedLegs: [], validationRate: 0, totalProposed: 0 }; // Nothing to validate
    }
    const totalProposed = proposedLegs.length;

    try {
        const realGames = await gamesService.getVerifiedRealGames(sportKey, hours);
        if (!Array.isArray(realGames) || realGames.length === 0) {
             console.warn(`⚠️ Schedule Validation: No real games found for ${sportKey} to validate against.`);
             // Mark all as unvalidated
             return {
                 validatedLegs: proposedLegs.map(leg => ({ ...leg, real_game_validated: false })),
                 validationRate: 0,
                 totalProposed: totalProposed
             };
        }

        // Create a map for efficient lookup, normalizing team names
        const realGameMap = new Map();
        realGames.forEach(game => {
            // Normalize key: lowercase, trim, consistent separator
            const key = `${(game.away_team || '').toLowerCase().trim()}@${(game.home_team || '').toLowerCase().trim()}`;
            realGameMap.set(key, game); // Store the full game object
        });

        // Validate each proposed leg
        const validationResults = proposedLegs.map(leg => {
             // Normalize event string from AI: lowercase, trim, replace ' vs ' or ' @ ' with '@'
             const legEventKey = (leg.event || '')
                 .toLowerCase()
                 .trim()
                 .replace(/\s+vs\s+|\s+@\s+/, '@'); // Normalize separator to '@'

             const matchedGame = realGameMap.get(legEventKey);
             const isValidated = !!matchedGame;

             if (!isValidated) {
                 console.warn(`⚠️ Schedule Validation Failed: AI proposed leg for unverified/out-of-scope game: "${leg.event}" (Normalized key: ${legEventKey})`);
             }

             // Return leg with validation status and potentially updated data from verified source
             return {
                 ...leg,
                 real_game_validated: isValidated,
                 // If validated, ensure commence_time matches the verified game
                 commence_time: isValidated ? matchedGame.commence_time : leg.commence_time,
                 // Add verified event ID if useful downstream
                 verified_event_id: isValidated ? (matchedGame.event_id || matchedGame.id) : null
             };
        });

        const validatedCount = validationResults.filter(l => l.real_game_validated).length;
        const validationRate = totalProposed > 0 ? validatedCount / totalProposed : 0;
        console.log(`✅ Schedule Validation Complete for ${sportKey}: ${validatedCount}/${totalProposed} legs validated (${(validationRate * 100).toFixed(1)}%).`);

        return {
             validatedLegs: validationResults, // Return all legs, marked with status
             validationRate: validationRate,
             totalProposed: totalProposed
        };

    } catch (error) {
        console.error(`❌ Schedule validation process failed critically for ${sportKey}:`, error.message);
        sentryService.captureError(error, { component: 'aiService', operation: 'validateAILegsAgainstSchedule', sportKey });
        // On error, mark all as unvalidated
        return {
             validatedLegs: proposedLegs.map(leg => ({ ...leg, real_game_validated: false })),
             validationRate: 0,
             totalProposed: totalProposed
        };
    }
}


class AIService {

  // Selects the AI provider based on configuration or simple logic
  _getAIProviderConfig() {
      // Simple logic: Prefer Perplexity if key is valid, else try Gemini
       const apiKeyStatus = env.API_KEY_STATUS || {};
       const isPerplexityValid = !apiKeyStatus.criticalErrors?.some(e => e.includes('PERPLEXITY_API_KEY')) && !apiKeyStatus.warnings?.some(e => e.includes('PERPLEXITY_API_KEY'));
       const isGeminiValid = !apiKeyStatus.criticalErrors?.some(e => e.includes('GOOGLE_GEMINI_API_KEY'));


       if (isPerplexityValid) {
           console.log("🤖 Using Perplexity AI provider.");
           return { config: AI_PROVIDERS.PERPLEXITY, apiKey: env.PERPLEXITY_API_KEY };
       } else if (isGeminiValid) {
           console.log("🤖 Using Google Gemini provider (Perplexity key invalid/missing).");
            return { config: AI_PROVIDERS.GEMINI, apiKey: env.GOOGLE_GEMINI_API_KEY };
       } else {
            console.error("❌ No valid AI API key found (Perplexity or Gemini). AI service disabled.");
           return { config: null, apiKey: null }; // Indicate no provider available
       }
  }


  async _callAIProvider(prompt, requestedModel = null) {
        const { config: providerConfig, apiKey } = this._getAIProviderConfig();

        if (!providerConfig || !apiKey) {
            throw new Error('No valid AI provider configured or API key available.');
        }

        const modelToUse = requestedModel || providerConfig.model; // Use requested or provider default
        const apiUrl = typeof providerConfig.apiUrl === 'function'
            ? providerConfig.apiUrl(apiKey, modelToUse) // For Gemini-like APIs where key/model is in URL
            : providerConfig.apiUrl;
        const payload = providerConfig.buildPayload(prompt, modelToUse);
        const headers = providerConfig.getHeaders(apiKey);

        console.log(`📡 Calling ${providerConfig.name} (Model: ${modelToUse})...`);

        try {
            // Use withTimeout for the axios call
            const response = await withTimeout(
                axios.post(apiUrl, payload, { headers, timeout: WEB_TIMEOUT_MS }),
                WEB_TIMEOUT_MS + 2000, // Add a small buffer to the outer timeout
                `${providerConfig.name}_API_Call`
            );

            const responseText = providerConfig.extractContent(response.data);

            if (!responseText) {
                console.error(`❌ ${providerConfig.name} returned empty response content.`);
                 // Log details if possible
                 console.error("Response Data Sample:", JSON.stringify(response.data)?.substring(0, 500));
                throw new Error(`${providerConfig.name} returned empty or invalid response structure.`);
            }

            const parsedJson = extractJSON(responseText);
            if (!parsedJson) {
                // Error logged by extractJSON
                 throw new Error(`AI response from ${providerConfig.name} did not contain parseable JSON that matches the expected structure.`);
            }

            console.log(`✅ ${providerConfig.name} call successful.`);
            return parsedJson;

        } catch (error) {
            const status = error.response?.status;
            const errorData = error.response?.data;
            let errorMessage = error.message;

            // Improve error logging and messages
            if (error instanceof TimeoutError) {
                 errorMessage = `${providerConfig.name} API request timed out after ${WEB_TIMEOUT_MS / 1000}s.`;
                 console.error(`⏰ ${errorMessage}`);
            } else {
                 console.error(`❌ ${providerConfig.name} API Error: Status ${status}`, errorData || error.message);
            }


            if (status === 401 || status === 403) {
                errorMessage = `${providerConfig.name} API key invalid, expired, or lacks permissions.`;
            } else if (status === 429) {
                 errorMessage = `${providerConfig.name} API rate limit exceeded. Please wait and try again.`;
            } else if (status === 400) {
                 // Often indicates a bad request / prompt issue
                 errorMessage = `${providerConfig.name} API Bad Request (Status 400). Check prompt structure or model compatibility. Details: ${JSON.stringify(errorData)}`;
            } else if (error.code === 'ECONNABORTED' && !(error instanceof TimeoutError)) {
                 // Network level timeout, potentially different from application timeout
                 errorMessage = `${providerConfig.name} API request connection timed out.`;
            }
             // Log structured error to Sentry
             sentryService.captureError(error, {
                component: 'aiService', operation: '_callAIProvider', provider: providerConfig.name, model: modelToUse, status: status, level: 'error'
             });

            // Throw a consistent error format
            throw new Error(errorMessage);
        }
    }


  async generateParlay(sportKey, numLegs, mode, aiModel /* Ignored for now */, betType, options = {}) {
      const requestId = `parlay_${sportKey}_${Date.now()}`;
      console.log(`🎯 Starting EV-Driven Parlay Generation [${requestId}] | Sport: ${sportKey} | Legs: ${numLegs} | Mode: ${mode} | Type: ${betType}`);

      // --- Input Validation ---
      if (!sportKey || typeof sportKey !== 'string') throw new Error("Invalid sportKey provided.");
      if (!numLegs || typeof numLegs !== 'number' || numLegs < 2 || numLegs > 8) throw new Error("Invalid number of legs (must be 2-8).");
      if (!['web', 'live', 'db'].includes(mode)) {
          console.warn(`⚠️ Invalid mode "${mode}", defaulting to 'web'.`);
          mode = 'web';
      }
      // TODO: Add validation for betType against allowed types?


       // --- Prepare Context ---
       const horizonHours = options.horizonHours || DEFAULT_HORIZON_HOURS;
       // Fetch user config - assuming it's passed in options if needed
       const userConfig = options.userConfig || null; // Example: await getConfig(options.chatId, 'ai');
        // Fetch schedule context - crucial for web/live modes
       const scheduleContext = (mode === 'web' || mode === 'live')
            ? await buildScheduleContextForAI(sportKey, horizonHours)
            : null; // No schedule context needed for pure DB mode
        // Fetch injury context (Placeholder - needs real implementation)
        const injuryContext = null; // await fetchInjuryReport(sportKey);


       const promptContext = {
            scheduleInfo: scheduleContext,
            injuryReport: injuryContext,
            userConfig: userConfig
            // Add other context like market trends if available
       };


      try {
          let rawAIParlayData;
          let generationStrategy = '';

          // --- Select Generation Strategy ---
          if (mode === 'web' || mode === 'live') {
              console.log(`🖥️ Using Web Research strategy (Mode: ${mode})`);
              generationStrategy = 'quantum_web_ev';
              const prompt = ElitePromptService.getWebResearchPrompt(sportKey, numLegs, betType, promptContext);
              rawAIParlayData = await this._callAIProvider(prompt);
          } else if (mode === 'db') {
              console.log(`💾 Using Database (+EV Scan) strategy (Mode: ${mode})`);
              generationStrategy = 'database_quant_ev';
              // DB mode uses internal logic, doesn't call external AI for leg selection
               rawAIParlayData = await this._generateDbQuantParlay(sportKey, numLegs, betType, horizonHours);
          } else {
              // Should not happen due to validation, but handle defensively
               throw new Error(`Unsupported mode: ${mode}`);
          }

           // --- Basic Structure Validation ---
           if (!rawAIParlayData || !Array.isArray(rawAIParlayData.legs) /* Removed length check here */ ) {
                console.error("❌ AI/DB function returned invalid structure (missing legs array):", rawAIParlayData);
                // Handle cases where DB mode might return 0 legs intentionally
                if (generationStrategy === 'database_quant_ev' && rawAIParlayData?.legs?.length === 0) {
                     console.log("✅ DB Quant mode found no +EV legs, returning empty parlay structure.");
                     // Return the structured "no bets found" response from _generateDbQuantParlay
                     return rawAIParlayData; // This structure indicates no bets found
                }
                throw new Error('AI or DB function failed to return a valid parlay structure with a legs array.');
           }


          // --- Process & Validate Legs ---
          // 1. Ensure Odds Exist (Defaults if necessary)
          let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);

           // 2. Schedule Validation (Only for AI modes, DB mode assumes valid games)
           let validationRate = 1.0; // Assume 100% for DB mode initially
           let finalLegs = processedLegs;

           if (generationStrategy === 'quantum_web_ev') {
                const { validatedLegs: scheduleValidatedLegs, validationRate: rate } = await validateAILegsAgainstSchedule(sportKey, processedLegs, horizonHours);
                validationRate = rate;
                // Filter out legs that failed schedule validation
                finalLegs = scheduleValidatedLegs.filter(leg => leg.real_game_validated);

                 if (finalLegs.length < originalLegCount) {
                    console.warn(`⚠️ ${originalLegCount - finalLegs.length} leg(s) removed due to schedule validation failure.`);
                }
                 if (finalLegs.length < 2) { // Need at least 2 legs for a parlay
                    console.error(`❌ Insufficient valid legs (${finalLegs.length}) remain after schedule validation.`);
                     // Return a specific structure indicating validation failure led to invalid parlay
                     return {
                        ...rawAIParlayData, // Keep metadata if available
                        legs: [], // No valid legs
                        combined_parlay_metrics: null,
                        riskAssessment: { overallRisk: 'REJECTED', risks: [{type: 'VALIDATION', severity: 'CRITICAL', message: 'Insufficient legs passed schedule validation.'}] },
                        recommendations: { primaryAction: 'DO NOT BET. AI proposed invalid games.' },
                        summary: { verdict: 'REJECTED', primaryAction: 'AI proposed invalid games.' },
                        research_metadata: { ...(rawAIParlayData.research_metadata || {}), validation_failed_insufficient_legs: true, generationStrategy }
                    };
                }
           }


          // --- Final Quantitative Evaluation ---
          console.log(`🔬 Performing final quantitative evaluation on ${finalLegs.length} leg(s)...`);
          const evaluationResult = await quantitativeService.evaluateParlay(finalLegs);

           // Check if quantitative service rejected the parlay
           if (evaluationResult.error || evaluationResult.summary?.verdict === 'REJECTED' || evaluationResult.riskAssessment?.overallRisk === 'REJECTED') {
                console.warn(`❌ Parlay REJECTED by Quantitative Service. Reason: ${evaluationResult.error || evaluationResult.summary?.primaryAction || evaluationResult.riskAssessment?.risks?.[0]?.message}`);
                 // Return the evaluation result directly as it contains the rejection details
                 return {
                     ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}), // Keep metadata
                     legs: finalLegs, // Show the legs that were evaluated
                     ...evaluationResult, // Include detailed rejection reason from quant service
                     research_metadata: { ...(rawAIParlayData.research_metadata || {}), quantitative_rejection: true, generationStrategy, validationRate: validationRate.toFixed(2) }
                 };
           }

          // --- Assemble Final Result ---
          const finalResult = {
              ...(rawAIParlayData.parlay_metadata ? { parlay_metadata: rawAIParlayData.parlay_metadata } : {}), // Use metadata if AI provided
              legs: finalLegs, // The final validated and processed legs
              // Use results directly from quantitativeService
              combined_parlay_metrics: evaluationResult.combined_parlay_metrics,
              riskAssessment: evaluationResult.riskAssessment,
              recommendations: evaluationResult.recommendations,
              summary: evaluationResult.summary,
              // Add research/generation metadata
              research_metadata: {
                  ...(rawAIParlayData.research_metadata || {}), // Keep original research notes if any
                  generationStrategy: generationStrategy,
                  mode: mode, // Store the requested mode
                  validationRate: parseFloat(validationRate.toFixed(2)),
                  finalLegCount: finalLegs.length
              },
               portfolio_construction: rawAIParlayData.portfolio_construction || evaluationResult.recommendations // Use AI's construction or quant recommendations
          };

          // Update metadata leg count if it differs
           if (finalResult.parlay_metadata) {
               finalResult.parlay_metadata.legs_count = finalLegs.length;
           }


          console.log(`✅ Successfully generated and evaluated EV-driven parlay [${requestId}]. Verdict: ${finalResult.summary?.verdict}`);
          return finalResult;

      } catch (error) {
          console.error(`❌ EV-Driven parlay generation failed critically [${requestId}]:`, error.message);
          // Log specific error details potentially
          sentryService.captureError(error, {
              component: 'aiService', operation: 'generateParlay_Overall', sportKey, mode, numLegs, level: 'error'
          });

          // Attempt fallback ONLY if the error wasn't during fallback itself
          if (generationStrategy !== 'quantum_fallback_ev') {
                console.log(`🔄 Attempting FALLBACK generation for [${requestId}] due to critical error...`);
                try {
                     // Pass necessary context to fallback
                    return await this._generateFallbackParlay(sportKey, numLegs, betType, promptContext);
                } catch (fallbackError) {
                    console.error(`❌ FALLBACK generation ALSO failed for [${requestId}]:`, fallbackError.message);
                    sentryService.captureError(fallbackError, { component: 'aiService', operation: 'generateParlay_Fallback', sportKey, level: 'fatal' });
                    // Throw a user-friendly error if even fallback fails
                    throw new Error(`AI analysis failed for ${sportKey}. Both primary and fallback attempts failed.`);
                }
           } else {
                 // If the error occurred during fallback, throw directly
                 throw new Error(`AI fallback analysis failed for ${sportKey}: ${error.message}`);
           }
      }
  }


  // Refactored DB Quant Logic
  async _generateDbQuantParlay(sportKey, numLegs, betType, horizonHours) {
        try {
            const allGames = await gamesService.getGamesForSport(sportKey, {
                hoursAhead: horizonHours,
                includeOdds: true, // Essential for EV
                useCache: false, // Use fresh data
            });

            if (!Array.isArray(allGames) || allGames.length === 0) {
                 console.warn(`⚠️ DB Quant: No games found for ${sportKey}.`);
                 return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', "No games available in database.");
            }

            console.log(`🔍 DB Quant: Scanning ${allGames.length} ${sportKey} games for +EV plays...`);
            const bestPlays = await this._findBestValuePlays(allGames); // Uses updated EV calc

            if (bestPlays.length === 0) {
                 console.log(`🚫 DB Quant: No +EV plays found for ${sportKey}.`);
                 return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `No profitable (+EV) bets found among ${allGames.length} games.`);
            }

            console.log(`✅ DB Quant: Found ${bestPlays.length} +EV plays. Selecting top ${Math.min(numLegs, bestPlays.length)}.`);
            const topPlays = bestPlays.slice(0, numLegs); // Take up to numLegs

            // Format legs for quantitativeService, including necessary fields
            const parlayLegs = topPlays.map(play => this._formatPlayAsLeg(play, sportKey));

            // Return a structure similar to AI output, but without calling external AI
            // Quantitative service will evaluate this structure later in the main generateParlay flow
             const parlayData = {
                legs: parlayLegs,
                parlay_metadata: {
                    sport: gamesService._formatSportKey(sportKey), // Use helper if available
                    sport_key: sportKey,
                    legs_count: parlayLegs.length,
                    bet_type: betType,
                    analyst_tier: "QUANTITATIVE (DB Scan)",
                    generated_at: new Date().toISOString(),
                    data_sources_used: ["Internal Database", "Cache"],
                },
                 portfolio_construction: {
                    overall_thesis: `Constructed from the top ${parlayLegs.length} +EV bets identified via database scan and no-vig calculation.`,
                     key_risk_factors: ["Based on cached/DB odds, verify live prices", "Model is simple no-vig calc"],
                     clv_plan: "Verify odds match or beat calculated price before betting."
                },
                 research_metadata: { // Add metadata specific to this mode
                    mode: 'db',
                    generationStrategy: 'database_quant_ev',
                    games_scanned: allGames.length,
                    ev_plays_found: bestPlays.length,
                    legs_used: parlayLegs.length,
                }
                // quantitative_analysis will be added by the main function after calling quantitativeService.evaluateParlay
            };
            return parlayData;


        } catch (error) {
            console.error(`❌ DB Quant mode failed critically for ${sportKey}:`, error.message);
            sentryService.captureError(error, { component: 'aiService', operation: '_generateDbQuantParlay', sportKey, level: 'error' });
            // Return empty structure on failure
            return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'db', `Error during database analysis: ${error.message}`);
        }
    }

    // Helper to format DB play into AI leg structure
     _formatPlayAsLeg(play, sportKey) {
        const decimalOdds = ProbabilityCalculator.americanToDecimal(play.outcome.price);
        const impliedProb = ProbabilityCalculator.impliedProbability(decimalOdds);
        const edge = (play.noVigProb / impliedProb - 1) * 100;

        return {
            sportsbook: play.game.source || 'Database Odds', // Source from game data
            market_type: play.market.key,
            line: play.outcome.point ?? null, // Use null if point is undefined/0
            price: play.outcome.price,
            region: 'us', // Assuming US region for DB data
            timestamp: play.game.last_updated || new Date().toISOString(), // Use game update time if available
            implied_probability: parseFloat(impliedProb.toFixed(4)),
            model_probability: parseFloat(play.noVigProb.toFixed(4)), // Use no-vig as model prob
            edge_percent: parseFloat(edge.toFixed(2)),
            ev_per_100: parseFloat(play.ev.toFixed(2)),
             kelly_fraction_full: parseFloat(ProbabilityCalculator.kellyFraction(decimalOdds, play.noVigProb).toFixed(4)),
            clv_target_price: null, // Cannot easily determine CLV target from DB odds alone
            injury_gates: null, // DB mode doesn't have live injury checks
            market_signals: null, // DB mode doesn't have live market signals
            correlation_notes: "Assumed low correlation (cross-game).", // Basic assumption
            // Add fields needed by quantitativeService directly
            event: `${play.game.away_team} @ ${play.game.home_team}`,
            game: `${play.game.away_team} @ ${play.game.home_team}`,
            gameId: play.game.event_id,
            sport_key: sportKey,
            commence_time: play.game.commence_time,
            market: play.market.key,
            selection: `${play.outcome.name} ${play.outcome.point ?? ''}`.trim(),
            pick: `${play.outcome.name} ${play.outcome.point ?? ''}`.trim(),
            odds: { american: play.outcome.price }, // Keep original odds format too
             odds_decimal: decimalOdds,
             fair_prob: play.noVigProb,
             no_vig_prob: play.noVigProb,
             confidence: play.noVigProb,
             real_game_validated: true, // Assume DB games are valid
             best_quote: { decimal: decimalOdds }
        };
    }

   // Helper to create a consistent empty/failed response
    _createEmptyParlayResponse(sportKey, numLegs, betType, mode, reason) {
         return {
            legs: [],
            parlay_metadata: { sport: gamesService._formatSportKey(sportKey), sport_key: sportKey, legs_count: 0, bet_type: betType, analysis_mode: mode, generated_at: new Date().toISOString() },
            combined_parlay_metrics: null,
            riskAssessment: { overallRisk: 'REJECTED', risks:[{ type: 'GENERATION', severity: 'CRITICAL', message: reason }] },
            recommendations: { primaryAction: `DO NOT BET. ${reason}` },
            summary: { verdict: 'REJECTED', primaryAction: reason },
            portfolio_construction: { overall_thesis: reason },
            research_metadata: { mode, generationStrategy: mode === 'db' ? 'database_quant_ev' : 'unknown', generation_failed_reason: reason }
         };
    }


  async _generateFallbackParlay(sportKey, numLegs, betType, context = {}) {
      console.warn(`⚠️ Triggering FALLBACK generation (EV-Driven) for ${sportKey} (${numLegs} legs, ${betType})`);
      const generationStrategy = 'quantum_fallback_ev'; // Specific strategy name
      const prompt = ElitePromptService.getFallbackPrompt(sportKey, numLegs, betType, context);

       try {
           const rawAIParlayData = await this._callAIProvider(prompt); // Use default model

            // --- Basic Structure Validation ---
           if (!rawAIParlayData || !Array.isArray(rawAIParlayData.legs) || rawAIParlayData.legs.length === 0) {
               console.error("❌ Fallback AI response lacked valid 'legs' array or returned empty:", rawAIParlayData);
               throw new Error('Fallback AI failed to provide a valid parlay structure.');
           }

            // --- Process Legs ---
           let processedLegs = this._ensureLegsHaveOdds(rawAIParlayData.legs);
            // Ensure correct number of legs (slice if AI gave too many)
            processedLegs = processedLegs.slice(0, numLegs);
            // Mark legs as unvalidated (critical for fallback)
           processedLegs = processedLegs.map(leg => ({ ...leg, real_game_validated: false, timestamp: new Date().toISOString() })); // Add timestamp


            // --- Final Quantitative Evaluation ---
           console.log(`🔬 Evaluating FALLBACK parlay with ${processedLegs.length} leg(s)...`);
            // Use quantitativeService even for fallback to get EV/Kelly based on AI *estimates*
           const evaluationResult = await quantitativeService.evaluateParlay(processedLegs);

            // --- Assemble Final Result ---
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
                   generationStrategy: generationStrategy,
                   validationRate: 0.00, // Explicitly 0% validation
                   finalLegCount: processedLegs.length,
                   note: 'Generated using fundamental analysis & ESTIMATED odds/probabilities without real-time data or validation.'
               },
               error: evaluationResult.error // Pass error from quant service if any
           };

            // Adjust metadata/summary for fallback context
            if (finalResult.parlay_metadata) {
                finalResult.parlay_metadata.analysis_mode = "FALLBACK";
                 finalResult.parlay_metadata.legs_count = processedLegs.length;
            }
             if (finalResult.summary) {
                finalResult.summary.confidence = 'LOW'; // Override confidence to LOW for fallback
                 finalResult.summary.verdict = finalResult.summary.verdict === 'POSITIVE_EV' ? 'FALLBACK_POSITIVE_EV' : finalResult.summary.verdict; // Distinguish fallback EV
            }
             if (finalResult.recommendations?.primaryAction && !finalResult.recommendations.primaryAction.includes("FALLBACK")) {
                 finalResult.recommendations.primaryAction = `[FALLBACK MODE] ${finalResult.recommendations.primaryAction} Strongly advise caution & verification.`;
             }
             // Ensure high risk due to fallback nature
            if (finalResult.riskAssessment && finalResult.riskAssessment.overallRisk !== 'REJECTED') {
                 finalResult.riskAssessment.overallRisk = 'HIGH';
                 finalResult.riskAssessment.risks.push({ type: 'DATA_SOURCE', severity: 'HIGH', message: 'Parlay generated in fallback mode with estimated data.', impact: 'EV and probabilities are estimates, actual risk may be higher.' });
             }


            console.log(`✅ Fallback generation completed for ${sportKey}. Verdict: ${finalResult.summary?.verdict}`);
            return finalResult;

        } catch (fallbackError) {
             console.error(`❌ FallBACK generation failed critically [${sportKey}]:`, fallbackError.message);
             sentryService.captureError(fallbackError, { component: 'aiService', operation: '_generateFallbackParlay', sportKey, level: 'fatal' });
             // If fallback itself fails, return a structured error response
            return this._createEmptyParlayResponse(sportKey, numLegs, betType, 'fallback', `Fallback AI analysis failed: ${fallbackError.message}`);
        }
    }


  // --- Generic Chat Function (Placeholder/Example) ---
    async genericChat(modelIdentifier, messages) {
     console.log(`💬 Calling generic chat with model identifier: ${modelIdentifier}`);
     // Simple pass-through for now, assuming modelIdentifier maps directly or using default
     // Requires _callAIProvider to handle non-JSON responses gracefully if needed
     try {
         const prompt = `System: Be helpful and concise. Respond naturally.\n${messages.map(m => `${m.role}: ${m.content}`).join('\n')}`;
         // This call expects JSON by default, might need adjustment for pure chat
         const responseJson = await this._callAIProvider(prompt, AI_MODELS.perplexity); // Using perplexity as default chat model
         // Extract relevant text content if responseJson isn't just the string
         return responseJson?.text || responseJson?.content || JSON.stringify(responseJson) || 'Could not get chat response.';
     } catch (error) {
          console.error(`❌ Generic chat failed: ${error.message}`);
          sentryService.captureError(error, { component: 'aiService', operation: 'genericChat' });
          return `Sorry, I encountered an error: ${error.message}`;
     }
  }

 // --- Validate Odds (Simple Placeholder) ---
 // This is less critical now as odds structure is checked in quant service
 async validateOdds(oddsData) {
     if (!Array.isArray(oddsData)) return { valid: false, message: "Input is not an array." };
     // Basic check: does at least one game have some bookmaker info?
     const hasAnyBookmaker = oddsData.some(game => Array.isArray(game.bookmakers));
     return { valid: hasAnyBookmaker, message: hasAnyBookmaker ? "Data contains bookmaker arrays." : "No bookmaker arrays found." };
 }

} // End AIService Class

// Export Singleton Instance
export default new AIService();

// Export ProbabilityCalculator if needed by other modules (though it's internal to quant now)
// export { ProbabilityCalculator }; // Probably not needed externally anymore
