/**
 * A fresh Delorun studio on loopback, in a profile that mounts `@delo/bundle-local` and `@delo/bundle-studio`, shows
 * its connection as up and loads without a refused request: no `Disconnected` pill, no 421 on `GET /auth/elevation`
 * (a device-only route that the loopback page does not call), also when the browser reports the network offline, as
 * it does on a computer with its Wi-Fi off while the studio on the same computer is up.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delo/packages/bundle-local')
const BUNDLE_STUDIO = join(REPO, 'delo/packages/bundle-studio')
/** The packages whose built browser halves the profile serves: the two bundles' own and the studio plugins they mount. */
const BUILT = ['@delo/bundle-local', '@delo/plugin-theme', '@delo/plugin-settings-layout', '@delo/plugin-chat-states', '@delo/plugin-sidebar', '@delo/plugin-onboarding', '@delo/plugin-trash']

/** What a page did while it loaded: every response status with its path, and whether its websocket opened. */
interface LoadLog {
  readonly statuses: string[]
  websocket: boolean
}

/**
 * Open a fresh studio and wait until it has loaded its data and its websocket is up.
 * @param offline - whether the page reports `navigator.onLine === false`.
 * @returns the page and what it logged.
 */
async function openFreshStudio(offline: boolean): Promise<{ readonly page: Page; readonly log: LoadLog }> {
  // The root build leaves Delo's packages out; the profile serves their built browser halves.
  const build = spawnSync('pnpm', [...BUILT.flatMap(name => ['--filter', name]), 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }, { dir: BUNDLE_STUDIO, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-studio-connected'))
  const log: LoadLog = { statuses: [], websocket: false }
  page.on('response', (response) => { log.statuses.push(`${String(response.status())} ${new URL(response.url()).pathname}`) })
  page.on('websocket', () => { log.websocket = true })
  // Chromium reports a computer without a network interface, or with Wi-Fi off, as offline.
  if (offline) await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false }) })
  await page.goto(scaffold.authenticatedUrl)
  await page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/list' && response.status() === 200)
  await expect.poll(() => log.websocket).toBe(true)
  return { page, log }
}

for (const offline of [false, true]) {
  it.skipIf(webSnapshotMode() === 'record')(`shows a fresh studio connected and loads with no 421${offline ? ' while the browser reports the network offline' : ''}`, async () => {
    const { page, log } = await openFreshStudio(offline)
    expect(await page.evaluate(() => navigator.onLine)).toBe(!offline)
    // The pill shows within a moment of the connection state changing; wait out its minimum visible time.
    await page.waitForTimeout(3_000)
    expect(await page.getByText('Disconnected', { exact: true }).count()).toBe(0)
    expect(log.statuses.filter(status => status.startsWith('421 ')), log.statuses.join('\n')).toEqual([])
    expect(log.statuses.filter(status => status.startsWith('200 /api/')).length).toBeGreaterThan(5)
  }, 120_000)
}
