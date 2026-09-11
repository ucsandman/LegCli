// ratelimit — fixed windows for the board's API, in memory (one process, and a
// restart is a fresh window). Two buckets: requests per identity (a person's
// name when they are known, else the client address) so one client cannot
// flood the board, and failed authorizations per address so a token cannot be
// guessed at speed. Both are deliberately generous: the board itself polls.
import { createHash } from 'node:crypto'

const WINDOW_MS = 60000

export function createLimiter({
  windowMs = WINDOW_MS,
  max = Number(process.env.BATON_RATE_MAX || 600),
  maxFailures = Number(process.env.BATON_RATE_MAX_FAILURES || 20),
} = {}) {
  const hits = new Map()
  const fails = new Map()
  const tried = new Map()
  const sweep = (map, now) => { for (const [k, v] of map) if (now - v.start >= windowMs) map.delete(k) }
  const bump = (map, key, limit, now) => {
    if (map.size > 1000) sweep(map, now)
    const cur = map.get(key)
    if (!cur || now - cur.start >= windowMs) { map.set(key, { start: now, n: 1 }); return { ok: true, count: 1, retry_after: 0 } }
    cur.n += 1
    if (cur.n > limit) return { ok: false, count: cur.n, retry_after: Math.max(1, Math.ceil((cur.start + windowMs - now) / 1000)) }
    return { ok: true, count: cur.n, retry_after: 0 }
  }
  // Guessing means trying tokens; a board page retrying the one token it was
  // given (a tab open since `share rotate`) is not, and must not lock the
  // machine it runs on out of its own board. One value counts once a window.
  const guess = (key, token, now) => {
    if (!token) return true
    const h = createHash('sha256').update(String(token)).digest('hex')
    const cur = tried.get(key)
    if (!cur || now - cur.start >= windowMs) { if (tried.size > 1000) sweep(tried, now); tried.set(key, { start: now, seen: new Set([h]) }); return true }
    if (cur.seen.has(h)) return false
    cur.seen.add(h)
    return true
  }
  return {
    request: (key, now = Date.now()) => bump(hits, key, max, now),
    failure: (key, token = null, now = Date.now()) => (guess(key, token, now) ? bump(fails, key, maxFailures, now) : { ok: true, count: fails.get(key)?.n ?? 0, retry_after: 0 }),
    // true once this address has spent its failed-token budget for the window
    lockedOut: (key, now = Date.now()) => { const cur = fails.get(key); return Boolean(cur && now - cur.start < windowMs && cur.n > maxFailures) },
    retryAfter: (key, now = Date.now()) => { const cur = fails.get(key); return cur ? Math.max(1, Math.ceil((cur.start + windowMs - now) / 1000)) : 1 },
    reset: () => { hits.clear(); fails.clear(); tried.clear() },
    max,
    maxFailures,
  }
}
