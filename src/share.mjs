// share — optional multiplayer for the board, off until `baton share on`
// writes $BATON_HOME/share.json. With it on, the board binds the Tailscale or
// LAN address, every human has a name and their own token (kept as a sha256
// hash: a token is printed once and `baton share rotate` issues a new one),
// and every session belongs to the human whose terminal started it
// (`BATON_PERSON`, else the owner). With it off nothing changes: loopback is
// open and `BATON_TOKEN` is the only token.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { networkInterfaces, userInfo } from 'node:os'
import { createSocket } from 'node:dgram'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic } from './fsx.mjs'

export const OFF = { version: 1, on: false, bind: null, bind_kind: null, port: null, owner: null, people: [] }
export const ROLES = ['owner', 'guest']

export function sharePath() { return join(home(), 'share.json') }

export function readShare() {
  const f = sharePath()
  if (!existsSync(f)) return { ...OFF }
  try {
    const s = JSON.parse(readFileSync(f, 'utf8'))
    return { ...OFF, ...s, people: Array.isArray(s.people) ? s.people : [] }
  } catch { return { ...OFF } }
}

export function writeShare(share) {
  mkdirSync(home(), { recursive: true })
  writeJsonAtomic(sharePath(), share)
  return share
}

// On means: turned on, bound somewhere, and at least one person to let in.
export function isOn(share = readShare()) { return Boolean(share.on && share.people.length && share.bind) }

export function hashToken(token) { return createHash('sha256').update(String(token)).digest('hex') }
export function newToken() { return randomBytes(24).toString('base64url') }
export function validName(name) { return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(name ?? '')) }

// Which person presented this token, in constant time. null for no match.
export function identify(share, presented) {
  if (!presented || !share?.people?.length) return null
  const h = Buffer.from(hashToken(presented))
  let found = null
  for (const p of share.people) {
    const q = Buffer.from(String(p.token_sha256 ?? '').padEnd(h.length, '0').slice(0, h.length))
    if (timingSafeEqual(h, q) && p.token_sha256) found = found ?? p
  }
  return found
}

export function personNamed(share, name) { return share.people.find((p) => p.name.toLowerCase() === String(name ?? '').toLowerCase()) ?? null }
export function isOwner(person) { return person?.role === 'owner' }

export function addPerson(name, { role = 'guest', share = readShare() } = {}) {
  if (!validName(name)) throw new Error(`bad name "${name}": letters, digits, dash and underscore, up to 32 characters`)
  if (!ROLES.includes(role)) throw new Error(`bad role "${role}" (owner|guest)`)
  if (personNamed(share, name)) throw new Error(`"${name}" is already on the board; baton share rotate ${name} issues a new link`)
  const token = newToken()
  const person = { name, role, token_sha256: hashToken(token), created_at: new Date().toISOString(), last_seen: null }
  share.people.push(person)
  writeShare(share)
  return { person, token, share }
}

export function removePerson(name, share = readShare()) {
  const before = share.people.length
  share.people = share.people.filter((p) => p.name.toLowerCase() !== String(name).toLowerCase())
  if (share.people.length === before) throw new Error(`no one called "${name}" on this board`)
  if (share.owner && share.owner.toLowerCase() === String(name).toLowerCase()) share.owner = share.people.find((p) => p.role === 'owner')?.name ?? null
  writeShare(share)
  return share
}

export function rotate(name, share = readShare()) {
  const person = personNamed(share, name)
  if (!person) throw new Error(`no one called "${name}" on this board`)
  const token = newToken()
  person.token_sha256 = hashToken(token)
  person.rotated_at = new Date().toISOString()
  writeShare(share)
  return { person, token, share }
}

function ipv4s() {
  const out = []
  for (const [name, list] of Object.entries(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address })
  return out
}

// The address of the interface the default route uses, without sending a byte.
function defaultRouteAddress() {
  return new Promise((resolvePromise) => {
    const s = createSocket('udp4')
    const done = (v) => { try { s.close() } catch {} resolvePromise(v) }
    s.on('error', () => done(null))
    try { s.connect(53, '8.8.8.8', () => { try { done(s.address().address) } catch { done(null) } }) } catch { done(null) }
  })
}

// 'tailscale' (default), 'lan', or an address to use as given.
export async function resolveBind(kind = 'tailscale') {
  const want = String(kind).toLowerCase()
  if (!['tailscale', 'lan'].includes(want)) return want
  const addrs = ipv4s()
  if (want === 'tailscale') {
    const ts = addrs.find((a) => /tailscale/i.test(a.name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))
    if (!ts) throw new Error('no Tailscale address on this machine: use --bind lan, or --bind <address>')
    return ts.address
  }
  const viaRoute = await defaultRouteAddress()
  if (viaRoute && addrs.some((a) => a.address === viaRoute)) return viaRoute
  const lan = addrs.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) && !/tailscale|virtual|default switch|wsl/i.test(a.name))
  if (!lan) throw new Error('no LAN address found: pass --bind <address>')
  return lan.address
}

export function linkFor(share, token) { return `http://${share.bind}:${share.port}/?token=${token}` }

// Whose terminal this is: BATON_PERSON, else the board's owner, else 'local'.
export function whoami(share = readShare()) {
  const named = String(process.env.BATON_PERSON ?? '').trim()
  if (named && validName(named)) return named
  return share.owner || 'local'
}

export async function turnOn({ bind = 'tailscale', port = Number(process.env.BATON_PORT || 4747), owner } = {}) {
  const share = readShare()
  const address = await resolveBind(bind)
  share.on = true
  share.bind = address
  share.bind_kind = ['tailscale', 'lan'].includes(String(bind).toLowerCase()) ? String(bind).toLowerCase() : 'address'
  share.port = port
  let token = null
  if (!share.people.length) {
    const name = validName(owner) ? owner : (validName(userInfo().username) ? userInfo().username.toLowerCase() : 'owner')
    share.owner = name
    writeShare(share)
    const added = addPerson(name, { role: 'owner', share })
    token = added.token
    return { share: added.share, owner: added.person, token }
  }
  if (!share.owner) share.owner = share.people.find((p) => p.role === 'owner')?.name ?? share.people[0].name
  writeShare(share)
  return { share, owner: personNamed(share, share.owner), token }
}

export function turnOff() {
  const share = readShare()
  share.on = false
  writeShare(share)
  return share
}
