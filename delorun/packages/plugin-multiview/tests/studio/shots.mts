/**
 * Pictures of Multiview's entry points in the built studio, with no model key: a scratch home from the demonstration-home
 * builder, one hand-written chat that lists two finished agents, the studio on a Multiview scratch port and headless
 * Chromium at 1440 px, light theme. Run from the repository root after `pnpm run build:artifacts`:
 * `node --import tsx/esm delorun/packages/plugin-multiview/tests/studio/shots.mts <shots-dir> [--keep]`.
 * The agents are pinned through the page's own pin buttons. The script keeps nothing outside `/tmp/mvint-studio-*` and the
 * shots directory unless `--keep` is given, and it stops the studio it started.
 * @module @delorun/plugin-multiview/tests/studio/shots
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { zstdCompressSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { projectKey } from '../../../../../packages/session/session-persistence-jsonl/src/format.ts'

const root = resolve(new URL('.', import.meta.url).pathname, '../../../../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright') as typeof import('playwright')

const PORT = 18843
const shots = process.argv[2]
const keep = process.argv.includes('--keep')
if (shots === undefined) throw new Error('usage: shots.mts <shots-dir> [--keep]')
mkdirSync(shots, { recursive: true })

const work = mkdtempSync('/tmp/mvint-studio-')
chmodSync(work, 0o700)
const home = join(work, 'home')
const projects = join(work, 'projects')
const tsx = join(root, 'node_modules/.bin/tsx')
const cli = join(root, 'delorun/apps/cli')
const env = {
  ...process.env, HOME: work, DELORUN_HOME: home, DEMO_HOME_KEY: 'sk-demonstration-placeholder-never-sent',
  NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
}
let studio: ChildProcess | undefined

const message = (role: 'user' | 'assistant', text: string): Record<string, unknown> => ({
  id: randomUUID(), role, content: [{ type: 'text', text }],
  source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' },
})

/**
 * One finished turn of a chat as session events.
 * @param ask - what the person asked.
 * @param answer - what the model answered.
 * @returns the event objects, without `seq` and `time`.
 */
function turn(ask: string, answer: string): Record<string, unknown>[] {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'user/message', data: message('user', ask), surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: message('assistant', answer), stream: [] }, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * A session log in the store's encoding: the header line is a Zstandard frame of its own, followed by one frame for the events.
 * @param header - the header object.
 * @param events - the events in order; `seq` and `time` are added.
 * @param at - the time of the first event, in epoch milliseconds.
 * @returns the file content.
 */
function logFile(header: Record<string, unknown>, events: Record<string, unknown>[], at: number): Buffer {
  const lines = events.map((event, seq) => JSON.stringify({ ...event, seq, time: at + seq }))
  return Buffer.concat([zstdCompressSync(`${JSON.stringify(header)}\n`), zstdCompressSync(`${lines.join('\n')}\n`)])
}

/**
 * Write the hand-written chat and two agent chats into the home's session store.
 * @param cwd - the workspace folder the chats belong to.
 * @returns the chat ids.
 */
function writeAgentChats(cwd: string): { parent: string; agents: string[] } {
  const sessions = join(home, 'sessions', projectKey(cwd))
  const parent = randomUUID()
  const agents = [randomUUID(), randomUUID()]
  const labels = ['Run the tests', 'Review the diff']
  const answers = ['All 48 tests pass.', 'Two small notes on the diff; nothing blocking.']
  const now = Date.now()
  const header = (id: string, extra: Record<string, unknown>) => ({ type: 'session', version: 4, id, createdAt: now - 120_000, cwd, isSeeded: false, ...extra })
  const catalog = agents.map((id, index) => ({
    type: 'subagent/catalog', data: { version: 3, childId: id, childCreatedAt: now - 60_000 + index, mode: 'continuable', label: labels[index], name: `agent-${index + 1}` },
  }))
  mkdirSync(join(sessions, parent), { recursive: true })
  writeFileSync(join(sessions, parent, 'session.v4.jsonl.zstd'), logFile(header(parent, { delegationDepth: 0 }), [
    ...turn('Run the tests and review the diff, each with its own agent.', 'Both agents are working on it. I will report when they finish.'), ...catalog,
  ], now - 100_000))
  agents.forEach((id, index) => {
    mkdirSync(join(sessions, id), { recursive: true })
    writeFileSync(join(sessions, id, 'session.v4.jsonl.zstd'), logFile(header(id, { parentSession: parent, origin: 'subagent', delegationDepth: 1 }), [
      { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'subagent', label: labels[index] } },
      ...turn(labels[index]!, answers[index]!),
    ], now - 90_000))
  })
  return { parent, agents }
}

