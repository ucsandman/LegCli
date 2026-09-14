// Baton board — vanilla JS, no build step. Talks to /api/* (see src/server.mjs)
// and /api/events (SSE). Keeps DOM nodes keyed by card_id so a live update
// patches one card instead of re-rendering the whole board.
(function () {
  'use strict'

  const STATUS_LABELS = {
    running: 'running', handing_off: 'handing off', waiting_human: 'waiting human',
    needs_approval: 'needs approval', paused: 'paused', queued: 'queued',
    backlog: 'backlog', done: 'done', failed: 'failed', killed: 'killed',
  }
  const STATUS_CLASS = {
    running: 'ok', handing_off: 'warn', waiting_human: 'warn', needs_approval: 'warn',
    paused: 'muted', queued: 'muted', backlog: 'muted', done: 'ok dim', failed: 'bad', killed: 'bad',
  }
  const ACTION_LABELS = {
    enqueue: 'Run', pause: 'Pause', resume: 'Resume', kill: 'Kill', reassign: 'Reassign',
    handoff_now: 'Hand off now', approve: 'Approve', rerun: 'Rerun',
  }
  const ACTION_PATHS = {
    enqueue: 'run', pause: 'pause', resume: 'resume', kill: 'kill', reassign: 'reassign',
    handoff_now: 'handoff', approve: 'approve', rerun: 'rerun',
  }
  const ADAPTER_ACCENTS = ['claude', 'codex', 'agy']

  const state = {
    cards: new Map(),
    columns: [],
    columnEls: new Map(),
    cardNodes: new Map(),
    logState: new Map(),
    drawerId: null,
    drawerTimer: null,
    drawerRequest: 0,
    adapters: null,
    es: null,
    retryMs: 1000,
    sseRequest: 0,
    authRequest: 0,
    cardsRequest: 0,
    boardRevision: 0,
    logRequests: new Map(),
    nextLogRequest: 0,
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

  function toast(msg) {
    const box = document.getElementById('toast')
    const item = el('div', { class: 'toast-item' }, [String(msg)])
    item.appendChild(el('button', { type: 'button', 'aria-label': 'Dismiss message', onclick: () => item.remove() }, ['×']))
    box.appendChild(item)
    setTimeout(() => item.remove(), 6000)
  }

  function truncate(str, n) {
    const s = String(str || '')
    return s.length > n ? `${s.slice(0, n - 1)}…` : s
  }

  function formatElapsed(ms) {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
    const total = Math.floor(safe / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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

  function stateGlyph(s) {
    if (s === 'done') return '✓'
    if (s === 'handed') return '↷'
    if (s === 'failed') return '✗'
    if (s === 'active') return '●'
    return '·'
  }

  // ---- SSE ----
  function setSseState(s) {
    const dot = document.getElementById('sse-dot')
    const text = document.getElementById('sse-text')
    const banner = document.getElementById('banner')
    dot.className = `dot ${s}`
    text.textContent = s === 'live' ? 'live' : s === 'reconnecting' ? 'reconnecting…' : 'connecting'
    banner.hidden = s === 'live'
    if (!banner.hidden) banner.textContent = s === 'reconnecting' ? 'Reconnecting to Baton…' : 'Connecting to Baton…'
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
      setSseState('live')
      const data = JSON.parse(e.data)
      state.boardRevision += 1
      state.columns = data.columns
      state.cards = new Map(data.cards.map((c) => [c.card_id, c]))
      renderBoard()
      // nothing between the drop and this hello was replayed: an open drawer
      // is as old as the gap
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
      setSseState('reconnecting')
      try { es.close() } catch { /* ignore */ }
      const wait = state.retryMs || 1000
      setTimeout(() => { if (request === state.sseRequest) connectSse() }, wait)
      state.retryMs = Math.min(wait * 2, 15000)
    }
  }

  // ---- board render ----
  function renderScheduler(sched) {
    if (!sched) return
    document.getElementById('sched-status').textContent =
      `scheduler: ${sched.running ? 'running' : 'stopped'}, ${sched.max_concurrent} max`
  }

  // a guest on a shared board has no pipeline side: take it off the page
  // instead of shouting 403 at them
  const ownerOnly = (err) => /belongs to the owner of this machine/.test(err.message)
  function guestMode() {
    document.body.classList.add('guest')
    for (const el of [document.getElementById('board'), document.getElementById('new-card-btn'), document.querySelector('.topbar a[href="/floor"]')]) if (el) el.hidden = true
  }

  function ownerMode() {
    document.body.classList.remove('guest')
    for (const el of [document.getElementById('board'), document.getElementById('new-card-btn'), document.querySelector('.topbar a[href="/floor"]')]) if (el) el.hidden = false
  }

  const isGuest = () => document.body.classList.contains('guest')

  async function fetchCards() {
    if (isGuest()) return
    const request = ++state.cardsRequest
    const revision = state.boardRevision
    try {
      const data = await api('/api/cards')
      if (request !== state.cardsRequest || revision !== state.boardRevision || isGuest()) return
      state.columns = data.columns
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
      // a guest is told who they are by health, which is open to them
      if (data.you && data.you.role && data.you.role !== 'owner') { guestMode(); return false }
      ownerMode()
      renderScheduler(data.scheduler)
      return true
    } catch (err) {
      if (request !== state.authRequest) return false
      if (ownerOnly(err)) return guestMode()
      toast(err.message)
      return false
    }
  }

  function toggleEmptyState() {
    const empty = document.getElementById('empty-state')
    const columnsEl = document.getElementById('columns')
    const hasCards = state.cards.size > 0
    empty.hidden = hasCards
    columnsEl.hidden = !hasCards
  }

  function updateColumnCounts() {
    for (const [name, colEl] of state.columnEls) {
      let count = 0
      for (const c of state.cards.values()) if (c.column === name) count += 1
      colEl.countEl.textContent = String(count)
    }
  }

  function renderBoard() {
    const columnsEl = document.getElementById('columns')
    columnsEl.textContent = ''
    state.columnEls = new Map()
    state.cardNodes = new Map()
    for (const name of state.columns) {
      const countEl = el('span', { class: 'count' }, ['0'])
      const list = el('div', { class: 'column-cards' })
      const section = el('section', { class: 'column' }, [
        el('h2', {}, [name, countEl]),
        list,
      ])
      columnsEl.appendChild(section)
      state.columnEls.set(name, { section, list, countEl })
    }
    for (const card of state.cards.values()) renderCard(card)
    updateColumnCounts()
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
    if (!state.columnEls.has(card.column)) {
      fetchCards()
      return
    }
    const prev = state.cards.get(card.card_id)
    const tail = staleLogTail(state.logState.get(card.card_id), card, Date.now())
    renderCard(card)
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
    updateColumnCounts()
    toggleEmptyState()
    if (state.drawerId === id) closeDrawer()
  }

  function onLedgerEvent(ev) {
    const card = state.cards.get(ev.card_id)
    if (card) {
      card.last_event = { ts: ev.ts, type: ev.type, summary: ev.summary, actor: ev.actor }
      const root = state.cardNodes.get(ev.card_id)
      if (root) {
        const line = root.querySelector('.card-last-event')
        if (line) {
          line.textContent = formatLastEvent(card.last_event)
          if (ev.type === 'blocked_by') line.setAttribute('title', ev.summary)
          else line.removeAttribute('title')
        }
      }
    }
    if (state.drawerId === ev.card_id) appendDrawerEvent(ev)
  }

  function tickElapsed() {
    for (const [id, card] of state.cards) {
      if (!card.active_run) continue
      const root = state.cardNodes.get(id)
      if (!root) continue
      const span = root.querySelector('.elapsed')
      if (span) span.textContent = formatElapsed(Date.now() - Date.parse(card.active_run.started_at))
    }
  }

  // ---- card node ----
  function buildStatusChip(card) {
    let label = STATUS_LABELS[card.status] || card.status
    const cls = STATUS_CLASS[card.status] || 'muted'
    let titleAttr = null
    if (card.status === 'queued' && card.last_event && card.last_event.type === 'blocked_by') {
      // the scheduler writes "blocked by <holder> on <lease> …" for a lease and
      // "blocked: <reason>" for anything else (the concurrency cap, a landing repo)
      const s = String(card.last_event.summary || '')
      label = /^blocked by /.test(s) ? 'blocked by lease' : 'blocked: ' + s.replace(/^blocked:\s*/, '').slice(0, 24)
      titleAttr = s
    } else if (card.status === 'running' && card.station_kind === 'land') {
      label = 'landing'
    } else if (card.status === 'waiting_human' && card.pr_url) {
      label = 'PR open'
      titleAttr = card.pr_url
    }
    return el('span', { class: `chip status-chip ${cls}`, title: titleAttr }, [label])
  }

  function shortWorktree(card) {
    if (!card.worktree) return ''
    const parts = String(card.worktree).split(/[\\/]/).filter(Boolean)
    const i = parts.lastIndexOf('.baton-worktrees')
    return i > 0 ? parts.slice(i - 1).join('/') : parts.slice(-2).join('/')
  }

  // A bounced card carries its reason until it lands or ends: "bounced: test
  // red (attempt 1)" while it is queued, running or handing off again.
  function buildBounceChip(card) {
    if (!card.bounce_reason || !['queued', 'running', 'handing_off', 'needs_approval'].includes(card.status)) return null
    const short = String(card.bounce_reason).split(/[(:]/)[0].trim().slice(0, 24) || 'bounced'
    const attempt = card.land_attempts ? ` (attempt ${card.land_attempts})` : ''
    return el('span', { class: 'chip status-chip warn bounce-chip', title: card.bounce_reason }, [`bounced: ${short}${attempt}`])
  }

  function buildChainRail(card) {
    const rail = el('div', { class: 'chain-rail' })
    for (const entry of card.chain_view || []) {
      const accent = ADAPTER_ACCENTS.includes(baseAdapterName(entry.adapter)) ? baseAdapterName(entry.adapter) : 'fake'
      const pill = el('span', { class: `pill adapter-${accent} state-${entry.state}` }, [
        el('span', { class: 'pill-adapter' }, [entry.adapter]),
        entry.mode ? el('span', { class: 'pill-mode' }, [entry.mode]) : null,
        el('span', { class: 'pill-state', 'aria-hidden': 'true' }, [stateGlyph(entry.state)]),
        entry.approve ? el('span', { class: 'pill-lock', 'aria-hidden': 'true' }, ['🔒']) : null,
      ])
      rail.appendChild(pill)
    }
    return rail
  }

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
      renderCard(card)
    }).catch((err) => {
      if (state.logRequests.get(id) === request) toast(err.message)
    }).finally(() => {
      if (state.logRequests.get(id) === request) state.logRequests.delete(id)
    })
    request.promise = promise
    state.logRequests.set(id, request)
    return promise
  }

  function buildLogSection(card) {
    const wrap = el('div', { class: 'card-log' })
    const cache = state.logState.get(card.card_id)
    if (card.runs_count > 0 && !cache) ensureLogLoaded(card.card_id, 8)
    const lines = cache ? cache.lines : []
    const text = lines.length ? lines.join('\n') : (card.runs_count > 0 ? 'loading log…' : 'no runs yet')
    wrap.appendChild(el('pre', { class: 'log-pre' }, [text]))
    if (card.runs_count > 0 && (!cache || !cache.expanded)) {
      wrap.appendChild(el('button', { type: 'button', class: 'log-more', onclick: () => ensureLogLoaded(card.card_id, 200) }, ['show more']))
    }
    return wrap
  }

  function buildReassignPicker(card) {
    const adapterSelect = el('select', { 'aria-label': `Reassign adapter for ${card.title || card.card_id}` })
    const modeSelect = el('select', { 'aria-label': `Reassign mode for ${card.title || card.card_id}` })
    const applyBtn = el('button', { type: 'button' }, ['Apply'])
    const cancelBtn = el('button', { type: 'button' }, ['Cancel'])
    const picker = el('div', { class: 'reassign-picker', hidden: true }, [adapterSelect, modeSelect, applyBtn, cancelBtn])

    function populateModes() {
      modeSelect.textContent = ''
      const adapter = (state.adapters || []).find((a) => a.name === adapterSelect.value)
      const allowed = adapter ? adapter.modes.allowed : []
      for (const m of allowed) modeSelect.appendChild(el('option', { value: m }, [m]))
      if (adapter && adapter.modes.default) modeSelect.value = adapter.modes.default
    }

    async function open() {
      if (!state.adapters) {
        try { state.adapters = (await api('/api/adapters')).adapters } catch (err) { toast(err.message); return }
      }
      adapterSelect.textContent = ''
      for (const a of state.adapters) adapterSelect.appendChild(el('option', { value: a.name }, [a.name]))
      if (card.active_adapter) adapterSelect.value = card.active_adapter
      populateModes()
      picker.hidden = false
    }

    adapterSelect.addEventListener('change', populateModes)
    applyBtn.addEventListener('click', async () => {
      try {
        await api(`/api/cards/${encodeURIComponent(card.card_id)}/reassign`, { method: 'POST', body: { adapter: adapterSelect.value, mode: modeSelect.value } })
        picker.hidden = true
      } catch (err) {
        toast(err.message)
      }
    })
    cancelBtn.addEventListener('click', () => { picker.hidden = true })

    return { node: picker, open }
  }

  async function runAction(card, action) {
    try {
      await api(`/api/cards/${encodeURIComponent(card.card_id)}/${ACTION_PATHS[action]}`, { method: 'POST', body: {} })
    } catch (err) {
      toast(err.message)
    }
  }

  async function removeCardAction(card) {
    if (!confirm(`Remove card "${card.title || card.card_id}"? This cannot be undone.`)) return
    try {
      await api(`/api/cards/${encodeURIComponent(card.card_id)}`, { method: 'DELETE' })
      dropCard(card.card_id)
    } catch (err) {
      toast(err.message)
    }
  }

  function buildActions(card, reassign) {
    const wrap = el('div', { class: 'card-actions' })
    for (const action of card.actions || []) {
      const label = ACTION_LABELS[action]
      if (!label) continue
      if (action === 'reassign') {
        wrap.appendChild(el('button', { type: 'button', 'aria-label': `${label} ${card.title || card.card_id}`, onclick: () => reassign.open() }, [label]))
        continue
      }
      wrap.appendChild(el('button', { type: 'button', 'aria-label': `${label} ${card.title || card.card_id}`, onclick: () => runAction(card, action) }, [label]))
    }
    if (['done', 'failed', 'killed'].includes(card.status)) {
      wrap.appendChild(el('button', { type: 'button', class: 'danger', 'aria-label': `Remove ${card.title || card.card_id}`, onclick: () => removeCardAction(card) }, ['Remove']))
    }
    return wrap
  }

  function buildCardChildren(card) {
    const children = []
    const titleBtn = el('button', { type: 'button', class: 'card-title', onclick: () => openDrawer(card.card_id) }, [card.title || truncate(card.task, 60)])
    children.push(el('div', { class: 'card-head' }, [titleBtn]))

    children.push(el('div', { class: 'card-meta' }, [
      el('span', { class: 'repo-name' }, [card.repo_name || '']),
      card.station && card.station !== '-' ? el('span', { class: 'chip station-chip' }, [card.station]) : null,
      buildStatusChip(card),
      buildBounceChip(card),
    ]))

    children.push(buildChainRail(card))

    const leases = card.leases && card.leases.length ? card.leases : ['**']
    children.push(el('div', { class: 'card-leases' }, leases.map((l) => el('span', { class: 'chip lease-chip' }, [l]))))

    children.push(el('div', { class: 'card-elapsed' }, [
      el('span', { class: 'elapsed' }, [card.active_run ? formatElapsed(Date.now() - Date.parse(card.active_run.started_at)) : '--:--']),
    ]))

    const lastEventEl = el('div', { class: 'card-last-event' }, [formatLastEvent(card.last_event)])
    if (card.last_event && card.last_event.type === 'blocked_by') lastEventEl.setAttribute('title', card.last_event.summary)
    children.push(lastEventEl)

    children.push(buildLogSection(card))

    const reassign = buildReassignPicker(card)
    children.push(buildActions(card, reassign))
    children.push(reassign.node)

    return children
  }

  function renderCard(card) {
    state.cards.set(card.card_id, card)
    let root = state.cardNodes.get(card.card_id)
    if (!root) {
      root = el('article', { class: 'card', 'data-card-id': card.card_id })
      state.cardNodes.set(card.card_id, root)
    } else {
      while (root.firstChild) root.removeChild(root.firstChild)
    }
    for (const child of buildCardChildren(card)) if (child) root.appendChild(child)
    const target = state.columnEls.get(card.column)
    if (target && root.parentElement !== target.list) target.list.appendChild(root)
    updateColumnCounts()
    return root
  }

  // ---- drawer ----
  function buildEventRow(e) {
    const row = el('div', { class: 'event-row' }, [
      el('span', { class: 'mono event-ts' }, [e.ts]),
      el('span', { class: 'event-type' }, [e.type]),
      el('span', { class: 'event-actor' }, [formatActor(e.actor)]),
      el('span', { class: 'event-summary' }, [e.summary]),
    ])
    if (e.body) {
      const details = el('details', {}, [el('summary', {}, ['body'])])
      details.appendChild(el('pre', { class: 'mono' }, [typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)]))
      row.appendChild(details)
    }
    return row
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

  function renderDrawer(detail, log) {
    const content = document.getElementById('drawer-content')
    content.textContent = ''
    const card = detail.card
    content.appendChild(el('h2', {}, [card.title || card.card_id]))

    content.appendChild(el('h3', {}, ['Task']))
    content.appendChild(el('p', {}, [card.task || '']))

    content.appendChild(el('h3', {}, ['Worktree']))
    // shown relative to the repo (the full path is the tooltip): a shared board
    // should not print an operator's home directory
    content.appendChild(el('p', { class: 'mono', title: card.worktree || '' }, [shortWorktree(card) || '(none)']))

    content.appendChild(el('h3', {}, ['Pipeline']))
    const pipelineList = el('ol', { class: 'pipeline-list' })
    for (const st of card.pipeline || []) {
      pipelineList.appendChild(el('li', { class: st.name === card.station ? 'current' : '' }, [`${st.name} (${st.kind})`]))
    }
    content.appendChild(pipelineList)

    content.appendChild(el('h3', {}, ['Events']))
    const timeline = el('div', { class: 'events-timeline', id: 'drawer-events' })
    for (const e of detail.events || []) timeline.appendChild(buildEventRow(e))
    content.appendChild(timeline)

    content.appendChild(el('h3', {}, ['Runs']))
    const runsList = el('ul', { class: 'runs-list' })
    for (const r of detail.runs || []) {
      runsList.appendChild(el('li', {}, [`run ${r.run} — ${r.adapter} — ${r.outcome ?? r.status} — signal ${r.signal ?? '-'} — exit ${r.exit_code ?? '-'}`]))
    }
    content.appendChild(runsList)

    content.appendChild(el('h3', {}, ['Bundle']))
    if (detail.bundle) {
      const pathText = detail.bundle.path || ''
      const copyBtn = el('button', { type: 'button', onclick: () => copyToClipboard(pathText) }, ['Copy path'])
      // shown from the worktree down; Copy path copies the full path
      const parts = pathText.split(/[\\/]/).filter(Boolean)
      const wt = parts.lastIndexOf('.baton-worktrees')
      const shown = wt >= 0 ? parts.slice(wt + 2).join('/') : parts.slice(-3).join('/')
      content.appendChild(el('p', {}, [`${detail.bundle.id}: `, el('span', { class: 'mono', title: pathText }, [shown || pathText]), copyBtn]))
    } else {
      content.appendChild(el('p', {}, ['no bundle']))
    }

    content.appendChild(el('h3', {}, ['Log']))
    content.appendChild(el('pre', { class: 'log-pre' }, [(log.lines || []).join('\n') || '(empty)']))
  }

  function appendDrawerEvent(ev) {
    const timeline = document.getElementById('drawer-events')
    if (timeline) timeline.appendChild(buildEventRow(ev))
  }

  function refreshDrawerAfterUpdate() {
    // card summary changed while the drawer is open; the pipeline highlight
    // and top section can go stale, so refetch the drawer's own detail.
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

  async function openDrawer(id) {
    state.drawerId = id
    const request = ++state.drawerRequest
    const drawer = document.getElementById('drawer')
    drawer.hidden = false
    drawer.setAttribute('aria-hidden', 'false')
    try {
      const [detail, log] = await Promise.all([
        api(`/api/cards/${encodeURIComponent(id)}`),
        api(`/api/cards/${encodeURIComponent(id)}/log?tail=2000`),
      ])
      if (state.drawerId !== id || request !== state.drawerRequest) return
      renderDrawer(detail, log)
    } catch (err) {
      toast(err.message)
    }
  }

  function closeDrawer() {
    state.drawerId = null
    state.drawerRequest += 1
    const drawer = document.getElementById('drawer')
    drawer.hidden = true
    drawer.setAttribute('aria-hidden', 'true')
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

  function addChainRow(ui, { adapter: preferred = null, first = false } = {}) {
    const adapterSelect = el('select', { 'aria-label': 'Chain adapter' })
    const adapters = [...(state.adapters || [])].sort((a, b) => Number(a.fake) - Number(b.fake))
    for (const a of adapters) adapterSelect.appendChild(el('option', { value: a.name }, [adapterLabel(a)]))
    if (preferred && adapters.some((a) => a.name === preferred)) adapterSelect.value = preferred
    const modeSelect = el('select', { 'aria-label': 'Chain mode' })
    const approveCheckbox = el('input', { type: 'checkbox', 'aria-label': 'Approve before this leg' })
    const approveLabel = el('label', {}, [approveCheckbox, ' approval before start'])
    const turnsInput = el('input', { type: 'number', min: '0', 'aria-label': 'Max turns', placeholder: 'max turns' })
    const fakeInput = el('input', { type: 'text', 'aria-label': 'Scripted test behavior', placeholder: 'test behavior' })
    const removeBtn = first ? null : el('button', { type: 'button', 'aria-label': 'Remove fallback agent' }, ['Remove'])
    const title = el('span', { class: 'fallback-row-title' }, [first ? `First: ${preferred}` : `Fallback ${ui.chainRows.children.length + 1}`])
    const row = el('div', { class: `chain-row${first ? '' : ' fallback-row'}` }, [title, adapterSelect, modeSelect, approveLabel, turnsInput, fakeInput, removeBtn])
    if (first) adapterSelect.hidden = true
    if (removeBtn) removeBtn.addEventListener('click', () => { row.remove(); refreshFallbackSummary(ui) })

    function populateModes() {
      modeSelect.textContent = ''
      const adapter = (state.adapters || []).find((a) => a.name === adapterSelect.value)
      const allowed = adapter ? adapter.modes.allowed : []
      for (const m of allowed) modeSelect.appendChild(el('option', { value: m }, [m]))
      if (adapter && adapter.modes.default) modeSelect.value = adapter.modes.default
      fakeInput.hidden = !(adapter && adapter.fake)
    }
    adapterSelect.addEventListener('change', populateModes)
    populateModes()

    row.fields = { adapterSelect, modeSelect, approveCheckbox, turnsInput, fakeInput }
    ;(first ? ui.firstControls : ui.chainRows).appendChild(row)
    refreshFallbackSummary(ui)
    return row
  }

  function refreshFallbackSummary(ui) {
    const names = [...ui.chainRows.children].filter((row) => row.fields).map((row) => row.fields.adapterSelect.value)
    ui.fallbackSummary.textContent = names.length
      ? `If the first agent cannot continue, Baton tries ${names.join(' → ')} in this order.`
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
    const preferred = ['claude', 'codex', 'agy'].filter((name) => real.includes(name) && name !== first)
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

  // ---- settings ----
  function initSettings() {
    const input = document.getElementById('token-input')
    input.value = getToken()
    input.addEventListener('change', async () => {
      const v = input.value.trim()
      if (v) localStorage.setItem('batonToken', v)
      else localStorage.removeItem('batonToken')
      state.boardRevision += 1
      state.cardsRequest += 1
      state.sseRequest += 1
      if (state.es) { try { state.es.close() } catch { /* ignore */ } }
      state.es = null
      const owner = await loadHealth()
      if (owner) fetchCards()
      connectSse()
    })
  }

  // ---- init ----
  async function init() {
    initSettings()
    initNewCardDialog()
    document.getElementById('new-card-btn').addEventListener('click', () => openNewCardDialog())
    document.getElementById('empty-new-card-btn').addEventListener('click', () => openNewCardDialog())
    document.getElementById('drawer-close').addEventListener('click', () => closeDrawer())
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.drawerId) closeDrawer() })
    // health first: it says whether this human owns the pipeline side at all
    await loadHealth()
    fetchCards()
    connectSse()
    setInterval(tickElapsed, 1000)
  }

  document.addEventListener('DOMContentLoaded', init)

  // test seam: node:test runs this file with a stub document and reads the
  // pure update decisions back out; in a browser there is no `module`
  if (typeof module !== 'undefined') module.exports = { drawerRefreshNeeded, staleLogTail }
})()
