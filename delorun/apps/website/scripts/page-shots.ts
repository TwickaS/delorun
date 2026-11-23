/**
 * Takes the home page's review pictures in headless Chromium, in the states `packages/site-design/scripts/shots.ts`
 * does not reach: with scripts off, with reduced motion, and with keyboard focus moved to the first control marked
 * unavailable (the desktop button). Prints the element that has focus. `zoom` takes one window-sized picture at each of
 * several points of the hero's scroll zoom instead, named `<out>-p<percent>.png`, for checking that the zoom draws the same.
 *
 * Usage: `node scripts/page-shots.ts <full|noscript|reduced|focus|zoom> <url> <out.png> [width] [height] [light|dark] [pixel ratio]`
 *
 * @module @delorun/website/scripts/page-shots
 */
import { createRequire } from 'node:module'

/** The states a picture can be taken in. */
const MODES = ['full', 'noscript', 'reduced', 'focus', 'zoom'] as const

/** The points of the hero's scroll, as fractions of its length, that `zoom` takes a picture at. */
const ZOOM_POINTS = [0, 0.15, 0.35, 0.55, 0.75, 0.9] as const

/** How long each zoom point waits for the sharper tiles the zoom loads once the scroll pauses, in milliseconds. */
const ZOOM_SETTLE = 1500

/** Tab presses before the focus search gives up. */
const MAX_TABS = 60

const [mode, url, out, width = '1440', height = '900', scheme = 'light', ratio = '1'] = process.argv.slice(2)
if (!MODES.some(each => each === mode) || url === undefined || out === undefined || (scheme !== 'light' && scheme !== 'dark')) {
  throw new Error('usage: page-shots.ts <full|noscript|reduced|focus|zoom> <url> <out.png> [width] [height] [light|dark] [pixel ratio]')
}

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../tools/package.json', import.meta.url))('playwright') as typeof import('playwright')
const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    viewport: { width: Number(width), height: Number(height) },
    deviceScaleFactor: Number(ratio),
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
  if (mode === 'zoom') {
    // The full-size pictures the zoom hands over to load on the first scroll or after an idle moment.
    await page.waitForTimeout(3000)
    for (const point of ZOOM_POINTS) {
      await page.evaluate(at => {
        const hero = document.querySelector<HTMLElement>('section[aria-labelledby="home-hero"]')
        if (hero !== null) scrollTo(0, hero.offsetTop + at * (hero.offsetHeight - innerHeight))
      }, point)
      await page.waitForTimeout(ZOOM_SETTLE)
      await page.screenshot({ path: out.replace(/\.png$/, '') + `-p${String(Math.round(point * 100)).padStart(2, '0')}.png` })
    }
  } else {
    await page.screenshot({ path: out, fullPage: mode === 'full' || mode === 'reduced' })
  }
  console.log(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? ''))
} finally {
  await browser.close()
}
