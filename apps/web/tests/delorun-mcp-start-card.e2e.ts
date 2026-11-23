/**
 * Delorun's MCP start card, in a profile that mounts `@delorun/bundle-local` and `@delorun/bundle-studio`: under "Always ask" a
 * stdio MCP server from the person's own rows waits for them, and a chat shows the card "files wants to start" above the
 * message box with Allow, Not now and Details. The card is not answered here (Allow would start the server). With
 * `DELORUN_SCREENSHOT_DIR` the run also saves the card in light and dark at 1440 and 390 wide, and Settings, Permissions with
 * the choice of which servers ask first. Zero model calls.
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
import { newEnglishPage, openDelorunSettings, saveFailureShot } from './support.ts'

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
    { insert: [{
      id: 'files-server', name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'stdio', serverName: 'files', command: '/bin/sh', args: ['-c', 'exit 0'], env: {}, cwd: '' },
    }] },
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
  try {
    await card.waitFor({ timeout: 30_000 })
  } catch (error) {
    // Diagnosis of a missing card: what the Host holds, what the studio reads, and what the dock renders.
    const reviews = scaffold.ctx.get('mcpReviews')
    const rows = [...scaffold.ctx.loader.entries()].filter(entry => ['files-server', 'delorun-mcp-consent'].includes(entry.options.id))
    const states = await Promise.all(rows.map(async entry => [entry.options.id, entry.options.disabled ?? false, await entry.fiber?.await().then(() => 'active', (failure: unknown) => String(failure).slice(0, 300)) ?? 'no fiber']))
    const read = await page.evaluate(async () => {
      const answer = await fetch('/api/delorunMcpConsent.pending')
      return { status: answer.status, body: (await answer.text()).slice(0, 600) }
    })
    const statuses = await page.getByRole('status').allTextContents()
    const dock = await page.locator('[data-composer-input]').first().evaluate(input => input.closest('form, section, div')?.parentElement?.outerHTML.slice(0, 1500) ?? 'none')
    console.log('MCP-DIAG', JSON.stringify({ hasReviews: reviews !== undefined, pending: reviews?.pending().map(review => [review.serverName, review.origin, review.reason]), states, read, statuses, dock }, null, 1))
    await page.screenshot({ path: join(root, 'diag.png') }).catch(() => undefined)
    if (SCREENSHOTS !== undefined) await page.screenshot({ path: join(SCREENSHOTS, 'diag-missing-card.png') }).catch(() => undefined)
    throw error
  }
  await card.getByText('files wants to start').waitFor()
  await card.getByText('From your own settings').waitFor()
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

  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await openDelorunSettings(page)
  await page.getByRole('button', { name: 'Permissions', exact: true }).click()
  await page.getByText('Which MCP servers ask first', { exact: true }).waitFor()
  await page.getByText('Always ask', { exact: true }).scrollIntoViewIfNeeded()
  await shot('settings-ask-1440')
}, 480_000)
