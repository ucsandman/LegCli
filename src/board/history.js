// History cell: every conversation on this machine, Leg's own and the ones
// Claude Code, Codex, Grok, Antigravity and Copilot keep in their own stores.
// Data: /api/history (a page at a time) and /api/history/<id> (one
// conversation's last messages, read only when a row is opened), plus
// /api/worktrees. Nothing here is pushed over SSE: the live terminals lane
// stays the only live region; this cell is a count that opens, like finished
// terminals and what landed (DESIGN.md rule 3).
//
// `el`, `api`, `getToken`, `ago` and `whenAgo` are copied from sessions.js,
// which cannot export from its IIFE. The time grammar is sessions.js's: a
// change to ago() there is a change here in the same commit.
(function () {
  'use strict'
  const PAGE = 50
  const IDS = ['claude', 'codex', 'agy', 'grok', 'copilot']

  function getToken() { return localStorage.getItem('legToken') || localStorage.getItem('batonToken') || '' }
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const r = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
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
  function whenAgo(ts) {
    const t = Date.parse(ts)
    return Number.isFinite(t) ? `${ago(Date.now() - t)} ago` : ''
  }
  function sysMessage(text, tone) { const fn = window.legMessage || window.batonMessage; if (typeof fn === 'function') fn(text, tone) }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(ta)
    return ok
  }

  function takeFocus(box) {
    const node = document.activeElement
    if (!box || !node || !box.contains(node)) return null
    const key = typeof node.getAttribute === 'function' ? node.getAttribute('data-focus-key') : null
    if (!key) return null
    const at = { key }
    if (typeof node.selectionStart === 'number') { at.start = node.selectionStart; at.end = node.selectionEnd }
    return at
  }

  function putFocus(box, at) {
    if (!box || !at) return
    const key = at.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    let target = null
    try { target = box.querySelector(`[data-focus-key="${key}"]`) } catch { return }
    if (target && target.disabled) target = target.parentElement?.querySelector('[data-focus-key]:not([disabled])') || null
    if (!target) return
    target.focus({ preventScroll: true })
    if (typeof at.start === 'number' && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(at.start, at.end) } catch {}
    }
  }

  function takeScroll(box) {
    const at = new Map()
    if (!box) return at
    for (const node of box.querySelectorAll('[data-scroll-key]')) if (node.scrollTop) at.set(node.getAttribute('data-scroll-key'), node.scrollTop)
    return at
  }

  function putScroll(box, at) {
    if (!box || !at || !at.size) return
    for (const node of box.querySelectorAll('[data-scroll-key]')) {
      const was = at.get(node.getAttribute('data-scroll-key'))
      if (was) node.scrollTop = was
    }
  }

  const state = {
    open: false, loaded: false, loading: false, error: '', guest: false,
    total: 0, counts: {}, records: [], offset: 0, providers: [], refreshedAt: null,
    filters: { provider: '', search: '', repo: '', managed: false },
    detailId: null, detail: null, detailError: '',
    worktrees: null, worktreesError: '',
  }
  let searchTimer = null
  let loadSeq = 0 // a slower, older request never overwrites a newer filter's answer

  function query({ more = false } = {}) {
    const f = state.filters
    const q = new URLSearchParams()
    q.set('limit', String(PAGE))
    if (more && state.records.length) {
      const last = state.records[state.records.length - 1]
      q.set('before', last.id)
    } else {
      q.set('offset', '0')
    }
    if (f.provider) q.set('provider', f.provider)
    if (f.search) q.set('search', f.search)
    if (f.repo) q.set('repo', f.repo)
    if (f.managed) q.set('managed', '1')
    return `/api/history?${q}`
  }

  async function load({ more = false } = {}) {
    if (state.loading && more) return
    state.loading = true
    state.error = ''
    const seq = ++loadSeq
    try {
      const r = await api(query({ more }))
      if (seq !== loadSeq) return
      // a page fetched after new conversations arrived can overlap the last one
      const seen = new Set(more ? state.records.map((x) => x.id) : [])
      state.records = more ? [...state.records, ...r.records.filter((x) => !seen.has(x.id))] : r.records
      state.total = r.total
      state.counts = r.counts || {}
      state.providers = r.providers || []
      state.refreshedAt = r.refreshed_at
      state.loaded = true
      if (r.refresh_error) state.error = `the index did not refresh: ${r.refresh_error}`
    } catch (err) {
      if (seq !== loadSeq) return
      // a guest never gets this cell: the whole group is the owner's
      if (/belongs to the owner/.test(err.message)) state.guest = true
      state.error = err.message
    }
    state.loading = false
    render()
  }

  async function loadWorktrees() {
    try { state.worktrees = await api('/api/worktrees?dirty=0'); state.worktreesError = '' } catch (err) { state.worktreesError = err.message }
    render()
  }

  async function openDetail(id) {
    if (state.detailId === id) { state.detailId = null; state.detail = null; render(); return }
    state.detailId = id
    state.detail = null
    state.detailError = ''
    render()
    try {
      const d = await api(`/api/history/${encodeURIComponent(id)}?messages=8`)
      if (state.detailId !== id) return
      state.detail = d
    } catch (err) { if (state.detailId === id) state.detailError = err.message }
    render()
    document.querySelector(`[data-focus-key="history-close:${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
  }

  function copy(text, what) {
    const done = () => sysMessage(`${what} copied`, 'ok')
    const fail = () => {
      if (fallbackCopy(text)) done()
      else sysMessage(`could not copy the ${what}`, 'danger')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail)
    else fail()
  }

  const short = (r) => `${r.provider}:${String(r.native_id || r.leg_session_id || '').slice(0, 8)}`
  const agentChip = (name) => el('span', { class: `chip${IDS.includes(name) ? ` chip-id-${name}` : ''}` }, [name])

  function row(r) {
    const where = `${r.repo_name || r.cwd || 'no folder'}${r.branch ? ` on ${r.branch}` : ''}${r.worktree ? ' (worktree)' : ''}`
    const open = state.detailId === r.id
    const title = el('button', { type: 'button', class: 'history-title', 'aria-expanded': open ? 'true' : 'false', 'data-focus-key': `history:${r.id}` }, [r.title || `(untitled, ${short(r)})`])
    title.addEventListener('click', () => openDetail(r.id))
    return el('div', { class: 'history-row', 'data-history-id': r.id }, [
      el('div', {}, [
        title,
        el('div', { class: 'history-register' }, [
          agentChip(r.provider),
          r.managed ? el('span', { class: 'chip' }, [r.live ? 'leg, live' : 'leg']) : el('span', { class: 'chip is-stale' }, [r.live ? 'external, live' : 'external']),
          el('span', {}, [where]),
          r.turns ? el('span', {}, [`${r.turns} prompt${r.turns === 1 ? '' : 's'}`]) : null,
          el('span', { class: 'mono' }, [short(r)]),
        ]),
      ]),
      el('span', { class: 'history-when' }, [whenAgo(r.updated_at || r.started_at)]),
    ])
  }

  function messageRow(m, key) {
    const isUser = m.role === 'user'
    return el('div', { class: `turn drawer-msg ${isUser ? 'is-human' : 'is-agent'}` }, [
      el('div', { class: 'drawer-msg-head' }, [
        el('span', { class: `turn-role drawer-msg-role ${isUser ? '' : 'chip-state-ok'}` }, [isUser ? 'human' : 'agent']),
        m.ts ? el('span', { class: 'turn-when drawer-msg-when' }, [whenAgo(m.ts)]) : null,
      ]),
      el('p', { 'data-scroll-key': `history-msg:${key}` }, [m.text]),
    ])
  }

  function detail(r) {
    const d = state.detail
    const box = el('div', { class: 'history-detail', role: 'region', 'aria-label': `Conversation ${short(r)}` })
    const close = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-focus-key': `history-close:${r.id}` }, ['Close'])
    close.addEventListener('click', () => openDetail(r.id))
    box.appendChild(el('div', { class: 'detail-heading' }, [el('span', {}, [r.title || 'Untitled conversation']), close]))
    if (state.detailError) { box.appendChild(el('p', { class: 'history-empty' }, [`could not read it: ${state.detailError}`])); return box }
    if (!d) { box.appendChild(el('p', { class: 'history-empty' }, ['reading the conversation'])); return box }
    const kv = el('div', { class: 'kv' })
    const pair = (k, v) => { if (v === null || v === undefined || v === '') return; kv.appendChild(el('span', { class: 'kv-key' }, [k])); kv.appendChild(el('span', { class: 'kv-val' }, [typeof v === 'string' ? v : String(v)])) }
    pair('agent', `${d.provider}${d.account && d.account !== 'default' ? ` (${d.account})` : ''}`)
    pair('started by', d.managed ? `Leg, session ${d.leg_session_id} (${d.leg_status})` : 'the agent itself, outside Leg')
    pair('folder', `${d.cwd || 'unknown'}${d.cwd_exists === false ? ' (gone)' : ''}`)
    pair('repository', d.repo ? `${d.repo}${d.branch ? ` on ${d.branch}` : ''}` : null)
    pair('worktree', d.worktree ? d.worktree.path : null)
    pair('started', d.started_at ? `${new Date(d.started_at).toLocaleString()} (${whenAgo(d.started_at)})` : null)
    pair('last activity', d.updated_at ? `${new Date(d.updated_at).toLocaleString()} (${whenAgo(d.updated_at)})` : null)
    pair('prompts', d.turns)
    pair('transcript', d.transcript === 'supported' ? d.transcript_path : `${d.transcript_path || 'kept by the agent'} (Leg cannot read this agent's transcript)`)
    pair('id', d.id)
    box.appendChild(kv)
    const cmd = el('div', { class: 'history-command' })
    if (d.resume && d.resume.supported) {
      const text = `leg history continue ${d.id}`
      const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, ['Copy the continue command'])
      b.addEventListener('click', () => copy(text, 'command'))
      cmd.append(el('span', {}, ['Continue it in a terminal:']), el('code', { class: 'mono' }, [text]), b)
    } else cmd.appendChild(el('span', { class: 'history-empty' }, [`Cannot continue it: ${d.resume ? d.resume.reason : 'unknown'}`]))
    if (d.cwd) { const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, ['Copy folder path']); b.addEventListener('click', () => copy(d.cwd, 'path')); cmd.appendChild(b) }
    box.appendChild(cmd)
    if (d.messages === null) box.appendChild(el('p', { class: 'history-empty' }, ['Leg has no reader for this agent\'s transcript; the agent itself can show it.']))
    else if (!d.messages.length) box.appendChild(el('p', { class: 'history-empty' }, ['No messages could be read from the transcript.']))
    else {
      box.appendChild(el('p', { class: 'cap-line' }, [`the last ${d.messages.length} message${d.messages.length === 1 ? '' : 's'}, newest first`]))
      const msgs = [...d.messages].reverse()
      msgs.forEach((m, i) => box.appendChild(messageRow(m, `${r.id}:${i}`)))
    }
    return box
  }

  function worktreeRow(w) {
    const owner = w.owner.kind === 'checkout' ? 'the checkout itself' : w.owner.kind === 'session' ? `Leg session ${w.owner.id}${w.owner.live ? ', live' : ''}` : w.owner.kind === 'card' ? `Leg card ${w.owner.id}` : 'not Leg\'s'
    const flags = []
    if (!w.exists) flags.push(el('span', { class: 'chip chip-state-warn' }, ['missing']))
    if (w.orphaned) flags.push(el('span', { class: 'chip chip-state-warn' }, ['orphaned']))
    if (w.stale) flags.push(el('span', { class: 'chip is-stale' }, ['stale']))
    if (w.dirty !== null && w.dirty !== undefined) flags.push(el('span', { class: `chip ${w.dirty ? 'chip-state-warn' : 'chip-state-ok'}` }, [w.dirty ? `${w.dirty} uncommitted` : 'clean']))
    return el('div', { class: 'history-row' }, [
      el('div', {}, [
        el('div', { class: 'mono' }, [w.path]),
        el('div', { class: 'history-register' }, [
          el('span', {}, [`${w.repo_name || 'repo'}${w.branch ? ` on ${w.branch}` : ' (detached)'}`]),
          el('span', {}, [owner]),
          el('span', {}, [`${w.conversations.count} conversation${w.conversations.count === 1 ? '' : 's'}`]),
          ...flags,
        ]),
      ]),
      el('span', { class: 'history-when' }, [w.last_activity_at ? whenAgo(w.last_activity_at) : '']),
    ])
  }

  function render() {
    const head = document.getElementById('history-head')
    const region = document.querySelector('.region-history')
    const meta = document.querySelector('.region-history .region-meta')
    const slot = document.getElementById('history-actions')
    const panel = document.getElementById('history-drawer')
    const list = document.getElementById('history-list')
    const listMeta = document.getElementById('history-list-meta')
    const more = document.getElementById('history-more')
    if (!head || !meta || !slot || !panel || !list || !listMeta || !more) return
    const focusAt = takeFocus(panel) || takeFocus(region)
    const scrollAt = takeScroll(panel)
    slot.textContent = ''
    if (state.guest) { head.textContent = 'Conversations'; meta.textContent = 'The owner of this machine sees them.'; panel.hidden = true; return }
    if (!state.loaded) {
      head.textContent = state.error ? 'Conversations unavailable' : 'Reading conversations'
      meta.textContent = state.error || 'Looking through the agents\' own stores.'
      panel.hidden = true
      return
    }
    const filtered = state.filters.provider || state.filters.search || state.filters.repo || state.filters.managed
    const all = Object.values(state.counts).reduce((a, b) => a + b, 0)
    const byAgent = Object.entries(state.counts).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} ${p}`).join(', ')
    head.textContent = all ? `${all} conversation${all === 1 ? '' : 's'}` : 'No conversations found'
    meta.textContent = all
      ? `${byAgent}${filtered ? `; ${state.total} match the filters` : ''}${state.refreshedAt ? `; looked ${whenAgo(state.refreshedAt)}` : ''}`
      : 'Leg looks in the Claude Code, Codex, Grok, Antigravity and Copilot homes on this machine, and its own sessions.'
    const btn = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-expanded': state.open ? 'true' : 'false', 'aria-controls': 'history-drawer', 'data-focus-key': 'history-toggle' },
      [state.open ? 'Hide conversations' : (all ? `Browse ${all}` : 'Browse')])
    btn.addEventListener('click', () => { state.open = !state.open; if (state.open && state.worktrees === null) loadWorktrees(); render() })
    slot.appendChild(btn)
    panel.hidden = !state.open
    if (!state.open) {
      putFocus(region, focusAt)
      return
    }
    const headline = document.getElementById('history-drawer-head')
    if (headline) headline.textContent = filtered ? `${state.total} of ${all} conversations` : `${all} conversation${all === 1 ? '' : 's'}`
    // filters: the select is filled once from the providers the server names
    const sel = document.getElementById('history-provider')
    if (sel && sel.options.length <= 1 && state.providers.length) for (const p of state.providers) sel.appendChild(el('option', { value: p.name }, [p.label]))
    listMeta.textContent = state.error ? state.error : (state.loading ? 'reading' : `${state.records.length} of ${state.total} shown, newest first`)
    list.textContent = ''
    if (!state.records.length && !state.loading) list.appendChild(el('p', { class: 'history-empty' }, [filtered ? 'Nothing matches these filters.' : 'No conversation has been found on this machine yet.']))
    for (const r of state.records) {
      list.appendChild(row(r))
      if (state.detailId === r.id) list.appendChild(detail(r))
    }
    more.textContent = ''
    if (state.records.length < state.total) {
      const b = el('button', { type: 'button', class: 'btn btn-secondary', 'data-focus-key': 'history-more' }, [`Show ${Math.min(PAGE, state.total - state.records.length)} more`])
      b.addEventListener('click', () => load({ more: true }))
      more.appendChild(b)
    }
    // checkouts
    const wtMeta = document.getElementById('worktrees-meta')
    const wtList = document.getElementById('worktrees-list')
    if (wtMeta && wtList) {
      wtList.textContent = ''
      if (state.worktreesError) wtMeta.textContent = `could not list them: ${state.worktreesError}`
      else if (!state.worktrees) wtMeta.textContent = 'listing the checkouts'
      else {
        const w = state.worktrees.worktrees
        const missing = w.filter((x) => !x.exists).length
        const orphaned = w.filter((x) => x.orphaned).length
        wtMeta.textContent = w.length ? `${w.length} checkout${w.length === 1 ? '' : 's'} across ${state.worktrees.repos} repositor${state.worktrees.repos === 1 ? 'y' : 'ies'}${missing ? `, ${missing} missing` : ''}${orphaned ? `, ${orphaned} orphaned` : ''}. Read only: Remove on a terminal or a card is what removes one.` : 'No repository is known yet.'
        for (const x of w) wtList.appendChild(worktreeRow(x))
      }
    }
    putScroll(panel, scrollAt)
    putFocus(panel, focusAt) || putFocus(region, focusAt)
  }

  function wireFilters() {
    const sel = document.getElementById('history-provider')
    const search = document.getElementById('history-search')
    const repo = document.getElementById('history-repo')
    const only = document.getElementById('history-only')
    const form = document.getElementById('history-filters')
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); load() })
    if (sel) sel.addEventListener('change', () => { state.filters.provider = sel.value; load() })
    if (only) only.addEventListener('change', () => { state.filters.managed = only.checked; load() })
    const debounce = (input, key) => input && input.addEventListener('input', () => {
      state.filters[key] = input.value.trim()
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => load(), 300)
    })
    debounce(search, 'search')
    debounce(repo, 'repo')
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireFilters()
    render()
    load()
    // the count stays honest without pushing anything over the live stream
    setInterval(() => { if (!document.hidden && !state.open) load() }, 60000)
  })
})()
