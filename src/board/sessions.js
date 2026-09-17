// Terminals lane: the window rail (5h/7d per login), the sessions started with
// `leg claude|codex|agy`, overlap flags (two live sessions editing the same
// file), and what has landed on trunk. Data: /api/sessions, pushed as the SSE
// `sessions` event (board.js re-dispatches it as `leg:sessions`).
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
  const IDS = ['claude', 'codex', 'agy', 'grok', 'fake']

  let view = null
  const NO_BRANCH_BLOCKER = 'this terminal works in the checkout itself: there is no branch of its own to land'
  let hoisted = new Set()
  let trunkOpen = false
  let finishedOpen = false
  let pendingConfirm = null
  const sessionEditors = new Map()
  const alsoOpen = new Set()
  const actionNotes = new Map()
  const lastTone = new Map()
  const defaultEditor = { order: null, dirty: false, saving: false, status: '', statusClass: '' }

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

  // 6.9: this page has ONE system message, and it lives in board.js, published
  // as window.batonMessage. A result that belongs to a terminal is written into
  // that terminal's sentence slot instead; only what belongs to no object at all
  // comes through here. This file no longer writes into #toast itself.
  function sysMessage(text, tone) { const fn = window.legMessage || window.batonMessage; if (typeof fn === 'function') fn(text, tone) }

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

  // A pasted screenshot arrives in the prompt as a machine tag carrying an
  // absolute temp path. On the board that is two lines of noise in front of the
  // sentence the reader came to read, and it puts the operator's own home
  // directory on screen. The tag is replaced by what it actually was.
  function promptText(task) {
    if (!task) return 'no prompt yet'
    const cleaned = String(task)
      .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, ' ')
      .replace(/<image\b[^>]*>/gi, ' ')
      .replace(/\[Image #\d+\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) return 'an image, with no text'
    return /^<image/i.test(String(task).trim()) || /\[Image #\d+\]/.test(String(task)) ? `(image) ${cleaned}` : cleaned
  }

  // A file is identified by its name. The directory above it is the same for
  // every file in the list, and when the work happens in a temp directory the
  // full path is 90 characters of noise per file with the operator's user name
  // in the middle of it. The whole path stays on the title and in the detail.
  function fileLabel(path) {
    const parts = String(path).split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] + (/[\\/]$/.test(String(path)) ? '/' : '') : String(path)
  }

  function accountLabel(a) { return a.label || (a.account === 'default' ? a.agent : `${a.agent}/${a.account}`) }
  function optionLabel(a) { return a ? (a.account && a.account !== 'default' ? `${a.agent}/${a.account}` : a.agent) : 'none' }
  function idOf(agent) { return IDS.includes(agent) ? agent : 'fake' }
  const tail = (id) => String(id).split('-').slice(-2).join('-')
  // `leg#7f3a`: the repo this terminal is in and the short id the row prints,
  // which is how a human refers to it out loud and in the verdict.
  const shortId = (s) => tail(s.session_id).replace(new RegExp(`^${s.agent || ''}-`), '')
  const rowName = (s) => `${s.repo_name || s.agent || 'terminal'}#${shortId(s)}`
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
        ? `agy publishes no usage percentage for the ${words} window. Leg sees the wall when agy hits it.`
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

  // The instrument. One track, one fill, one numeral, and a 2px notch cut
  // through the bar where 85 percent sits. `minor` is the second window on a
  // login: the same instrument at half the height and a smaller numeral, so
  // the reader's eye lands on the window that is closest to a wall first.
  function gauge(account, win, kind, { minor = false } = {}) {
    const state = windowState(account, win)
    const pct = state === 'reading' ? Math.max(0, Math.min(100, Math.round(win.pct))) : null
    const words = WIN_WORDS[kind] || kind
    const valueText = railValueText(account, win, kind)
    const id = idOf(account.agent)
    // severity paints INSIDE the track and nowhere else: the fill runs in the
    // login's own identity colour up to 85 percent and in the over colour past
    // it, so the bar shows the reserve it has eaten without colouring a word
    const fill = pct === null ? null : el('span', {
      class: 'gauge-fill',
      style: pct <= 85
        ? `width:${pct}%;background:var(--id-${id})`
        : `width:${pct}%;background:linear-gradient(to right,var(--id-${id}) 0 ${((85 / pct) * 100).toFixed(2)}%,var(--danger) ${((85 / pct) * 100).toFixed(2)}% 100%)`,
    })
    // 6.1.6: a meter with no value is not a meter. aria-valuenow is required by
    // role=meter, and an empty or absent one is announced as zero percent, which
    // is the fabricated reading the visible cell refuses to print. With no value
    // the track drops the role and carries the same sentence as its name.
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
    if (pct === null && state !== 'reading') {
      // no number exists, so no instrument is drawn. A track with nothing in it
      // is a reading of zero to anyone glancing at it.
      return el('div', { class: 'gauge gauge--none' }, [
        el('span', { class: 'gauge-label' }, [words]),
        el('span', { class: 'gauge-read--none', ...semantics }, [state === 'notshared' ? 'not shared' : state === 'loading' ? 'reading' : 'no reading']),
      ])
    }
    const readout = [el('span', { class: 'gauge-read' }, [`${pct}%`])]
    const observed = Date.parse(account.observed_at || account.updated_at || '')
    if (!minor && account.stale && account.agent !== 'agy' && Number.isFinite(observed)) {
      readout.push(el('span', { class: 'gauge-note' }, [`measured ${ago(Date.now() - observed)} ago`]))
    } else if (!minor && win && Number.isFinite(win.resets_at)) {
      readout.push(el('span', { class: 'gauge-note' }, [`resets ${until(win.resets_at)}`]))
    }
    return el('div', { class: `gauge${minor ? ' gauge--minor' : ''}` }, [
      el('span', { class: 'gauge-label' }, [words]),
      el('div', { class: 'gauge-track', ...semantics }, [fill, el('span', { class: 'gauge-post', style: 'left:85%' })]),
      el('div', { class: 'gauge-readout' }, readout),
    ])
  }

  // ---- the binding bucket -------------------------------------------------
  // The bucket that will actually stop the work: the one the endpoint marked
  // active, else the highest percentage it reported, else the legacy hottest of
  // the two windows, which is all an older record or a guest payload carries.
  // Mirrors binding() in src/usage.mjs; the board cannot import from it.
  const BUCKET_WORD = { weekly_scoped: 'week', weekly_all: 'week', session: 'session', spend: 'spend', seven_day: '7d', five_hour: '5h' }
  function bindingOf(a) {
    const buckets = Array.isArray(a && a.buckets) ? a.buckets.filter((b) => b && Number.isFinite(b.percent)) : []
    const top = (l) => (l.length ? [...l].sort((x, y) => y.percent - x.percent)[0] : null)
    const b = top(buckets.filter((x) => x.is_active)) || top(buckets)
    if (b) return { kind: b.kind, model: b.model || null, percent: b.percent, resets_at: Number.isFinite(b.resets_at) ? b.resets_at : null, scope: b.model ? 'model' : 'account' }
    const w = worstWindow(a)
    if (!w || !Number.isFinite(w.pct)) return null
    return { kind: a && a.seven_day === w ? 'seven_day' : 'five_hour', model: null, percent: w.pct, resets_at: Number.isFinite(w.resets_at) ? w.resets_at : null, scope: 'account' }
  }
  // the token's two words: `fable week`, `week`, `session`, `5h`
  function bucketWord(b) { const word = BUCKET_WORD[b.kind] || b.kind; return b.model ? `${b.model} ${word}` : word }
  // the same bucket inside a sentence: "63% of its week"
  function windowPhrase(b) { return b.kind === 'session' ? 'its session' : b.kind === 'five_hour' ? 'its 5 hours' : 'its week' }
  // the account's own window, ignoring any model bucket: what a same-login
  // model rung still has to spend, and what an account wall would take away
  function accountBucket(a) {
    const flat = (Array.isArray(a && a.buckets) ? a.buckets : []).filter((b) => b && !b.model && Number.isFinite(b.percent))
    const b = [...flat].sort((x, y) => y.percent - x.percent)[0]
    if (b) return { kind: b.kind, model: null, percent: b.percent, resets_at: Number.isFinite(b.resets_at) ? b.resets_at : null, scope: 'account' }
    const legacy = bindingOf(a)
    return legacy && !legacy.model ? legacy : null
  }
  const Model = (m) => (m ? String(m).charAt(0).toUpperCase() + String(m).slice(1) : '')
  // every model this login has published anything about. A model named by
  // neither a bucket nor a wall is one Leg has never seen, and it is never
  // guessed at.
  function knownModels(a) {
    const out = []
    for (const b of (a && a.buckets) || []) if (b && b.model && !out.includes(b.model)) out.push(b.model)
    for (const m of Object.keys((a && a.walls) || {})) if (!out.includes(m)) out.push(m)
    return out
  }
  function wallFor(a, model) {
    const w = a && a.walls ? a.walls[model] : null
    return w && Number.isFinite(w.limited_until) && w.limited_until * 1000 > Date.now() ? w : null
  }
  function walledModels(a) { return knownModels(a).filter((m) => wallFor(a, m)) }
  function openModels(a) { return knownModels(a).filter((m) => !wallFor(a, m)) }
  function modelBucket(a, model) {
    return (Array.isArray(a && a.buckets) ? a.buckets : []).find((b) => b && b.model === model && Number.isFinite(b.percent)) || null
  }

  // ---- the capacity strip -------------------------------------------------
  // One 44px band under the verdict, one token per login, and nothing else:
  // usage is a property of the work now, not a region of its own. The panels
  // are not rewritten, they move behind the disclosure at the end of the strip.
  // The token prints the BINDING bucket, because the board printing 47% for a
  // login whose active bucket is at 63% is the defect this strip exists for.
  function capFigure(a, b) {
    // the same two refusals the gauge prints, in the strip's shorter grammar
    if (a.shared === false) return 'not shared'
    if (a.loading) return 'reading'
    if (acctState(a) === 'walled') return Number.isFinite(a.limited_until) ? `back ${until(a.limited_until)}` : 'back when it resets'
    // agy publishes no percentage, ever; a login that has one and has not
    // reported it yet is a different fact and says so.
    if (!b) return a.agent === 'agy' ? 'no figure' : 'no reading'
    const observed = Date.parse(a.observed_at || a.updated_at || '')
    // a reading older than the window it describes prints the clock it was
    // taken at instead of a bucket word: it is a measurement, not a reading now
    if (a.stale && a.agent !== 'agy' && Number.isFinite(observed)) return `${Math.round(b.percent)}% ${clockAt(observed)}`
    return `${Math.round(b.percent)}% ${bucketWord(b)}`
  }
  // the spoken sentence carries what the visible token cannot: the reset, the
  // source, the wall and the age of the reading, exactly as the gauges do.
  function capValueText(a, b) {
    const parts = []
    if (a.shared === false) parts.push(`Usage for ${accountLabel(a)} is not shared with guests.`)
    else if (!b) {
      parts.push(a.agent === 'agy'
        ? 'agy publishes no usage percentage, ever. Leg sees the wall when agy hits it.'
        : `No reading has come back from ${accountLabel(a)} yet.`)
    } else {
      parts.push(`${Math.round(b.percent)} percent of ${b.model ? `the ${b.model} ${BUCKET_WORD[b.kind] || b.kind}` : windowPhrase(b)} used.`)
      if (Number.isFinite(b.resets_at)) parts.push(`Resets at ${until(b.resets_at)}, in ${spoken(b.resets_at * 1000 - Date.now())}.`)
    }
    if (acctState(a) === 'walled') parts.push(`${accountLabel(a)} is at its wall until ${until(a.limited_until)}, in ${spoken(a.limited_until * 1000 - Date.now())}.`)
    for (const m of walledModels(a)) parts.push(`${m} is out until ${until(wallFor(a, m).limited_until)}.`)
    if (a.source) parts.push(`Source: ${a.source}.`)
    const observed = Date.parse(a.observed_at || a.updated_at || '')
    if (a.stale && a.agent !== 'agy' && Number.isFinite(observed)) parts.push(`Read at ${clockAt(observed)}, ${spoken(Date.now() - observed)} ago, stale.`)
    return parts.join(' ')
  }
  function capToken(a) {
    const id = idOf(a.agent)
    const b = bindingOf(a)
    const walled = acctState(a) === 'walled'
    const pct = b ? Math.max(0, Math.min(100, Math.round(b.percent))) : null
    const token = el('span', { class: 'cap-token' }, [
      el('span', { class: `dot id-${id}`, 'aria-hidden': 'true' }),
      el('span', { class: `cap-name id-${id}` }, [accountLabel(a)]),
    ])
    // no number, no instrument. A track with nothing in it is a reading of zero
    // to anyone glancing at it, which is exactly what agy does not have.
    if (pct !== null || walled) {
      const stop = pct !== null && pct > 85 ? `${((85 / pct) * 100).toFixed(2)}%` : null
      const fill = el('span', {
        class: 'cap-fill',
        style: walled ? 'width:100%;background:var(--danger)'
          : stop ? `width:${pct}%;background:linear-gradient(to right,var(--id-${id}) 0 ${stop},var(--danger) ${stop} 100%)`
            : `width:${pct}%;background:var(--id-${id})`,
      })
      // a walled login with no percentage is not a meter: 100 would be a number
      // nobody measured. It keeps the track and carries the sentence instead.
      const semantics = pct === null
        ? { role: 'img', 'aria-label': `${accountLabel(a)} capacity. ${capValueText(a, b)}` }
        : { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${accountLabel(a)} capacity`, 'aria-valuetext': capValueText(a, b) }
      token.appendChild(el('span', { class: 'cap-track', ...semantics }, [fill]))
    }
    // with no track the figure carries the whole sentence itself, the way the
    // gauge's readout does when a window has never been read
    const quiet = pct === null && !walled ? { role: 'img', 'aria-label': `${accountLabel(a)} capacity. ${capValueText(a, b)}` } : {}
    token.appendChild(el('span', { class: `cap-figure${walled ? ' is-out' : ''}${pct === null && !walled ? ' cap-figure--none' : ''}`, ...quiet }, [capFigure(a, b)]))
    return token
  }
  function capacityStrip(list) {
    const box = document.getElementById('capacity-tokens')
    if (!box) return
    box.textContent = ''
    for (const a of list) box.appendChild(capToken(a))
  }

  // The model rail, on the panel head inside the drawer: one chip per model
  // this login has published a bucket or a wall for. A walled model says when
  // it is back, in words, because a wall is attributed from wording and a
  // percentage is measured, and one must never be printed as the other.
  function modelRail(a) {
    const models = knownModels(a)
    if (!models.length) return null
    const rail = el('span', { class: 'model-rail', 'aria-label': `${accountLabel(a)} models` })
    for (const m of models) {
      const wall = wallFor(a, m)
      const b = modelBucket(a, m)
      const text = wall ? `${m} out until ${until(wall.limited_until)}` : b ? `${m} ${Math.round(b.percent)}%` : m
      rail.appendChild(el('span', { class: `model-chip${wall ? ' is-out' : ''}`, title: wall && wall.evidence ? wall.evidence : null }, [text]))
    }
    return rail
  }

  // A login is a raised object, and how much surface it gets is the design
  // saying how much it matters. The login carrying the terminals gets the wide
  // lit panel with both of its windows drawn; a login with one fact to report
  // gets a half panel; a login that publishes no figure draws no instrument at
  // all, because an empty track reads as a measurement of zero.
  function loginPanel(a, { lit = false } = {}) {
    const state = acctState(a)
    const id = idOf(a.agent)
    const panel = el('article', { class: `panel${lit ? ' panel--lit' : ''}`, 'aria-label': `${accountLabel(a)} usage` })
    const live = a.live ? `${a.live} terminal${a.live === 1 ? '' : 's'} working` : 'no terminals'
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('span', { class: 'who' }, [el('span', { class: `dot id-${id}` }), el('span', { class: `acct-name id-${id}` }, [accountLabel(a)])]),
      el('span', { class: 'who-note' }, [live]),
      // one chip per model this login has published a bucket or a wall for
      modelRail(a),
    ]))

    if (state === 'notshared' || state === 'loading') {
      panel.appendChild(gauge(a, null, '5h'))
      panel.appendChild(el('p', { class: 'reading-sub reading-sub--lead' }, [state === 'notshared' ? 'Usage for this login is not shared with guests.' : 'Waiting for the first reading.']))
      return panel
    }

    // A login at its wall is reporting the loudest fact it has, and it is a
    // known one: say that instead of "no reading", whether or not a percentage
    // ever came back.
    if (state === 'walled' && !a.five_hour && !a.seven_day) {
      panel.appendChild(el('p', { class: 'reading' }, ['At the wall']))
      panel.appendChild(el('p', { class: 'reading-sub' }, [Number.isFinite(a.limited_until)
        ? `Back ${until(a.limited_until)}. Nothing runs on ${accountLabel(a)} until then.`
        : `Nothing runs on ${accountLabel(a)} until it resets.`]))
      return panel
    }

    // agy publishes no usage figure, ever, so there is nothing to draw and the
    // panel says so in a sentence instead of drawing an empty instrument
    if (!a.five_hour && !a.seven_day) {
      panel.appendChild(gauge(a, null, '5h'))
      panel.appendChild(el('p', { class: 'reading-sub reading-sub--lead' }, [a.agent === 'agy'
        ? 'agy publishes no usage figure, ever. Leg shows its terminals and their elapsed time instead.'
        : `No reading has come back from ${accountLabel(a)} yet.`]))
      return panel
    }

    // the window closest to a wall is drawn first and full size; the other is
    // the same instrument at half height, so which one to read is not a question
    const [first, second] = [a.seven_day, a.five_hour].every((w) => w && Number.isFinite(w.pct))
      ? (a.seven_day.pct >= a.five_hour.pct ? [[a.seven_day, '7d'], [a.five_hour, '5h']] : [[a.five_hour, '5h'], [a.seven_day, '7d']])
      : [[a.five_hour && Number.isFinite(a.five_hour.pct) ? a.five_hour : a.seven_day, a.five_hour && Number.isFinite(a.five_hour.pct) ? '5h' : '7d'], null]
    panel.appendChild(el('div', { class: 'gauge-block' }, [gauge(a, first[0], first[1])]))
    if (second) panel.appendChild(el('div', { class: 'gauge-block' }, [gauge(a, second[0], second[1], { minor: true })]))

    if (state === 'walled') {
      panel.appendChild(el('p', { class: 'reading' }, ['At the wall']))
      panel.appendChild(el('p', { class: 'reading-sub' }, [`Back ${until(a.limited_until)}. Nothing runs on ${accountLabel(a)} until then.`]))
    }
    return panel
  }

  // The headline is the one fact that decides what happens next, said as a
  // sentence. It is never the number that the strip under it already prints:
  // the same figure in the two largest slots on the page is one fact taking up
  // two, which is what the rejected head did.
  //
  // VERDICT_CH is a MEASUREMENT, not a taste: at 1280 the verdict column is
  // 26ch (891px) and 300 random sentences per length, drawn from this table's
  // own vocabulary, still fit two 56.16px lines at 60 characters. 56 is that
  // ceiling with four characters of slack for a longer login name, and
  // test/board-verdict.test.mjs holds every branch under it.
  const VERDICT_CH = 56
  // the sub is two lines of 17px inside `max-width: 54ch`, which is about 120
  // characters; clauses are added while they fit and dropped whole after that.
  const SUB_CH = 120
  // Each headline is written as a preferred form and shorter fallbacks, so a
  // login called `claude/very-long-account` costs a clause, never a third line.
  function headline(...forms) {
    const real = forms.filter(Boolean)
    for (const f of real) if (f.length <= VERDICT_CH) return f
    const last = String(real[real.length - 1] || '')
    const cut = last.slice(0, VERDICT_CH - 1)
    const space = cut.lastIndexOf(' ')
    return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[,.;:]$/, '')}.`
  }
  function subLine(...parts) {
    const out = []
    for (const p of parts.filter(Boolean)) {
      const next = out.concat(p).join(' ')
      if (next.length <= SUB_CH) out.push(p)
    }
    return out.join(' ')
  }

  // A.5, top to bottom. A bucket whose state is unknown is never named, and
  // "Measured Ns ago" appears only when the reading is actually stale.
  function verdictLines(list, sessions) {
    const accounts = (list || []).filter((a) => a && a.agent && !a.loading)
    if (!accounts.length) return { line: 'Reading the logins.', sub: '' }
    const live = (sessions || []).filter((s) => s.active)
    const acctOf = (s) => accounts.find((a) => a.agent === s.agent && (a.account || 'default') === (s.account || 'default'))
    const liveOn = (a) => live.filter((s) => acctOf(s) === a).length
    const walled = accounts.filter((a) => acctState(a) === 'walled')
    const carrying = accounts.filter((a) => liveOn(a) > 0)
    const subject = (carrying.length ? closestToWall(carrying) : closestToWall(accounts)) || accounts[0]
    const b = bindingOf(subject)
    const other = (a) => accounts.filter((x) => x !== a)
    const openElsewhere = other(subject).filter((a) => acctState(a) !== 'walled')
    const leftOf = (bb) => Math.max(0, 100 - Math.round(bb.percent))
    const figure = (a) => { const bb = bindingOf(a); return bb ? (bb.model ? `${accountLabel(a)} is at ${Math.round(bb.percent)}% of the ${Model(bb.model)} week.` : `${accountLabel(a)} is at ${Math.round(bb.percent)}% of ${windowPhrase(bb)}.`) : null }
    const wallClause = (a) => (Number.isFinite(a.limited_until) ? `${accountLabel(a)} is at its limit until ${until(a.limited_until)}.` : `${accountLabel(a)} is at its limit.`)
    const otherWalls = () => walled.filter((a) => a !== subject).map(wallClause).join(' ') || null
    // a reading taken two hours ago with terminals running since is a floor,
    // not a measurement, and the direction it is wrong in is the whole point
    const staleClause = (a, bb) => {
      const observed = Date.parse((a && (a.observed_at || a.updated_at)) || '')
      if (!a || !a.stale || a.agent === 'agy' || !Number.isFinite(observed) || !bb) return null
      const n = liveOn(a)
      if (!n) return `Measured ${ago(Date.now() - observed)} ago.`
      return `Measured ${ago(Date.now() - observed)} ago. ${n} terminal${n === 1 ? ' runs' : 's run'} on it, so the real figure is higher, never lower.`
    }

    // 1. a human is blocked. Attention is the scarcer thing, so it outranks
    // usage. `waiting` carries {type, message, since} from the Notification
    // hook (step 5); the older reset-waiting field on the same name carries
    // {agent, account, resets_at} and is not this, so the shape is checked.
    const blocked = live
      .filter((s) => s.waiting && s.waiting.type && s.waiting.since && Number.isFinite(Date.parse(s.waiting.since)))
      .sort((x, y) => Date.parse(x.waiting.since) - Date.parse(y.waiting.since))[0]
    if (blocked) {
      const who = rowName(blocked)
      const waited = spoken(Date.now() - Date.parse(blocked.waiting.since))
      const others = live.length - 1
      return {
        line: headline(`${who} has waited on you for ${waited}.`, `${who} has waited on you for ${ago(Date.now() - Date.parse(blocked.waiting.since))}.`, `${who} is waiting on you.`),
        sub: subLine(
          blocked.waiting.message ? `It asked to run ${String(blocked.waiting.message).slice(0, 80)}.` : null,
          others > 0 ? `The other ${others === 1 ? 'terminal is' : `${others} terminals are`} still running.` : null,
        ),
      }
    }

    // 2. every login at its limit: nothing anywhere can be started, whatever
    // is running. Said before the per-login branches because it is the whole
    // board's state, not this login's.
    if (walled.length === accounts.length && walled.length > 1) {
      const first = [...walled].sort((x, y) => (x.limited_until || Infinity) - (y.limited_until || Infinity))[0]
      return {
        line: headline(`Every login is at its limit; ${accountLabel(first)} is back first.`, `Every login is at its limit.`),
        sub: subLine(Number.isFinite(first.limited_until) ? `${accountLabel(first)} returns ${until(first.limited_until)}.` : null),
      }
    }

    if (live.length) {
      // 3. an account-scoped bucket binds, and this login has model rungs that
      // therefore buy nothing. Only said where models are KNOWN: on a login
      // with no model buckets there is no switch to warn anyone off.
      if (b && b.scope === 'account' && knownModels(subject).length) {
        const alt = openModels(subject)[0]
        const next = openElsewhere[0]
        return {
          line: headline(`${accountLabel(subject)} has ${leftOf(b)}% left, shared by every model.`, `${accountLabel(subject)} has ${leftOf(b)}% left, for every model.`),
          sub: subLine(
            alt ? `Switching to ${alt} buys nothing.` : null,
            next ? `Next off ${accountLabel(subject)}: ${accountLabel(next)}.` : 'Nothing else is open.',
            staleClause(subject, b),
          ),
        }
      }

      // 4. a model bucket is walled while the account window is open: the one
      // case where a same-login switch is the answer.
      const out = acctState(subject) === 'walled' ? [] : walledModels(subject)
      if (out.length) {
        const wall = wallFor(subject, out[0])
        const open = openModels(subject)[0]
        const acct = accountBucket(subject)
        return {
          line: headline(
            `${Model(out[0])} is out until ${until(wall.limited_until)}; ${open || 'no other model'} is open.`,
            `${Model(out[0])} is out until ${until(wall.limited_until)}.`,
          ),
          sub: subLine(
            acct ? `${accountLabel(subject)} still has ${leftOf(acct)}% of ${windowPhrase(acct)}.` : null,
            open ? `Hand off > ${subject.agent}/${open} keeps this terminal.` : null,
          ),
        }
      }

      // 5. one login carries every live terminal: one login, one point of
      // failure, and that is what the sentence says.
      if (carrying.length === 1 && b) {
        const who = b.model ? Model(b.model) : accountLabel(subject)
        return {
          line: headline(
            `${who} is at ${Math.round(b.percent)}% of ${windowPhrase(b)}, the only login open.`,
            `${who} is at ${Math.round(b.percent)}% of ${windowPhrase(b)}.`,
          ),
          sub: subLine(staleClause(subject, b), otherWalls()),
        }
      }

      // 6. several logins carry work: name the one closest to a wall, and the
      // volume, then put the next login's figure in the sub.
      if (b) {
        const second = other(subject).map(figure).filter(Boolean)[0]
        return {
          line: headline(
            `${accountLabel(subject)} has ${leftOf(b)}% left, and ${live.length} terminal${live.length === 1 ? ' is' : 's are'} working.`,
            `${accountLabel(subject)} has ${leftOf(b)}% left.`,
          ),
          sub: subLine(second, staleClause(subject, b), otherWalls()),
        }
      }

      // live, and not one login has published a figure. Never a guess.
      return {
        line: headline(`${live.length} terminal${live.length === 1 ? ' is' : 's are'} working, and no login has a figure.`, `${live.length} terminal${live.length === 1 ? ' is' : 's are'} working.`),
        sub: subLine(otherWalls(), 'No login has reported a usage figure yet.'),
      }
    }

    // 7 to 9. nothing is running.
    const bestOpen = openElsewhere.concat(acctState(subject) === 'walled' ? [] : [subject]).map((a) => ({ a, b: bindingOf(a) })).filter((x) => x.b).sort((x, y) => y.b.percent - x.b.percent)[0]
    const openLine = bestOpen ? `${bestOpen.b.model ? Model(bestOpen.b.model) : accountLabel(bestOpen.a)} is at ${Math.round(bestOpen.b.percent)}% of ${windowPhrase(bestOpen.b)}.` : null
    if (walled.length) {
      const first = [...walled].sort((x, y) => (x.limited_until || Infinity) - (y.limited_until || Infinity))[0]
      return {
        line: headline(
          `Nothing is running. ${accountLabel(first)} is back ${until(first.limited_until)}.`,
          `Nothing is running. ${accountLabel(first)} is at its limit.`,
        ),
        sub: subLine(openLine),
      }
    }
    if (bestOpen) return { line: headline(`Nothing is running. ${openLine}`, 'Nothing is running.'), sub: '' }
    return { line: 'Nothing is running, and no login has a figure.', sub: '' }
  }

  // The login panels are behind one disclosure now, and whether it is open is
  // the reader's decision, kept across reloads. localStorage throws in a
  // private window and on a board opened from a file, so it is never load
  // bearing: the strip and the panels both render either way.
  const CAP_KEY = 'legCapacityOpen'
  let capacityOpen = (() => { try { return localStorage.getItem(CAP_KEY) === '1' } catch { return false } })()
  function renderCapacityToggle() {
    const btn = document.getElementById('capacity-toggle')
    const drawer = document.getElementById('capacity-drawer')
    if (btn) {
      btn.setAttribute('aria-expanded', capacityOpen ? 'true' : 'false')
      btn.textContent = capacityOpen ? 'Hide capacity and models' : 'Capacity and models >'
    }
    if (drawer) drawer.hidden = !capacityOpen
  }
  function toggleCapacity() {
    capacityOpen = !capacityOpen
    try { localStorage.setItem(CAP_KEY, capacityOpen ? '1' : '0') } catch { /* private window: the drawer still opens, it just does not remember */ }
    renderCapacityToggle()
  }

  // 6.1.5, all eight states. The walled state is an ADDITIONAL state of the
  // rail, never a replacement for it: both percentages, both reset times and
  // both rails stay on screen while the account is at its wall, and R4 grows.
  function renderAccounts(accounts) {
    const box = document.getElementById('accounts')
    if (!box) return
    box.textContent = ''
    const list = accounts || []

    const { line, sub } = verdictLines(list, view ? view.sessions : [])
    const h1 = document.getElementById('verdict-line')
    const p = document.getElementById('verdict-sub')
    if (h1) h1.textContent = line
    if (p) p.textContent = sub
    // the strip is the only usage on screen until the reader opens the drawer
    capacityStrip(list)
    renderCapacityToggle()

    if (!list.length) return
    // Size encodes importance. The login the terminals are on gets the wide lit
    // panel; the rest share the row beneath it. When every login is idle the
    // one closest to a wall leads, because that is the one that decides whether
    // the next terminal can start.
    const liveSessions = (view ? view.sessions || [] : []).filter((s) => s.active)
    const lead = (liveSessions.length && list.find((a) => a.agent === liveSessions[0].agent)) || closestToWall(list) || list[0]
    const rest = list.filter((a) => a !== lead)
    box.appendChild(loginPanel(lead, { lit: true }))
    if (rest.length === 1) box.appendChild(loginPanel(rest[0]))
    else if (rest.length) box.appendChild(el('div', { class: 'logins-pair' }, rest.map((a) => loginPanel(a))))
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
  async function act(id, action, btn, body = null) {
    btn.disabled = true
    actionNotes.delete(id)
    try {
      if (action.startsWith('requests/')) {
        await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body })
        actionNotes.set(id, { at: Date.now(), tone: 'ok', text: action.endsWith('approve') ? 'approved; this terminal hands off in a few seconds' : 'the request was dismissed' })
      } else if (action === 'request-handoff') {
        await api(`/api/sessions/${encodeURIComponent(id)}/request-handoff`, { method: 'POST', body })
        sysMessage('asked; the owner of that terminal decides', 'ok')
      } else if (action === 'remove') {
        const r = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        sysMessage(r.worktree ? (r.worktree.removed ? (r.worktree.branchDeleted === false ? 'removed the terminal and its worktree; the branch is kept' : 'removed the terminal, its worktree and its branch') : `removed the terminal; the worktree is kept: ${r.worktree.reason}`) : 'removed the terminal', 'ok')
      } else if (action === 'remove-record') {
        await api(`/api/sessions/${encodeURIComponent(id)}?force=1&keep_worktree=1`, { method: 'DELETE' })
        sysMessage('removed the Leg record; the worktree and the branch are kept', 'ok')
      } else {
        await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body })
        if (action === 'handoff') actionNotes.set(id, { at: Date.now(), tone: 'warn', text: body && body.agent ? `hand-off to ${optionLabel(body)} requested; this terminal switches agents in a few seconds` : 'hand-off requested; this terminal switches agents in a few seconds' })
        else if (action === 'end') actionNotes.set(id, { at: Date.now(), tone: 'warn', text: 'end requested; the agent stops after its current turn' })
        else if (action === 'land/fix') actionNotes.set(id, { at: Date.now(), tone: 'ok', text: 'applied fix' })
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
    else if (!s.eligible_next) wrap.appendChild(el('p', { class: 'sentence tone-warn' }, [`preferred: ${preferred}. No fallback is eligible now; Leg waits if every account is at its limit.`]))
    else if (eligible !== preferred) wrap.appendChild(el('p', { class: 'sentence tone-muted' }, [`preferred: ${preferred}, first eligible now: ${eligible}`]))
    else wrap.appendChild(el('p', { class: 'sentence tone-muted' }, [`first eligible now: ${eligible}`]))
    wrap.appendChild(el('p', { class: 'blocker' }, ['Used after a usage limit or Hand off now. A normal exit ends this terminal.']))

    // The picker. The Hand off now button on the panel stays the one-click
    // path (it takes the order); this names a destination instead. An option
    // that cannot be picked carries the reason in its own label, so nothing is
    // greyed out without saying why.
    const targets = Array.isArray(s.handoff_targets) ? s.handoff_targets : []
    if (s.active && targets.length) {
      const pick = el('div', { class: 'form-row' })
      const selectId = `handoff-to-${s.session_id}`
      pick.appendChild(el('label', { for: selectId }, ['Hand off now to']))
      const select = el('select', { id: selectId })
      select.appendChild(el('option', { value: '' }, ['the next option in the order']))
      targets.forEach((t, i) => {
        const note = t.available ? '' : ` — ${t.reason}${Number.isFinite(t.resets_at) ? `, back ${until(t.resets_at)}` : ''}`
        // the index is the value: an account name is not ours to parse
        select.appendChild(el('option', { value: String(i), disabled: t.available ? null : 'disabled' }, [optionLabel(t) + note]))
      })
      const go = el('button', { type: 'button', class: 'btn btn-secondary' }, ['Hand off'])
      go.addEventListener('click', () => {
        const t = select.value === '' ? null : targets[Number(select.value)]
        act(s.session_id, 'handoff', go, t ? { agent: t.agent, account: t.account } : null)
      })
      pick.appendChild(el('div', { class: 'chain-rail' }, [select, go]))
      if (!targets.some((t) => t.available)) {
        pick.appendChild(el('p', { class: 'field-help' }, ['Every destination is at its limit or not installed; a hand-off now waits for the first reset.']))
      }
      wrap.appendChild(pick)
    }

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

  // One terminal, as a row inside the terminals panel rather than a card of its
  // own. Cards made every terminal the same size whatever it was doing; a row
  // lets the panel carry the group and leaves elevation free to mean one thing.
  // Reading order across the row is what it is doing, what it is working on,
  // how long it has been at it, and what you can do about it.
  function renderSession(s) {
    const notes = rankedNotes(s)
    const urgent = needsYou(s, notes)
    // the article is named so the accessibility tree does not hand the reader
    // three identical triples of Land / Hand off now / Details / End
    const term = el('article', { class: `term${urgent ? ' is-urgent' : ''}`, 'data-session-id': s.session_id, 'aria-label': `${s.agent} ${tail(s.session_id)}` })
    const row = el('div', { class: 'term-row' })
    const body = el('div', { class: 'term-body' })

    // The register is the caption for the prompt underneath, not a column of
    // its own: state first, then where the work is, then anything unusual about
    // this terminal. One line, meta colour, the smallest type on the board.
    const branch = s.worktree ? s.worktree.branch : s.branch
    const register = el('div', { class: 'term-register' }, [
      statusMark(s.status, s.session_id, urgent ? 'waiting on you' : null),
      el('span', { class: 'term-where', title: s.cwd || null }, [`${s.repo_name || s.cwd || 'unknown repo'}${branch ? ` on ${branch}` : ''}`]),
    ])
    if (s.account !== 'default') register.appendChild(el('span', { class: 'chip' }, [s.account]))
    if (shared() && s.owner) register.appendChild(el('span', { class: 'chip' }, [isMine(s) ? `${s.owner}, you` : s.owner]))
    if (s.lineage && s.lineage.from) register.appendChild(el('span', { class: 'chip' }, [`from ${s.lineage.from}`]))
    if (s.worktree) register.appendChild(el('span', { class: 'chip' }, [`own worktree, from ${s.worktree.base || 'a detached HEAD'}`]))
    if (s.has_synthesis) register.appendChild(el('span', { class: 'chip', title: 'synthesis record active' }, ['synthesis']))
    // the portable harness, one word: what this leg's client received from the
    // source harness (src/harness/index.mjs STATES); nothing when the feature is off
    const hb = harnessBadge(s.harness)
    if (hb) register.appendChild(el('span', { class: hb.cls, title: hb.title }, [hb.text]))
    body.appendChild(register)

    if (s.hidden) body.appendChild(el('p', { class: 'term-prompt term-prompt--empty' }, ['prompt hidden']))
    else {
      // a real <button>, so Enter, Space, the focus ring and touch all come free
      const prompt = el('button', { type: 'button', class: `panel-prompt${s.task ? '' : ' term-prompt--empty'}`, title: s.task || 'no prompt yet', 'aria-expanded': drawer.id === s.session_id ? 'true' : 'false', 'data-focus-key': `prompt:${s.session_id}` }, [promptText(s.task)])
      prompt.addEventListener('click', () => (drawer.id === s.session_id ? closeSessionDrawer() : openSessionDrawer(s.session_id, 'prompt')))
      body.appendChild(prompt)
    }

    // Exactly one sentence, the highest-ranked note. A terminal that is merely
    // running has nothing to say that its own row does not already show, and
    // four rows each saying "activity" is four lines of noise that make the one
    // row with something real to say harder to find. The sentence is kept for a
    // row that needs the reader, and for anything not simply running.
    const own = notes.filter((n) => !hoisted.has(n.text))
    const quiet = !urgent && own[0] && own[0].tone === 'muted'
    if (own[0] && !quiet) body.appendChild(el('p', { class: `sentence tone-${own[0].tone}` }, [own[0].text]))
    const rest = quiet ? [] : own.slice(1)
    if (rest.length) {
      // G3: the demoted notes are NAMED, never counted. "2 more" tells the
      // reader nothing about whether the thing behind it matters.
      const open = alsoOpen.has(s.session_id)
      // `btn` is what zeroes the native button chrome; `btn-text` alone shipped
      // the browser's grey bevelled box, label at 2.19:1 and invisible on hover
      const also = el('button', { type: 'button', class: 'btn btn-text also', 'aria-expanded': open ? 'true' : 'false', 'data-focus-key': `also:${s.session_id}` }, [`also: ${rest.map((n) => n.cat).join(', ')}`])
      also.addEventListener('click', () => { if (open) alsoOpen.delete(s.session_id); else alsoOpen.add(s.session_id); renderSessions(view) })
      body.appendChild(also)
      if (open) for (const n of rest) body.appendChild(el('p', { class: `sentence tone-${n.tone}` }, [n.text]))
    }
    const touched = s.files || []
    if (!s.hidden && touched.length) {
      // comma-separated text, not chips: six file names are a sentence, and a
      // file that is also in an overlap is named in that sentence anyway
      const overlapFiles = new Set((s.overlap || []).flatMap((o) => o.files))
      const line = el('p', { class: 'files' })
      touched.slice(0, 6).forEach((f, i) => {
        if (i) line.appendChild(document.createTextNode(', '))
        line.appendChild(el('span', { class: `file${overlapFiles.has(f) ? ' is-overlap' : ''}`, title: f }, [fileLabel(f)]))
      })
      if (touched.length > 6) line.appendChild(document.createTextNode(`, and ${touched.length - 6} more`))
      body.appendChild(line)
    }
    row.appendChild(body)

    // elapsed and the short id, right-aligned and small: the two facts you scan
    // down the column rather than read
    row.appendChild(el('div', { class: 'term-clock' }, [
      el('span', { class: 'term-when elapsed', 'data-elapsed-from': String(Date.parse(s.started_at) || 0), 'data-elapsed-format': 'compact', title: `started ${new Date(s.started_at).toLocaleString()}` }, [ago(s.elapsed_ms)]),
      // the tail is `codex-99ab`, printed immediately after the word `codex`:
      // the prefix is the agent name twice, and it is the half that squeezed
      // the state word out of the identity column on a one-line row
      el('span', { class: 'term-id', title: s.session_id }, [tail(s.session_id).replace(new RegExp(`^${s.agent}-`), '')]),
    ]))

    if (pendingConfirm && pendingConfirm.id === s.session_id) {
      // Snapshot it: confirmRow clears pendingConfirm before it calls back, so
      // a callback that read the variable instead of this value dereferenced
      // null and threw on the way to act(). That was every Yes on this page —
      // Remove, Remove record, End and Land all did nothing, with the
      // TypeError going only to the console.
      const pending = pendingConfirm
      term.appendChild(row)
      term.appendChild(confirmRow(pending.question, pending.verb, (btn) => act(s.session_id, pending.action, btn)))
      return term
    }
    const actions = el('div', { class: 'term-actions' })
    const ask = (question, verb, action) => () => { pendingConfirm = { id: s.session_id, question, verb, action }; renderSessions(view) }
    if (s.hidden) {
      if (s.active) {
        const q = el('button', { type: 'button', class: 'btn btn-secondary', title: `ask ${s.owner || 'the owner'} to hand this terminal off; they approve it on their own board` }, ['Request handoff'])
        q.addEventListener('click', () => act(s.session_id, 'request-handoff', q))
        actions.appendChild(q)
      }
      row.appendChild(actions)
      term.appendChild(row)
      return term
    }
    // G10: the order is Land, Hand off now, Details, End, and it never reflows
    // by availability. A button that does not apply is omitted, never moved.
    const landing = Boolean(s.land && s.land.state === 'landing')
    const cl = s.can_land || (s.worktree ? (s.land_blocker ? { ok: false, blockers: [{ code: 'legacy', message: s.land_blocker }] } : { ok: true, blockers: [] }) : { ok: false, blockers: [{ code: 'no_worktree', message: NO_BRANCH_BLOCKER }] })
    const isOnTarget = cl.blockers && cl.blockers.some((b) => b.code === 'on_target_branch')
    const targetLocked = cl.blockers && cl.blockers.find((b) => b.code === 'target_locked')
    const blocker = !cl.ok ? (cl.blockers[0]?.message || NO_BRANCH_BLOCKER) : null
    const blockerId = blocker ? `land-blocker-${s.session_id}` : null

    if (isOnTarget) {
      const commitDirect = el('button', {
        type: 'button',
        class: 'btn btn-secondary',
        'data-focus-key': `commit-direct:${s.session_id}`,
        title: `Commit directly on ${s.branch || s.worktree?.base || 'main'}`,
      }, ['Commit directly'])
      commitDirect.addEventListener('click', () => act(s.session_id, 'land/fix', commitDirect, { action: 'commit_directly' }))
      actions.appendChild(commitDirect)
    } else {
      const landLabel = landing ? 'Landing…' : targetLocked ? targetLocked.message : 'Land'
      const landDisabled = !cl.ok || landing
      const land = el('button', {
        type: 'button',
        class: `btn ${landDisabled ? 'btn-secondary' : 'btn-primary'}${landing ? ' is-loading' : ''}`,
        disabled: landDisabled ? '' : null,
        'data-focus-key': `land:${s.session_id}`,
        'aria-describedby': blockerId,
        title: blocker || (s.worktree ? `commit work on ${s.worktree.branch}, rebase onto ${s.worktree.base}, test, and fast-forward ${s.worktree.base}` : 'Land'),
      }, [landLabel])
      if (!landDisabled) {
        land.addEventListener('click', async () => {
          land.disabled = true
          land.classList.add('is-loading')
          land.textContent = 'Preparing…'
          try {
            const res = await api(`/api/sessions/${encodeURIComponent(s.session_id)}/land/prepare`, { method: 'POST' })
            land.classList.remove('is-loading')
            if (!res.ok) {
              actionNotes.set(s.session_id, { at: Date.now(), tone: 'danger', text: res.error || 'Prepare failed' })
              refresh()
              return
            }
            const statText = res.diff_stat || `${res.files?.length || 0} files changed`
            const question = `Prepared: ${statText} · tests green. Land onto ${s.worktree?.base || 'main'} and ship to GitHub?`
            pendingConfirm = {
              id: s.session_id,
              question,
              verb: 'Land',
              action: 'land',
            }
            renderSessions(view)
          } catch (err) {
            land.classList.remove('is-loading')
            actionNotes.set(s.session_id, { at: Date.now(), tone: 'danger', text: err.message })
            refresh()
          }
        })
      }
      actions.appendChild(land)
    }
    if (s.active) {
      const h = el('button', { type: 'button', class: `btn ${blocker ? 'btn-primary' : 'btn-secondary'}`, title: 'save the bundle, stop this agent, start the next option in the same terminal', 'data-focus-key': `handoff:${s.session_id}` }, ['Hand off now'])
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
        : 'Remove this terminal? Leg\'s record of it is deleted.', 'Remove', 'remove'))
      actions.appendChild(r)
      if (s.worktree) {
        const keep = el('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `remove-record:${s.session_id}` }, ['Remove record'])
        keep.addEventListener('click', ask(`Remove only the Leg record for ${s.session_id}? The worktree at ${s.worktree.path} and the branch ${s.worktree.branch} stay, with every commit.`, 'Remove record', 'remove-record'))
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
    row.appendChild(actions)
    term.appendChild(row)

    // Why can't I land expander or fallback blocker message
    if (!cl.ok && !isOnTarget && s.worktree) {
      const list = el('ul', { class: 'blocker-list' })
      for (const b of cl.blockers) {
        const item = el('li', { class: 'blocker-item' })
        item.appendChild(el('span', { class: 'blocker-msg' }, [b.message]))
        const fixes = b.fixes || (b.fix ? [b.fix] : [])
        if (fixes.length) {
          const grp = el('span', { class: 'blocker-fixes' })
          for (const f of fixes) {
            const fBtn = el('button', { type: 'button', class: 'btn btn-sm btn-secondary', title: f.label }, [f.label])
            fBtn.addEventListener('click', () => act(s.session_id, 'land/fix', fBtn, { action: f.action, target_session: f.target_session }))
            grp.appendChild(fBtn)
          }
          item.appendChild(grp)
        }
        list.appendChild(item)
      }
      const expander = el('details', { class: 'why-cant-land', id: blockerId }, [
        el('summary', { class: 'why-cant-land-summary' }, ["Why can't I land?"]),
        list,
      ])
      term.appendChild(expander)
    } else if (blocker) {
      term.appendChild(el('p', { class: 'blocker', id: blockerId }, [blocker]))
    }
    return term
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
    const isUser = m.role === 'user'
    return el('div', { class: `turn drawer-msg ${isUser ? 'is-human' : 'is-agent'}` }, [
      el('div', { class: 'drawer-msg-head' }, [
        el('span', { class: `turn-role drawer-msg-role ${isUser ? '' : 'chip-state-ok'}` }, [isUser ? 'human' : 'agent']),
        m.ts ? el('span', { class: 'turn-when drawer-msg-when' }, [whenAgo(m.ts)]) : null,
      ]),
      // every box that can scroll carries a key, so where the reader had
      // scrolled to survives the rebuild three seconds later
      el('p', { 'data-scroll-key': `msg:${key}` }, [m.text]),
    ])
  }

  function fileRow(f) {
    const wrap = el('div', { class: 'drawer-file-item' })
    const pre = el('pre', { class: 'drawer-diff', hidden: '', 'data-scroll-key': `diff:${f.path}` })
    const row = el('button', { type: 'button', class: 'btn btn-text file-row', 'aria-expanded': 'false', 'data-focus-key': `file:${f.path}` }, [
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
          ? 'RESUME.md carries no Leg stamp, so its freshness cannot be checked'
          : `RESUME.md is stale: ${v.reasons.join('; ')}`
    return el('p', { class: cls, title: 'freshness is recomputed from git on every poll; leg resume --check' }, [text])
  }

  // ---- the portable harness ----
  // Every word here comes from the outcome the session recorded when the leg
  // started (src/harness/index.mjs prepareHarnessForHandoff), never from a guess.
  const HARNESS_WORD = { synced: 'harness synced', partial: 'harness partial', stale: 'harness stale', attention: 'harness attention', blocked: 'harness refused', error: 'harness error', unsupported: 'harness unsupported', source: 'harness source' }
  function harnessBadge(h) {
    if (!h || h.state === 'off' || h.state === 'same-client') return null
    const text = HARNESS_WORD[h.state] || `harness ${h.state}`
    const cls = h.state === 'synced' || h.state === 'partial' || h.state === 'source' ? 'chip chip-state-ok' : h.state === 'unsupported' ? 'chip' : 'chip is-stale'
    return { text, cls, title: h.summary || text }
  }

  function harnessSection(s, d) {
    const h = (d && d.harness) || s.harness
    if (!h || h.state === 'off') return null
    const box = el('div', { class: 'detail-section' })
    const src = h.source ? `${h.source}` : 'unknown'
    const captured = h.captured_at ? `captured ${whenAgo(h.captured_at)}` : 'not captured'
    const head = h.state === 'same-client'
      ? `${h.to} to ${h.to}: same client, same harness`
      : h.state === 'source' ? `${h.target} is the source of the harness; nothing to carry`
        : `source ${src}, ${captured}${h.synced_at ? `, synced ${whenAgo(h.synced_at)}` : ''}${h.policy ? `, policy ${h.policy}` : ''}`
    box.appendChild(el('div', { class: 'well' }, [
      el('div', {}, [head]),
      h.summary && h.state !== 'same-client' && h.state !== 'source' ? el('p', { class: `sentence ${h.state === 'synced' || h.state === 'partial' ? 'tone-ok' : h.state === 'unsupported' ? 'tone-muted' : 'tone-warn'}` }, [h.summary]) : null,
      h.reason && (h.state === 'blocked' || h.state === 'error' || h.state === 'unsupported') ? el('p', { class: 'blocker' }, [h.reason]) : null,
    ]))
    if (h.components) {
      const rows = el('div', { class: 'drawer-timeline' })
      for (const [name, c] of Object.entries(h.components)) {
        const count = c.total !== null && c.total !== undefined ? `${c.carried} / ${c.total}` : ''
        rows.appendChild(el('div', { class: 'turn timeline-item' }, [
          el('span', { class: 'mono turn-when' }, [name]),
          el('span', { class: 'turn-role' }, [c.state]),
          el('p', { class: 'timeline-summary' }, [`${count}${c.note ? `${count ? ' · ' : ''}${c.note}` : ''}`]),
        ]))
      }
      box.appendChild(rows)
    }
    const dropped = h.dropped || []
    const attention = h.attention || []
    if (attention.length) {
      const list = el('div', {})
      for (const a of attention) list.appendChild(el('p', { class: 'blocker' }, [`${a.component}: ${a.file ? `${a.file}: ` : ''}${a.reason}`]))
      box.appendChild(el('div', { class: 'detail-section' }, [el('div', {}, ['Needs you']), list]))
    }
    if (dropped.length) {
      const list = el('div', {})
      for (const dr of dropped) list.appendChild(el('p', { class: 'sentence tone-muted' }, [`${dr.component}: ${dr.item}${dr.excluded ? ' (excluded by policy)' : ''}. ${dr.reason}`]))
      box.appendChild(el('div', { class: 'detail-section' }, [el('div', {}, [`Dropped (${dropped.length})`]), list]))
    }
    const history = (d && d.harness && d.harness.history) || []
    if (history.length) {
      const list = el('div', { class: 'drawer-timeline' })
      for (const r of history.slice(-8).reverse()) {
        list.appendChild(el('div', { class: 'turn timeline-item' }, [
          el('span', { class: 'mono turn-when' }, [clockAt(Date.parse(r.ts))]),
          el('span', { class: 'turn-role' }, [r.op]),
          el('p', { class: 'timeline-summary' }, [r.op === 'apply' ? `${r.source} to ${r.target}: ${r.state}, ${r.written || 0} written, ${(r.backups || []).length} backed up` : r.op === 'capture' ? `${r.source} captured` : `${r.from || 'start'} to ${r.to}: ${r.state}${r.proceed === false ? ', refused' : ''}`]),
        ]))
      }
      box.appendChild(list)
    }
    return box
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
    const left = el('div', { class: 'detail-brand' }, [
      el('span', { class: `dot id-${idOf(s.agent)}` }),
      el('span', { class: `acct-name chip-id-${idOf(s.agent)}` }, [s.agent]),
      el('span', { class: 'chip mono' }, [tail(s.session_id)]),
      el('span', { class: s.active ? 'chip chip-state-ok' : 'chip is-stale' }, [s.active ? (label || 'running') : (label || s.status)]),
    ])
    const pause = el('button', { type: 'button', class: 'btn btn-secondary', id: 'session-drawer-pause', 'data-focus-key': 'drawer-pause' }, [drawer.paused ? 'Resume updates' : 'Pause updates'])
    pause.addEventListener('click', () => { drawer.paused = !drawer.paused; if (!drawer.paused) loadDrawer(); else renderDrawer() })
    const close = el('button', { type: 'button', class: 'btn btn-secondary', id: 'session-drawer-close', 'data-focus-key': 'drawer-close' }, ['Close'])
    close.addEventListener('click', closeSessionDrawer)
    const header = el('div', { class: 'detail-masthead' }, [left, el('div', { class: 'detail-ctrls' }, [pause, close])])
    box.appendChild(header)
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
      timeline.appendChild(el('div', { class: 'turn timeline-item' }, [
        el('span', { class: 'mono turn-when' }, [clockAt(Date.parse(e.ts))]),
        el('span', { class: 'turn-role' }, [e.type]),
        el('p', { class: 'timeline-summary' }, [e.summary || '']),
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

    const harness = harnessSection(s, d)
    if (harness) box.appendChild(section('Harness', 'the working environment this leg was given', harness))
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
    meta.textContent = `${verdict}${shareClause(list)}${landed ? `, last landed ${clockAt(landed)}` : ''}`
  }

  // A.7: a fact true of every row is a property of the region and is said once,
  // here. Per-row usage is per MODEL, which is real; the reader who adds three
  // rows' figures together is stopped by this clause and by nothing else.
  function shareClause(list) {
    const groups = new Map()
    for (const s of list.filter((x) => x.active)) {
      const key = `${s.agent}/${s.account || 'default'}`
      groups.set(key, (groups.get(key) || 0) + 1)
    }
    const [key, n] = [...groups.entries()].sort((x, y) => y[1] - x[1])[0] || []
    if (!n || n < 2) return ''
    const label = key.endsWith('/default') ? key.slice(0, -'/default'.length) : key
    return `, ${n} share the ${label} login`
  }

  // A fact that is true of every terminal on the board is a property of the
  // board, not of any row. Printed per row it was the same sentence three
  // times, which is three lines of noise around the one row that had something
  // of its own to say. The per-row copy stays in the DOM, visually hidden, so
  // the Land button's aria-describedby still resolves to its own reason.
  function sharedBlocker(list) {
    const shown = list.filter((s) => !s.hidden)
    if (shown.length < 2) return null
    const first = shown[0].worktree ? shown[0].land_blocker : NO_BRANCH_BLOCKER
    if (!first) return null
    return shown.every((s) => (s.worktree ? s.land_blocker : NO_BRANCH_BLOCKER) === first) ? first : null
  }

  // Any sentence two or more terminals would print identically is a fact about
  // the board, not about a terminal. `near the 7d wall, next: codex` on three
  // rows is one fact and two lines of noise, and it is set in the alarm weight,
  // so the noise is the loudest thing on the page.
  function sharedNotes(list, notesOf) {
    const seen = new Map()
    for (const s of list) {
      for (const n of notesOf.get(s.session_id) || []) {
        const at = seen.get(n.text) || { n, count: 0 }
        at.count += 1
        seen.set(n.text, at)
      }
    }
    // only a note that carries a state worth acting on is worth saying at board
    // level. `turn 12, last activity 1:04 AM` is per-terminal detail: shared by
    // coincidence, not a fact about the board, and hoisting it put the quietest
    // sentence on the page in the loudest position.
    return [...seen.values()].filter((x) => x.count >= 2 && x.n.tone !== 'muted').map((x) => x.n)
  }

  function hoistShared(list, notesOf) {
    const slot = document.getElementById('terminals-hoisted')
    if (!slot) return
    const shared = sharedBlocker(list)
    const notes = notesOf ? sharedNotes(list, notesOf) : []
    hoisted = new Set(notes.map((n) => n.text))
    slot.textContent = ''
    for (const n of notes) slot.appendChild(el('span', { class: `hoisted-note tone-${n.tone}` }, [n.text]))
    if (shared) slot.appendChild(el('span', { class: 'hoisted-note tone-muted' }, [`every terminal here ${shared.replace(/^this terminal /, '')}`]))
    slot.hidden = !slot.childNodes.length
    for (const p of document.querySelectorAll('#session-grid .blocker')) p.classList.toggle('is-hoisted', Boolean(shared))
  }

  // Finished terminals are history. After a day of work they are most of the
  // list, and drawn as full rows they bury the one or two that are live, so
  // they leave the panel entirely and become a ledger cell with a drawer.
  function renderFinished(finished, region) {
    const head = document.getElementById('finished-head')
    const meta = document.querySelector('.region-finished .region-meta')
    const slot = document.getElementById('finished-actions')
    const box = document.getElementById('finished-list')
    const panel = document.getElementById('finished-drawer')
    if (!head || !meta || !slot || !box || !panel) return
    slot.textContent = ''
    box.textContent = ''
    if (!finished.length) {
      head.textContent = 'No finished terminals'
      meta.textContent = 'Every terminal Leg knows about is still live.'
      panel.hidden = true
      return
    }
    const counts = {}
    for (const s of finished) counts[s.status] = (counts[s.status] || 0) + 1
    head.textContent = `${finished.length} finished`
    meta.textContent = Object.entries(counts).map(([k, n]) => `${n} ${(STATUS[k] && STATUS[k][0]) || k}`).join(', ')
    // naming eight dead session ids is a wall of text nobody reads. The repos
    // they were working in is the fact worth carrying.
    const repos = [...new Set(finished.map((s) => s.repo_name).filter(Boolean))]
    if (repos.length) meta.textContent += `, in ${repos.slice(0, 3).join(', ')}${repos.length > 3 ? ` and ${repos.length - 3} more` : ''}`
    const btn = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-expanded': finishedOpen ? 'true' : 'false', 'aria-controls': 'finished-drawer', 'data-focus-key': 'finished-toggle' },
      [finishedOpen ? `Hide the ${finished.length}` : `View all ${finished.length}`])
    btn.addEventListener('click', () => { finishedOpen = !finishedOpen; renderSessions(view) })
    slot.appendChild(btn)
    panel.hidden = !finishedOpen
    const headline = document.getElementById('finished-drawer-head')
    if (headline) headline.textContent = `${finished.length} finished terminal${finished.length === 1 ? '' : 's'}`
    if (!finishedOpen) return
    for (const s of finished) {
      const panelEl = renderSession(s)
      box.appendChild(panelEl)
      if (drawer.id === s.session_id && region) panelEl.after(region)
    }
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
    if (empty) empty.hidden = list.some((s) => s.active || needsYou(s, notesOf.get(s.session_id) || []))

    // A terminal that has ended or been lost is history, and history does not
    // belong in the panel that shows what is live. It moves to the ledger.
    const done = (s) => !s.active && !urgent(s) && drawer.id !== s.session_id
    const live = list.filter((s) => !done(s))
    const finished = list.filter(done)
    terminalsMeta(live, notesOf)
    // computed over the rows that are actually drawn: a sentence shared only by
    // terminals collapsed into the ledger is not on screen to be deduped
    hoistShared(live, notesOf)
    for (const s of live) {
      const panel = renderSession(s)
      grid.appendChild(panel)
      if (drawer.id === s.session_id && region) panel.after(region)
    }
    // the per-row copies exist only now, so the pass that hides the ones the
    // region already says runs after the rows are in the document
    hoistShared(live, notesOf)
    const section = document.querySelector('.region-terminals')
    if (section) section.hidden = false
    grid.hidden = live.length === 0
    renderFinished(finished, region)
    // every control in a panel is a new element after this rebuild, and the
    // expanded region was moved out and back, which blurs whatever was focused
    // inside it and zeroes every box it could scroll: put the reader back on
    // the control they were on, at the offset they had scrolled to
    if (region && parked) putScroll(region, parked)
    putFocus(document, focus)
  }

  // What landed is history too. The full list was eighteen rows of git log at
  // the same visual weight as the live terminals, so the loudest thing on the
  // page was a commit from eleven days ago. It is a count and a disclosure now,
  // and `git log` is one keystroke away in the terminal already open.
  function renderTrunk(v) {
    const box = document.getElementById('trunk')
    const head = document.getElementById('trunk-head')
    const meta = document.querySelector('.region-trunk .region-meta')
    const slot = document.getElementById('trunk-actions')
    const panel = document.getElementById('trunk-drawer')
    if (!box || !head || !meta || !slot || !panel) return
    box.textContent = ''
    slot.textContent = ''
    const all = (v.trunk || []).filter((t) => t.branch)
    const branches = all.map((t) => `${t.repo_name}@${t.branch}`)
    const total = all.reduce((n, t) => n + t.commits.length, 0)
    if (!total) {
      head.textContent = 'Nothing landed yet'
      meta.textContent = 'Land commits a terminal\'s work, rebases it onto main, runs the tests and fast-forwards.'
      panel.hidden = true
      return
    }
    const newest = all.flatMap((t) => t.commits).map((c) => c.when).filter(Boolean)[0]
    head.textContent = `${total} landed`
    meta.textContent = `${newest ? `newest ${newest}, ` : ''}on ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? ` and ${branches.length - 3} more` : ''}`
    const btn = el('button', { type: 'button', class: 'btn btn-secondary', 'aria-expanded': trunkOpen ? 'true' : 'false', 'aria-controls': 'trunk-drawer', 'data-focus-key': 'trunk-toggle' },
      [trunkOpen ? `Hide the ${total}` : `View ${total} commit${total === 1 ? '' : 's'}`])
    btn.addEventListener('click', () => { trunkOpen = !trunkOpen; renderTrunk(view) })
    slot.appendChild(btn)
    panel.hidden = !trunkOpen
    const headline = document.getElementById('trunk-drawer-head')
    if (headline) headline.textContent = `${total} commit${total === 1 ? '' : 's'} landed on ${branches.slice(0, 2).join(', ')}`
    if (!trunkOpen) return
    for (const t of all) {
      box.appendChild(el('div', { class: 'group-head' }, [`${t.repo_name} on ${t.branch}`, el('span', {}, [`${t.commits.length} commit${t.commits.length === 1 ? '' : 's'}`])]))
      for (const c of t.commits) {
        const lb = c.landed_by
        const by = lb && lb.by && lb.by !== 'local' ? ` for ${lb.by}` : ''
        box.appendChild(el('div', { class: 'trunk-row' }, [
          el('span', { class: 'line-main', title: c.sha }, [c.subject]),
          el('span', { class: 'line-when' }, [lb
            ? el('span', { class: 'landed-by', title: `Land pressed on the card of ${lb.agent} session ${lb.session_id}${by}${Number.isFinite(Date.parse(lb.at)) ? `, ${new Date(lb.at).toLocaleString()}` : ''}` }, [`${c.when}, by ${lb.agent}${by}`])
            : `${c.when}, ${c.author}`]),
        ]))
      }
    }
  }

  // The elapsed clock ticks every second and the connection word sits in the
  // topbar: between them, liveness is proved by real data and nothing on this
  // board has to pulse to look alive.
  function tickElapsed() {
    for (const node of document.querySelectorAll('[data-elapsed-from]')) {
      const from = Number(node.getAttribute('data-elapsed-from'))
      if (!from) continue
      node.textContent = node.getAttribute('data-elapsed-format') === 'compact'
        ? ago(Date.now() - from)
        : elapsedClock(Date.now() - from)
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
    // A rebuild replaces every button in the grid. A confirm row is a question
    // the reader is answering right now, and a push landing between their
    // mousedown and their mouseup dropped the click: the browser fires `click`
    // only when both landed on the same element, so Remove did nothing however
    // often it was pressed. The rows hold still until the question is answered
    // — `view` is already current, and answering it re-renders from that.
    if (!pendingConfirm) renderSessions(v)
    renderTrunk(v)
    // the panel behind the expansion just changed: status, turns and what is
    // next live in the session view, so redraw the region from it
    if (drawer.id) { if (drawerSession()) renderDrawer(); else closeSessionDrawer() }
  }

  async function refresh() {
    try { render(await api('/api/sessions')) } catch (err) { sysMessage(err.message, 'danger') }
  }

  // Exactly one listener. board.js publishes `leg:sessions` and the legacy
  // `baton:sessions` alias for every push; this file had been registered on
  // `leg:sessions` twice and on the alias once, so one push rebuilt the entire
  // terminals grid three times over.
  // The verdict is a pure function of the payload, and its character budget is
  // a measurement, so test/board-verdict.test.mjs drives the branches directly
  // through this seam. In a browser there is no `module`, and nothing here
  // depends on it. board-updates.test.mjs uses the same pattern in board.js.
  if (typeof module !== 'undefined') module.exports = { verdictLines, VERDICT_CH, SUB_CH, bindingOf, capFigure, capToken, shareClause, headline }

  window.addEventListener('leg:sessions', (e) => render(e.detail))
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (pendingConfirm) { pendingConfirm = null; if (view) renderSessions(view); return }
    if (drawer.id) closeSessionDrawer()
  })
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('default-order-save')?.addEventListener('click', saveDefaultOrder)
    document.getElementById('capacity-toggle')?.addEventListener('click', toggleCapacity)
    renderCapacityToggle()
    renderLoadingHead()
    refresh()
    setInterval(tickElapsed, 1000)
    // the timed re-sort exists to move the needs-you partition, which can wait a
    // few seconds: it stands down mid-selection rather than clearing the drag
    setInterval(() => { if (view && !pendingConfirm && !selectionInsideGrid()) renderSessions(view) }, 15000)
  })
})()
