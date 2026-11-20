/**
 * Browser spike for the layout adapter: builds the spike page with Vite, serves it on a Multiview scratch port and runs the engine
 * checks in Chromium and WebKit with Playwright. Run from the repository root:
 * `node --import tsx/esm delorun/packages/plugin-multiview/tests/layout/browser/spike.mts [shots-dir]`.
 * It prints one JSON result per browser; it keeps nothing outside `/tmp/mvl-spike-*` and the optional shots directory.
 */
import { createServer } from 'node:http'
import { createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

const here = new URL('.', import.meta.url).pathname
const root = resolve(here, '../../../../../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium, webkit } = require('playwright') as typeof import('playwright')

const OUT = '/tmp/mvl-spike-dist'
const BASE_OUT = '/tmp/mvl-spike-base'
const PORT = 18840
const shots = process.argv[2]

rmSync(OUT, { recursive: true, force: true })
rmSync(BASE_OUT, { recursive: true, force: true })
const common = { configFile: false as const, logLevel: 'error' as const, oxc: { jsx: { runtime: 'automatic' } }, resolve: { dedupe: ['react', 'react-dom'] } }
await build({ ...common, root: here, build: { outDir: OUT, emptyOutDir: true, minify: true } })

// Baseline for the bundle delta: React and the layout model, without the layout engine's library.
await build({ ...common, root: here, build: { outDir: BASE_OUT, emptyOutDir: true, minify: true, rollupOptions: { input: join(here, 'base.html') } } })

function sizeOf(dir: string): { js: number; jsGzip: number; css: number; cssGzip: number } {
  const out = { js: 0, jsGzip: 0, css: 0, cssGzip: 0 }
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const file = join(path, name)
      if (statSync(file).isDirectory()) walk(file)
      else if (name.endsWith('.js')) { const body = readFileSync(file); out.js += body.length; out.jsGzip += gzipSync(body).length }
      else if (name.endsWith('.css')) { const body = readFileSync(file); out.css += body.length; out.cssGzip += gzipSync(body).length }
    }
  }
  walk(dir)
  return out
}

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

const shape = (model: any): string => {
  const walk = (node: any): string =>
    node.kind === 'leaf' ? node.panes.join('+') : `${node.orientation === 'horizontal' ? 'H' : 'V'}(${node.children.map(walk).join(' ')})`
  return walk(model.root)
}
const modelOf = async (page: AnyPage): Promise<any> => page.evaluate(() => (window as any).__spike.model)
const settle = (page: AnyPage): Promise<void> => page.waitForTimeout(200)

