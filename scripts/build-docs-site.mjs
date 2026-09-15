#!/usr/bin/env node
// Renders the public docs to static HTML under site/docs, so a stranger can
// read them without the repository. The repository is private and stays that
// way, which means these pages are the only place the claims on the landing
// page can be checked.
//
//   node scripts/build-docs-site.mjs
//
// Regenerate after editing anything in docs/ and commit the output; Vercel
// serves site/ as static files and runs no build step.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// The one place the domain lives. Friday's custom domain is a single edit here
// plus the same constant in site/index.html's canonical and og:url.
const ORIGIN = process.env.LEG_SITE_ORIGIN || process.env.BATON_SITE_ORIGIN || 'https://legcli.com'

// Public docs only. DECISIONS, DEVIATIONS, ERRORS, REUSE, ROADMAP-v2, DEMO and
// the dated review notes are working files: they name unshipped plans and
// internal postmortems, and they are not part of what a buyer is promised.
const PAGES = [
  {
    slug: 'index',
    source: null,
    title: 'Leg docs: usage limits, the board and the handoff',
    description: 'Every Leg document: install, the concepts, the board, configuration, the CLI contract, the agent adapters and the FAQ.',
  },
  {
    slug: 'getting-started',
    nav: 'Install',
    source: 'docs/getting-started.md',
    title: 'Install Leg and monitor your Claude Code usage limit',
    description: 'Install Leg, run your first agent under it, and see the board, the usage reading and the handoff. Node 22+, one npm command.',
  },
  {
    slug: 'concepts',
    nav: 'How it works',
    source: 'docs/concepts.md',
    title: 'How Leg works: sessions, bundles and the wall',
    description: 'The pieces Leg is built from: a session, the usage reading, the handoff bundle, the wall, worktrees and landing work on trunk.',
  },
  {
    slug: 'board-guide',
    nav: 'The board',
    source: 'docs/board-guide.md',
    title: 'The Leg board, panel by panel',
    description: 'Every card, gauge, button and drawer on the Leg board, what each number means, and where the reading behind it came from.',
  },
  {
    slug: 'configuration',
    nav: 'Configuration',
    source: 'docs/configuration.md',
    title: 'Leg configuration and environment variables',
    description: 'Every Leg environment variable, the config file, network exposure, the token seam and the folder-trust switch.',
  },
  {
    slug: 'cli-contracts',
    nav: 'What it reads',
    source: 'docs/cli-contracts.md',
    title: 'What Leg reads from Claude Code, Codex and agy',
    description: 'The exact usage endpoints, hooks, log lines and limit strings Baton reads from Claude Code, Codex and agy, each cited to its source.',
  },
  {
    slug: 'adapters',
    nav: 'Adapters',
    source: 'docs/adapters.md',
    title: 'Leg agent adapters for Claude Code, Codex and agy',
    description: 'How each agent adapter spawns its CLI, what it strips from the environment, and how to tell whether a tap is live or docs-only.',
  },
  {
    slug: 'faq',
    nav: 'FAQ',
    source: 'docs/faq.md',
    title: 'Leg FAQ: what it edits, what it sends, how the license works',
    description: 'What Leg edits and never edits, whether it sends anything anywhere, what happens to your license, and what it does not do.',
  },
  {
    slug: 'real-run',
    nav: 'A real run',
    source: 'docs/real-run.md',
    title: 'A real run: Claude Code hits its usage limit, Codex continues',
    description: 'One recorded session: Claude Code working, the limit landing, the bundle saved, and Codex picking the work up in the same terminal.',
  },
  {
    slug: 'vocabulary',
    nav: 'Vocabulary',
    source: 'docs/VOCABULARY.md',
    title: 'Leg vocabulary',
    description: 'The words Leg uses on the board and in the CLI, each with the one meaning it carries everywhere.',
  },
  {
    slug: 'readme',
    nav: 'README',
    source: 'README.md',
    title: 'Leg README',
    description: 'The complete Leg README as shipped in the npm package: what it does, what it reads, what it never touches, and the license.',
  },
  {
    slug: 'changelog',
    nav: 'Changelog',
    source: 'CHANGELOG.md',
    title: 'Leg changelog',
    description: 'Every released version of Leg and what changed in it.',
  },
]

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Where a markdown link inside docs/ should point once the docs are pages.
const slugForSource = new Map(PAGES.filter((p) => p.source).map((p) => [p.source.toLowerCase(), p.slug]))

