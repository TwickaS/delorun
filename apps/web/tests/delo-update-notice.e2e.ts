/**
 * Delo's update notice in the studio's sidebar, in a profile that mounts `@delo/bundle-local` and
 * `@delo/bundle-studio`: the page reads a fixed notice from the update check's route, shows its text, hides it for
 * that release when closed, and on a page marked as a remote session shows the text with no control.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delo/packages/bundle-local')
const BUNDLE_STUDIO = join(REPO, 'delo/packages/bundle-studio')
/** The packages whose built browser halves the profile serves: the two bundles' own and the studio plugins they mount. */
const BUILT = ['@delo/bundle-local', '@delo/plugin-theme', '@delo/plugin-settings-layout', '@delo/plugin-chat-states', '@delo/plugin-sidebar', '@delo/plugin-onboarding']
/** The route's answer: a security fix on the same DeepSeek Harness that keeps every plugin. */
const NOTICE = {
  notice: {
    running: { delo: '0.1.2', dsh: '0.2.2' },
    release: { delo: '0.1.3', dsh: '0.2.2', channel: 'stable', security: true, summary: 'Fixes the reach listener\'s cookie check' },
    kind: 'patch',
    disables: 0,
  },
}

/**
 * Open the studio with the notice route answered by {@link NOTICE}.
 * @param browser - the browser.
 * @param url - the studio's authenticated address.
 * @param remote - whether the page is marked as one a reach listener served.
 * @returns the page, with the notice shown.
 */
async function openStudio(browser: Browser, url: string, remote: boolean): Promise<Page> {
  const page = await newEnglishPage(browser)
  if (remote) await page.addInitScript(() => { Reflect.set(globalThis, '__DSH_REMOTE_MEDIA__', 'placeholder') })
  await page.route('**/api/deloUpdateCheck.notice', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NOTICE) }))
  await page.goto(url)
  await page.locator('[data-update-notice="0.1.3"]').waitFor({ timeout: 30_000 })
  return page
}

it.skipIf(webSnapshotMode() === 'record')('shows the update notice in the sidebar, hides it for its release when closed, and offers no control on a remote session', async () => {
  // The root build leaves Delo's packages out; the profile serves their built browser halves.
  const build = spawnSync('pnpm', [...BUILT.flatMap(name => ['--filter', name]), 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }, { dir: BUNDLE_STUDIO, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())

  const page = await openStudio(browser, scaffold.authenticatedUrl, false)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-update-notice'))
  const notice = page.locator('[data-update-notice="0.1.3"]')
  await expect.poll(() => notice.textContent()).toBe([
    'Delorun 0.1.3 is available',
    'Security fix · All your plugins stay compatible',
    'Fixes the reach listener\'s cookie check',
    'Run delorun update in a terminal on this computer.',
  ].join(''))
  expect(await notice.locator('code').textContent()).toBe('delorun update')
  await notice.getByRole('button', { name: 'Hide this notice until a newer release', exact: true }).click()
  await expect.poll(() => notice.count()).toBe(0)
  expect(await page.evaluate(() => window.localStorage.getItem('delo:sidebar:update.dismissed'))).toBe('0.1.3')

  // A remote session's page, in a fresh browser context, shows the text and no control.
  const remote = await openStudio(browser, scaffold.authenticatedUrl, true)
  onTestFailed(() => saveFailureShot(remote, 'web-e2e-delo-update-notice-remote'))
  const remoteNotice = remote.locator('[data-update-notice="0.1.3"]')
  expect(await remoteNotice.textContent()).toContain('Run delorun update in a terminal on the computer that runs Delo.')
  expect(await remoteNotice.locator('button, a, input, [tabindex]').count()).toBe(0)
}, 240_000)
