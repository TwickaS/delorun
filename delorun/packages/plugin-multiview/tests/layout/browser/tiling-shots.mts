/**
 * Screenshots of Multiview's layouts: builds `tiling.html` with Vite over the sources of the workspace packages, serves it on a
 * Multiview scratch port and, in headless Chromium, takes every layout choice at 1440x900 with 2, 3, 5 and 7 panes
 * (`layout-<id>-<n>.png`, skipping a choice that does not apply to that many panes), the layout picker in the light and dark
 * themes at 800x700 (`picker-light.png`, `picker-dark.png`) and the Settings section in both themes, 1100 px wide and full height
 * (`settings-light.png`, `settings-dark.png`), and Auto with a 12 px pane gap at 3 and 5 panes (`gap-12-auto-<n>.png`). Run from the
 * repository root:
 * `[MVT_PORT=<port>] node --import tsx/esm delorun/packages/plugin-multiview/tests/layout/browser/tiling-shots.mts <shots-dir> [name-prefix]`;
 * a prefix such as `settings` takes only the pictures whose names start with it.
 * It keeps nothing outside `/tmp/mvt-shots-*` and the shots directory.
 */
import { createServer } from 'node:http'
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { build } from 'vite'
import { layoutChoice } from '../../../src/layout/choices.ts'
import { LAYOUT_CHOICE_IDS } from '../../../src/layout/presets.ts'

const here = new URL('.', import.meta.url).pathname
const root = resolve(here, '../../../../../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright') as typeof import('playwright')

const PORT = Number(process.env.MVT_PORT ?? 18843)
const OUT = `/tmp/mvt-shots-dist-${String(PORT)}`
const shots = process.argv[2]
const only = process.argv[3]
if (shots === undefined) throw new Error('usage: tiling-shots.mts <shots-dir> [name-prefix]')
mkdirSync(shots, { recursive: true })

rmSync(OUT, { recursive: true, force: true })
await build({
  configFile: false,
  logLevel: 'error',
  root: here,
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../../../tsconfig.base.client.json', import.meta.url))] })],
  build: { outDir: OUT, emptyOutDir: true, minify: false, rollupOptions: { input: join(here, 'tiling.html') } },
})

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const server = createServer((request, response) => {
  const pathname = (request.url ?? '/').split('?')[0]!
  const path = join(OUT, pathname === '/' ? 'tiling.html' : pathname)
  try {
    statSync(path)
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    createReadStream(path).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
}).listen(PORT, '127.0.0.1')

interface View { readonly name: string; readonly width: number; readonly height: number; readonly query: string; readonly theme: 'light' | 'dark'; readonly fullPage?: boolean }
const views: View[] = []
const skipped: string[] = []
for (const id of LAYOUT_CHOICE_IDS) {
  for (const panes of [2, 3, 5, 7]) {
    if (!layoutChoice(id).available(panes)) { skipped.push(`${id}-${panes}`); continue }
    views.push({ name: `layout-${id}-${panes}`, width: 1440, height: 900, query: `layout=${id}&panes=${panes}&theme=light`, theme: 'light' })
  }
}
for (const panes of [3, 5]) views.push({ name: `gap-12-auto-${panes}`, width: 1440, height: 900, query: `layout=auto&panes=${panes}&gap=12&theme=light`, theme: 'light' })
for (const theme of ['light', 'dark'] as const) views.push({ name: `picker-${theme}`, width: 800, height: 700, query: `layout=picker&theme=${theme}`, theme })
for (const theme of ['light', 'dark'] as const) views.push({ name: `settings-${theme}`, width: 1100, height: 900, query: `layout=settings&theme=${theme}`, theme, fullPage: true })

const wanted = views.filter(view => only === undefined || view.name.startsWith(only))

const browser = await chromium.launch()
let written = 0
try {
  for (const view of wanted) {
    const page = await browser.newPage({ viewport: { width: view.width, height: view.height }, colorScheme: view.theme })
    page.on('pageerror', error => { console.error(`${view.name}: ${error.message}`) })
    await page.goto(`http://127.0.0.1:${PORT}/?${view.query}`)
    await page.waitForSelector('#root > *')
    await page.evaluate(async () => { await document.fonts.ready })
    await page.evaluate(() => new Promise<void>(done => { requestAnimationFrame(() => { requestAnimationFrame(() => { done() }) }) }))
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(shots, `${view.name}.png`), fullPage: view.fullPage === true })
    console.log(join(shots, `${view.name}.png`))
    written += 1
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
  rmSync(OUT, { recursive: true, force: true })
}
console.log(`${written} pictures written`)
if (skipped.length > 0) console.log(`skipped (not available for that many panes): ${skipped.join(', ')}`)