function rewriteHref (href) {
  if (/^(https?:|mailto:|#)/i.test(href)) return href
  const [path, hash = ''] = href.split('#')
  if (!path) return href
  const normalised = path.replace(/^\.\//, '').replace(/^\.\.\//, '').toLowerCase()
  const withDocs = normalised.startsWith('docs/') ? normalised : `docs/${normalised}`
  const slug = slugForSource.get(normalised) || slugForSource.get(withDocs)
  if (slug) return `/docs/${slug}${hash ? '#' + hash : ''}`
  // An image or asset that travels with the docs.
  if (/\.(png|jpe?g|gif|svg|webp|mp4)$/i.test(path)) return `/img/docs/${basename(path)}`
  // Files with a public home of their own.
  const elsewhere = {
    license: '/license',
    'security.md': '/support#security',
    'code_of_conduct.md': '/support',
    'contributing.md': '/support',
  }
  if (elsewhere[normalised]) return elsewhere[normalised] + (hash ? '#' + hash : '')
  // Everything left is a working file that ships inside the package but has no
  // public page: DEMO, REUSE, ROADMAP-v2, DEVIATIONS, NOTICE, the site source.
  // The package is where a reader can actually open it, so point there rather
  // than dangling a 404 at a stranger.
  return 'https://www.npmjs.com/package/legcli'
}

const slugify = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')

marked.use({
  gfm: true,
  breaks: false,
  // Rewriting hrefs on the token, before rendering, keeps the default link and
  // image renderers (and their escaping) exactly as marked ships them.
  walkTokens (token) {
    if (token.type === 'link' || token.type === 'image') token.href = rewriteHref(token.href)
  },
  renderer: {
    // Headings get an id so the on-this-page nav and cross-doc anchors resolve.
    heading ({ tokens, depth }) {
      const text = this.parser.parseInline(tokens)
      const id = slugify(tokens.map((t) => t.raw).join(''))
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${depth}>\n`
    },
  },
})

function page ({ slug, title, description, body, headings }) {
  const url = slug === 'index' ? `${ORIGIN}/docs` : `${ORIGIN}/docs/${slug}`
  // Short labels here, not the SEO titles: the sidebar is for finding a page,
  // and at phone width these become a single swipeable row of pills.
  const nav = [
    `<li><a href="/docs"${slug === 'index' ? ' aria-current="page"' : ''}>All docs</a></li>`,
    ...PAGES.filter((p) => p.slug !== 'index')
      .map((p) => `<li><a href="/docs/${p.slug}"${p.slug === slug ? ' aria-current="page"' : ''}>${escapeHtml(p.nav || p.title)}</a></li>`),
  ].join('\n')
  const onThisPage = headings.length
    ? `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${headings.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('')}</ul></nav>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(/leg/i.test(title) ? title : `${title} | Leg`)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#0E1012">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Leg">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${ORIGIN}/og.png?v=2">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${ORIGIN}/og.png?v=2">
<link rel="preload" href="/fonts/atkinson-hyperlegible-next-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/azeret-mono-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/docs.css">
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="docs">
<a class="skip" href="#doc">Skip to the document</a>
<header class="docs-top">
  <div class="docs-top-wrap">
    <a class="docs-home" href="/">Leg</a>
    <nav aria-label="Site"><a href="/docs">Docs</a> <a href="/#pricing">Pricing</a> <a href="/license">License</a></nav>
  </div>
</header>
<div class="docs-shell">
  <nav class="docs-nav" aria-label="Documentation">
    <p class="docs-nav-title">Documentation</p>
    <ul>
${nav}
    </ul>
  </nav>
  <main id="doc" class="docs-body">
${onThisPage}
${body}
    <hr class="docs-end">
    <p class="docs-foot">Leg is commercial, source-available software by Wes Sander. The source you run ships in the npm package. Questions or a refund: <a href="mailto:legcli@practicalsystems.io">legcli@practicalsystems.io</a>.</p>
  </main>
</div>
</body>
</html>
`
}

function headingsOf (markdown) {
  const out = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ text: m[1].replace(/`/g, ''), id: slugify(m[1]) })
  }
  return out
}

const outDir = join(root, 'site', 'docs')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// Screenshots referenced from the markdown travel with the pages.
const shots = join(root, 'docs', 'screenshots')
const imgDir = join(root, 'site', 'img', 'docs')
mkdirSync(imgDir, { recursive: true })
let copied = 0
if (existsSync(shots)) {
  for (const f of readdirSync(shots)) {
    if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(f)) continue
    copyFileSync(join(shots, f), join(imgDir, f))
    copied++
  }
}

const written = []
for (const p of PAGES) {
  let body, headings
  if (p.slug === 'index') {
    const cards = PAGES.filter((x) => x.slug !== 'index')
      .map((x) => `<li><a href="/docs/${x.slug}"><strong>${escapeHtml(x.title.replace(/ \| .*$/, ''))}</strong><span>${escapeHtml(x.description)}</span></a></li>`)
      .join('\n')
    body = `<h1>Leg documentation</h1>
<p class="lede">Leg is a local wrapper for coding-agent CLIs: type <code>leg claude</code>, <code>leg codex</code> or <code>leg agy</code> and you get the same interactive agent with a board beside it, usage tracking per agent and account, a handoff bundle kept current, and an automatic handoff to the next agent in the same terminal when the usage limit hits.</p>
<p class="lede">The source repository is private. These pages carry the same text as the documentation shipped inside the npm package, so every claim on the site can be checked before you buy, and the source itself is readable at <code>$(npm root -g)/legcli/src</code> after you install.</p>
<ul class="doc-cards">
${cards}
</ul>`
    headings = []
  } else {
    const md = readFileSync(join(root, p.source), 'utf8')
    headings = headingsOf(md)
    body = marked.parse(md)
  }
  const file = p.slug === 'index' ? join(outDir, 'index.html') : join(outDir, `${p.slug}.html`)
  writeFileSync(file, page({ ...p, body, headings }))
  written.push(p.slug === 'index' ? '/docs' : `/docs/${p.slug}`)
}

// The sitemap has to list every page that is now indexable, or the new docs
// are invisible to search and to the AI crawlers that read sitemaps.
//
// No `lastmod`. It is optional, and here it cannot be made honest: this file is
// generated and committed alongside the pages it describes, so a date read from
// the clock changes on every build, and a date read from git changes the moment
// the sources are committed — the sitemap would always describe the commit
// before the one containing it. Search engines discount a lastmod they cannot
// trust, so an absent one is worth more than a wrong one.
const urls = [
  { loc: `${ORIGIN}/`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${ORIGIN}/docs`, priority: '0.9', changefreq: 'weekly' },
  ...PAGES.filter((p) => p.slug !== 'index').map((p) => ({
    loc: `${ORIGIN}/docs/${p.slug}`,
    priority: '0.7',
    changefreq: 'weekly',
  })),
  { loc: `${ORIGIN}/support`, priority: '0.5', changefreq: 'monthly' },
  { loc: `${ORIGIN}/license`, priority: '0.3', changefreq: 'yearly' },
]
writeFileSync(join(root, 'site', 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`)

console.log(`docs pages written: ${written.length} (${written.join(', ')})`)
console.log(`screenshots copied: ${copied} -> site/img/docs`)
console.log(`sitemap urls: ${urls.length}`)
