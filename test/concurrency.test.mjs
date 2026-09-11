// Many cards on one repo: non-overlapping leases run at the same time;
// overlapping leases serialize with a blocked_by event naming the holder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome, testEnv, initRepo, baton, batonSpawn, readCard, events, sleep } from './helpers.mjs'

test('BATON_MAX_CONCURRENT=2: A/B (disjoint leases) run together; D waits for C (overlapping) with blocked_by', async (t) => {
  const home = makeHome()
  const env = testEnv(home, { BATON_MAX_CONCURRENT: '2', FAKE_DELAY_MS: '3000' })
  const repo = initRepo('conc-')
  const add = (task, leases, queue) => baton(['card', 'add', '--repo', repo, '--task', task, '--chain', 'fake', '--leases', leases, '--slug', task, ...(queue ? ['--queue'] : [])], env).trim()
  const A = add('a', 'src/a/**', true)
  const B = add('b', 'src/b/**', true)
  // C and D are created now (C first, so it is earlier in created order) but
  // queued only once A and B are done, so the lease contest is C vs D alone.
  const C = add('c', 'src/**', false)
  const D = add('d', 'src/x.js', false)

  const sched = batonSpawn(['scheduler', 'start', '--ticks', '120', '--interval-ms', '500'], env)
  let schedOut = ''
  sched.stdout.on('data', (d) => { schedOut += d })
  sched.stderr.on('data', (d) => { schedOut += d })

  let sawBothRunning = false
  let sawCandDTogether = false
  let queuedCD = false
  const t0 = Date.now()
  for (;;) {
    const st = Object.fromEntries([A, B, C, D].map((id) => [id, readCard(home, id).status]))
    if (st[A] === 'running' && st[B] === 'running') sawBothRunning = true
    if (st[C] === 'running' && st[D] === 'running') sawCandDTogether = true
    if (!queuedCD && st[A] === 'done' && st[B] === 'done') {
      baton(['card', 'queue', C], env)
      baton(['card', 'queue', D], env)
      queuedCD = true
    }
    if ([A, B, C, D].every((id) => st[id] === 'done')) break
    if (Date.now() - t0 > 110000) break
    await sleep(200)
  }
  sched.kill()
  await new Promise((r) => sched.on('exit', r))
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  const final = Object.fromEntries([A, B, C, D].map((id) => [id, readCard(home, id).status]))
  t.diagnostic(`A/B ran together=${sawBothRunning}; C/D together=${sawCandDTogether}; final=${JSON.stringify(final)} (${seconds}s)`)
  assert.deepEqual(final, { [A]: 'done', [B]: 'done', [C]: 'done', [D]: 'done' }, schedOut.slice(-1500))
  assert.equal(sawBothRunning, true, 'A and B must be observed running at the same time')
  assert.equal(sawCandDTogether, false, 'C and D must never run together')

  const dEvents = events(home, D)
  const blocked = dEvents.filter((e) => e.type === 'blocked_by')
  t.diagnostic(`D blocked_by events: ${blocked.map((e) => e.summary).join(' | ')}`)
  assert.ok(blocked.some((e) => e.summary.includes(`blocked by ${C}`) && e.summary.includes('src/**')), 'D was blocked by C on src/**')
  // one blocked_by per blocker change, not per tick
  assert.ok(blocked.length <= 3, `expected few blocked_by events, got ${blocked.length}`)
  // D's leg started after C was done
  const dStart = dEvents.find((e) => e.type === 'leg_started').ts
  const cDone = events(home, C).find((e) => e.type === 'done').ts
  assert.ok(dStart > cDone, `D started ${dStart} after C done ${cDone}`)
})
