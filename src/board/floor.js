// Baton floor — the scheduler-eye view: what's running, waiting, queued, and
// which leases block whom. Polls /api/floor, /api/trunk and /api/sessions
// (for the instrument head's account rails) and refreshes on SSE.
(function () {
  'use strict'

  const WAIT_LABELS = { approve: 'Approve', resume: 'Resume', kill: 'Kill' }
  const WAIT_BTN_CLASS = { approve: 'btn btn-primary', resume: 'btn btn-secondary', kill: 'btn btn-danger' }

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
  const state = { es: null, retryMs: 1000, timers: [], stopped: false, sseRequest: 0, floorRequest: 0, trunkRequest: 0, headRequest: 0, lastReadingAt: null, bind: (typeof location !== 'undefined' && location.host) || '127.0.0.1:4747', pendingFloor: null }

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
  const IDS = ['claude', 'codex', 'agy', 'fake']
  const FIVE_HOUR_MS = 5 * 3600 * 1000
  let headOpen = false
  const narrowQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 619px)') : { matches: false }

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
  function until(epochS) { return Number.isFinite(epochS) ? clockAt(epochS * 1000) : 'unknown' }
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

  function accountLabel(a) { return a.label || (a.account === 'default' ? a.agent : `${a.agent}/${a.account}`) }
  function idOf(agent) { return IDS.includes(agent) ? agent : 'fake' }


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
  // 6.1.1: one element, one gradient, hard stops computed from the value, so the
  // bar shows the zones it has crossed and red is confined to the part past 85.
  function fillStops(pct) {
    return { s60: pct <= 60 ? 100 : (60 / pct) * 100, s85: pct <= 85 ? 100 : (85 / pct) * 100 }
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
        ? `agy publishes no usage percentage for the ${words} window. Baton sees the wall when agy hits it.`
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
  // R4, one printed word beside both numerals. Colour never carries this alone.
  function tierWord(a, w) {
    const state = acctState(a)
    if (state === 'notshared') return 'not shared'
    if (state === 'walled') return 'at the wall'
    if (state === 'loading') return 'reading'
    if (!w || !Number.isFinite(w.pct)) return 'no reading'
    // usage.mjs returns stale === true precisely when the observation time
    // cannot be parsed, so this branch is reached with no timestamp; say what is
    // true rather than printing `stale NaNd`
    if (state === 'stale') {
      const observed = Date.parse(a.observed_at || a.updated_at || '')
      return Number.isFinite(observed) ? `stale ${ago(Date.now() - observed)}` : 'no reading'
    }
    const pct = Math.round(w.pct)
    return pct >= 85 ? 'over 85' : pct >= 60 ? 'over 60' : 'under 60'
  }
  // 6.1.3, R3 line 1, under the 5h rail only. The rule, out loud: print nothing
  // rather than a wrong number. A straight line drawn across the first tenth of
  // a window describes the last turn, not the next four hours, so under 30
  // minutes of elapsed window this returns null and the caption is absent.
  function burnRate(a, w, now) {
    if (!w || !Number.isFinite(w.pct) || !Number.isFinite(w.resets_at)) return null
    const resetsMs = w.resets_at * 1000
    const elapsedMs = FIVE_HOUR_MS - (resetsMs - now)
    if (elapsedMs < 30 * 60 * 1000 || elapsedMs > FIVE_HOUR_MS) return null
    if (!(w.pct > 0)) return `at this rate the ${until(w.resets_at)} reset arrives first`
    const goneMs = now + ((100 - w.pct) / (w.pct / elapsedMs))
    if (!Number.isFinite(goneMs) || goneMs <= now) return null
    if (goneMs >= resetsMs) return `at this rate the ${until(w.resets_at)} reset arrives first`
    return `at this rate the 5h window is gone about ${clockAt(goneMs)}, ${Math.round((resetsMs - goneMs) / 60000)} min before the ${until(w.resets_at)} reset`
  }
  // 6.1.4, R3 line 2. The number is checkable because the line says where and
  // when Baton read it: source and observed_at ship in the payload today and
  // print nowhere on the board.
  function provenanceLine(a, now) {
    const observed = Date.parse(a.observed_at || a.updated_at || '')
    if (!Number.isFinite(observed)) return el('div', { class: 'prov' }, [`no reading yet from ${accountLabel(a)}`])
    const line = el('div', { class: 'prov' }, [`read ${clockAt(observed)}, ${a.source || 'source not recorded'}`])
    if (a.stale && a.agent !== 'agy') line.append(document.createTextNode(`, ${ago(now - observed)} ago, `), el('span', { class: 'prov is-stale' }, ['stale']))
    return line
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

  function rail(account, win, kind) {
    const state = windowState(account, win)
    const pct = state === 'reading' ? Math.max(0, Math.min(100, Math.round(win.pct))) : null
    // Print nothing rather than a wrong number. A walled account paints its
    // rails full (board.css .acct.is-walled .fill), which asserted a finished
    // window for one that was never read: the numeral said `no reading` and the
    // bar beside it said 100%. `is-none` on the rail itself is what suppresses
    // the fill and the 85 post now, per window, not per account.
    const stops = fillStops(pct === null ? 0 : pct)
    const track = el('span', { class: `track ${kind === '5h' ? 'h12' : 'h8'}`, style: `--pct:${pct === null ? 0 : pct}%` }, [
      pct === null ? null : el('span', { class: 'fill', style: `--s60:${stops.s60.toFixed(1)}%;--s85:${stops.s85.toFixed(1)}%` }),
      pct === null ? null : el('span', { class: 'post' }),
    ])
    const tone = pct === null ? 'is-none' : pct >= 85 ? 'is-danger' : pct >= 60 ? 'is-warn' : ''
    const num = el('span', { class: `num num-${kind} ${tone}`.trim() }, pct === null
      ? [state === 'notshared' ? 'not shared' : state === 'loading' ? 'reading' : 'no reading']
      : [String(pct), el('span', { class: 'pct' }, ['%'])])
    // G7: the numeral and the reset time are one continuous run and one fixation
    const reset = el('span', { class: 'reset' }, win && Number.isFinite(win.resets_at)
      ? [`resets ${until(win.resets_at)}`, el('span', { class: 'in' }, [`, in ${ago(win.resets_at * 1000 - Date.now())}`])]
      : [])
    const words = WIN_WORDS[kind] || kind
    const valueText = railValueText(account, win, kind)
    // 6.1.6: a meter with no value is not a meter. aria-valuenow is required by
    // role=meter, and an empty or absent one is announced as zero percent, which
    // is the fabricated reading the visible cell refuses to print. With no value
    // the rail drops the role and carries the same sentence as its name.
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
    return el('div', { class: `rail${pct === null ? ' is-none' : ''}`, ...semantics },
      [el('span', { class: 'win' }, [kind]), track, num, reset])
  }

  function railR3(a, now) {
    const state = acctState(a)
    if (state === 'notshared') return [el('div', { class: 'prov' }, ['usage is not shared with guests'])]
    if (state === 'loading') return [el('div', { class: 'prov' }, ['reading /api/sessions'])]
    const out = []
    if (!a.five_hour && !a.seven_day && a.agent === 'agy') out.push(el('div', { class: 'burn' }, ['agy publishes no usage percentage. Baton sees the wall when agy hits it.']))
    else { const caption = burnRate(a, a.five_hour, now); if (caption) out.push(el('div', { class: 'burn' }, [caption])) }
    out.push(provenanceLine(a, now))
    return out
  }

  function railR4(a) {
    const state = acctState(a)
    const word = tierWord(a, worstWindow(a))
    const tone = state === 'walled' ? 'is-walled'
      : state === 'notshared' || state === 'loading' || word === 'no reading' ? 'is-none'
        : word === 'over 85' ? 'is-danger'
          : word === 'over 60' || state === 'stale' ? 'is-warn' : ''
    const out = [el('div', { class: `tier ${tone}`.trim() }, [word])]
    if (state === 'walled') {
      out.push(el('div', { class: 'reset' }, [`back ${until(a.limited_until)}`]))
      out.push(el('div', { class: 'in' }, [`in ${ago(a.limited_until * 1000 - Date.now())}`]))
    }
    return out
  }

  function acctRow(a, closest) {
    const now = Date.now()
    const state = acctState(a)
    const nameCls = a.agent ? ` chip-id-${idOf(a.agent)}` : ''
    const marks = []
    if (a.live) marks.push(el('span', { class: 'chip' }, [`${a.live} live terminal${a.live === 1 ? '' : 's'}`]))
    if (closest) marks.push(el('span', { class: 'chip' }, ['closest to a wall']))
    return el('div', { class: `acct${state === 'ok' ? '' : ` is-${state}`}` }, [
      el('div', { class: 'r1' }, [
        el('span', { class: `acct-name${nameCls}` }, [accountLabel(a)]),
        marks.length ? el('div', {}, marks) : null,
      ]),
      el('div', { class: 'r2' }, [rail(a, a.five_hour, '5h'), rail(a, a.seven_day, '7d')]),
      el('div', { class: 'r3' }, railR3(a, now)),
      el('div', { class: 'r4' }, railR4(a)),
    ])
  }

  // 6.1.5, all eight states. The walled state is an ADDITIONAL state of the
  // rail, never a replacement for it: both percentages, both reset times and
  // both rails stay on screen while the account is at its wall, and R4 grows.
  function renderAccounts(accounts) {
    // THE ONE LINE THAT DIFFERS FROM sessions.js: this page's head box
    const box = document.getElementById('floor-accounts')
    if (!box) return
    box.textContent = ''
    const list = accounts || []
    const narrow = Boolean(narrowQuery.matches) && list.length > 1
    // 5.5: the condensed head shows the account closest to a wall, with both of
    // its windows, and hides only the others. At full width the head keeps the
    // payload's own order, so no row moves for a reason the reader cannot see.
    const worst = narrow ? closestToWall(list) : null
    const ordered = worst ? [worst, ...list.filter((a) => a !== worst)] : list
    ordered.forEach((a, i) => {
      const row = acctRow(a, narrow && i === 0)
      if (narrow && i > 0 && !headOpen) row.hidden = true
      box.appendChild(row)
    })
    if (narrow) {
      // G3: the demoted accounts are NAMED with their tier, never counted. `2
      // more accounts` hid the fact that one of them was the 96% row, so the
      // phone head carried neither the word `claude` nor the number 96.
      const hidden = ordered.slice(1)
      const named = hidden.map((a) => `${accountLabel(a)} ${tierWord(a, worstWindow(a))}`).join(', ')
      const more = el('button', { type: 'button', class: 'btn btn-text', 'aria-expanded': headOpen ? 'true' : 'false' },
        [headOpen ? `hide ${hidden.map((a) => accountLabel(a)).join(', ')}` : `also: ${named}`])
      more.addEventListener('click', () => { headOpen = !headOpen; renderAccounts(accounts) })
      box.appendChild(more)
    }
    publishHeadHeight()
  }

  // The head is sticky and its height moves with the width, with the number of
  // accounts and with the condensed-head disclosure, so it is measured here and
  // published for the stylesheet. Without it a control tabbed into from below is
  // scrolled to the viewport edge and then covered by the plate (WCAG 2.2
  // 2.4.11), and a region scrolled to its top parks its heading behind it.
  function publishHeadHeight() {
    const head = document.querySelector('.head')
    if (!head || typeof head.getBoundingClientRect !== 'function' || !document.documentElement) return
    const h = Math.round(head.getBoundingClientRect().height)
    if (h) document.documentElement.style.setProperty('--head-h', `${h}px`)
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
    document.getElementById('sched-status').textContent = `scheduler ${sched.running ? 'running' : 'stopped'}, ${sched.max_concurrent ?? '?'} max`
    document.getElementById('count-running').textContent = String(data.counts.running)
    document.getElementById('count-queued').textContent = String(data.counts.queued)
    document.getElementById('count-waiting').textContent = String(data.counts.waiting)
    document.getElementById('count-done').textContent = String(data.counts.done)
  }

  function renderRunning(list) {
    renderTable('running-body', list, (r) => el('tr', {}, [
      el('td', { 'data-label': 'Card', title: r.title || r.card_id }, [r.title || r.card_id]),
      el('td', { 'data-label': 'Station' }, [r.station || '']),
      el('td', { 'data-label': 'Agent / leg' }, [el('span', { class: 'chip' }, [`${r.adapter || '?'} leg ${r.leg}`])]),
      el('td', { 'data-label': 'Leases' }, [el('span', { class: 'chip' }, [(r.leases && r.leases.length ? r.leases : ['**']).join(', ')])]),
      el('td', { 'data-label': 'Last event', title: formatLastEvent(r.last_event) }, [formatLastEvent(r.last_event)]),
      el('td', { 'data-label': 'Elapsed' }, [el('span', { class: 'elapsed' }, [elapsedClock(r.elapsed_ms || 0)])]),
      el('td', { class: 'row-actions', 'data-label': 'Actions' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', 'aria-label': `Pause ${r.title || r.card_id}`, onclick: () => runFloorAction(r.card_id, 'pause') }, ['Pause']),
        el('button', { type: 'button', class: 'btn btn-danger', 'aria-label': `Kill ${r.title || r.card_id}`, onclick: () => runFloorAction(r.card_id, 'kill') }, ['Kill']),
      ]),
    ]), 'Nothing running. A queued card starts here when its leases are free and the scheduler has a slot.')
  }

  function renderWaiting(list) {
    renderTable('waiting-body', list, (w) => {
      const btns = (w.actions || [])
        .filter((a) => WAIT_LABELS[a])
        .map((a) => el('button', { type: 'button', class: WAIT_BTN_CLASS[a], 'aria-label': `${WAIT_LABELS[a]} ${w.title || w.card_id}`, onclick: () => runFloorAction(w.card_id, a) }, [WAIT_LABELS[a]]))
      return el('tr', {}, [
        el('td', { 'data-label': 'Card', title: w.title || w.card_id }, [w.title || w.card_id]),
        el('td', { 'data-label': 'Station' }, [w.station || '']),
        el('td', { 'data-label': 'Status' }, [w.status]),
        el('td', { 'data-label': 'Since' }, [el('span', { class: 'chip' }, [formatTs(w.since)])]),
        el('td', { class: 'row-actions', 'data-label': 'Actions' }, btns),
      ])
    }, 'No cards waiting on a human. A card lands here when a station asks for approval or a run stops for an answer.')
  }

  function renderQueued(list) {
    renderTable('queued-body', list, (q) => el('tr', {}, [
      el('td', { 'data-label': 'Card', title: q.title || q.card_id }, [q.title || q.card_id]),
      el('td', { 'data-label': 'Station' }, [q.station || '']),
      el('td', { 'data-label': 'Leases' }, [el('span', { class: 'chip' }, [(q.leases && q.leases.length ? q.leases : ['**']).join(', ')])]),
      el('td', { 'data-label': 'Blocked by', title: q.blocked_by || '' }, [q.blocked_by ? `blocked by ${q.blocked_by}` : '']),
    ]), 'Nothing queued. New card on the board queues one; it waits here until a slot and its leases are free.')
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

  // the floor is owner-only: a guest (or anyone whose token has rotated) would
  // otherwise get two toasts every two seconds for as long as the tab is open
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
    const main = document.querySelector('.shell')
    main.textContent = ''
    main.appendChild(el('section', { class: 'region' }, [
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
      renderRunning(data.running)
      renderWaiting(data.waiting)
      renderQueued(data.queued)
      renderLeases(data)
      setRegionMeta('running-head', `${data.running.length} running`)
      setRegionMeta('waiting-head', `${data.waiting.length} waiting on a human`)
      setRegionMeta('queued-head', `${data.queued.length} queued`)
      setRegionMeta('leases-head', `${data.leases.length} held`)
    } catch (err) {
      if (state.stopped || request !== state.floorRequest) return
      if (err.status === 401 || err.status === 403) return lockOut(err.message)
      toast(err.message)
    }
  }

  async function refreshTrunk() {
    const request = ++state.trunkRequest
    try {
      const data = await api('/api/trunk?since=1h')
      if (state.stopped || request !== state.trunkRequest) return
      state.lastReadingAt = new Date()
      renderTrunkTable(data)
      setRegionMeta('trunk-lane-head', `${data.landed.length} landed in the last hour`)
    } catch (err) {
      if (state.stopped || request !== state.trunkRequest) return
      if (err.status === 401 || err.status === 403) return lockOut(err.message)
      toast(err.message)
    }
  }

  // the instrument head's accounts are not on /api/floor's payload; /api/sessions
  // carries them (sessionsView()) and is already reachable by an owner token.
  async function refreshHead() {
    const request = ++state.headRequest
    try {
      const data = await api('/api/sessions')
      if (state.stopped || request !== state.headRequest) return
      state.lastReadingAt = new Date()
      renderHead(data.accounts || [])
    } catch (err) {
      if (state.stopped || request !== state.headRequest) return
      if (err.status === 401 || err.status === 403) return lockOut(err.message)
    }
  }

  // The board is pushed a card for every write under its directory, log bytes
  // included, so a busy agent turns an unconditional refresh-per-push into a
  // continuous request stream against a single-threaded local server that is
  // also serving this page's SSE. One pending refresh at a time, the shape
  // board.js uses for its drawer.
  const FLOOR_REFRESH_MS = 250
  function scheduleFloorRefresh() {
    if (state.pendingFloor) return
    state.pendingFloor = setTimeout(() => { state.pendingFloor = null; refreshFloor() }, FLOOR_REFRESH_MS)
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
      banner.textContent = state.lastReadingAt ? `Reconnecting to Baton. Last reading ${clockAt(state.lastReadingAt.getTime())}.` : `Reconnecting to Baton on ${state.bind}.`
    } else if (s === 'connecting') {
      banner.textContent = `Connecting to Baton on ${state.bind}.`
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
    } catch { /* the page's own host is already a correct answer */ }
  }

  function init() {
    loadBind()
    connectSse()
    refreshFloor()
    refreshTrunk()
    refreshHead()
    // a backgrounded tab kept polling three endpoints every two seconds forever;
    // the SSE stream wakes it with the work it missed when it comes back
    state.timers.push(
      setInterval(() => { if (!document.hidden) refreshFloor() }, 2000),
      setInterval(() => { if (!document.hidden) { refreshTrunk(); refreshHead() } }, 2000),
    )
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.stopped) { refreshFloor(); refreshTrunk(); refreshHead() } })
    if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', () => renderHead(null))
  }

  document.addEventListener('DOMContentLoaded', init)

  // test seam: node:test runs this file with a stub document; in a browser
  // there is no `module`
  if (typeof module !== 'undefined') module.exports = { boardHref }
})()
