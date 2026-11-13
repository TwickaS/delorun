/**
 * Delo's dangerous mode, in a profile that mounts `@delo/bundle-local` with the permission row's `fullAccessEverywhere`
 * set and the grant file present in a scratch home: the sidebar shows the badge, picking Full access in a workspace
 * without a grant switches the chat with no dialog, the Settings, Permissions card turns the mode off, and the chat is
 * back on Workspace Write with the badge gone. Zero model calls: switching a preset runs no turn.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { writeDangerousGrant } from '../../../delo/packages/plugin-permission-defaults/src/store.ts'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { acknowledgeDeloNotice, connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delo/packages/bundle-local')
/** Where the screenshots of the flow go when `DELO_SCREENSHOT_DIR` names a folder. */
const SCREENSHOTS = process.env.DELO_SCREENSHOT_DIR

it.skipIf(webSnapshotMode() === 'record')('switches to full access with no dialog while dangerous mode is on, and tightens when it is turned off', async () => {
  const build = spawnSync('pnpm', ['--filter', '@delo/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delo-dangerous-mode-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const originalHome = process.env.DELO_HOME
  const home = join(root, 'delo-home')
  process.env.DELO_HOME = home
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELO_HOME')
    else process.env.DELO_HOME = originalHome
  })
  await writeDangerousGrant(home)
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'DANGER_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELO_DANGER_BROWSER_KEY')
  const overlay = join(root, 'danger.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'delo-update-gate', config: { holdUntilChecked: false } },
    { id: 'delo-permission-defaults', config: { enabled: true, fullAccessEverywhere: true } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'danger-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1440, height: 900 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-dangerous-mode'))
  await page.goto(scaffold.authenticatedUrl)
  await acknowledgeDeloNotice(page)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'site')

  const access = () => page.locator('button[aria-label^="Access mode"]').first()
  const badge = () => page.getByRole('button', { name: 'Dangerous mode is on. Open Permissions in Settings.' })
  const shot = async (name: string): Promise<void> => {
    if (SCREENSHOTS === undefined) return
    await mkdir(SCREENSHOTS, { recursive: true })
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) })
  }

  await access().waitFor({ timeout: 15_000 })
  expect(await access().getAttribute('aria-label')).toMatch(/current: Workspace Write/)
  await badge().waitFor()
  await shot('badge-1440')

  // No dialog opens for full access in a workspace that holds no grant of its own.
  await access().click()
  await page.getByRole('menuitem', { name: 'Full access' }).click()
  await expect.poll(async () => access().getAttribute('aria-label')).toMatch(/current: Full access/)
  expect(await page.getByRole('dialog').count()).toBe(0)
  await shot('no-dialog-full-access-1440')

  // The badge opens Settings on the Permissions card, which turns the mode off.
  await badge().click()
  await page.getByText('Dangerous mode is on: any chat can switch to full access without asking.').waitFor()
  await shot('settings-card-1440')
  await page.setViewportSize({ width: 390, height: 844 })
  await shot('settings-card-390')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Turn off', exact: true }).click()
  await page.getByText('Dangerous mode is off.', { exact: false }).waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(async () => access().getAttribute('aria-label'), { timeout: 15_000 }).toMatch(/current: Workspace Write/)
  await badge().waitFor({ state: 'detached' })

  // With the mode off the ordinary consent asks again.
  await access().click()
  await page.getByRole('menuitem', { name: 'Full access' }).click()
  await page.getByRole('dialog', { name: 'Allow full access for this workspace?' }).waitFor()
}, 240_000)
