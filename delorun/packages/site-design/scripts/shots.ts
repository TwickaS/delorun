/**
 * Takes a screenshot of a locally served page in headless Chromium and prints what the page keeps: the look attributes on
 * the root element, the browser's storage and the cookies. For the pictures a site lane reports and for checking that a
 * look is carried without being stored.
 *
 * Usage: `node scripts/shots.ts <url> <out.png> [--width 1440] [--height 900] [--full] [--click <selector>]... [--wait <ms>]`
 *
 * @module @delorun/site-design/scripts/shots
 */
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' }, full: { type: 'boolean' }, click: { type: 'string', multiple: true }, wait: { type: 'string', default: '600' } },
})
const [url, out] = positionals
if (url === undefined || out === undefined) throw new Error('usage: shots.ts <url> <out.png> [--width n] [--height n] [--full] [--click selector]... [--wait ms]')

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../../apps/tools/package.json', import.meta.url))('playwright') as typeof import('playwright')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: Number(values.width), height: Number(values.height) } })
  await page.goto(url)
  await page.waitForTimeout(Number(values.wait))
  for (const selector of values.click ?? []) {
    await page.click(selector)
    await page.waitForTimeout(Number(values.wait))
  }
  await page.screenshot({ path: out, fullPage: values.full === true })
  const kept = await page.evaluate(() => ({
    address: location.pathname + location.search,
    root: { ...document.documentElement.dataset, dark: document.documentElement.classList.contains('dark') },
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    cookie: document.cookie,
  }))
  console.log(JSON.stringify(kept))
} finally {
  await browser.close()
}
