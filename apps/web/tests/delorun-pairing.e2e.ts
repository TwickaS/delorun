/**
 * Delorun's pairing pop-up, in a profile that mounts `@delorun/bundle-local`: the studio at the home's own computer opens
 * "A device wants to pair" for a request that arrived without an approval window, with the device's details, the code
 * field and Submit, and a wrong code shows the tries left. While a field is being typed in, the notice shows instead. The
 * pending route's answer is scripted in the page, because a window-less request needs a device on a tailnet. Zero model
 * calls. With `DELORUN_SCREENSHOT_DIR` set it saves the pop-up at 1440 and 390 px, light and dark.
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

const VIEW = { mayAskWithoutWindow: 'own-user', showRequest: 'dialog', windowMinutes: 5, requestExpiryMinutes: 5, pendingPerIdentity: 1 }

it.skipIf(webSnapshotMode() === 'record')('opens the pairing pop-up, keeps the notice while a field is typed in, and shows the tries left', async () => {
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
  const dialog = page.getByRole('dialog', { name: 'A device wants to pair' })
  const notice = page.getByText('A device asks to connect: Me Example · Pixel 9 · Android')
  // The composer may hold the focus: then the notice shows and the pop-up waits until the field is left.
  await Promise.race([dialog.waitFor({ timeout: 20_000 }), notice.waitFor({ timeout: 20_000 })])
  if (await notice.isVisible()) {
    await shot('notice-1440')
    await page.getByRole('button', { name: 'Enter code' }).click()
  }
  await dialog.waitFor()
  await dialog.getByText('Pixel 9', { exact: true }).waitFor()
  await dialog.getByText('Me Example', { exact: false }).waitFor()
  const submit = dialog.getByRole('button', { name: 'Submit' })
  expect(await submit.isDisabled()).toBe(true)
  const both = async (name: string): Promise<void> => {
    await shot(`${name}-1440`)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-390`)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await both(`pop-up-${scheme}`)
  }
  await page.emulateMedia({ colorScheme: 'light' })

  await dialog.getByLabel('Match code').fill('1234567')
  expect(await submit.isDisabled()).toBe(true)
  await dialog.getByLabel('Match code').fill('00000000')
  await shot('pop-up-typed-1440')
  await submit.click()
  await dialog.getByText('That code does not match. 2 tries left.').waitFor()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await both(`wrong-code-${scheme}`)
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  expect(wrongCodes).toBe(1)
}, 240_000)
