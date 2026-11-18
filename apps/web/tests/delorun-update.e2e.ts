/**
 * The studio's update screens in a profile that mounts `@delorun/bundle-local` and `@delorun/bundle-studio`: the sidebar's
 * Update now… opens the report dialog, the dialog prepares and applies, the page reloads once when the Host answers as the
 * new release and shows "Updated to …", and a rolled-back outcome is worded as one. The update routes are answered by
 * the page's route interception with `@delorun/plugin-update/wire` views, so no home process or release is needed.
 * With `DELORUN_UPDATE_SHOTS` set to a directory, the spec saves pictures of each screen there.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, revealNavigationDrawer, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
const BUNDLE_STUDIO = join(REPO, 'delorun/packages/bundle-studio')
const BUILT = ['@delorun/bundle-local', '@delorun/plugin-theme', '@delorun/plugin-settings-layout', '@delorun/plugin-chat-states', '@delorun/plugin-sidebar', '@delorun/plugin-new-workspace', '@delorun/plugin-onboarding', '@delorun/plugin-update', '@delorun/plugin-tool-failure-guard', '@delorun/plugin-trash', '@delorun/plugin-downloads']
const NOTICE = {
  running: { delorun: '0.1.2', dsh: '0.2.2' },
  release: { delorun: '0.1.3', dsh: '0.2.2', channel: 'stable', security: false, summary: 'Faster start and two fixes' },
  kind: 'patch',
  disables: 1,
} as const
const FROM = { delorun: '0.1.2', dsh: '0.2.2', channel: 'stable' }
const TO = { delorun: '0.1.3', dsh: '0.2.2', channel: 'stable' }
const OK = { ok: true }
const CONTROLS = ['update-check', 'update-begin', 'update-cancel', 'update-rollback', 'update-dismiss', 'stop']
const SHOTS = process.env.DELORUN_UPDATE_SHOTS
/** `DELORUN_UPDATE_SHOTS_VIEW=phone-dark` takes the pictures at 390 wide in the dark scheme. */
const PHONE_DARK = process.env.DELORUN_UPDATE_SHOTS_VIEW === 'phone-dark'

/** The Host's answers the interception gives; `scenario` moves as the page acts. */
interface Script {
  release: string
  progress: object
  result?: object | undefined
  prepared?: object | undefined
  /** Whether the state route lets this page begin an update; true when absent. */
  begin?: boolean
}

/**
 * The state route's view for a script.
 * @param script - what the Host is at.
 * @returns the JSON body of the state route.
 */
function stateView(script: Script): object {
  return {
    release: { delorun: script.release, dsh: '0.2.2' }, available: true,
    access: { actor: 'computer', phonePowers: 'careful', may: Object.fromEntries(CONTROLS.map(control => [control, control === 'update-begin' && script.begin === false ? { ok: false, needs: 'unlock' } : OK])) },
    check: { enabled: true, checkedAt: Date.now(), notice: NOTICE },
    progress: script.progress, rollback: { available: false },
    ...script.prepared === undefined ? {} : { prepared: script.prepared },
    ...script.result === undefined ? {} : { result: script.result },
  }
}

const PREPARED = {
  handle: 'handle-1', expiresAt: Date.now() + 600_000, kind: 'patch', releaseNote: NOTICE.release.summary, runningChats: 0,
  confirm: { ticks: ['item:0'] },
  report: {
    schema: 'delorun.update-report/3', installation: 'cli-home', from: FROM, to: TO,
    release: { manifest: 'a'.repeat(64), signature: 'passed', freshness: 'passed', log: 'passed' }, generated: '2026-11-17T00:00:00Z', installations: [],
    items: [{ kind: 'plugin', subject: { name: 'old-plugin', version: '1.0.0' }, reason: 'dsh-requirement-unmet', effect: 'disabled', verification: 'verified', detail: { axis: 'dsh', requirement: '^0.2.2' }, actions: [] }],
    notChecked: [], counts: { disabled: 1, removed: 0, changed: 0, unverified: 0, data: 0, harness: 0 },
  },
}

/**
 * Answer the update routes of a page from a script.
 * @param page - the page.
 * @param script - the Host's state, which the apply route moves.
 * @param onApply - what the apply route does to the script.
 */
async function serveUpdateRoutes(page: Page, script: Script, onApply: (script: Script) => void): Promise<void> {
  await page.route('**/delorun/update/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1)
    const json = (body: object): Promise<void> => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (path === 'state') return json(stateView(script))
    if (path === 'prepare') { script.prepared = PREPARED; return json({ prepared: PREPARED }) }
    if (path === 'apply') { script.prepared = undefined; onApply(script); return json({ kind: 'update-begun', target: '0.1.3', runningChats: 0 }) }
    if (path === 'dismiss') { script.result = undefined; return json({}) }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'UPDATE_FAILED', message: 'no such route' }) })
  })
}

/**
 * Save a picture when `DELORUN_UPDATE_SHOTS` names a directory.
 * @param page - the page.
 * @param name - the file's name without extension.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, `${name}${PHONE_DARK ? '-phone-dark' : ''}.png`) })
}

/**
 * Open the studio past its onboarding.
 * @param browser - the browser.
 * @param url - the studio's authenticated address.
 * @param script - the Host's state.
 * @param onApply - what the apply route does to the script.
 * @param remote - whether a reach listener served the page; such a page opens after the first one put the onboarding off.
 * @returns the page.
 */
