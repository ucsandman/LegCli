// auth — who is allowed in. Loopback with no token is open; any other bind
// address refuses to start without a token, and with a token every /api
// request needs `Authorization: Bearer <token>` (timing-safe). With `baton
// share` on, each human has their own token and the board knows their name
// and role (src/share.mjs); a loopback request is still the owner, so the
// machine's own browser needs nothing.
import { timingSafeEqual } from 'node:crypto'
import { identify, isOn as shareIsOn, personNamed } from './share.mjs'

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

export function checkBind({ bind, token, share = null }) {
  // share on means every request carries a personal token, so the bind is guarded
  if (!isLoopback(bind) && !token && !shareIsOn(share ?? undefined)) throw new BindRefused(bind)
  return true
}

export function remoteAddress(req) { return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '' }

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

// → { ok, subject, person } where person is { name, role } when share is on.
export function authorize({ token, req, url, share = null }) {
  const presented = presentedToken(req, url)
  if (shareIsOn(share ?? undefined)) {
    const person = identify(share, presented)
    if (person) return { ok: true, subject: person.name, person }
    // the machine's own browser is the owner: a personal token is for other
    // people. share.loopback_owner = false asks for a token even here.
    if (!presented && share.loopback_owner !== false && isLoopback(remoteAddress(req))) {
      const owner = personNamed(share, share.owner) ?? share.people.find((p) => p.role === 'owner') ?? null
      if (owner) return { ok: true, subject: owner.name, person: owner }
    }
    return { ok: false, subject: null, person: null }
  }
  if (!token) return { ok: true, subject: 'local', person: null }
  if (tokenMatches(token, presented)) return { ok: true, subject: 'token', person: null }
  return { ok: false, subject: null, person: null }
}
