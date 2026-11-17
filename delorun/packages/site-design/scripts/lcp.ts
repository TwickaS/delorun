/**
 * Measures the largest contentful paint of a locally served page on a phone-like profile (390 px wide, 4x CPU slowdown,
 * 1.6 Mbit/s and 150 ms latency), several times, and prints each value, the median and the element that was largest.
 *
 * Usage: `node scripts/lcp.ts <url> [runs]`
 *
 * @module @delorun/site-design/scripts/lcp
 */
import { createRequire } from 'node:module'

const [url, runsText = '5'] = process.argv.slice(2)
if (url === undefined) throw new Error('usage: lcp.ts <url> [runs]')

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../../apps/tools/package.json', import.meta.url))('playwright') as typeof import('playwright')
const browser = await chromium.launch()
const values: number[] = []
let element = ''
try {
  for (let run = 0; run < Number(runsText); run++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true })
    const page = await context.newPage()
    const client = await context.newCDPSession(page)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 })
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.addInitScript(() => {
      const holder = window as unknown as { __lcp?: { time: number; text: string } }
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1) as (PerformanceEntry & { element?: Element }) | undefined
        if (last !== undefined) holder.__lcp = { time: last.startTime, text: `${last.element?.tagName ?? '?'}: ${(last.element?.textContent ?? '').slice(0, 40)}` }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    const found = await page.evaluate(() => (window as unknown as { __lcp?: { time: number; text: string } }).__lcp)
    if (found !== undefined) { values.push(Math.round(found.time)); element = found.text }
    await context.close()
  }
} finally {
  await browser.close()
}
values.sort((a, b) => a - b)
console.log(`lcp runs ${values.join(' ')} ms; median ${String(values[Math.floor(values.length / 2)])} ms; largest: ${element}`)
