/**
 * Pictures and measures of the replica on the built site (`out/`, served by `../docs/scripts/serve-static.mjs`): the
 * hero at its first frame at 390, 768 and 1440 px, with reduced motion and with scripts off; "Watch it change" at each
 * chapter and "From your phone" at 1440 and 390 px; each frame's size; and the layout shift on load on a phone profile
 * (390 px, four times slower CPU), with the elements that moved. Run `node src/replica/preview/site-shots.ts <out-dir>
 * <base-url>` in `delorun/apps/website`. Playwright comes from `apps/tools`, which depends on it; the site does not.
 * @module @delorun/website/replica/preview/site-shots
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
  screenshot: (options: { path: string }) => Promise<unknown>
}
interface Page {
  on: (event: 'pageerror', listener: (error: Error) => void) => void
  goto: (url: string, options?: { waitUntil: 'load' | 'networkidle' }) => Promise<unknown>
  locator: (selector: string) => Locator
  waitForTimeout: (ms: number) => Promise<void>
  evaluate: <R, A>(fn: (arg: A) => R, arg: A) => Promise<R>
  addInitScript: (script: string) => Promise<void>
  context: () => { newCDPSession: (page: Page) => Promise<{ send: (method: string, params: object) => Promise<unknown> }> }
  close: () => Promise<void>
}
interface Browser {
  newPage: (options: { viewport: { width: number, height: number }, reducedMotion: 'reduce' | 'no-preference', javaScriptEnabled: boolean, deviceScaleFactor?: number, isMobile?: boolean, hasTouch?: boolean }) => Promise<Page>
  close: () => Promise<void>
}

const { chromium } = createRequire(new URL('../../../../tools/package.json', import.meta.url))('playwright') as { chromium: { launch: () => Promise<Browser> } }

const [out, base] = process.argv.slice(2)
if (out === undefined || base === undefined) throw new Error('usage: site-shots.ts <out-dir> <base-url>')
mkdirSync(out, { recursive: true })
const errors: string[] = []

/** How a page is opened. */
interface Open {
  readonly width: number
  readonly reduced?: boolean
  readonly scripts?: boolean
}

/**
 * Open the home page.
 * @param browser - the browser.
 * @param options - the width, the motion preference and whether scripts run.
 * @returns the page, loaded.
 */
async function open(browser: Browser, { width, reduced = false, scripts = true }: Open): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference', javaScriptEnabled: scripts })
  page.on('pageerror', (error) => { errors.push(`${String(width)}: ${error.message}`) })
  await page.goto(base!, { waitUntil: 'load' })
  return page
}

/**
 * Take a picture of the section a heading names.
 * @param page - the page.
 * @param heading - the heading's id.
 * @param file - the picture's name.
 */
async function section(page: Page, heading: string, file: string): Promise<void> {
  await page.locator(`section:has(#${heading})`).first().screenshot({ path: join(out!, file) })
  console.log(join(out!, file))
}

/**
 * The size of every replica frame on the page, by the section it is in.
 * @param page - the page.
 * @returns one line per frame that shows.
 */
async function frames(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('figure[aria-label]')].flatMap((figure) => {
    const box = figure.getBoundingClientRect()
    if (box.width === 0) return []
    const id = figure.closest('section')?.querySelector('[id]')?.id ?? '?'
    return [`${id}: ${String(Math.round(box.width))} x ${String(Math.round(box.height))}`]
  }), undefined)
}

const browser = await chromium.launch()
try {
  for (const width of [390, 768, 1440]) {
    const page = await open(browser, { width })
    await section(page, 'hero', `hero-first-frame-${String(width)}.png`)
    for (const line of await frames(page)) console.log(`frame at ${String(width)}: ${line}`)
    await page.close()
    for (const [state, options] of [['reduced-motion', { reduced: true }], ['scripts-off', { scripts: false }]] as const) {
      const other = await open(browser, { width, ...options })
      await other.waitForTimeout(state === 'reduced-motion' ? 1500 : 0)
      await section(other, 'hero', `hero-${state}-${String(width)}.png`)
      if (width !== 768) {
        await section(other, 'replays', `replays-${state}-${String(width)}.png`)
        await section(other, 'phone', `phone-${state}-${String(width)}.png`)
      }
      await other.close()
    }
  }
  for (const width of [1440, 390]) {
    const page = await open(browser, { width })
    await page.evaluate(() => { document.querySelector('#replays')?.scrollIntoView() }, undefined)
    await page.waitForTimeout(2000)
    const tabs = page.locator('section:has(#replays) [role="tab"]')
    for (let index = 0; index < await tabs.count(); index++) {
      await tabs.nth(index).click()
      await page.waitForTimeout(700)
      await section(page, 'replays', `replays-chapter-${String(index + 1)}-${String(width)}.png`)
    }
    await page.evaluate(() => { document.querySelector('#phone')?.scrollIntoView() }, undefined)
    await page.waitForTimeout(2500)
    await section(page, 'phone', `phone-${String(width)}.png`)
    await page.close()
  }
  // Layout shift on load on a phone profile, as the audit measures it.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference', javaScriptEnabled: true, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await phone.addInitScript(`window.__shifts = []; new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shifts.push({ value: entry.value, sources: entry.sources.map(source => (source.node && source.node.nodeType === 1 ? source.node.tagName + '.' + String(source.node.className).slice(0, 40) : String(source.node && source.node.nodeName)) + ' ' + JSON.stringify(source.previousRect) + ' -> ' + JSON.stringify(source.currentRect)) }) }).observe({ type: 'layout-shift', buffered: true })`)
  await (await phone.context().newCDPSession(phone)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await phone.goto(base, { waitUntil: 'load' })
  await phone.waitForTimeout(5000)
  const shifts: readonly { readonly value: number, readonly sources: readonly string[] }[] = JSON.parse(await phone.evaluate(() => JSON.stringify(Reflect.get(window, '__shifts')), undefined))
  console.log(`layout shift on load (390 px, 4x CPU): ${shifts.reduce((total, shift) => total + shift.value, 0).toFixed(4)}`)
  for (const shift of shifts) console.log(`  ${shift.value.toFixed(4)} ${shift.sources.join(' | ')}`)
  await phone.close()
} finally {
  await browser.close()
}
for (const error of errors) console.error(error)
