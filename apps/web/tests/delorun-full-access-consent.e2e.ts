/**
 * Delorun's one-dialog switch to full access, in a profile that mounts `@delorun/bundle-local`: picking Full access in the
 * composer's permission control opens only Delorun's consent (upstream's built-in confirmation is skipped), whose
 * acknowledgement gates the button; confirming records the workspace's grant and the chat shows Full access, a reload
 * keeps it, cancelling changes nothing, and a second chat in the granted workspace asks the short form without a grant
 * call. Zero model calls: switching a preset runs no turn.
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
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { acknowledgeDelorunNotice, connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
/** Where the screenshots of the flow go when `DELORUN_SCREENSHOT_DIR` names a folder. */
const SCREENSHOTS = process.env.DELORUN_SCREENSHOT_DIR

const FIRST_TITLE = 'Allow full access for this workspace?'
const SHORT_TITLE = 'Switch this chat to full access?'
const BUILT_IN_TITLE = 'Enable Full access?'

it.skipIf(webSnapshotMode() === 'record')('switches a chat to full access through one dialog that records the workspace grant', async () => {
  const build = spawnSync('pnpm', ['--filter', '@delorun/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delorun-full-access-consent-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  // The grant store lives under the Delorun home; a scratch home keeps the person's own grants out of the run and the run out of them.
  const originalHome = process.env.DELORUN_HOME
  process.env.DELORUN_HOME = join(root, 'delorun-home')
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
    else process.env.DELORUN_HOME = originalHome
  })
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'ACCESS_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELORUN_ACCESS_BROWSER_KEY')
  const overlay = join(root, 'access.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    // `delorun start` releases the update gate's start hold; this scaffold has no start.
    { id: 'delorun-update-gate', config: { holdUntilChecked: false } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'access-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-full-access-consent'))
  await page.goto(scaffold.authenticatedUrl)
  await acknowledgeDelorunNotice(page)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'site')

  const access = () => page.locator('button[aria-label^="Access mode"]').first()
  const shot = async (name: string): Promise<void> => {
    if (SCREENSHOTS === undefined) return
    await mkdir(SCREENSHOTS, { recursive: true })
    // Let the dialog's fade-in finish so the picture shows it whole.
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) })
  }
  const grants = (): Promise<number> => page.evaluate(async () => {
    const answer = await (await fetch('/api/delorunPermission.workspaces')).json() as { workspaces: { grantedAt: number | null }[] }
    return answer.workspaces.filter(workspace => workspace.grantedAt !== null).length
  })
  const pickFullAccess = async (): Promise<void> => {
    await access().click()
    await page.getByRole('menuitem', { name: 'Full access' }).click()
  }
  const dialogs = () => page.getByRole('dialog')

  await access().waitFor({ timeout: 15_000 })
  expect(await access().getAttribute('aria-label')).toMatch(/current: Workspace Write/)

  // Cancelling the one dialog leaves the preset and records nothing; upstream's own dialog never shows.
  await pickFullAccess()
  const first = page.getByRole('dialog', { name: FIRST_TITLE })
  await first.waitFor()
  expect(await page.getByRole('dialog', { name: BUILT_IN_TITLE }).count()).toBe(0)
  expect(await dialogs().count()).toBe(1)
  await shot('single-dialog-first-time')
  await first.getByRole('button', { name: 'Cancel', exact: true }).click()
  await first.waitFor({ state: 'detached' })
  expect(await access().getAttribute('aria-label')).toMatch(/current: Workspace Write/)
  expect(await grants()).toBe(0)

  // The button stays disabled until the risk is acknowledged; confirming records the grant and applies the switch.
  await pickFullAccess()
  await first.waitFor()
  const allow = first.getByRole('button', { name: 'Allow full access', exact: true })
  expect(await allow.isDisabled()).toBe(true)
  await first.getByRole('checkbox', { name: 'I understand the risks and want to continue' }).check()
  await allow.click()
  await first.waitFor({ state: 'detached' })
  await expect.poll(async () => access().getAttribute('aria-label')).toMatch(/current: Full access/)
  await shot('composer-full-access')
  expect(await grants()).toBe(1)
  await page.reload()
  await access().waitFor({ timeout: 15_000 })
  expect(await access().getAttribute('aria-label')).toMatch(/current: Full access/)

  // A second chat in the granted workspace starts with full access; after the person lowers it, picking full access again
  // asks the short form and calls no grant route.
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await access().waitFor({ timeout: 15_000 })
  await expect.poll(async () => access().getAttribute('aria-label')).toMatch(/current: Full access/)
  await access().click()
  await page.getByRole('menuitem', { name: 'Workspace Write' }).click()
  await expect.poll(async () => access().getAttribute('aria-label')).toMatch(/current: Workspace Write/)
  const grantCalls: string[] = []
  page.on('request', (request) => { if (request.url().includes('delorunPermission.setFullAccess')) grantCalls.push(request.url()) })
  await pickFullAccess()
  const short = page.getByRole('dialog', { name: SHORT_TITLE })
  await short.waitFor()
  expect(await dialogs().count()).toBe(1)
  await shot('single-dialog-short-form')
  const switchNow = short.getByRole('button', { name: 'Switch this chat to full access', exact: true })
  expect(await switchNow.isDisabled()).toBe(true)
  await short.getByRole('checkbox').check()
  await switchNow.click()
  await short.waitFor({ state: 'detached' })
  await expect.poll(async () => access().getAttribute('aria-label')).toMatch(/current: Full access/)
  expect(grantCalls).toEqual([])
}, 240_000)
