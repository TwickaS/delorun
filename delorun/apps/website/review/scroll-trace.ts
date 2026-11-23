/**
 * Traces scrolling on the built home page in headless Chromium and prints what each scroll cost: frame intervals,
 * dropped frames, long tasks, style, layout, paint, raster and image-decode time, and the number of compositor layers.
 * Two scrolls are measured: `hero`, through the mosaic's zoom, and `wall`, through the wall of every screenshot with all
 * of them shown and loaded. For comparing a change's before and after; it never changes the page.
 *
 * Usage: `node review/scroll-trace.ts [--out out] [--port 18681] [--runs 3] [--scenario hero|wall|all] [--width 1440|390]
 * [--scheme light|dark] [--cpu 1] [--trace-dir <dir>]`
 *
 * Headless Chromium draws with a software renderer, so raster and composite cost more than on a real graphics card: the
 * numbers compare two builds on one machine, they do not predict a visitor's frame rate.
 *
 * @module @delorun/website/review/scroll-trace
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { launch, type Page } from './browser.ts'
import { waitForResources } from './resources.ts'
import { serve } from './serve.ts'
import { SCROLL_START, summariseScroll, type ScrollSummary, type TraceEvent } from './trace-summary.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out' },
    port: { type: 'string', default: '18681' },
    runs: { type: 'string', default: '3' },
    scenario: { type: 'string', default: 'all' },
    width: { type: 'string', default: '1440' },
    scheme: { type: 'string', default: 'light' },
    cpu: { type: 'string', default: '1' },
    'trace-dir': { type: 'string' },
  },
})

/** The trace categories that hold the renderer's frame, paint, raster and decode events. */
const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'viz', 'gpu', 'benchmark']

/** How fast the synthetic scroll moves, in pixels a second: a brisk flick through the page. */
const SPEED = 2000

type Scenario = 'hero' | 'wall'

/**
 * Brings the page to where a scroll starts and returns how far it scrolls.
 * @param page - the page, loaded.
 * @param scenario - which scroll.
 * @returns the distance in pixels.
 */
async function prepare(page: Page, scenario: Scenario): Promise<number> {
  if (scenario === 'hero') return page.evaluate(() => document.querySelector('section[aria-labelledby="home-hero"]')?.getBoundingClientRect().height ?? 0)
  await page.evaluate(() => { document.getElementById('home-wall')?.closest('section')?.scrollIntoView({ block: 'start' }) })
  await page.waitForTimeout(300)
  const show = page.locator('button', { hasText: /^Show all/ })
  if (await show.isVisible()) await show.click()
  // Every picture loads first, so the trace is of scrolling a full grid rather than of loading it.
  await page.evaluate(async () => {
    const section = document.getElementById('home-wall')?.closest('section')
    if (section == null) return
    for (let y = 0; y < section.offsetHeight; y += innerHeight * 0.8) {
      scrollTo(0, section.offsetTop + y)
      await new Promise(done => { setTimeout(done, 250) })
    }
    scrollTo(0, section.offsetTop)
    await Promise.all([...section.querySelectorAll('img')].map(img => img.complete ? undefined : new Promise(done => { img.addEventListener('load', done); img.addEventListener('error', done) })))
  })
  await page.waitForTimeout(800)
  return page.evaluate(() => (document.getElementById('home-wall')?.closest('section')?.offsetHeight ?? innerHeight) - innerHeight)
}

/**
 * Measures one scroll in a fresh context.
 * @param base - the server's origin.
 * @param scenario - which scroll.
 * @param run - the run's number, for the trace file's name.
 * @returns the summary and the compositor layer count.
 */
async function measure(base: string, scenario: Scenario, run: number): Promise<ScrollSummary & { readonly layers: number }> {
  const width = Number(values.width)
  const phone = width <= 480
  const viewport = { width, height: phone ? 844 : 900 }
  const context = await browser.newContext({ viewport, colorScheme: values.scheme === 'dark' ? 'dark' : 'light', ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}) })
  try {
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await page.goto(base, { waitUntil: 'load' })
    // The zoom's sharper pictures load once the page has idled after loading; the trace starts after that.
    await page.waitForTimeout(3500)
    const cpu = Number(values.cpu)
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    const distance = await prepare(page, scenario)
    const events: TraceEvent[] = []
    cdp.on('Tracing.dataCollected', ({ value }) => { events.push(...(value as TraceEvent[])) })
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: CATEGORIES } })
    // Starting a trace repaints the page; the measured scroll starts once that has passed, at the time stamp.
    await page.waitForTimeout(1000)
    await page.evaluate(label => {
      console.timeStamp(label)
      const state = window as typeof window & { traceFrames?: number[]; traceStop?: boolean }
      state.traceFrames = []
      let last = performance.now()
      const tick = (now: number) => { state.traceFrames?.push(now - last); last = now; if (state.traceStop !== true) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    }, SCROLL_START)
    await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(width / 2), y: Math.round(viewport.height / 2), yDistance: -Math.round(distance), speed: SPEED, gestureSourceType: phone ? 'touch' : 'mouse', preventFling: true })
    await page.waitForTimeout(500)
    const frames = await page.evaluate(() => {
      const state = window as typeof window & { traceFrames?: number[]; traceStop?: boolean }
      state.traceStop = true
      return (state.traceFrames ?? []).slice(1)
    })
    const complete = new Promise(done => { cdp.once('Tracing.tracingComplete', done) })
    await cdp.send('Tracing.end')
    await complete
    // The layer tree is read after the trace, since asking for it repaints the page.
    const layerTree = new Promise<number>(done => { cdp.once('LayerTree.layerTreeDidChange', event => { done(event.layers?.length ?? 0) }) })
    await cdp.send('LayerTree.enable')
    const layers = await Promise.race([layerTree, page.waitForTimeout(3000).then(() => 0)])
    const traceDir = values['trace-dir']
    if (traceDir !== undefined) {
      mkdirSync(traceDir, { recursive: true })
      writeFileSync(join(traceDir, `${scenario}-w${String(width)}-${values.scheme}-run${String(run)}.json`), JSON.stringify({ traceEvents: events }))
    }
    return { ...summariseScroll(events, frames), layers }
  } finally {
    await context.close()
  }
}

const out = resolve(fileURLToPath(new URL('..', import.meta.url)), values.out)
const scenarios: readonly Scenario[] = values.scenario === 'all' ? ['hero', 'wall'] : [values.scenario === 'wall' ? 'wall' : 'hero']

await waitForResources()
const server = await serve(out, Number(values.port))
const browser = await launch()
try {
  for (const scenario of scenarios) {
    for (let run = 1; run <= Number(values.runs); run++) {
      const result = await measure(`http://127.0.0.1:${values.port}/`, scenario, run)
      console.log(JSON.stringify({ scenario, width: Number(values.width), scheme: values.scheme, cpu: Number(values.cpu), run, ...result }))
    }
  }
} finally {
  await browser.close()
  server.close()
}
