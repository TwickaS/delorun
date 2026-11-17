/**
 * Takes the review pictures of the setup strip and the plugin browser from a locally served page in headless Chromium,
 * at 390, 768 and 1440 px. The strip is taken in Soft light and Berry dark, before any change and after three (Ocean,
 * Berry, Spacious); the plugin browser with scripts off, with the longest entry chosen, and with the whole list shown. It
 * prints each section's height, whether anything is wider than the window, the root's look attributes and what the
 * browser stored, which must be nothing.
 *
 * Usage: `node tests/sections-shots.ts <page url> <output directory> [strip|plugins]`; the last argument takes one section only.
 *
 * @module website/tests/sections-shots
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { BrowserContextOptions, Page } from 'playwright'

const [url, out, only] = process.argv.slice(2)
if (url === undefined || out === undefined) throw new Error('usage: sections-shots.ts <page url> <output directory>')
mkdirSync(out, { recursive: true })

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../tools/package.json', import.meta.url))('playwright') as typeof import('playwright')

const WIDTHS = [390, 768, 1440] as const

/** A strip picture's look: the default page in light, or Berry carried in the link in dark. */
const LOOKS = [
  { name: 'soft-light', query: '', scheme: 'light' },
  { name: 'berry-dark', query: '?look=t3-chat&scheme=dark', scheme: 'dark' },
] as const

/** The plugin browser's longest real entry, by its sentence. */
const LONGEST = 'Delorun local integration'

const browser = await chromium.launch()

/**
 * Opens the page in a new context.
 * @param options - the context's options.
 * @param query - the link's query.
 * @returns the page.
 */
async function open(options: BrowserContextOptions, query = ''): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  const page = await context.newPage()
  await page.goto(`${url}${query}`, { waitUntil: 'networkidle' })
  return page
}

/**
 * Prints a section's measures and what the browser kept.
 * @param page - the page.
 * @param name - the picture's name.
 * @param selector - the section's root.
 */
async function measure(page: Page, name: string, selector: string): Promise<void> {
  const facts = await page.evaluate((query) => {
    const element = document.querySelector(query)
    return {
      height: element?.getBoundingClientRect().height,
      // How tall the section's drawn parts are, whatever room its box holds for them.
      content: element === null ? undefined : Math.max(...[...element.querySelectorAll('*')].map(each => each.getBoundingClientRect().bottom)) - element.getBoundingClientRect().top,
      sideways: document.documentElement.scrollWidth - innerWidth,
      root: { ...document.documentElement.dataset },
      stored: [...Object.keys(localStorage), ...Object.keys(sessionStorage), document.cookie].filter(Boolean),
    }
  }, selector)
  console.log(name, JSON.stringify(facts))
}

try {
  for (const width of WIDTHS) {
    for (const look of only === 'plugins' ? [] : LOOKS) {
      const page = await open({ viewport: { width, height: 900 }, colorScheme: look.scheme }, look.query)
      await measure(page, `strip-${String(width)}-${look.name}-still`, '[data-setup-strip]')
      await page.locator('section[aria-labelledby="make-it-yours"]').scrollIntoViewIfNeeded()
      const strip = page.locator('[data-setup-strip="live"]')
      await strip.waitFor()
      await page.waitForTimeout(500)
      await page.locator('section[aria-labelledby="make-it-yours"]').screenshot({ path: join(out, `strip-${String(width)}-${look.name}-before.png`) })
      await measure(page, `strip-${String(width)}-${look.name}-before`, '[data-setup-strip]')
      const tiles = strip.getByRole('radiogroup', { name: 'Theme' })
      await tiles.getByRole('radio', { name: /Ocean/ }).click()
      await page.waitForTimeout(500)
      await tiles.getByRole('radio', { name: /Berry/ }).click()
      await page.waitForTimeout(500)
      await strip.getByRole('radio', { name: 'Spacious' }).click()
      await page.waitForTimeout(700)
      await page.locator('section[aria-labelledby="make-it-yours"]').screenshot({ path: join(out, `strip-${String(width)}-${look.name}-after-three.png`) })
      await measure(page, `strip-${String(width)}-${look.name}-after-three`, '[data-setup-strip]')
      await page.context().close()
    }

    if (only === 'strip') continue
    const off = await open({ viewport: { width, height: 900 }, javaScriptEnabled: false })
    await off.locator('section[aria-labelledby="parts"]').screenshot({ path: join(out, `plugins-${String(width)}-scripts-off.png`) })
    await measure(off, `plugins-${String(width)}-scripts-off`, '[data-plugin-browser="still"]')
    await off.context().close()

    const still = await open({ viewport: { width, height: 900 } })
    // The still's height while scripts run, before the live browser replaces it.
    await measure(still, `plugins-${String(width)}-still-scripts-on`, '[data-plugin-browser="still"]')
    await still.locator('section[aria-labelledby="parts"]').scrollIntoViewIfNeeded()
    const list = still.getByRole('list', { name: 'Plugins' })
    await list.waitFor()
    await measure(still, `plugins-${String(width)}-live-first`, '[data-plugin-browser="live"]')
    await list.getByRole('button', { name: LONGEST }).click()
    await still.waitForTimeout(400)
    await still.locator('section[aria-labelledby="parts"]').screenshot({ path: join(out, `plugins-${String(width)}-longest-chosen.png`) })
    await still.getByRole('button', { name: /^Show all/ }).click()
    await still.waitForTimeout(300)
    await still.locator('section[aria-labelledby="parts"]').screenshot({ path: join(out, `plugins-${String(width)}-all.png`) })
    await measure(still, `plugins-${String(width)}-all`, '[data-plugin-browser="live"]')
    await still.context().close()
  }
} finally {
  await browser.close()
}
