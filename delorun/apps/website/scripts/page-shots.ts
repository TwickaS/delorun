/**
 * Takes the home page's review pictures in headless Chromium, in the states `packages/site-design/scripts/shots.ts`
 * does not reach: with scripts off, with reduced motion, and with keyboard focus moved to the first control marked
 * unavailable (the desktop button). Prints the element that has focus.
 *
 * Usage: `node scripts/page-shots.ts <full|noscript|reduced|focus> <url> <out.png> [width] [height] [light|dark]`
 *
 * @module @delorun/website/scripts/page-shots
 */
import { createRequire } from 'node:module'

/** The states a picture can be taken in. */
const MODES = ['full', 'noscript', 'reduced', 'focus'] as const

/** Tab presses before the focus search gives up. */
const MAX_TABS = 60

const [mode, url, out, width = '1440', height = '900', scheme = 'light'] = process.argv.slice(2)
if (!MODES.some(each => each === mode) || url === undefined || out === undefined || (scheme !== 'light' && scheme !== 'dark')) {
  throw new Error('usage: page-shots.ts <full|noscript|reduced|focus> <url> <out.png> [width] [height] [light|dark]')
}

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../tools/package.json', import.meta.url))('playwright') as typeof import('playwright')
const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    viewport: { width: Number(width), height: Number(height) },
    javaScriptEnabled: mode !== 'noscript',
    colorScheme: scheme,
    reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference',
  })
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForTimeout(600)
  if (mode === 'focus') {
    for (let tab = 0; tab < MAX_TABS; tab += 1) {
      await page.keyboard.press('Tab')
      if (await page.evaluate(() => document.activeElement?.getAttribute('aria-disabled') === 'true')) break
    }
    await page.waitForTimeout(300)
  }
  await page.screenshot({ path: out, fullPage: mode === 'full' || mode === 'reduced' })
  console.log(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? ''))
} finally {
  await browser.close()
}
