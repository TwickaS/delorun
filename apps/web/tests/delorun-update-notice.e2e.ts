/**
 * Delorun's update notice in the studio's sidebar, in a profile that mounts `@delorun/bundle-local` and
 * `@delorun/bundle-studio`: the Host's `delorun-update-check` row serves a fixed notice from a check attached the way
 * `delorun` attaches one, the page shows its text and an Update now… button once onboarding is skipped, hides it for that
 * release when closed, and on a page marked as a remote session shows the text with no control.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
const BUNDLE_STUDIO = join(REPO, 'delorun/packages/bundle-studio')
/** The packages whose built browser halves the profile serves: the two bundles' own and the studio plugins they mount. */
const BUILT = ['@delorun/bundle-local', '@delorun/plugin-theme', '@delorun/plugin-settings-layout', '@delorun/plugin-chat-states', '@delorun/plugin-sidebar', '@delorun/plugin-new-workspace', '@delorun/plugin-onboarding', '@delorun/plugin-update', '@delorun/plugin-tool-failure-guard', '@delorun/plugin-trash', '@delorun/plugin-downloads']
/** The attached check's notice: a security fix on the same DeepSeek Harness that keeps every plugin. */
const NOTICE = {
  running: { delorun: '0.1.2', dsh: '0.2.2' },
  release: { delorun: '0.1.3', dsh: '0.2.2', channel: 'stable', security: true, summary: 'Fixes the reach listener\'s cookie check' },
  kind: 'patch',
  disables: 0,
} as const

/** What the attached check reports, as `@delorun/bundle-local/update-check` names it. */
interface UpdateCheckState {
  readonly checked?: number
  readonly notice?: typeof NOTICE
}

/**
 * The method of the `delorunUpdateCheck` service this spec calls, as `@delorun/bundle-local/update-check` declares it; the
 * Web app does not depend on Delorun's packages, so the spec names it here.
 */
interface UpdateCheckService {
  attach(source: { read(): Promise<UpdateCheckState>; check(timeoutMs: number): Promise<UpdateCheckState> }): () => void
}

/**
 * Whether a service value has the `attach` method of {@link UpdateCheckService}; `ctx.get` types a service this
 * program does not declare as `any`.
 * @param value - the service value.
 * @returns whether it offers `attach`.
 */
function isUpdateCheck(value: unknown): value is UpdateCheckService {
  return typeof value === 'object' && value !== null && 'attach' in value && typeof value.attach === 'function'
}

/**
 * Open the studio and wait for the notice.
 * @param browser - the browser.
 * @param url - the studio's authenticated address.
 * @param remote - whether the page is marked as one a reach listener served.
 * @returns the page, with the notice shown.
 */
async function openStudio(browser: Browser, url: string, remote: boolean): Promise<Page> {
  const page = await newEnglishPage(browser)
  if (remote) await page.addInitScript(() => { Reflect.set(globalThis, '__DSH_REMOTE_MEDIA__', 'placeholder') })
  await page.goto(url)
  await page.locator('[data-update-notice="0.1.3"]').waitFor({ timeout: 30_000 })
  return page
}

it.skipIf(webSnapshotMode() === 'record')('shows the Host\'s update notice in the sidebar, hides it for its release when closed, and offers no control on a remote session', async () => {
  // The root build leaves Delorun's packages out; the profile serves their built browser halves.
  // One call per package: bundle-local and plugin-update reference each other, which one `--filter` run refuses as a task cycle.
  for (const name of BUILT) {
    const build = spawnSync('pnpm', ['--filter', name, 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
    expect(build.status, `${name}: ${build.stdout}${build.stderr}`).toBe(0)
  }
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }, { dir: BUNDLE_STUDIO, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  // The bundle's patch turns the row's switch on; the check is the one fixed source `delorun` would otherwise attach.
  const updateCheck: unknown = scaffold.ctx.get('delorunUpdateCheck')
  if (!isUpdateCheck(updateCheck)) throw new Error('The delorun-update-check row provides no delorunUpdateCheck service')
  const state = (): Promise<UpdateCheckState> => Promise.resolve({ checked: Date.now(), notice: NOTICE })
  onTestFinished(updateCheck.attach({ read: state, check: state }))
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())

  const page = await openStudio(browser, scaffold.authenticatedUrl, false)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-update-notice'))
  const notice = page.locator('[data-update-notice="0.1.3"]')
  const close = notice.getByRole('button', { name: 'Hide this notice until a newer release', exact: true })
  // A fresh profile opens Delorun's onboarding, whose dialog covers the sidebar until it is done or skipped.
  const onboarding = page.getByRole('dialog')
  await onboarding.getByRole('button', { name: 'Complete setup later', exact: true }).waitFor({ timeout: 30_000 })
  await expect(close.click({ trial: true, timeout: 2_000 })).rejects.toThrow()
  await onboarding.getByRole('button', { name: 'Complete setup later', exact: true }).click()
  await onboarding.waitFor({ state: 'detached' })

  await expect.poll(() => notice.textContent()).toBe([
    'Delorun 0.1.3 is available',
    'Security fix · All your plugins stay compatible',
    'Release note: Fixes the reach listener\'s cookie check',
    'Update now…',
  ].join(''))
  expect(await notice.getByRole('status').textContent()).toBe('Delorun 0.1.3 is availableSecurity fix · All your plugins stay compatible')
  expect(await notice.getByRole('status').getByRole('button').count()).toBe(0)
  expect(await notice.locator('code').count()).toBe(0)
  expect(await notice.getByRole('button', { name: 'Update now…', exact: true }).count()).toBe(1)
  await close.click()
  await expect.poll(() => notice.count()).toBe(0)
  expect(await page.evaluate(() => window.localStorage.getItem('delorun:sidebar:update.dismissed'))).toBe('0.1.3')

  // A remote session's page, in a fresh browser context, shows the Host's notice and no control.
  const remote = await openStudio(browser, scaffold.authenticatedUrl, true)
  onTestFailed(() => saveFailureShot(remote, 'web-e2e-delorun-update-notice-remote'))
  const remoteNotice = remote.locator('[data-update-notice="0.1.3"]')
  expect(await remoteNotice.textContent()).toContain('Release note: Fixes the reach listener\'s cookie check')
  expect(await remoteNotice.textContent()).toContain('Run delorun update in a terminal on the computer that runs Delorun.')
  expect(await remoteNotice.locator('button, a, input, [tabindex]').count()).toBe(0)
}, 240_000)
