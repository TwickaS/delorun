/**
 * Screenshots of the entry points: builds `index.html` with Vite over the sources of the workspace packages, serves it on a
 * Multiview scratch port and takes light-theme pictures in headless Chromium at 1440 and 390 px. Run from the repository root:
 * `node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <shots-dir>`.
 * It keeps nothing outside `/tmp/mve-shots-*` and the shots directory.
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

const OUT = '/tmp/mve-shots-dist'
const PORT = 18842
const shots = process.argv[2]
if (shots === undefined) throw new Error('usage: shots.mts <shots-dir>')
mkdirSync(shots, { recursive: true })

rmSync(OUT, { recursive: true, force: true })
await build({
  configFile: false,
  logLevel: 'error',
  root: here,
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../../../tsconfig.base.client.json', import.meta.url))] })],
  build: { outDir: OUT, emptyOutDir: true, minify: false },
})

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const server = createServer((request, response) => {
  const pathname = (request.url ?? '/').split('?')[0]!
  const path = join(OUT, pathname === '/' ? 'index.html' : pathname)
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
    { name: 'agents-list-pins-1440-light', width: 1440, height: 560, query: 'pins=3' },
    { name: 'agents-list-pins-390-light', width: 390, height: 640, query: 'pins=3' },
    { name: 'agents-list-limit-1440-light', width: 1440, height: 560, query: 'pins=5&max=6' },
    { name: 'multiview-open-layouts-1440-light', width: 1440, height: 480, query: 'pins=3&open=1&popover=0', menu: true },
  ]
  for (const view of views) {
    const page = await browser.newPage({ viewport: { width: view.width, height: view.height }, colorScheme: 'light' })
    await page.goto(`http://127.0.0.1:${PORT}/?${view.query}`)
    await page.waitForSelector('header button')
    if (view.menu === true) {
      await page.getByRole('button', { name: 'Multiview' }).click({ button: 'right' })
      await page.waitForSelector('[role="dialog"]')
    }
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(shots, `${view.name}.png`) })
    console.log(join(shots, `${view.name}.png`))
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
  rmSync(OUT, { recursive: true, force: true })
}
