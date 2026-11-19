/**
 * Screenshots of the Face ID client screens, for design review. Start the preview first
 * (`node_modules/.bin/vite --config delorun/packages/bundle-local/scripts/face-id-preview/vite.config.ts`), then:
 *
 *   node_modules/.bin/tsx delorun/packages/bundle-local/scripts/face-id-preview/shoot.ts --out <directory>
 *
 * It writes `<name>-<width>-<theme>.png`: 390px wide in dark and light for every screen, and 1440px wide for the
 * screens a computer also shows. Playwright comes from `@deepseek-ai/dsh-web`'s dependencies.
 * @module @delorun/bundle-local/scripts/face-id-preview/shoot
 */
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

/** The slice of Playwright's API this script uses. */
interface Page {
  goto(url: string): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  locator(selector: string): { first(): { click(): Promise<void> } }
  screenshot(options: { path: string }): Promise<unknown>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  evaluate<T>(run: () => T): Promise<T>
}
interface Context { newPage(): Promise<Page>; close(): Promise<void> }
interface Playwright { chromium: { launch(): Promise<{ newContext(options: object): Promise<Context>; close(): Promise<void> }> } }

const { values } = parseArgs({ options: { out: { type: 'string' }, base: { type: 'string', default: 'http://127.0.0.1:19115' } } })
if (values.out === undefined) throw new Error('usage: shoot.ts --out <directory>')
const out = values.out
await mkdir(out, { recursive: true })

/** One picture: the output name, the screen query value, and the widths it is shot at. */
const SHOTS: readonly { readonly name: string; readonly screen: string; readonly wide: boolean; readonly tap?: string }[] = [
  { name: 'b2-sheet', screen: 'b2-sheet', wide: true },
  { name: 'b2-answer', screen: 'b2-answer', wide: false },
  { name: 'wire-install', screen: 'wire-install', wide: false },
  { name: 'b2-cancelled', screen: 'b2-cancelled', wide: false, tap: '[data-face-id-sheet] button' },
  { name: 'b3-pin', screen: 'b3-pin', wide: false },
  { name: 'b1-pairing', screen: 'b1-pairing', wide: true },
  { name: 'b1-add', screen: 'b1-add', wide: false },
  { name: 'b1-add-code', screen: 'b1-add-code', wide: false, tap: '[data-face-id-add] button' },
  { name: 'code-entry', screen: 'code-entry', wide: true },
  { name: 'b4-phone', screen: 'b4-phone', wide: false },
  { name: 'b4-computer', screen: 'b4-computer', wide: true },
  { name: 'devices-phone', screen: 'devices-phone', wide: false },
  { name: 'devices-phone-nokey', screen: 'devices-phone-nokey', wide: false },
]

const playwright = createRequire(new URL('../../../../../apps/web/package.json', import.meta.url))('playwright') as Playwright
const browser = await playwright.chromium.launch()
try {
  for (const width of [390, 1440]) {
    for (const theme of ['dark', 'light'] as const) {
      const mobile = width === 390
      const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', colorScheme: theme })
      try {
        for (const shot of SHOTS.filter(entry => mobile || entry.wide)) {
          const page = await context.newPage()
          await page.goto(`${values.base}/?screen=${shot.screen}&theme=${theme}`)
          await page.waitForTimeout(600)
          if (shot.tap !== undefined) {
            await page.locator(shot.tap).first().click()
            await page.waitForTimeout(600)
          }
          // A full-page capture drops Chromium's touch emulation, and with it `(pointer: coarse)` and the 44 px touch
          // targets; growing the viewport to the page keeps the emulation.
          const height = await page.evaluate(() => document.documentElement.scrollHeight)
          await page.setViewportSize({ width, height: Math.max(height, mobile ? 844 : 900) })
          await page.waitForTimeout(200)
          await page.screenshot({ path: join(out, `${shot.name}-${width}-${theme}.png`) })
        }
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}
