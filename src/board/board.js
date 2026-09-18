// Leg board: vanilla JS, no build step. Talks to /api/* (see src/server.mjs)
// and /api/events (SSE). Keeps one row per card_id, so a live push patches one
// row instead of re-rendering the list. Design: .design/BOARD-DESIGN.md. Ids,
// class names and source shapes: .design/BUILD-CONTRACT.md section 6.2. Three
// of those shapes are pinned by test/board-updates.test.mjs, which runs this
// file as source:
//  1. The export line at the bottom stays ONE line with no nested braces: the
//     test rewrites it with /module\.exports = \{[^}]+\}/ and takes the FIRST
//     match, so that text must not appear earlier in the file either.
//  2. upsertCard, scheduleDrawerRefresh, fetchCards, ensureLogLoaded and the
//     'hello' listener keep their headers and the calls named in the contract.
//  3. Every id is looked up by exactly the string the test's fake DOM
//     registers. That fake node has no insertBefore, no querySelector that
//     finds anything and no focus(), which is why this file appends rather
//     than inserts and reads its own nodes back through `root.slots`.
(function () {
  'use strict'

  // 6.3: the nine shipped status words, unchanged, each beside the mark tone it
  // takes. The word carries the meaning; the 7px mark is aria-hidden.
  const STATUS_LABELS = {
    running: 'running', handing_off: 'handing off', waiting_human: 'waiting human',
    needs_approval: 'needs approval', paused: 'paused', queued: 'queued',
    backlog: 'backlog', done: 'done', failed: 'failed', killed: 'killed',
  }
  const STATUS_TONE = {
    running: 'run', handing_off: 'warn', waiting_human: 'warn', needs_approval: 'warn',
    paused: 'idle', queued: 'idle', backlog: 'idle', done: 'idle', failed: 'danger', killed: 'danger',
  }
  // rows are ordered needs-you first, then the verdicts you have to answer, then
  // work in flight, then the queue, then what is finished
  const ROW_RANK = {
    needs_approval: 0, waiting_human: 0, failed: 1, killed: 1, running: 2,
    handing_off: 2, paused: 3, queued: 4, backlog: 5, done: 6,
  }
  // C.1: liveness decides the surface. A live card is a row in the Background
  // panel; a finished one collapses into the one ledger line.
  const LIVE_STATUSES = ['backlog', 'queued', 'running', 'handing_off', 'needs_approval', 'waiting_human', 'paused']
  const FINISHED_STATUSES = ['done', 'failed', 'killed']
  const isLive = (card) => LIVE_STATUSES.includes(card.status)
  // 6.5 G10: the button order is fixed and never reflows by availability
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
  // the permission modes come off /api/adapters as each CLI's own enum, in three
  // spellings at once (acceptEdits, accept-edits, workspace-write), which is the
  // one field in the dialog that decides what an agent may do to the repo. The
  // value sent is still the enum; only the label the reader picks from is ours.
  const MODE_LABELS = {
    acceptEdits: 'edit files without asking',
    'accept-edits': 'edit files without asking',
    auto_edit: 'edit files without asking',
    'workspace-write': 'write inside the worktree',
    'read-only': 'read only',
    plan: 'plan only',
  }
  const AGENT_IDS = ['claude', 'codex', 'agy', 'grok']
  const DEFAULT_BIND = '127.0.0.1:4747'
  // The version these page files shipped with. The server answers /api/health
  // with the version of the PROCESS, and the two drift apart the moment a
  // release lands on disk under a board that was started before it: the page
  // then draws controls the process has no routes for (an empty agent select,
  // no buckets). test/files-version.test.mjs pins this to package.json.
  const FILES_VERSION = '0.13.1'
  const TIMELINE_CAP = 12
  // mirrors LOOPBACK in src/auth.mjs; state.bind is "<host>:<port>" and an IPv6
  // host arrives bracketed
  const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']

  const state = {
    cards: new Map(),
    // the fake DOM in test/board-updates.test.mjs pre-populates this map before
    // it calls fetchCards/upsertCard; the seven kanban columns it named are gone
    // from the page, so nothing else writes to it
    columnEls: new Map(),
    cardNodes: new Map(),
    rowOrder: '',
    logState: new Map(),
    drawerId: null,
    drawerTimer: null,
    drawerRequest: 0,
    drawerDetail: null,
    drawerEvents: [],
    timelineEl: null,
    timelineCap: TIMELINE_CAP,
    adapters: null,
    es: null,
    retryMs: 1000,
    sseRequest: 0,
    authRequest: 0,
    cardsRequest: 0,
    boardRevision: 0,
    logRequests: new Map(),
    nextLogRequest: 0,
    bind: DEFAULT_BIND,
    // health answers "can anything but this machine reach the board": a
    // loopback bind with share off is local only, and a token there is a field
    // nobody can ever have a use for
    shareOn: false,
    isOwner: true,
    // state.bind is DEFAULT_BIND until health says otherwise, so a board that
    // 401s the first request would otherwise name 127.0.0.1:4747 to someone
    // looking at a different server entirely. A guest's health is redacted and
    // carries no bind at all, so answering is not the same as knowing where.
    healthKnown: false,
    bindKnown: false,
    lastHello: null,
    // C.2: the one-line entry infers its repo from the most recently focused
    // terminal, published by sessions.js on the leg:sessions window event.
    sessions: [],
    // one entry per repo with a live terminal: { repo, repo_name, branch }
    repoTrunks: [],
    preferences: null,
    // { claude: [{id, label, default}], codex: [...], agy: [...], grok: [...] }
    // from /api/models. null until it answers; an agent missing from it offers
    // its provider default and nothing else, which is what a bare `leg <agent>`
    // already does.
    models: null,
  }
  // a card push while an agent writes its log only moves these two
  const VOLATILE_CARD_FIELDS = ['last_event', 'elapsed_ms']
  const DRAWER_REFRESH_MS = 1000
  const LOG_REFRESH_MS = 5000

  // ---- helpers ----
  // a shared link carries the person's token: keep it, then take it out of the
  // address bar so it is not in a screenshot or the next copied URL
  try {
    const fromLink = new URL(location.href).searchParams.get('token')
    if (fromLink) {
      localStorage.setItem('legToken', fromLink)
      const clean = new URL(location.href)
      clean.searchParams.delete('token')
      history.replaceState(null, '', clean.pathname + clean.search + clean.hash)
    }
  } catch {}
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
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`)
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
  // One implementation for the whole page, published as window.batonMessage so
  // sessions.js reaches it instead of writing a second one into the same box.
  // One message at a time, deduped by exact text. A result that belongs to a
  // terminal or a card is written into that object's sentence slot, not here.
  // Errors never auto-dismiss, which is why `tone` defaults to danger: a bare
  // call is an error, and an error the reader has not seen does not disappear.
  const MESSAGE_WORD = { ok: 'done', warn: 'warning', danger: 'error' }
  const message = { text: null, node: null, timer: null }

  function dismissMessage() {
    if (message.timer) { clearTimeout(message.timer); message.timer = null }
    if (message.node) message.node.remove()
    message.node = null
    message.text = null
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
  if (typeof window !== 'undefined') window.legMessage = toast;
  if (typeof window !== 'undefined') window.batonMessage = toast;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  function truncate(str, n) {
    const s = String(str || '')
    return s.length > n ? `${s.slice(0, n - 1)}…` : s
  }

  // src/board/sessions.js OWNS THE TIME GRAMMAR FOR THE BOARD. elapsedClock()
  // and clockAt() below are its functions character for character, because the
  // three board files cannot import from each other and one fact must never
  // print in two formats: `404:30` on a background card two regions under
  // `06:44:30` on a terminal card was the same run measured two ways.
  // G12: fixed form, zero padded, so a column of elapsed clocks aligns on its
  // colon whether the terminal has run four minutes or four hours.
  function elapsedClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const pad = (n) => String(n).padStart(2, '0')
    const mm = pad(Math.floor(s / 60) % 60)
    const ss = pad(s % 60)
    const h = Math.floor(s / 3600)
    return h ? `${pad(h)}:${mm}:${ss}` : `${mm}:${ss}`
  }

  // an idle card has no run to measure, and a run whose start did not parse is
  // not a zero-length run: both print the placeholder rather than a number.
  // A running card counts up from its current run, in the column the terminal
  // rows above hold their run clock in. A live card BETWEEN runs has no run
  // clock at all: created_at to updated_at is the card's whole age, which for
  // a card that sat in the backlog for a day reads `24:05:00` in a column that
  // means "this run", so it is labelled for what it is instead: how long it
  // has been sitting in the state it is in.
  function runElapsed(card) {
    const from = card.active_run ? Date.parse(card.active_run.started_at) : NaN
    if (Number.isFinite(from)) return elapsedClock(Date.now() - from)
    if (!card.runs_count) return '--:--'
    const since = Date.parse(card.updated_at)
    return Number.isFinite(since) && since <= Date.now() ? `idle ${agoShort(Date.now() - since)}` : '--:--'
  }

  function clockAt(ms) {
    if (!Number.isFinite(ms)) return 'unknown'
    const d = new Date(ms)
    const out = Math.abs(ms - Date.now())
    if (out < 20 * 3600000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (out < 6 * 86400000) return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  // times are local and the head says so once, in .head-caption
  function clock(ts) {
    const at = ts ? Date.parse(ts) : NaN
    return Number.isFinite(at) ? clockAt(at) : 'an unknown time'
  }

  function formatLastEvent(last) {
    if (!last) return 'no events yet'
    return truncate(`${last.type}: ${last.summary}`, 90)
  }

  function formatActor(actor) {
    if (!actor) return 'leg'
    if (actor.type === 'human') return `human:${actor.id || 'local'}`
    if (actor.type === 'agent') return `agent:${actor.adapter || '?'}`
    return 'leg'
  }

  function baseAdapterName(name) { return String(name || '').replace(/^fake-/, '') }
  function agentClass(name) {
    const base = baseAdapterName(name)
    return AGENT_IDS.includes(base) ? base : 'fake'
  }

  // Kept by name: docs/board-guide.md references it. It returns the leg's state
  // as a word now, because section 8 of the design deletes the check, the cross
  // and the arrow from the copy, and the subset fonts carry none of them.
  function stateGlyph(s) {
    if (s === 'done') return 'done'
    if (s === 'handed') return 'handed off'
    if (s === 'failed') return 'failed'
    if (s === 'active') return 'running'
    return 'pending'
  }

  // ---- SSE ----
  function setSseState(s, waitMs) {
    const rule = document.getElementById('sse-dot')
    const text = document.getElementById('sse-text')
    const banner = document.getElementById('banner')
    rule.className = `sse-rule is-${s}`
    text.textContent = s === 'live' ? 'live'
      : s === 'reconnecting' ? `reconnecting, next attempt in ${Math.round((waitMs || state.retryMs) / 1000)}s`
        : 'connecting'
    banner.hidden = s === 'live'
    if (banner.hidden) return
    banner.textContent = s === 'reconnecting' && state.lastHello
      ? `Reconnecting to Leg. Last reading ${clock(state.lastHello)}.`
      : `${s === 'reconnecting' ? 'Reconnecting' : 'Connecting'} to Leg on ${state.bind}.`
  }

  // sessions.js owns the terminals region and listens for `leg:sessions`.
  // `baton:sessions` is the old name, still emitted for anything outside this
  // page that listens for it; nothing in the board may listen for both, because
  // each listener rebuilds the whole grid.
  function publishSessions(detail) {
    window.dispatchEvent(new CustomEvent('leg:sessions', { detail }))
    window.dispatchEvent(new CustomEvent('baton:sessions', { detail }))
  }

  // the entry line's repo inference reads the latest sessions payload without
  // owning the terminals region: sessions.js still renders it, this file only
  // keeps a copy for "the most recently focused terminal's repo". Guarded the
  // same way window.legMessage is above: the pure-logic test harness passes a
  // window stub with no addEventListener at all.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('leg:sessions', (e) => {
      state.sessions = (e.detail && e.detail.sessions) || []
      // each repo's own default branch, read once per push by the server: the
      // entry line's `on <branch>` and the trunk it posts come from here
      state.repoTrunks = (e.detail && e.detail.trunk) || []
      renderEntryLine()
    })
  }

  function connectSse() {
    if (state.es) { try { state.es.close() } catch { /* ignore */ } }
    const request = ++state.sseRequest
    setSseState('connecting')
    const token = getToken()
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events'
    const es = new EventSource(url)
    state.es = es
    es.addEventListener('hello', (e) => {
      if (state.es !== es || request !== state.sseRequest) return
      state.retryMs = 1000
      state.lastHello = new Date().toISOString()
      setSseState('live')
      const data = JSON.parse(e.data)
      state.boardRevision += 1
      state.cards = new Map(data.cards.map((c) => [c.card_id, c]))
      renderBoard()
      // nothing between the drop and this hello was replayed: an open detail
      // region is as old as the gap
      scheduleDrawerRefresh()
      if (data.sessions) publishSessions(data.sessions)
    })
    // one parse, one publish, and both inside the staleness guard: the missing
    // braces meant a superseded EventSource still drove a full rebuild, and the
    // payload (a quarter of a megabyte) was parsed twice to do it
    es.addEventListener('sessions', (e) => { if (state.es === es && request === state.sseRequest) publishSessions(JSON.parse(e.data)) })
    es.addEventListener('card', (e) => { if (state.es === es && request === state.sseRequest) upsertCard(JSON.parse(e.data)) })
    es.addEventListener('removed', (e) => { if (state.es === es && request === state.sseRequest) dropCard(JSON.parse(e.data).card_id) })
    es.addEventListener('event', (e) => { if (state.es === es && request === state.sseRequest) onLedgerEvent(JSON.parse(e.data)) })
    es.addEventListener('health', (e) => { if (state.es === es && request === state.sseRequest) renderScheduler(JSON.parse(e.data).scheduler) })
    es.onopen = () => { if (state.es === es && request === state.sseRequest) fetchCards() }
    es.onerror = () => {
      if (state.es !== es || request !== state.sseRequest) return
      const wait = state.retryMs || 1000
      setSseState('reconnecting', wait)
      try { es.close() } catch { /* ignore */ }
      setTimeout(() => { if (request === state.sseRequest) connectSse() }, wait)
      state.retryMs = Math.min(wait * 2, 15000)
    }
  }

  // ---- the page's own status lines ----
  function renderScheduler(sched) {
    if (!sched) return
    document.getElementById('sched-status').textContent =
      `scheduler ${sched.running ? 'running' : 'stopped'}, ${sched.max_concurrent} max`
  }

  // a guest on a shared board has no pipeline side: take it off the page
  // instead of shouting 403 at them
  const ownerOnly = (err) => /belongs to the owner of this machine/.test(err.message)
  // `node`, not `el`: the loop variable shadowed this file's own el() DOM
  // factory, so any line added inside these two loops that builds a node would
  // fail against a name that is in scope everywhere else in the file
  function guestMode() {
    document.body.classList.add('guest')
    state.isOwner = false
    renderTokenMeta()
    for (const node of [document.getElementById('board'), document.getElementById('new-card-btn'), document.querySelector('.masthead a[href="/floor"]')]) if (node) node.hidden = true
  }

  function ownerMode() {
    document.body.classList.remove('guest')
    for (const node of [document.getElementById('board'), document.getElementById('new-card-btn'), document.querySelector('.masthead a[href="/floor"]')]) if (node) node.hidden = false
  }

  const isGuest = () => document.body.classList.contains('guest')

  async function fetchCards() {
    if (isGuest()) return
    const request = ++state.cardsRequest
    const revision = state.boardRevision
    try {
      const data = await api('/api/cards')
      if (request !== state.cardsRequest || revision !== state.boardRevision || isGuest()) return
      state.cards = new Map(data.cards.map((c) => [c.card_id, c]))
      renderBoard()
      scheduleDrawerRefresh()
    } catch (err) {
      if (ownerOnly(err)) return guestMode()
      toast(err.message)
    }
  }

  async function loadHealth() {
    const request = ++state.authRequest
    try {
      const data = await api('/api/health')
      if (request !== state.authRequest) return false
      if (data.bind) { state.bind = `${data.bind}:${data.port}`; state.bindKnown = true }
      state.shareOn = !!(data.you && data.you.share && data.you.share.on)
      state.isOwner = !(data.you && data.you.role && data.you.role !== 'owner')
      state.healthKnown = true
      renderBoardFacts(data)
      versionSkew(data.version)
      renderTokenMeta()
      // a guest is told who they are by health, which is open to them
      if (data.you && data.you.role && data.you.role !== 'owner') { guestMode(); return false }
      ownerMode()
      renderScheduler(data.scheduler)
      return true
    } catch (err) {
      if (request !== state.authRequest) return false
      if (ownerOnly(err)) return guestMode()
      // health is the only thing that can say this board is local; without it
      // the token field stays on screen, or a viewer whose token is missing or
      // wrong has no way to type one
      state.isOwner = false
      state.healthKnown = false
      state.bindKnown = false
      renderTokenMeta()
      toast(err.message)
      return false
    }
  }

  // ---- 6.12 step 6: liveness split, cards reborn ----
  // C.1: a live card is a row in the Background panel, right under Terminals.
  // A finished one falls into one ledger cell. `cardsOpen` now gates the
  // finished-cards drawer, not a background-tasks drawer: there is no drawer
  // for live cards, they are always on the page.
  let cardsOpen = false
  function toggleEmptyState() {
    const empty = document.getElementById('empty-state')
    if (empty) empty.hidden = state.cards.size > 0
  }

  function rowRank(card) {
    const r = ROW_RANK[card.status]
    return r === undefined ? 7 : r
  }

  function startedAt(card) {
    const at = (card.active_run && card.active_run.started_at) || card.updated_at || card.created_at
    const ms = at ? Date.parse(at) : NaN
    return Number.isNaN(ms) ? 0 : ms
  }

  function orderedCards() {
    return [...state.cards.values()].sort((a, b) => rowRank(a) - rowRank(b) || startedAt(a) - startedAt(b))
  }

  function liveCards() { return orderedCards().filter((c) => isLive(c)) }

  // C.5: finished cards, newest first, for the ledger's [View] drawer.
  function finishedCards() {
    return [...state.cards.values()]
      .filter((c) => FINISHED_STATUSES.includes(c.status))
      .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
  }

  // C.5: "1 running, 1 waiting on you", the same predicate as needsYou on the
  // terminals region. A zero clause is omitted rather than printed as 0.
  function backgroundMeta(live) {
    const running = live.filter((c) => ['running', 'handing_off'].includes(c.status)).length
    const waiting = live.filter((c) => ['needs_approval', 'waiting_human'].includes(c.status)).length
    const parts = []
    if (running) parts.push(`${running} running`)
    if (waiting) parts.push(`${waiting} waiting on you`)
    return parts.join(', ')
  }

  function renderBackgroundRegion(live) {
    const section = document.getElementById('background')
    if (section) section.hidden = live.length === 0
    const meta = document.querySelector('#background .region-meta')
    if (meta) meta.textContent = backgroundMeta(live)
  }

  // C.1, C.5: "3 finished cards, 2 done, 1 failed, last 11:02 PM", one line,
  // never a count of the live cards (they are their own region now).
  function renderFinishedLedger() {
    const finished = finishedCards()
    const head = document.getElementById('cards-head')
    const meta = document.querySelector('#board .region-meta')
    if (head) {
      if (!finished.length) head.textContent = 'No finished cards'
      else {
        const done = finished.filter((c) => c.status === 'done').length
        const failed = finished.filter((c) => c.status === 'failed').length
        const killed = finished.filter((c) => c.status === 'killed').length
        const parts = []
        if (done) parts.push(`${done} done`)
        if (failed) parts.push(`${failed} failed`)
        if (killed) parts.push(`${killed} killed`)
        head.textContent = `${plural(finished.length, 'finished card')}, ${parts.join(', ')}, last ${clock(finished[0].updated_at)}`
      }
    }
    if (meta) meta.textContent = ''
    const slot = document.querySelector('#board .ledger-actions')
    if (slot) {
      let view = document.getElementById('cards-view-toggle')
      if (!finished.length) { if (view) view.remove() } else {
        if (!view) {
          view = el('button', { type: 'button', class: 'btn btn-secondary', id: 'cards-view-toggle', 'aria-controls': 'cards-drawer' }, ['View'])
          view.addEventListener('click', () => { cardsOpen = !cardsOpen; renderFinishedLedger() })
          slot.appendChild(view)
        }
        view.textContent = cardsOpen ? 'Hide' : 'View'
        view.setAttribute('aria-expanded', cardsOpen ? 'true' : 'false')
      }
    }
    const panel = document.getElementById('cards-drawer')
    if (panel) panel.hidden = !(cardsOpen && finished.length)
    renderFinishedList(finished)
  }

  // C.5: each drawer row is one line, never the full interactive row a live
  // card gets: "done after 3 runs, landed 7f3a2c1" or "failed at station
  // build after 2 runs: <last event summary>".
  function finishedLine(card) {
    const runs = plural(card.runs_count || 0, 'run')
    const last = card.last_event ? card.last_event.summary : 'no events yet'
    if (card.status === 'done') {
      const landed = card.land && card.land.state === 'landed' && card.land.sha ? `landed ${String(card.land.sha).slice(0, 7)}` : last
      return `done after ${runs}, ${landed}`
    }
    if (card.status === 'failed') return `failed at station ${card.station} after ${runs}: ${last}`
    return `killed after ${runs}`
  }

  function renderFinishedList(finished) {
    const list = document.getElementById('columns')
    if (!list) return
    list.textContent = ''
    for (const card of finished) {
      list.appendChild(el('div', { class: 'finished-line' }, [
        el('span', { class: 'row-meta mono' }, [card.title || card.card_id]),
        el('span', { class: 'finished-names' }, [finishedLine(card)]),
      ]))
    }
  }

  // Re-appending every row costs one DOM move each and can move a node out from
  // under the cursor, so it happens only when the order string actually changed.
  function orderRows() {
    const list = document.getElementById('background-grid')
    const order = liveCards().map((c) => c.card_id)
    const key = order.join(',')
    if (key === state.rowOrder) return
    state.rowOrder = key
    for (const id of order) {
      const row = state.cardNodes.get(id)
      if (row) list.appendChild(row)
    }
    if (state.drawerId) placeDetail(state.drawerId)
  }

  // called after anything that can change which cards are live, finished, or
  // how many of each: cheap text/count work, safe to run in full every time.
  function refreshCardMeta() {
    const live = liveCards()
    renderBackgroundRegion(live)
    renderFinishedLedger()
    placeEntryLine(live.length > 0)
    renderEntryLine()
    toggleEmptyState()
  }

  function renderBoard() {
    const grid = document.getElementById('background-grid')
    // the detail region is a child of this list while a row is expanded: park it
    // back on the body so the wipe below does not take it out of the document
    document.body.appendChild(document.getElementById('drawer'))
    if (grid) grid.textContent = ''
    state.cardNodes = new Map()
    const live = liveCards()
    for (const card of live) renderRow(card)
    state.rowOrder = live.map((c) => c.card_id).join(',')
    if (state.drawerId) placeDetail(state.drawerId)
    refreshCardMeta()
  }

  // the board is pushed a card for every write under its directory, log bytes
  // included, so a push is only worth two API calls when the drawer's own
  // content moved with it
  function cardSignature(card) {
    const stable = {}
    for (const [k, v] of Object.entries(card)) if (!VOLATILE_CARD_FIELDS.includes(k)) stable[k] = v
    return JSON.stringify(stable)
  }

  function drawerRefreshNeeded(prev, next) {
    return !prev || cardSignature(prev) !== cardSignature(next)
  }

  // the cached tail belongs to one run: a new run replaces it, and a running
  // one is re-read at most every LOG_REFRESH_MS so it does not freeze
  function staleLogTail(cache, card, now) {
    if (!cache) return 0
    const run = card.active_run ? card.active_run.run : null
    const otherRun = cache.runs_count !== card.runs_count || cache.run !== run
    const growing = Boolean(card.active_run) && now - cache.at >= LOG_REFRESH_MS
    if (!otherRun && !growing) return 0
    return cache.expanded ? 200 : 8
  }

  // a card that fell off liveness (running -> done, say) loses its row; the
  // finished ledger picks it up on the next refreshCardMeta() instead
  function removeLiveRow(id) {
    const root = state.cardNodes.get(id)
    if (root) { root.remove(); state.cardNodes.delete(id) }
    state.rowOrder = ''
    if (state.drawerId === id) closeDrawer()
  }

  function upsertCard(card) {
    state.boardRevision += 1
    const prev = state.cards.get(card.card_id)
    const tail = staleLogTail(state.logState.get(card.card_id), card, Date.now())
    state.cards.set(card.card_id, card)
    if (isLive(card)) { renderRow(card); orderRows() } else { removeLiveRow(card.card_id) }
    refreshCardMeta()
    if (tail) ensureLogLoaded(card.card_id, tail)
    if (state.drawerId === card.card_id && drawerRefreshNeeded(prev, card)) scheduleDrawerRefresh()
  }

  function dropCard(id) {
    state.boardRevision += 1
    state.cards.delete(id)
    state.logState.delete(id)
    removeLiveRow(id)
    refreshCardMeta()
  }

  function onLedgerEvent(ev) {
    const card = state.cards.get(ev.card_id)
    if (card) {
      card.last_event = { ts: ev.ts, type: ev.type, summary: ev.summary, actor: ev.actor }
      const root = state.cardNodes.get(ev.card_id)
      if (root && root.slots) {
        const said = cardSentence(card)
        root.slots.sentence.className = `sentence tone-${said.tone}`
        root.slots.sentence.textContent = said.text
      }
    }
    if (state.drawerId === ev.card_id) appendDrawerEvent(ev)
  }

  function tickElapsed() {
    for (const [id, card] of state.cards) {
      if (!card.active_run) continue
      const root = state.cardNodes.get(id)
      if (!root || !root.slots) continue
      root.slots.elapsed.textContent = runElapsed(card)
    }
  }

  // ---- the row ----
  // 6.3: a 7px square and one of the nine shipped words. The mark is decoration;
  // deleting it loses nothing, which is why it is aria-hidden.
  function statusWord(card) {
    let label = STATUS_LABELS[card.status] || card.status
    if (card.status === 'running' && card.station_kind === 'land') label = 'landing'
    else if (card.status === 'waiting_human' && card.pr_url) label = 'PR open'
    return el('span', { class: 'status-word' }, [
      el('span', { class: `mark tone-${STATUS_TONE[card.status] || 'idle'}`, 'aria-hidden': 'true' }),
      label,
    ])
  }

  // R2 line 2, exactly one sentence, the highest-ranked thing true about the
  // card. Every branch names a station, a time, a count or the server's own
  // reason, so the reader can check it.
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
      return { tone: 'warn', text: `waiting on you at station ${card.station} since ${clock(card.updated_at)}` }
    }
    if (card.status === 'done') return { tone: 'ok', text: `done after ${plural(card.runs_count || 0, 'run')}, ${last ? last.summary : 'no events yet'}` }
    // C.3: a card runs -p --output-format json, mute until the leg exits. Once
    // it has said anything real the generic branch below still carries it.
    if (card.status === 'running' && last && (last.type === 'leg_started' || last.summary === 'leg started')) {
      return { tone: 'muted', text: `no message until this leg ends, started ${clock(last.ts)}` }
    }
    return { tone: 'muted', text: `${formatLastEvent(last)}${last ? `, ${clock(last.ts)}` : ''}` }
  }

  // 6.11: flat inline tokens, middot-separated by CSS, each agent name printed
  // beside its own colour so identity never rides on hue alone.
  function buildChainRail(card) {
    const rail = el('div', { class: 'chain-rail' })
    for (const entry of card.chain_view || []) {
      rail.appendChild(el('span', { class: `chip chip-id-${agentClass(entry.adapter)}` }, [entry.adapter]))
      const tone = entry.state === 'done' ? 'chip-state-ok' : entry.state === 'failed' ? 'chip-state-bad' : 'chip'
      rail.appendChild(el('span', { class: `chip ${tone}` }, [stateGlyph(entry.state)]))
    }
    return rail
  }

  function buildLeases(card) {
    const leases = card.leases && card.leases.length ? card.leases : ['**']
    const blocked = card.status === 'queued' && card.last_event && card.last_event.type === 'blocked_by'
    const wrap = el('div', { class: 'leases' }, leases.map((l) => el('span', { class: 'chip' }, [l])))
    if (blocked) wrap.appendChild(el('span', { class: 'chip chip-state-warn' }, ['blocked by lease']))
    return wrap
  }

  // 6.5: no confirm() anywhere on this board. The buttons swap for a sentence
  // and two controls on --e4, focus moves to Cancel, Escape cancels. sessions.js
  // carries a copy of this function: these two files have no module system, so a
  // change here is a prompt to change the copy there.
  let openConfirm = null
  function confirmRow(question, verb, onYes, onCancel) {
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => { openConfirm = null; onCancel() } }, ['Cancel'])
    const row = el('div', { class: 'confirm-row' }, [
      el('span', {}, [question]),
      el('button', { type: 'button', class: 'btn btn-danger', onclick: () => { openConfirm = null; onYes() } }, [verb]),
      cancel,
    ])
    openConfirm = onCancel
    row.cancelBtn = cancel
    return row
  }

  async function runAction(card, action) {
    try {
      await api(`/api/cards/${encodeURIComponent(card.card_id)}/${ACTION_PATHS[action]}`, { method: 'POST', body: {} })
    } catch (err) {
      toast(err.message)
    }
  }

  async function removeCardAction(card) {
    try {
      await api(`/api/cards/${encodeURIComponent(card.card_id)}`, { method: 'DELETE' })
      dropCard(card.card_id)
    } catch (err) {
      toast(err.message)
    }
  }

  function askRemove(card, wrap) {
    const name = card.title || card.card_id
    const row = confirmRow(`Remove ${name}? Its card record, events and runs are deleted; the worktree is kept.`, 'Remove', () => removeCardAction(card), () => renderRow(card))
    wrap.textContent = ''
    wrap.appendChild(row)
    row.cancelBtn.focus()
  }

  // C.3: at most four buttons in the row's 2x2 grid, fixed order; anything
  // left over moves into the expansion instead of a fifth slot.
  function splitActions(card) {
    const available = card.actions || []
    const ordered = ACTION_ORDER.filter((a) => available.includes(a) && ACTION_LABELS[a])
    return { shown: ordered.slice(0, 4), overflow: ordered.slice(4) }
  }

  function buildActions(card, actions) {
    const wrap = el('div', { class: 'row-actions' })
    for (const action of actions) {
      const label = ACTION_LABELS[action]
      const cls = `btn ${ACTION_CLASS[action] || 'btn-secondary'}`
      const run = action === 'reassign' ? () => openReassign(card, wrap) : () => runAction(card, action)
      wrap.appendChild(el('button', { type: 'button', class: cls, 'aria-label': `${label} ${card.title || card.card_id}`, onclick: run }, [label]))
    }
    if (['done', 'failed', 'killed'].includes(card.status)) {
      wrap.appendChild(el('button', { type: 'button', class: 'btn btn-danger', 'aria-label': `Remove ${card.title || card.card_id}`, onclick: () => askRemove(card, wrap) }, ['Remove']))
    }
    return wrap
  }

  // C.3: a short relative age ("6m ago"), for the work stat line only. The
  // pinned time grammar in sessions.js (elapsedClock/clockAt) is unrelated:
  // this is a duration since a timestamp, not an elapsed-run clock.
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

  // C.3: the branch a live card works on is leg/<card_id> once it has a
  // worktree (src/worktree.mjs branchName), else it has not started and the
  // register falls back to the trunk it will branch from.
  // A terminal's short id is the random tail of its session id. A card id has
  // no hash on the end, only a slug, and `card-20260917-2300-seeded-live-card-3`
  // ends in `3`: a bare digit identifies nothing on a board with four cards. So
  // the short id is the last segment, grown leftwards until it is a token a
  // reader can match back to the row (4 characters or more).
  function cardShortId(id) {
    const parts = String(id || '').split('-').filter(Boolean)
    if (!parts.length) return ''
    let out = parts[parts.length - 1]
    for (let i = parts.length - 2; i >= 0 && out.length < 4; i--) out = `${parts[i]}-${out}`
    return out
  }

  // The branch this card's checkout is really on, for a reader who is going to
  // paste it into `git checkout`. A card that cut its own worktree is on
  // `leg/<card-id>`; one that adopted a terminal's is on that TERMINAL's
  // branch, which no reader can derive from the card id, so the server records
  // it with the worktree (`worktree_branch`). Shortened for the row only when
  // the full name does not fit, and the full name is on the element's title.
  function cardBranch(card) {
    if (card.worktree_branch) return card.worktree_branch
    if (card.worktree) return `leg/${card.card_id}`
    return card.trunk || 'main'
  }

  function cardAgent(card) { return (card.agent_model && card.agent_model.agent) || card.active_adapter || null }

  function cardAgentModelText(card) {
    const agent = cardAgent(card)
    if (!agent) return null
    const model = card.agent_model && card.agent_model.model
    return model ? `${agent}/${model}` : agent
  }

  // C.3: "4 files, +212 -18, tests green 6m ago", built only from the parts
  // the server actually measured. Nothing measured prints nothing.
  function workStatLine(card) {
    const parts = []
    const w = card.work
    if (w) {
      if (Number.isFinite(w.files)) parts.push(plural(w.files, 'file'))
      const ins = Number.isFinite(w.insertions) ? `+${w.insertions}` : ''
      const del = Number.isFinite(w.deletions) ? `-${w.deletions}` : ''
      const diff = [ins, del].filter(Boolean).join(' ')
      if (diff) parts.push(diff)
    }
    if (card.tests) parts.push(`tests ${card.tests.state} ${agoSince(card.tests.at)} ago`)
    if (card.land) {
      if (card.land.state === 'bounced') parts.push(`land bounced: ${card.land.reason || 'unknown reason'}`)
      else if (card.land.state === 'landed' && card.land.sha) parts.push(`landed ${String(card.land.sha).slice(0, 7)}`)
      else if (card.land.state === 'failed') parts.push(`land failed${card.land.reason ? `: ${card.land.reason}` : ''}`)
    }
    return parts.join(', ')
  }

  // the reassign picker replaces the buttons in place, like the confirm row
  async function openReassign(card, wrap) {
    if (!state.adapters) {
      try { state.adapters = (await api('/api/adapters')).adapters } catch (err) { toast(err.message); return }
    }
    const adapterSelect = el('select', { 'aria-label': `Reassign adapter for ${card.title || card.card_id}` })
    const modeSelect = el('select', { 'aria-label': `Reassign mode for ${card.title || card.card_id}` })
    for (const a of state.adapters) adapterSelect.appendChild(el('option', { value: a.name }, [a.name]))
    if (card.active_adapter) adapterSelect.value = card.active_adapter
    function populateModes() {
      modeSelect.textContent = ''
      const adapter = (state.adapters || []).find((a) => a.name === adapterSelect.value)
      for (const m of adapter ? adapter.modes.allowed : []) modeSelect.appendChild(el('option', { value: m }, [m]))
      if (adapter && adapter.modes.default) modeSelect.value = adapter.modes.default
    }
    adapterSelect.addEventListener('change', populateModes)
    populateModes()
    const apply = el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      try {
        await api(`/api/cards/${encodeURIComponent(card.card_id)}/reassign`, { method: 'POST', body: { adapter: adapterSelect.value, mode: modeSelect.value } })
        renderRow(card)
      } catch (err) { toast(err.message) }
    } }, ['Apply'])
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => renderRow(card) }, ['Cancel'])
    wrap.textContent = ''
    wrap.appendChild(el('div', { class: 'reassign-picker' }, [adapterSelect, modeSelect, apply, cancel]))
  }

  // C.3: R1 register (state, station, repo/branch, agent/model), R2 title +
  // sentence, R3 the work stat line (only what is measured), R4 elapsed, the
  // short id, and at most four action buttons. A card row reads down the same
  // four columns as a terminal (.row already carries that shape, see
  // board.css's own comment on it: "the same shape as .term-row").
  function buildRow(card) {
    const said = cardSentence(card)
    const agentText = cardAgentModelText(card)
    const agentBase = cardAgent(card)
    const title = el('button', {
      type: 'button', class: 'row-title', 'aria-expanded': state.drawerId === card.card_id ? 'true' : 'false',
      onclick: () => expandRow(card.card_id),
    }, [card.title || truncate(card.task, 60) || card.card_id])
    const sentence = el('p', { class: `sentence tone-${said.tone}` }, [said.text])
    const elapsed = el('span', { class: 'elapsed' }, [runElapsed(card)])
    const statLine = workStatLine(card)
    const { shown } = splitActions(card)
    const cells = [
      el('div', { class: 'r1' }, [
        statusWord(card),
        card.station && card.station !== '-' ? el('span', { class: 'chip' }, [card.station]) : null,
        el('span', { class: 'row-meta mono', title: `${card.repo_name || 'no repo'} on ${cardBranch(card)}` }, [`${card.repo_name || 'no repo'} on ${truncate(cardBranch(card), 32)}`]),
        agentText ? el('span', { class: `chip chip-id-${agentClass(agentBase)}` }, [agentText]) : null,
      ]),
      el('div', { class: 'r2' }, [title, sentence]),
      el('div', { class: 'r3' }, statLine ? [el('p', { class: 'row-meta' }, [statLine])] : []),
      el('div', { class: 'r4' }, [
        elapsed,
        el('span', { class: 'row-meta mono', title: card.card_id }, [cardShortId(card.card_id)]),
        buildActions(card, shown),
      ]),
    ]
    return { cells, slots: { title, sentence, elapsed } }
  }

  function renderRow(card) {
    state.cards.set(card.card_id, card)
    let root = state.cardNodes.get(card.card_id)
    if (!root) {
      root = el('article', { class: 'row', 'data-card-id': card.card_id })
      state.cardNodes.set(card.card_id, root)
      document.getElementById('background-grid').appendChild(root)
      state.rowOrder = ''
    } else {
      while (root.firstChild) root.removeChild(root.firstChild)
    }
    const built = buildRow(card)
    for (const cell of built.cells) root.appendChild(cell)
    root.slots = built.slots
    return root
  }

  // ---- 6.6 the detail region: in flow under its row, never an overlay ----
  async function ensureLogLoaded(id, tail) {
    const cardAtRequest = state.cards.get(id)
    if (!cardAtRequest) return
    const runAtRequest = cardAtRequest.active_run ? cardAtRequest.active_run.run : null
    const pending = state.logRequests.get(id)
    if (pending && pending.tail >= tail && pending.run === runAtRequest && pending.runs_count === cardAtRequest.runs_count) return pending.promise
    const request = { id: ++state.nextLogRequest, tail, run: runAtRequest, runs_count: cardAtRequest.runs_count }
    const path = `/api/cards/${encodeURIComponent(id)}/log?tail=${tail}${runAtRequest == null ? '' : `&run=${encodeURIComponent(runAtRequest)}`}`
    const promise = api(path).then((data) => {
      const card = state.cards.get(id)
      if (!card || state.logRequests.get(id) !== request || card.runs_count !== cardAtRequest.runs_count || (card.active_run ? card.active_run.run : null) !== runAtRequest) return
      state.logState.set(id, {
        lines: data.lines || [],
        expanded: tail > 8,
        at: Date.now(),
        runs_count: card.runs_count,
        run: runAtRequest,
      })
      if (state.drawerId === id) repaintDrawer()
    }).catch((err) => {
      if (state.logRequests.get(id) === request) toast(err.message)
    }).finally(() => {
      if (state.logRequests.get(id) === request) state.logRequests.delete(id)
    })
    request.promise = promise
    state.logRequests.set(id, request)
    return promise
  }

  function detailSection(title, note, body) {
    return el('section', { class: 'detail-section' }, [
      el('h3', { class: 'detail-heading' }, [title, note ? el('span', { class: 'detail-sub' }, [note]) : null]),
    ].concat(body))
  }

  function kvRow(key, value) {
    return [el('span', { class: 'kv-key' }, [key]), el('span', { class: 'kv-val' }, [value])]
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    } else {
      fallbackCopy(text)
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    document.body.removeChild(ta)
  }

  // G11: the machine strings in full, never shortened. The row prints the short
  // form; this is where the reader comes for the one they can paste.
  function whereBlock(card, bundle) {
    const rows = []
      .concat(kvRow('repo', card.repo || 'no repo'))
      .concat(kvRow('trunk', card.trunk || 'main'))
      .concat(kvRow('worktree', card.worktree || 'no worktree yet'))
      .concat(kvRow('leases', (card.leases && card.leases.length ? card.leases : ['**']).join(', ')))
    if (bundle && bundle.path) rows.push(...kvRow('bundle', bundle.path))
    const copy = el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => copyToClipboard(card.worktree || card.repo || '') }, ['Copy worktree path'])
    return [el('div', { class: 'kv' }, rows), copy]
  }

  // C.4: card -> terminal. Take over pauses the card and hands back one
  // copyable command; a terminal cannot be opened from a browser tab, so the
  // board says that plainly rather than pretending it can.
  function buildTakeOver(card) {
    const box = el('div', { class: 'kv' })
    const btn = el('button', { type: 'button', class: 'btn btn-secondary', onclick: async () => {
      try {
        const data = await api(`/api/cards/${encodeURIComponent(card.card_id)}/take-over`, { method: 'POST', body: {} })
        box.textContent = ''
        box.appendChild(el('p', { class: 'sentence tone-muted' }, ['A terminal cannot be opened from a browser tab, so this is the one command Leg hands you.']))
        const row = el('div', { class: 'reassign-picker' }, [
          el('span', { class: 'row-meta mono' }, [data.command]),
          el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => copyToClipboard(data.command) }, ['Copy']),
        ])
        box.appendChild(row)
      } catch (err) { toast(err.message) }
    } }, ['Take over'])
    box.appendChild(btn)
    return detailSection('Take over', 'pauses the card and starts an interactive terminal from its bundle', box)
  }

  function eventRow(e) {
    return el('div', { class: 'turn' }, [
      el('span', { class: 'turn-when' }, [clock(e.ts)]),
      el('span', { class: 'turn-role' }, [`${e.type}, ${formatActor(e.actor)}`]),
      el('p', {}, [e.summary]),
    ])
  }

  // capped by count, and the cap names its volume: no nested scrollbar, the page
  // just grows when the reader asks for more
  function paintTimeline() {
    const box = state.timelineEl
    if (!box) return
    box.textContent = ''
    const all = state.drawerEvents
    const shown = all.slice(-state.timelineCap).reverse()
    for (const e of shown) box.appendChild(eventRow(e))
    if (all.length > shown.length) {
      box.appendChild(el('p', { class: 'cap-line' }, [
        `showing ${shown.length} of ${plural(all.length, 'event')}`,
        el('button', { type: 'button', class: 'btn btn-text', onclick: () => { state.timelineCap += 40; paintTimeline() } }, ['show 40 more']),
      ]))
    }
  }

  function appendDrawerEvent(ev) {
    state.drawerEvents.push(ev)
    paintTimeline()
  }

  function renderDrawer(detail) {
    state.drawerDetail = detail
    const content = document.getElementById('drawer-content')
    content.textContent = ''
    const card = detail.card || {}
    const id = card.card_id || state.drawerId
    content.appendChild(el('h2', { class: 'detail-heading' }, [card.title || id]))

    content.appendChild(detailSection('Task', `card ${id}`, el('p', { class: 'drawer-task' }, [card.task || 'no task recorded'])))
    content.appendChild(detailSection('Where', 'full paths, never shortened', whereBlock(card, detail.bundle)))

    const stations = card.pipeline || []
    const at = stations.findIndex((s) => s.name === card.station) + 1
    const pipeline = []
    for (const st of stations) pipeline.push(...kvRow(st.name, `${st.kind}${st.name === card.station ? ', this station' : ''}`))
    content.appendChild(detailSection('Pipeline', at ? `station ${at} of ${stations.length}` : `${plural(stations.length, 'station')}, none started`, el('div', { class: 'kv' }, pipeline)))

    // C.3: the chain rail, the leases and the pipeline above all moved out of
    // the row and into this expansion; the row itself carries only the model
    // token and the station name now.
    content.appendChild(detailSection('Chain', null, buildChainRail(card)))
    content.appendChild(detailSection('Leases', null, buildLeases(card)))

    const { overflow } = splitActions(card)
    if (overflow.length) content.appendChild(detailSection('More actions', 'past the four on the row', buildActions(card, overflow)))

    content.appendChild(buildTakeOver(card))

    const runs = detail.runs || []
    const runRows = []
    for (const r of runs) runRows.push(...kvRow(`run ${r.run}`, `${r.adapter}, ${r.outcome ?? r.status}, signal ${r.signal ?? 'none'}, exit ${r.exit_code ?? 'none'}`))
    content.appendChild(detailSection('Runs', plural(runs.length, 'run'), el('div', { class: 'kv' }, runRows.length ? runRows : kvRow('runs', 'no runs yet'))))

    state.drawerEvents = detail.events || []
    state.timelineEl = el('div', { class: 'drawer-timeline' })
    content.appendChild(detailSection('Timeline', 'newest first', state.timelineEl))
    paintTimeline()

    const cache = state.logState.get(id)
    const lines = cache ? cache.lines : []
    content.appendChild(detailSection('Log', lines.length ? `last ${plural(lines.length, 'line')}` : 'no output yet',
      el('pre', { class: 'log-pre' }, [lines.length ? lines.join('\n') : (card.runs_count ? 'the log for this run is empty' : 'no runs yet')])))
  }

  function repaintDrawer() {
    if (state.drawerDetail) renderDrawer(state.drawerDetail)
  }

  function refreshDrawerAfterUpdate() {
    // the card summary changed while its row is expanded; the station marker and
    // the run list go stale with it, so refetch the detail
    if (state.drawerId) openDrawer(state.drawerId)
  }

  // openDrawer costs two requests, one of them a 64 KB log read: a burst of
  // pushes (or a reconnect, which refetches by two paths) gets one refresh
  function scheduleDrawerRefresh() {
    if (!state.drawerId || state.drawerTimer) return
    state.drawerTimer = setTimeout(() => {
      state.drawerTimer = null
      refreshDrawerAfterUpdate()
    }, DRAWER_REFRESH_MS)
  }

  // The detail region is MOVED under the row being expanded instead of floating
  // over it, so the page keeps exactly one scroll container. A row that has not
  // been rendered yet has nowhere to put it, and so does the stub DOM the tests
  // run against, in which case it stays where the markup left it.
  function placeDetail(id) {
    const row = state.cardNodes.get(id)
    const detail = document.getElementById('drawer')
    if (row && typeof row.after === 'function') row.after(detail)
    return detail
  }

  function markRow(id, expanded) {
    const root = id ? state.cardNodes.get(id) : null
    if (!root || !root.slots) return null
    if (expanded) root.classList.add('is-selected')
    else root.classList.remove('is-selected')
    root.slots.title.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    return root
  }

  async function openDrawer(id) {
    const previous = state.drawerId
    if (previous && previous !== id) markRow(previous, false)
    state.drawerId = id
    state.timelineCap = TIMELINE_CAP
    const request = ++state.drawerRequest
    const drawer = document.getElementById('drawer')
    drawer.hidden = false
    drawer.setAttribute('aria-hidden', 'false')
    placeDetail(id)
    markRow(id, true)
    try {
      const [detail, log] = await Promise.all([
        api(`/api/cards/${encodeURIComponent(id)}`),
        api(`/api/cards/${encodeURIComponent(id)}/log?tail=2000`),
      ])
      if (state.drawerId !== id || request !== state.drawerRequest) return
      const card = state.cards.get(id)
      state.logState.set(id, {
        lines: log.lines || [],
        expanded: true,
        at: Date.now(),
        runs_count: card ? card.runs_count : null,
        run: card && card.active_run ? card.active_run.run : null,
      })
      renderDrawer(detail)
    } catch (err) {
      toast(err.message)
    }
  }

  function closeDrawer() {
    const open = state.drawerId
    state.drawerId = null
    state.drawerRequest += 1
    state.drawerDetail = null
    state.timelineEl = null
    const drawer = document.getElementById('drawer')
    drawer.hidden = true
    drawer.setAttribute('aria-hidden', 'true')
    return markRow(open, false)
  }

  // only one region is expanded at a time, and the control that opened it gets
  // the focus back when it collapses
  function expandRow(id) {
    if (state.drawerId === id) return collapseRow()
    openDrawer(id)
  }

  function collapseRow() {
    const root = closeDrawer()
    if (root && root.slots) root.slots.title.focus()
  }

  // ---- 6.15 step 6: the one-line background entry (C.2) ----
  // src/board/entry.js OWNS THE ROW. It is on this page and on /floor, and one
  // sentence that starts work has to post one body from both, so the row lives
  // in a file both pages load and this file keeps only the names its own code
  // and its test seams call. `state` is handed over live: the row reads
  // sessions, cards, preferences, adapters and models on every render, never a
  // copy taken at mount.
  const entryUi = window.legEntry.create({
    el,
    api,
    toast,
    host: state,
    boxId: 'card-entry',
    isGuest,
    onCreated: (card) => upsertCard(card),
    // this page has the dialog markup, so More settings opens it in place
    onMoreSettings: () => openNewCardDialog(),
    // C.2: the row sits under the Background panel, and under Terminals when
    // there are no live cards to sit under
    moveUnder: { whenLive: 'background', whenEmpty: '.region-terminals' },
  })
  const entryState = entryUi.entryState
  const knownRepos = () => entryUi.knownRepos()
  const entryRepo = () => entryUi.entryRepo()
  const realAdapters = () => entryUi.realAdapters()
  const ladderAgents = () => entryUi.ladderAgents()
  const asRung = (agent, model) => entryUi.asRung(agent, model)
  const ladderLabel = (r) => entryUi.ladderLabel(r)
  const modelSelect = (agent, model, label, onPick) => entryUi.modelSelect(agent, model, label, onPick)
  const entryChain = () => entryUi.entryChain()
  const entryTrunk = (repo) => entryUi.entryTrunk(repo)
  const renderEntryLine = () => entryUi.renderEntryLine()
  const placeEntryLine = (hasLive) => entryUi.placeEntryLine(hasLive)

  // sessions.js draws the ladder editor in Settings and needs the same model
  // catalog, but the two files share no module scope (both are plain scripts
  // served to the browser), so the one fetch is published here and read there.
  // Narrow on purpose: the catalog and nothing else of this file's state.
  function publishModels() {
    if (typeof window === 'undefined') return
    window.legBoard = { models: state.models }
  }

  // ---- new card dialog ----
  // Two questions, side by side: WHAT the work is (task, repo, branch) and WHO
  // runs it. "Who runs it" is the same ladder the one-line entry row walks,
  // one row per rung and a model select on each, prefilled from preferences so
  // the dialog opens showing exactly what pressing Start on that row would
  // have done. Every other field the dialog ever had is under Advanced, and
  // every one of them still posts.
  function newCardDialogEls() {
    return {
      dialog: document.getElementById('new-card-dialog'),
      form: document.getElementById('new-card-form'),
      error: document.getElementById('new-card-error'),
      repo: document.getElementById('nc-repo'),
      repoKnown: document.getElementById('nc-repo-known'),
      task: document.getElementById('nc-task'),
      testAdapter: document.getElementById('nc-test-adapter'),
      fallbackSummary: document.getElementById('nc-fallback-summary'),
      pipeline: document.getElementById('nc-pipeline'),
      customPipeline: document.getElementById('nc-custom-pipeline'),
      chainRows: document.getElementById('nc-chain-rows'),
      addRowBtn: document.getElementById('nc-add-row'),
      saveLadder: document.getElementById('nc-save-ladder'),
      leases: document.getElementById('nc-leases'),
      trunk: document.getElementById('nc-trunk'),
      landMode: document.getElementById('nc-land-mode'),
      testCommand: document.getElementById('nc-test-command'),
      title: document.getElementById('nc-title'),
      queue: document.getElementById('nc-queue'),
      cancel: document.getElementById('nc-cancel'),
    }
  }

  function adapterLabel(adapter) { return adapter.fake ? `${adapter.name} (test/demo)` : adapter.name }

  // The rows as DATA. The DOM used to be the record: a row's values were read
  // back off its own inputs, which works until rows can move, because moving a
  // row means rebuilding it and a rebuilt input is empty. Reorder, remove and
  // renumber are all list operations here, and the DOM is redrawn from the list.
  let ncRows = []

  function ncAdapter(name) { return (state.adapters || []).find((a) => a.name === name) || null }

  function ncRow(agent, model) {
    const adapter = ncAdapter(agent)
    return {
      agent: adapter ? adapter.name : agent,
      model: model || '',
      mode: adapter && adapter.modes ? (adapter.modes.default || '') : '',
      approve: false, turns: '', fake: '',
    }
  }

  // the first installed agent no row already names: a fallback that repeats the
  // row above it can never fire
  function ncNextAgent() {
    const used = ncRows.map((r) => r.agent)
    const real = realAdapters()
    return real.find((a) => !used.includes(a)) || real[0] || ((state.adapters || [])[0] || {}).name || 'claude'
  }

  const ncLeg = (r) => (r.model ? `${r.agent}/${r.model}` : r.agent)

  function refreshFallbackSummary(ui) {
    const legs = ncRows.map(ncLeg)
    ui.fallbackSummary.textContent = legs.length > 1
      ? `Leg starts on ${legs[0]}, and tries ${legs.slice(1).join(', then ')} only when the row before it cannot continue.`
      : legs.length === 1
        ? `Leg runs ${legs[0]} and stops there. Add a fallback to hand the work on when it cannot continue.`
        : 'No agent is set. Add a row, or this card has nothing to run it.'
  }

  // `focusKey` is the control the reader should still be on after the redraw.
  // Every row is destroyed and rebuilt here, so the button a keyboard user just
  // pressed Enter on is gone and focus falls to <body>: pressing Up twice meant
  // tabbing back through every control above it. Same idea as sessions.js's
  // takeFocus/putFocus pair (data-focus-key), but the intent is passed in rather
  // than read off document.activeElement, because the moved row's key is known
  // at the press and the row it lands on is a different index.
  function renderChainRows(ui, focusKey) {
    ui.chainRows.textContent = ''
    const keyed = new Map()
    ncRows.forEach((row, index) => {
      // every control on the row is named for the step it belongs to, so a
      // screen reader hears "Model for fallback 2" and not "Chain adapter"
      const step = index === 0 ? 'the first agent' : `fallback ${index}`
      const adapter = ncAdapter(row.agent)
      const box = el('div', { class: 'chain-row' })
      box.appendChild(el('span', { class: 'chain-num' }, [`${index + 1}.`]))

      const who = el('select', { 'aria-label': `Provider for ${step}` })
      for (const a of [...(state.adapters || [])].sort((x, y) => Number(x.fake) - Number(y.fake))) who.appendChild(el('option', { value: a.name }, [adapterLabel(a)]))
      who.value = row.agent
      who.addEventListener('change', () => {
        row.agent = who.value
        // a model belongs to one provider: carrying gpt-5.6-luna over to claude
        // would post a model that CLI has never heard of
        row.model = ''
        const next = ncAdapter(row.agent)
        row.mode = next && next.modes ? (next.modes.default || '') : ''
        renderChainRows(ui)
      })
      box.appendChild(who)

      box.appendChild(modelSelect(row.agent, row.model, `Model for ${step}`, (v) => { row.model = v; refreshFallbackSummary(ui) }))

      const mode = el('select', { 'aria-label': `Permissions for ${step}` })
      for (const m of (adapter && adapter.modes ? adapter.modes.allowed : [])) mode.appendChild(el('option', { value: m }, [MODE_LABELS[m] ? `${MODE_LABELS[m]} (${m})` : m]))
      mode.value = row.mode || (adapter && adapter.modes ? adapter.modes.default : '')
      mode.addEventListener('change', () => { row.mode = mode.value })
      box.appendChild(mode)

      const approve = el('input', { type: 'checkbox', 'aria-label': `Ask before ${step} starts` })
      approve.checked = row.approve
      approve.addEventListener('change', () => { row.approve = approve.checked })
      box.appendChild(el('label', { class: 'chain-toggle' }, [approve, ' ask before start']))

      const turns = el('input', { type: 'number', min: '1', class: 'chain-turns', 'aria-label': `Max turns for ${step}`, placeholder: 'max turns', value: row.turns })
      turns.addEventListener('input', () => { row.turns = turns.value })
      box.appendChild(turns)

      if (adapter && adapter.fake) {
        const fake = el('input', { type: 'text', class: 'chain-fake', 'aria-label': `Scripted behaviour for ${step}`, placeholder: 'test behavior', value: row.fake })
        fake.addEventListener('input', () => { row.fake = fake.value })
        box.appendChild(fake)
      }

      const up = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-label': `Move ${step} earlier`, 'data-focus-key': `chain:${index}:up`, disabled: index === 0 ? '' : null }, ['Up'])
      const down = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-label': `Move ${step} later`, 'data-focus-key': `chain:${index}:down`, disabled: index === ncRows.length - 1 ? '' : null }, ['Down'])
      const drop = el('button', { type: 'button', class: 'btn btn-danger', 'aria-label': `Remove ${step}`, 'data-focus-key': `chain:${index}:remove`, disabled: ncRows.length < 2 ? '' : null }, ['Remove'])
      // the key names where the row LANDS, not where it was pressed
      up.addEventListener('click', () => { ncRows.splice(index - 1, 0, ncRows.splice(index, 1)[0]); renderChainRows(ui, `chain:${index - 1}:up`) })
      down.addEventListener('click', () => { ncRows.splice(index + 1, 0, ncRows.splice(index, 1)[0]); renderChainRows(ui, `chain:${index + 1}:down`) })
      drop.addEventListener('click', () => { ncRows.splice(index, 1); renderChainRows(ui, `chain:${Math.min(index, ncRows.length - 1)}:remove`) })
      box.append(up, down, drop)
      keyed.set(`chain:${index}:up`, up)
      keyed.set(`chain:${index}:down`, down)
      keyed.set(`chain:${index}:remove`, drop)

      ui.chainRows.appendChild(box)
    })
    refreshFallbackSummary(ui)
    if (focusKey) restoreChainFocus(ui, keyed, focusKey)
  }

  // A row moved to either end loses the button that moved it, and the last row
  // standing cannot be removed, so the focus goes to the nearest live control on
  // that row and, when the row itself is gone, to Add a fallback.
  function restoreChainFocus(ui, keyed, focusKey) {
    const at = focusKey.split(':')[1]
    let target = keyed.get(focusKey) || null
    if (!target || target.disabled) {
      target = [`chain:${at}:up`, `chain:${at}:down`, `chain:${at}:remove`]
        .map((k) => keyed.get(k))
        .find((node) => node && !node.disabled) || ui.addRowBtn || null
    }
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true })
  }

  // "Save as my default ladder": the rows become preferences.handoff_ladder,
  // which the entry row and every new terminal read. A scripted test adapter is
  // never a rung and the server refuses one, so it is dropped here with a
  // sentence rather than sent and refused; two rows naming the same agent and
  // model are one rung, for the same reason.
  async function saveLadderFromRows(rows) {
    const real = realAdapters()
    // and of those, the agents a SAVED ladder may name. A custom adapter added
    // with `leg adapter add` is a real agent and runs a card, but preferences
    // takes a closed list and refuses the whole array over one rung it does not
    // know, so the claude rung beside a custom one was never written either.
    const saveable = ladderAgents()
    const dropped = []
    const seen = new Set()
    const ladder = []
    for (const r of rows) {
      if (!real.includes(r.agent)) continue
      if (!saveable.includes(r.agent)) { if (!dropped.includes(r.agent)) dropped.push(r.agent); continue }
      const key = `${r.agent}/${r.model || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      ladder.push(asRung(r.agent, r.model || null))
    }
    const left = dropped.length ? ` ${dropped.join(', ')} ${dropped.length > 1 ? 'were' : 'was'} left off: the default ladder keeps only the agents Settings can express (${saveable.join(', ')}).` : ''
    if (!ladder.length) {
      toast(dropped.length
        ? `The default ladder was left alone: it would keep no rung at all.${left}`
        : 'The default ladder was left alone: a scripted test agent cannot be a rung.')
      return
    }
    try {
      const data = await api('/api/settings', { method: 'PATCH', body: { handoff_ladder: ladder } })
      state.preferences = data.preferences || state.preferences
      entryState.ladderStart = 0
      entryState.model = undefined
      renderEntryLine()
      toast(`Saved as your default ladder: ${ladder.map(ladderLabel).join(' then ')}.${left}`)
    } catch (err) {
      toast(`The card was created. The default ladder was not saved: ${err.message}`)
    }
  }

  async function openNewCardDialog() {
    if (!state.adapters) {
      try { state.adapters = (await api('/api/adapters')).adapters } catch (err) { toast(err.message); return }
    }
    // neither of these stops the dialog opening: without a catalog every model
    // select offers the provider default, and without preferences the rows fall
    // back to the agents that are installed
    if (!state.models) { try { state.models = (await api('/api/models')).models; publishModels() } catch { /* provider default only */ } }
    if (!state.preferences) { try { state.preferences = (await api('/api/settings')).preferences || null } catch { /* installed adapters only */ } }

    const ui = newCardDialogEls()
    ui.form.reset()
    ui.error.hidden = true
    ui.error.textContent = ''
    // More settings is the same sentence with more fields, so the sentence
    // comes with it: on this page from the row above, and from /floor through
    // the #new-card hash, which is how that page reaches this dialog without a
    // second copy of its markup.
    if (entryState.task && entryState.task.trim()) ui.task.value = entryState.task
    // the workflow is one of the row's three nouns and it went the same way the
    // task does. form.reset() above puts the select back to the option marked
    // selected in the markup (build), so this has to run after it.
    if (entryState.pipeline) ui.pipeline.value = entryState.pipeline
    ui.customPipeline.hidden = ui.pipeline.value !== 'custom'

    // the repo and branch the entry row would have used, and every repo this
    // board has seen, so the commonest case is already filled in
    const repo = entryRepo()
    ui.repoKnown.textContent = ''
    for (const r of knownRepos()) ui.repoKnown.appendChild(el('option', { value: r.path }, [r.name]))
    ui.repoKnown.appendChild(el('option', { value: '' }, ['Another path, typed below']))
    ui.repoKnown.value = repo ? repo.path : ''
    ui.repo.value = repo ? repo.path : ''
    ui.trunk.value = entryTrunk(repo) || 'main'

    ui.testAdapter.textContent = ''
    ui.testAdapter.appendChild(el('option', { value: '' }, ['Use the real first row above']))
    for (const adapter of (state.adapters || []).filter((a) => a.fake)) ui.testAdapter.appendChild(el('option', { value: adapter.name }, [adapterLabel(adapter)]))

    const rungs = entryChain()
    ncRows = rungs.length ? rungs.map((r) => ncRow(r.agent, r.model || '')) : []
    if (!ncRows.length && (state.adapters || []).length) ncRows = [ncRow(ncNextAgent(), '')]
    ui.saveLadder.checked = false
    renderChainRows(ui)
    ui.dialog.showModal()
  }

  async function submitNewCard(e) {
    e.preventDefault()
    const ui = newCardDialogEls()
    const fail = (msg) => { ui.error.hidden = false; ui.error.textContent = msg }
    const rows = ncRows.filter((r) => r.agent)
    if (!rows.length) return fail('Add at least one row under Who runs it: a card needs an agent to run it.')
    if (!ui.repo.value.trim()) return fail('Name the repository this card works in.')
    // One object per row, not a comma list plus four adapter-keyed strings.
    // The keyed form could only ever carry one mode, one turn limit and one
    // model PER ADAPTER, so a chain of claude/fable then claude/opus lost the
    // difference between its own two rows. src/pipeline.mjs normalizeChainEntry
    // takes every one of these fields per entry.
    const chain = rows.map((r) => ({
      adapter: r.agent,
      ...(r.model ? { model: r.model } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(String(r.turns).trim() ? { maxTurns: Number(String(r.turns).trim()) } : {}),
      ...(r.approve ? { approve: true } : {}),
      ...(String(r.fake).trim() ? { fakeMode: String(r.fake).trim() } : {}),
    }))

    const body = {
      repo: ui.repo.value.trim(),
      task: ui.task.value.trim(),
      chain,
      pipeline: ui.pipeline.value === 'custom' ? ui.customPipeline.value.trim() : ui.pipeline.value,
      leases: ui.leases.value.trim(),
      trunk: ui.trunk.value.trim() || 'main',
      land_mode: ui.landMode.value,
      test_command: ui.testCommand.value.trim(),
      title: ui.title.value.trim(),
      queue: ui.queue.checked,
    }
    try {
      const data = await api('/api/cards', { method: 'POST', body })
      // the card exists now: a ladder that will not save is a toast, never a
      // reason to leave the dialog open over a card that was already created
      if (ui.saveLadder.checked) await saveLadderFromRows(rows)
      ui.dialog.close()
      // the sentence was sent, so the row that carried it here is spent: a row
      // left armed makes the next Start post the same card a second time.
      // upsertCard redraws the row, so there is no render call to add.
      entryState.task = ''
      entryState.editing = null
      upsertCard(data.card)
    } catch (err) {
      fail(err.message)
    }
  }

  function initNewCardDialog() {
    const ui = newCardDialogEls()
    ui.form.addEventListener('submit', submitNewCard)
    ui.cancel.addEventListener('click', () => ui.dialog.close())
    ui.pipeline.addEventListener('change', () => { ui.customPipeline.hidden = ui.pipeline.value !== 'custom' })
    // the picker fills the path field rather than replacing it: the path is
    // what gets posted, and a reader who wants a repo the board has never seen
    // types it in the same box
    ui.repoKnown.addEventListener('change', () => {
      if (!ui.repoKnown.value) { ui.repo.focus(); return }
      ui.repo.value = ui.repoKnown.value
      const known = knownRepos().find((r) => r.path === ui.repoKnown.value) || { path: ui.repoKnown.value, name: ui.repoKnown.value }
      ui.trunk.value = entryTrunk(known) || 'main'
    })
    // unchanged meaning: the scripted adapter replaces the agent on the first
    // row, and clearing it puts the first real agent back
    ui.testAdapter.addEventListener('change', () => {
      if (!ncRows.length) ncRows = [ncRow(ncNextAgent(), '')]
      const real = realAdapters()
      ncRows[0] = ncRow(ui.testAdapter.value || real[0] || ncRows[0].agent, '')
      renderChainRows(ui)
    })
    ui.addRowBtn.addEventListener('click', () => { ncRows.push(ncRow(ncNextAgent(), '')); renderChainRows(ui) })
  }

  // ---- 6.10 settings: the last region of the page, in flow ----
  // "<host>:<port>", possibly "[::1]:4747"
  function bindHost(bind) {
    const s = String(bind ?? '').trim()
    const bracketed = s.match(/^\[(.+)\]:\d+$/)
    if (bracketed) return bracketed[1].toLowerCase()
    return s.replace(/:\d+$/, '').toLowerCase()
  }

  // A loopback bind with share off can only ever be reached from this machine,
  // and src/auth.mjs lets that request in with no token at all. Asking for one
  // there is a question with no answer, so the field is not drawn. Three things
  // put it back: a token already stored (which has to stay clearable), a guest
  // or a health call that never answered (neither has established local), and
  // any bind or share that lets a second machine in.
  function tokenPanel({ bind, shareOn, isOwner, token, healthKnown, bindKnown }) {
    const at = bindKnown ? ` to ${bind}` : ''
    // nothing has been heard back from the server: do not name an address that
    // is only this file's default, and do not claim the board is local
    if (!healthKnown) {
      return {
        hidden: false,
        meta: token ? 'That token was refused. Check it, or clear the field to sign out.' : 'This board wants a token before it will say anything.',
      }
    }
    const localOnly = bindKnown && LOOPBACK_HOSTS.includes(bindHost(bind)) && !shareOn && isOwner && !token
    if (localOnly) return { hidden: true, meta: `Local only, ${bind} answers this machine and nothing else` }
    // share on, no token, and the server still called us the owner: auth.mjs
    // recognised this browser by its loopback address. Saying "unauthenticated"
    // there was wrong, and it was the line the owner read on their own board.
    if (shareOn && isOwner && !token) {
      return { hidden: false, meta: `Signed in as the owner from this machine. A token is only needed from somewhere else.` }
    }
    return {
      hidden: false,
      meta: token
        ? `API token set, sent${at} as a bearer token`
        : `No API token set, requests reach${at || ' this board'} unauthenticated`,
    }
  }

  function renderTokenMeta() {
    const panel = tokenPanel({ bind: state.bind, shareOn: state.shareOn, isOwner: state.isOwner, token: getToken(), healthKnown: state.healthKnown, bindKnown: state.bindKnown })
    const field = document.getElementById('token-field')
    if (field) field.hidden = panel.hidden
    const meta = document.querySelector('.region-settings .region-meta')
    if (meta) meta.textContent = panel.meta
  }

  // The process behind the page is older or newer than the page itself. Said
  // once, as an error that stays until dismissed, because everything the reader
  // sees from here on is drawn by files the process does not know about.
  function versionSkew(processVersion) {
    if (!processVersion || processVersion === FILES_VERSION) return false
    toast(`This board process runs leg ${processVersion} and the page files are ${FILES_VERSION}. Restart it to match: leg down && leg up`)
    return true
  }

  function renderBoardFacts(health) {
    const box = document.querySelector('.region-settings .board-facts')
    if (!box) return
    box.textContent = ''
    const you = health.you || {}
    const share = you.share || { on: false, people: 0 }
    const sched = health.scheduler
    const skew = health.version && health.version !== FILES_VERSION ? `, page files ${FILES_VERSION}` : ''
    const lines = [
      `leg ${health.version}${skew}, bound to ${state.bind}`,
      `signed in as ${you.name || 'local'}, ${you.role || 'owner'}`,
      share.on ? `share on, ${share.people === 1 ? '1 person' : `${share.people} people`}` : 'share off, nobody invited',
    ]
    // a guest is sent neither the scheduler nor the paths: print nothing rather
    // than a number this board was not told
    if (sched) lines.push(sched.running ? `scheduler running, pid ${sched.pid}, ${sched.max_concurrent} max` : `scheduler stopped, ${sched.max_concurrent} max`)
    if (health.home) lines.push(`board home ${health.home}`)
    for (const line of lines) box.appendChild(el('p', {}, [line]))
  }

  function initSettings() {
    const input = document.getElementById('token-input')
    input.value = getToken()
    input.addEventListener('change', async () => {
      const v = input.value.trim()
      if (v) { localStorage.setItem('legToken', v); localStorage.setItem('batonToken', v); }
      else { localStorage.removeItem('legToken'); localStorage.removeItem('batonToken'); }
      renderTokenMeta()
      state.boardRevision += 1
      state.cardsRequest += 1
      state.sseRequest += 1
      if (state.es) { try { state.es.close() } catch { /* ignore */ } }
      state.es = null
      const owner = await loadHealth()
      if (owner) fetchCards()
      connectSse()
    })
    const show = document.getElementById('token-show')
    if (show) {
      show.addEventListener('click', () => {
        const hidden = input.type !== 'text'
        input.type = hidden ? 'text' : 'password'
        show.textContent = hidden ? 'Hide' : 'Show'
      })
    }
    const disclosure = document.querySelector('.region-settings .disclosure')
    const body = document.getElementById('settings-body')
    if (disclosure && body) {
      disclosure.addEventListener('click', () => {
        const opening = body.hidden
        body.hidden = !opening
        disclosure.setAttribute('aria-expanded', opening ? 'true' : 'false')
        disclosure.textContent = opening ? 'Hide settings' : 'Show settings'
      })
    }
    renderTokenMeta()
  }

  // ---- what /floor sends over in the address bar ----
  // The floor starts cards from its own copy of the entry row, but the New card
  // dialog's markup exists once, on this page, so the floor's More settings and
  // its card titles are links here. `#new-card` opens the dialog, `#new-card=<task>`
  // opens it with the sentence the reader had already typed, and `#card=<id>`
  // expands that card's detail region. The hash is cleared once it is acted on:
  // a reload should not reopen a dialog the reader closed.
  async function openFromHash() {
    const hash = decodeURIComponent(String((location && location.hash) || '').replace(/^#/, ''))
    if (!hash) return
    const clear = () => { try { history.replaceState(null, '', location.pathname + location.search) } catch { /* a browser that refuses is still on the right page */ } }
    if (hash.startsWith('new-card')) {
      // `#new-card=<task>&pipeline=<p>` or `#new-card?pipeline=<p>`: the floor's
      // entry row sends both, and the dialog opens on what the reader chose
      const rest = hash.slice('new-card'.length)
      const m = rest.match(/[&?]pipeline=([a-z_-]+)$/)
      const task = rest.replace(/[&?]pipeline=[a-z_-]+$/, '').replace(/^=/, '')
      if (task) entryState.task = task
      // an unknown word is harmless: the dialog's select ignores a value it has no option for
      if (m) entryState.pipeline = m[1]
      if (task || m) renderEntryLine()
      clear()
      await openNewCardDialog()
      return
    }
    if (hash.startsWith('card=')) {
      const id = hash.slice('card='.length)
      clear()
      if (!state.cards.has(id)) await fetchCards()
      if (state.cards.has(id)) expandRow(id)
    }
  }

  // ---- init ----
  async function init() {
    initSettings()
    initNewCardDialog()
    document.getElementById('new-card-btn').addEventListener('click', () => openNewCardDialog())
    document.getElementById('empty-new-card-btn').addEventListener('click', () => openNewCardDialog())
    document.getElementById('drawer-close').addEventListener('click', () => collapseRow())
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (openConfirm) { const cancel = openConfirm; openConfirm = null; cancel(); return }
      if (state.drawerId) collapseRow()
    })
    // health first: it says whether this human owns the pipeline side at all
    const owner = await loadHealth()
    fetchCards()
    connectSse()
    setInterval(tickElapsed, 1000)
    // C.2: the ladder sentence on the entry line reads this; a guest never
    // sees the entry line, so there is nothing to fetch it for
    if (owner) {
      // three independent reads, so they go out together: the ladder the entry
      // line names, the adapters that are actually installed (the fallback when
      // there is no ladder at all), and the model catalog both selects use
      await Promise.all([
        api('/api/settings').then((d) => { state.preferences = d.preferences || null }).catch(() => {}),
        api('/api/adapters').then((d) => { state.adapters = d.adapters || null }).catch(() => {}),
        api('/api/models').then((d) => { state.models = d.models || null }).catch(() => {}),
      ])
      publishModels()
      renderEntryLine()
      // last, so the dialog opens over a page that already knows its ladder,
      // its repos and its cards
      await openFromHash()
    }
  }

  document.addEventListener('DOMContentLoaded', init)

  // test seam: node:test runs this file with a stub document and reads the
  // pure update decisions back out; in a browser there is no `module`
  if (typeof module !== 'undefined') module.exports = { drawerRefreshNeeded, staleLogTail, tokenPanel, bindHost }
})()