async function openStudio(browser: Browser, url: string, script: Script, onApply: (script: Script) => void, remote = false): Promise<Page> {
  const page = await newEnglishPage(browser)
  if (remote) await page.addInitScript(() => { Reflect.set(globalThis, '__DSH_REMOTE_MEDIA__', 'placeholder') })
  if (PHONE_DARK) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
  }
  await serveUpdateRoutes(page, script, onApply)
  await page.goto(url)
  // A fresh profile opens Delorun's onboarding, whose dialog covers the sidebar until it is put off.
  // A later page of the same profile finds it already put off.
  if (!remote) {
    const onboarding = page.getByRole('dialog')
    await onboarding.getByRole('button', { name: 'Complete setup later', exact: true }).click({ timeout: 30_000 })
    await onboarding.waitFor({ state: 'detached' })
  }
  return page
}

it.skipIf(webSnapshotMode() === 'record')('updates from the sidebar notice through the report dialog, reloads once, and words the outcomes', async () => {
  // One call per package: bundle-local and plugin-update reference each other, which one `--filter` run refuses as a task cycle.
  for (const name of BUILT) {
    const build = spawnSync('pnpm', ['--filter', name, 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
    expect(build.status, `${name}: ${build.stdout}${build.stderr}`).toBe(0)
  }
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }, { dir: BUNDLE_STUDIO, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  const updateCheck: { attach(source: { read(): Promise<object>; check(timeoutMs: number): Promise<object> }): () => void } = scaffold.ctx.get('delorunUpdateCheck')
  const state = (): Promise<object> => Promise.resolve({ checked: Date.now(), notice: NOTICE })
  onTestFinished(updateCheck.attach({ read: state, check: state }))
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())

  const script: Script = { release: '0.1.2', progress: { kind: 'idle' } }
  const page = await openStudio(browser, scaffold.authenticatedUrl, script, (s) => {
    s.progress = { kind: 'applying', phase: 'waiting', target: '0.1.3', runningChats: 1 }
  })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-update'))
  let loads = 0
  page.on('load', () => { loads += 1 })

  const notice = page.locator('[data-update-notice="0.1.3"]')
  if (PHONE_DARK) await revealNavigationDrawer(page, 'en')
  await notice.waitFor()
  await shoot(page, 'notice')
  await notice.getByRole('button', { name: 'Update now…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Update to Delorun 0.1.3' })
  await dialog.waitFor()
  await dialog.getByText('Release note:').waitFor()
  const update = dialog.getByRole('button', { name: 'Update', exact: true })
  expect(await update.isDisabled()).toBe(true)
  await dialog.getByRole('checkbox').first().check()
  await shoot(page, 'report-dialog')
  await expect.poll(() => update.isEnabled()).toBe(true)
  const before = loads
  await update.click()
  await page.getByText('Waiting for 1 chat to finish.').waitFor({ timeout: 15_000 })
  await shoot(page, 'progress')
  // The Host now answers as 0.1.3: the page reloads itself once and shows the outcome card.
  script.release = '0.1.3'
  script.progress = { kind: 'idle' }
  script.result = { kind: 'update', outcome: 'committed', from: '0.1.2', to: '0.1.3', at: '2026-11-17T12:00:00Z' }
  const card = page.getByText('Updated to Delorun 0.1.3')
  await card.waitFor({ timeout: 30_000 })
  expect(loads - before).toBe(1)
  await shoot(page, 'updated')
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect.poll(() => card.count()).toBe(0)

  // An update that did not work: the outcome is worded as a rollback by the home process.
  script.release = '0.1.2'
  script.result = { kind: 'update', outcome: 'rolled-back', from: '0.1.2', to: '0.1.3', at: '2026-11-17T12:00:00Z', reason: 'HEALTH_FAILED', criterion: 'H2-host-ready' }
  await page.reload()
  const back = page.getByText('The update to Delorun 0.1.3 did not work, so Delorun went back to 0.1.2')
  await back.waitFor({ timeout: 30_000 })
  await shoot(page, 'went-back')

  // A page a reach listener served follows the state route's `update-begin`: no button while it is refused, the button once allowed.
  const refused = await openStudio(browser, scaffold.authenticatedUrl, { release: '0.1.2', progress: { kind: 'idle' }, begin: false }, () => {}, true)
  if (PHONE_DARK) await revealNavigationDrawer(refused, 'en')
  await refused.locator('[data-update-notice="0.1.3"]').waitFor()
  expect(await refused.getByRole('button', { name: 'Update now…', exact: true }).count()).toBe(0)
  const allowed = await openStudio(browser, scaffold.authenticatedUrl, { release: '0.1.2', progress: { kind: 'idle' } }, () => {}, true)
  if (PHONE_DARK) await revealNavigationDrawer(allowed, 'en')
  await allowed.locator('[data-update-notice="0.1.3"]').getByRole('button', { name: 'Update now…', exact: true }).waitFor()
  await shoot(allowed, 'notice-remote-allowed')
}, 300_000)
