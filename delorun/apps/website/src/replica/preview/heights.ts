/**
 * How tall each chapter needs its frame: for every session, width and chapter, the frame's height and how far any
 * scrolling element inside the drawn studio overflows it (zero when the whole chapter fits). It runs under reduced
 * motion, where each chapter shows its last state, the fullest one. Run `node src/replica/preview/heights.ts [base-url]`
 * in `delorun/apps/website` with the preview server up (`vite --config src/replica/preview/vite.config.ts`). Playwright
 * comes from `apps/tools`, which depends on it; the site does not.
 * @module @delorun/website/replica/preview/heights
 */
import { createRequire } from 'node:module'

/** The few Playwright calls this script makes; the site does not depend on Playwright or its types. */
interface Locator {
  first: () => Locator
  nth: (index: number) => Locator
  click: () => Promise<void>
  count: () => Promise<number>
  waitFor: (options: { state: 'attached' | 'visible', timeout: number }) => Promise<void>
}
interface Page {
  goto: (url: string) => Promise<unknown>
  locator: (selector: string) => Locator
  getByRole: (role: string) => Locator
  waitForTimeout: (ms: number) => Promise<void>
  evaluate: <R>(fn: () => R) => Promise<R>
  close: () => Promise<void>
}
interface Browser {
  newPage: (options: { viewport: { width: number, height: number }, reducedMotion: 'reduce' | 'no-preference' }) => Promise<Page>
  close: () => Promise<void>
}

const { chromium } = createRequire(new URL('../../../../tools/package.json', import.meta.url))('playwright') as { chromium: { launch: () => Promise<Browser> } }
const base = process.argv[2] ?? 'http://127.0.0.1:18710/'
/** With `--tiny`, each frame is first cut to 360 px, so the overflow is everything the chapter needs beyond that. */
const tiny = process.argv.includes('--tiny')
const widths = (process.argv.slice(3).find(each => /^[\d,]+$/.test(each)) ?? '320,390,768,1440').split(',').map(Number)

/** What one chapter measures: the frame's size, how far a scrolling element in its active screen overflows it, and the height it needs. */
interface Measure {
  readonly width: number
  readonly frame: number
  readonly overflow: number
}

const CONFIGS = [
  { session: 'ordinary-work', width: 'responsive' },
  { session: 'changes-and-versions', width: 'responsive' },
  { session: 'ordinary-work', width: 'pair' },
] as const

const browser = await chromium.launch()
try {
  for (const { session, width } of CONFIGS) {
    for (const viewport of widths) {
      const page = await browser.newPage({ viewport: { width: viewport, height: 1000 }, reducedMotion: 'reduce' })
      await page.goto(`${base}?look=soft&scheme=light&width=${width}&session=${session}`)
      await page.locator('[data-studio-replica][inert]').first().waitFor({ state: 'attached', timeout: 60_000 })
      await page.waitForTimeout(800)
      const tabs = await page.getByRole('tab').count()
      for (let chapter = 0; chapter < tabs; chapter += 1) {
        await page.getByRole('tab').nth(chapter).click()
        await page.waitForTimeout(700)
        if (tiny) await page.evaluate((): void => { for (const figure of document.querySelectorAll('figure')) { figure.style.aspectRatio = 'auto'; figure.style.height = '360px' } })
        await page.waitForTimeout(100)
        const measured = await page.evaluate((): Measure[] => [...document.querySelectorAll<HTMLElement>('figure')].filter(figure => figure.offsetParent !== null).map(figure => ({
          width: Math.round(figure.getBoundingClientRect().width),
          frame: Math.round(figure.getBoundingClientRect().height),
          overflow: Math.max(0, ...[...figure.querySelectorAll<HTMLElement>('[data-studio-replica] *')]
            .filter(element => element.clientHeight > 1 && element.scrollHeight > element.clientHeight + 1 && element.closest('[data-screen]:not([data-active])') === null && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(element).overflowY) && !element.className.toString().includes('layout') && !element.className.toString().includes('screens') && !element.className.toString().includes('main'))
            .map(element => element.scrollHeight - element.clientHeight)),
        })))
        console.log(`${session} ${width} w${String(viewport)} chapter ${String(chapter + 1)}: ${measured.map(each => `${String(each.width)}x${String(each.frame)} +${String(each.overflow)} = ${String(each.frame + each.overflow)}`).join(' | ')}`)
      }
      await page.close()
    }
  }
} finally {
  await browser.close()
}
