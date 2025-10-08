// src/utils/aiResponseParser.js - SAFE MODULAR FIX

export function safeExtractJSON(text = '') {
    if (!text || typeof text !== 'string') {
        console.warn('❌ AI response was empty or not a string');
        return null;
    }

    try {
        // Try multiple extraction methods
        const jsonBlockRegex = /```json\s*([\s\S]+?)\s*```/;
        const match = text.match(jsonBlockRegex);
        
        if (match && match[1]) {
            return JSON.parse(match[1].trim());
        }

        // Look for any JSON object
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        console.warn('❌ No JSON found in AI response');
        return null;
    } catch (error) {
        console.warn('❌ Failed to parse AI response as JSON:', error.message);
        console.log('📝 Raw AI response:', text.substring(0, 500) + '...');
        return null;
    }
}

export function validateParlayStructure(parlayData) {
    if (!parlayData || typeof parlayData !== 'object') {
        return { isValid: false, error: 'Parlay data is not an object' };
    }

    // Check for required structure
    if (!Array.isArray(parlayData.legs)) {
        return { isValid: false, error: 'Missing legs array' };
    }

    if (parlayData.legs.length === 0) {
        return { isValid: false, error: 'Empty legs array' };
    }

    // Validate each leg
    for (let i = 0; i < parlayData.legs.length; i++) {
        const leg = parlayData.legs[i];
        if (!leg || typeof leg !== 'object') {
            return { isValid: false, error: `Leg ${i + 1} is not an object` };
        }

        if (!leg.event || typeof leg.event !== 'string') {
            return { isValid: false, error: `Leg ${i + 1} missing event` };
        }

        if (!leg.selection || typeof leg.selection !== 'string') {
            return { isValid: false, error: `Leg ${i + 1} missing selection` };
        }

        if (!leg.market || typeof leg.market !== 'string') {
            return { isValid: false, error: `Leg ${i + 1} missing market` };
        }
    }

    return { isValid: true };
}

export function createFallbackParlay(sportKey, numLegs, error) {
    console.log(`🔄 Creating fallback parlay for ${sportKey} due to: ${error}`);
    
    return {
        legs: [],
        reasoning: `Unable to generate AI parlay: ${error}. Please try again or use a different sport.`,
        sport: sportKey,
        confidence: 0,
        parlay_price_decimal: 1,
        parlay_price_american: 0,
        quantitative_analysis: { error: 'Fallback mode' },
        research_metadata: { 
            fallback_used: true,
            error: error.message || error
        }
    };
}
