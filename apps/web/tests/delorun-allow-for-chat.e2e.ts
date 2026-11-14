/**
 * "Allow for this chat" on a sandbox escalation card, in a profile that mounts `@delorun/bundle-local`: the card shows
 * Reject, Allow once and Allow for this chat; the choice switches the chat to the mode the request asked for (through
 * the one full-access dialog for full access, with no dialog for workspace write), answers the card as allowed, and the
 * next escalation in the chat is not asked. Zero real model calls: a mock model asks for the escalation.
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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: carries the approval package's session-event merge.
import type {} from '@deepseek-ai/dsh-user-approval'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { acknowledgeDelorunNotice, connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
/** Where the screenshots of the flow go when `DELORUN_SCREENSHOT_DIR` names a folder. */
const SCREENSHOTS = process.env.DELORUN_SCREENSHOT_DIR

/**
 * Run the flow for one escalation target.
 * @param requested - the mode the mock model asks for.
 * @param start - the access control's menu item the chat starts from.
 * @param after - the access control's label after the choice.
 * @param viaDialog - whether the choice shows the full-access dialog.
 */
async function allowForChat(requested: 'workspace-write' | 'danger-full-access', start: string, after: RegExp, viaDialog: boolean): Promise<void> {
  const build = spawnSync('pnpm', ['--filter', '@delorun/bundle-local', 'run', 'build'], { cwd: REPO, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'delorun-allow-for-chat-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  // The grant store lives under the Delorun home; a scratch home keeps the person's own grants out of the run and the run out of them.
  const originalHome = process.env.DELORUN_HOME
  process.env.DELORUN_HOME = join(root, 'delorun-home')
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
    else process.env.DELORUN_HOME = originalHome
  })
  const server = await startMockLlmServer({
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    successText: 'ESCALATION_DONE',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo allow-for-chat', description: 'print a marker', sandbox_permissions: requested, justification: 'the test needs a wider mode' }),
  })
  onTestFinished(() => server.close())
  const key = credentialRef('DELORUN_ALLOW_CHAT_KEY')
  const overlay = join(root, 'allow.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    // `delorun start` releases the update gate's start hold; this scaffold has no start.
    { id: 'delorun-update-gate', config: { holdUntilChecked: false } },
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true, extraOverlayPath: overlay,
    profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
  })
  onTestFinished(() => scaffold.close())
  const asked: string[] = []
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { if (event.type === 'approval/asked') asked.push(event.data.id) })
  await scaffold.ctx.credentials.set(key, 'allow-for-chat-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-allow-for-chat'))
  await page.goto(scaffold.authenticatedUrl)
  await acknowledgeDelorunNotice(page)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'site')

  const access = () => page.locator('button[aria-label^="Access mode"]').first()
  const shot = async (name: string): Promise<void> => {
    if (SCREENSHOTS === undefined) return
    await mkdir(SCREENSHOTS, { recursive: true })
    // Let the dialog's fade-in finish so the picture shows it whole.
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) })
  }
  const send = async (text: string): Promise<void> => {
    const input = page.locator('[data-composer-input]').first()
    await input.fill(text)
    await input.press('Enter')
  }

  await access().waitFor({ timeout: 15_000 })
  await access().click()
  await page.getByRole('menuitem', { name: start }).click()
  await expect.poll(async () => access().getAttribute('aria-label')).toContain(`current: ${start}`)

  // The card: Reject, Allow once and Allow for this chat, with the choice as the primary button.
  const settled = scaffold.whenTurnSettled(60_000)
  await send('run the escalated command')
  const card = page.locator('[data-approval-key]')
  await card.waitFor({ timeout: 60_000 })
  const choice = card.getByRole('button', { name: 'Allow for this chat', exact: true })
  await choice.waitFor()
  expect(await card.getByRole('button').allInnerTexts()).toEqual(['Reject', 'Allow once', 'Allow for this chat'])
  await shot('escalation-card')

  if (viaDialog) {
    await choice.click()
    const dialog = page.getByRole('dialog', { name: 'Allow full access for this workspace?' })
    await dialog.waitFor()
    // The card is still waiting behind the dialog.
    expect(await card.count()).toBe(1)
    await shot('full-access-dialog')
    await dialog.getByRole('checkbox', { name: 'I understand the risks and want to continue' }).check()
    await dialog.getByRole('button', { name: 'Allow full access', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  } else {
    await choice.click()
  }
  await settled
  await expect.poll(async () => access().getAttribute('aria-label')).toMatch(after)
  await shot('composer-chip')
  expect(asked).toHaveLength(1)

  // The next escalation in the chat runs in the chosen mode without asking.
  const second = scaffold.whenTurnSettled(60_000)
  await send('run the escalated command again')
  await second
  expect(await page.locator('[data-approval-key]').count()).toBe(0)
  expect(asked).toHaveLength(1)
}

it.skipIf(webSnapshotMode() === 'record')('switches a chat to workspace write from an escalation card, and the next escalation is not asked', async () => {
  await allowForChat('workspace-write', 'Read Only', /current: Workspace Write/, false)
}, 240_000)

it.skipIf(webSnapshotMode() === 'record')('switches a chat to full access through the one dialog from an escalation card, and the next escalation is not asked', async () => {
  await allowForChat('danger-full-access', 'Workspace Write', /current: Full access/, true)
}, 240_000)
