/**
 * Delorun's MCP start card, in a profile that mounts `@delorun/bundle-local` and `@delorun/bundle-studio`: under "Always ask" a
 * stdio MCP server from the person's own rows waits for them, and a chat shows the card "files wants to start" above the
 * message box with Allow, Not now and Details. The card is not answered here (Allow would start the server). With
 * `DELORUN_SCREENSHOT_DIR` the run also saves the card in light and dark at 1440 and 390 wide. Zero model calls.
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
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
const BUNDLE_STUDIO = join(REPO, 'delorun/packages/bundle-studio')
/** The packages whose built browser halves the profile serves: the two bundles' own and the studio plugins they mount. */
const BUILT = ['@delorun/bundle-local', '@delorun/plugin-theme', '@delorun/plugin-settings-layout', '@delorun/plugin-chat-states', '@delorun/plugin-sidebar', '@delorun/plugin-new-workspace', '@delorun/plugin-onboarding', '@delorun/plugin-update', '@delorun/plugin-tool-failure-guard', '@delorun/plugin-trash', '@delorun/plugin-downloads']
/** Where the screenshots of the flow go when `DELORUN_SCREENSHOT_DIR` names a folder. */
const SCREENSHOTS = process.env.DELORUN_SCREENSHOT_DIR

it.skipIf(webSnapshotMode() === 'record')('shows the MCP start card with Allow, Not now and Details for a waiting server under Always ask', async () => {
  // One call per package: the bundles and their plugins reference each other, which one `--filter` run refuses as a task cycle.
  for (const name of BUILT) {
    const build = spawnSync('pnpm', ['--filter', name, 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
    expect(build.status, `${name}: ${build.stdout}${build.stderr}`).toBe(0)
  }
  const root = await mkdtemp(join(tmpdir(), 'delorun-mcp-start-card-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const originalHome = process.env.DELORUN_HOME
  process.env.DELORUN_HOME = join(root, 'delorun-home')
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
    else process.env.DELORUN_HOME = originalHome
  })
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'CARD_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELORUN_MCP_CARD_BROWSER_KEY')
  const overlay = join(root, 'mcp-start-card.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'delorun-update-gate', config: { holdUntilChecked: false } },
    // Under "Always ask" even a server of the person's own rows waits for them.
    { id: 'delorun-mcp-consent', config: { enabled: true, ask: 'always' } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }, { dir: BUNDLE_STUDIO, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'mcp-card-browser-test-key')
  // The studio's own new-workspace flow replaces upstream's picker, so the workspace and its blank chat are stored directly.
  const folder = join(scaffold.workspaceCwd, 'site')
  await mkdir(folder, { recursive: true })
  const workspace = await scaffold.ctx.workspaceRegistry.create(folder)
  const chat = SessionId('mcp-start-card-chat')
  const handle = await scaffold.ctx.agents.create({
    sessionId: chat, meta: { cwd: folder, agentPreset: 'standard' }, agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
  })
  try {
    await workspace.attachSession(chat)
  } finally {
    await handle.dispose()
  }
  // The scaffold imports the studio plugins in two passes, and a server row in the first pass starts before the consent
  // row has its module, as upstream's mcp-client starts a server when no row declares a consent. The person's server
  // row is therefore added once the consent service is mounted, as a server the person adds while Delorun runs.
  for (let waited = 0; scaffold.ctx.get('mcpAddConsent') === undefined; waited += 100) {
    expect(waited, 'the MCP consent service mounts').toBeLessThan(30_000)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const row = await scaffold.ctx.loader.create({
    id: 'files-server', name: '@deepseek-ai/dsh-mcp-client',
    config: { transport: 'stdio', serverName: 'files', command: '/bin/sh', args: ['-c', 'exit 0'], env: {}, cwd: '' },
  })
  // The review refuses the start, so the row fails with the typed refusal and nothing runs.
  await expect(scaffold.ctx.loader.resolve(row).fiber?.await()).rejects.toThrow('the add-time consent did not allow')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.addInitScript((id) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, chat)
  await page.setViewportSize({ width: 1440, height: 900 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-mcp-start-card'))
  const shot = async (name: string): Promise<void> => {
    if (SCREENSHOTS === undefined) return
    await mkdir(SCREENSHOTS, { recursive: true })
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) })
  }

  await page.goto(scaffold.authenticatedUrl)
  // A fresh studio opens Delorun's onboarding, whose dialog covers the sidebar until it is put off.
  const onboarding = page.getByRole('dialog')
  await onboarding.getByRole('button', { name: 'Complete setup later', exact: true }).click({ timeout: 30_000 })
  await onboarding.waitFor({ state: 'detached' })
  await page.locator('[data-composer-input]').first().waitFor({ timeout: 30_000 })

  const card = page.getByRole('status').filter({ hasText: 'wants to start' })
  await card.waitFor({ timeout: 30_000 })
  await card.getByText('files wants to start').waitFor()
  await card.getByText('From a place Delorun could not identify').waitFor()
  for (const name of ['Allow', 'Not now', 'Details']) {
    expect(await card.getByRole('button', { name, exact: true }).count(), name).toBe(1)
  }

  const views = [{ name: 'light', width: 1440, height: 900 }, { name: 'light', width: 390, height: 844 }, { name: 'dark', width: 390, height: 844 }, { name: 'dark', width: 1440, height: 900 }] as const
  for (const view of views) {
    await page.emulateMedia({ colorScheme: view.name })
    await page.setViewportSize({ width: view.width, height: view.height })
    await card.waitFor()
    await shot(`card-${view.name}-${String(view.width)}`)
  }

}, 480_000)
