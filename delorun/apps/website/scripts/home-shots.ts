/**
 * Takes the home page's review pictures in headless Chromium: the hero, halfway through the zoom, the hand-off to the
 * film, the wall, the lightbox and the footer, each at 1440 and 390 px wide, in the light and the dark scheme.
 *
 * Usage: `node scripts/home-shots.ts <page address> <output directory> [suffix]`
 *
 * @module @delorun/website/scripts/home-shots
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Browser } from 'playwright'

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../tools/package.json', import.meta.url))('playwright') as typeof import('playwright')

const [base, out, suffix = ''] = process.argv.slice(2)
if (base === undefined || out === undefined) throw new Error('Usage: node scripts/home-shots.ts <page address> <output directory> [suffix]')
mkdirSync(out, { recursive: true })

const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const
const SCHEMES = ['light', 'dark'] as const

/**
 * Takes one size and scheme's pictures.
 * @param browser - the browser.
 * @param size - the window.
 * @param scheme - light or dark.
 */
async function shoot(browser: Browser, size: { readonly width: number; readonly height: number }, scheme: 'light' | 'dark'): Promise<void> {
  const phone = size.width < 640
  const context = await browser.newContext({ viewport: size, colorScheme: scheme, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone })
  const page = await context.newPage()
  const name = (part: string) => join(out ?? '', `${part}-${String(size.width)}-${scheme}${suffix}.png`)
  await page.goto(base ?? '', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: name('hero') })

  const hero = page.locator('section[aria-labelledby="home-hero"]')
  const box = await hero.evaluate(el => ({ top: el.getBoundingClientRect().top + window.scrollY, height: el.offsetHeight }))
  const range = box.height - size.height
  for (const [part, at] of [['zoom', 0.5], ['handoff', 1.02]] as const) {
    await page.evaluate(y => window.scrollTo(0, y), box.top + range * at)
    // Time for the tiles the zoom shows larger to load their sharper level.
    await page.waitForTimeout(1800)
    await page.screenshot({ path: name(part) })
  }

  const wall = page.locator('section[aria-labelledby="home-wall"]')
  await wall.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + 160))
  await page.waitForTimeout(1200)
  await page.screenshot({ path: name('wall') })
  await wall.locator('[data-shot]').filter({ visible: true }).nth(2).click()
  await page.waitForTimeout(1300)
  await page.screenshot({ path: name('lightbox') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(900)
  await page.screenshot({ path: name('footer') })
  await context.close()
}

const browser = await chromium.launch()
try {
  for (const size of SIZES) for (const scheme of SCHEMES) await shoot(browser, size, scheme)
} finally {
  await browser.close()
}
