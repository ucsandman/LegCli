// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
// resolveNpmCliEntry — the real JS entry of a globally installed npm CLI, so
// the runner can spawn(node, [entry, ...]) with NO shell. The global npm .cmd
// shim needs a shell on Windows, and a shell may resolve to the WSL bash shim,
// which drops Windows variables and misresolves node. A bin override that
// already points at a .mjs/.cjs/.js short-circuits the resolution (tests).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function resolveNpmCliEntry(pkgName, binName = pkgName, { binOverride, pkgDir, log = () => {} } = {}) {
  if (binOverride && /\.(mjs|cjs|js)$/.test(binOverride)) return binOverride
  const candidates = []
  if (pkgDir) candidates.push(pkgDir)
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', pkgName))
  }
  candidates.push(`/usr/local/lib/node_modules/${pkgName}`)
  candidates.push(`/usr/lib/node_modules/${pkgName}`)
  for (const dir of candidates) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName]
      if (bin) return join(dir, bin)
    } catch (err) {
      log(`${pkgName} package.json unreadable at ${pkgPath}: ${err.message}`)
    }
  }
  return null
}
