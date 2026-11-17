/**
 * Pictures of the replica from its local preview (`vite --config src/replica/preview/vite.config.ts`): the hero session
 * at three chapters, the Changes chapter with its dialog open, the terminal chapter, and the pair, at 1440 and 390 px wide, in Soft light and
 * Ocean dark, and one under reduced motion. Run `node src/replica/preview/shots.ts <out-dir> [base-url]` in
 * `delorun/apps/website`; it prints each picture's path and every page error. Playwright comes from `apps/tools`, which
 * depends on it; the site does not.
 * @module @delorun/website/replica/preview/shots
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
/** The few Playwright calls this script makes; the site does not depend on Playwright or its types. */
interface Locator {
  first: () => Locator
  nth: (index: number) => Locator
  click: () => Promise<void>
  count: () => Promise<number>
  waitFor: (options: { state: 'attached' | 'visible', timeout: number }) => Promise<void>
  screenshot: (options: { path: string }) => Promise<unknown>
}
interface Page {
  on: ((event: 'pageerror', listener: (error: Error) => void) => void) & ((event: 'console', listener: (message: { type: () => string, text: () => string }) => void) => void)
  goto: (url: string) => Promise<unknown>
  locator: (selector: string) => Locator
  getByRole: (role: string, options?: { name: string }) => Locator
  waitForTimeout: (ms: number) => Promise<void>
  mouse: { move: (x: number, y: number) => Promise<void> }
  close: () => Promise<void>
}
interface Browser {
  newPage: (options: { viewport: { width: number, height: number }, reducedMotion: 'reduce' | 'no-preference' }) => Promise<Page>
  close: () => Promise<void>
}

const { chromium } = createRequire(new URL('../../../../tools/package.json', import.meta.url))('playwright') as { chromium: { launch: () => Promise<Browser> } }

const out = process.argv[2]
if (out === undefined) throw new Error('usage: shots.ts <out-dir> [base-url]')
const base = process.argv[3] ?? 'http://127.0.0.1:18670/'
mkdirSync(out, { recursive: true })

const LOOKS = [{ name: 'soft-light', query: 'look=soft&scheme=light' }, { name: 'ocean-dark', query: 'look=ocean&scheme=dark' }] as const
const VIEWPORTS = [{ name: '1440', width: 1440, height: 1000 }, { name: '390', width: 390, height: 1100 }] as const
const errors: string[] = []

/**
 * Open the preview and wait for the live studio.
 * @param browser - the browser.
 * @param options - the page's address, size and motion preference.
 * @returns the page.
 */
async function open(browser: Browser, { query, width, height, reduced }: { query: string, width: number, height: number, reduced: boolean }): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  page.on('pageerror', (error) => { errors.push(`${query} ${String(width)}: ${error.message}`) })
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${query} ${String(width)}: ${message.text()}`) })
  await page.goto(`${base}?${query}`)
  await page.locator('.studio-replica[inert]').first().waitFor({ state: 'attached', timeout: 60_000 })
  return page
}

/**
 * Show a chapter from its beginning, let it run, pause it and take the replica's picture.
 * @param page - the page.
 * @param chapter - the chapter's index on the rail.
 * @param wait - how long it runs, in milliseconds, or a selector inside the drawn studio to wait for.
 * @param file - the picture's path.
 */
async function shoot(page: Page, chapter: number, wait: number | string, file: string): Promise<void> {
  await page.getByRole('tab').nth(chapter).click()
  if (typeof wait === 'number') await page.waitForTimeout(wait)
  else await page.locator(`.studio-replica ${wait}`).first().waitFor({ state: 'visible', timeout: 30_000 })
  const pause = page.getByRole('button', { name: 'Pause' })
  if (await pause.count() > 0) await pause.click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
  await page.locator('main').screenshot({ path: file })
  console.log(file)
}

const browser = await chromium.launch()
try {
  for (const look of LOOKS) {
    for (const viewport of VIEWPORTS) {
      const name = `${look.name}-${viewport.name}`
      const hero = await open(browser, { query: `${look.query}&width=responsive`, ...viewport, reduced: false })
      for (const [chapter, wait] of [[0, 4000], [1, 2000], [3, 6000]] as const) await shoot(hero, chapter, wait, join(out, `hero-${String(chapter + 1)}-${name}.png`))
      await hero.close()
      const changes = await open(browser, { query: `${look.query}&width=desktop&session=changes-and-versions`, ...viewport, reduced: false })
      await shoot(changes, 1, '[role="dialog"]', join(out, `changes-dialog-${name}.png`))
      await shoot(changes, 3, 3500, join(out, `terminal-${name}.png`))
      await changes.close()
      const pair = await open(browser, { query: `${look.query}&width=pair&session=changes-and-versions`, ...viewport, reduced: false })
      await shoot(pair, 0, 3000, join(out, `phone-section-${name}.png`))
      await pair.close()
    }
  }
  const still = await open(browser, { query: 'look=soft&scheme=light&width=responsive', ...VIEWPORTS[0], reduced: true })
  await shoot(still, 2, 1000, join(out, 'hero-3-reduced-motion-soft-light-1440.png'))
  await still.close()
} finally {
  await browser.close()
}
for (const error of errors) console.error(error)
