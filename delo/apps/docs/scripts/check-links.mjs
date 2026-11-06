// Dead-link check over the built site: every internal link and fragment in the HTML, the Markdown routes and the
// llms.txt indexes must name a built file and, for a fragment, an id in that file. External links are not fetched.
// Usage: node scripts/check-links.mjs <out-dir>. Exits 1 with one line per dead link.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const outDir = resolve(process.argv[2] ?? 'out')
if (!existsSync(outDir)) {
  console.error(`check-links: ${outDir} does not exist; run the build first`)
  process.exit(1)
}

/** Every file under a directory, skipping Next's runtime payloads and assets, which carry no page links. */
function filesUnder(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '_next' ? [] : filesUnder(path)
    return name.startsWith('__next') ? [] : [path]
  })
}

const posix = path => path.split(sep).join('/')
const files = filesUnder(outDir)
const ids = new Map()
for (const file of files) {
  if (!file.endsWith('.html')) continue
  const html = readFileSync(file, 'utf8')
  ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])))
}

/** The file a site path names: the path itself, or its `.html` page, or its directory's index. */
function fileFor(urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const base = resolve(outDir, `.${decoded}`)
  const candidates = [base, `${base}.html`, join(base, 'index.html')]
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
}

const dead = []
let checked = 0

/**
 * Check one link found in a file.
 * @param source - the file holding the link.
 * @param target - the link target as written.
 */
function check(source, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return
  checked += 1
  const rel = posix(relative(outDir, source))
  const hashAt = target.indexOf('#')
  const pathPart = hashAt === -1 ? target : target.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : decodeURIComponent(target.slice(hashAt + 1))
  if (pathPart === '' && fragment === '') return dead.push(`${rel}: empty link target "${target}"`)
  if (pathPart === '') {
    if (!source.endsWith('.html')) return
    if (!ids.get(source)?.has(fragment)) dead.push(`${rel}: "${target}" names no id on this page`)
    return
  }
  if (!pathPart.startsWith('/')) return dead.push(`${rel}: relative link "${target}" in a built file; links must be site paths`)
  const file = fileFor(pathPart.replace(/\?.*$/, ''))
  if (file === undefined) return dead.push(`${rel}: "${target}" names no built file`)
  if (fragment !== '' && file.endsWith('.html') && !ids.get(file)?.has(fragment)) dead.push(`${rel}: "${target}" names no id "${fragment}" on ${posix(relative(outDir, file))}`)
}

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (file.endsWith('.html')) {
    for (const match of text.matchAll(/\s(?:href|src)="([^"]*)"/g)) check(file, match[1].replaceAll('&amp;', '&'))
  } else if (file.endsWith('.txt') || file.includes(`${sep}llms.mdx${sep}`)) {
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) check(file, match[1])
  }
}

if (dead.length > 0) {
  for (const line of dead) console.error(`check-links: ${line}`)
  console.error(`check-links: ${String(dead.length)} dead link(s) in ${outDir}`)
  process.exit(1)
}
console.log(`check-links: ${String(checked)} internal link(s) and fragment(s) resolve in ${outDir}`)
