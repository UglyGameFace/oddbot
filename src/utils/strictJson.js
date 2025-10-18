// src/utils/strictJson.js
export function strictExtractJSONObject(text) {
  if (typeof text !== 'string') throw new Error('AI output is not text');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found');
  const candidate = text.slice(start, end + 1).trim();
  if (candidate.startsWith('``````')) {
    throw new Error('Fenced code block detected');
  }
  return JSON.parse(candidate);
}
