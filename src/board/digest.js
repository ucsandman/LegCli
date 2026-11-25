// While you were away: the digest on the board. Data: /api/digest, the record
// `leg digest` prints (src/digest.mjs), owner-only like the audit trail
// because it names repositories and prompts (src/server.mjs).
//
// It sits above Terminals and reads on arrival: when the page loads, and again
// when a tab that was left open comes back into view with a read more than 30
// minutes old or from another calendar day. There is no timer and nothing here
// arrives over SSE (DESIGN.md rule 3: the live terminals lane is the only live
// region). Hide for today keeps it closed in this browser until the next
// calendar day (docs/review-2026-09-18.md, next move 3).
//
// Three states and nothing else. A refusal, a guest's or an operator's 403 or
// any other failure, draws nothing. A window where nothing moved is one line
// that still says how much it read (L2). Otherwise the volume and what needs a
// person, most urgent first, in the server's order.
//
// `el`, `api`, `getToken` and `ago` are copied from audit.js, which copied them
// from sessions.js; none of them can export from an IIFE.
(function () {
  'use strict'

  // the CLI's default window (DEFAULT_SINCE in src/digest.mjs), named in words
  // on the panel so the counts beside it can be checked against `leg digest`
  const SINCE = '8h'
  const SINCE_WORDS = 'the last 8 hours'
  const HIDDEN_KEY = 'legDigestHidden'
  // how old a read may be before the tab coming back into view asks again
  const STALE_MS = 30 * 60 * 1000

  // localStorage throws with site data blocked (sessions.js says where); a
  // board that cannot remember the hide shows the panel again, nothing worse
  function stored(key) { try { return localStorage.getItem(key) || '' } catch { return '' } }
  function store(key, value) { try { localStorage.setItem(key, value) } catch { /* nowhere to keep it */ } }
  function getToken() { return stored('legToken') || stored('batonToken') }
  async function api(path) {
    const headers = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const r = await fetch(path, { method: 'GET', headers })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`)
    return data
  }
  function el(tag, attrs, children) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) { if (v === null || v === undefined) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v) }
    for (const c of children || []) { if (c === null || c === undefined) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c) }
    return n
  }
  function ago(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
    const d = Math.floor(h / 24)
    return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
  }
  const since = (ts) => { const t = Date.parse(ts); return Number.isFinite(t) ? ago(Date.now() - t) : null }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  // the reader's own calendar day: Hide for today ends at their midnight
  function today() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const root = document.getElementById('digest')
  if (!root) return
  const meta = document.getElementById('digest-meta')
  const sub = document.getElementById('digest-sub')
  const list = document.getElementById('digest-list')
  const hide = document.getElementById('digest-hide')

  // the attention kinds src/digest.mjs emits, as the words and tones the
  // terminal rows already use (STATUS in sessions.js: waiting is warn, lost
  // is danger). A kind added there and not here still prints, in its own name.
  const KIND = {
    waiting_on_you: ['waiting on you', 'warn'],
    card_waiting_human: ['card waiting on you', 'warn'],
    card_needs_approval: ['card needs approval', 'warn'],
    card_paused: ['card paused', 'warn'],
    all_out: ['all out', 'warn'],
    card_failed: ['card failed', 'danger'],
    lost: ['lost', 'danger'],
  }

  // a terminal reads as the row below it does: a dot, the agent (and the login
  // when it is not the default), the short id in the data face
  function terminal(a) {
    return el('span', { class: 'digest-term' }, [
      el('span', { class: `dot id-${a.agent}`, 'aria-hidden': 'true' }),
      a.account && a.account !== 'default' ? `${a.agent}/${a.account}` : a.agent,
      el('span', { class: 'chip' }, [a.short]),
    ])
  }

  // the status word, then who over what in one column (the register over the
  // prompt, as a terminal row reads), then the clock
  function row(kind, who, what, when) {
    const [word, tone] = KIND[kind] || [String(kind).replace(/_/g, ' '), 'warn']
    return el('li', { class: 'digest-row' }, [
      el('span', { class: 'digest-kind' }, [el('span', { class: `mark tone-${tone}`, 'aria-hidden': 'true' }), word]),
      el('div', { class: 'digest-body' }, [
        who.length ? el('div', { class: 'digest-who' }, who) : null,
        el('p', { class: 'digest-what' }, [what]),
      ]),
      el('span', { class: 'digest-when' }, [when]),
    ])
  }

  function render(d) {
    const v = d.volume
    list.replaceChildren()
    if (!v.terminals && !v.cards && !v.landings) {
      root.classList.add('is-quiet')
      sub.hidden = true
      meta.textContent = `Nothing moved in ${SINCE_WORDS}. Read ${plural(v.sessions_on_disk, 'terminal')} and ${plural(v.cards_on_disk, 'card')} on disk.`
      return
    }
    root.classList.remove('is-quiet')
    meta.textContent = `In ${SINCE_WORDS}: ${plural(v.terminals, 'terminal')}, ${plural(v.cards, 'card')} and ${plural(v.landings, 'landing')} moved; ${plural(v.events, 'event')} read.`
    const attention = d.attention || []
    sub.hidden = false
    sub.replaceChildren(...(attention.length
      ? [document.createTextNode('Needs you'), el('span', { class: 'region-count' }, [String(attention.length)])]
      : [document.createTextNode('Nothing needs you')]))

    for (const a of attention.filter((x) => x.kind !== 'lost')) {
      // a card is named by its title, which the server's message opens with;
      // its short id is the last word of a slug and identifies nothing
      const who = a.agent ? [terminal(a)] : []
      const back = Number.isFinite(a.resets_at) ? `; back ${new Date(a.resets_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
      const when = since(a.since)
      list.appendChild(row(a.kind, who, `${a.message || ''}${back}`, when ? `${when} ago` : ''))
    }
    // every lost terminal is one row: the reason is the same for each, so it is
    // said once (DESIGN.md rule 4). The server sends them oldest first.
    const lost = attention.filter((x) => x.kind === 'lost').reverse()
    if (lost.length) {
      const shown = lost.slice(0, 4)
      const who = shown.map(terminal)
      if (lost.length > shown.length) who.push(el('span', { class: 'digest-more' }, [`and ${lost.length - shown.length} more`]))
      const newest = since(lost[0].since)
      const oldest = since(lost[lost.length - 1].since)
      const when = !newest ? '' : lost.length > 1 && oldest && oldest !== newest ? `${newest} to ${oldest} ago` : `${newest} ago`
      list.appendChild(row('lost', who, lost.length === 1 ? 'closed or crashed; its bundle is on disk' : 'closed or crashed; each bundle is on disk', when))
    }
  }

  // when the server was last asked (or the hide last checked), and on which of
  // the reader's calendar days
  let readAt = 0
  let readDay = ''
  async function load() {
    readAt = Date.now()
    readDay = today()
    if (stored(HIDDEN_KEY) === readDay) { root.hidden = true; return }
    let d
    try { d = await api(`/api/digest?since=${SINCE}`) } catch { root.hidden = true; return }
    if (!d || !d.volume) { root.hidden = true; return }
    render(d)
    root.hidden = false
  }

  hide.addEventListener('click', () => {
    store(HIDDEN_KEY, today())
    root.hidden = true
  })
  // Coming back to a tab that was left open is an arrival too. A read older
  // than STALE_MS, or one from another calendar day (a hide may have run out),
  // is asked again the moment the tab is looked at.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - readAt >= STALE_MS || today() !== readDay) load()
  })
  load()
})()
