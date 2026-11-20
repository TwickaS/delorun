/**
 * Photograph the studio in WebKit with the iPhone 15 profile and report the colours behind Safari's bars.
 * Run from the repository root: `tsx delorun/apps/tools/src/edges-shots.ts <studio url> <out prefix> <light|dark> <width>x<height> <script.json>`.
 * The script is a JSON array of `{ name, steps }`; each steps entry is `{ click }`, `{ press }`, `{ goto }`, `{ waitMs }` or `{ eval }`.
 * After a surface's steps it saves `<prefix>-<name>.png` and prints its edge variables and the backgrounds at the top and bottom of the screen.
 * @module @delorun/tools/edges-shots
 */
import { readFileSync } from 'node:fs'
import { devices, webkit } from 'playwright'

type Step = { click: string } | { press: string } | { goto: string } | { waitMs: number } | { eval: string } | { dump: true } | { reset: true }
interface Surface { readonly name: string; readonly steps: readonly Step[] }

const [url, prefix, scheme, size, scriptPath] = process.argv.slice(2)
if (url === undefined || prefix === undefined || scheme === undefined || size === undefined || scriptPath === undefined) throw new Error('usage: edges-shots <url> <prefix> <light|dark> <WxH> <script.json>')
const [width, height] = size.split('x').map(Number) as [number, number]
const surfaces = JSON.parse(readFileSync(scriptPath, 'utf8')) as Surface[]

const browser = await webkit.launch()
const context = await browser.newContext({ ...(width < 768 ? devices['iPhone 15'] : {}), viewport: { width, height }, colorScheme: scheme === 'dark' ? 'dark' : 'light' })
const page = await context.newPage()
const origin = new URL(url).origin
await page.goto(origin + '/').catch(() => undefined)
await page.evaluate(link => { location.href = link }, url)
await page.waitForLoadState('networkidle')
await page.waitForSelector('text=Loading plugins', { state: 'detached', timeout: 90_000 }).catch(() => undefined)
await page.waitForTimeout(1500)

/** A string, not a function: the transpiler's helper calls would not exist in the page. */
const PROBE = `(() => {
  const root = getComputedStyle(document.documentElement)
  const behind = y => {
    for (const element of document.elementsFromPoint(innerWidth / 2, y)) {
      if (element.hasAttribute('data-delorun-edge')) continue
      const colour = getComputedStyle(element).backgroundColor
      if (colour !== 'rgba(0, 0, 0, 0)') return colour + ' (' + element.tagName.toLowerCase() + (element.className ? '.' + String(element.className).split(' ')[0] : '') + ')'
    }
    return 'none'
  }
  return { top: root.getPropertyValue('--edge-top-background').trim(), bottom: root.getPropertyValue('--edge-bottom-background').trim(), under5Top: behind(6), under5Bottom: behind(innerHeight - 6) }
})()`
const probe = (): Promise<unknown> => page.evaluate(PROBE)

for (const surface of surfaces) {
  try {
    for (const step of surface.steps) {
      if ('click' in step) await page.locator(step.click).locator('visible=true').first().click({ timeout: 5000 })
      else if ('press' in step) await page.keyboard.press(step.press)
      else if ('goto' in step) await page.goto(origin + step.goto)
      else if ('waitMs' in step) await page.waitForTimeout(step.waitMs)
      else if ('reset' in step) {
        await page.goto(origin + '/')
        await page.waitForSelector('text=Loading plugins', { state: 'detached', timeout: 90_000 }).catch(() => undefined)
        await page.getByText('Complete setup later').click({ timeout: 4000 }).catch(() => undefined)
        await page.waitForTimeout(600)
      } else if ('dump' in step) console.log(await page.evaluate("[...document.querySelectorAll('button,[role=button],a,[role=menuitem],[role=tab]')].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40)).join(' | ')"))
      else console.log(JSON.stringify(await page.evaluate(step.eval)))
    }
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${prefix}-${surface.name}.png` })
    console.log(surface.name, JSON.stringify(await probe()))
  } catch (error) {
    console.log(surface.name, 'FAILED', error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
}
await browser.close()
