// Audit trail: who did what, across every terminal and every card on this
// board. Data: /api/audit, which is owner-only — the trail names repositories
// and the people on the roster.
//
// It loads when the reader asks, never on a board render: the trail reads every
// session's events and every card's ledger, and that is not work to do on a
// timer behind a panel nobody has opened. Like the history cell, nothing here
// arrives over SSE (DESIGN.md rule 3: the live terminals lane is the only live
// region).
//
// `el`, `api`, `getToken`, `ago` and `whenAgo` are copied from sessions.js,
// which cannot export from its IIFE. The time grammar is sessions.js's: a
// change to ago() there is a change here in the same commit.
(function () {
  'use strict'

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
  function clockAt(ms) {
    const d = new Date(ms)
    if (!Number.isFinite(d.getTime())) return ''
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  }

  const root = document.getElementById('audit')
  if (!root) return
  const whoSel = document.getElementById('audit-who')
  const kindSel = document.getElementById('audit-kind')
  const loadBtn = document.getElementById('audit-load')
  const meta = document.getElementById('audit-meta')
  const list = document.getElementById('audit-list')
  let knownPeople = null

  // A guest or an operator never sees this panel; the fieldset stays hidden
  // until /api/audit answers, so a 403 leaves nothing on the page to click.
  async function reveal() {
    try {
      const r = await api('/api/audit?limit=1')
      root.hidden = false
      knownPeople = r.people || []
      fillPeople()
    } catch { root.hidden = true }
  }

  function fillPeople() {
    if (!knownPeople) return
    const current = whoSel.value
    while (whoSel.options.length > 1) whoSel.remove(1)
    for (const p of knownPeople) whoSel.appendChild(el('option', { value: p }, [p]))
    whoSel.value = current
  }

  function row(e) {
    const line = el('div', { class: 'audit-row' })
    line.appendChild(el('span', { class: 'audit-when', title: e.at }, [clockAt(Date.parse(e.at))]))
    line.appendChild(el('span', { class: `chip chip-id-${e.kind === 'human' ? 'human' : (e.agent || 'leg')}` }, [e.who]))
    line.appendChild(el('span', { class: 'audit-what' }, [e.what.replace(/_/g, ' ')]))
    line.appendChild(el('span', { class: 'audit-summary' }, [e.summary || '']))
    const where = e.where === 'card' ? `card ${e.id}` : `terminal ${String(e.id).split('-').pop()}`
    line.appendChild(el('span', { class: 'chip' }, [where]))
    if (e.repo) line.appendChild(el('span', { class: 'chip' }, [String(e.repo).split(/[\\/]/).pop() + (e.branch ? `@${e.branch}` : '')]))
    line.appendChild(el('span', { class: 'audit-ago' }, [whenAgo(e.at)]))
    return line
  }

  async function load() {
    loadBtn.disabled = true
    meta.textContent = 'reading every terminal and every card…'
    list.replaceChildren()
    try {
      const q = new URLSearchParams({ limit: '200' })
      if (whoSel.value) q.set('who', whoSel.value)
      if (kindSel.value) q.set('kind', kindSel.value)
      const r = await api(`/api/audit?${q}`)
      knownPeople = r.people || knownPeople
      fillPeople()
      // L2: the verdict carries the volume it processed, so an empty trail from
      // a board that looked at nothing does not read like a quiet week.
      const scanned = `${r.scanned.sessions} terminal${r.scanned.sessions === 1 ? '' : 's'} and ${r.scanned.cards} card${r.scanned.cards === 1 ? '' : 's'}, ${r.scanned.events} events read`
      meta.textContent = r.entries.length
        ? `${r.matched} action${r.matched === 1 ? '' : 's'}${r.truncated ? `, newest ${r.entries.length} shown` : ''} — ${scanned}`
        : `nothing matched — ${scanned}`
      for (const e of r.entries) list.appendChild(row(e))
    } catch (err) {
      meta.textContent = err.message
    } finally {
      loadBtn.disabled = false
    }
  }

  loadBtn.addEventListener('click', load)
  whoSel.addEventListener('change', load)
  kindSel.addEventListener('change', load)
  reveal()
})()
