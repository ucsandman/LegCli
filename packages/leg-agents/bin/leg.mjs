#!/usr/bin/env node
// leg-agents: thin alias for @ucsandman/legcli.
// Installs the real package as a dependency and delegates to its CLI.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve('@ucsandman/legcli/package.json'));
await import(pathToFileURL(join(pkgRoot, 'bin', 'leg.mjs')).href);
