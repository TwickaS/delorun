/**
 * Measures the home page's bytes over the network at each stage a visitor reaches: the first screen, halfway through the
 * zoom, the end of the zoom, and the lightbox opened from a mosaic tile. Each count is the bytes on the wire (after
 * compression) of every request so far, split into pictures and the rest, with the largest contentful paint. The phone
 * run uses a 390 px screen at 3× with a throttled network (1.6 Mbit/s down, 150 ms) and a 4× slower processor, a common
 * stand-in for a mid-range phone on a slow 4G link. run it against a built copy, such
 * as `wrangler dev` serving `out/`, since the dev server's unbundled modules are not what a visitor downloads.
 *
 * Usage: `node scripts/page-weight.ts <page address> desktop|phone`
 *
 * @module @delorun/website/scripts/weight
 */
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../tools/package.json', import.meta.url))
const { chromium } = require('playwright') as typeof import('playwright')

const [address, device] = process.argv.slice(2)
if (address === undefined || (device !== 'desktop' && device !== 'phone')) throw new Error('Usage: node scripts/page-weight.ts <page address> desktop|phone')
const phone = device === 'phone'

const browser = await chromium.launch()
const context = await browser.newContext(phone
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' }
  : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
if (phone) {
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
}

const urls = new Map<string, string>()
let pictures = 0
let rest = 0
let count = 0
cdp.on('Network.responseReceived', event => { urls.set(event.requestId, event.response.url) })
cdp.on('Network.loadingFinished', event => {
  count++
  if (/\.(avif|webp|png|jpe?g)(\?|$)/.test(urls.get(event.requestId) ?? '')) pictures += event.encodedDataLength
  else rest += event.encodedDataLength
})

/**
 * Prints the bytes so far.
 * @param stage - the stage's name.
 */
function report(stage: string): void {
  console.log(`${stage.padEnd(14)} ${((pictures + rest) / 1024).toFixed(0).padStart(6)} KB in ${String(count).padStart(3)} requests (pictures ${(pictures / 1024).toFixed(0)} KB, the rest ${(rest / 1024).toFixed(0)} KB)`)
}

await page.goto(address, { waitUntil: 'networkidle', timeout: 180_000 })
const lcp = await page.evaluate(() => new Promise<string>(resolve => {
  new PerformanceObserver(list => {
    const last = list.getEntries().at(-1) as (PerformanceEntry & { element?: Element; url?: string }) | undefined
    resolve(`${last?.startTime.toFixed(0) ?? '?'} ms (${last?.element?.className.toString().replace(/_[a-z0-9]+_[0-9]+/g, '') ?? '?'}${last?.url === undefined || last.url === '' ? '' : `, ${last.url.split('/').pop() ?? ''}`})`)
  }).observe({ type: 'largest-contentful-paint', buffered: true })
}))
report('first screen')
console.log(`largest paint  ${lcp}`)

const range = await page.evaluate(() => {
  const hero = document.querySelector<HTMLElement>('section[aria-labelledby="home-hero"]')
  return hero === null ? 0 : hero.offsetHeight - innerHeight
})
for (const [stage, until] of [['mid zoom', 0.5], ['end of zoom', 1]] as const) {
  for (let at = 0.05; at <= until + 0.001; at += 0.05) {
    await page.evaluate(y => { scrollTo(0, y) }, range * at)
    await page.waitForTimeout(phone ? 260 : 160)
  }
  await page.waitForTimeout(1500)
  report(stage)
}

await page.evaluate(() => { scrollTo(0, 0) })
await page.waitForTimeout(800)
await page.locator('[data-layout] [data-shot]').filter({ visible: true }).nth(phone ? 20 : 60).click()
await page.waitForTimeout(phone ? 4000 : 1500)
report('lightbox')
await browser.close()
