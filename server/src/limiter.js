/** Tiny concurrency gate — resolves when a slot is free, call release() when done. */
export function createSemaphore(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) { active++; next(); }
  };
  return {
    async acquire() {
      if (active < max) { active++; return release; }
      await new Promise((resolve) => waiting.push(resolve));
      return release;
    },
    get pending() { return waiting.length; },
  };
}

/** Run `fn` over `items` with at most `concurrency` in flight, preserving order. */
export async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Per-key sliding-window rate limiter.
 *
 * Used for the hard requirement that we never exceed N lookups per unique
 * domain per minute regardless of how fast the rest of the pipeline runs —
 * a fast pipeline hammering one corporate mail server is exactly the behaviour
 * that gets a sender blocklisted.
 */
export function createRateLimiter({ perMinute, windowMs = 60_000 }) {
  const hits = new Map(); // key -> number[] of timestamps

  function prune(key, now) {
    const arr = hits.get(key);
    if (!arr) return [];
    let i = 0;
    while (i < arr.length && arr[i] <= now - windowMs) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length === 0) hits.delete(key);
    return arr;
  }

  return {
    /** Non-blocking: true if allowed (and counted), false if the window is full. */
    tryTake(key) {
      const now = Date.now();
      const arr = prune(key, now);
      if (arr.length >= perMinute) return false;
      if (!hits.has(key)) hits.set(key, []);
      hits.get(key).push(now);
      return true;
    },
    /** Blocking: waits until a slot in this key's window opens up. */
    async take(key, { signal } = {}) {
      while (true) {
        if (signal?.aborted) throw new Error('aborted');
        const now = Date.now();
        const arr = prune(key, now);
        if (arr.length < perMinute) {
          if (!hits.has(key)) hits.set(key, []);
          hits.get(key).push(now);
          return;
        }
        const waitMs = Math.max(25, arr[0] + windowMs - now);
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 2000)));
      }
    },
    /** Milliseconds until this key would be allowed again; 0 if allowed now. */
    retryAfterMs(key) {
      const now = Date.now();
      const arr = prune(key, now);
      if (arr.length < perMinute) return 0;
      return Math.max(0, arr[0] + windowMs - now);
    },
    reset(key) { hits.delete(key); },
  };
}
