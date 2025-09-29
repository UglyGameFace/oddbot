// src/services/cacheService.js

export default function makeCache(redis) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function getOrSetJSON(key, ttlSec, loader, { lockMs = 8000, retryMs = 150 } = {}) {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);

    const lockKey = `lock:${key}`;
    const gotLock = await redis.set(lockKey, '1', { NX: true, PX: lockMs });

    if (gotLock) {
      try {
        const data = await loader();
        await redis.set(key, JSON.stringify(data), { EX: ttlSec });
        return data;
      } finally {
        await redis.del(lockKey);
      }
    } else {
      const deadline = Date.now() + lockMs;
      while (Date.now() < deadline) {
        await sleep(retryMs);
        const again = await redis.get(key);
        if (again) return JSON.parse(again);
      }
      // If still not available, compute once
      const data = await loader();
      await redis.set(key, JSON.stringify(data), { EX: ttlSec });
      return data;
    }
  }

  return { getOrSetJSON };
}
