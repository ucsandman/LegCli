// ratelimit — fixed windows for the board's API, in memory (one process, and a
// restart is a fresh window). Two buckets: requests per identity (a person's
// name when they are known, else the client address) so one client cannot
// flood the board, and failed authorizations per address so a token cannot be
// guessed at speed. Both are deliberately generous: the board itself polls.
const WINDOW_MS = 60000

export function createLimiter({
  windowMs = WINDOW_MS,
  max = Number(process.env.BATON_RATE_MAX || 600),
  maxFailures = Number(process.env.BATON_RATE_MAX_FAILURES || 20),
} = {}) {
  const hits = new Map()
  const fails = new Map()
  const sweep = (map, now) => { for (const [k, v] of map) if (now - v.start >= windowMs) map.delete(k) }
  const bump = (map, key, limit, now) => {
    if (map.size > 1000) sweep(map, now)
    const cur = map.get(key)
    if (!cur || now - cur.start >= windowMs) { map.set(key, { start: now, n: 1 }); return { ok: true, count: 1, retry_after: 0 } }
    cur.n += 1
    if (cur.n > limit) return { ok: false, count: cur.n, retry_after: Math.max(1, Math.ceil((cur.start + windowMs - now) / 1000)) }
    return { ok: true, count: cur.n, retry_after: 0 }
  }
  return {
    request: (key, now = Date.now()) => bump(hits, key, max, now),
    failure: (key, now = Date.now()) => bump(fails, key, maxFailures, now),
    // true once this address has spent its failed-token budget for the window
    lockedOut: (key, now = Date.now()) => { const cur = fails.get(key); return Boolean(cur && now - cur.start < windowMs && cur.n > maxFailures) },
    retryAfter: (key, now = Date.now()) => { const cur = fails.get(key); return cur ? Math.max(1, Math.ceil((cur.start + windowMs - now) / 1000)) : 1 },
    reset: () => { hits.clear(); fails.clear() },
    max,
    maxFailures,
  }
}
