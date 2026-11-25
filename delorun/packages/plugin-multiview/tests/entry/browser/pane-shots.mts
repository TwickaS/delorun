/**
 * Pictures of the redesigned agents list: builds `pane.html` with Vite over the workspace sources, serves it on a scratch
 * port and takes pictures in headless Chromium at 1440 and 390 px, in both themes, for a catalog of 8 and of 32 agents.
 * Run from the repository root:
 * `node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/pane-shots.mts <shots-dir>`.
 * It keeps nothing outside `/tmp/mve-pane-*` and the shots directory.
 */
import { createServer } from 'node:http'
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { build } from 'vite'

const here = new URL('.', import.meta.url).pathname
const root = resolve(here, '../../../../../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright') as typeof import('playwright')

const OUT = '/tmp/mve-pane-dist'
const PORT = 18843
const shots = process.argv[2]
if (shots === undefined) throw new Error('usage: pane-shots.mts <shots-dir>')
mkdirSync(shots, { recursive: true })

rmSync(OUT, { recursive: true, force: true })
await build({
  configFile: false,
  logLevel: 'error',
  root: here,
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../../../tsconfig.base.client.json', import.meta.url))] })],
  build: { outDir: OUT, emptyOutDir: true, minify: false, rollupOptions: { input: join(here, 'pane.html') } },
})

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const server = createServer((request, response) => {
  const pathname = (request.url ?? '/').split('?')[0]!
  const path = join(OUT, pathname === '/' ? 'pane.html' : pathname)
  try {
    statSync(path)
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    createReadStream(path).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
}).listen(PORT, '127.0.0.1')

const browser = await chromium.launch()
try {
  const views = [
    { name: 'pane-8-1440-light', width: 1440, height: 900, query: 'agents=8' },
    { name: 'pane-8-1440-dark', width: 1440, height: 900, query: 'agents=8&theme=dark' },
    { name: 'pane-8-390-light', width: 390, height: 844, query: 'agents=8' },
    { name: 'pane-8-390-dark', width: 390, height: 844, query: 'agents=8&theme=dark' },
    { name: 'pane-32-1440-light', width: 1440, height: 900, query: 'agents=32' },
    { name: 'pane-32-1440-dark', width: 1440, height: 900, query: 'agents=32&theme=dark' },
    { name: 'pane-32-390-light', width: 390, height: 844, query: 'agents=32' },
    { name: 'pane-32-390-dark', width: 390, height: 844, query: 'agents=32&theme=dark' },
  ]
  for (const view of views) {
    const page = await browser.newPage({ viewport: { width: view.width, height: view.height }, colorScheme: view.query.includes('dark') ? 'dark' : 'light' })
    await page.goto(`http://127.0.0.1:${String(PORT)}/pane.html?${view.query}`)
    await page.waitForSelector('header button')
    await page.getByRole('button', { name: /subagents/ }).last().click()
    await page.waitForSelector('[role="dialog"]')
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(shots, `${view.name}.png`) })
    console.log(join(shots, `${view.name}.png`))
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
  rmSync(OUT, { recursive: true, force: true })
}
