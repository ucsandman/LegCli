// Leg floor, the scheduler-eye view: what is running, what is waiting on you,
// what is queued and behind what, and what landed. Polls /api/floor (the
// scheduler's own view: leases, blockers, counts), /api/cards (the rows),
// /api/trunk and /api/sessions, and refreshes on SSE.
//
// The floor starts work too: the one-line entry row under the capacity strip is
// src/board/entry.js, the same file and the same posted body as the board's.
(function () {
  'use strict'

  // src/board/board.js OWNS THESE FOUR TABLES (its own comment: "the button
  // order is fixed and never reflows by availability"). The floor draws the
  // same card rows and cannot import from that file, so they are carried here
  // and a change to either is a change to both in the same commit.
  const ACTION_ORDER = ['approve', 'enqueue', 'resume', 'pause', 'handoff_now', 'rerun', 'reassign', 'kill']
  const ACTION_LABELS = {
    enqueue: 'Run', pause: 'Pause', resume: 'Resume', kill: 'Kill', reassign: 'Reassign',
    handoff_now: 'Hand off now', approve: 'Approve', rerun: 'Rerun',
  }
  const ACTION_PATHS = {
    enqueue: 'run', pause: 'pause', resume: 'resume', kill: 'kill', reassign: 'reassign',
    handoff_now: 'handoff', approve: 'approve', rerun: 'rerun',
  }
  const ACTION_CLASS = { approve: 'btn-primary', enqueue: 'btn-primary', kill: 'btn-danger' }
  const STATUS_TONE = {
    running: 'run', handing_off: 'warn', waiting_human: 'warn', needs_approval: 'warn',
    paused: 'idle', queued: 'idle', backlog: 'idle', done: 'idle', failed: 'danger', killed: 'danger',
  }
  // The five stations this page is: each one is a question ("what is going now",
  // "what is stuck on me") and every live card is in exactly one of them.
  const STATIONS = [
    { key: 'running', head: 'running-head', box: 'running-rows', count: 'count-running', statuses: ['running', 'handing_off'], empty: 'Nothing running. A queued card starts here when its leases are free and the scheduler has a slot.' },
    { key: 'waiting', head: 'waiting-head', box: 'waiting-rows', count: 'count-waiting', statuses: ['waiting_human', 'needs_approval', 'paused'], empty: 'Nothing is waiting on you. A card lands here when a station asks for approval, or a run stops for an answer.' },
    { key: 'queued', head: 'queued-head', box: 'queued-rows', count: 'count-queued', statuses: ['queued'], empty: 'Nothing queued. Start one above; it waits here until a slot and its leases are free.' },
    // the control this names is index.html's `<label for="nc-queue">… Run now`,
    // the only checkbox involved: the line used to name a "queue box" that is
    // on no screen, and inverted the tick a reader has to clear
    { key: 'backlog', head: 'backlog-head', box: 'backlog-rows', count: 'count-backlog', statuses: ['backlog'], empty: 'Nothing in the backlog. A card made in More settings with Run now unticked waits here until you press Run.' },
    { key: 'done', head: 'done-head', box: 'done-rows', count: 'count-done', statuses: ['done', 'failed', 'killed'], empty: 'Nothing finished today.' },
  ]

  // `bind` starts as the address the reader actually reached this page on and is
  // replaced by the server's own bind at init. It used to be the literal
  // 127.0.0.1:4747 in two banner strings, so every board started with --port,
  // every share and every second instance told a disconnected user to go and
  // look at a port with nothing on it.
  // NOTE: the ported head block below declares a LOCAL `state` in five of its
  // functions for the account's one state word. Those five never touch this
  // object; anything added inside them that needs it must reach for another
  // name. test/board-updates.test.mjs pins `state.stopped` in this file by
  // source text, which is why the module object keeps the name.
  // pinned to package.json by test/files-version.test.mjs; see board.js FILES_VERSION
  const FILES_VERSION = '0.13.1'
  const state = { es: null, retryMs: 1000, timers: [], stopped: false, sseRequest: 0, floorRequest: 0, trunkRequest: 0, headRequest: 0, cardsRequest: 0, lastReadingAt: null, bind: (typeof location !== 'undefined' && location.host) || '127.0.0.1:4747', pendingFloor: null, pendingCards: null, cards: new Map(), blockers: new Map(), doneOpen: false, ringId: null, scheduler: {}, trunkOff: false }

  // What the entry row reads on every render: the terminals (for the repo it
  // infers), the cards it has seen, each repo's default branch, the ladder, the
  // installed agents and the model catalog. entry.js is handed this object
  // live, never a copy.
  const host = { sessions: [], cards: state.cards, repoTrunks: [], preferences: null, adapters: null, models: null }

  function getToken() { return localStorage.getItem('legToken') || localStorage.getItem('batonToken') || '' }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    let data = null
    if (text) { try { data = JSON.parse(text) } catch { data = null } }
    if (!res.ok) {
      const err = new Error((data && data.error) || `${res.status} ${res.statusText}`)
      err.status = res.status
      throw err
    }
    return data
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue
      if (k === 'class') node.className = v
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
      else if (v === true) node.setAttribute(k, '')
      else node.setAttribute(k, v)
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
    }
    return node
  }

  // ---- 6.9 the system message ----
  // src/board/board.js OWNS THIS COMPONENT; this is its MESSAGE_WORD table and
  // its toast(), character for character. The floor used to build a second one
  // into the same #toast box with the same .sysmsg-item class: no severity
  // word, so the colour of a 7px mark was the only signal of how bad a message
  // was, and the mark was hardcoded to danger whatever the tone.
  // One message at a time, deduped by exact text. Errors never auto-dismiss,
  // which is why `tone` defaults to danger: a bare call is an error, and an
  // error the reader has not seen does not disappear.
  const MESSAGE_WORD = { ok: 'done', warn: 'warning', danger: 'error' }
  const message = { text: null, node: null, timer: null }

  function dismissMessage() {
    if (message.timer) { clearTimeout(message.timer); message.timer = null }
    if (message.node) message.node.remove()
    message.node = null
    message.text = null
  }

  // the same words the board prints (board.js STATUS_LABELS): these two files
  // have no module system, so the map is carried rather than imported
  const STATUS_LABELS = {
    running: 'running', handing_off: 'handing off', waiting_human: 'waiting human',
    needs_approval: 'needs approval', paused: 'paused', queued: 'queued',
    backlog: 'backlog', done: 'done', failed: 'failed', killed: 'killed',
  }

  function toast(msg, tone = 'danger') {
    const text = String(msg)
    const box = document.getElementById('toast')
    if (!box || text === message.text) return
    dismissMessage()
    const word = MESSAGE_WORD[tone] || MESSAGE_WORD.danger
    const item = el('div', { class: `sysmsg-item tone-${tone}` }, [
      el('span', { class: 'status-word' }, [el('span', { class: `mark tone-${tone}`, 'aria-hidden': 'true' }), word]),
      el('span', {}, [text]),
    ])
    if (tone === 'danger') {
      item.appendChild(el('button', { type: 'button', class: 'btn btn-danger', 'aria-label': 'Dismiss message', onclick: dismissMessage }, ['Dismiss']))
    } else {
      message.timer = setTimeout(dismissMessage, 6000)
    }
    box.appendChild(item)
    message.node = item
    message.text = text
  }

  // A timestamp in a table cell is local, like every other clock on the page.
  // formatTs used to slice the ISO-8601 string, which is UTC, and feed three
  // columns sitting under a caption that reads "Times are local."
  function formatTs(ts) { return clockAt(Date.parse(ts)) }

  // the full text always goes in the cell's title too (6.7): CSS truncates
  // with text-overflow: ellipsis, this no longer pre-truncates the string.
  function formatLastEvent(last) {
    if (!last) return 'no events yet'
    return `${last.type}: ${last.summary}`
  }

  // ---- 6.1 the instrument head ------------------------------------------
  // src/board/sessions.js OWNS THIS BLOCK. From ago() down to renderAccounts()
  // it is that file's code character for character, with exactly one deliberate
  // difference, marked at the line it is on (the id of the box the head is
  // rendered into). The three board files cannot import from each other, and
  // the previous arrangement - a comment promising "a literal copy" - drifted
  // into six wrong answers on this page alone: a calm full bar for a walled
  // account with no reading, aria-valuenow="0" for a window with no reading,
  // "in 6d 23:55" against "in 6d 23h", "resets Sep 19" against "resets Sat
  // 10:11 PM", "back 10:11 PM" for a wall four days out, and a provenance line
  // with its source dropped. A change to any of it is a change to both files in
  // the same commit.

  const WIN_WORDS = { '5h': '5 hour', '7d': '7 day' }
  const IDS = ['claude', 'codex', 'agy', 'grok', 'fake']

  // ---- times. The head prints `Times are local.` once, so no row repeats it ----
  // THIS FILE OWNS THE TIME GRAMMAR FOR THE WHOLE BOARD. ago(), clockAt(),
  // until() and elapsedClock() below are copied character for character into
  // src/board/floor.js and src/board/board.js, which cannot import from here.
  // One fact must never print in two formats across the two pages, so a change
  // to any of these four is a change to all three files in the same commit.
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
  // aria-valuetext is read out loud, so the gap is spelled out there and stays
  // abbreviated in the visible cells. Both floor, so the spoken sentence and the
  // cell beside it never differ by a minute on the same rail.
  function spoken(ms) {
    const m = Math.max(0, Math.floor(ms / 60000))
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
    const h = Math.floor(m / 60)
    const rest = m % 60
    if (h < 48) return `${h} hour${h === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`
    return `${Math.floor(h / 24)} days`
  }
  function clockAt(ms) {
    if (!Number.isFinite(ms)) return 'unknown'
    const d = new Date(ms)
    const out = Math.abs(ms - Date.now())
    if (out < 20 * 3600000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (out < 6 * 86400000) return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  function elapsedClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const pad = (n) => String(n).padStart(2, '0')
    const mm = pad(Math.floor(s / 60) % 60)
    const ss = pad(s % 60)
    const h = Math.floor(s / 3600)
    return h ? `${pad(h)}:${mm}:${ss}` : `${mm}:${ss}`
  }
  function until(epochS) { return Number.isFinite(epochS) ? clockAt(epochS * 1000) : 'unknown' }

  function accountLabel(a) { return a.label || (a.account === 'default' ? a.agent : `${a.agent}/${a.account}`) }
  function idOf(agent) { return IDS.includes(agent) ? agent : 'fake' }

  // ---- the capacity strip ------------------------------------------------
  // src/board/strip.js draws it, here and on the board, from the same accounts
  // payload: the panels below are a drawer now, and the one line the reader
  // sees first is the same line on both pages. It is a plain script too, so it
  // takes this file's primitives instead of growing a copy of the time grammar.
  // The guard is for the pure-logic harness in test/board-updates.test.mjs,
  // which runs this file with no window at all.
  const strip = () => (typeof window !== 'undefined' && window.legStrip) || null
  if (strip()) strip().use({ el, accountLabel, idOf, acctState, worstWindow, until, clockAt, spoken })

  // ---- 6.1 the window rail ----------------------------------------------
  // One state value per account drives the .acct modifier, every rail cell, the
  // tier word and the spoken sentence, so those four cannot disagree.
  function acctState(a) {
    if (a.shared === false) return 'notshared'
    if (a.loading) return 'loading'
    if (Number.isFinite(a.limited_until) && a.limited_until * 1000 > Date.now()) return 'walled'
    if (!a.five_hour && !a.seven_day) return 'noreading'
    if (a.stale && a.agent !== 'agy') return 'stale'
    return 'ok'
  }
  // What one window's numeral cell can say. A window with no reading prints the
  // refusal, never a zero: a zero is a reading.
  function windowState(a, w) {
    const s = acctState(a)
    if (s === 'notshared' || s === 'loading') return s
    return w && Number.isFinite(w.pct) ? 'reading' : 'noreading'
  }
  // 6.1.6: a meter announces its name and its value text, so the whole answer
  // goes in one sentence instead of four separate visible cells.
  function railValueText(a, w, kind) {
    const words = WIN_WORDS[kind] || kind
    const state = windowState(a, w)
    const parts = []
    if (state === 'notshared') parts.push(`Usage for the ${words} window is not shared with guests.`)
    else if (state === 'loading') parts.push(`No reading for the ${words} window has come back from /api/sessions yet.`)
    else if (state === 'noreading') {
      parts.push(a.agent === 'agy'
        ? `agy publishes no usage percentage for the ${words} window. Leg sees the wall when agy hits it.`
        : `No reading for the ${words} window yet.`)
    } else {
      parts.push(`${Math.round(w.pct)} percent of the ${words} window used.`)
      if (Number.isFinite(w.resets_at)) parts.push(`Resets at ${until(w.resets_at)}, in ${spoken(w.resets_at * 1000 - Date.now())}.`)
    }
    if (acctState(a) === 'walled') parts.push(`${accountLabel(a)} is at its wall until ${until(a.limited_until)}, in ${spoken(a.limited_until * 1000 - Date.now())}.`)
    const observed = Date.parse(a.observed_at || a.updated_at || '')
    if (a.stale && a.agent !== 'agy' && Number.isFinite(observed)) parts.push(`Read at ${clockAt(observed)}, ${spoken(Date.now() - observed)} ago, stale.`)
    return parts.join(' ')
  }
  function worstWindow(a) {
    const w = [a.five_hour, a.seven_day].filter((x) => x && Number.isFinite(x.pct)).sort((x, y) => y.pct - x.pct)
    return w[0] || a.five_hour || a.seven_day || null
  }
  // Drives the condensed head under 620px: walled first, then the highest
  // percentage across both windows, ties broken by the soonest reset.
  function closestToWall(accounts) {
    const walled = (a) => (acctState(a) === 'walled' ? 1 : 0)
    const worst = (a) => { const w = worstWindow(a); return w && Number.isFinite(w.pct) ? w.pct : -1 }
    const soonest = (a) => {
      const r = [a.five_hour, a.seven_day].filter((w) => w && Number.isFinite(w.resets_at)).map((w) => w.resets_at)
      return r.length ? Math.min(...r) : Infinity
    }
    return [...accounts].sort((x, y) => (walled(y) - walled(x)) || (worst(y) - worst(x)) || (soonest(x) - soonest(y)))[0] || null
  }

  // The instrument. One track, one fill, one numeral, and a 2px notch cut
  // through the bar where 85 percent sits. `minor` is the second window on a
  // login: the same instrument at half the height and a smaller numeral, so
  // the reader's eye lands on the window that is closest to a wall first.
  function gauge(account, win, kind, { minor = false } = {}) {
    const state = windowState(account, win)
    const pct = state === 'reading' ? Math.max(0, Math.min(100, Math.round(win.pct))) : null
    const words = WIN_WORDS[kind] || kind
    const valueText = railValueText(account, win, kind)
    const id = idOf(account.agent)
    // severity paints INSIDE the track and nowhere else: the fill runs in the
    // login's own identity colour up to 85 percent and in the over colour past
    // it, so the bar shows the reserve it has eaten without colouring a word
    const fill = pct === null ? null : el('span', {
      class: 'gauge-fill',
      style: pct <= 85
        ? `width:${pct}%;background:var(--id-${id})`
        : `width:${pct}%;background:linear-gradient(to right,var(--id-${id}) 0 ${((85 / pct) * 100).toFixed(2)}%,var(--danger) ${((85 / pct) * 100).toFixed(2)}% 100%)`,
    })
    // 6.1.6: a meter with no value is not a meter. aria-valuenow is required by
    // role=meter, and an empty or absent one is announced as zero percent, which
    // is the fabricated reading the visible cell refuses to print. With no value
    // the track drops the role and carries the same sentence as its name.
    const semantics = pct === null
      ? { role: 'img', 'aria-label': `${accountLabel(account)}, ${words} window. ${valueText}` }
      : {
        role: 'meter',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(pct),
        'aria-label': `${accountLabel(account)}, ${words} window`,
        'aria-valuetext': valueText,
      }
    if (pct === null && state !== 'reading') {
      // no number exists, so no instrument is drawn. A track with nothing in it
      // is a reading of zero to anyone glancing at it.
      return el('div', { class: 'gauge gauge--none' }, [
        el('span', { class: 'gauge-label' }, [words]),
        el('span', { class: 'gauge-read--none', ...semantics }, [state === 'notshared' ? 'not shared' : state === 'loading' ? 'reading' : 'no reading']),
      ])
    }
    const readout = [el('span', { class: 'gauge-read' }, [`${pct}%`])]
    const observed = Date.parse(account.observed_at || account.updated_at || '')
    if (!minor && account.stale && account.agent !== 'agy' && Number.isFinite(observed)) {
      readout.push(el('span', { class: 'gauge-note' }, [`measured ${ago(Date.now() - observed)} ago`]))
    } else if (!minor && win && Number.isFinite(win.resets_at)) {
      readout.push(el('span', { class: 'gauge-note' }, [`resets ${until(win.resets_at)}`]))
    }
    return el('div', { class: `gauge${minor ? ' gauge--minor' : ''}` }, [
      el('span', { class: 'gauge-label' }, [words]),
      el('div', { class: 'gauge-track', ...semantics }, [fill, el('span', { class: 'gauge-post', style: 'left:85%' })]),
      el('div', { class: 'gauge-readout' }, readout),
    ])
  }

  // A login is a raised object, and how much surface it gets is the design
  // saying how much it matters. The login carrying the terminals gets the wide
  // lit panel with both of its windows drawn; a login with one fact to report
  // gets a half panel; a login that publishes no figure draws no instrument at
  // all, because an empty track reads as a measurement of zero.
  function loginPanel(a, { lit = false } = {}) {
    const state = acctState(a)
    const id = idOf(a.agent)
    const panel = el('article', { class: `panel${lit ? ' panel--lit' : ''}`, 'aria-label': `${accountLabel(a)} usage` })
    const live = a.live ? `${a.live} terminal${a.live === 1 ? '' : 's'} working` : 'no terminals'
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('span', { class: 'who' }, [el('span', { class: `dot id-${id}` }), el('span', { class: `acct-name id-${id}` }, [accountLabel(a)])]),
      el('span', { class: 'who-note' }, [live]),
    ]))

    if (state === 'notshared' || state === 'loading') {
      panel.appendChild(gauge(a, null, '5h'))
      panel.appendChild(el('p', { class: 'reading-sub reading-sub--lead' }, [state === 'notshared' ? 'Usage for this login is not shared with guests.' : 'Waiting for the first reading.']))
      return panel
    }

    // A login at its wall is reporting the loudest fact it has, and it is a
    // known one: say that instead of "no reading", whether or not a percentage
    // ever came back.
    if (state === 'walled' && !a.five_hour && !a.seven_day) {
      panel.appendChild(el('p', { class: 'reading' }, ['At the wall']))
      panel.appendChild(el('p', { class: 'reading-sub' }, [Number.isFinite(a.limited_until)
        ? `Back ${until(a.limited_until)}. Nothing runs on ${accountLabel(a)} until then.`
        : `Nothing runs on ${accountLabel(a)} until it resets.`]))
      return panel
    }

    // agy publishes no usage figure, ever, so there is nothing to draw and the
    // panel says so in a sentence instead of drawing an empty instrument
    if (!a.five_hour && !a.seven_day) {
      panel.appendChild(gauge(a, null, '5h'))
      panel.appendChild(el('p', { class: 'reading-sub reading-sub--lead' }, [a.agent === 'agy'
        ? 'agy publishes no usage figure, ever. Leg shows its terminals and their elapsed time instead.'
        : `No reading has come back from ${accountLabel(a)} yet.`]))
      return panel
    }

    // the window closest to a wall is drawn first and full size; the other is
    // the same instrument at half height, so which one to read is not a question
    const [first, second] = [a.seven_day, a.five_hour].every((w) => w && Number.isFinite(w.pct))
      ? (a.seven_day.pct >= a.five_hour.pct ? [[a.seven_day, '7d'], [a.five_hour, '5h']] : [[a.five_hour, '5h'], [a.seven_day, '7d']])
      : [[a.five_hour && Number.isFinite(a.five_hour.pct) ? a.five_hour : a.seven_day, a.five_hour && Number.isFinite(a.five_hour.pct) ? '5h' : '7d'], null]
    panel.appendChild(el('div', { class: 'gauge-block' }, [gauge(a, first[0], first[1])]))
    if (second) panel.appendChild(el('div', { class: 'gauge-block' }, [gauge(a, second[0], second[1], { minor: true })]))

    if (state === 'walled') {
      panel.appendChild(el('p', { class: 'reading' }, ['At the wall']))
      panel.appendChild(el('p', { class: 'reading-sub' }, [`Back ${until(a.limited_until)}. Nothing runs on ${accountLabel(a)} until then.`]))
    }
    return panel
  }

  function renderAccounts(accounts) {
    // THE ONE LINE THAT DIFFERS FROM sessions.js: this page's head box
    const box = document.getElementById('floor-accounts')
    if (!box) return
    box.textContent = ''
    const list = accounts || []
    // the strip is the only usage on screen until the reader opens the drawer,
    // and it renders for an empty list too (it is then an empty band, not a
    // page of panels)
    if (strip()) { strip().capacityStrip(list); strip().renderCapacityToggle() }
    if (!list.length) return
    // The floor has no verdict sentence: it is the scheduler's view, and its own
    // heading says what page you are on. The login panels are identical to the
    // board's, which is the contract that matters — a percentage, a reset or a
    // wall can never read two ways across the two pages.
    // the same lead rule as the board: the login carrying the terminals, else
    // the one closest to a wall. Leading with a walled login that has no reading
    // put a panel with no instrument in the largest slot.
    const lead = list.find((a) => a.live) || closestToWall(list) || list[0]
    const rest = list.filter((a) => a !== lead)
    box.appendChild(loginPanel(lead, { lit: true }))
    if (rest.length === 1) box.appendChild(loginPanel(rest[0]))
    else if (rest.length) box.appendChild(el('div', { class: 'logins-pair' }, rest.map((a) => loginPanel(a))))
  }

  // the head is kept so a breakpoint change can redraw it without a refetch,
  // the way sessions.js redraws from its cached view
  let lastAccounts = []
  function renderHead(accounts) { lastAccounts = accounts || lastAccounts; renderAccounts(lastAccounts) }

  // The sentence a region prints in place of its rows. Each one says what the
  // region holds AND what puts something in it, the shape index.html's own
  // empty states use: four of the five used to say only that there was nothing
  // there, which teaches a first-time reader nothing about what a lease is or
  // how a card reaches the queue.
  function emptyRow(text) { return el('p', { class: 'empty-line' }, [text]) }

  // renderTable: table-layout: fixed with real column widths (board.css) means
  // an empty table would otherwise show a header over a void; instead the
  // <thead> hides and one emptyRow() sentence takes its place under the head.
  function renderTable(bodyId, list, buildRow, emptyText) {
    const body = document.getElementById(bodyId)
    body.textContent = ''
    const table = body.parentElement
    const section = table && table.parentElement
    if (section) { const old = section.querySelector('.empty-line'); if (old) old.remove() }
    const thead = table && table.querySelector('thead')
    if (!list.length) {
      if (thead) thead.hidden = true
      if (section) section.appendChild(emptyRow(emptyText))
      return
    }
    if (thead) thead.hidden = false
    for (const item of list) for (const row of [].concat(buildRow(item))) body.appendChild(row)
  }

  function setRegionMeta(headId, text) {
    const head = document.getElementById(headId)
    const meta = head && head.parentElement && head.parentElement.querySelector('.region-meta')
    if (meta) meta.textContent = text
  }

  function renderHeader(data) {
    // repo names only on the floor (the full path is the tooltip): a shared
    // floor should not print every operator's home directory
    const reposEl = document.getElementById('repos-list')
    reposEl.textContent = data.repos && data.repos.length ? data.repos.map((r) => String(r).split(/[\\/]/).filter(Boolean).pop() || r).join(', ') : '(none)'
    reposEl.title = data.repos && data.repos.length ? data.repos.join('\n') : ''
    const sched = data.scheduler || {}
    // the rows need this too: a card queued while nothing is draining the queue
    // is not waiting for a slot, and the masthead was the only place that said so
    state.scheduler = sched
    document.getElementById('sched-status').textContent = `scheduler ${sched.running ? 'running' : 'stopped'}, ${sched.max_concurrent ?? '?'} max`
    // the counts live in the station headings now, beside the rows they count.
    // They are counted off the rows themselves (renderStation): a header that
    // counts one payload while the station under it lists another is one fact
    // answering twice, and the floor had exactly that shape.
  }

  // ---- the stations ------------------------------------------------------
  // src/board/board.js OWNS THE CARD ROW: its buildRow is R1 (state, station,
  // repo on branch, agent/model), R2 (title, one sentence), R4 (the clock, the
  // short id and at most four buttons), in the `.row` grid the terminal rows
  // use. The floor draws that row, grouped into the five stations instead of
  // ranked into one list, and the two files cannot import from each other: a
  // change to the row's shape is a change to both in the same commit.

  function truncate(str, n) {
    const text = String(str || '')
    return text.length > n ? `${text.slice(0, n - 1)}…` : text
  }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}` }
  function agoShort(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 48) return `${h}h`
    return `${Math.floor(h / 24)}d`
  }
  function agoSince(ts) {
    const at = ts ? Date.parse(ts) : NaN
    return Number.isFinite(at) ? agoShort(Date.now() - at) : 'an unknown time'
  }

  function cardTitle(card) { return card.title || truncate(card.task, 60) || card.card_id }

  function cardShortId(id) {
    const parts = String(id || '').split('-').filter(Boolean)
    if (!parts.length) return ''
    let out = parts[parts.length - 1]
    for (let i = parts.length - 2; i >= 0 && out.length < 4; i--) out = `${parts[i]}-${out}`
    return out
  }

  function cardBranch(card) {
    if (card.worktree_branch) return card.worktree_branch
    if (card.worktree) return `leg/${card.card_id}`
    return card.trunk || 'main'
  }

  function cardAgentModelText(card) {
    const agent = (card.agent_model && card.agent_model.agent) || card.active_adapter || null
    if (!agent) return null
    const model = card.agent_model && card.agent_model.model
    return model ? `${agent}/${model}` : agent
  }

  function statusWord(card) {
    let label = STATUS_LABELS[card.status] || card.status
    if (card.status === 'running' && card.station_kind === 'land') label = 'landing'
    else if (card.status === 'waiting_human' && card.pr_url) label = 'PR open'
    return el('span', { class: 'status-word' }, [
      el('span', { class: `mark tone-${STATUS_TONE[card.status] || 'idle'}`, 'aria-hidden': 'true' }),
      label,
    ])
  }

  // board.js cardSentence, carried: one sentence, the highest-ranked thing true
  // about the card, every branch naming a station, a time, a count or the
  // server's own reason.
  function cardSentence(card) {
    const last = card.last_event
    if (card.bounce_reason && ['queued', 'running', 'handing_off', 'needs_approval'].includes(card.status)) {
      const attempt = card.land_attempts ? ` on attempt ${card.land_attempts}` : ''
      return { tone: 'danger', text: `Land bounced${attempt}: ${card.bounce_reason}. The worktree still holds every commit; nothing was lost.` }
    }
    if (card.status === 'queued' && last && last.type === 'blocked_by') return { tone: 'warn', text: last.summary }
    if (['failed', 'killed'].includes(card.status)) {
      return { tone: 'danger', text: `${card.status} at station ${card.station} after ${plural(card.runs_count || 0, 'run')}: ${last ? last.summary : 'no events yet'}` }
    }
    if (['waiting_human', 'needs_approval'].includes(card.status)) {
      return { tone: 'warn', text: `waiting on you at station ${card.station} since ${formatTs(card.updated_at)}` }
    }
    if (card.status === 'done') return { tone: 'ok', text: `done after ${plural(card.runs_count || 0, 'run')}, ${last ? last.summary : 'no events yet'}` }
    if (card.status === 'running' && last && (last.type === 'leg_started' || last.summary === 'leg started')) {
      return { tone: 'muted', text: `no message until this leg ends, started ${formatTs(last.ts)}` }
    }
    return { tone: 'muted', text: `${formatLastEvent(last)}${last ? `, ${formatTs(last.ts)}` : ''}` }
  }

  // A card that is running prints the clock of the run it is in; one that is
  // not prints how long it has sat where it is, which is the question the floor
  // is asked ("has that been stuck since lunch").
  function cardClock(card) {
    if (card.active_run && Number.isFinite(card.elapsed_ms)) return elapsedClock(card.elapsed_ms)
    return `idle ${agoSince(card.updated_at)}`
  }

  // What a queued card is actually waiting for, in the scheduler's own words.
  // scheduler.mjs writes `blocked by <holder> on <lease>` and this line is no
  // longer under a column headed "Blocked by", so the summary is printed as it
  // comes: a prefix here printed `blocked by blocked by card "X" on src/**`.
  // A blocked_by event is written inside the scheduler's own tick, so a card
  // queued while the scheduler is stopped never gets one and used to fall
  // through to "waiting for a free slot" - a sentence about a slot that will
  // never be taken. /api/floor says which it is.
  function waitingFor(card) {
    const blocker = state.blockers.get(card.card_id)
    if (blocker) return blocker
    if (state.scheduler && state.scheduler.running === false) return 'the scheduler is stopped'
    return 'waiting for a free slot'
  }

  // The row's one sentence already carries the scheduler's reason when the card
  // has a blocked_by event (cardSentence's queued branch), so the note under it
  // says the position alone: printed twice, the reader reads it as two blockers.
  function queueNote(card, index, total) {
    const said = cardSentence(card).text
    const why = waitingFor(card)
    const place = `${index + 1} of ${total} in the queue`
    return said === why ? place : `${place}, ${why}`
  }

  async function runFloorAction(id, action) {
    try {
      await api(`/api/cards/${encodeURIComponent(id)}/${ACTION_PATHS[action] || action}`, { method: 'POST', body: {} })
      refreshCards()
      refreshFloor()
    } catch (err) {
      toast(err.message)
    }
  }

  // The board owns the card's detail region (the log tail, the chain rail, the
  // leases, Take over and its one copyable command), and there is one copy of
  // it. A title here is the link to that card on the board, which is also what
  // Enter on the keyboard ring presses.
  function cardHref(card) { return `/#card=${encodeURIComponent(card.card_id)}` }

  // src/board/board.js OWNS THIS PICKER (its openReassign, and .reassign-picker
  // in board.css): reassign is the one action whose POST carries a body, and
  // src/chain.mjs refuses it without an adapter. The floor's button used to
  // post `{}` straight from the row, so every press on this page was a
  // "reassign needs an adapter" error toast and the floor could not reassign at
  // all. The picker replaces the row's buttons in place, the way the board's
  // does, and Cancel puts them back.
  async function openReassign(card, wrap) {
    if (!host.adapters) {
      try { host.adapters = (await api('/api/adapters')).adapters } catch (err) { toast(err.message); return }
    }
    const name = cardTitle(card)
    const adapterSelect = el('select', { 'aria-label': `Reassign adapter for ${name}` })
    const modeSelect = el('select', { 'aria-label': `Reassign mode for ${name}` })
    for (const a of host.adapters || []) adapterSelect.appendChild(el('option', { value: a.name }, [a.name]))
    if (card.active_adapter) adapterSelect.value = card.active_adapter
    function populateModes() {
      modeSelect.textContent = ''
      const adapter = (host.adapters || []).find((a) => a.name === adapterSelect.value)
      const modes = (adapter && adapter.modes) || {}
      for (const m of modes.allowed || []) modeSelect.appendChild(el('option', { value: m }, [m]))
      if (modes.default) modeSelect.value = modes.default
    }
    adapterSelect.addEventListener('change', populateModes)
    populateModes()
    const apply = el('button', {
      type: 'button', class: 'btn btn-primary', 'aria-label': `Reassign ${name} to the chosen adapter`,
      onclick: async () => {
        try {
          await api(`/api/cards/${encodeURIComponent(card.card_id)}/reassign`, { method: 'POST', body: { adapter: adapterSelect.value, mode: modeSelect.value } })
          restoreActions(card, wrap)
          refreshCards()
          refreshFloor()
        } catch (err) { toast(err.message) }
      },
    }, ['Apply'])
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => restoreActions(card, wrap) }, ['Cancel'])
    wrap.textContent = ''
    wrap.appendChild(el('div', { class: 'reassign-picker' }, [adapterSelect, modeSelect, apply, cancel]))
    // focus lands in the picker, which is also what holds this row against the
    // next poll's rebuild (renderStation): the reader gets their 30 seconds
    if (adapterSelect.focus) adapterSelect.focus()
  }

  function actionButtons(card, wrap) {
    const available = card.actions || []
    const shown = ACTION_ORDER.filter((a) => available.includes(a) && ACTION_LABELS[a]).slice(0, 4)
    return shown.map((action) => el('button', {
      type: 'button',
      class: `btn ${ACTION_CLASS[action] || 'btn-secondary'}`,
      'aria-label': `${ACTION_LABELS[action]} ${cardTitle(card)}`,
      'data-action': action,
      onclick: () => { if (action === 'reassign') openReassign(card, wrap); else runFloorAction(card.card_id, action) },
    }, [ACTION_LABELS[action]]))
  }

  function restoreActions(card, wrap) {
    wrap.textContent = ''
    for (const btn of actionButtons(card, wrap)) wrap.appendChild(btn)
  }

  function buildActions(card) {
    const wrap = el('div', { class: 'row-actions' })
    restoreActions(card, wrap)
    return wrap
  }

  function buildCardRow(card, index) {
    const said = cardSentence(card)
    const agentText = cardAgentModelText(card)
    const row = el('article', { class: 'row', 'data-card-id': card.card_id })
    row.appendChild(el('div', { class: 'r1' }, [
      statusWord(card),
      card.station && card.station !== '-' ? el('span', { class: 'chip' }, [card.station]) : null,
      el('span', { class: 'row-meta mono', title: `${card.repo_name || 'no repo'} on ${cardBranch(card)}` }, [`${card.repo_name || 'no repo'} on ${truncate(cardBranch(card), 32)}`]),
      agentText ? el('span', { class: 'chip' }, [agentText]) : null,
    ]))
    row.appendChild(el('div', { class: 'r2' }, [
      el('a', { class: 'row-title', href: cardHref(card), 'aria-label': `Open ${cardTitle(card)} on the board` }, [cardTitle(card)]),
      el('p', { class: `sentence tone-${said.tone}` }, [said.text]),
    ]))
    row.appendChild(el('div', { class: 'r3' }, card.status === 'queued'
      ? [el('p', { class: 'row-meta' }, [queueNote(card, index, state.queueOrder.length)])]
      : []))
    row.appendChild(el('div', { class: 'r4' }, [
      el('span', { class: 'elapsed' }, [cardClock(card)]),
      el('span', { class: 'row-meta mono', title: card.card_id }, [cardShortId(card.card_id)]),
      buildActions(card),
    ]))
    return row
  }

  // Everything on a row is text, so a station that would say exactly what it
  // already says is left alone: a rebuilt row takes the reader's focus with it,
  // and this page repaints every two seconds.
  function rowSignature(card, index) {
    return [card.status, card.station, cardTitle(card), cardSentence(card).text, cardClock(card), cardAgentModelText(card), (card.actions || []).join('/'), index].join('|')
  }

  function stationCards(station, cards) {
    const list = cards.filter((c) => station.statuses.includes(c.status))
    if (station.key === 'done') {
      // "today" is this reader's own day, on the clock every other time on this
      // page is printed in
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return list
        .filter((c) => (Date.parse(c.updated_at) || 0) >= midnight.getTime())
        .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
    }
    if (station.key === 'queued') return list.sort((a, b) => state.queueOrder.indexOf(a.card_id) - state.queueOrder.indexOf(b.card_id))
    return list.sort((a, b) => (Date.parse(a.updated_at) || 0) - (Date.parse(b.updated_at) || 0))
  }

  // A reader pressing a button inside a station keeps THAT row: the poll that
  // arrives mid-press must not rebuild the node under their finger, and a
  // reassign picker open in it must not vanish. The hold used to be the whole
  // station and had no bound, so a click on Kill (the button keeps focus) froze
  // running, waiting, queued or backlog for as long as the reader left focus
  // there: the row still read `running`, the clock stopped, and the second
  // press got an illegal-transition 409. One row, for 30 seconds.
  const ROW_HOLD_MS = 30000
  function heldRowId(box) {
    const focused = (typeof document !== 'undefined' && document.activeElement) || null
    if (!focused || !box.contains || !box.contains(focused)) { box.heldId = null; box.heldAt = 0; return null }
    const row = [...(box.children || [])].find((r) => r === focused || (r.contains && r.contains(focused)))
    const id = row && row.getAttribute ? row.getAttribute('data-card-id') : null
    if (!id) return null
    if (box.heldId !== id) { box.heldId = id; box.heldAt = Date.now() }
    return Date.now() - box.heldAt >= ROW_HOLD_MS ? null : id
  }

  function renderStation(station, cards) {
    const box = document.getElementById(station.box)
    if (!box) return
    const section = box.parentElement
    const count = document.getElementById(station.count)
    if (count) count.textContent = String(cards.length)
    if (section && section.querySelector) { const old = section.querySelector('.empty-line'); if (old && old.remove) old.remove() }
    if (!cards.length) {
      box.textContent = ''
      box.signature = ''
      if (section && section.appendChild) section.appendChild(el('p', { class: 'empty-line' }, [station.empty]))
      return
    }
    const key = cards.map((c, i) => `${c.card_id}:${rowSignature(c, i)}`).join(',')
    if (box.signature === key) return
    const held = heldRowId(box)
    const focusedBefore = (typeof document !== 'undefined' && document.activeElement) || null
    const existing = new Map()
    for (const row of [...(box.children || [])]) {
      const id = row.getAttribute && row.getAttribute('data-card-id')
      if (id) existing.set(id, row)
    }
    // a row whose words have not changed keeps its node too, so the reader's
    // scroll position, their text selection and the focus ring survive a poll
    const next = cards.map((card, i) => {
      const prev = existing.get(card.card_id)
      const sig = rowSignature(card, i)
      if (prev && (card.card_id === held || prev.signature === sig)) return prev
      const row = buildCardRow(card, i)
      row.signature = sig
      return row
    })
    next.forEach((row, i) => { if (box.children[i] !== row) box.insertBefore(row, box.children[i] || null) })
    while (box.children.length > next.length) box.removeChild(box.children[next.length])
    // moving a node is a remove and an insert, which blurs it: put the reader
    // back on the control they were on, without moving the viewport
    if (focusedBefore && focusedBefore.focus && document.activeElement !== focusedBefore && box.contains && box.contains(focusedBefore)) {
      focusedBefore.focus({ preventScroll: true })
    }
    // a held row is showing last poll's words, so the station is not caught up
    // and must try again on the next one
    box.signature = held ? '' : key
  }

  // The sub-line under a station heading answers "and what of it": the queue
  // says what the front of it waits for, the rest say how long the oldest row
  // has been where it is.
  function stationMeta(station, list) {
    if (!list.length) return ''
    if (station.key === 'queued') return `first: ${waitingFor(list[0])}`
    if (station.key === 'done') {
      const count = (status) => list.filter((c) => c.status === status).length
      return [count('done') ? `${count('done')} done` : null, count('failed') ? `${count('failed')} failed` : null, count('killed') ? `${count('killed')} killed` : null].filter(Boolean).join(', ')
    }
    return `oldest ${agoSince(list[0].updated_at)}`
  }

  function renderStations() {
    const cards = [...state.cards.values()]
    state.queueOrder = cards
      .filter((c) => c.status === 'queued')
      .sort((a, b) => (Date.parse(a.created_at || a.updated_at) || 0) - (Date.parse(b.created_at || b.updated_at) || 0))
      .map((c) => c.card_id)
    for (const station of STATIONS) {
      const list = stationCards(station, cards)
      renderStation(station, list)
      setRegionMeta(station.head, stationMeta(station, list))
    }
    renderDoneToggle()
    paintRing()
  }

  function renderDoneToggle() {
    const btn = document.getElementById('done-toggle')
    const box = document.getElementById('done-rows')
    if (btn) {
      btn.setAttribute('aria-expanded', state.doneOpen ? 'true' : 'false')
      btn.textContent = state.doneOpen ? 'Hide' : 'View'
    }
    if (box) box.hidden = !state.doneOpen
  }

  // ---- the keyboard ring -------------------------------------------------
  // The three keys the board answers on its rows: j and k move, Enter opens the
  // card. Every other board binding presses a control this page does not have,
  // so it is not claimed here.
  function ringRows() {
    const out = []
    for (const station of STATIONS) {
      const box = document.getElementById(station.box)
      if (!box || box.hidden || !box.children) continue
      for (const row of [...box.children]) if (row.getAttribute && row.getAttribute('data-card-id')) out.push(row)
    }
    return out
  }
  function paintRing() {
    const rows = ringRows()
    const at = rows.findIndex((r) => r.getAttribute('data-card-id') === state.ringId)
    if (state.ringId && at < 0) state.ringId = null
    rows.forEach((r, i) => { if (r.classList) r.classList.toggle('is-focused', i === at) })
  }
  function moveRing(step) {
    const rows = ringRows()
    if (!rows.length) return
    const at = rows.findIndex((r) => r.getAttribute('data-card-id') === state.ringId)
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step))
    state.ringId = rows[next].getAttribute('data-card-id')
    paintRing()
    // the ring moves focus to the row's title, so a screen reader announces
    // which card it landed on instead of a bare button word
    const link = rows[next].querySelector && rows[next].querySelector('.row-title')
    if (link && link.focus) link.focus()
  }
  function floorKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : ''
    // a reader typing a task into the entry row is typing, not steering
    if (['input', 'textarea', 'select'].includes(tag)) return
    if (e.key === 'j') { e.preventDefault(); moveRing(1) }
    else if (e.key === 'k') { e.preventDefault(); moveRing(-1) }
    else if (e.key === 'Enter' && state.ringId && typeof location !== 'undefined') {
      // a focused control answers its own Enter. The ring used to swallow every
      // Enter on the page for as long as it was set, so Approve, Start, View,
      // the capacity disclosure and the Board link all navigated to the ringed
      // card instead of doing their own job.
      if (e.target && e.target.closest && e.target.closest('button, a, summary, [role="button"]')) return
      const card = state.cards.get(state.ringId)
      if (card) { e.preventDefault(); location.href = cardHref(card) }
    }
  }

  function renderLeases(data) {
    renderTable('leases-body', data.leases, (l) => {
      const rows = [el('tr', {}, [
        el('td', { 'data-label': 'Lease' }, [el('span', { class: 'chip' }, [l.lease])]),
        el('td', { 'data-label': 'Card', title: l.card_id }, [l.card_id]),
        el('td', { 'data-label': 'Station' }, [l.station || '']),
        el('td', { 'data-label': 'Since' }, [el('span', { class: 'chip' }, [formatTs(l.since)])]),
      ])]
      const blocked = (data.queued || []).filter((q) => q.blocked_by && q.blocked_by.includes(l.lease))
      if (blocked.length) {
        const names = blocked.map((q) => q.title || q.card_id).join(', ')
        rows.push(el('tr', { class: 'lease-blocked-row' }, [el('td', { colspan: '4', 'data-label': 'Note', title: names }, [`queued, blocked: ${names}`])]))
      }
      return rows
    }, 'No leases held. A running card reserves the files it will change, so an overlapping card waits instead of clashing.')
  }

  function renderTrunkTable(data) {
    renderTable('trunk-body', data.landed, (t) => el('tr', {}, [
      el('td', { 'data-label': 'Time' }, [el('span', { class: 'chip' }, [formatTs(t.ts)])]),
      el('td', { 'data-label': 'Card', title: t.title || t.card_id }, [t.title || t.card_id]),
      el('td', { 'data-label': 'Summary', title: t.summary || '' }, [t.summary || '']),
    ]), 'Nothing landed in the last hour.')
  }

  // The rows of this page are not owner-only: src/share.mjs mayUseCards lets an
  // operator use /api/floor, /api/cards and /api/sessions, and only the machine
  // map (/api/trunk) is kept for the owner. So a 401/403 from an endpoint the
  // page cannot exist without locks it out - a guest, or anyone whose token has
  // rotated, would otherwise get two toasts every two seconds for as long as
  // the tab is open - and a 403 from the trunk lane alone stands that one table
  // down (standDownTrunk).
  function boardHref(href) {
    try {
      const token = new URL(href).searchParams.get('token')
      return token ? `/?token=${encodeURIComponent(token)}` : '/'
    } catch { return '/' }
  }

  function lockOut(message) {
    if (state.stopped) return
    state.stopped = true
    for (const t of state.timers) clearInterval(t)
    state.timers = []
    if (state.es) { try { state.es.close() } catch { /* ignore */ } }
    document.getElementById('banner').hidden = true
    document.getElementById('sse-dot').className = 'sse-rule'
    document.getElementById('sse-text').textContent = 'stopped'
    // `main.wrap` is this page's own container. It used to look for `.shell`,
    // which no version of floor.html has ever had, so the one path that tells a
    // locked-out reader how to get back in threw on its first line instead.
    const main = document.querySelector('main.wrap')
    if (!main) return
    main.textContent = ''
    main.appendChild(el('section', { class: 'region-floor' }, [
      el('h2', { class: 'region-title' }, ['Floor unavailable']),
      el('p', { class: 'empty-line' }, [message]),
      el('p', { class: 'empty-line' }, [
        el('a', { href: boardHref(location.href) }, ['Open the board']),
        ' to set a token, or ask the owner of this machine for a share link.',
      ]),
    ]))
  }

  async function refreshFloor() {
    const request = ++state.floorRequest
    try {
      const data = await api('/api/floor')
      if (state.stopped || request !== state.floorRequest) return
      state.lastReadingAt = new Date()
      renderHeader(data)
      // the scheduler's own answer to "why is that one not moving": the rows
      // themselves come from /api/cards, and this is the only place the reason
      // a queued card is held exists
      state.blockers = new Map((data.queued || []).filter((q) => q.blocked_by).map((q) => [q.card_id, q.blocked_by]))
      renderLeases(data)
      renderStations()
      setRegionMeta('leases-head', `${data.leases.length} held`)
    } catch (err) {
      if (state.stopped || request !== state.floorRequest) return
      if (err.status === 401 || err.status === 403) return lockOut(err.message)
      toast(err.message)
    }
  }

  // /api/trunk is the map of the machine (every repository path on it), and the
  // server keeps that for the owner while an operator may use every other
  // endpoint this page draws. One 403 here used to replace the whole floor with
  // "Floor unavailable", so the pipeline view an operator is entitled to was
  // unusable. The lane goes off the page with a line saying whose it is, and
  // nothing else on the floor changes.
  function standDownTrunk(why) {
    if (state.trunkOff) return
    state.trunkOff = true
    const body = document.getElementById('trunk-body')
    const table = body && body.parentElement
    const section = table && table.parentElement
    if (body) body.textContent = ''
    if (table) table.hidden = true
    if (section && section.appendChild) {
      const old = section.querySelector && section.querySelector('.empty-line')
      if (old && old.remove) old.remove()
      section.appendChild(el('p', { class: 'empty-line' }, [`Trunk lane not shown: ${why}`]))
    }
    setRegionMeta('trunk-lane-head', 'the owner of this machine only')
  }

  async function refreshTrunk() {
    if (state.trunkOff) return
    const request = ++state.trunkRequest
    try {
      const data = await api('/api/trunk?since=1h')
      if (state.stopped || request !== state.trunkRequest) return
      state.lastReadingAt = new Date()
      renderTrunkTable(data)
      setRegionMeta('trunk-lane-head', `${data.landed.length} landed in the last hour`)
    } catch (err) {
      if (state.stopped || request !== state.trunkRequest) return
      if (err.status === 401 || err.status === 403) return standDownTrunk(err.message)
      toast(err.message)
    }
  }

  // The rows. /api/floor carries the scheduler's view (who holds what, who is
  // blocked by whom) but not a card's register, its sentence or its buttons;
  // /api/cards carries the same summarize() payload the board's rows are built
  // from, so the two pages cannot describe one card two ways.
  async function refreshCards() {
    const request = ++state.cardsRequest
    try {
      const data = await api('/api/cards')
      if (state.stopped || request !== state.cardsRequest) return
      state.lastReadingAt = new Date()
      state.cards = new Map((data.cards || []).map((c) => [c.card_id, c]))
      host.cards = state.cards
      renderStations()
      if (entry) entry.renderEntryLine()
    } catch (err) {
      if (state.stopped || request !== state.cardsRequest) return
      if (err.status === 401 || err.status === 403) return lockOut(err.message)
      toast(err.message)
    }
  }

  // the instrument head's accounts are not on /api/floor's payload; /api/sessions
  // carries them (sessionsView()) and is already reachable by an owner token.
  // The same payload carries the terminals, each repo's default branch and the
  // saved ladder, which is everything the entry row infers its sentence from.
  async function refreshHead() {
    const request = ++state.headRequest
    try {
      const data = await api('/api/sessions')
      if (state.stopped || request !== state.headRequest) return
      state.lastReadingAt = new Date()
      renderHead(data.accounts || [])
      host.sessions = data.sessions || []
      host.repoTrunks = data.trunk || []
      if (data.preferences) host.preferences = data.preferences
      if (entry) entry.renderEntryLine()
    } catch (err) {
      if (state.stopped || request !== state.headRequest) return
      if (err.status === 401 || err.status === 403) return lockOut(err.message)
    }
  }

  // ---- the entry row ------------------------------------------------------
  // src/board/entry.js, the same row and the same posted body as the board's.
  // "More settings" is the only thing this page cannot do itself: the New card
  // dialog's markup lives once, in index.html, so the link carries the sentence
  // over to the board in the hash rather than this page carrying a second copy
  // of a thirteen-field form.
  const entry = (typeof window !== 'undefined' && window.legEntry)
    ? window.legEntry.create({
      el,
      api,
      toast,
      host,
      boxId: 'card-entry',
      onCreated: (card) => {
        if (!card) return
        state.cards.set(card.card_id, card)
        renderStations()
        toast(`Queued ${card.title || card.card_id}. It is in ${card.status === 'backlog' ? 'Backlog' : 'Queued'} below.`, 'ok')
        if (entry) entry.renderEntryLine()
        refreshCards()
      },
      onMoreSettings: (entryState) => {
        const task = (entryState.task || '').trim()
        // the workflow the reader picked on this row rides along, or the
        // board's dialog would open on its default and lose the choice
        const pipeline = entryState.pipeline && entryState.pipeline !== 'build' ? `&pipeline=${encodeURIComponent(entryState.pipeline)}` : ''
        location.href = task ? `/#new-card=${encodeURIComponent(task)}${pipeline}` : `/#new-card${pipeline ? '?' + pipeline.slice(1) : ''}`
      },
    })
    : null

  // the ladder sentence and both selects read these; without them the row still
  // draws, and Start says which of the two reasons it is off
  async function loadEntryCatalog() {
    await Promise.all([
      api('/api/settings').then((d) => { host.preferences = d.preferences || host.preferences }).catch(() => {}),
      api('/api/adapters').then((d) => { host.adapters = d.adapters || null }).catch(() => {}),
      api('/api/models').then((d) => { host.models = d.models || null }).catch(() => {}),
    ])
    if (entry) entry.renderEntryLine()
  }

  // The board is pushed a card for every write under its directory, log bytes
  // included, so a busy agent turns an unconditional refresh-per-push into a
  // continuous request stream against a single-threaded local server that is
  // also serving this page's SSE. One pending refresh at a time, the shape
  // board.js uses for its drawer.
  const FLOOR_REFRESH_MS = 250
  function scheduleFloorRefresh() {
    if (state.pendingFloor) return
    state.pendingFloor = setTimeout(() => { state.pendingFloor = null; refreshFloor(); refreshCards() }, FLOOR_REFRESH_MS)
  }

  // ---- SSE ----
  function setSseState(s) {
    const dot = document.getElementById('sse-dot')
    const text = document.getElementById('sse-text')
    const banner = document.getElementById('banner')
    dot.className = `sse-rule is-${s}`
    const retrySec = Math.max(1, Math.round((state.retryMs || 1000) / 1000))
    text.textContent = s === 'live' ? 'live' : s === 'reconnecting' ? `reconnecting, next attempt in ${retrySec}s` : 'connecting'
    banner.hidden = s === 'live'
    if (s === 'reconnecting') {
      banner.textContent = state.lastReadingAt ? `Reconnecting to Leg. Last reading ${clockAt(state.lastReadingAt.getTime())}.` : `Reconnecting to Leg on ${state.bind}.`
    } else if (s === 'connecting') {
      banner.textContent = `Connecting to Leg on ${state.bind}.`
    }
  }

  function connectSse() {
    if (state.stopped) return
    if (state.es) { try { state.es.close() } catch { /* ignore */ } }
    const request = ++state.sseRequest
    setSseState('connecting')
    const token = getToken()
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events'
    const es = new EventSource(url)
    state.es = es
    es.addEventListener('hello', () => {
      if (state.es !== es || request !== state.sseRequest) return
      state.retryMs = 1000
      setSseState('live')
      refreshFloor()
      refreshCards()
      refreshTrunk()
      refreshHead()
    })
    es.addEventListener('card', () => { if (state.es === es && request === state.sseRequest) scheduleFloorRefresh() })
    es.addEventListener('event', (e) => {
      if (state.es !== es || request !== state.sseRequest) return
      scheduleFloorRefresh()
      const data = JSON.parse(e.data)
      if (data.type === 'landed') refreshTrunk()
    })
    es.onerror = () => {
      if (state.es !== es || request !== state.sseRequest) return
      setSseState('reconnecting')
      try { es.close() } catch { /* ignore */ }
      const wait = state.retryMs || 1000
      setTimeout(() => { if (request === state.sseRequest) connectSse() }, wait)
      state.retryMs = Math.min(wait * 2, 15000)
    }
  }

  // the address in the banners comes from the server, so both pages name the
  // same one; location.host already covers it if health is unreachable
  async function loadBind() {
    try {
      const data = await api('/api/health')
      if (data && data.bind) state.bind = `${data.bind}:${data.port}`
      // same note the board gives: the process is not the version these files are
      if (data && data.version && data.version !== FILES_VERSION) toast(`This board process runs leg ${data.version} and the page files are ${FILES_VERSION}. Restart it to match: leg down && leg up`)
    } catch { /* the page's own host is already a correct answer */ }
  }

  function init() {
    document.getElementById('capacity-toggle')?.addEventListener('click', () => { if (strip()) strip().toggleCapacity() })
    document.getElementById('done-toggle')?.addEventListener('click', () => { state.doneOpen = !state.doneOpen; renderDoneToggle() })
    document.addEventListener('keydown', floorKey)
    if (strip()) strip().renderCapacityToggle()
    renderDoneToggle()
    if (entry) entry.renderEntryLine()
    loadBind()
    loadEntryCatalog()
    connectSse()
    refreshFloor()
    refreshCards()
    refreshTrunk()
    refreshHead()
    // a backgrounded tab kept polling three endpoints every two seconds forever;
    // the SSE stream wakes it with the work it missed when it comes back
    state.timers.push(
      setInterval(() => { if (!document.hidden) { refreshFloor(); refreshCards() } }, 2000),
      setInterval(() => { if (!document.hidden) { refreshTrunk(); refreshHead() } }, 2000),
    )
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.stopped) { refreshFloor(); refreshCards(); refreshTrunk(); refreshHead() } })
  }

  document.addEventListener('DOMContentLoaded', init)

  // test seam: node:test runs this file with a stub document; in a browser
  // there is no `module`
  if (typeof module !== 'undefined') module.exports = { boardHref, stationCards, stationMeta, waitingFor, queueNote, cardClock, cardHref, STATIONS }
})()
