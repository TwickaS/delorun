/**
 * Pictures of the replica's frames from its local preview (`vite --config src/replica/preview/vite.config.ts`): the hero
 * at its first frame at 320, 390 and 1440 px; "Watch it change" at every chapter at 390 and 1440; the phone section's pair
 * at 390, 768 and 1440; and the keyboard's Tab sequence past a replay at 390, with the focused element after each press.
 * Run `node src/replica/preview/frames-shots.ts <out-dir> [base-url]` in `delorun/apps/website`; it prints each
 * picture's path, the Tab sequence and every page error. Playwright comes from `apps/tools`, which depends on it; the
 * site does not.
 * @module @delorun/website/replica/preview/frames-shots
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
  evaluate: <R>(fn: () => R) => Promise<R>
  keyboard: { press: (key: string) => Promise<void> }
  mouse: { move: (x: number, y: number) => Promise<void> }
  close: () => Promise<void>
}
interface Browser {
  newPage: (options: { viewport: { width: number, height: number }, reducedMotion: 'reduce' | 'no-preference' }) => Promise<Page>
  close: () => Promise<void>
}

const { chromium } = createRequire(new URL('../../../../tools/package.json', import.meta.url))('playwright') as { chromium: { launch: () => Promise<Browser> } }

const out = process.argv[2]
if (out === undefined) throw new Error('usage: frames-shots.ts <out-dir> [base-url]')
const base = process.argv[3] ?? 'http://127.0.0.1:18710/'
mkdirSync(out, { recursive: true })
const errors: string[] = []

/**
 * Open the preview and wait for the live studio.
 * @param browser - the browser.
 * @param query - the preview's query.
 * @param width - the window's width.
 * @returns the page.
 */
async function open(browser: Browser, query: string, width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1100 }, reducedMotion: 'no-preference' })
  page.on('pageerror', (error) => { errors.push(`${query} ${String(width)}: ${error.message}`) })
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${query} ${String(width)}: ${message.text()}`) })
  await page.goto(`${base}?look=soft&scheme=light&${query}`)
  await page.locator('[data-studio-replica][inert]').first().waitFor({ state: 'attached', timeout: 60_000 })
  await page.waitForTimeout(600)
  return page
}

/**
 * Take the replica's picture.
 * @param page - the page.
 * @param name - the picture's name.
 */
async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  const file = join(out!, `${name}.png`)
  await page.locator('main').screenshot({ path: file })
  console.log(file)
}

const browser = await chromium.launch()
try {
  for (const width of [320, 390, 1440]) {
    const page = await open(browser, 'width=responsive', width)
    await shoot(page, `hero-first-frame-w${String(width)}`)
    await page.close()
  }
  for (const width of [390, 1440]) {
    const page = await open(browser, 'width=responsive&session=changes-and-versions', width)
    for (let chapter = 0; chapter < 4; chapter += 1) {
      await page.getByRole('tab').nth(chapter).click()
      await page.waitForTimeout(chapter === 3 ? 3500 : 1800)
      await shoot(page, `watch-it-change-chapter-${String(chapter + 1)}-w${String(width)}`)
    }
    await page.close()
  }
  for (const width of [390, 768, 1440]) {
    const page = await open(browser, 'width=pair&opens=asks-first', width)
    await shoot(page, `from-your-phone-w${String(width)}`)
    await page.close()
  }
  const page = await open(browser, 'width=responsive', 390)
  const sequence: string[] = []
  await page.locator('[role="tabpanel"]').first().click()
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press('Tab')
    sequence.push(await page.evaluate(() => {
      const active = document.activeElement
      return active === null ? 'none' : `${active.tagName.toLowerCase()}${active.getAttribute('role') === null ? '' : `[${active.getAttribute('role')!}]`} "${(active.textContent ?? '').trim().slice(0, 24)}"${active.closest('[inert]') === null ? '' : ' INSIDE INERT'}`
    }))
  }
  console.log(`Tab sequence at 390:\n${sequence.map((each, index) => `  ${String(index + 1)}. ${each}`).join('\n')}`)
  await page.close()
} finally {
  await browser.close()
}
for (const error of errors) console.error(error)
