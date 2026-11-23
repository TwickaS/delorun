/**
 * Delorun's security overview, in a profile that mounts `@delorun/bundle-local`: the trust badge opens the overview,
 * which reads "Protected as Delorun intends" with the rows folded when every row is green, shows this copy of Delorun
 * as "Signature verified · checking files" while the background full check waits, and opens a red row with its reason
 * and fix when Changes cannot read one of its records. The trust bill and Changes' records are scripted in the page, because
 * the bill needs the launcher that starts a real install; the other facts come from the Host's own routes. Zero model
 * calls.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { acknowledgeDelorunNotice, newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
/** Where the screenshots go when `DELORUN_SCREENSHOT_DIR` names a folder. */
const SCREENSHOTS = process.env.DELORUN_SCREENSHOT_DIR
/** A stylesheet added to the page before the screenshots, such as a theme layer that has not merged yet. */
const SCREENSHOT_CSS = process.env.DELORUN_SCREENSHOT_CSS

const AT = new Date(Date.now() - 3 * 60_000).toISOString()

/**
 * The trust bill: a start bill whose start check hashed part of the release, or the bill of a passed full check.
 * @param stage - which bill.
 * @returns the bill.
 */
function bill(stage: 'start' | 'verify') {
  return {
    schema: 'delorun.trust-bill/1',
    stage,
    generatedAt: AT,
    release: {
      version: '0.1.0-preview.3', commit: null, manifestSha256: null, fileListSha256: null, root: null,
      launcher: { version: '0.1.0-preview.3', path: null }, lastFullHashAt: null,
      startCheck: { at: AT, full: false, hashed: 42, files: 44_841 }, signature: 'pass', files: 'pass',
    },
    releaseLog: { state: 'verified', lastAttempt: AT, uncheckedSince: null },
    plugins: { status: 'known', entries: [] },
    changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [] },
    mcp: { status: 'known', servers: [] },
    checkNow: { via: 'launcher' },
    ...(stage === 'verify' ? { checkedBy: { via: 'launcher', seconds: 14.2 } } : {}),
  }
}

/**
 * The rows' freshness beside the bill.
 * @param full - the background full check's state.
 * @returns the freshness.
 */
function checks(full: 'waiting' | 'done') {
  const at = { at: AT, running: false }
  return { release: { ...at, full: { state: full } }, releaseLog: at, plugins: at, changes: at }
}

it.skipIf(webSnapshotMode() === 'record')('shows the calm line, the release while it is being checked, and a red row with its fix', async () => {
  const build = spawnSync('pnpm', ['--filter', '@delorun/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delorun-security-overview-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const originalHome = process.env.DELORUN_HOME
  process.env.DELORUN_HOME = join(root, 'delorun-home')
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
    else process.env.DELORUN_HOME = originalHome
  })
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'OVERVIEW_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELORUN_OVERVIEW_BROWSER_KEY')
  const overlay = join(root, 'overview.yml')
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
  await scaffold.ctx.credentials.set(key, 'overview-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1440, height: 900 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-security-overview'))

  let answer = { bill: bill('verify'), checks: checks('done') }
  let problems: readonly string[] = []
  await page.route('**/api/delorunTrust.bill', route => route.fulfill({ json: answer }))
  await page.route('**/delorun/changes/state', async (route) => {
    const response = await route.fetch()
    const body: unknown = response.ok() ? await response.json() : {}
    await route.fulfill({ json: { ...(typeof body === 'object' && body !== null ? body : {}), problems } })
  })
  const shot = async (name: string): Promise<void> => {
    if (SCREENSHOTS === undefined) return
    await mkdir(SCREENSHOTS, { recursive: true })
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SCREENSHOTS, `${name}-${String(width)}.png`) })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  let acknowledged = false
  const open = async (): Promise<ReturnType<Page['getByRole']>> => {
    await page.goto(scaffold.authenticatedUrl)
    if (!acknowledged) await acknowledgeDelorunNotice(page)
    acknowledged = true
    if (SCREENSHOT_CSS !== undefined) await page.addStyleTag({ content: await readFile(SCREENSHOT_CSS, 'utf8') })
    await page.getByRole('button', { name: /^Trust: / }).click()
    const dialog = page.getByRole('dialog', { name: 'Security' })
    await dialog.waitFor()
    return dialog
  }

  const calm = await open()
  await calm.getByText('Protected as Delorun intends').waitFor({ timeout: 20_000 })
  expect(await calm.getByText('What the agent can do').isVisible()).toBe(false)
  await shot('green')
  await calm.getByRole('button', { name: /Show what was checked/ }).click()
  await calm.getByText('What the agent can do').waitFor()
  await shot('green-open')

  answer = { bill: bill('start'), checks: checks('waiting') }
  const checking = await open()
  await checking.getByRole('tab', { name: 'Advanced' }).click()
  await checking.getByText('Signature verified · checking files').waitFor({ timeout: 20_000 })
  await shot('checking-advanced')
  await checking.getByRole('tab', { name: 'Basic' }).click()
  await checking.getByText('Checking this copy of Delorun').waitFor()
  await shot('checking')

  answer = { bill: bill('verify'), checks: checks('done') }
  problems = ['A record of a change cannot be read.']
  const red = await open()
  const row = red.locator('li[data-status="red"]', { hasText: 'Undo cannot work for some changes' })
  await row.waitFor({ timeout: 20_000 })
  await row.getByRole('button', { name: 'Open Changes' }).waitFor()
  await shot('red-undo')
}, 300_000)
