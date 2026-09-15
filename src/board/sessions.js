// Terminals lane: the window rail (5h/7d per login), the sessions started with
// `baton claude|codex|agy`, overlap flags (two live sessions editing the same
// file), and what has landed on trunk. Data: /api/sessions, pushed as the SSE
// `sessions` event (board.js re-dispatches it as `baton:sessions`).
//
// The design is .design/BOARD-DESIGN.md sections 6.1 to 6.6; the ids, class
// names and frozen source shapes are .design/BUILD-CONTRACT.md section 6.1.
// Two tests read this file as SOURCE TEXT, not as behaviour:
//   test/board-drawer.test.mjs  takeScroll/putScroll, renderDrawer's
//     capture -> wipe -> restore order, the four data-scroll-key literals, and
//     the two "newest first" strings.
//   test/resume.test.mjs        resumeLine(v) and the line that appends it.
// Read both before renaming anything here. board-a11y does not scan this file,
// so every control it builds carrying a visible name or an 'aria-label' is a
// hand rule with no test behind it.
(function () {
  'use strict'
  // 6.3: the nine shipped status words, unchanged, each with the tone of its
  // 7px mark. The word carries the meaning; the mark is aria-hidden.
  const STATUS = {
    starting: ['starting', 'run'], running: ['running', 'run'], warning: ['near limit', 'warn'], limit: ['limit hit', 'danger'],
    handing_off: ['handing off', 'warn'], waiting: ['waiting for reset', 'warn'], handed_off: ['handed off', 'idle'], ended: ['ended', 'idle'], lost: ['lost', 'danger'],
  }
  const WIN_WORDS = { '5h': '5 hour', '7d': '7 day' }
  const IDS = ['claude', 'codex', 'agy', 'fake']
  const FIVE_HOUR_MS = 5 * 3600 * 1000

  let view = null
  let headOpen = false
  let pendingConfirm = null
  const sessionEditors = new Map()
  const alsoOpen = new Set()
  const actionNotes = new Map()
  const lastTone = new Map()
  const defaultEditor = { order: null, dirty: false, saving: false, status: '', statusClass: '' }
  const narrowQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 619px)') : { matches: false }

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

  // 6.9: this page has ONE system message, and it lives in board.js, published
  // as window.batonMessage. A result that belongs to a terminal is written into
  // that terminal's sentence slot instead; only what belongs to no object at all
  // comes through here. This file no longer writes into #toast itself.
  function sysMessage(text, tone) { if (typeof window.batonMessage === 'function') window.batonMessage(text, tone) }

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
  function until(epochS) { return Number.isFinite(epochS) ? clockAt(epochS * 1000) : 'unknown' }
  function whenAgo(ts) {
    const t = Date.parse(ts)
    return Number.isFinite(t) ? `${ago(Date.now() - t)} ago` : ''
  }
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
  function optionLabel(a) { return a ? (a.account && a.account !== 'default' ? `${a.agent}/${a.account}` : a.agent) : 'none' }
  function idOf(agent) { return IDS.includes(agent) ? agent : 'fake' }
  const tail = (id) => String(id).split('-').slice(-2).join('-')
  const shared = () => Boolean(view && view.share && view.share.on)
  const isMine = (s) => Boolean(view && view.you && s.owner && view.you.name === s.owner)

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
    const box = document.getElementById('accounts')
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

  // Before the first /api/sessions comes back the rail draws its face and its
  // graduations and says `reading`. Never a zero.
  function renderLoadingHead() {
    renderAccounts([{ label: 'accounts', agent: null, account: 'default', loading: true, five_hour: null, seven_day: null }])
  }

  // ---- 6.4 rankedNotes: one ranking, four surfaces ------------------------
  // The notice set is modelled as ranked DATA, not written per fixture. The
  // panel's one sentence, the `also:` disclosure, the expanded detail and the
  // Terminals region-head count all read this list, so a live overlap warning
  // cannot end up behind a past success on the same row.
  function landLine(s) {
    const L = s.land
    if (!L) return null
    const who = L.by && L.by !== 'local' ? `, by ${L.by}` : ''
    if (L.state === 'landing') return { rank: 7, cat: 'landing', tone: 'warn', text: `landing ${L.branch} onto ${L.base}: commit, rebase, test, fast-forward` }
    if (L.state === 'landed') {
      const at = Date.parse(L.at || '')
      if (Number.isFinite(at) && Date.now() - at > 10 * 60 * 1000) return null
      const n = L.files ? L.files.length : null
      const counts = n === null ? '' : `, ${n} file${n === 1 ? '' : 's'}, +${L.insertions || 0}/-${L.deletions || 0}${L.tested ? '' : ', untested'}`
      // every other field in this template is guarded; an unrecorded sha used to
      // render `undefin`, which reads as a real short hash
      const sha = L.sha ? String(L.sha).slice(0, 7) : 'an unrecorded commit'
      return { rank: 9, cat: 'landed', tone: 'ok', text: `landed on ${L.base}, ${sha}${counts}${who}` }
    }
    if (L.state === 'noop') return { rank: 9, cat: 'nothing to land', tone: 'muted', text: `nothing to land: ${L.branch} has no changes beyond ${L.base}` }
    if (L.state === 'interrupted') return { rank: 2, cat: 'landing cut off', tone: 'danger', text: 'the landing was cut off (the board restarted); press Land again' }
    // G9: the bounce states the consequence, not just the event. "bounced:
    // CONFLICT" leaves the reader guessing what happened to their work.
    const at = Date.parse(L.at || '')
    const when = Number.isFinite(at) ? ` at ${clockAt(at)}` : ''
    const first = String(L.detail || L.reason || '').split('\n')[0].slice(0, 160)
    return { rank: 2, cat: 'bounced', tone: 'danger', text: `Land was attempted${when} onto ${L.base} and bounced${who}: ${first}. The branch still holds every commit; nothing was lost.` }
  }

  function rankedNotes(s) {
    const out = []
    // 6.13: someone else's terminal says one thing and nothing else
    if (s.hidden) {
      out.push({ rank: 10, cat: 'read-only', tone: 'muted', text: `read-only: ${s.owner || 'another human'} owns this terminal` })
      return out
    }
    // the last thing the reader pressed, while it is still the freshest fact
    const done = actionNotes.get(s.session_id)
    if (done && Date.now() - done.at < 60000) out.push({ rank: done.tone === 'danger' ? 2 : 9, cat: 'last action', tone: done.tone, text: done.text })
    if (s.all_out && s.all_out.length) out.push({ rank: 1, cat: 'all out', tone: 'danger', text: `every option is out, first back: ${optionLabel(s.all_out[0])} ${until(s.all_out[0].resets_at)}` })
    if (s.limit) out.push({ rank: 1, cat: 'limit', tone: 'danger', text: `limit: ${s.limit.reason}${Number.isFinite(s.limit.resets_at) ? `, back ${until(s.limit.resets_at)}` : ''}` })
    const land = landLine(s)
    if (land) out.push(land)
    // rank 3, and section 10 item 2: the best sentence in the product. It names
    // the agent, the session, the file, the mechanism and the consequence in one
    // line. Kept character for character; only its position changed.
    for (const o of s.overlap || []) {
      // the same elision as the files line below it: one form per page
      const files = `${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? `, and ${o.files.length - 3} more` : ''}`
      out.push({ rank: 3, cat: 'overlap', tone: 'danger', text: o.separate
        ? `${o.agent} (${tail(o.session_id)}) is changing ${files} in another checkout; whoever lands second rebases`
        : `${o.agent} (${tail(o.session_id)}) is editing ${files} too` })
    }
    for (const r of s.requests || []) out.push({ rank: 4, cat: 'handoff request', tone: 'warn', text: `${r.by} asked to take this terminal at ${clockAt(Date.parse(r.at))}` })
    if (s.status === 'waiting' && s.waiting) out.push({ rank: 5, cat: 'waiting', tone: 'warn', text: `waiting for ${optionLabel(s.waiting)} at ${until(s.waiting.resets_at)}` })
    if (s.status === 'handing_off' && s.handoff && s.handoff.to) out.push({ rank: 6, cat: 'handing off', tone: 'warn', text: `handing off to ${optionLabel(s.handoff.to)}, ${s.handoff.reason}${s.handoff.at ? `, ${ago(Date.now() - Date.parse(s.handoff.at))}` : ''}` })
    // rank 8 does not restate the percentage: the head prints it in 30px type a
    // few inches above. It names what the head does not carry, the fallback.
    if (s.warning) out.push({ rank: 8, cat: 'near limit', tone: 'warn', text: `near the ${s.warning.window} wall, next: ${s.chain && s.chain[0] ? optionLabel(s.chain[0]) : 'no eligible fallback'}` })
    // rank 10 is a genuine fallback, so a state nobody wrote a fixture for still
    // gets a correct sentence rather than an empty slot.
    out.push({ rank: 10, cat: 'activity', tone: 'muted', text: `turn ${s.turns || 0}${s.last_activity ? `, last activity ${clockAt(Date.parse(s.last_activity))}` : ''}` })
    out.sort((a, b) => a.rank - b.rank)
    return out
  }

  // needs you: limit hit, bounced, overlap, a pending handoff request, all out.
  // The same predicate raises the panel, sorts the list and counts the region
  // head, so the three cannot disagree about what is wrong.
  function needsYou(s, notes) { return !s.hidden && notes.length > 0 && notes[0].rank <= 4 }

  // 6.3: a 7px square plus a word. The square is aria-hidden and the word is the
  // meaning. The annunciation fires only on a transition INTO danger while the
  // page is open, never on first paint.
  // `override` is how a needs-you panel says so in words. The panel's only other
  // carrier of that state is one elevation step (--e2 to --e3, 1.15:1), so
  // without the word colour is carrying it alone and two panels that need
  // opposite things from the reader both said `running`.
  function statusMark(status, key, override) {
    const [word, tone] = STATUS[status] || [status, 'idle']
    const was = lastTone.get(key)
    const fresh = was !== undefined && was !== 'danger' && tone === 'danger'
    lastTone.set(key, tone)
    return el('span', { class: 'status-word' }, [
      el('span', { class: `mark tone-${tone}${fresh ? ' state-active' : ''}`, 'aria-hidden': 'true' }),
      override || word,
    ])
  }

  // 6.5: no confirm() and no modal. The button row swaps for one sentence and
  // two buttons, focus moves to Cancel, and Escape cancels.
  function confirmRow(question, verb, onYes) {
    const yes = el('button', { type: 'button', class: 'btn btn-danger' }, [verb])
    const no = el('button', { type: 'button', class: 'btn btn-secondary' }, ['Cancel'])
    yes.addEventListener('click', () => { pendingConfirm = null; onYes(yes) })
    no.addEventListener('click', () => { pendingConfirm = null; renderSessions(view) })
    setTimeout(() => no.focus(), 0)
    return el('div', { class: 'confirm-row' }, [el('span', { class: 'sentence' }, [question]), yes, no])
  }

  // G11: the full machine strings, never shortened. A path the reader cannot
  // copy is a path they cannot check.
  function whereBlock(s) {
    const rows = []
    const add = (k, v) => { if (v) rows.push(el('div', { class: 'kv-key' }, [k]), el('div', { class: 'kv-val' }, [String(v)])) }
    add('path', s.worktree ? s.worktree.path : s.cwd)
    add('branch', s.worktree ? s.worktree.branch : s.branch)
    add('cut from', s.worktree ? (s.worktree.base || 'a detached HEAD') : null)
    add('transcript', s.transcript_path)
    // one sha length per page: the trunk list and the land sentence print seven
    // characters, so the HEAD row does too, with the full forty in its title the
    // way a path carries its own full string
    if (s.head) rows.push(el('div', { class: 'kv-key' }, ['head']), el('div', { class: 'kv-val', title: String(s.head) }, [String(s.head).slice(0, 7)]))
    return el('div', { class: 'kv' }, rows)
  }

  function moveOrder(order, index, delta) {
    const target = index + delta
    if (target < 0 || target >= order.length) return [...order]
    const next = [...order]
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  }

  function orderRows(order, onMove, scope) {
    const box = el('div', {})
    order.forEach((agent, index) => {
      const attrs = (direction) => ({
        'data-order-scope': scope,
        'data-order-agent': agent,
        'data-order-direction': direction,
        'data-focus-key': `order:${scope}:${agent}:${direction}`,
      })
      const up = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-label': `Move ${agent} earlier`, disabled: index === 0 ? '' : null, ...attrs('up') }, ['Up'])
      const down = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-label': `Move ${agent} later`, disabled: index === order.length - 1 ? '' : null, ...attrs('down') }, ['Down'])
      up.addEventListener('click', () => onMove(index, -1))
      down.addEventListener('click', () => onMove(index, 1))
      box.appendChild(el('div', { class: 'order-row' }, [el('span', { class: `order-row-name chip-id-${idOf(agent)}` }, [`${index + 1}. ${agent}`]), up, down]))
    })
    return box
  }

  // Every region on this page is wiped and rebuilt on a timer, so a control the
  // reader had tabbed to is a different element three seconds later and focus
  // lands back on <body>. Controls that survive a rebuild by identity carry a
  // stable data-focus-key and this pair carries the focus across, with the caret
  // where it applies. Written first for the handoff-order buttons; the detail
  // region, the panels and the default-order editor all use the same pair now.
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
    // a key can carry a file path, so both CSS string escapes have to survive
    const key = at.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    let target = null
    try { target = box.querySelector(`[data-focus-key="${key}"]`) } catch { return }
    // an agent moved to the end of the list loses its own Down button: focus the
    // control beside it rather than dropping the reader back to the top
    if (target && target.disabled) target = target.parentElement?.querySelector('[data-focus-key]:not([disabled])') || null
    if (!target) return
    // preventScroll is load-bearing, not a nicety. This runs on a 3-second
    // timer, and a bare focus() scrolls its element into view every time, so a
    // reader who clicked any button was dragged back to it on every poll and
    // could not scroll the page at all. Restoring focus after a rebuild must
    // never move the viewport; only a focus move the reader asked for may.
    target.focus({ preventScroll: true })
    if (typeof at.start === 'number' && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(at.start, at.end) } catch { /* no longer a text field */ }
    }
  }

  // A rebuild clears any selection that spans it, so the timed re-sort stands
  // down while the reader is selecting a path or a sentence out of a panel. A
  // real data push still redraws: the words on screen win over the drag.
  function selectionInsideGrid() {
    const sel = typeof document.getSelection === 'function' ? document.getSelection() : null
    if (!sel || sel.isCollapsed || !String(sel).trim()) return false
    const grid = document.getElementById('session-grid')
    return Boolean(grid && sel.anchorNode && grid.contains(sel.anchorNode))
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
    const focus = takeFocus(document)
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
    putFocus(document, focus)
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

  // A result that belongs to a terminal is written into that terminal's sentence
  // slot, where the reader is already looking. Only a result that belongs to no
  // object on this page goes to the one system message.
  async function act(id, action, btn) {
    btn.disabled = true
    actionNotes.delete(id)
    try {
      if (action.startsWith('requests/')) {
        await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        actionNotes.set(id, { at: Date.now(), tone: 'ok', text: action.endsWith('approve') ? 'approved; this terminal hands off in a few seconds' : 'the request was dismissed' })
      } else if (action === 'request-handoff') {
        await api(`/api/sessions/${encodeURIComponent(id)}/request-handoff`, { method: 'POST' })
        sysMessage('asked; the owner of that terminal decides', 'ok')
      } else if (action === 'remove') {
        const r = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        sysMessage(r.worktree ? (r.worktree.removed ? (r.worktree.branchDeleted === false ? 'removed the terminal and its worktree; the branch is kept' : 'removed the terminal, its worktree and its branch') : `removed the terminal; the worktree is kept: ${r.worktree.reason}`) : 'removed the terminal', 'ok')
      } else if (action === 'remove-record') {
        await api(`/api/sessions/${encodeURIComponent(id)}?force=1&keep_worktree=1`, { method: 'DELETE' })
        sysMessage('removed the Baton record; the worktree and the branch are kept', 'ok')
      } else {
        await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        if (action === 'handoff') actionNotes.set(id, { at: Date.now(), tone: 'warn', text: 'hand-off requested; this terminal switches agents in a few seconds' })
        else if (action === 'end') actionNotes.set(id, { at: Date.now(), tone: 'warn', text: 'end requested; the agent stops after its current turn' })
      }
      refresh()
    } catch (err) {
      actionNotes.set(id, { at: Date.now(), tone: 'danger', text: err.message })
      btn.disabled = false
      if (view) renderSessions(view)
    }
  }

  function renderHandoffOrder(s) {
    const wrap = el('div', {})
    // One chip for the whole sequence, not one per agent: `.chip + .chip::before`
    // puts a middot between every pair of siblings, so separate chips rendered
    // `now: codex · then · claude`, a five-item list with two items called
    // "then". The agent names keep their identity colour inside it.
    const sequence = el('div', { class: 'chain-rail', 'aria-label': 'Terminal handoff sequence' })
    const chain = el('span', { class: 'chip' }, ['now: ', el('span', { class: `chip-id-${idOf(s.agent)}` }, [optionLabel(s)])])
    // the fonts carry no arrow glyph, so the word does the arrow's job
    for (const next of s.chain || []) chain.append(document.createTextNode(', then '), el('span', { class: `chip-id-${idOf(next.agent)}` }, [optionLabel(next)]))
    sequence.appendChild(chain)
    wrap.appendChild(sequence)
    const preferred = optionLabel(s.preferred_next)
    const eligible = optionLabel(s.eligible_next)
    if (!s.handoff_availability_known) wrap.appendChild(el('p', { class: 'sentence tone-muted' }, [`preferred: ${preferred}, and current eligibility is unavailable for this older terminal`]))
    else if (!s.eligible_next) wrap.appendChild(el('p', { class: 'sentence tone-warn' }, [`preferred: ${preferred}. No fallback is eligible now; Baton waits if every account is at its limit.`]))
    else if (eligible !== preferred) wrap.appendChild(el('p', { class: 'sentence tone-muted' }, [`preferred: ${preferred}, first eligible now: ${eligible}`]))
    else wrap.appendChild(el('p', { class: 'sentence tone-muted' }, [`first eligible now: ${eligible}`]))
    wrap.appendChild(el('p', { class: 'blocker' }, ['Used after a usage limit or Hand off now. A normal exit ends this terminal.']))

    const editableNow = ['starting', 'running', 'warning', 'limit', 'waiting'].includes(s.status)
    if (!s.hidden && editableNow) {
      let state = sessionEditors.get(s.session_id)
      const sourceOrder = s.can_edit_handoff_order ? s.handoff_order : (view?.preferences?.handoff_order ?? s.handoff_order)
      if (!state) {
        state = { open: false, order: [...sourceOrder], dirty: false, saving: false, status: '', statusClass: '' }
        sessionEditors.set(s.session_id, state)
      } else if (!state.dirty && !state.saving) state.order = [...sourceOrder]
      const change = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-expanded': state.open ? 'true' : 'false', 'data-focus-key': `order-toggle:${s.session_id}` }, [state.open ? 'Close order editor' : 'Change order'])
      change.addEventListener('click', () => { state.open = !state.open; renderDrawer() })
      wrap.appendChild(change)
      if (state.open) {
        const editor = el('div', { class: 'detail-section' })
        editor.appendChild(el('p', { class: 'blocker' }, [s.can_edit_handoff_order
          ? 'Move agents to set the priority for this terminal. All three stay available; the agent running now is skipped, and the rest keep this order.'
          : 'This terminal started before order changes were available. Save this order for the next terminal, then restart when ready.']))
        editor.appendChild(orderRows(state.order, (index, delta) => {
          state.order = moveOrder(state.order, index, delta)
          state.dirty = true
          state.status = ''
          renderDrawer()
        }, s.session_id))
        editor.appendChild(el('p', { class: 'blocker' }, [`Draft priority after ${s.agent}: ${agentsAfter(s.agent, state.order).join(', then ')}`]))
        const status = el('span', { class: `field-status ${state.statusClass}`, 'aria-live': 'polite' }, [state.status])
        const save = el('button', { type: 'button', class: 'btn btn-secondary', disabled: state.saving || !state.dirty ? '' : null, 'data-focus-key': `order-save:${s.session_id}` }, [state.saving ? 'Saving…' : s.can_edit_handoff_order ? 'Save for this terminal' : 'Save as default for next launch'])
        save.addEventListener('click', async () => {
          state.saving = true; state.status = ''; renderDrawer()
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
            renderDrawer()
          }
        })
        editor.append(status, save)
        wrap.appendChild(editor)
      }
    }
    return wrap
  }

  // ---- 6.2 the session panel ---------------------------------------------
  // A full-width band in the four-register grid, not a floating card. Elevation
  // is assigned by urgency, not by nesting: a terminal that starts needing you
  // rises, and that rise is the notification.
  function renderSession(s) {
    const notes = rankedNotes(s)
    const urgent = needsYou(s, notes)
    // the article is named so the accessibility tree does not hand the reader
    // three identical triples of Land / Hand off now / Details / End
    const panel = el('article', { class: `panel ${s.hidden || !s.active ? 'is-inert' : urgent ? 'needs-you' : 'is-running'}`, 'data-session-id': s.session_id, 'aria-label': `${s.agent} ${tail(s.session_id)}` })

    const chips = []
    if (s.account !== 'default') chips.push(el('span', { class: 'chip' }, [s.account]))
    if (shared() && s.owner) chips.push(el('span', { class: 'chip' }, [isMine(s) ? `${s.owner}, you` : s.owner]))
    if (s.lineage && s.lineage.from) chips.push(el('span', { class: 'chip' }, [`from ${s.lineage.from}`]))
    panel.appendChild(el('div', { class: 'r1' }, [
      el('div', {}, [el('span', { class: `acct-name chip-id-${idOf(s.agent)}` }, [s.agent]), ' ', el('span', { class: 'chip' }, [tail(s.session_id)])]),
      statusMark(s.status, s.session_id, urgent ? 'waiting on you' : null),
      chips.length ? el('div', {}, chips) : null,
    ]))

    const r2 = el('div', { class: 'r2' })
    if (s.hidden) r2.appendChild(el('p', { class: 'sentence tone-muted' }, ['prompt hidden']))
    else {
      // a real <button>, so Enter, Space, the focus ring and touch all come free
      const prompt = el('button', { type: 'button', class: 'panel-prompt', title: s.task || 'no prompt yet', 'aria-expanded': drawer.id === s.session_id ? 'true' : 'false', 'data-focus-key': `prompt:${s.session_id}` }, [s.task || 'no prompt yet'])
      prompt.addEventListener('click', () => (drawer.id === s.session_id ? closeSessionDrawer() : openSessionDrawer(s.session_id, 'prompt')))
      r2.appendChild(prompt)
    }
    // exactly one sentence, the highest-ranked note
    if (notes[0]) r2.appendChild(el('p', { class: `sentence tone-${notes[0].tone}` }, [notes[0].text]))
    const rest = notes.slice(1)
    if (rest.length) {
      // G3: the demoted notes are NAMED, never counted. "2 more" tells the
      // reader nothing about whether the thing behind it matters.
      const open = alsoOpen.has(s.session_id)
      // `btn` is what zeroes the native button chrome; `btn-text` alone shipped
      // the browser's grey bevelled box, label at 2.19:1 and invisible on hover
      const also = el('button', { type: 'button', class: 'btn btn-text also', 'aria-expanded': open ? 'true' : 'false', 'data-focus-key': `also:${s.session_id}` }, [`also: ${rest.map((n) => n.cat).join(', ')}`])
      also.addEventListener('click', () => { if (open) alsoOpen.delete(s.session_id); else alsoOpen.add(s.session_id); renderSessions(view) })
      r2.appendChild(also)
      if (open) for (const n of rest) r2.appendChild(el('p', { class: `sentence tone-${n.tone}` }, [n.text]))
    }
    const touched = s.files || []
    if (!s.hidden && touched.length) {
      // comma-separated text, not chips: six file names are a sentence, and a
      // file that is also in an overlap is named in that sentence anyway
      const overlapFiles = new Set((s.overlap || []).flatMap((o) => o.files))
      const line = el('p', { class: 'files' })
      touched.slice(0, 6).forEach((f, i) => {
        if (i) line.appendChild(document.createTextNode(', '))
        line.appendChild(el('span', { class: `file${overlapFiles.has(f) ? ' is-overlap' : ''}`, title: f }, [f]))
      })
      if (touched.length > 6) line.appendChild(document.createTextNode(`, and ${touched.length - 6} more`))
      r2.appendChild(line)
    }
    panel.appendChild(r2)

    const branch = s.worktree ? s.worktree.branch : s.branch
    panel.appendChild(el('div', { class: 'r3' }, [
      el('div', { class: 'where', title: s.cwd || null }, [`${s.repo_name || s.cwd || 'unknown repo'}${branch ? `@${branch}` : ''}`]),
      s.worktree ? el('div', { class: 'worktree' }, [`own worktree, from ${s.worktree.base || 'a detached HEAD'}`]) : null,
    ]))

    const r4 = el('div', { class: 'r4' }, [
      el('span', { class: 'elapsed', 'data-elapsed-from': String(Date.parse(s.started_at) || 0), title: `started ${new Date(s.started_at).toLocaleString()}` }, [elapsedClock(s.elapsed_ms)]),
    ])
    if (pendingConfirm && pendingConfirm.id === s.session_id) {
      r4.appendChild(confirmRow(pendingConfirm.question, pendingConfirm.verb, (btn) => act(s.session_id, pendingConfirm.action, btn)))
      panel.appendChild(r4)
      return panel
    }
    const actions = el('div', { class: 'actions' })
    const ask = (question, verb, action) => () => { pendingConfirm = { id: s.session_id, question, verb, action }; renderSessions(view) }
    if (s.hidden) {
      if (s.active) {
        const q = el('button', { type: 'button', class: 'btn btn-secondary', title: `ask ${s.owner || 'the owner'} to hand this terminal off; they approve it on their own board` }, ['Request handoff'])
        q.addEventListener('click', () => act(s.session_id, 'request-handoff', q))
        actions.appendChild(q)
      }
      r4.appendChild(actions)
      panel.appendChild(r4)
      return panel
    }
    // G10: the order is Land, Hand off now, Details, End, and it never reflows
    // by availability. A button that does not apply is omitted, never moved.
    const landing = Boolean(s.land && s.land.state === 'landing')
    const blocker = s.worktree
      ? s.land_blocker
      : 'this terminal works in the checkout itself: there is no branch of its own to land'
    // G10 is disabled-with-its-reason, so the reason is attached to the control
    // as well as printed: the title used to be on the inverse condition, giving
    // the tooltip to the button that explains itself and none to the one that
    // needs it, and nothing connected the sentence below to the button above.
    const blockerId = blocker ? `land-blocker-${s.session_id}` : null
    const land = el('button', {
      type: 'button',
      class: `btn btn-primary${landing ? ' is-loading' : ''}`,
      disabled: blocker || landing ? '' : null,
      'data-focus-key': `land:${s.session_id}`,
      'aria-describedby': blockerId,
      title: blocker || `commit this terminal's work on ${s.worktree.branch}, rebase it onto ${s.worktree.base}, run the tests, fast-forward ${s.worktree.base}; a bounce says why`,
    }, [landing ? 'Landing…' : 'Land'])
    land.addEventListener('click', () => act(s.session_id, 'land', land))
    actions.appendChild(land)
    if (s.active) {
      const h = el('button', { type: 'button', class: 'btn btn-secondary', title: 'save the bundle, stop this agent, start the next option in the same terminal', 'data-focus-key': `handoff:${s.session_id}` }, ['Hand off now'])
      h.addEventListener('click', () => act(s.session_id, 'handoff', h))
      actions.appendChild(h)
    }
    const details = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-expanded': drawer.id === s.session_id ? 'true' : 'false', 'data-focus-key': `details:${s.session_id}` }, ['Details'])
    details.addEventListener('click', () => (drawer.id === s.session_id ? closeSessionDrawer() : openSessionDrawer(s.session_id, 'details')))
    actions.appendChild(details)
    if (s.active) {
      const e = el('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `end:${s.session_id}` }, ['End'])
      e.addEventListener('click', ask('End this terminal? The agent stops and the bundle is kept.', 'End', 'end'))
      actions.appendChild(e)
    } else {
      const r = el('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `remove:${s.session_id}` }, ['Remove'])
      r.addEventListener('click', ask(s.worktree
        ? `Remove this terminal? Its worktree at ${s.worktree.path} and its branch ${s.worktree.branch} go with it.`
        : 'Remove this terminal? Baton\'s record of it is deleted.', 'Remove', 'remove'))
      actions.appendChild(r)
      if (s.worktree) {
        const keep = el('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `remove-record:${s.session_id}` }, ['Remove record'])
        keep.addEventListener('click', ask(`Remove only the Baton record for ${s.session_id}? The worktree at ${s.worktree.path} and the branch ${s.worktree.branch} stay, with every commit.`, 'Remove record', 'remove-record'))
        actions.appendChild(keep)
      }
    }
    for (const r of s.requests || []) {
      const ok = el('button', { type: 'button', class: 'btn btn-primary', title: `hand this terminal off for ${r.by}` }, [`Approve ${r.by}`])
      ok.addEventListener('click', () => act(s.session_id, `requests/${encodeURIComponent(r.by)}/approve`, ok))
      const no = el('button', { type: 'button', class: 'btn btn-danger' }, [`Dismiss ${r.by}`])
      no.addEventListener('click', () => act(s.session_id, `requests/${encodeURIComponent(r.by)}/dismiss`, no))
      actions.append(ok, no)
    }
    r4.appendChild(actions)
    // the reason a disabled control is disabled is printed, never left in a title
    if (blocker) r4.appendChild(el('p', { class: 'blocker', id: blockerId }, [blocker]))
    panel.appendChild(r4)
    return panel
  }

  // ---- 6.6 the detail region: an in-flow expansion, never an overlay ------
  // The messages, the diffs and the timeline are one extra fetch per open
  // terminal, so nothing here is requested until the region is open, and the
  // poll stops when it is paused or the tab is in the background.
  const drawer = { id: null, paused: false, timer: null, detail: null, error: '', expanded: new Set(), diffs: new Map(), turnCap: 8, openedBy: 'prompt' }

  function drawerSession() { return view && view.sessions ? view.sessions.find((s) => s.session_id === drawer.id) : null }
  // The region is MOVED under the panel it expands, so the reference is cached:
  // once it has been moved into the sessions list, getElementById would stop
  // finding it the moment that list is rebuilt.
  let regionEl = null
  function detailRegion() {
    if (!regionEl) regionEl = document.getElementById('session-drawer')
    return regionEl
  }

  function openSessionDrawer(id, from) {
    drawer.id = id
    drawer.openedBy = from === 'details' ? 'details' : 'prompt'
    drawer.detail = null
    drawer.error = ''
    drawer.paused = false
    drawer.turnCap = 8
    drawer.expanded.clear()
    drawer.diffs.clear()
    const region = detailRegion()
    if (region) { region.hidden = false; region.setAttribute('aria-hidden', 'false') }
    // in flow, directly under the panel it belongs to, so the page keeps exactly
    // one scroll container and the instrument head stays visible. renderSessions
    // is what puts it there, and it runs before the content is built so that
    // moving the region cannot blur what the next line focuses.
    if (view) renderSessions(view)
    renderDrawer()
    loadDrawer()
    if (drawer.timer) clearInterval(drawer.timer)
    drawer.timer = setInterval(() => { if (!drawer.paused && !document.hidden) loadDrawer() }, 3000)
    document.getElementById('session-drawer-close')?.focus()
  }

  function closeSessionDrawer() {
    if (drawer.timer) clearInterval(drawer.timer)
    drawer.timer = null
    const id = drawer.id
    const from = drawer.openedBy
    drawer.id = null
    const region = detailRegion()
    if (region) { region.hidden = true; region.setAttribute('aria-hidden', 'true') }
    if (view) renderSessions(view)
    // back to the control that opened it, not to a different control on the same
    // panel: closing from Details used to land the reader on the prompt button
    if (id) putFocus(document, { key: `${from === 'details' ? 'details' : 'prompt'}:${id}` })
  }

  async function loadDrawer() {
    if (!drawer.id) return
    const id = drawer.id
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}/detail`)
      if (drawer.id !== id) return // the region moved on while this was in flight
      drawer.detail = data
      drawer.error = ''
    } catch (err) {
      if (drawer.id !== id) return
      drawer.error = err.message
    }
    renderDrawer()
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
    if (d.truncated) pre.appendChild(el('span', { class: 'hunk' }, [`cut off at ${d.diff.split('\n').length} lines`]))
  }

  // A failure is never cached: it used to be written into the success map, where
  // it was indistinguishable from a real diff to paintDiff and survived every
  // collapse and re-expand, so one transient 400 pinned that file to an error
  // until the whole region was closed. The message is painted and nothing is
  // stored, so the next expand asks again.
  async function showDiff(path, pre) {
    if (drawer.diffs.has(path)) { paintDiff(pre, drawer.diffs.get(path)); return }
    pre.textContent = 'reading the diff'
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(drawer.id)}/diff?file=${encodeURIComponent(path)}`)
      drawer.diffs.set(path, d)
      paintDiff(pre, d)
    } catch (err) {
      pre.textContent = ''
      pre.appendChild(el('span', { class: 'hunk' }, [`the diff could not be read: ${err.message}. Collapse this file and open it again to retry.`]))
    }
  }

  function messageRow(m, key) {
    return el('div', { class: 'turn drawer-msg' }, [
      el('span', { class: 'turn-role drawer-msg-role' }, [m.role === 'user' ? 'human' : 'agent']),
      m.ts ? el('span', { class: 'turn-when drawer-msg-when' }, [whenAgo(m.ts)]) : null,
      // every box that can scroll carries a key, so where the reader had
      // scrolled to survives the rebuild three seconds later
      el('p', { 'data-scroll-key': `msg:${key}` }, [m.text]),
    ])
  }

  function fileRow(f) {
    const wrap = el('div', {})
    const pre = el('pre', { class: 'drawer-diff', hidden: '', 'data-scroll-key': `diff:${f.path}` })
    const row = el('button', { type: 'button', class: 'btn btn-text', 'aria-expanded': 'false', 'data-focus-key': `file:${f.path}` }, [
      el('span', { class: 'mono', title: f.path }, [f.path]),
      f.dirty ? el('span', { class: 'chip chip-state-warn' }, ['uncommitted']) : null,
      Number.isFinite(f.adds) ? el('span', { class: 'chip chip-state-ok' }, [`+${f.adds}`]) : null,
      // red is not spent on a diff: the minus glyph carries the deletion
      Number.isFinite(f.dels) ? el('span', { class: 'chip' }, [`-${f.dels}`]) : null,
      // no counts against HEAD: the agent created it, or it is already committed
      Number.isFinite(f.adds) ? null : el('span', { class: 'chip' }, [f.state === 'new' ? 'new' : f.state === 'committed' ? 'committed' : String(f.state || '')]),
    ])
    const toggle = () => {
      const opening = pre.hidden
      pre.hidden = !opening
      row.setAttribute('aria-expanded', opening ? 'true' : 'false')
      if (opening) { drawer.expanded.add(f.path); showDiff(f.path, pre) } else drawer.expanded.delete(f.path)
    }
    row.addEventListener('click', toggle)
    if (drawer.expanded.has(f.path)) { pre.hidden = false; row.setAttribute('aria-expanded', 'true'); showDiff(f.path, pre) }
    wrap.append(row, pre)
    return wrap
  }

  // The region is rebuilt from scratch every poll so every relative timestamp
  // stays honest. That used to throw away where the reader had scrolled inside
  // the task box, a message or the timeline: they snapped back to the top every
  // three seconds, which made a long message impossible to read. Each scrollable
  // box carries a stable data-scroll-key, and its offset is carried across.
  function takeScroll(box) {
    const at = new Map()
    for (const node of box.querySelectorAll('[data-scroll-key]')) if (node.scrollTop) at.set(node.getAttribute('data-scroll-key'), node.scrollTop)
    return at
  }
  function putScroll(box, at) {
    if (!at.size) return
    for (const node of box.querySelectorAll('[data-scroll-key]')) {
      const was = at.get(node.getAttribute('data-scroll-key'))
      if (was) node.scrollTop = was
    }
  }

  // Whether .baton/RESUME.md still describes the repository a reader would find.
  // The server recomputes this from git on every poll, so the line is a verdict
  // about right now, not a timestamp the file remembered about itself.
  function resumeLine(v) {
    const cls = v.state === 'fresh' ? 'sentence tone-ok' : v.state === 'missing' ? 'sentence tone-muted' : 'sentence tone-warn'
    const text = v.state === 'fresh'
      ? `RESUME.md is current${v.written_at ? `, written ${whenAgo(v.written_at)}` : ''}`
      : v.state === 'missing'
        ? 'no RESUME.md in this checkout yet; one is written at the first hand-off'
        : v.state === 'unstamped'
          ? 'RESUME.md carries no Baton stamp, so its freshness cannot be checked'
          : `RESUME.md is stale: ${v.reasons.join('; ')}`
    return el('p', { class: cls, title: 'freshness is recomputed from git on every poll; baton resume --check' }, [text])
  }

  function section(title, note, body) {
    const s = el('section', { class: 'detail-section' }, [
      el('h3', { class: 'detail-heading' }, [title, note ? el('span', { class: 'detail-sub' }, [note]) : null]),
    ])
    s.appendChild(body)
    return s
  }

  // G14: a cap names its volume. `showing 8 of 34 turns` beats `last 8 turns`,
  // which never said how much the reader could not see.
  function capLine(shown, total, noun, onMore) {
    const line = el('div', { class: 'cap-line' }, [`showing ${shown} of ${total} ${noun}`])
    if (onMore) {
      // the same label as the card drawer's overflow control (board.js): one
      // wording, so `show 40` and `show 40 more` are not read as two controls
      const more = el('button', { type: 'button', class: 'btn btn-text', 'data-focus-key': `more:${noun}` }, ['show 40 more'])
      more.addEventListener('click', onMore)
      line.appendChild(more)
    }
    return line
  }

  function renderDrawer() {
    const box = document.getElementById('session-drawer-content')
    if (!box) return
    const inner = takeScroll(box)
    const focus = takeFocus(box)
    const s = drawerSession()
    const d = drawer.detail
    box.textContent = ''
    if (!s) {
      box.appendChild(el('p', { class: 'sentence tone-muted' }, ['This terminal is no longer on the board.']))
      return
    }
    const [label] = STATUS[s.status] || [s.status]
    const controls = el('div', { class: 'cap-line' }, [
      el('span', { class: `acct-name chip-id-${idOf(s.agent)}` }, [s.agent]),
      el('span', { class: 'chip' }, [tail(s.session_id)]),
    ])
    const pause = el('button', { type: 'button', class: 'btn btn-secondary', id: 'session-drawer-pause', 'data-focus-key': 'drawer-pause' }, [drawer.paused ? 'Resume updates' : 'Pause updates'])
    pause.addEventListener('click', () => { drawer.paused = !drawer.paused; if (!drawer.paused) loadDrawer(); else renderDrawer() })
    const close = el('button', { type: 'button', class: 'btn btn-secondary', id: 'session-drawer-close', 'data-focus-key': 'drawer-close' }, ['Close'])
    close.addEventListener('click', closeSessionDrawer)
    controls.append(pause, close)
    box.appendChild(controls)
    if (drawer.error) box.appendChild(el('p', { class: 'sentence tone-danger' }, [drawer.error]))

    const last = d && d.messages ? [...d.messages].reverse().find((m) => m.role === 'assistant') : null
    const now = el('div', { class: 'detail-section' }, [
      el('div', { class: 'well' }, [
        el('div', {}, [`${label}, ${s.turns || 0} turn${s.turns === 1 ? '' : 's'}${s.last_activity ? `, last activity ${clockAt(Date.parse(s.last_activity))}` : ''}`]),
        last ? el('p', { class: 'sentence' }, [last.text]) : el('p', { class: 'sentence tone-muted' }, [d ? 'nothing said yet' : 'reading the transcript']),
      ]),
      // G11: path, branch and transcript in full, never shortened
      whereBlock(s),
      s.worktree ? el('p', { class: 'blocker' }, [`Another terminal was live in this checkout, so this one works in its own worktree and lands by rebasing ${s.worktree.branch} onto ${s.worktree.base || 'its base'}.`]) : null,
      s.usage_error ? el('p', { class: 'blocker' }, [`usage unknown (${s.usage_error}); the limit still hands off`]) : null,
    ])
    box.appendChild(section('Now', drawer.paused ? 'paused' : `every 3 seconds${d ? `, read ${whenAgo(d.ts)}` : ''}`, now))

    box.appendChild(section('Task', 'the prompt this terminal started from',
      el('p', { class: 'drawer-task', 'data-scroll-key': 'task' }, [s.task || 'no prompt yet'])))

    // newest first, here and in the timeline: the region is meant to be left
    // open beside the work, where the thing worth seeing is the last thing that
    // happened, not the oldest one thirty lines up
    const msgs = el('div', {})
    const all = d && d.messages ? d.messages : []
    const turns = all.slice(-drawer.turnCap)
    // the key is the message's own position in the shown transcript, so a new
    // turn arriving does not move every older box's scroll offset onto its
    // neighbour
    if (turns.length) turns.map((m, i) => messageRow(m, m.ts || i)).reverse().forEach((row) => msgs.appendChild(row))
    else msgs.appendChild(el('p', { class: 'sentence tone-muted' }, [d ? 'no transcript for this agent' : 'reading the transcript']))
    if (all.length > turns.length) msgs.appendChild(capLine(turns.length, all.length, 'turns', () => { drawer.turnCap += 40; renderDrawer() }))
    box.appendChild(section('Conversation', `showing ${turns.length} of ${all.length} turns, newest first`, msgs))

    const files = el('div', {})
    const list = (d && d.files) || []
    if (list.length) for (const f of list) files.appendChild(fileRow(f))
    else files.appendChild(el('p', { class: 'sentence tone-muted' }, [d ? 'no files changed yet' : 'reading the file list']))
    box.appendChild(section('Files', list.length ? `${list.length} changed, open one for its diff` : '', files))

    const timeline = el('div', { class: 'drawer-timeline', 'data-scroll-key': 'timeline' })
    const events = (d && d.events) || []
    for (const e of events.slice(-40).reverse()) {
      // clockAt, not a slice of the ISO string: that printed UTC, in 24-hour
      // with seconds, under a page that says `Times are local.` and beside a
      // header on the same panel printing the same instant as 11:04 PM. The
      // summary is a block, as board.js:754 builds the same row, or the kind
      // word and the sentence render glued: `lostrunner pid 999002 is gone`.
      timeline.appendChild(el('div', { class: 'turn' }, [
        el('span', { class: 'mono turn-when' }, [clockAt(Date.parse(e.ts))]),
        el('span', { class: 'turn-role' }, [e.type]),
        el('p', {}, [e.summary || '']),
      ]))
    }
    if (!events.length) timeline.appendChild(el('p', { class: 'sentence tone-muted' }, [d ? 'nothing recorded yet' : 'reading the timeline']))
    const shownEvents = Math.min(events.length, 40)
    const timelineBody = el('div', { class: 'detail-section' }, [timeline])
    if (events.length > shownEvents) timelineBody.appendChild(capLine(shownEvents, events.length, 'events', null))
    box.appendChild(section('Timeline', 'this terminal, newest first', timelineBody))

    const next = el('div', { class: 'detail-section' }, [renderHandoffOrder(s)])
    if (s.bundle) next.appendChild(el('p', { class: 'blocker' }, [`bundle ${s.bundle.id}${s.bundle.at ? `, saved ${whenAgo(s.bundle.at)}` : ''}`]))
    if (d && d.resume) next.appendChild(resumeLine(d.resume))
    box.appendChild(section('What happens next', '', next))
    putScroll(box, inner)
    putFocus(box, focus)
  }

  // ---- the Terminals region ----------------------------------------------
  // A verdict with its volume (G14), counted from the same ranking the panels
  // print, so the head and the rows cannot disagree.
  function terminalsMeta(list, notesOf) {
    const meta = document.querySelector('.region-terminals .region-meta')
    if (!meta) return
    const waiting = list.filter((s) => needsYou(s, notesOf.get(s.session_id) || [])).length
    const running = list.filter((s) => s.active).length
    const landed = list.map((s) => (s.land && s.land.state === 'landed' ? Date.parse(s.land.at || '') : NaN)).filter(Number.isFinite).sort((a, b) => b - a)[0]
    // the verdict alone. The two help sentences that used to follow it here are
    // static, never change, and are printed in the expansion where the handoff
    // order actually is; carrying them in the region head made the one number
    // that moves the tail of a 108-character paragraph. Running comes first so
    // `2 waiting on you, 3 running` is not read as five terminals.
    const verdict = !list.length ? 'nothing is running'
      : waiting ? `${running} running, ${waiting} waiting on you`
        : `${running} running, nothing is waiting on you`
    meta.textContent = `${verdict}${landed ? `, last landed ${clockAt(landed)}` : ''}`
  }

  function renderSessions(v) {
    const focus = takeFocus(document)
    const grid = document.getElementById('session-grid')
    if (!grid) return
    // park the expanded region back on the body before the list is wiped, so it
    // is never orphaned by the rebuild and never loses its own content.
    // Detaching a subtree resets scrollTop on every scrollable box inside it,
    // so a reader half way down a 200-line diff was returned to the top by a
    // rebuild of the list around them. The offsets are read before the move and
    // written back after it, the same contract renderDrawer keeps.
    const region = detailRegion()
    const parked = region ? takeScroll(region) : null
    if (region && region.parentNode === grid) document.body.appendChild(region)
    grid.textContent = ''
    const list = [...v.sessions]
    const notesOf = new Map(list.map((s) => [s.session_id, rankedNotes(s)]))
    const urgent = (s) => needsYou(s, notesOf.get(s.session_id) || [])
    // needs-you first, then started_at ascending. The re-sort every 15 seconds
    // only moves the needs-you partition, so a panel never slides under the
    // cursor for a reason the reader cannot see.
    list.sort((a, b) => (urgent(a) === urgent(b) ? Date.parse(a.started_at) - Date.parse(b.started_at) : urgent(a) ? -1 : 1))
    const empty = document.querySelector('.region-terminals .empty-line')
    if (empty) empty.hidden = list.length > 0
    terminalsMeta(list, notesOf)
    for (const s of list) {
      const panel = renderSession(s)
      grid.appendChild(panel)
      if (drawer.id === s.session_id && region) panel.after(region)
    }
    // every control in a panel is a new element after this rebuild, and the
    // expanded region was moved out and back, which blurs whatever was focused
    // inside it and zeroes every box it could scroll: put the reader back on
    // the control they were on, at the offset they had scrolled to
    if (region && parked) putScroll(region, parked)
    putFocus(document, focus)
  }

  function renderTrunk(v) {
    const box = document.getElementById('trunk')
    if (!box) return
    box.textContent = ''
    const branches = []
    let count = 0
    for (const t of v.trunk || []) {
      if (!t.branch) continue
      branches.push(`${t.repo_name}@${t.branch}`)
      for (const c of t.commits) {
        count++
        const lb = c.landed_by
        const by = lb && lb.by && lb.by !== 'local' ? ` for ${lb.by}` : ''
        box.appendChild(el('div', { class: 'trunk-row' }, [
          el('div', { class: 'r1' }, [el('span', { class: 'mono' }, [c.sha])]),
          el('div', { class: 'r2' }, [c.subject]),
          el('div', { class: 'r3' }, [el('span', { class: 'chip' }, [`${t.repo_name}@${t.branch}`])]),
          el('div', { class: 'r4' }, [lb
            ? el('span', { class: 'landed-by', title: `Land pressed on the card of ${lb.agent} session ${lb.session_id}${by}${Number.isFinite(Date.parse(lb.at)) ? `, ${new Date(lb.at).toLocaleString()}` : ''}` }, [`${c.when}, landed by ${lb.agent} (${tail(lb.session_id)})${by}`])
            : el('span', { class: 'chip' }, [`${c.when}, ${c.author}`])]),
        ]))
      }
    }
    const meta = document.querySelector('.region-trunk .region-meta')
    if (meta) {
      meta.textContent = count
        ? `the last ${count} commit${count === 1 ? '' : 's'} on ${branches.join(', ')}`
        : 'Nothing has landed on main from this board yet. The Land button commits this terminal\'s work, rebases it onto main, runs the tests and fast-forwards.'
    }
  }

  // The elapsed clock ticks every second and the connection word sits in the
  // topbar: between them, liveness is proved by real data and nothing on this
  // board has to pulse to look alive.
  function tickElapsed() {
    for (const node of document.querySelectorAll('[data-elapsed-from]')) {
      const from = Number(node.getAttribute('data-elapsed-from'))
      if (from) node.textContent = elapsedClock(Date.now() - from)
    }
  }

  function render(v) {
    view = v
    const who = document.getElementById('whoami')
    if (who) {
      who.hidden = !(v.share && v.share.on)
      who.textContent = v.share && v.share.on && v.you ? `you are ${v.you.name}${v.you.role === 'owner' ? '' : ', a guest'}, ${v.share.people} on this board` : ''
    }
    renderAccounts(v.accounts || [])
    renderDefaultOrder(v)
    renderSessions(v)
    renderTrunk(v)
    // the panel behind the expansion just changed: status, turns and what is
    // next live in the session view, so redraw the region from it
    if (drawer.id) { if (drawerSession()) renderDrawer(); else closeSessionDrawer() }
  }

  async function refresh() {
    try { render(await api('/api/sessions')) } catch (err) { sysMessage(err.message, 'danger') }
  }

  window.addEventListener('baton:sessions', (e) => render(e.detail))
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (pendingConfirm) { pendingConfirm = null; if (view) renderSessions(view); return }
    if (drawer.id) closeSessionDrawer()
  })
  if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', () => { if (view) renderAccounts(view.accounts || []) })
  window.addEventListener('resize', publishHeadHeight)
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('default-order-save')?.addEventListener('click', saveDefaultOrder)
    renderLoadingHead()
    refresh()
    setInterval(tickElapsed, 1000)
    // the timed re-sort exists to move the needs-you partition, which can wait a
    // few seconds: it stands down mid-selection rather than clearing the drag
    setInterval(() => { if (view && !selectionInsideGrid()) renderSessions(view) }, 15000)
  })
})()
