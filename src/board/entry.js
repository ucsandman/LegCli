// The one-line background entry (redesign C.2), for every page that can start
// work: the board under its Background panel, the floor under its capacity
// strip.
//
// THIS FILE OWNS THE ENTRY ROW. It was board.js's, and the floor had no way to
// start anything at all; a second copy there would have been a second Start
// button posting a slightly different body. It is a plain script like the
// other four, so it publishes one factory on `window.legEntry` and the page
// hands it what it cannot know: its own el/api/toast, the live payloads it
// polls, and what "More settings" means on that page.
//
//   const entry = window.legEntry.create({ el, api, toast, host, ... })
//   entry.render()
//
// `host` is the caller's own live state object, read on every render and never
// copied: { sessions, cards (Map), repoTrunks, preferences, adapters, models }.
(function () {
  'use strict'

  function create(deps) {
    const { el, api, toast } = deps
    const host = deps.host
    const boxId = deps.boxId || 'card-entry'
    const isGuest = deps.isGuest || (() => false)
    const onCreated = deps.onCreated || (() => {})
    const onMoreSettings = deps.onMoreSettings || (() => {})

    // Its three nouns (repo, ladder, workflow) are inferred and are buttons
    // that swap for a select in place; nothing here persists past a page
    // reload. `model` is a THIRD state: undefined means "whatever the rung
    // carries", '' means "the provider's own default", and an id means that
    // model. A plain null could not tell the first two apart, and they post
    // different chains.
    const entryState = { task: '', repo: null, ladderStart: 0, model: undefined, pipeline: 'build', editing: null }
    const PIPELINE_WORDS = { build: 'build only', 'build-land': 'build and land', factory: 'plan, build, review and land' }

    // Only a terminal that carries a `repo` is offered: /api/cards refuses a path
    // that is not a git repository root, so a terminal whose cwd is a plain
    // folder would put a value in this field that Start can only ever reject.
    function knownRepos() {
      const seen = new Map()
      for (const s of host.sessions || []) if (s.repo && !seen.has(s.repo)) seen.set(s.repo, s.repo_name || s.repo)
      for (const c of (host.cards || new Map()).values()) if (c.repo && !seen.has(c.repo)) seen.set(c.repo, c.repo_name || c.repo)
      return [...seen].map(([path, name]) => ({ path, name }))
    }

    // C.2: the most recently focused terminal's repo, else the last card's, else
    // the first terminal's.
    function inferRepo() {
      const sessions = (host.sessions || []).filter((s) => s.repo)
      const byFocus = sessions.length ? [...sessions].sort((a, b) => (Date.parse(b.last_activity) || 0) - (Date.parse(a.last_activity) || 0))[0] : null
      if (byFocus) return { path: byFocus.repo, name: byFocus.repo_name || byFocus.repo }
      const cards = [...(host.cards || new Map()).values()].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
      if (cards[0] && cards[0].repo) return { path: cards[0].repo, name: cards[0].repo_name || cards[0].repo }
      if (sessions[0]) return { path: sessions[0].repo, name: sessions[0].repo_name || sessions[0].repo }
      return null
    }

    function entryRepo() { return entryState.repo || inferRepo() }

    // Every agent this machine really has, test adapters excluded: a ladder that
    // hands off to a script is not a fallback.
    function realAdapters() {
      return (host.adapters || []).filter((a) => !a.fake).map((a) => a.name)
    }

    // The agents a SAVED ladder may name, which is not the same list as the
    // agents that can run a card: preferences takes a closed list
    // (ALL_HANDOFF_AGENTS, src/preferences.mjs) and refuses the whole array over
    // one rung it does not know, so a custom adapter added with `leg adapter
    // add` runs cards happily and can never be a saved rung. Settings' own
    // picker holds the same four at src/board/sessions.js LADDER_AGENTS; this
    // copy is the one the New card dialog saves through.
    const LADDER_AGENTS = ['claude', 'codex', 'agy', 'grok']
    function ladderAgents() { return [...LADDER_AGENTS] }

    const rungCost = (agent) => (agent === 'agy' ? 'free' : agent === 'grok' ? 'metered' : 'plan')
    const asRung = (agent, model) => ({ agent, account: 'default', model: model || null, when: 'always', cost: rungCost(agent) })

    // The ladder this board acts on, with two fallbacks under the real one.
    // Wes's report was "I'm not able to configure any agents for the background
    // stuff": the entry row read `handoff_ladder` alone and said "no agent is
    // configured" on an install that had three agents and a working
    // `handoff_order`, because a preferences.json written by a Leg older than
    // 0.12.0 carries only the order. The server writes both keys now
    // (preferences.mjs ladderFor), so this is for the file that is already on
    // disk, for an older server behind a newer board, and for a settings call
    // that never answered at all -- in which case the adapters themselves are
    // the honest list. A rung with no model means "whatever that CLI runs".
    function ladderFromPreferences(prefs) {
      if (prefs && Array.isArray(prefs.handoff_ladder) && prefs.handoff_ladder.length) return prefs.handoff_ladder
      if (prefs && Array.isArray(prefs.handoff_order) && prefs.handoff_order.length) return prefs.handoff_order.map((a) => asRung(a, null))
      return realAdapters().map((a) => asRung(a, null))
    }

    // the ladder, skipping a credits/metered rung while may_spend is off:
    // a card never starts on a rung that bills without asking (-p mode does)
    function ladderRungs() {
      const prefs = host.preferences
      const maySpend = !!(prefs && prefs.may_spend)
      return ladderFromPreferences(prefs).filter((r) => maySpend || !['credits', 'metered'].includes(r.cost))
    }

    function ladderLabel(r) { return r.model ? `${r.agent}/${r.model}` : r.agent }

    // An empty list has two different causes and they need two different
    // sentences: nothing is installed, or everything installed bills and
    // spending is off. "No agent is configured" for the second one sent the
    // reader to a settings page that had nothing wrong with it.
    function ladderSentence(rungs) {
      if (rungs.length) return rungs.map(ladderLabel).join(' then ')
      return ladderFromPreferences(host.preferences).length
        ? 'every agent here bills by the token, and spending is off'
        : 'no agent is configured'
    }

    // The models /api/models published for this provider. An unknown provider or
    // a catalog that never answered is an empty list, and the select then offers
    // the provider default alone, which is what a bare `leg <agent>` already runs.
    function modelsFor(agent) {
      const catalog = host.models || {}
      return Array.isArray(catalog[agent]) ? catalog[agent] : []
    }

    // The first option of every model select. It names the model the CLI would
    // pick when Leg passes no flag, when the catalog says which one that is.
    function defaultModelLabel(agent) {
      const chosen = modelsFor(agent).find((m) => m.default)
      return chosen ? `${agent} default (${chosen.id})` : `${agent} default`
    }

    // A provider + model select pair, wired so the model list follows the
    // provider. `onPick(agent, model)` fires on either; `model` is '' for the
    // provider default.
    function modelSelect(agent, model, label, onPick) {
      const select = el('select', { 'aria-label': label })
      const fill = () => {
        select.textContent = ''
        select.appendChild(el('option', { value: '' }, [defaultModelLabel(agent)]))
        for (const m of modelsFor(agent)) select.appendChild(el('option', { value: m.id }, [m.label || m.id]))
        // A model the catalog does not list is still the model the card will be
        // posted with: agy's and grok's lists are cached for an hour and are
        // empty on a fresh board or after a failed probe. Dropping the select to
        // '' there showed "<agent> default" over a card that ran a named model,
        // and silently, so nothing changed the row it was read from. The option
        // is added instead, so the select names what will run and the reader can
        // still move off it.
        if (model && !modelsFor(agent).some((m) => m.id === model)) select.appendChild(el('option', { value: model }, [model]))
        select.value = model || ''
      }
      fill()
      select.addEventListener('change', () => onPick(select.value))
      select.refill = fill
      return select
    }

    // Exactly what Start posts: one chain entry per rung, carrying that rung's
    // model, from the rung the reader picked downward. De-duplicated by
    // (adapter, model) and not by adapter, because `claude/fable` then
    // `claude/opus` are two real legs and a hand-off between them is the whole
    // point; two rungs that name the same adapter AND the same model are one leg
    // twice, and a hand-off from a leg to its own twin buys nothing.
    function entryChain() {
      const seen = new Set()
      const out = []
      for (const r of ladderRungs().slice(entryState.ladderStart || 0)) {
        const key = `${r.agent}/${r.model || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(r)
      }
      // A model picked on the row itself applies to the leg that actually starts,
      // which is the first one; the fallbacks under it keep the models the ladder
      // gave them. The override can collide with the rung below it (picking opus
      // on a row whose ladder already reads fable then opus), and two identical
      // legs are one leg twice, so the duplicate goes.
      if (out.length && entryState.model !== undefined) {
        out[0] = { ...out[0], model: entryState.model || null }
        const same = (a, b) => a.agent === b.agent && (a.model || '') === (b.model || '')
        if (out.length > 1 && same(out[0], out[1])) out.splice(1, 1)
      }
      return out
    }

    // The branch a card in this repo should be cut from. The sessions payload
    // carries the repo's own default branch (the server reads origin/HEAD, then
    // main/master/trunk, then the current branch) and each terminal's branch, so
    // neither the sentence nor the body has to assume `main` in a repo whose
    // default is `master` or `develop`: Start could only ever fail there.
    function entryTrunk(repo) {
      if (!repo) return null
      const known = (host.repoTrunks || []).find((t) => t.repo === repo.path || t.repo_name === repo.name)
      if (known && known.branch) return known.branch
      for (const s of host.sessions || []) {
        if (s.repo !== repo.path) continue
        const b = (s.worktree && s.worktree.base) || (!s.worktree && s.branch)
        if (b) return b
      }
      return null
    }

    // The body, built once and posted by Start on either page: two pages that
    // build it two ways is two different cards from one sentence.
    function entryBody() {
      const repo = entryRepo()
      const task = (entryState.task || '').trim()
      if (!task || !repo) return null
      const trunk = entryTrunk(repo)
      return {
        repo: repo.path, task,
        chain: entryChain().map((r) => ({ adapter: r.agent, ...(r.model ? { model: r.model } : {}) })),
        ...(trunk ? { trunk } : {}),
        pipeline: entryState.pipeline, queue: true,
      }
    }

    async function submitEntry() {
      const body = entryBody()
      if (!body) return
      try {
        const data = await api('/api/cards', { method: 'POST', body })
        entryState.task = ''
        entryState.editing = null
        onCreated(data.card)
      } catch (err) { toast(err.message) }
    }

    function nounSelect(options, current, onPick) {
      const select = el('select', { 'aria-label': 'Change' })
      for (const o of options) select.appendChild(el('option', { value: o.value }, [o.label]))
      select.value = current
      select.addEventListener('change', () => { onPick(select.value); entryState.editing = null; renderEntryLine() })
      return select
    }

    function nounButton(text, key) {
      return el('button', { type: 'button', class: 'btn btn-text', onclick: () => { entryState.editing = key; renderEntryLine() } }, [text])
    }

    function renderEntryLine() {
      const box = document.getElementById(boxId)
      if (!box) return
      if (isGuest()) { box.hidden = true; return }
      box.hidden = false
      box.textContent = ''
      const repo = entryRepo()
      const task = el('input', { type: 'text', placeholder: 'Describe the task', 'aria-label': 'Task to run in the background', value: entryState.task })
      // Start has two reasons to be off and says which one it is. A card with no
      // agent to run it is refused by /api/cards with "missing chain", and a
      // button that posts a request it knows will fail is a worse button.
      const canRun = entryChain().length > 0
      const why = !canRun ? `No agent to run it: ${ladderSentence([])}.` : 'Describe the task to start it.'
      const reason = el('span', { class: 'field-help' }, [why])
      reason.hidden = canRun && Boolean(entryState.task.trim())
      const start = el('button', { type: 'button', class: 'btn btn-primary', disabled: canRun && entryState.task.trim() ? null : '' }, ['Start'])
      task.addEventListener('input', () => { entryState.task = task.value; start.disabled = !canRun || !task.value.trim(); reason.hidden = canRun && Boolean(task.value.trim()) })
      // Enter in the field is the same press as Start: a one-line form that can
      // only be submitted by reaching for the mouse is not a one-line form.
      task.addEventListener('keydown', (e) => { if (e.key === 'Enter' && canRun && task.value.trim()) submitEntry() })
      start.addEventListener('click', () => submitEntry())
      // `.confirm-row` is the board's existing sentence-plus-controls strip: a
      // flex row with a gap on the raised surface, which is exactly this line.
      box.appendChild(el('div', { class: 'confirm-row' }, [el('span', {}, ['Run in the background:']), task, start, reason]))

      const line = el('p', { class: 'field-help' })
      line.appendChild(document.createTextNode('in '))
      if (entryState.editing === 'repo') {
        line.appendChild(nounSelect(knownRepos().map((r) => ({ value: r.path, label: r.name })), repo ? repo.path : '', (v) => { entryState.repo = knownRepos().find((r) => r.path === v) || null }))
      } else {
        line.appendChild(nounButton(repo ? repo.name : 'no repo', 'repo'))
      }
      line.appendChild(document.createTextNode(` on ${entryTrunk(repo) || 'main'}, with `))
      const rungs = ladderRungs()
      if (entryState.editing === 'ladder') {
        // Two selects, not one. The provider select picks the rung the chain
        // starts at; the model select beside it swaps the model on that first leg
        // without touching the saved ladder, which is what "codex, but on
        // gpt-5.6-luna, just this once" means. Opening the pair is one press and
        // changing the model is the next, so the model a reader wants is two
        // presses from the row it is read on. The whole ladder is still edited in
        // Settings, and More settings below writes it back.
        const from = Math.min(entryState.ladderStart || 0, Math.max(0, rungs.length - 1))
        const chosen = rungs[from] || null
        // the pair stays open when the provider changes: closing it would put the
        // model select the reader is reaching for back behind another press
        const who = el('select', { 'aria-label': 'Which agent starts' })
        for (let i = 0; i < rungs.length; i++) who.appendChild(el('option', { value: String(i) }, [ladderLabel(rungs[i])]))
        who.value = String(from)
        who.addEventListener('change', () => { entryState.ladderStart = Number(who.value); entryState.model = undefined; renderEntryLine() })
        line.appendChild(who)
        if (chosen) {
          const picked = entryState.model === undefined ? (chosen.model || '') : entryState.model
          line.appendChild(document.createTextNode(' on '))
          line.appendChild(modelSelect(chosen.agent, picked, `Model for ${chosen.agent}`, (v) => { entryState.model = v; renderEntryLine() }))
        }
      } else {
        // the sentence names the legs Start posts, models and all
        line.appendChild(nounButton(ladderSentence(entryChain()), 'ladder'))
      }
      line.appendChild(document.createTextNode(', '))
      if (entryState.editing === 'pipeline') {
        line.appendChild(nounSelect(Object.keys(PIPELINE_WORDS).map((v) => ({ value: v, label: PIPELINE_WORDS[v] })), entryState.pipeline, (v) => { entryState.pipeline = v }))
      } else {
        line.appendChild(nounButton(PIPELINE_WORDS[entryState.pipeline] || 'build only', 'pipeline'))
      }
      line.appendChild(document.createTextNode('.  '))
      line.appendChild(el('button', { type: 'button', class: 'btn btn-text', onclick: () => onMoreSettings(entryState) }, ['More settings']))
      box.appendChild(line)
    }

    // C.2: always visible under the Background panel; when there are no live
    // cards the panel is hidden, so the entry moves to sit under Terminals
    // instead. The fake DOM in the tests has no after(), so this is a no-op
    // there and a real move in the browser. A page with no Background panel
    // (the floor) passes no anchor and the row never moves.
    function placeEntryLine(hasLive) {
      const anchor = deps.moveUnder
      if (!anchor) return
      const box = document.getElementById(boxId)
      if (!box) return
      if (hasLive) {
        const bg = document.getElementById(anchor.whenLive)
        if (bg && typeof bg.appendChild === 'function') bg.appendChild(box)
      } else {
        const terms = document.querySelector(anchor.whenEmpty)
        if (terms && typeof terms.after === 'function') terms.after(box)
      }
    }

    return {
      entryState, PIPELINE_WORDS, knownRepos, inferRepo, entryRepo, realAdapters, ladderAgents, asRung,
      ladderFromPreferences, ladderRungs, ladderLabel, ladderSentence,
      modelsFor, defaultModelLabel, modelSelect,
      entryChain, entryTrunk, entryBody, submitEntry, nounSelect, nounButton,
      renderEntryLine, placeEntryLine,
    }
  }

  if (typeof window !== 'undefined') window.legEntry = { create }
  // test seam: node:test runs this file with a stub document, the way the other
  // board scripts are run; in a browser there is no `module`
  if (typeof module !== 'undefined') module.exports = { create }
})()
