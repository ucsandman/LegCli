// Baton board: vanilla JS, no build step. Talks to /api/* (see src/server.mjs)
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
  const AGENT_IDS = ['claude', 'codex', 'agy']
  const DEFAULT_BIND = '127.0.0.1:4747'
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
      localStorage.setItem('batonToken', fromLink)
      const clean = new URL(location.href)
      clean.searchParams.delete('token')
      history.replaceState(null, '', clean.pathname + clean.search + clean.hash)
    }
  } catch {}
  function getToken() { return localStorage.getItem('batonToken') || '' }

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
  if (typeof window !== 'undefined') window.batonMessage = toast

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
  // not a zero-length run: both print the placeholder rather than a number
  // A running card counts up from its current run. A card that has finished
  // still owes the reader the number: created_at to updated_at is what it took,
  // and `--:--` in that column was three of the five demo stills saying nothing.
  // Only a card that has never started keeps the placeholder.
  function runElapsed(card) {
    const from = card.active_run ? Date.parse(card.active_run.started_at) : NaN
    if (Number.isFinite(from)) return elapsedClock(Date.now() - from)
    if (!card.runs_count) return '--:--'
    const started = Date.parse(card.created_at)
    const ended = Date.parse(card.updated_at)
    return Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? elapsedClock(ended - started)
      : '--:--'
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
    if (!actor) return 'baton'
    if (actor.type === 'human') return `human:${actor.id || 'local'}`
    if (actor.type === 'agent') return `agent:${actor.adapter || '?'}`
    return 'baton'
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
      ? `Reconnecting to Baton. Last reading ${clock(state.lastHello)}.`
      : `${s === 'reconnecting' ? 'Reconnecting' : 'Connecting'} to Baton on ${state.bind}.`
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
      if (data.sessions) window.dispatchEvent(new CustomEvent('baton:sessions', { detail: data.sessions }))
    })
    es.addEventListener('sessions', (e) => { if (state.es === es && request === state.sseRequest) window.dispatchEvent(new CustomEvent('baton:sessions', { detail: JSON.parse(e.data) })) })
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

  // ---- 6.12 step 8: one row per card, no columns ----
  // Background tasks are the third ledger cell: a count, a line of detail and a
  // disclosure, the same shape as finished terminals and what landed. Nothing
  // headless is what the board is for, so the rows live behind the button.
  let cardsOpen = false
  function toggleEmptyState() {
    const empty = document.getElementById('empty-state')
    const list = document.getElementById('columns')
    const panel = document.getElementById('cards-drawer')
    const hasCards = state.cards.size > 0
    empty.hidden = hasCards
    list.hidden = !hasCards
    if (panel) panel.hidden = !(hasCards && cardsOpen)
  }

  function countCards(...statuses) {
    let n = 0
    for (const c of state.cards.values()) if (statuses.includes(c.status)) n += 1
    return n
  }

  // G14: a verdict carries its volume
  function cardsMeta() {
    const total = state.cards.size
    if (!total) return ''
    const running = countCards('running', 'handing_off')
    const queued = countCards('queued')
    const backlog = countCards('backlog')
    const waiting = countCards('waiting_human', 'needs_approval')
    const finished = countCards('done', 'failed', 'killed')
    const parts = []
    if (running) parts.push(`${running} running`)
    if (queued) parts.push(`${queued} queued`)
    if (backlog) parts.push(`${backlog} in backlog`)
    if (waiting) parts.push(`${waiting} waiting on you`)
    if (finished) parts.push(`${finished} finished`)
    return parts.length ? parts.join(', ') : `${total} cards, nothing is running`
  }

  function renderCardsMeta() {
    const meta = document.querySelector('#board .region-meta')
    const head = document.getElementById('cards-head')
    const slot = document.querySelector('#board .ledger-actions')
    const total = state.cards.size
    if (meta) meta.textContent = total ? cardsMeta() : 'Nothing is queued. Baton starts the next login only when a terminal hands off.'
    if (head) head.textContent = total ? `${total} background task${total === 1 ? '' : 's'}` : 'No background tasks'
    if (!slot) return
    const existing = document.getElementById('cards-toggle')
    if (!total) { if (existing) existing.remove(); return }
    const label = cardsOpen ? `Hide the ${total}` : `View ${total} card${total === 1 ? '' : 's'}`
    if (existing) { existing.textContent = label; existing.setAttribute('aria-expanded', cardsOpen ? 'true' : 'false'); return }
    const btn = el('button', { type: 'button', class: 'btn btn-secondary', id: 'cards-toggle', 'aria-expanded': cardsOpen ? 'true' : 'false', 'aria-controls': 'cards-drawer' }, [label])
    btn.addEventListener('click', () => { cardsOpen = !cardsOpen; toggleEmptyState(); renderCardsMeta() })
    slot.appendChild(btn)
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

  // Re-appending every row costs one DOM move each and can move a node out from
  // under the cursor, so it happens only when the order string actually changed.
  function orderRows() {
    const list = document.getElementById('columns')
    const order = orderedCards().map((c) => c.card_id)
    const key = order.join(',')
    if (key === state.rowOrder) return
    state.rowOrder = key
    for (const id of order) {
      const row = state.cardNodes.get(id)
      if (row) list.appendChild(row)
    }
    if (state.drawerId) placeDetail(state.drawerId)
  }

  function renderBoard() {
    const list = document.getElementById('columns')
    // the detail region is a child of this list while a row is expanded: park it
    // back on the body so the wipe below does not take it out of the document
    document.body.appendChild(document.getElementById('drawer'))
    list.textContent = ''
    state.cardNodes = new Map()
    const order = orderedCards()
    for (const card of order) renderRow(card)
    state.rowOrder = order.map((c) => c.card_id).join(',')
    if (state.drawerId) placeDetail(state.drawerId)
    renderCardsMeta()
    toggleEmptyState()
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

  function upsertCard(card) {
    state.boardRevision += 1
    const prev = state.cards.get(card.card_id)
    const tail = staleLogTail(state.logState.get(card.card_id), card, Date.now())
    renderRow(card)
    orderRows()
    renderCardsMeta()
    toggleEmptyState()
    if (tail) ensureLogLoaded(card.card_id, tail)
    if (state.drawerId === card.card_id && drawerRefreshNeeded(prev, card)) scheduleDrawerRefresh()
  }

  function dropCard(id) {
    state.boardRevision += 1
    state.cards.delete(id)
    state.logState.delete(id)
    const root = state.cardNodes.get(id)
    if (root) { root.remove(); state.cardNodes.delete(id) }
    state.rowOrder = ''
    renderCardsMeta()
    toggleEmptyState()
    if (state.drawerId === id) closeDrawer()
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
    return { tone: 'muted', text: `${formatLastEvent(last)}${last ? `, ${clock(last.ts)}` : ''}` }
  }

  function shortWorktree(card) {
    if (!card.worktree) return ''
    const parts = String(card.worktree).split(/[\\/]/).filter(Boolean)
    const i = parts.lastIndexOf('.baton-worktrees')
    return i > 0 ? parts.slice(i - 1).join('/') : parts.slice(-2).join('/')
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

  function buildActions(card) {
    const wrap = el('div', { class: 'row-actions' })
    const available = card.actions || []
    for (const action of ACTION_ORDER) {
      if (!available.includes(action) || !ACTION_LABELS[action]) continue
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

  // 5.1: R1 who, R2 what, R3 where, R4 when-act-verdict. No object type moves a
  // field to a different x, which is why a card row reads down the same four
  // columns as an account and a terminal.
  function buildRow(card) {
    const said = cardSentence(card)
    const chain = (card.chain_view && card.chain_view.length ? card.chain_view : card.chain) || []
    const agent = card.active_adapter || (chain[0] ? chain[0].adapter : null)
    const title = el('button', {
      type: 'button', class: 'row-title', 'aria-expanded': state.drawerId === card.card_id ? 'true' : 'false',
      onclick: () => expandRow(card.card_id),
    }, [card.title || truncate(card.task, 60) || card.card_id])
    const sentence = el('p', { class: `sentence tone-${said.tone}` }, [said.text])
    const elapsed = el('span', { class: 'elapsed' }, [runElapsed(card)])
    const cells = [
      el('div', { class: 'r1' }, [
        el('span', { class: agent ? `chip chip-id-${agentClass(agent)}` : 'chip' }, [agent || 'no agent']),
        card.station && card.station !== '-' ? el('span', { class: 'chip' }, [card.station]) : null,
        statusWord(card),
      ]),
      el('div', { class: 'r2' }, [title, sentence]),
      el('div', { class: 'r3' }, [
        el('p', { class: 'row-meta mono' }, [`${card.repo_name || 'no repo'}@${card.trunk || 'main'}`]),
        card.worktree ? el('p', { class: 'row-meta mono', title: card.worktree }, [shortWorktree(card)]) : null,
        buildChainRail(card),
        buildLeases(card),
      ]),
      el('div', { class: 'r4' }, [elapsed, buildActions(card)]),
    ]
    return { cells, slots: { title, sentence, elapsed } }
  }

  function renderRow(card) {
    state.cards.set(card.card_id, card)
    let root = state.cardNodes.get(card.card_id)
    if (!root) {
      root = el('article', { class: 'row', 'data-card-id': card.card_id })
      state.cardNodes.set(card.card_id, root)
      document.getElementById('columns').appendChild(root)
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

  // ---- new card dialog ----
  function newCardDialogEls() {
    return {
      dialog: document.getElementById('new-card-dialog'),
      form: document.getElementById('new-card-form'),
      error: document.getElementById('new-card-error'),
      repo: document.getElementById('nc-repo'),
      task: document.getElementById('nc-task'),
      firstAgent: document.getElementById('nc-first-agent'),
      firstControls: document.getElementById('nc-first-controls'),
      testAdapter: document.getElementById('nc-test-adapter'),
      fallbackSummary: document.getElementById('nc-fallback-summary'),
      pipeline: document.getElementById('nc-pipeline'),
      customPipeline: document.getElementById('nc-custom-pipeline'),
      chainRows: document.getElementById('nc-chain-rows'),
      addRowBtn: document.getElementById('nc-add-row'),
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

  // the agents already named in this dialog: the first agent and every fallback
  // row already added. A fallback set to one of these can never fire.
  function chosenAdapters(ui) {
    const used = [ui.testAdapter.value || ui.firstAgent.value]
    for (const row of ui.chainRows.children) if (row.fields) used.push(row.fields.adapterSelect.value)
    return used.filter(Boolean)
  }

  function addChainRow(ui, { adapter: preferred = null, first = false } = {}) {
    const adapterSelect = el('select', { 'aria-label': 'Chain adapter' })
    const adapters = [...(state.adapters || [])].sort((a, b) => Number(a.fake) - Number(b.fake))
    for (const a of adapters) adapterSelect.appendChild(el('option', { value: a.name }, [adapterLabel(a)]))
    // Add fallback agent used to default to the first option in the list, which
    // is normally the agent already chosen as First agent: the summary line then
    // read "Baton tries claude, then agy, then claude", a fallback that cannot
    // fire. rebuildDefaultFallbacks already applies this filter.
    if (!preferred && !first) {
      const used = chosenAdapters(ui)
      preferred = adapters.filter((a) => !a.fake).map((a) => a.name).find((name) => !used.includes(name)) || null
    }
    if (preferred && adapters.some((a) => a.name === preferred)) adapterSelect.value = preferred
    const modeSelect = el('select', { 'aria-label': 'Chain mode' })
    const approveCheckbox = el('input', { type: 'checkbox', 'aria-label': 'Approve before this leg' })
    const approveLabel = el('label', {}, [approveCheckbox, ' approval before start'])
    const turnsInput = el('input', { type: 'number', min: '0', 'aria-label': 'Max turns', placeholder: 'max turns' })
    const fakeInput = el('input', { type: 'text', 'aria-label': 'Scripted test behavior', placeholder: 'test behavior' })
    const removeBtn = first ? null : el('button', { type: 'button', class: 'btn btn-danger', 'aria-label': 'Remove fallback agent' }, ['Remove'])
    const title = el('span', { class: 'fallback-row-title' }, [first ? `First: ${preferred}` : `Fallback ${ui.chainRows.children.length + 1}`])
    const row = el('div', { class: `chain-row${first ? '' : ' fallback-row'}` }, [title, adapterSelect, modeSelect, approveLabel, turnsInput, fakeInput, removeBtn])
    if (first) adapterSelect.hidden = true
    if (removeBtn) removeBtn.addEventListener('click', () => { row.remove(); refreshFallbackSummary(ui) })

    function populateModes() {
      modeSelect.textContent = ''
      const adapter = (state.adapters || []).find((a) => a.name === adapterSelect.value)
      const allowed = adapter ? adapter.modes.allowed : []
      for (const m of allowed) modeSelect.appendChild(el('option', { value: m }, [MODE_LABELS[m] ? `${MODE_LABELS[m]} (${m})` : m]))
      if (adapter && adapter.modes.default) modeSelect.value = adapter.modes.default
      fakeInput.hidden = !(adapter && adapter.fake)
    }
    adapterSelect.addEventListener('change', populateModes)
    // the summary sentence names the fallback agents by row, so it has to
    // follow a row whose agent the reader changed after it was added
    if (!first) adapterSelect.addEventListener('change', () => refreshFallbackSummary(ui))
    populateModes()

    row.fields = { adapterSelect, modeSelect, approveCheckbox, turnsInput, fakeInput }
    ;(first ? ui.firstControls : ui.chainRows).appendChild(row)
    refreshFallbackSummary(ui)
    return row
  }

  function refreshFallbackSummary(ui) {
    const names = [...ui.chainRows.children].filter((row) => row.fields).map((row) => row.fields.adapterSelect.value)
    ui.fallbackSummary.textContent = names.length
      ? `If the first agent cannot continue, Baton tries ${names.join(', then ')} in this order.`
      : 'No fallback agent is set. Add one under Advanced options if another agent should take over.'
  }

  function rebuildFirstControls(ui) {
    ui.firstControls.textContent = ''
    addChainRow(ui, { adapter: ui.testAdapter.value || ui.firstAgent.value, first: true })
  }

  function rebuildDefaultFallbacks(ui) {
    ui.chainRows.textContent = ''
    const first = ui.firstAgent.value
    const real = (state.adapters || []).filter((a) => !a.fake).map((a) => a.name)
    const preferred = AGENT_IDS.filter((name) => real.includes(name) && name !== first)
    for (const adapter of preferred) addChainRow(ui, { adapter })
    refreshFallbackSummary(ui)
  }

  async function openNewCardDialog() {
    if (!state.adapters) {
      try { state.adapters = (await api('/api/adapters')).adapters } catch (err) { toast(err.message); return }
    }
    const ui = newCardDialogEls()
    ui.form.reset()
    ui.error.hidden = true
    ui.error.textContent = ''
    ui.customPipeline.hidden = ui.pipeline.value !== 'custom'
    const real = (state.adapters || []).filter((a) => !a.fake)
    ui.firstAgent.textContent = ''
    for (const adapter of real) ui.firstAgent.appendChild(el('option', { value: adapter.name }, [adapter.name]))
    if (real.some((a) => a.name === 'claude')) ui.firstAgent.value = 'claude'
    ui.testAdapter.textContent = ''
    ui.testAdapter.appendChild(el('option', { value: '' }, ['Use the real first agent above']))
    for (const adapter of (state.adapters || []).filter((a) => a.fake)) ui.testAdapter.appendChild(el('option', { value: adapter.name }, [adapterLabel(adapter)]))
    ui.firstControls.textContent = ''
    ui.chainRows.textContent = ''
    rebuildFirstControls(ui)
    rebuildDefaultFallbacks(ui)
    ui.dialog.showModal()
  }

  async function submitNewCard(e) {
    e.preventDefault()
    const ui = newCardDialogEls()
    const rows = [...ui.firstControls.children, ...ui.chainRows.children]
      .filter((row) => row.fields)
      .map((row) => ({
        adapter: row.fields.adapterSelect.value,
        mode: row.fields.modeSelect.value,
        approve: row.fields.approveCheckbox.checked,
        turns: row.fields.turnsInput.value.trim(),
        fake: row.fields.fakeInput.hidden ? '' : row.fields.fakeInput.value.trim(),
      }))
      .filter((r) => r.adapter)

    const body = {
      repo: ui.repo.value.trim(),
      task: ui.task.value.trim(),
      chain: rows.map((r) => r.adapter).join(','),
      pipeline: ui.pipeline.value === 'custom' ? ui.customPipeline.value.trim() : ui.pipeline.value,
      leases: ui.leases.value.trim(),
      trunk: ui.trunk.value.trim() || 'main',
      land_mode: ui.landMode.value,
      test_command: ui.testCommand.value.trim(),
      title: ui.title.value.trim(),
      mode: rows.filter((r) => r.mode).map((r) => `${r.adapter}=${r.mode}`).join(','),
      approve: rows.filter((r) => r.approve).map((r) => r.adapter).join(','),
      maxTurns: rows.filter((r) => r.turns).map((r) => `${r.adapter}=${r.turns}`).join(','),
      fake_mode: rows.filter((r) => r.fake).map((r) => `${r.adapter}=${r.fake}`).join(','),
      queue: ui.queue.checked,
    }
    try {
      const data = await api('/api/cards', { method: 'POST', body })
      ui.dialog.close()
      upsertCard(data.card)
    } catch (err) {
      ui.error.hidden = false
      ui.error.textContent = err.message
    }
  }

  function initNewCardDialog() {
    const ui = newCardDialogEls()
    ui.form.addEventListener('submit', submitNewCard)
    ui.cancel.addEventListener('click', () => ui.dialog.close())
    ui.pipeline.addEventListener('change', () => { ui.customPipeline.hidden = ui.pipeline.value !== 'custom' })
    ui.firstAgent.addEventListener('change', () => { ui.testAdapter.value = ''; rebuildFirstControls(ui); rebuildDefaultFallbacks(ui) })
    ui.testAdapter.addEventListener('change', () => rebuildFirstControls(ui))
    ui.addRowBtn.addEventListener('click', () => addChainRow(ui))
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

  function renderBoardFacts(health) {
    const box = document.querySelector('.region-settings .board-facts')
    if (!box) return
    box.textContent = ''
    const you = health.you || {}
    const share = you.share || { on: false, people: 0 }
    const sched = health.scheduler
    const lines = [
      `baton ${health.version}, bound to ${state.bind}`,
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
      if (v) localStorage.setItem('batonToken', v)
      else localStorage.removeItem('batonToken')
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
    await loadHealth()
    fetchCards()
    connectSse()
    setInterval(tickElapsed, 1000)
  }

  document.addEventListener('DOMContentLoaded', init)

  // test seam: node:test runs this file with a stub document and reads the
  // pure update decisions back out; in a browser there is no `module`
  if (typeof module !== 'undefined') module.exports = { drawerRefreshNeeded, staleLogTail, tokenPanel, bindHost }
})()
