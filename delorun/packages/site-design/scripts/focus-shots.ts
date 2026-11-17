/**
 * Takes pictures of keyboard focus on a theme tile and on a footer link at 1440 and 390 px, from a locally served site,
 * and prints the focus outline each element has.
 *
 * Usage: `node scripts/focus-shots.ts <base-url> <out-dir>`
 *
 * @module @delorun/site-design/scripts/focus-shots
 */
import { createRequire } from 'node:module'

const [base, out] = process.argv.slice(2)
if (base === undefined || out === undefined) throw new Error('usage: focus-shots.ts <base-url> <out-dir>')

// The tools package owns the Playwright dependency.
const { chromium } = createRequire(new URL('../../../apps/tools/package.json', import.meta.url))('playwright') as typeof import('playwright')
const browser = await chromium.launch()
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.goto(base)
    await page.waitForTimeout(1500)
    for (const [name, selector] of [['tile', '[role=radio]:has-text("Ocean")'], ['footer-link', 'footer nav a >> nth=1']] as const) {
      const element = page.locator(selector).first()
      if (await element.count() === 0) {
        console.log(name, width, 'not found')
        continue
      }
      await element.scrollIntoViewIfNeeded()
      // Focus after a key press, so the browser treats it as keyboard focus and draws the focus-visible ring.
      await page.keyboard.press('Tab')
      await element.focus()
      await page.waitForTimeout(400)
      const box = await element.boundingBox()
      if (box === null) throw new Error(`${name} has no box at ${String(width)} px`)
      const x = Math.max(0, box.x - 40)
      const y = Math.max(0, box.y - 40)
      await page.screenshot({ path: `${out}/focus-${name}-${String(width)}.png`, clip: { x, y, width: Math.min(width - x, box.width + 80), height: box.height + 80 } })
      console.log(name, width, await element.evaluate(each => { const style = getComputedStyle(each); return `${style.outlineColor} ${style.outlineWidth} offset ${style.outlineOffset}` }))
    }
    await page.close()
  }
} finally {
  await browser.close()
}
