// store — read side of the ledger plus thin wrappers around the ledger CLI
// (src/ledger.mjs stays the only writer). Everything the orchestrator,
// scheduler, board and CLI need to look at cards goes through here.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readEvents as ledgerReadEvents } from './ledger.mjs'

const SRC = dirname(fileURLToPath(import.meta.url))
export const LEDGER = join(SRC, 'ledger.mjs')
export const RUNNER = join(SRC, 'runner.mjs')
export const BATON_ACTOR = { type: 'baton' }

export function home() {
  return process.env.BATON_HOME || join(homedir(), '.baton')
}

export function cardDir(id) { return join(home(), 'cards', id) }

export function readCard(id) {
  const f = join(cardDir(id), 'card.json')
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

export function listCards() {
  const root = join(home(), 'cards')
  if (!existsSync(root)) return []
  return readdirSync(root).sort().map(readCard).filter(Boolean)
}

export function readRuns(id) {
  const dir = join(cardDir(id), 'runs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
    .map((n) => {
      try { return JSON.parse(readFileSync(join(dir, String(n), 'run.json'), 'utf8')) } catch { return null }
    }).filter(Boolean)
}

export function readEvents(id) { return ledgerReadEvents(id) }

function ledger(args) {
  return execFileSync(process.execPath, [LEDGER, ...args], { windowsHide: true, encoding: 'utf8', env: process.env })
}

export function ledgerCreate(fields) {
  const args = ['create']
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    args.push(`--${k}`, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return ledger(args).trim()
}

export function ledgerAppend(id, { actor = BATON_ACTOR, type, summary, body, station, leg }) {
  const args = ['append', '--card', id, '--actor', JSON.stringify(actor), '--type', type, '--summary', summary]
  if (body) args.push('--body', String(body).slice(0, 4000))
  if (station) args.push('--station', station)
  if (leg !== undefined && leg !== null) args.push('--leg', String(leg))
  ledger(args)
}

export function ledgerLog({ actor = BATON_ACTOR, type, summary, body }) {
  const args = ['log', '--actor', JSON.stringify(actor), '--type', type, '--summary', summary]
  if (body) args.push('--body', String(body).slice(0, 4000))
  ledger(args)
}

export function ledgerUpdate(id, { status, station, leg, sessionId, patch }) {
  const args = ['update', '--card', id]
  if (status) args.push('--status', status)
  if (station) args.push('--station', station)
  if (leg !== undefined && leg !== null) args.push('--leg', String(leg))
  if (sessionId) args.push('--session-id', sessionId)
  if (patch && Object.keys(patch).length) args.push('--patch', JSON.stringify(patch))
  if (args.length === 3) return
  ledger(args)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
