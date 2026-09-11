// leases — pure helpers for deciding whether two cards' claimed leases (glob-ish
// path patterns) could touch the same files. Used to gate parallel station starts.
//
// The overlap check is a deliberate approximation biased toward false positives:
// when unsure we say overlapping, because a wrongly serialized card costs minutes
// and a wrongly parallel card can corrupt a merge.

// Backslashes to forward slashes, strip a leading './' or '/', collapse repeated
// slashes, strip a trailing '/'. Anything empty (or '**' itself) is the wildcard
// lease that overlaps everything.
export function normalize(p) {
  if (p === null || p === undefined || p === '' || p === '**') return '**'
  let s = String(p).replace(/\\/g, '/')
  s = s.replace(/^\.\//, '').replace(/^\/+/, '')
  s = s.replace(/\/+/g, '/')
  s = s.replace(/\/$/, '')
  return s === '' ? '**' : s
}

// Path segments before the first segment that contains a glob character.
export function literalPrefix(p) {
  const s = normalize(p)
  if (s === '**') return []
  const segments = s.split('/')
  const idx = segments.findIndex((seg) => seg.includes('*') || seg.includes('?'))
  return idx === -1 ? segments : segments.slice(0, idx)
}

// See file header: approximation biased toward false positives.
export function overlap(a, b) {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === '**' || nb === '**') return true
  if (na === nb) return true
  const pa = literalPrefix(a)
  const pb = literalPrefix(b)
  const len = Math.min(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    if (pa[i] !== pb[i]) return false
  }
  return true
}

export function anyOverlap(listA, listB) {
  const a = listA && listA.length ? listA : ['**']
  const b = listB && listB.length ? listB : ['**']
  for (const x of a) {
    for (const y of b) {
      if (overlap(x, y)) return true
    }
  }
  return false
}

// Every overlapping (holder lease, candidate lease) pair, in running order.
export function conflicts(candidate, running) {
  const candLeases = candidate.leases && candidate.leases.length ? candidate.leases : ['**']
  const out = []
  for (const holder of running) {
    const holderLeases = holder.leases && holder.leases.length ? holder.leases : ['**']
    for (const hLease of holderLeases) {
      for (const cLease of candLeases) {
        if (overlap(hLease, cLease)) {
          out.push({ holder: holder.card_id, lease: hLease, against: cLease })
        }
      }
    }
  }
  return out
}

// One row per lease of every running/handing_off card, sorted by card_id then lease.
export function held(cards) {
  const out = []
  for (const card of cards) {
    if (card.status !== 'running' && card.status !== 'handing_off') continue
    const leases = card.leases && card.leases.length ? card.leases : ['**']
    for (const lease of leases) {
      out.push({ lease, card_id: card.card_id, station: card.station, since: card.updated_at })
    }
  }
  out.sort((x, y) => (x.card_id === y.card_id
    ? (x.lease < y.lease ? -1 : x.lease > y.lease ? 1 : 0)
    : (x.card_id < y.card_id ? -1 : 1)))
  return out
}
