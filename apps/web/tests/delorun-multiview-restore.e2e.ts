/**
 * Delorun's Multiview, in a profile that mounts `@delorun/bundle-local`: a chat that lists two agents has both pinned
 * through the agents list, Multiview opens as a layer over the chat with one pane per chat, closing a pane unpins it,
 * the header button closes the layer, and the open state, the remaining pins and the layout come back after leaving the
 * chat for another one and returning, and after a page reload. Zero model calls: the chats are written into the
 * scaffold's session store before the page opens.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
// Carries the session/title and subagent/catalog event declarations into the fixture builders.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subagent'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { acknowledgeDelorunNotice, newEnglishPage, saveFailureShot } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
const PARENT_ASK = 'Run the tests and review the diff, each with its own agent.'
const OTHER_ASK = 'Say something unrelated to agents.'
const AGENT_LABELS = ['Run the tests', 'Review the diff'] as const
const STORAGE_PREFIX = 'dsh.multiview.v1'

interface SeededChats {
  readonly parent: SessionId
  readonly other: SessionId
  readonly agents: readonly SessionId[]
}

const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]

/**
 * Append one finished question and answer to a detached Session.
 * @param session - the Session being built.
 * @param turn - the one-based turn number.
 * @param ask - the user's message.
 * @param answer - the assistant's reply.
 */
