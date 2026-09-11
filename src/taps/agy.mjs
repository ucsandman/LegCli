// agy tap — Antigravity CLI 1.2.0 is a closed Go binary with no hooks and no
// usage percentage on any surface Baton can read (its own status line fetches
// a quota summary from the backend; the value is not written anywhere). What
// it does give:
//   --log-file <path>       one log per Baton session; the wall shows up as
//                           RESOURCE_EXHAUSTED / "it resets in <d>" / "out of quota"
//                           (strings present in agy.exe; docs-only until hit live)
//   ~/.gemini/antigravity-cli/history.jsonl
//                           {display, timestamp, workspace, conversationId} per
//                           prompt (observed live) → task text + conversation id
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LAYOUT } from '../accounts.mjs'

export function historyFile(agyHome = LAYOUT.agy.home()) { return join(agyHome, 'history.jsonl') }

const LIMIT_RES = [
  ['agy-resource-exhausted', /RESOURCE_EXHAUSTED/],
  ['agy-resets-in', /it resets in\s+\S+/i],
  ['agy-out-of-quota', /out of quota/i],
  ['agy-quota-exhausted', /quota (exhausted|exceeded)/i],
]

// Log text → { signal, detail, resets_at } | null
export function scanLog(text) {
  for (const [id, re] of LIMIT_RES) {
    const m = re.exec(text)
    if (!m) continue
    const at = text.lastIndexOf(m[0])
    const detail = text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ').trim()
    let resets_at = null
    const d = /resets in\s+(\d+)([smhd])/i.exec(text.slice(at))
    if (d) resets_at = Math.floor(Date.now() / 1000) + parseInt(d[1], 10) * { s: 1, m: 60, h: 3600, d: 86400 }[d[2]]
    return { signal: id, detail, resets_at }
  }
  return null
}

function sameDir(a, b) {
  const n = (x) => String(x ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return n(a) === n(b)
}

// Prompts typed into agy in `cwd` since `sinceMs`.
export function promptsSince({ agyHome, cwd, sinceMs }) {
  const f = historyFile(agyHome)
  if (!existsSync(f)) return []
  const out = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.timestamp >= sinceMs - 2000 && sameDir(j.workspace, cwd)) out.push({ text: String(j.display ?? ''), ts: j.timestamp, conversationId: j.conversationId ?? null })
  }
  return out
}

export function logSize(path) { try { return statSync(path).size } catch { return 0 } }
