/**
 * Browser run for the phone pager: builds the harness page with Vite, serves it on a Multiview scratch port and checks the pager at
 * 390 px in Chromium (touch swipe) and WebKit (everything but the swipe, which Playwright's WebKit cannot synthesise). Run from the
 * repository root: `node --import tsx/esm delorun/packages/plugin-multiview/tests/phone/browser/pager.mts [shots-dir]`.
 * It prints one JSON result per browser and writes 390 px light and dark pictures into the optional shots directory; it keeps
 * nothing else outside `/tmp/mvp-pager-*`.
 */
import { createServer } from 'node:http'
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { build } from 'vite'

const here = new URL('.', import.meta.url).pathname
const root = resolve(here, '../../../../../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium, webkit } = require('playwright') as typeof import('playwright')

const OUT = '/tmp/mvp-pager-dist'
const PORT = 18848
const shots = process.argv[2]
if (shots) mkdirSync(shots, { recursive: true })

rmSync(OUT, { recursive: true, force: true })
await build({
  configFile: false, logLevel: 'error', oxc: { jsx: { runtime: 'automatic' } }, resolve: { dedupe: ['react', 'react-dom'] },
  root: here, build: { outDir: OUT, emptyOutDir: true, minify: true },
})

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
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

type AnyPage = import('playwright').Page
interface Check { name: string; ok: boolean; detail: string; skipped?: boolean }

const settle = (page: AnyPage, ms = 450): Promise<void> => page.waitForTimeout(ms)
const scrollLeft = (page: AnyPage): Promise<number> => page.evaluate(() => document.querySelector('[data-multiview-pager] > div:nth-child(2)')!.scrollLeft)
const active = (page: AnyPage): Promise<string> => page.evaluate(() => window.__pager.active)
const bodies = (page: AnyPage): Promise<string[]> => page.evaluate(() => window.__pager.bodies())

/** A finger drag along the middle of the page: touch start, a run of moves, touch end, as the browser's own touch input. */
async function swipe(page: AnyPage, distance: number): Promise<void> {
  const client = await page.context().newCDPSession(page)
  const y = 420
  const from = distance < 0 ? 350 : 40
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number): Promise<unknown> =>
    client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  await touch('touchStart', from)
  const steps = 12
  for (let step = 1; step <= steps; step++) {
    await touch('touchMove', from + (distance * step) / steps)
    await page.waitForTimeout(12)
  }
  await touch('touchEnd', from)
  await client.detach()
  await settle(page, 700)
}

async function runBrowser(name: 'chromium' | 'webkit'): Promise<Check[]> {
  const browser = await (name === 'chromium' ? chromium : webkit).launch()
  const checks: Check[] = []
  const add = (check: string, ok: boolean, detail: string, skipped = false): void => { checks.push({ name: check, ok, detail, ...(skipped ? { skipped } : {}) }) }
  const open = async (theme: 'light' | 'dark', search = ''): Promise<AnyPage> => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: theme })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/?theme=${theme}${search}`)
    await page.waitForSelector('[data-multiview-pager]')
    await settle(page, 150)
    return page
  }
  try {
    const page = await open('light')
    add('starts on the main page', (await active(page)) === 'main' && (await scrollLeft(page)) === 0, `scrollLeft ${await scrollLeft(page)}`)
    add('mounts the shown page and its neighbour only', (await bodies(page)).join() === 'main,claude', (await bodies(page)).join())

    const overflow = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
    add('the document does not scroll sideways', overflow[0] === overflow[1], `scrollWidth ${overflow[0]} / innerWidth ${overflow[1]}`)

    const chipBox = (await page.locator('[data-page-chip="claude"]').boundingBox())!
    const stripBox = (await page.locator('[role="tablist"]').boundingBox())!
    add('chip and strip are touch sized', chipBox.height >= 36 && stripBox.height >= 44, `chip ${chipBox.height}px, strip ${stripBox.height}px (chip hit area reaches the strip's 4 px padding)`)

    await page.tap('[data-page-chip="codex"]')
    await settle(page, 700)
    add('a chip tap scrolls to its page', (await active(page)) === 'codex' && Math.abs((await scrollLeft(page)) - 780) < 2, `active ${await active(page)}, scrollLeft ${await scrollLeft(page)}`)
    add('the pages around it are mounted and the far ones are not', (await bodies(page)).join() === 'claude,codex,explorer', (await bodies(page)).join())
    add('a chip tap reports one change, not the pages passed on the way', (await page.evaluate(() => window.__pager.changes.join())) === 'codex', await page.evaluate(() => window.__pager.changes.join()))

    await page.tap('[data-page-dot="main"]')
    await settle(page, 700)
    add('a dot tap scrolls to its page', (await active(page)) === 'main' && (await scrollLeft(page)) < 2, `active ${await active(page)}`)

    if (name === 'chromium') {
      await swipe(page, -300)
      add('a touch swipe snaps to the next page', (await active(page)) === 'claude' && Math.abs((await scrollLeft(page)) - 390) < 2, `active ${await active(page)}, scrollLeft ${await scrollLeft(page)}`)
      await swipe(page, -320)
      add('a quick swipe moves one page only', (await active(page)) === 'codex', `active ${await active(page)}`)
      await swipe(page, 300)
      await swipe(page, 300)
      await swipe(page, 300)
      add('swiping past the first page stays put', (await active(page)) === 'main' && (await scrollLeft(page)) === 0, `scrollLeft ${await scrollLeft(page)}`)
    } else {
      add('touch swipe', true, 'Playwright WebKit cannot synthesise touch scrolling; verify on a real iPhone', true)
    }

    // The amber dot and the active chip, then the breakpoint switch with the shown page kept.
    add('the amber dot is on the agent that needs approval', (await page.locator('[data-attention-dot]').count()) === 1, `${await page.locator('[data-attention-dot]').count()} dot`)
    await page.tap('[data-page-chip="explorer"]')
    await settle(page, 700)
    await page.setViewportSize({ width: 1000, height: 700 })
    await settle(page, 200)
    add('above 768 px the pager gives way to the splits', (await page.locator('[data-splits]').count()) === 1 && (await page.locator('[data-multiview-pager]').count()) === 0, 'splits shown at 1000 px')
    await page.setViewportSize({ width: 390, height: 844 })
    await settle(page, 400)
    add('back at 390 px the pager returns on the same page', (await active(page)) === 'explorer' && Math.abs((await scrollLeft(page)) - 1170) < 2, `active ${await active(page)}, scrollLeft ${await scrollLeft(page)}`)
    await page.context().close()

    if (shots) {
      for (const theme of ['light', 'dark'] as const) {
        const shot = await open(theme, '&start=claude')
        await settle(shot, 400)
        await shot.screenshot({ path: join(shots, `${name}-pager-agent-390-${theme}.png`) })
        await shot.context().close()
        const main = await open(theme)
        await main.screenshot({ path: join(shots, `${name}-pager-main-390-${theme}.png`) })
        await main.context().close()
      }
    }
  } finally {
    await browser.close()
  }
  return checks
}

let failed = false
try {
  for (const name of ['chromium', 'webkit'] as const) {
    const checks = await runBrowser(name)
    if (checks.some(check => !check.ok)) failed = true
    console.log(JSON.stringify({ browser: name, checks }, null, 2))
  }
} finally {
  server.close()
  rmSync(OUT, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
