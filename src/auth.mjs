// auth — the multiplayer-ready seam. v1 runs on loopback with no token; any
// other bind address refuses to start without BATON_TOKEN, and with a token
// every /api request needs `Authorization: Bearer <token>` (timing-safe).
import { timingSafeEqual } from 'node:crypto'

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']

export function isLoopback(bind) {
  return LOOPBACK.includes(String(bind ?? '').trim().toLowerCase())
}

export class BindRefused extends Error {
  constructor(bind) {
    super(`refusing to bind ${bind} without BATON_TOKEN; see README "Network exposure"`)
    this.name = 'BindRefused'
    this.exitCode = 3
  }
}

export function checkBind({ bind, token }) {
  if (!isLoopback(bind) && !token) throw new BindRefused(bind)
  return true
}

export function tokenMatches(token, presented) {
  if (!token || typeof presented !== 'string') return false
  const a = Buffer.from(token)
  const b = Buffer.from(presented)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Bearer header, or ?token= for EventSource (which cannot set headers).
export function presentedToken(req, url) {
  const h = req.headers.authorization
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim()
  return url.searchParams.get('token')
}

export function authorize({ token, req, url }) {
  if (!token) return { ok: true, subject: 'local' }
  const presented = presentedToken(req, url)
  if (tokenMatches(token, presented)) return { ok: true, subject: 'token' }
  return { ok: false, subject: null }
}
