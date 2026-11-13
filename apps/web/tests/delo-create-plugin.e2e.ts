/**
 * Create a plugin in a fresh Delorun studio on loopback: in Settings, Plugins it writes the scaffold into the connected
 * workspace's `plugins` folder and nowhere else, lists the files, and Turn on only records a change that waits in
 * Changes, with the plugin not on.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, openDeloSettings, revealNavigationDrawer, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delo/packages/bundle-local')
const BUNDLE_STUDIO = join(REPO, 'delo/packages/bundle-studio')
const BUILT = [
  '@delo/bundle-local', '@delo/plugin-theme', '@delo/plugin-settings-layout', '@delo/plugin-chat-states', '@delo/plugin-sidebar',
  '@delo/plugin-onboarding', '@delo/plugin-trash', '@delo/plugin-changes',
]

it.skipIf(webSnapshotMode() === 'record')('creates a plugin in the workspace and asks for it to be turned on in Changes', async () => {
  const build = spawnSync('pnpm', [...BUILT.flatMap(name => ['--filter', name]), 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }, { dir: BUNDLE_STUDIO, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-create-plugin'))
  await page.goto(scaffold.authenticatedUrl)
  // A fresh profile opens Delo's onboarding, whose dialog covers the sidebar until it is skipped.
  const onboarding = page.getByRole('dialog')
  await onboarding.getByRole('button', { name: 'Continue', exact: true }).click()
  await onboarding.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await onboarding.waitFor({ state: 'detached' })
  // The studio bundle words the composer placeholder differently, so the helper's wait for it does not apply: the
  // picker's Open closes its dialog, which is the connection this scenario needs.
  mkdirSync(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
  await revealNavigationDrawer(page, 'en')
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await picker.waitFor({ timeout: 10_000 })
  await picker.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = picker.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(join(scaffold.workspaceCwd, 'workspace'))
  await pathInput.press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await picker.waitFor({ state: 'detached' })
  await openDeloSettings(page)
  await page.getByLabel('Agent').getByRole('button', { name: 'Plugins' }).click()
  await page.getByRole('heading', { name: 'Create a plugin' }).waitFor()
  await page.getByLabel('Name', { exact: true }).fill('hello-e2e')
  await page.getByRole('button', { name: 'Create plugin', exact: true }).click()
  await page.locator('[data-delo-create-result]').getByText('package.json', { exact: true }).waitFor()
  const folder = join(scaffold.workspaceCwd, 'workspace', 'plugins', 'hello-e2e')
  expect(existsSync(join(folder, 'package.json'))).toBe(true)
  expect(readdirSync(join(scaffold.workspaceCwd, 'workspace'))).toEqual(['plugins'])
  await page.getByRole('button', { name: 'Turn on', exact: true }).click()
  await page.getByText('Waiting in Changes for your review.').waitFor()
  const state = await page.evaluate(async () => await (await fetch('delo/changes/state')).json()) as { requests: { summary: string }[] }
  expect(state.requests).toHaveLength(1)
  expect(state.requests[0]!.summary).toContain('hello-e2e')
}, 180_000)
