/**
 * Delo's Privacy section in a profile that mounts `@delo/bundle-local`, against a mock DeepSeek API: model requests
 * carry no session log by default, each upstream opt-in turns on alone after consent, and both turn off again from the
 * same screen.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delo/packages/bundle-local')
const SESSION_LOG = 'DeepSeek session-log upload'
const ANALYTICS = 'Desktop analytics'
/** Each opt-in's consent dialog title. */
const CONSENT = { [SESSION_LOG]: 'Turn on DeepSeek session-log upload?', [ANALYTICS]: 'Turn on desktop analytics?' }

/**
 * The `config.enabled` each opt-in row composes: the profile's own patch value, or the bundle's `false` when the
 * profile holds none, as after a write of the inherited value.
 */
type ProfileOptIns = { sessionLog: boolean; analytics: boolean }

it.skipIf(webSnapshotMode() === 'record')('turns each upstream opt-in on alone after consent and off again from the Privacy section', async () => {
  // The root build leaves Delo's packages out; the profile serves this package's built browser half.
  const build = spawnSync('pnpm', ['--filter', '@delo/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delo-privacy-consent-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'PRIVACY_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELO_PRIVACY_BROWSER_KEY')
  const overlay = join(root, 'privacy.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    // The analytics row mounts only in the desktop profile; here it mounts with an exporter whose collector is a closed local port.
    { id: 'product-analytics', disabled: false },
    { id: 'desktop-product-telemetry', disabled: false, config: {
      endpoint: 'http://127.0.0.1:9/v1/logs', serviceName: 'delo-privacy-fixture', serviceVersion: 'fixture',
      scheduledDelayMillis: 1000, timeoutMillis: 1000, exportTimeoutMillis: 2000, shutdownTimeoutMillis: 2000,
    } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'privacy-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-privacy-consent'))
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.locator('[data-composer-input]').first()
  const send = async (text: string): Promise<void> => {
    const settled = scaffold.whenTurnSettled()
    await input.fill(text)
    await input.press('Enter')
    await settled
  }
  const profileOptIns = async (): Promise<ProfileOptIns> => {
    const patches = yaml.load(await readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as { id?: string; config?: { enabled?: boolean } }[] | null
    const enabled = (id: string): boolean => patches?.find(patch => patch.id === id)?.config?.enabled ?? false
    return { sessionLog: enabled('session-log-deepseek'), analytics: enabled('product-analytics') }
  }
  const openPrivacy = async (): Promise<void> => {
    await openSettings(page, 'en')
    await page.getByRole('button', { name: 'Privacy', exact: true }).click()
    await page.getByText('Delo has no telemetry of its own.').waitFor()
  }
  const toggle = (name: string) => page.getByRole('switch', { name, exact: true })
  const consentTo = async (name: typeof SESSION_LOG | typeof ANALYTICS): Promise<void> => {
    await toggle(name).click()
    const dialog = page.getByRole('dialog', { name: CONSENT[name] })
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click()
    await expect.poll(() => toggle(name).getAttribute('aria-checked')).toBe('true')
  }
  const turnOff = async (name: string): Promise<void> => {
    await toggle(name).click()
    await expect.poll(() => toggle(name).getAttribute('aria-checked')).toBe('false')
  }
  const lastBody = (): object => server.requests.at(-1)?.body ?? {}

  // Off by default: the first request carries no session log.
  await send('privacy-default-marker')
  expect(server.requests.length).toBeGreaterThan(0)
  for (const request of server.requests) expect(request.body).not.toHaveProperty('dsh_session_log')

  await openPrivacy()
  await expectSwitches(page, { [SESSION_LOG]: 'false', [ANALYTICS]: 'false' })
  // Cancelling the consent dialog changes nothing.
  await toggle(ANALYTICS).click()
  await page.getByRole('dialog', { name: CONSENT[ANALYTICS] }).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expectSwitches(page, { [SESSION_LOG]: 'false', [ANALYTICS]: 'false' })

  // Desktop analytics on alone.
  await consentTo(ANALYTICS)
  await expect.poll(profileOptIns).toEqual({ sessionLog: false, analytics: true })
  expect(await scaffold.ctx.productAnalytics.enabled()).toBe(true)

  // Session-log upload on alone, then the next request carries the log.
  await turnOff(ANALYTICS)
  await expect.poll(profileOptIns).toEqual({ sessionLog: false, analytics: false })
  await consentTo(SESSION_LOG)
  await expect.poll(profileOptIns).toEqual({ sessionLog: true, analytics: false })
  expect(await scaffold.ctx.productAnalytics.enabled()).toBe(false)
  await page.keyboard.press('Escape')
  await send('privacy-upload-on-marker')
  expect(lastBody()).toHaveProperty('dsh_session_log')

  // Off again from the same screen.
  await openPrivacy()
  await turnOff(SESSION_LOG)
  await expect.poll(profileOptIns).toEqual({ sessionLog: false, analytics: false })
  await page.keyboard.press('Escape')
  await send('privacy-upload-off-marker')
  expect(lastBody()).not.toHaveProperty('dsh_session_log')
  expect(server.requests.map(request => request.outcome).every(outcome => outcome === 'completed')).toBe(true)
}, 240_000)

/**
 * Wait until each named switch shows its expected state.
 * @param page - the studio page.
 * @param expected - `aria-checked` by switch name.
 */
async function expectSwitches(page: Page, expected: Record<string, 'true' | 'false'>): Promise<void> {
  for (const [name, checked] of Object.entries(expected)) {
    await expect.poll(() => page.getByRole('switch', { name, exact: true }).getAttribute('aria-checked')).toBe(checked)
  }
}