async function drag(page: AnyPage, from: { x: number; y: number }, to: { x: number; y: number }, steps = 14): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps })
  await page.waitForTimeout(80)
  await page.mouse.up()
  await settle(page)
}
const center = async (page: AnyPage, selector: string): Promise<{ x: number; y: number }> => {
  const box = (await page.locator(selector).first().boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
const bodyBox = async (page: AnyPage, pane: string) => (await page.locator(`[data-pane="${pane}"]`).boundingBox())!

async function fresh(browser: import('playwright').Browser, options: Record<string, unknown> = {}, search = ''): Promise<AnyPage> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  const page = await context.newPage()
  // tsx wraps named functions with a `__name` helper that does not exist in the page.
  await page.addInitScript('window.__name = (target) => target')
  page.on('pageerror', error => console.error('pageerror', error.message))
  await page.goto(`http://127.0.0.1:${PORT}/${search}`)
  await page.waitForSelector('[data-input="main"]')
  await settle(page)
  return page
}

async function run(name: 'chromium' | 'webkit'): Promise<Check[]> {
  const browser = await (name === 'chromium' ? chromium : webkit).launch()
  const checks: Check[] = []
  const add = (check: string, ok: boolean, detail: string): void => { checks.push({ name: check, ok, detail }) }
  try {
    // 1. Drag a pane by its grip onto the left edge of another pane: it splits there.
    {
      const page = await fresh(browser)
      add('initial layout', shape(await modelOf(page)) === 'H(main V(a b))', shape(await modelOf(page)))
      const widths = await page.evaluate(() => [...document.querySelectorAll('[data-tabset]')].map(e => Math.round(e.getBoundingClientRect().width)))
      add('initial 56/44 widths', widths[0]! > widths[1]!, JSON.stringify(widths))
      const main = await bodyBox(page, 'main')
      await drag(page, await center(page, '[data-header="b"] [data-tabset-drag-handle]'), { x: main.x + 12, y: main.y + main.height / 2 })
      const after = await modelOf(page)
      const changes = await page.evaluate(() => (window as any).__spike.changes.map((c: any) => c.reason))
      add('drag-to-edge splits', shape(after) === 'H(b main a)', `${shape(after)} reasons=${JSON.stringify(changes)}`)
      const mounts = await page.evaluate(() => (window as any).__spike.mounts)
      add('no remount after edge drop', Object.values(mounts).every(v => v === 1), JSON.stringify(mounts))
      if (shots) await page.screenshot({ path: join(shots, `${name}-after-edge-drop-1440.png`) })
      await page.context().close()
    }
    // 1b. Drop in the middle joins as a tab.
    {
      const page = await fresh(browser)
      const main = await bodyBox(page, 'main')
      await drag(page, await center(page, '[data-header="a"] [data-tabset-drag-handle]'), { x: main.x + main.width / 2, y: main.y + main.height / 2 })
      const after = await modelOf(page)
      const tablist = await page.evaluate(() => getComputedStyle(document.querySelector('[data-tabset-id="leaf:main"] [data-tab-list]')!).display)
      add('drop on middle joins tabs', shape(after) === 'H(main+a V(b))'.replace('V(b)', 'b') , `${shape(after)} tablist=${tablist}`)
      await page.context().close()
    }
    // 1c. A one-tab tabset draws no tab strip.
    {
      const page = await fresh(browser)
      const displays = await page.evaluate(() => [...document.querySelectorAll('[data-tab-list]')].map(e => getComputedStyle(e).display))
      add('one-tab tabset has no tab strip', displays.every(d => d === 'none'), JSON.stringify(displays))
      await page.context().close()
    }
    // 2. Separator role and keyboard resize.
    {
      const page = await fresh(browser)
      const info = await page.evaluate(() => [...document.querySelectorAll('[role=separator]')].map(e => ({
        label: e.getAttribute('aria-label'), orientation: e.getAttribute('aria-orientation'), now: e.getAttribute('aria-valuenow'),
        min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax'), tabindex: e.getAttribute('tabindex'),
      })))
      add('separator role and values', info.length === 2 && info.every(i => i.now !== null && i.min !== null && i.max !== null && i.tabindex === '0'), JSON.stringify(info))
      const first = page.locator('[role=separator]').first()
      await first.focus()
      const before = await first.getAttribute('aria-valuenow')
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft')
      await settle(page)
      const after = await first.getAttribute('aria-valuenow')
      const resized = await page.evaluate(() => (window as any).__spike.changes.filter((c: any) => c.reason === 'resize').length)
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('role'))
      add('keyboard resize', before !== after, `valuenow ${before} -> ${after}; resize reports=${resized}; focus kept on ${focused}`)
      add('model keeps the keyboard size', resized > 0, `reports=${resized}`)
      await page.context().close()
    }
    // 3 and 4. Focus, typed text, scroll position and DOM identity across moves.
    {
      const page = await fresh(browser)
      await page.evaluate(() => {
        document.querySelectorAll('[data-input]').forEach(e => { (e as any).__tag = (e as HTMLElement).dataset.input })
        document.querySelector('[data-scroller="a"]')!.scrollTop = 300
      })
      const scrollSet = await page.evaluate(() => document.querySelector('[data-scroller="a"]')!.scrollTop)
      await page.locator('[data-input="a"]').click()
      await page.keyboard.type('hello')
      await page.evaluate(() => (window as any).__spike.actions.swap('a', 'b'))
      await settle(page)
      const state = await page.evaluate(() => ({
        active: (document.activeElement as HTMLElement | null)?.dataset.input ?? document.activeElement?.tagName,
        value: (document.querySelector('[data-input="a"]') as HTMLInputElement).value,
        tags: [...document.querySelectorAll('[data-input]')].map(e => (e as any).__tag === (e as HTMLElement).dataset.input),
        scroll: document.querySelector('[data-scroller="a"]')!.scrollTop,
        mounts: (window as any).__spike.mounts,
      }))
      add('DOM identity across swap', state.tags.every(Boolean) && Object.values(state.mounts).every(v => v === 1), JSON.stringify({ tags: state.tags, mounts: state.mounts }))
      add('focus and typed text kept across swap', state.active === 'a' && state.value === 'hello', JSON.stringify({ active: state.active, value: state.value }))
      add('scroll position kept across swap', state.scroll === scrollSet && scrollSet > 0, `set to ${scrollSet}, after swap ${state.scroll}`)
      await page.evaluate(() => (window as any).__spike.actions.applyPreset('grid'))
      await settle(page)
      const grid = await page.evaluate(() => ({
        tags: [...document.querySelectorAll('[data-input]')].map(e => (e as any).__tag === (e as HTMLElement).dataset.input),
        mounts: (window as any).__spike.mounts,
        active: (document.activeElement as HTMLElement | null)?.dataset.input ?? document.activeElement?.tagName,
        shape: (window as any).__spike.model,
      }))
      add('DOM identity across preset (setModel)', grid.tags.every(Boolean) && Object.values(grid.mounts).every(v => v === 1), JSON.stringify({ tags: grid.tags, mounts: grid.mounts, shape: shape(grid.shape) }))
      add('focus kept across preset', grid.active === 'a', `active=${grid.active}`)
      const scrollAfterPreset = await page.evaluate(() => document.querySelector('[data-scroller="a"]')!.scrollTop)
      add('scroll position kept across preset', scrollAfterPreset === scrollSet, `after preset ${scrollAfterPreset}`)
      // Dragging while another pane has focus.
      await page.evaluate(() => { document.querySelector('[data-scroller="b"]')!.scrollTop = 100 })
      await page.locator('[data-input="b"]').click()
      const main = await bodyBox(page, 'main')
      await drag(page, await center(page, '[data-header="a"] [data-tabset-drag-handle]'), { x: main.x + main.width - 12, y: main.y + main.height / 2 })
      const mid = await page.evaluate(() => ({
        tags: [...document.querySelectorAll('[data-input]')].map(e => (e as any).__tag === (e as HTMLElement).dataset.input),
        mounts: (window as any).__spike.mounts,
      }))
      add('DOM identity across drag-docking', mid.tags.every(Boolean) && Object.values(mid.mounts).every(v => v === 1), JSON.stringify(mid))
      const scrollAfterDrag = await page.evaluate(() => document.querySelector('[data-scroller="b"]')!.scrollTop)
      add('scroll position kept across drag-docking', scrollAfterDrag === 100, `after drag ${scrollAfterDrag}`)
      await page.context().close()
    }
    // 5. Touch: resize by finger, and the separator's hit area.
    {
      const page = await fresh(browser, { hasTouch: true, isMobile: name === 'chromium' ? false : false })
      const sep = page.locator('[role=separator]').first()
      const box = (await sep.boundingBox())!
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
      add('touch hit area', true, `separator ${Math.round(box.width)}x${Math.round(box.height)} coarse=${coarse}`)
      const before = await sep.getAttribute('aria-valuenow')
      if (name === 'chromium') {
        const client = await page.context().newCDPSession(page)
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        const send = (type: string, px: number): Promise<unknown> => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y }] })
        await send('touchStart', x)
        for (let i = 1; i <= 12; i += 1) await send('touchMove', x - i * 10)
        await send('touchEnd', 0)
      }
      await settle(page)
      const after = await sep.getAttribute('aria-valuenow')
      if (name === 'chromium') add('touch drag resizes', before !== after, `valuenow ${before} -> ${after} (CDP touch events)`)
      else checks.push({ name: 'touch drag resizes', ok: true, skipped: true, detail: 'not testable: Playwright WebKit has no touch drag, and synthetic pointer events cannot take pointer capture; needs a real iOS device' })
      await page.context().close()
    }
    // 6. Too many panes for the screen: what the library does when minimum sizes do not fit.
    {
      const page = await fresh(browser, { viewport: { width: 1000, height: 560 } }, '?agents=5')
      const rects = await page.evaluate(() => [...document.querySelectorAll('[data-tabset]')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }))
      const scrolls = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, view: innerHeight, collapsed: document.querySelectorAll('[data-tabset-collapsed]').length }))
      add('overfull layout (exploratory)', true, `tabsets ${JSON.stringify(rects)} ${JSON.stringify(scrolls)}`)
      await page.context().close()
    }
    // Screenshots for the report.
    if (shots) {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) {
        const page = await fresh(browser, { viewport: { width, height } })
        await page.screenshot({ path: join(shots, `${name}-default-${width}.png`) })
        await page.context().close()
      }
    }
  } finally {
    await browser.close()
  }
  return checks
}

const results: Record<string, unknown> = {}
try {
  if (shots) mkdirSync(shots, { recursive: true })
  results.bundle = { page: sizeOf(OUT), baseline: sizeOf(BASE_OUT) }
  for (const name of ['chromium', 'webkit'] as const) results[name] = await run(name)
} finally {
  server.close()
}
console.log(JSON.stringify(results, null, 1))
process.exit(0)
