/**
 * Screenshot one step of the studio's onboarding in headless Chromium, at 1440 px and 390 px wide in each colour
 * scheme. Run from the repository root against a running studio of a scratch home, never a person's own:
 * `DELORUN_HOME=<scratch home> node_modules/.bin/tsx delorun/packages/plugin-onboarding/scripts/step-screens.ts <out dir> <prefix> <step heading>`.
 * Each browser context opens its own one-time studio link (`delorun open --print`) and walks forward, pressing
 * Continue, or Skip step where a step has no Continue, until the step's heading shows; on Models it unticks the
 * providers and goes on without a key. It adds nothing and finishes nothing. Where the step shows a preview chip, a second picture has the chip's tooltip open. A development aid, not
 * a test.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = process.cwd()
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright') as typeof import('playwright')

const [out = '', prefix = 'step', heading = ''] = process.argv.slice(2)
if (out === '' || heading === '') throw new Error('usage: step-screens.ts <out dir> <prefix> <step heading>')
mkdirSync(resolve(out), { recursive: true })

const WIDTHS = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } } as const
const SCHEMES = ['light', 'dark'] as const

/** The buttons that move the guide forward, in the order they are tried. */
const FORWARD = [/^(Continue|I understand|Got it)$/u, /^Continue without a key$/u, /^Skip step$/u]

/** @returns a fresh one-time studio link from the running home process. */
function studioLink(): string {
  const printed = execFileSync('node_modules/.bin/tsx', ['delorun/apps/cli/src/bin.ts', 'open', '--print'], { cwd: root, encoding: 'utf8', env: process.env, timeout: 120_000 })
  const link = printed.split(/\s+/u).find(word => word.startsWith('http'))
  if (link === undefined) throw new Error(`no link in: ${printed}`)
  return link
}

const browser = await chromium.launch()
for (const [width, viewport] of Object.entries(WIDTHS)) {
  for (const scheme of SCHEMES) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: width === '390' ? 2 : 1 })
    const page = await context.newPage()
    await page.goto(studioLink())
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 60_000 })
    let found = false
    for (let step = 0; step < 14 && !found; step++) {
      await page.waitForTimeout(1200)
      const shown = (await dialog.getByRole('heading', { level: 2 }).first().textContent() ?? '').trim()
      if (shown === heading) {
        found = true
        break
      }
      let pressed = false
      for (const name of FORWARD) {
        const button = dialog.getByRole('button', { name })
        if (await button.count() > 0 && await button.first().isEnabled()) {
          await button.first().click()
          pressed = true
          break
        }
      }
      if (!pressed) {
        // The Models landing connects the ticked providers; with none ticked its button goes on without a key.
        for (const box of await dialog.getByRole('checkbox', { checked: true }).all()) await box.uncheck()
        const without = dialog.getByRole('button', { name: FORWARD[1] })
        if (await without.count() === 0) throw new Error(`no way forward from the step "${shown}"`)
        await without.first().click()
      }
    }
    if (!found) throw new Error(`the guide has no step "${heading}"`)
    // The step's reads settle: the plugin manager's answer and the Host's requirement check.
    await page.waitForTimeout(4000)
    const base = join(out, `${prefix}-${width}-${scheme}`)
    await page.screenshot({ path: `${base}.png` })
    const chip = dialog.locator('[data-preview-chip]')
    if (await chip.count() > 0) {
      await chip.first().hover()
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${base}-chip.png` })
    }
    await context.close()
  }
}
await browser.close()
