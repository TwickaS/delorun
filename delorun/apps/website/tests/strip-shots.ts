/**
 * Takes the setup strip's review pictures from a locally served page in headless Chromium: the section after Soft to
 * Ocean to Custom moss and back, at a wide and a phone width, in light and dark, with reduced motion, and with scripts off.
 * It prints the strip's box and content heights, the root's look attributes and what the browser stored after each run,
 * which must be nothing.
 *
 * Usage: `node tests/strip-shots.ts <page url> <output directory>`
 *
 * @module website/tests/strip-shots
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [url, out] = process.argv.slice(2)
if (url === undefined || out === undefined) throw new Error('usage: strip-shots.ts <page url> <output directory>')
mkdirSync(out, { recursive: true })

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../tools/package.json', import.meta.url))('playwright') as typeof import('playwright')

/** One picture: its viewport width, colour scheme, motion preference and whether scripts run. */
interface Shot {
  readonly name: string
  readonly width: number
  readonly scheme: 'light' | 'dark'
  readonly reducedMotion: boolean
  readonly scripts: boolean
}

const SHOTS: readonly Shot[] = [
  { name: 'strip-1440-light', width: 1440, scheme: 'light', reducedMotion: false, scripts: true },
  { name: 'strip-1440-dark', width: 1440, scheme: 'dark', reducedMotion: false, scripts: true },
  { name: 'strip-390-light', width: 390, scheme: 'light', reducedMotion: false, scripts: true },
  { name: 'strip-390-dark-reduced', width: 390, scheme: 'dark', reducedMotion: true, scripts: true },
  { name: 'strip-1440-reduced', width: 1440, scheme: 'light', reducedMotion: true, scripts: true },
  { name: 'strip-1440-scripts-off', width: 1440, scheme: 'light', reducedMotion: false, scripts: false },
  { name: 'strip-390-scripts-off', width: 390, scheme: 'light', reducedMotion: false, scripts: false },
]

const browser = await chromium.launch()
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: { width: shot.width, height: 900 },
      colorScheme: shot.scheme,
      reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference',
      javaScriptEnabled: shot.scripts,
    })
    const page = await context.newPage()
    // The strip works once the page has hydrated, after its scripts have loaded.
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.locator('#make-it-yours').scrollIntoViewIfNeeded()
    // The page loads the live strip as its section nears the screen; until then, and with scripts off, the still stands.
    const strip = page.locator(shot.scripts ? '[data-setup-strip="live"]' : '[data-setup-strip="still"]')
    await strip.waitFor()
    if (shot.scripts) {
      await page.waitForTimeout(800)
      const tiles = strip.getByRole('radiogroup', { name: 'Theme' })
      await tiles.getByRole('radio', { name: /Ocean/ }).click()
      await page.waitForTimeout(600)
      await strip.getByRole('radio', { name: 'Moss' }).click()
      await page.waitForTimeout(600)
      await strip.getByRole('button', { name: 'Back to Ocean' }).click()
      await page.waitForTimeout(800)
    }
    await page.locator('#make-it-yours').screenshot({ path: join(out, `${shot.name}.png`) })
    const box = await strip.evaluate(element => ({ height: element.getBoundingClientRect().height, content: element.scrollHeight, body: element.firstElementChild?.getBoundingClientRect().height }))
    const kept = await page.evaluate(() => ({
      root: { ...document.documentElement.dataset, dark: document.documentElement.classList.contains('dark') },
      localStorage: Object.keys(localStorage),
      sessionStorage: Object.keys(sessionStorage),
      cookie: document.cookie,
    }))
    console.log(shot.name, JSON.stringify({ box, ...kept }))
    await context.close()
  }
} finally {
  await browser.close()
}