function appendTurn(session: Session, turn: number, ask: string, answer: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('Synthetic system prompt.') }, { surfaceOp: 'append' })
  const user = session.append('user/message', createUserMessage({ content: text(ask), source: { kind: 'user' } }), { surfaceOp: 'append' })
  if (turn === 1) session.append('session/title', { title: ask, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({ content: text(answer), source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    usage: { inputTokens: 100, outputTokens: 20 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Write one detached Session through the shipped JSONL provider into the scaffold's store.
 * @param scaffold - the booted scaffold whose persistence receives the chat.
 * @param meta - the chat's header.
 * @param events - the chat's events.
 */
async function persist(scaffold: WebScaffold, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const seeder = new Context()
  try {
    await seeder.plugin(JsonlSessionPersistence, { root: scaffold.persistenceRoot })
    const handle = await seeder.sessionPersistence.create(meta)
    await handle.append(events)
    await handle.close()
  } finally {
    await seeder.fiber.dispose()
  }
}

/**
 * Seed the chat that lists two agents, the agents' own chats and one unrelated chat.
 * @param scaffold - the booted scaffold.
 * @returns the chats' ids.
 */
async function seedChats(scaffold: WebScaffold): Promise<SeededChats> {
  const now = Date.now()
  const header = (id: SessionId, extra: Partial<SessionHeader>): SessionHeader => ({
    version: SESSION_FORMAT_VERSION, id, createdAt: now - 120_000, cwd: scaffold.workspaceCwd, isSeeded: false,
    delegationDepth: 0, ...extra,
  })
  const parent = SessionId('mv-restore-parent')
  const other = SessionId('mv-restore-other')
  const agents = [SessionId('mv-restore-agent-1'), SessionId('mv-restore-agent-2')]

  const parentSession = Session.create(parent)
  appendTurn(parentSession, 1, PARENT_ASK, 'Both agents are working on it. I will report when they finish.')
  agents.forEach((id, index) => {
    parentSession.append('subagent/catalog', {
      version: 3, childId: id, childCreatedAt: now - 60_000 + index, mode: 'continuable', label: AGENT_LABELS[index]!, name: `agent-${String(index + 1)}`,
    })
  })
  await persist(scaffold, header(parent, {}), parentSession.snapshotEvents())

  for (const [index, id] of agents.entries()) {
    const child = Session.create(id)
    child.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'subagent', label: AGENT_LABELS[index]! })
    appendTurn(child, 1, AGENT_LABELS[index]!, `Finished: ${AGENT_LABELS[index]!}.`)
    await persist(scaffold, header(id, { parentSession: parent, origin: 'subagent', delegationDepth: 1, createdAt: now - 90_000 }), child.snapshotEvents())
  }

  const otherSession = Session.create(other)
  appendTurn(otherSession, 1, OTHER_ASK, 'Nothing to do with agents.')
  await persist(scaffold, header(other, { createdAt: now - 150_000 }), otherSession.snapshotEvents())
  return { parent, other, agents }
}

/**
 * Read the saved Multiview state of one chat out of the page's localStorage.
 * @param page - the page under test.
 * @param chat - the chat's id.
 * @returns the saved `{ pins, layout, open }`, or `undefined` before one is saved.
 */
async function savedState(page: Page, chat: string): Promise<{ pins: string[]; layout: unknown; open: boolean } | undefined> {
  const raw = await page.evaluate(([prefix, id]) => {
    const key = Object.keys(localStorage).find(candidate => candidate.startsWith(`${prefix!}.`) && candidate.endsWith(`.${id!}`))
    return key === undefined ? null : localStorage.getItem(key)
  }, [STORAGE_PREFIX, chat])
  return raw === null ? undefined : JSON.parse(raw) as { pins: string[]; layout: unknown; open: boolean }
}

/**
 * The pane headers' chat ids in document order.
 * @param region - the Multiview region.
 * @returns the ids from `data-pane-header`.
 */
async function paneIds(region: Locator): Promise<string[]> {
  return region.locator('[data-pane-header]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-header') ?? ''))
}

it.skipIf(webSnapshotMode() === 'record')('shows pinned agents beside the chat and restores Multiview on return and reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delorun-multiview-restore-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const originalHome = process.env.DELORUN_HOME
  process.env.DELORUN_HOME = join(root, 'delorun-home')
  onTestFinished(() => {
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
    else process.env.DELORUN_HOME = originalHome
  })
  await mkdir(process.env.DELORUN_HOME, { recursive: true })
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'UNUSED' })
  onTestFinished(() => server.close())
  const key = credentialRef('DELORUN_MULTIVIEW_BROWSER_KEY')
  const overlay = join(root, 'multiview.yml')
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
  await scaffold.ctx.credentials.set(key, 'multiview-browser-test-key')
  const chats = await seedChats(scaffold)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1440, height: 900 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-multiview-restore'))
  await page.goto(scaffold.authenticatedUrl)
  await acknowledgeDelorunNotice(page)

  const region = page.getByRole('region', { name: 'Multiview' })
  const multiviewButton = page.getByRole('button', { name: /^Multiview(,|$)/ })
  // The seeded chats sit in the Ungrouped folder, which starts collapsed; each row carries its chat id.
  const openChat = async (id: SessionId): Promise<void> => {
    const row = page.locator(`[data-row-key="session:${id}"]`)
    const folder = page.locator('[data-row-key="workspace:"]')
    await folder.waitFor({ timeout: 30_000 })
    // The folder re-renders while the sidebar loads; expand it only while it is collapsed.
    await expect.poll(async () => {
      if (await row.isVisible()) return true
      if (await folder.getAttribute('aria-expanded') === 'false') await folder.click({ timeout: 2_000 }).catch(() => undefined)
      return false
    }, { timeout: 30_000 }).toBe(true)
    await row.click({ timeout: 15_000 })
    await expect.poll(() => row.getAttribute('aria-selected'), { timeout: 15_000 }).toBe('true')
  }

  await openChat(chats.parent)
  await page.getByRole('button', { name: '2 subagents' }).click()
  for (const label of AGENT_LABELS) await page.getByRole('button', { name: `Pin ${label} to Multiview` }).click()
  await page.keyboard.press('Escape')
  await expect.poll(() => savedState(page, chats.parent).then(state => state?.pins.length), { timeout: 10_000 }).toBe(2)
  expect(await region.count()).toBe(0)

  // One press opens the layer: the main chat and the two pinned agents.
  await multiviewButton.click()
  await region.waitFor({ timeout: 15_000 })
  await expect.poll(() => region.locator('[data-pane-header]').count(), { timeout: 15_000 }).toBe(3)
  expect(new Set(await paneIds(region))).toEqual(new Set([chats.parent, ...chats.agents]))

  // Closing a pane unpins its agent and leaves the other two panes.
  const closed = chats.agents[0]!
  await region.locator(`[data-pane-header="${closed}"]`).getByRole('button', { name: 'Close pane' }).click()
  await expect.poll(() => region.locator('[data-pane-header]').count(), { timeout: 10_000 }).toBe(2)
  await expect.poll(() => savedState(page, chats.parent).then(state => state?.pins), { timeout: 10_000 }).toEqual([chats.agents[1]])
  const remaining = new Set([chats.parent, chats.agents[1]!])
  expect(new Set(await paneIds(region))).toEqual(remaining)

  // The button closes the layer and the ordinary chat is back; the pin stays.
  await multiviewButton.click()
  await region.waitFor({ state: 'detached', timeout: 10_000 })
  await expect.poll(() => savedState(page, chats.parent).then(state => state?.open), { timeout: 10_000 }).toBe(false)
  expect((await savedState(page, chats.parent))?.pins).toEqual([chats.agents[1]])

  // Open again, leave for another chat and come back: it is open with the same panes in the same layout.
  await multiviewButton.click()
  await region.waitFor({ timeout: 15_000 })
  await expect.poll(() => region.locator('[data-pane-header]').count(), { timeout: 15_000 }).toBe(2)
  const before = await savedState(page, chats.parent)
  expect(before?.open).toBe(true)
  const orderBefore = await paneIds(region)

  await openChat(chats.other)
  await region.waitFor({ state: 'detached', timeout: 10_000 })
  await openChat(chats.parent)
  await region.waitFor({ timeout: 15_000 })
  await expect.poll(() => region.locator('[data-pane-header]').count(), { timeout: 15_000 }).toBe(2)
  expect(await paneIds(region)).toEqual(orderBefore)
  expect(await savedState(page, chats.parent)).toEqual(before)

  // A reload restores it from the saved state.
  await page.reload()
  await region.waitFor({ timeout: 30_000 })
  await expect.poll(() => region.locator('[data-pane-header]').count(), { timeout: 15_000 }).toBe(2)
  expect(await paneIds(region)).toEqual(orderBefore)
  expect(await savedState(page, chats.parent)).toEqual(before)
}, 240_000)
