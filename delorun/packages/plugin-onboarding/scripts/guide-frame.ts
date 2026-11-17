/**
 * Walk the guide with Skip step and Continue and save one screenshot per step at desktop and phone width, to compare the
 * title row and the footer from step to step. Run from the repository root against a running studio of a scratch home:
 * `DELORUN_HOME=<scratch home> node_modules/.bin/tsx delorun/packages/plugin-onboarding/scripts/guide-frame.ts <out dir>`.
 * It presses no Add and no final button. A development aid, not a test.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = process.cwd()
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright') as typeof import('playwright')

const [out = ''] = process.argv.slice(2)
if (out === '') throw new Error('usage: guide-frame.ts <out dir>')
mkdirSync(resolve(out), { recursive: true })

const VIEWPORTS = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } } as const

/** @returns a fresh one-time studio link from the running home process. */
function studioLink(): string {
  const printed = execFileSync('node_modules/.bin/tsx', ['delorun/apps/cli/src/bin.ts', 'open', '--print'], { cwd: root, encoding: 'utf8', env: process.env })
  const link = printed.split(/\s+/u).find(word => word.startsWith('http'))
  if (link === undefined) throw new Error(`no link in: ${printed}`)
  return link
}

const browser = await chromium.launch()
for (const [width, viewport] of Object.entries(VIEWPORTS)) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark', deviceScaleFactor: width === 'phone' ? 2 : 1 })
  const page = await context.newPage()
  await page.goto(studioLink())
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 30_000 })
  for (let step = 1; step <= 12; step++) {
    await page.waitForTimeout(1200)
    const heading = (await dialog.getByRole('heading', { level: 2 }).first().textContent() ?? `step-${String(step)}`).trim()
    const slug = heading.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
    await page.screenshot({ path: join(out, `${width}-${String(step).padStart(2, '0')}-${slug}.png`) })
    const forward = dialog.getByRole('button', { name: /^(Skip step|Continue|Continue without a key|I understand|Got it)$/u })
    if (await forward.count() === 0) break
    await forward.first().click()
  }
  await context.close()
}
await browser.close()
