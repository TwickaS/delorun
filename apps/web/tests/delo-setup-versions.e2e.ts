/**
 * Delo's Setup versions section in a profile that mounts `@delo/bundle-local`: a person saves the setup from the
 * computer's own studio, changes it, then switches back to the saved version, and the profile files return.
 */
import { spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { acknowledgeDeloNotice, connectFreshWorkspace, newEnglishPage, openDeloSettings, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delo/packages/bundle-local')

it.skipIf(webSnapshotMode() === 'record')('saves the setup, changes it, and switches back to the saved version', async () => {
  // The root build leaves Delo's packages out; the profile serves this package's built browser half.
  const build = spawnSync('pnpm', ['--filter', '@delo/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delo-setup-versions-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'VERSIONS_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELO_VERSIONS_BROWSER_KEY')
  const overlay = join(root, 'versions.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'delo-update-gate', config: { holdUntilChecked: false } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'versions-browser-test-key')
  const patchFile = join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-setup-versions'))
  await page.goto(scaffold.authenticatedUrl)
  await acknowledgeDeloNotice(page)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await openDeloSettings(page)
  await page.getByRole('button', { name: 'Setup versions', exact: true }).click()
  await page.getByLabel('Name (optional)').waitFor()

  // The scaffold's own setup is already a version; an edit gives this save something new to keep.
  await appendFile(patchFile, '\n# the setup worth keeping\n')
  await page.getByLabel('Name (optional)').fill('Before trying')
  await page.getByRole('button', { name: 'Save this setup', exact: true }).click()
  await page.getByText('Saved this setup as a version.').waitFor()
  await page.getByText('Before trying').waitFor()
  const saved = await readFile(patchFile, 'utf8')

  await appendFile(patchFile, '# tried a change\n')
  expect(await readFile(patchFile, 'utf8')).not.toBe(saved)

  // The list reads the profile when the section opens, so open it again.
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await page.getByRole('button', { name: 'Setup versions', exact: true }).click()
  const row = page.getByRole('listitem').filter({ hasText: 'Before trying' })
  await row.getByRole('button', { name: 'What changes' }).click()
  await page.getByText('Switching to this version changes:').waitFor()
  const shots = process.env.DELO_SETUP_VERSIONS_SHOTS
  if (shots !== undefined) {
    for (const [name, width, height] of [['1440', 1440, 900], ['390', 390, 844]] as const) {
      await page.setViewportSize({ width, height })
      await page.screenshot({ path: join(shots, `setup-versions-${name}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  await row.getByRole('button', { name: 'Switch to this version' }).click()
  await page.getByText('Your setup from before is saved as a version', { exact: false }).waitFor()
  expect(await readFile(patchFile, 'utf8')).toBe(saved)
  await page.getByText('Saved before a switch').waitFor()
}, 240_000)
