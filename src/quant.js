// quant.js

export function analyzeQuantitative(data, type = "default") {
    if (!Array.isArray(data) || data.length === 0) return null;

    const n = data.length;
    const mean = data.reduce((sum, v) => sum + v, 0) / n;

    const variance =
        data.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);

    const min = Math.min(...data);
    const max = Math.max(...data);

    const sorted = data.slice().sort((a, b) => a - b);
    const median =
        n % 2 === 0
            ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
            : sorted[Math.floor(n / 2)];

    return {
        count: n,
        type,
        mean,
        stdDev,
        min,
        max,
        median,
    };
}

export default analyzeQuantitative;
