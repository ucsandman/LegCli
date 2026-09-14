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
  const sessionEditors = new Map()
  const defaultEditor = { order: null, dirty: false, saving: false, status: '', statusClass: '' }
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
      el('span', { class: 'usage-pct' }, [`${p}% used`]),
    ])
  }
  function accountLabel(a) { return a.account === 'default' ? a.agent : `${a.agent}/${a.account}` }
  function optionLabel(a) { return a ? (a.account && a.account !== 'default' ? `${a.agent}/${a.account}` : a.agent) : 'none' }

  function moveOrder(order, index, delta) {
    const target = index + delta
    if (target < 0 || target >= order.length) return [...order]
    const next = [...order]
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  }

  function orderRows(order, onMove, scope) {
    const box = el('div', { class: 'order-list' })
    order.forEach((agent, index) => {
      const attrs = (direction) => ({ 'data-order-scope': scope, 'data-order-agent': agent, 'data-order-direction': direction })
      const up = el('button', { type: 'button', 'aria-label': `Move ${agent} earlier`, disabled: index === 0 ? '' : null, ...attrs('up') }, ['↑'])
      const down = el('button', { type: 'button', 'aria-label': `Move ${agent} later`, disabled: index === order.length - 1 ? '' : null, ...attrs('down') }, ['↓'])
      up.addEventListener('click', () => onMove(index, -1))
      down.addEventListener('click', () => onMove(index, 1))
      box.appendChild(el('div', { class: 'order-row' }, [el('span', { class: 'order-row-name' }, [`${index + 1}. ${agent}`]), up, down]))
    })
    return box
  }

  function focusedOrderControl() {
    const node = document.activeElement
    if (!node?.dataset?.orderScope) return null
    return { scope: node.dataset.orderScope, agent: node.dataset.orderAgent, direction: node.dataset.orderDirection }
  }

  function restoreOrderFocus(focus) {
    if (!focus) return
    let target = document.querySelector(`[data-order-scope="${focus.scope}"][data-order-agent="${focus.agent}"][data-order-direction="${focus.direction}"]`)
    if (target?.disabled) target = document.querySelector(`[data-order-scope="${focus.scope}"][data-order-agent="${focus.agent}"]:not([disabled])`)
    target?.focus()
  }

  // Absolute priority, not a rotation: the saved list decides, minus the agent
  // already running here, so an agent placed last stays last.
  function agentsAfter(current, order) {
    return order.filter((agent) => agent !== current)
  }

  function renderDefaultOrder(v) {
    const field = document.getElementById('default-order')
    if (!field) return
    field.hidden = !v.preferences
    if (!v.preferences) return
    if (!defaultEditor.order || (!defaultEditor.dirty && !defaultEditor.saving)) defaultEditor.order = [...v.preferences.handoff_order]
    const list = document.getElementById('default-order-list')
    const focus = focusedOrderControl()
    list.textContent = ''
    list.appendChild(orderRows(defaultEditor.order, (index, delta) => {
      defaultEditor.order = moveOrder(defaultEditor.order, index, delta)
      defaultEditor.dirty = true
      defaultEditor.status = ''
      renderDefaultOrder(view)
    }, 'default'))
    const save = document.getElementById('default-order-save')
    save.disabled = defaultEditor.saving || !defaultEditor.dirty
    save.textContent = defaultEditor.saving ? 'Saving…' : 'Save default'
    const status = document.getElementById('default-order-status')
    status.textContent = defaultEditor.status
    status.className = `field-status ${defaultEditor.statusClass}`
    restoreOrderFocus(focus)
  }

  async function saveDefaultOrder() {
    defaultEditor.saving = true
    defaultEditor.status = ''
    renderDefaultOrder(view)
    try {
      const data = await api('/api/settings', { method: 'PATCH', body: { handoff_order: defaultEditor.order } })
      if (view) view.preferences = data.preferences
      defaultEditor.order = [...data.preferences.handoff_order]
      defaultEditor.dirty = false
      defaultEditor.status = 'Saved for new terminals.'
      defaultEditor.statusClass = 'ok'
    } catch (err) {
      defaultEditor.status = err.message
      defaultEditor.statusClass = 'bad'
    } finally {
      defaultEditor.saving = false
      renderDefaultOrder(view)
    }
  }

  function renderAccounts(accounts) {
    const box = document.getElementById('accounts')
    box.textContent = ''
    for (const a of accounts) {
      const walled = a.limited_until && a.limited_until * 1000 > Date.now()
      const pill = el('div', { class: `account-pill adapter-${a.agent}${walled ? ' walled' : ''}`, title: a.source ? `source: ${a.source}${a.updated_at ? `, updated ${ago(Date.now() - Date.parse(a.updated_at))} ago` : ''}` : 'no usage seen yet' }, [
        el('span', { class: 'account-name' }, [accountLabel(a), a.live ? el('span', { class: 'live-dot', title: `${a.live} live session${a.live === 1 ? '' : 's'}` }) : null]),
        a.stale && a.agent !== 'agy' ? el('span', { class: 'chip status-chip muted', title: 'the last quota check is over five minutes old' }, ['usage stale']) : null,
        walled ? el('span', { class: 'chip status-chip bad' }, [`limit · back ${until(a.limited_until)}`]) : null,
        !walled && a.agent === 'agy' && !a.five_hour ? el('span', { class: 'chip status-chip muted', title: 'agy exposes no usage percentage; Baton sees the wall when agy hits it' }, ['no % from agy']) : null,
        !walled && (a.five_hour || a.seven_day || a.agent !== 'agy') ? bar('5h', a.five_hour) : null,
        !walled && (a.five_hour || a.seven_day || a.agent !== 'agy') ? bar('7d', a.seven_day) : null,
      ])
      box.appendChild(pill)
    }
  }

  const tail = (id) => String(id).split('-').slice(-2).join('-')
  const shared = () => Boolean(view && view.share && view.share.on)
  const isMine = (s) => Boolean(view && view.you && s.owner && view.you.name === s.owner)

  async function act(id, action, btn) {
    btn.disabled = true
    try {
      if (action.startsWith('requests/')) {
        await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        toast(action.endsWith('approve') ? 'approved; the terminal hands off in a few seconds' : 'dismissed')
      } else if (action === 'request-handoff') {
        await api(`/api/sessions/${encodeURIComponent(id)}/request-handoff`, { method: 'POST' })
        toast('asked; the owner of that terminal decides')
      } else if (action === 'remove') {
        const r = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        toast(r.worktree ? (r.worktree.removed ? (r.worktree.branchDeleted === false ? 'removed worktree; branch kept' : 'removed, with its worktree and branch') : `removed; worktree kept: ${r.worktree.reason}`) : 'removed')
      } else if (action === 'remove-record') {
        await api(`/api/sessions/${encodeURIComponent(id)}?force=1&keep_worktree=1`, { method: 'DELETE' })
        toast('record removed; worktree and branch kept')
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
    if (L.state === 'landed') {
      // another human's card carries the state and the sha, never the file list
      const n = L.files ? L.files.length : null
      const counts = n === null ? '' : ` · ${n} file${n === 1 ? '' : 's'} +${L.insertions || 0}/-${L.deletions || 0}${L.tested ? '' : ' · untested'}`
      return el('div', { class: 'session-note ok', title: L.summary || '' }, [`✓ landed on ${L.base} · ${String(L.sha).slice(0, 7)}${counts}${who}`])
    }
    if (L.state === 'noop') return el('div', { class: 'session-note' }, [`nothing to land: ${L.branch} has no changes beyond ${L.base}`])
    if (L.state === 'interrupted') return el('div', { class: 'session-note bad' }, ['the landing was cut off (the board restarted); press Land again'])
    return el('div', { class: 'session-note bad', title: L.detail || '' }, [`✗ bounced (${L.reason}): ${String(L.detail || '').split('\n')[0].slice(0, 160)}${who}`])
  }

  function renderHandoffOrder(s) {
    const wrap = el('div', { class: 'session-handoff' })
    const sequence = el('div', { class: 'handoff-sequence', 'aria-label': 'Terminal handoff sequence' }, [
      el('span', { class: 'chip now' }, [`Now: ${optionLabel(s)}`]),
    ])
    for (const next of s.chain || []) sequence.append(el('span', { class: 'handoff-arrow', 'aria-hidden': 'true' }, ['→']), el('span', { class: `chip adapter-${next.agent}` }, [optionLabel(next)]))
    wrap.appendChild(sequence)
    const preferred = optionLabel(s.preferred_next)
    const eligible = optionLabel(s.eligible_next)
    if (!s.handoff_availability_known) wrap.appendChild(el('div', { class: 'session-note' }, [`Preferred: ${preferred} · current eligibility is unavailable for this older terminal.`]))
    else if (!s.eligible_next) wrap.appendChild(el('div', { class: 'session-note warn' }, [`Preferred: ${preferred}. No fallback is eligible now; Baton waits if every account is at its limit.`]))
    else if (eligible !== preferred) wrap.appendChild(el('div', { class: 'session-note' }, [`Preferred: ${preferred} · first eligible now: ${eligible}`]))
    else wrap.appendChild(el('div', { class: 'session-note' }, [`First eligible now: ${eligible}`]))
    wrap.appendChild(el('div', { class: 'session-note' }, ['Used after a usage limit or Hand off now. A normal exit ends this terminal.']))

    const editableNow = ['starting', 'running', 'warning', 'limit', 'waiting'].includes(s.status)
    if (!s.hidden && editableNow) {
      let state = sessionEditors.get(s.session_id)
      const sourceOrder = s.can_edit_handoff_order ? s.handoff_order : (view?.preferences?.handoff_order ?? s.handoff_order)
      if (!state) {
        state = { open: false, order: [...sourceOrder], dirty: false, saving: false, status: '', statusClass: '' }
        sessionEditors.set(s.session_id, state)
      } else if (!state.dirty && !state.saving) state.order = [...sourceOrder]
      const change = el('button', { type: 'button', 'aria-expanded': state.open ? 'true' : 'false' }, [state.open ? 'Close order editor' : 'Change order'])
      change.addEventListener('click', () => { state.open = !state.open; renderSessions(view) })
      wrap.appendChild(change)
      if (state.open) {
        const editor = el('div', { class: 'handoff-editor' })
        editor.appendChild(el('div', { class: 'session-note' }, [s.can_edit_handoff_order
          ? 'Move agents to set the priority for this terminal. All three stay available; the agent running now is skipped, and the rest keep this order.'
          : 'This terminal started before order changes were available. Save this order for the next terminal, then restart when ready.']))
        editor.appendChild(orderRows(state.order, (index, delta) => {
          state.order = moveOrder(state.order, index, delta)
          state.dirty = true
          state.status = ''
          renderSessions(view)
        }, s.session_id))
        editor.appendChild(el('div', { class: 'session-note' }, [`Draft priority after ${s.agent}: ${agentsAfter(s.agent, state.order).join(' → ')}`]))
        const status = el('span', { class: `field-status ${state.statusClass}`, 'aria-live': 'polite' }, [state.status])
        const save = el('button', { type: 'button', disabled: state.saving || !state.dirty ? '' : null }, [state.saving ? 'Saving…' : s.can_edit_handoff_order ? 'Save for this terminal' : 'Save as default for next launch'])
        save.addEventListener('click', async () => {
          state.saving = true; state.status = ''; renderSessions(view)
          try {
            if (s.can_edit_handoff_order) {
              await api(`/api/sessions/${encodeURIComponent(s.session_id)}/handoff-order`, { method: 'POST', body: { handoff_order: state.order } })
              state.status = 'Saved for this terminal.'
            } else {
              const data = await api('/api/settings', { method: 'PATCH', body: { handoff_order: state.order } })
              if (view) view.preferences = data.preferences
              defaultEditor.order = [...data.preferences.handoff_order]
              defaultEditor.dirty = false
              state.status = 'Saved as the default. Restart this terminal when ready.'
            }
            state.dirty = false
            state.statusClass = 'ok'
            await refresh()
          } catch (err) {
            state.status = err.message
            state.statusClass = 'bad'
          } finally {
            state.saving = false
            renderSessions(view)
          }
        })
        editor.append(status, save)
        wrap.appendChild(editor)
      }
    }
    return wrap
  }

  function renderSession(s) {
    const [label, cls] = STATUS[s.status] || [s.status, 'muted']
    const card = el('article', { class: `session-card adapter-${s.agent} status-${s.status}${s.overlap.length ? ' overlapping' : ''}${s.active ? '' : ' inactive'}${s.hidden ? ' hidden-card' : ''}`, 'data-session-id': s.session_id })
    card.appendChild(el('div', { class: 'session-head' }, [
      el('span', { class: `pill adapter-${s.agent} state-active` }, [el('span', { class: 'pill-adapter' }, [s.agent]), s.account !== 'default' ? el('span', { class: 'pill-mode' }, [s.account]) : null]),
      el('span', { class: `chip status-chip ${cls}` }, [label]),
      shared() && s.owner ? el('span', { class: `chip owner-chip${isMine(s) ? ' mine' : ''}`, title: `${s.owner} started this terminal${isMine(s) ? ' (you)' : ''}` }, [s.owner]) : null,
      s.lineage && s.lineage.from ? el('span', { class: 'chip status-chip muted', title: 'this terminal started with another agent' }, [`from ${s.lineage.from}`]) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'session-elapsed', title: `started ${new Date(s.started_at).toLocaleString()}` }, [ago(s.elapsed_ms)]),
    ]))
    const task = el('div', { class: `session-task${s.hidden ? '' : ' openable'}`, title: s.hidden ? '' : `${s.task || ''}\n\nClick for what this terminal is doing` }, [
      s.hidden ? el('span', { class: 'muted' }, ['prompt hidden']) : (s.task ? (s.task.length > 140 ? s.task.slice(0, 140) + '…' : s.task) : el('span', { class: 'muted' }, ['no prompt yet'])),
    ])
    // the whole prompt block opens the drawer: the card is the thing you look at
    if (!s.hidden) {
      task.setAttribute('role', 'button')
      task.setAttribute('tabindex', '0')
      task.addEventListener('click', () => openSessionDrawer(s.session_id))
      task.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSessionDrawer(s.session_id) } })
    }
    card.appendChild(task)
    card.appendChild(el('div', { class: 'session-meta' }, [
      el('span', { class: 'mono', title: s.cwd }, [s.repo_name || s.cwd, s.branch ? `@${s.branch}` : '']),
      s.worktree ? el('span', { class: 'chip worktree-chip', title: `another session was live in the checkout, so this one works in ${s.worktree.path}, branch ${s.worktree.branch}, cut from ${s.worktree.base || 'a detached HEAD'}` }, [`own worktree · from ${s.worktree.base || 'HEAD'}`]) : null,
      el('span', {}, [`${s.turns || 0} turn${s.turns === 1 ? '' : 's'}`]),
      s.head ? el('span', { class: 'mono', title: 'HEAD' }, [String(s.head).slice(0, 7)]) : null,
    ]))
    if (!s.hidden) card.appendChild(renderHandoffOrder(s))
    if (s.limits && (s.limits.five_hour || s.limits.seven_day)) card.appendChild(el('div', { class: 'session-usage' }, [bar('5h', s.limits.five_hour), bar('7d', s.limits.seven_day)]))
    else if (s.usage_error) card.appendChild(el('div', { class: 'session-note', title: s.usage_error }, [`usage unknown (${String(s.usage_error).slice(0, 60)}) · the limit still hands off`]))
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
    for (const r of s.requests || []) card.appendChild(el('div', { class: 'session-note warn' }, [`${r.by} asked for a hand-off ${ago(Date.now() - Date.parse(r.at))} ago`]))
    const actions = el('div', { class: 'card-actions' })
    // someone else's terminal: nothing to press but a request the owner approves
    if (s.hidden) {
      card.appendChild(el('div', { class: 'session-note' }, [`read-only: ${s.owner || 'another human'} owns this terminal`]))
      if (s.active) {
        const q = el('button', { type: 'button', title: `ask ${s.owner || 'the owner'} to hand this terminal off; they approve it on their own board` }, ['Request handoff'])
        q.addEventListener('click', () => act(s.session_id, 'request-handoff', q))
        actions.appendChild(q)
      }
      card.appendChild(actions)
      return card
    }
    for (const r of s.requests || []) {
      const ok = el('button', { type: 'button', title: `hand this terminal off for ${r.by}` }, [`Approve ${r.by}`])
      ok.addEventListener('click', () => act(s.session_id, `requests/${encodeURIComponent(r.by)}/approve`, ok))
      const no = el('button', { type: 'button', class: 'danger' }, ['Dismiss'])
      no.addEventListener('click', () => act(s.session_id, `requests/${encodeURIComponent(r.by)}/dismiss`, no))
      actions.append(ok, no)
    }
    const details = el('button', { type: 'button', title: 'what this terminal is doing: its last turns, the files it changed, and what happens next' }, ['Details'])
    details.addEventListener('click', () => openSessionDrawer(s.session_id))
    actions.appendChild(details)
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
      if (s.worktree) {
        const keep = el('button', { type: 'button', class: 'danger', title: 'remove only Baton\'s saved terminal record; keep this worktree and branch' }, ['Remove record'])
        keep.addEventListener('click', () => {
          const message = `Remove only the Baton record for ${s.session_id}?\n\nKeep worktree: ${s.worktree.path}\nKeep branch: ${s.worktree.branch}\n\nNo worktree files, commits, or branch will be deleted.`
          if (confirm(message)) act(s.session_id, 'remove-record', keep)
        })
        actions.appendChild(keep)
      }
    }
    card.appendChild(actions)
    return card
  }

  // ---- drawer: what this terminal is doing ----
  // The messages, the diffs and the timeline are one extra fetch per open
  // terminal, so nothing here is requested until the drawer is open, and the
  // poll stops when it is paused or the tab is in the background.
  const drawer = { id: null, paused: false, timer: null, detail: null, error: '', expanded: new Set(), diffs: new Map() }

  function drawerSession() { return view && view.sessions ? view.sessions.find((s) => s.session_id === drawer.id) : null }

  function openSessionDrawer(id) {
    drawer.id = id
    drawer.detail = null
    drawer.error = ''
    drawer.paused = false
    drawer.expanded.clear()
    drawer.diffs.clear()
    document.getElementById('session-drawer').hidden = false
    renderDrawer()
    loadDrawer()
    if (drawer.timer) clearInterval(drawer.timer)
    drawer.timer = setInterval(() => { if (!drawer.paused && !document.hidden) loadDrawer() }, 3000)
    document.getElementById('session-drawer-close').focus()
  }

  function closeSessionDrawer() {
    if (drawer.timer) clearInterval(drawer.timer)
    drawer.timer = null
    const id = drawer.id
    drawer.id = null
    document.getElementById('session-drawer').hidden = true
    const back = id ? document.querySelector(`[data-session-id="${id.replace(/"/g, '\\"')}"] .session-task`) : null
    if (back) back.focus()
  }

  async function loadDrawer() {
    if (!drawer.id) return
    const id = drawer.id
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}/detail`)
      if (drawer.id !== id) return // the drawer moved on while this was in flight
      drawer.detail = data
      drawer.error = ''
    } catch (err) {
      if (drawer.id !== id) return
      drawer.error = err.message
    }
    renderDrawer()
  }

  function whenAgo(ts) {
    const t = Date.parse(ts)
    return Number.isFinite(t) ? `${ago(Date.now() - t)} ago` : ''
  }

  function paintDiff(pre, d) {
    pre.textContent = ''
    const body = String(d.diff || '')
    // an empty diff has three quite different meanings; say which one this is
    if (!body.trim()) {
      pre.appendChild(el('span', { class: 'hunk' }, [
        d.state === 'committed' ? 'no changes against HEAD: this file is already committed'
          : d.state === 'gone' ? 'this path is not in the working tree any more'
            : 'nothing to show for this path',
      ]))
      return
    }
    for (const line of body.split('\n')) {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'del'
          : line.startsWith('@@') ? 'hunk' : ''
      pre.appendChild(el('span', { class: cls || null }, [line + '\n']))
    }
    if (d.truncated) pre.appendChild(el('span', { class: 'hunk' }, [`… cut off at ${d.diff.split('\n').length} lines`]))
  }

  async function showDiff(path, pre) {
    if (!drawer.diffs.has(path)) {
      pre.textContent = 'loading…'
      try {
        drawer.diffs.set(path, await api(`/api/sessions/${encodeURIComponent(drawer.id)}/diff?file=${encodeURIComponent(path)}`))
      } catch (err) {
        drawer.diffs.set(path, { diff: err.message, truncated: false })
      }
    }
    paintDiff(pre, drawer.diffs.get(path))
  }

  function messageRow(m) {
    const row = el('div', { class: `drawer-msg ${m.role}` }, [
      el('span', { class: 'drawer-msg-role' }, [m.role === 'user' ? 'human' : 'agent']),
      m.ts ? el('span', { class: 'drawer-msg-when' }, [whenAgo(m.ts)]) : null,
      el('p', {}, [m.text]),
    ])
    return row
  }

  function fileRow(f) {
    const wrap = el('div', { class: 'drawer-file' })
    const pre = el('pre', { class: 'drawer-diff', hidden: '' })
    const caret = el('span', { class: 'drawer-caret' }, ['▸'])
    const row = el('button', { type: 'button', class: 'drawer-file-row', 'aria-expanded': 'false' }, [
      caret,
      el('span', { class: 'mono drawer-file-path', title: f.path }, [f.path]),
      f.dirty ? el('span', { class: 'chip warn drawer-dirty' }, ['uncommitted']) : null,
      el('span', { class: 'spacer' }),
      Number.isFinite(f.adds) ? el('span', { class: 'drawer-adds' }, [`+${f.adds}`]) : null,
      Number.isFinite(f.dels) ? el('span', { class: 'drawer-dels' }, [`−${f.dels}`]) : null,
      // no counts against HEAD: the agent created it, or it is already committed
      Number.isFinite(f.adds) ? null : el('span', { class: 'chip muted drawer-state' }, [f.state === 'new' ? 'new' : f.state === 'committed' ? 'committed' : String(f.state || '')]),
    ])
    const toggle = () => {
      const opening = pre.hidden
      pre.hidden = !opening
      caret.textContent = opening ? '▾' : '▸'
      row.setAttribute('aria-expanded', opening ? 'true' : 'false')
      if (opening) { drawer.expanded.add(f.path); showDiff(f.path, pre) } else drawer.expanded.delete(f.path)
    }
    row.addEventListener('click', toggle)
    if (drawer.expanded.has(f.path)) { pre.hidden = false; caret.textContent = '▾'; row.setAttribute('aria-expanded', 'true'); showDiff(f.path, pre) }
    wrap.append(row, pre)
    return wrap
  }

  function section(title, note, body) {
    const s = el('section', { class: 'drawer-section' }, [
      el('h3', {}, [title, note ? el('span', { class: 'drawer-sub' }, [note]) : null]),
    ])
    s.appendChild(body)
    return s
  }

  function renderDrawer() {
    const box = document.getElementById('session-drawer-content')
    if (!box) return
    const panel = document.getElementById('session-drawer')
    const scroll = panel.scrollTop
    const s = drawerSession()
    const d = drawer.detail
    box.textContent = ''
    if (!s) {
      box.appendChild(el('p', { class: 'session-note' }, ['This terminal is no longer on the board.']))
      return
    }
    const [label] = STATUS[s.status] || [s.status]
    box.appendChild(el('div', { class: 'drawer-top' }, [
      el('span', { class: `pill adapter-${s.agent} state-active` }, [el('span', { class: 'pill-adapter' }, [s.agent])]),
      el('span', { class: 'mono drawer-where', title: s.cwd }, [`${s.repo_name || s.cwd}${s.branch ? '@' + s.branch : ''}`]),
      el('span', { class: 'spacer' }),
      (() => {
        const p = el('button', { type: 'button', id: 'session-drawer-pause', title: 'stop refreshing this panel' }, [drawer.paused ? 'Resume' : 'Pause'])
        p.addEventListener('click', () => { drawer.paused = !drawer.paused; if (!drawer.paused) loadDrawer(); else renderDrawer() })
        return p
      })(),
      (() => {
        const c = el('button', { type: 'button', id: 'session-drawer-close' }, ['Close'])
        c.addEventListener('click', closeSessionDrawer)
        return c
      })(),
    ]))
    if (drawer.error) box.appendChild(el('div', { class: 'session-note bad' }, [drawer.error]))

    const last = d && d.messages ? [...d.messages].reverse().find((m) => m.role === 'assistant') : null
    const now = el('div', { class: 'drawer-now' }, [
      el('div', { class: 'drawer-now-line' }, [
        `${label} · ${s.turns || 0} turn${s.turns === 1 ? '' : 's'}`,
        s.last_activity ? ` · last activity ${whenAgo(s.last_activity)}` : '',
      ]),
      last ? el('p', { class: 'drawer-said' }, [last.text]) : el('p', { class: 'drawer-said muted' }, [d ? 'nothing said yet' : 'loading…']),
    ])
    box.appendChild(section('Now', drawer.paused ? 'paused' : `live · every 3s${d ? ` · read ${whenAgo(d.ts)}` : ''}`, now))

    box.appendChild(section('Task', 'the prompt this terminal started from',
      el('p', { class: 'drawer-task' }, [s.task || 'no prompt yet'])))

    const msgs = el('div', { class: 'drawer-msgs' })
    if (d && d.messages && d.messages.length) for (const m of d.messages) msgs.appendChild(messageRow(m))
    else msgs.appendChild(el('p', { class: 'session-note' }, [d ? 'no transcript for this agent' : 'loading…']))
    box.appendChild(section('Conversation', `last ${d && d.messages ? d.messages.length : 0} turns`, msgs))

    const files = el('div', { class: 'drawer-files' })
    const list = (d && d.files) || []
    if (list.length) for (const f of list) files.appendChild(fileRow(f))
    else files.appendChild(el('p', { class: 'session-note' }, [d ? 'no files changed yet' : 'loading…']))
    box.appendChild(section('Files', list.length ? `${list.length} · click one for its diff` : '', files))

    const timeline = el('div', { class: 'drawer-timeline' })
    const events = (d && d.events) || []
    for (const e of events.slice(-40)) {
      timeline.appendChild(el('div', { class: 'drawer-event' }, [
        el('span', { class: 'mono drawer-event-ts' }, [String(e.ts).slice(11, 19)]),
        el('span', { class: `drawer-event-type ${e.type}` }, [e.type]),
        el('span', {}, [e.summary || '']),
      ]))
    }
    if (!events.length) timeline.appendChild(el('p', { class: 'session-note' }, [d ? 'nothing recorded yet' : 'loading…']))
    box.appendChild(section('Timeline', 'this terminal, newest last', timeline))

    const next = el('div', {}, [renderHandoffOrder(s)])
    if (s.bundle) next.appendChild(el('div', { class: 'session-note' }, [`bundle ${s.bundle.id}${s.bundle.at ? ` · saved ${whenAgo(s.bundle.at)}` : ''}`]))
    box.appendChild(section('What happens next', '', next))
    panel.scrollTop = scroll
  }

  function renderSessions(v) {
    const focus = focusedOrderControl()
    const grid = document.getElementById('session-grid')
    grid.textContent = ''
    const list = [...v.sessions].sort((a, b) => (a.active === b.active ? (a.started_at < b.started_at ? 1 : -1) : a.active ? -1 : 1))
    if (!list.length) {
      grid.appendChild(el('div', { class: 'session-empty' }, ['No terminals yet. In any repo: ', el('code', {}, ['baton claude']), ' — the normal Claude Code, with this board alongside and a hand-off to codex or agy when it hits its limit.']))
      restoreOrderFocus(focus)
      return
    }
    for (const s of list) grid.appendChild(renderSession(s))
    restoreOrderFocus(focus)
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
    const who = document.getElementById('whoami')
    if (who) {
      who.hidden = !(v.share && v.share.on)
      who.textContent = v.share && v.share.on && v.you ? `you are ${v.you.name}${v.you.role === 'owner' ? '' : ' (guest)'} · ${v.share.people} on this board` : ''
    }
    renderAccounts(v.accounts || [])
    renderDefaultOrder(v)
    renderSessions(v)
    renderTrunk(v)
    // the card behind the drawer just changed: status, turns and what is next
    // live in the session view, so redraw the panel from it
    if (drawer.id) { if (drawerSession()) renderDrawer(); else closeSessionDrawer() }
  }
  async function refresh() {
    try { render(await api('/api/sessions')) } catch (err) { toast(err.message) }
  }
  window.addEventListener('baton:sessions', (e) => render(e.detail))
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.id) closeSessionDrawer() })
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('default-order-save')?.addEventListener('click', saveDefaultOrder)
    refresh()
    setInterval(() => { if (view) renderSessions(view) }, 15000)
  })
})()
