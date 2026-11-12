/**
 * Walk the studio's onboarding in headless Chromium and save one screenshot per step, for each colour scheme at desktop
 * and phone width. Run from the repository root against a running studio of a scratch home, never a person's own:
 * `DELO_HOME=<scratch home> node_modules/.bin/tsx delo/packages/plugin-onboarding/scripts/screens.ts <out dir> <prefix>`.
 * Each browser context opens its own one-time studio link (`delorun open --print`), so each starts on the preview
 * notice. The walk presses Continue, and opens the states behind a press that changes nothing (the Models section, an
 * agent's confirmation, the clone form); it never adds a bundle, and only the last run presses the final button, to
 * show the first chat. A development aid, not a test.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = process.cwd()
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright') as typeof import('playwright')

const [out = '', prefix = 'before'] = process.argv.slice(2)
if (out === '') throw new Error('usage: screens.ts <out dir> [prefix]')
mkdirSync(resolve(out), { recursive: true })

const VIEWPORTS = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } } as const
const SCHEMES = ['light', 'dark'] as const

/** @returns a fresh one-time studio link from the running home process. */
function studioLink(): string {
  const printed = execFileSync('node_modules/.bin/tsx', ['delo/apps/cli/src/bin.ts', 'open', '--print'], { cwd: root, encoding: 'utf8', env: process.env })
  const link = printed.split(/\s+/u).find(word => word.startsWith('http'))
  if (link === undefined) throw new Error(`no link in: ${printed}`)
  return link
}

/**
 * Open the states a step hides behind a press that changes nothing, screenshot each, and close them again: the Models
 * section on Welcome, the first agent's confirmation on Agents, and the clone form on Workspace.
 * @param page - the page.
 * @param dialog - the onboarding dialog.
 * @param base - the screenshot path without its extension.
 */
async function extraStates(page: import('playwright').Page, dialog: import('playwright').Locator, base: string): Promise<void> {
  const models = dialog.getByRole('button', { name: 'Add or change providers' })
  if (await models.count() > 0) {
    await models.click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${base}-models.png` })
    await dialog.getByRole('button', { name: 'Hide providers' }).click()
  }
  const add = dialog.getByRole('button', { name: 'Add Claude Code' })
  // On Agents, the card's button shows once the plugin manager answers, which takes a while on a cold start.
  if (await dialog.getByRole('heading', { level: 2, name: 'Agents' }).count() > 0) {
    for (let wait = 0; wait < 40 && !(await add.count() > 0 && await add.isEnabled()); wait++) await page.waitForTimeout(500)
  }
  if (await add.count() > 0 && await add.isEnabled()) {
    await add.click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${base}-confirm.png` })
  }
  const clone = dialog.getByRole('radio', { name: 'Clone from Git' })
  if (await clone.count() > 0) {
    await clone.click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${base}-clone.png` })
    const fallback = dialog.getByRole('radio', { name: 'Default workspace' })
    if (await fallback.count() > 0) await fallback.click()
  }
}

const browser = await chromium.launch()
const combos = Object.entries(VIEWPORTS).flatMap(([width, viewport]) => SCHEMES.map(scheme => ({ width, viewport, scheme })))
for (const [index, { width, viewport, scheme }] of combos.entries()) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: width === 'phone' ? 2 : 1 })
  const page = await context.newPage()
  await page.goto(studioLink())
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 30_000 })
  for (let step = 1; step <= 12; step++) {
    await page.waitForTimeout(1200)
    const heading = (await dialog.getByRole('heading', { level: 2 }).first().textContent() ?? `step-${String(step)}`).trim()
    const slug = `${String(step).padStart(2, '0')}-${heading.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}`
    await page.screenshot({ path: join(out, `${prefix}-${width}-${scheme}-${slug}.png`) })
    await extraStates(page, dialog, join(out, `${prefix}-${width}-${scheme}-${slug}`))
    const forward = dialog.getByRole('button', { name: /^(Continue|I understand|Got it)$/u })
    if (await forward.count() > 0) {
      await forward.first().click()
      continue
    }
    // The last step: only the last run presses its button, to show the first chat and its starter prompts.
    if (index === combos.length - 1) {
      await dialog.getByRole('button', { name: /^Start a chat$/u }).click()
      // The chat opens once the harness created it; the prompts show when its message box mounts.
      await page.getByText('Try one').waitFor({ timeout: 15_000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(out, `${prefix}-${width}-${scheme}-${String(step + 1).padStart(2, '0')}-first-chat.png`) })
    }
    break
  }
  await context.close()
}
await browser.close()
