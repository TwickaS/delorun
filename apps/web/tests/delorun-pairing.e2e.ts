/**
 * Delorun's pop-up pairing notice and code box, in a profile that mounts `@delorun/bundle-local`: the studio at the home's
 * own computer shows "A device asks to connect" for a request that arrived without an approval window, Enter code opens
 * the code box with the Tailscale user above the device, and a wrong code is counted in place. The pending route's answer
 * is scripted in the page, because a window-less request needs a device on a tailnet. Zero model calls.
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
import { acknowledgeDelorunNotice, newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
/** Where the screenshots of the flow go when `DELORUN_SCREENSHOT_DIR` names a folder. */
const SCREENSHOTS = process.env.DELORUN_SCREENSHOT_DIR

const VIEW = { mayAskWithoutWindow: 'own-user', showRequest: 'notice', windowMinutes: 5, requestExpiryMinutes: 5, pendingPerIdentity: 1 }

it.skipIf(webSnapshotMode() === 'record')('shows the pairing notice, opens the code box and counts a wrong code', async () => {
  const build = spawnSync('pnpm', ['--filter', '@delorun/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delorun-pairing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const originalHome = process.env.DELORUN_HOME
  process.env.DELORUN_HOME = join(root, 'delorun-home')
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
    else process.env.DELORUN_HOME = originalHome
  })
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'PAIRING_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELORUN_PAIRING_BROWSER_KEY')
  const overlay = join(root, 'pairing.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'delorun-update-gate', config: { holdUntilChecked: false } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'pairing-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1440, height: 900 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-pairing'))

  let wrongCodes = 0
  const request = () => ({
    requestId: 'ask-1', label: 'Pixel 9', platform: 'Android', address: 'https://home.example.ts.net', createdAt: Date.now() - 5_000, expiresAt: Date.now() + 295_000,
    identity: { login: 'me@example.com', name: 'Me Example' }, windowless: true, wrongCodes,
  })
  await page.route('**/auth/devices/pending', route => route.fulfill({ json: { windowClosesAt: null, pending: [request()], pairing: VIEW } }))
  await page.route('**/auth/devices/approve', (route) => {
    wrongCodes += 1
    return route.fulfill({ status: 403, json: { error: 'APPROVAL_CODE_MISMATCH', message: 'That code does not match' } })
  })
  const shot = async (name: string): Promise<void> => {
    if (SCREENSHOTS === undefined) return
    await mkdir(SCREENSHOTS, { recursive: true })
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) })
  }

  await page.goto(scaffold.authenticatedUrl)
  await acknowledgeDelorunNotice(page)
  const notice = page.getByText('A device asks to connect: Me Example · Pixel 9 · Android')
  await notice.waitFor({ timeout: 20_000 })
  await shot('notice-1440')
  await page.setViewportSize({ width: 390, height: 844 })
  await shot('notice-390')
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.getByRole('button', { name: 'Enter code' }).click()
  const dialog = page.getByRole('dialog', { name: 'Enter the code from your device' })
  await dialog.waitFor()
  await dialog.getByText('Tailscale user: Me Example').waitFor()
  await shot('code-box-1440')
  await page.setViewportSize({ width: 390, height: 844 })
  await shot('code-box-390')
  await page.setViewportSize({ width: 1440, height: 900 })

  await dialog.getByLabel('Match code').fill('00000000')
  await dialog.getByText('Wrong codes: 1 of 3.', { exact: false }).waitFor()
  await shot('wrong-code-1440')
  await page.setViewportSize({ width: 390, height: 844 })
  await shot('wrong-code-390')
}, 240_000)
