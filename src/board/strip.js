// The capacity strip: one 44px band, one token per login, and the bucket that
// will actually stop the work printed in it.
//
// THIS FILE OWNS THE STRIP. The board draws it under the verdict and the floor
// draws it under the masthead, and a strip written twice is a percentage that
// can read two ways on two pages, which is the defect the strip exists to fix.
// src/board/sessions.js and src/board/floor.js keep the names (capFigure,
// capToken, bindingOf and the rest) and delegate here; nothing in either file
// draws a token itself.
//
// The three board scripts have no module system, so the page hands its own
// primitives over with use(): el(), the login labels and the time grammar are
// owned by sessions.js (and carried, character for character, by floor.js), so
// this file never grows a third copy of them.
(function () {
  'use strict'

  // { el, accountLabel, idOf, acctState, worstWindow, until, clockAt, spoken }
  let H = null
  function use(helpers) { H = helpers || H; return api }

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
    const w = H.worstWindow(a)
    if (!w || !Number.isFinite(w.pct)) return null
    return { kind: a && a.seven_day === w ? 'seven_day' : 'five_hour', model: null, percent: w.pct, resets_at: Number.isFinite(w.resets_at) ? w.resets_at : null, scope: 'account' }
  }
  // the token's two words: `fable week`, `week`, `session`, `5h`
  function bucketWord(b) { const word = BUCKET_WORD[b.kind] || b.kind; return b.model ? `${b.model} ${word}` : word }
  // the same bucket inside a sentence: "63% of its week"
  function windowPhrase(b) { return b.kind === 'session' ? 'its session' : b.kind === 'five_hour' ? 'its 5 hours' : 'its week' }
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

  // ---- one token ----------------------------------------------------------
  function capFigure(a, b) {
    // the same two refusals the gauge prints, in the strip's shorter grammar
    if (a.shared === false) return 'not shared'
    if (a.loading) return 'reading'
    if (H.acctState(a) === 'walled') return Number.isFinite(a.limited_until) ? `back ${H.until(a.limited_until)}` : 'back when it resets'
    // agy publishes no percentage, ever; a login that has one and has not
    // reported it yet is a different fact and says so.
    if (!b) return a.agent === 'agy' ? 'no figure' : 'no reading'
    const observed = Date.parse(a.observed_at || a.updated_at || '')
    // a reading older than the window it describes prints the clock it was
    // taken at instead of a bucket word: it is a measurement, not a reading now
    if (a.stale && a.agent !== 'agy' && Number.isFinite(observed)) return `${Math.round(b.percent)}% ${H.clockAt(observed)}`
    return `${Math.round(b.percent)}% ${bucketWord(b)}`
  }
  // the spoken sentence carries what the visible token cannot: the reset, the
  // source, the wall and the age of the reading, exactly as the gauges do.
  function capValueText(a, b) {
    const parts = []
    if (a.shared === false) parts.push(`Usage for ${H.accountLabel(a)} is not shared with guests.`)
    else if (!b) {
      parts.push(a.agent === 'agy'
        ? 'agy publishes no usage percentage, ever. Leg sees the wall when agy hits it.'
        : `No reading has come back from ${H.accountLabel(a)} yet.`)
    } else {
      parts.push(`${Math.round(b.percent)} percent of ${b.model ? `the ${b.model} ${BUCKET_WORD[b.kind] || b.kind}` : windowPhrase(b)} used.`)
      if (Number.isFinite(b.resets_at)) parts.push(`Resets at ${H.until(b.resets_at)}, in ${H.spoken(b.resets_at * 1000 - Date.now())}.`)
    }
    if (H.acctState(a) === 'walled') parts.push(`${H.accountLabel(a)} is at its wall until ${H.until(a.limited_until)}, in ${H.spoken(a.limited_until * 1000 - Date.now())}.`)
    for (const m of walledModels(a)) parts.push(`${m} is out until ${H.until(wallFor(a, m).limited_until)}.`)
    if (a.source) parts.push(`Source: ${a.source}.`)
    const observed = Date.parse(a.observed_at || a.updated_at || '')
    if (a.stale && a.agent !== 'agy' && Number.isFinite(observed)) parts.push(`Read at ${H.clockAt(observed)}, ${H.spoken(Date.now() - observed)} ago, stale.`)
    return parts.join(' ')
  }
  function capToken(a) {
    const el = H.el
    const id = H.idOf(a.agent)
    const b = bindingOf(a)
    const walled = H.acctState(a) === 'walled'
    const pct = b ? Math.max(0, Math.min(100, Math.round(b.percent))) : null
    const token = el('span', { class: 'cap-token' }, [
      el('span', { class: `dot id-${id}`, 'aria-hidden': 'true' }),
      el('span', { class: `cap-name id-${id}` }, [H.accountLabel(a)]),
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
        ? { role: 'img', 'aria-label': `${H.accountLabel(a)} capacity. ${capValueText(a, b)}` }
        : { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${H.accountLabel(a)} capacity`, 'aria-valuetext': capValueText(a, b) }
      token.appendChild(el('span', { class: 'cap-track', ...semantics }, [fill]))
    }
    // with no track the figure carries the whole sentence itself, the way the
    // gauge's readout does when a window has never been read
    const quiet = pct === null && !walled ? { role: 'img', 'aria-label': `${H.accountLabel(a)} capacity. ${capValueText(a, b)}` } : {}
    token.appendChild(el('span', { class: `cap-figure${walled ? ' is-out' : ''}${pct === null && !walled ? ' cap-figure--none' : ''}`, ...quiet }, [capFigure(a, b)]))
    return token
  }
  function capacityStrip(list) {
    const box = document.getElementById('capacity-tokens')
    if (!box) return
    box.textContent = ''
    for (const a of list || []) box.appendChild(capToken(a))
  }

  // ---- the disclosure the login panels live behind ------------------------
  // Whether it is open is the reader's decision, kept across reloads and shared
  // by both pages: opening it on the board and finding it shut on the floor is
  // the same fact answering two ways. localStorage throws in a private window
  // and on a page opened from a file, so it is never load bearing.
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

  const api = {
    use, BUCKET_WORD, bindingOf, bucketWord, windowPhrase, knownModels, wallFor, walledModels,
    capFigure, capValueText, capToken, capacityStrip, renderCapacityToggle, toggleCapacity,
    isCapacityOpen: () => capacityOpen,
  }

  if (typeof window !== 'undefined') window.legStrip = api
  // test seam: node:test runs this file with a stub document, the way the other
  // board scripts are run; in a browser there is no `module`
  if (typeof module !== 'undefined') module.exports = api
})()