try {
  execFileSync(tsx, ['delorun/apps/tools/src/demo-home.ts', '--home', home, '--projects', projects], { cwd: root, stdio: 'inherit' })
  const workspace = readdirSync(projects)[0]
  if (workspace === undefined) throw new Error('the demonstration home has no project')
  const chats = writeAgentChats(join(projects, workspace))
  // The workspace store lists the chats of each workspace; the hand-written chat is added to its workspace's list.
  const storePath = join(home, 'storages/workspace.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { tables: { workspaces: Record<string, { path: string; sessionIds: string[] }> } }
  for (const entry of Object.values(store.tables.workspaces)) if (entry.path.endsWith(`/${workspace}`)) entry.sessionIds.push(chats.parent, ...chats.agents)
  writeFileSync(storePath, JSON.stringify(store, null, 2))
  appendFileSync(join(home, 'profiles/default/cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${String(PORT)}\n`)
  studio = spawn(tsx, ['src/bin.ts', 'start', '--foreground'], { cwd: cli, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  studio.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
  studio.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
  const deadline = Date.now() + 120_000
  while (!(await fetch(`http://127.0.0.1:${String(PORT)}/`).then(() => true, () => false))) {
    if (Date.now() > deadline || studio.exitCode !== null) throw new Error(`the studio did not listen:\n${log.slice(-2000)}`)
    await new Promise(done => setTimeout(done, 1000))
  }
  let link: string | undefined
  while (link === undefined) {
    try {
      link = execFileSync(tsx, ['src/bin.ts', 'open', '--print'], { cwd: cli, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).match(/http:\/\/127[^\s]+/u)?.[0]
    } catch (_notReady) {
      // The studio answers HTTP before its run record exists; try again until the deadline.
      if (Date.now() > deadline + 60_000) throw new Error(`no sign-in link:\n${log.slice(-2000)}`)
      await new Promise(done => setTimeout(done, 2000))
    }
  }
  if (link === undefined) throw new Error('no sign-in link')
  writeFileSync(join(work, 'state.json'), JSON.stringify({ link, chats, log: log.slice(-500) }))

  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })).newPage()
    await page.goto(link)
    await page.waitForTimeout(6000)
    await page.getByText('Complete setup later').click()
    await page.getByRole('button', { name: 'Continue' }).click().catch(() => undefined)
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'garden-planner' }).first().click()
    await page.waitForTimeout(3000)
    await page.getByRole('button', { name: '2 subagents' }).click()
    await page.getByRole('button', { name: 'Pin Run the tests to Multiview' }).waitFor()
    await page.screenshot({ path: join(shots, 'agents-list-1440-light.png') })
    await page.getByRole('button', { name: 'Pin Run the tests to Multiview' }).click()
    await page.getByRole('button', { name: /Pin Review the diff to Multiview|Unpin Review the diff/ }).first().click()
    await page.getByText('2 pinned').waitFor()
    await page.screenshot({ path: join(shots, 'agents-list-pinned-1440-light.png') })
    await page.keyboard.press('Escape')
    await page.mouse.click(900, 500)
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(shots, 'header-multiview-1440-light.png'), clip: { x: 264, y: 0, width: 1176, height: 120 } })
    console.log(JSON.stringify(await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('dsh.multiview')) ?? ''))))
  } finally {
    await browser.close()
  }
} finally {
  if (studio !== undefined && studio.exitCode === null) {
    studio.kill('SIGTERM')
    await new Promise(done => setTimeout(done, 3000))
    if (studio.exitCode === null) studio.kill('SIGKILL')
  }
  if (keep) console.log(`kept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}
