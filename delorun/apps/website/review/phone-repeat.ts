/**
 * Repeats the two noisiest phone-profile measurements, the largest paint and the scroll frame rate, on the built `out/`
 * directory, and prints each run and the median. For deciding whether a single pass's number was machine load.
 *
 * Usage: `node review/phone-repeat.ts [--runs 3] [--port 18680]`
 *
 * @module @delorun/website/review/phone-repeat
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { frameRate, median, phoneVitals } from './audit.ts'
import { launch, throttleAsPhone } from './browser.ts'
import { open, url } from './page-tools.ts'
import { waitForResources } from './resources.ts'
import { serve } from './serve.ts'

const { values } = parseArgs({ options: { runs: { type: 'string', default: '3' }, port: { type: 'string', default: '18680' } } })
const out = resolve(fileURLToPath(new URL('..', import.meta.url)), 'out')

await waitForResources()
const server = await serve(out, Number(values.port))
const base = `http://127.0.0.1:${String(values.port)}`
const browser = await launch()
const paints: number[] = []
const rates: number[] = []
const worst: number[] = []
try {
  for (let run = 1; run <= Number(values.runs); run++) {
    const vitals = await phoneVitals(browser, base)
    paints.push(Number((vitals.measurements as { largestPaintMs: number | null }).largestPaintMs ?? 0))
    const session = await open(browser, { width: 390, scheme: 'light', phone: true }, 'phone scroll')
    await throttleAsPhone(session.context, session.page)
    await session.page.goto(url(base, '/'), { waitUntil: 'load', timeout: 60000 })
    await session.page.waitForTimeout(1500)
    const rate = await frameRate(session.page)
    rates.push(rate.fps)
    worst.push(rate.worstFrameMs)
    await session.context.close()
    console.log(`run ${String(run)}: largest paint ${String(paints.at(-1))} ms, scroll ${String(rate.fps)} fps, worst frame ${String(rate.worstFrameMs)} ms`)
  }
  console.log(`median: largest paint ${String(median(paints))} ms, scroll ${String(median(rates))} fps, worst frame ${String(median(worst))} ms`)
} finally {
  await browser.close()
  server.close()
}
