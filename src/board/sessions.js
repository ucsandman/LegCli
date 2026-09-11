// Terminals lane: the sessions started with `baton claude|codex|agy`, the
// accounts strip (5h/7d per login), overlap flags (two live sessions editing
// the same file), and what has landed on trunk. Data: /api/sessions, pushed
// as the SSE `sessions` event (board.js re-dispatches it as `baton:sessions`).
(function () {
  'use strict'
  const STATUS = {
    starting: ['starting', 'muted'], running: ['running', 'ok'], warning: ['near limit', 'warn'], limit: ['limit hit', 'bad'],
    handing_off: ['handing off', 'warn'], waiting: ['waiting for reset', 'warn'], handed_off: ['handed off', 'muted'], ended: ['ended', 'muted'], lost: ['lost', 'bad'],
  }
  let view = null
  function getToken() { return localStorage.getItem('batonToken') || '' }
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
  function toast(msg) {
    const box = document.getElementById('toast')
    const item = el('div', { class: 'toast-item' }, [msg])
    box.appendChild(item)
    setTimeout(() => item.remove(), 6000)
  }
  function ago(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`
  }
  function until(epochS) {
    if (!epochS) return 'unknown'
    const d = new Date(epochS * 1000)
    const ms = epochS * 1000 - Date.now()
    return `${d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (in ${ago(ms)})`
  }
  function pctClass(p) { return p >= 85 ? 'bad' : p >= 60 ? 'warn' : 'ok' }
  function bar(label, w) {
    if (!w || !Number.isFinite(w.pct)) return el('span', { class: 'usage-bar empty', title: `${label}: no data yet` }, [el('span', { class: 'usage-label' }, [label]), el('span', { class: 'usage-pct' }, ['—'])])
    const p = Math.max(0, Math.min(100, Math.round(w.pct)))
    return el('span', { class: `usage-bar ${pctClass(p)}`, title: `${label} window: ${p}% used${w.resets_at ? `, resets ${until(w.resets_at)}` : ''}` }, [
      el('span', { class: 'usage-label' }, [label]),
      el('span', { class: 'usage-track' }, [el('span', { class: 'usage-fill', style: `width:${p}%` })]),
      el('span', { class: 'usage-pct' }, [`${p}%`]),
    ])
  }
  function accountLabel(a) { return a.account === 'default' ? a.agent : `${a.agent}/${a.account}` }

  function renderAccounts(accounts) {
    const box = document.getElementById('accounts')
    box.textContent = ''
    for (const a of accounts) {
      const walled = a.limited_until && a.limited_until * 1000 > Date.now()
      const pill = el('div', { class: `account-pill adapter-${a.agent}${walled ? ' walled' : ''}`, title: a.source ? `source: ${a.source}${a.updated_at ? `, updated ${ago(Date.now() - Date.parse(a.updated_at))} ago` : ''}` : 'no usage seen yet' }, [
        el('span', { class: 'account-name' }, [accountLabel(a), a.live ? el('span', { class: 'live-dot', title: `${a.live} live session${a.live === 1 ? '' : 's'}` }) : null]),
        walled ? el('span', { class: 'chip status-chip bad' }, [`limit · back ${until(a.limited_until)}`]) : null,
        !walled && a.agent === 'agy' && !a.five_hour ? el('span', { class: 'chip status-chip muted', title: 'agy exposes no usage percentage; Baton sees the wall when agy hits it' }, ['no % from agy']) : null,
        !walled && (a.five_hour || a.seven_day || a.agent !== 'agy') ? bar('5h', a.five_hour) : null,
        !walled && (a.five_hour || a.seven_day || a.agent !== 'agy') ? bar('7d', a.seven_day) : null,
      ])
      box.appendChild(pill)
    }
  }

  const tail = (id) => String(id).split('-').slice(-2).join('-')

  async function act(id, action, btn) {
    btn.disabled = true
    try {
      if (action === 'remove') {
        const r = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        toast(r.worktree ? (r.worktree.removed ? 'removed, with its worktree and branch' : `removed; worktree kept: ${r.worktree.reason}`) : 'removed')
      } else {
        await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        toast(action === 'handoff' ? 'hand-off requested; the terminal switches agents in a few seconds' : action === 'land' ? 'landing: rebase, tests, fast-forward; the card shows the result' : 'end requested')
      }
      refresh()
    } catch (err) { toast(err.message); btn.disabled = false }
  }

  // The card's land line: in progress, landed, nothing to land, bounced with the reason.
  function landLine(s) {
    const L = s.land
    if (!L) return null
    const who = L.by && L.by !== 'local' ? ` · by ${L.by}` : ''
    if (L.state === 'landing') return el('div', { class: 'session-note warn' }, [`landing ${L.branch} onto ${L.base}: rebase, tests, fast-forward…`])
    if (L.state === 'landed') return el('div', { class: 'session-note ok', title: L.summary || '' }, [`✓ landed on ${L.base} · ${String(L.sha).slice(0, 7)} · ${L.files.length} file${L.files.length === 1 ? '' : 's'} +${L.insertions}/-${L.deletions}${L.tested ? '' : ' · untested'}${who}`])
    if (L.state === 'noop') return el('div', { class: 'session-note' }, [`nothing to land: ${L.branch} has no changes beyond ${L.base}`])
    if (L.state === 'interrupted') return el('div', { class: 'session-note bad' }, ['the landing was cut off (the board restarted); press Land again'])
    return el('div', { class: 'session-note bad', title: L.detail || '' }, [`✗ bounced (${L.reason}): ${String(L.detail || '').split('\n')[0].slice(0, 160)}${who}`])
  }

  function renderSession(s) {
    const [label, cls] = STATUS[s.status] || [s.status, 'muted']
    const card = el('article', { class: `session-card adapter-${s.agent} status-${s.status}${s.overlap.length ? ' overlapping' : ''}${s.active ? '' : ' inactive'}`, 'data-session-id': s.session_id })
    card.appendChild(el('div', { class: 'session-head' }, [
      el('span', { class: `pill adapter-${s.agent} state-active` }, [el('span', { class: 'pill-adapter' }, [s.agent]), s.account !== 'default' ? el('span', { class: 'pill-mode' }, [s.account]) : null]),
      el('span', { class: `chip status-chip ${cls}` }, [label]),
      s.lineage && s.lineage.from ? el('span', { class: 'chip status-chip muted', title: 'this terminal started with another agent' }, [`from ${s.lineage.from}`]) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'session-elapsed', title: `started ${new Date(s.started_at).toLocaleString()}` }, [ago(s.elapsed_ms)]),
    ]))
    card.appendChild(el('div', { class: 'session-task', title: s.task || '' }, [s.task ? (s.task.length > 140 ? s.task.slice(0, 140) + '…' : s.task) : el('span', { class: 'muted' }, ['no prompt yet'])]))
    card.appendChild(el('div', { class: 'session-meta' }, [
      el('span', { class: 'mono', title: s.cwd }, [s.repo_name || s.cwd, s.branch ? `@${s.branch}` : '']),
      s.worktree ? el('span', { class: 'chip worktree-chip', title: `another session was live in the checkout, so this one works in ${s.worktree.path}, branch ${s.worktree.branch}, cut from ${s.worktree.base || 'a detached HEAD'}` }, [`own worktree · from ${s.worktree.base || 'HEAD'}`]) : null,
      el('span', {}, [`${s.turns || 0} turn${s.turns === 1 ? '' : 's'}`]),
      s.head ? el('span', { class: 'mono', title: 'HEAD' }, [String(s.head).slice(0, 7)]) : null,
    ]))
    if (s.limits) card.appendChild(el('div', { class: 'session-usage' }, [bar('5h', s.limits.five_hour), bar('7d', s.limits.seven_day)]))
    if (s.warning) card.appendChild(el('div', { class: 'session-note warn' }, [`⚠ ${s.warning.window} window at ${Math.round(s.warning.pct)}% · next: ${s.chain && s.chain[0] ? s.chain[0].agent : 'none'}`]))
    if (s.limit) card.appendChild(el('div', { class: 'session-note bad', title: s.limit.detail || '' }, [`limit: ${s.limit.reason}${s.limit.resets_at ? ` · resets ${until(s.limit.resets_at)}` : ''}`]))
    if (s.handoff && s.handoff.to) card.appendChild(el('div', { class: 'session-note' }, [`${s.handoff.from ? s.handoff.from.agent : '?'} → ${s.handoff.to.agent}${s.handoff.to.account !== 'default' ? '/' + s.handoff.to.account : ''} (${s.handoff.reason})${s.bundle ? ` · bundle ${s.bundle.id}` : ''}`]))
    if (s.status === 'waiting' && s.waiting) card.appendChild(el('div', { class: 'session-note warn', title: 'every option is out; the terminal counts down and starts this agent from the bundle at the reset' }, [`⏳ waiting for ${s.waiting.agent}${s.waiting.account && s.waiting.account !== 'default' ? '/' + s.waiting.account : ''} at ${until(s.waiting.resets_at)}`]))
    else if (s.all_out && s.all_out.length) card.appendChild(el('div', { class: 'session-note bad' }, [`every option is out · first back: ${s.all_out[0].agent} ${until(s.all_out[0].resets_at)}`]))
    if (s.files.length) {
      const wrap = el('div', { class: 'session-files' })
      const overlapFiles = new Set(s.overlap.flatMap((o) => o.files))
      for (const f of s.files.slice(0, 8)) wrap.appendChild(el('span', { class: `chip file-chip${overlapFiles.has(f) ? ' bad' : ''}`, title: f }, [f.split('/').pop()]))
      if (s.files.length > 8) wrap.appendChild(el('span', { class: 'chip muted' }, [`+${s.files.length - 8}`]))
      card.appendChild(wrap)
    }
    for (const o of s.overlap) {
      const files = `${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? ` +${o.files.length - 3}` : ''}`
      card.appendChild(el('div', { class: 'session-note bad' }, [o.separate ? `⚠ ${o.agent} (${tail(o.session_id)}) is changing ${files} in another checkout; whoever lands second rebases` : `⚠ ${o.agent} (${tail(o.session_id)}) is editing ${files} too`]))
    }
    const landNote = landLine(s)
    if (landNote) card.appendChild(landNote)
    const actions = el('div', { class: 'card-actions' })
    if (s.worktree) {
      const l = el('button', { type: 'button', disabled: s.land_blocker ? '' : null, title: s.land_blocker || `commit this terminal's work on ${s.worktree.branch}, rebase it onto ${s.worktree.base}, run the tests, fast-forward ${s.worktree.base}; a bounce says why` }, ['Land'])
      l.addEventListener('click', () => act(s.session_id, 'land', l))
      actions.appendChild(l)
    }
    if (s.active) {
      const h = el('button', { type: 'button', title: 'save the bundle, stop this agent, start the next option in the same terminal' }, ['Hand off now'])
      h.addEventListener('click', () => act(s.session_id, 'handoff', h))
      const e = el('button', { type: 'button', class: 'danger' }, ['End'])
      e.addEventListener('click', () => act(s.session_id, 'end', e))
      actions.append(h, e)
    } else {
      const r = el('button', { type: 'button' }, ['Remove'])
      r.addEventListener('click', () => act(s.session_id, 'remove', r))
      actions.appendChild(r)
    }
    card.appendChild(actions)
    return card
  }

  function renderSessions(v) {
    const grid = document.getElementById('session-grid')
    grid.textContent = ''
    const list = [...v.sessions].sort((a, b) => (a.active === b.active ? (a.started_at < b.started_at ? 1 : -1) : a.active ? -1 : 1))
    if (!list.length) {
      grid.appendChild(el('div', { class: 'session-empty' }, ['No terminals yet. In any repo: ', el('code', {}, ['baton claude']), ' — the normal Claude Code, with this board alongside and a hand-off to codex or agy when it hits its limit.']))
      return
    }
    for (const s of list) grid.appendChild(renderSession(s))
  }

  function renderTrunk(v) {
    const box = document.getElementById('trunk')
    box.textContent = ''
    for (const t of v.trunk || []) {
      if (!t.branch) continue
      const list = el('ul', { class: 'trunk-list' })
      for (const c of t.commits) {
        const lb = c.landed_by
        const by = lb && lb.by && lb.by !== 'local' ? ` for ${lb.by}` : ''
        list.appendChild(el('li', {}, [el('span', { class: 'mono' }, [c.sha]), ' ', c.subject, ' ', lb
          ? el('span', { class: 'landed-by', title: `Land on the card of ${lb.agent} session ${lb.session_id}${by}, ${new Date(lb.at).toLocaleString()}` }, [`· ${c.when} · landed by ${lb.agent} (${tail(lb.session_id)})${by}`])
          : el('span', { class: 'muted' }, [`· ${c.when} · ${c.author}`])]))
      }
      box.appendChild(el('div', { class: 'trunk-repo' }, [el('h3', {}, [`landed on ${t.branch} · ${t.repo_name}`]), list]))
    }
  }

  function render(v) {
    view = v
    renderAccounts(v.accounts || [])
    renderSessions(v)
    renderTrunk(v)
  }
  async function refresh() {
    try { render(await api('/api/sessions')) } catch (err) { toast(err.message) }
  }
  window.addEventListener('baton:sessions', (e) => render(e.detail))
  document.addEventListener('DOMContentLoaded', () => {
    refresh()
    setInterval(() => { if (view) renderSessions(view) }, 15000)
  })
})()
