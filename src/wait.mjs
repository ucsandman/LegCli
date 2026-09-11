// wait — when every option is walled, the terminal stays open and counts down
// to the first reset instead of exiting. Pure timing here; src/attach.mjs
// wires the countdown line, the session record and the restart from the
// bundle around it.
export function fmtCountdown(secs) {
  const s = Math.max(0, Math.floor(secs))
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60
  return h ? `${h}h${String(m).padStart(2, '0')}m${String(r).padStart(2, '0')}s` : m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`
}

// Resolve 'ready' once resetsAt (epoch seconds) has passed, 'cancelled' when
// the signal aborts or isCancelled() says so. onTick(remainingSecs) runs every
// tickMs and once at the start. A null resetsAt resolves 'ready' at once.
export function waitForReset({ resetsAt, tickMs = 1000, signal = null, isCancelled = () => false, onTick = () => {} } = {}) {
  return new Promise((resolvePromise) => {
    let timer = null
    const finish = (r) => { if (timer) clearInterval(timer); signal?.removeEventListener?.('abort', onAbort); resolvePromise(r) }
    const onAbort = () => finish('cancelled')
    const check = () => {
      if (signal?.aborted || isCancelled()) return finish('cancelled')
      const remaining = Number.isFinite(resetsAt) ? resetsAt - Date.now() / 1000 : 0
      if (remaining <= 0) return finish('ready')
      onTick(remaining)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    check()
    // the interval is what keeps the process alive while it waits: never unref it
    timer = setInterval(check, tickMs)
  })
}
