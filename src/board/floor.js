// Baton floor — the scheduler-eye view: what's running, waiting, queued, and
// which leases block whom. Polls /api/floor + /api/trunk and refreshes on SSE.
(function () {
  'use strict'

  const WAIT_LABELS = { approve: 'Approve', resume: 'Resume', kill: 'Kill' }

  const state = { es: null, retryMs: 1000 }

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

  function formatElapsed(ms) {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
    const total = Math.floor(safe / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  function formatTs(ts) { return String(ts || '').replace('T', ' ').slice(0, 19) }

  function formatLastEvent(last) {
    if (!last) return 'no events yet'
    const s = `${last.type}: ${last.summary}`
    return s.length > 90 ? `${s.slice(0, 89)}…` : s
  }

  function emptyRow(colspan, text) {
    return el('tr', {}, [el('td', { colspan: String(colspan) }, [text])])
  }

  async function runFloorAction(id, action) {
    try {
      await api(`/api/cards/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} })
      refreshFloor()
    } catch (err) {
      toast(err.message)
    }
  }

  function renderHeader(data) {
    // repo names only on the floor (the full path is the tooltip): a shared
    // floor should not print every operator's home directory
    const reposEl = document.getElementById('repos-list')
    reposEl.textContent = data.repos && data.repos.length ? data.repos.map((r) => String(r).split(/[\\/]/).filter(Boolean).pop() || r).join(', ') : '(none)'
    reposEl.title = data.repos && data.repos.length ? data.repos.join('\n') : ''
    const sched = data.scheduler || {}
    document.getElementById('sched-status').textContent = `scheduler: ${sched.running ? 'running' : 'stopped'}, ${sched.max_concurrent ?? '?'} max`
    document.getElementById('count-running').textContent = String(data.counts.running)
    document.getElementById('count-queued').textContent = String(data.counts.queued)
    document.getElementById('count-waiting').textContent = String(data.counts.waiting)
    document.getElementById('count-done').textContent = String(data.counts.done)
  }

  function renderRunning(list) {
    const body = document.getElementById('running-body')
    body.textContent = ''
    if (!list.length) { body.appendChild(emptyRow(7, 'Nothing running.')); return }
    for (const r of list) {
      body.appendChild(el('tr', {}, [
        el('td', {}, [r.title || r.card_id]),
        el('td', {}, [r.station || '']),
        el('td', { class: 'mono' }, [`${r.adapter || '?'} leg ${r.leg}`]),
        el('td', { class: 'mono' }, [(r.leases && r.leases.length ? r.leases : ['**']).join(', ')]),
        el('td', {}, [formatLastEvent(r.last_event)]),
        el('td', { class: 'mono' }, [formatElapsed(r.elapsed_ms || 0)]),
        el('td', { class: 'row-actions' }, [
          el('button', { type: 'button', 'aria-label': `Pause ${r.title || r.card_id}`, onclick: () => runFloorAction(r.card_id, 'pause') }, ['Pause']),
          el('button', { type: 'button', 'aria-label': `Kill ${r.title || r.card_id}`, onclick: () => runFloorAction(r.card_id, 'kill') }, ['Kill']),
        ]),
      ]))
    }
  }

  function renderWaiting(list) {
    const body = document.getElementById('waiting-body')
    body.textContent = ''
    if (!list.length) { body.appendChild(emptyRow(5, 'No cards waiting on a human.')); return }
    for (const w of list) {
      const btns = (w.actions || [])
        .filter((a) => WAIT_LABELS[a])
        .map((a) => el('button', { type: 'button', 'aria-label': `${WAIT_LABELS[a]} ${w.title || w.card_id}`, onclick: () => runFloorAction(w.card_id, a) }, [WAIT_LABELS[a]]))
      body.appendChild(el('tr', {}, [
        el('td', {}, [w.title || w.card_id]),
        el('td', {}, [w.station || '']),
        el('td', {}, [w.status]),
        el('td', { class: 'mono' }, [formatTs(w.since)]),
        el('td', { class: 'row-actions' }, btns),
      ]))
    }
  }

  function renderQueued(list) {
    const body = document.getElementById('queued-body')
    body.textContent = ''
    if (!list.length) { body.appendChild(emptyRow(4, 'Nothing queued.')); return }
    for (const q of list) {
      body.appendChild(el('tr', {}, [
        el('td', {}, [q.title || q.card_id]),
        el('td', {}, [q.station || '']),
        el('td', { class: 'mono' }, [(q.leases && q.leases.length ? q.leases : ['**']).join(', ')]),
        el('td', {}, [q.blocked_by ? `blocked by ${q.blocked_by}` : '']),
      ]))
    }
  }

  function renderLeases(data) {
    const body = document.getElementById('leases-body')
    body.textContent = ''
    if (!data.leases.length) { body.appendChild(emptyRow(4, 'No leases held.')); return }
    for (const l of data.leases) {
      body.appendChild(el('tr', {}, [
        el('td', { class: 'mono' }, [l.lease]),
        el('td', {}, [l.card_id]),
        el('td', {}, [l.station || '']),
        el('td', { class: 'mono' }, [formatTs(l.since)]),
      ]))
      const blocked = (data.queued || []).filter((q) => q.blocked_by && q.blocked_by.includes(l.lease))
      if (blocked.length) {
        const names = blocked.map((q) => q.title || q.card_id).join(', ')
        body.appendChild(el('tr', { class: 'lease-blocked-row' }, [el('td', { colspan: '4' }, [`queued, blocked: ${names}`])]))
      }
    }
  }

  function renderTrunkTable(data) {
    const body = document.getElementById('trunk-body')
    body.textContent = ''
    if (!data.landed.length) { body.appendChild(emptyRow(3, 'Nothing landed in the last hour.')); return }
    for (const t of data.landed) {
      body.appendChild(el('tr', {}, [
        el('td', { class: 'mono' }, [formatTs(t.ts)]),
        el('td', {}, [t.title || t.card_id]),
        el('td', {}, [t.summary || '']),
      ]))
    }
  }

  async function refreshFloor() {
    try {
      const data = await api('/api/floor')
      renderHeader(data)
      renderRunning(data.running)
      renderWaiting(data.waiting)
      renderQueued(data.queued)
      renderLeases(data)
    } catch (err) {
      toast(err.message)
    }
  }

  async function refreshTrunk() {
    try {
      const data = await api('/api/trunk?since=1h')
      renderTrunkTable(data)
    } catch (err) {
      toast(err.message)
    }
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
    setSseState('connecting')
    const token = getToken()
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events'
    const es = new EventSource(url)
    state.es = es
    es.addEventListener('hello', () => {
      state.retryMs = 1000
      setSseState('live')
      refreshFloor()
      refreshTrunk()
    })
    es.addEventListener('card', () => refreshFloor())
    es.addEventListener('event', (e) => {
      refreshFloor()
      const data = JSON.parse(e.data)
      if (data.type === 'landed') refreshTrunk()
    })
    es.onerror = () => {
      setSseState('reconnecting')
      try { es.close() } catch { /* ignore */ }
      const wait = state.retryMs || 1000
      setTimeout(connectSse, wait)
      state.retryMs = Math.min(wait * 2, 15000)
    }
  }

  function init() {
    connectSse()
    refreshFloor()
    refreshTrunk()
    setInterval(refreshFloor, 2000)
    setInterval(refreshTrunk, 2000)
  }

  document.addEventListener('DOMContentLoaded', init)
})()
