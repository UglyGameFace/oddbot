// src/utils/strictJson.js
export function strictExtractJSONObject(text) {
  if (typeof text !== 'string') throw new Error('AI output is not text');
  
  // Clean the text first - remove code fences and normalize
  let cleanedText = text.trim();
  
  // Remove markdown code fences
  cleanedText = cleanedText.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
  
  // Find the first { and last } for the JSON object
  const start = cleanedText.indexOf('{');
  const end = cleanedText.lastIndexOf('}');
  
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found - missing { or }');
  }
  
  const candidate = cleanedText.slice(start, end + 1).trim();
  
  // Check for empty or invalid candidates
  if (!candidate || candidate.length < 2) {
    throw new Error('Empty or invalid JSON candidate');
  }
  
  // Check for fenced code blocks (basic check)
  if (candidate.startsWith('``````')) {
    throw new Error('Fenced code block detected');
  }
  
  try {
    // Parse the JSON - emojis are valid in JSON strings, so this should work
    const parsed = JSON.parse(candidate);
    
    // Additional validation for our expected structure
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Parsed JSON is not an object');
    }
    
    return parsed;
  } catch (parseError) {
    // Enhanced error information
    const errorInfo = {
      message: parseError.message,
      candidateLength: candidate.length,
      candidateStart: candidate.substring(0, 100),
      candidateEnd: candidate.substring(candidate.length - 50)
    };
    
    console.error('❌ strictExtractJSONObject parse error:', errorInfo);
    
    // Try to fix common JSON issues before re-throwing
    try {
      const fixedCandidate = fixCommonJSONIssues(candidate);
      return JSON.parse(fixedCandidate);
    } catch (fixedError) {
      // If fixed version also fails, throw original error with more context
      throw new Error(`JSON parse failed: ${parseError.message}. Candidate: ${candidate.substring(0, 200)}...`);
    }
  }
}

// Helper function to fix common JSON issues
function fixCommonJSONIssues(jsonString) {
  let fixed = jsonString;
  
  // Fix 1: Remove trailing commas
  fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  
  // Fix 2: Add missing commas between objects in arrays
  fixed = fixed.replace(/\}\s*\{/g, '}, {');
  
  // Fix 3: Fix unquoted keys (basic cases)
  fixed = fixed.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  
  // Fix 4: Replace single quotes with double quotes
  fixed = fixed.replace(/'/g, '"');
  
  // Fix 5: Handle emoji symbols that might cause issues (though they shouldn't in strings)
  // This is just for safety - emojis in strings should be fine in JSON
  
  // Fix 6: Remove any non-printable characters
  fixed = fixed.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
  
  console.log('🛠️ Applied JSON fixes to candidate');
  return fixed;
}

// NEW: Function to extract and validate the specific structure we expect from AI
export function extractAIParlayJSON(text) {
  try {
    const parsed = strictExtractJSONObject(text);
    
    // Validate it has the basic structure we expect
    if (!parsed.legs || !Array.isArray(parsed.legs)) {
      throw new Error('AI response missing "legs" array');
    }
    
    // Validate each leg has required fields (with emoji support)
    const validatedLegs = parsed.legs.map((leg, index) => {
      if (!leg || typeof leg !== 'object') {
        throw new Error(`Leg ${index} is not a valid object`);
      }
      
      if (typeof leg.selection !== 'string' || !leg.selection.trim()) {
        throw new Error(`Leg ${index} missing valid "selection" field`);
      }
      
      if (typeof leg.event !== 'string' || !leg.event.trim()) {
        throw new Error(`Leg ${index} missing valid "event" field`);
      }
      
      // Price/odds can be in different formats, we'll handle that in normalization
      const hasPrice = leg.price !== undefined || (leg.odds && leg.odds.american !== undefined);
      if (!hasPrice) {
        throw new Error(`Leg ${index} missing price/odds information`);
      }
      
      return leg;
    });
    
    // Return the validated structure
    return {
      ...parsed,
      legs: validatedLegs
    };
    
  } catch (error) {
    console.error('❌ extractAIParlayJSON validation failed:', error.message);
    throw error;
  }
}

// NEW: Function to normalize emoji symbols from AI response
export function normalizeAISymbols(aiData) {
  if (!aiData || typeof aiData !== 'object') return aiData;
  
  const normalized = JSON.parse(JSON.stringify(aiData));
  
  // Process legs array
  if (Array.isArray(normalized.legs)) {
    normalized.legs = normalized.legs.map(leg => {
      const normalizedLeg = { ...leg };
      
      // Normalize line values (spread/totals)
      if (typeof normalizedLeg.line === 'string') {
        if (normalizedLeg.line.startsWith('➕')) {
          normalizedLeg.line = parseFloat(normalizedLeg.line.slice(1));
        } else if (normalizedLeg.line.startsWith('➖')) {
          normalizedLeg.line = parseFloat(normalizedLeg.line.slice(1)) * -1;
        } else {
          // Try to parse as number if it's already in standard format
          const parsed = parseFloat(normalizedLeg.line);
          if (!isNaN(parsed)) normalizedLeg.line = parsed;
        }
      }
      
      // Normalize price values (odds)
      if (typeof normalizedLeg.price === 'string') {
        if (normalizedLeg.price.startsWith('➕')) {
          normalizedLeg.price = parseFloat(normalizedLeg.price.slice(1));
        } else if (normalizedLeg.price.startsWith('➖')) {
          normalizedLeg.price = parseFloat(normalizedLeg.price.slice(1)) * -1;
        } else {
          // Try to parse as number if it's already in standard format
          const parsed = parseFloat(normalizedLeg.price);
          if (!isNaN(parsed)) normalizedLeg.price = parsed;
        }
      }
      
      // Normalize selection text for display
      if (typeof normalizedLeg.selection === 'string') {
        normalizedLeg.selection = normalizedLeg.selection
          .replace(/➕/g, '+')
          .replace(/➖/g, '-')
          .replace(/📈/g, 'Over')
          .replace(/📉/g, 'Under')
          .replace(/🏠/g, 'Home')
          .replace(/✈️/g, 'Away')
          .replace(/⭐/g, 'Favorite')
          .replace(/🔺/g, '↑')
          .replace(/🔻/g, '↓');
      }
      
      return normalizedLeg;
    });
  }
  
  return normalized;
}

// NEW: Combined function that extracts and normalizes in one step
export function extractAndNormalizeAIParlay(text) {
  try {
    const extracted = extractAIParlayJSON(text);
    const normalized = normalizeAISymbols(extracted);
    return normalized;
  } catch (error) {
    console.error('❌ extractAndNormalizeAIParlay failed:', error.message);
    throw error;
  }
}
