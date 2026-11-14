/**
 * `delorun trash`: the listing of what was deleted and of damaged items, a
 * restore that returns a chat to the session root and leaves a workspace to
 * the studio, a purge and an empty that delete only after the person says yes,
 * reach the attachment and spill stores, and state the log residue or every
 * log they could not clear, and the refusal of every change while a home
 * process runs. Each refusal spec fails when its check is removed: a declined
 * purge would delete, a running home would be changed.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { acquireHomeLock, newStartId } from '@delorun/home'
import { DAY_MS, TrashStore, attachmentObjectPath, sessionDirectoryPath, spillSessionDirectoryPath } from '@delorun/trash'
import { CliError } from '../../src/exit.ts'
import { withHomeExclusive } from '../../src/home-exclusion.ts'
import { main } from '../../src/main.ts'
import { takeProfile } from '../../src/trash/command.ts'
import { homeTrash, runTrash, type TrashIo } from '../../src/trash/index.ts'

let home: string | undefined

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * A fresh home.
 * @returns its path.
 */
function newHome(): string {
  home = mkdtempSync(join(tmpdir(), 'delorun-trash-'))
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 })
  return home
}

/**
 * Plant one chat's session directory.
 * @param root - the home.
 * @param id - the chat.
 * @returns the directory.
 */
function plantChat(root: string, id: string, text = '{}\n'): string {
  const directory = sessionDirectoryPath(join(root, 'sessions'), '/work', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.jsonl'), text)
  return directory
}

/** The runtime version the specs' locks record. */
const RUNTIME = brandString<RuntimeVersion>('0.0.0')

/** One run's output and the questions it asked. */
interface Run {
  readonly code: number
  readonly out: string
  readonly asked: readonly string[]
}

/**
 * Run `delorun trash` over a home.
 * @param root - the home.
 * @param args - the arguments after `trash`.
 * @param options - the answer to every question, whether the home runs, and the clock.
 * @returns the run.
 */
async function trash(root: string, args: readonly string[], options: { answer?: string, running?: boolean, now?: number } = {}): Promise<Run> {
  let out = ''
  const asked: string[] = []
  const io: TrashIo = {
    home: root,
    stdout: (text) => { out += text },
    ask: async (question) => { asked.push(question); return options.answer ?? '' },
    exclusive: run => withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: 'use the Trash section in the studio\'s Settings' }, run, { probe: () => async () => 'answered', runtime: RUNTIME }),
    now: () => options.now ?? Date.now(),
  }
  if (options.running !== true) return { code: await runTrash(args, io), out, asked }
  mkdirSync(join(root, 'run', 'default'), { recursive: true, mode: 0o700 })
  const lock = await acquireHomeLock({ runDirectory: join(root, 'run', 'default'), runtime: RUNTIME, probe: async () => 'answered', startId: newStartId() })
  try {
    return { code: await runTrash(args, io), out, asked }
  } finally {
    lock.release()
  }
}

/**
 * The refusal one run raises.
 * @param run - the run.
 * @returns the refusal.
 */
async function refusal(run: Promise<unknown>): Promise<CliError> {
  const error = await run.then(() => undefined, (failure: unknown) => failure)
  if (!(error instanceof CliError)) throw new Error(`expected a CliError, got ${String(error)}`)
  return error
}

/**
 * Delete one chat into the home's trash over the same stores the studio's trash row names.
 * @param root - the home.
 * @param id - the chat.
 * @param label - its name.
 * @returns the item's id.
 */
async function deleteChat(root: string, id: string, label: string): Promise<string> {
  return (await homeTrash(root).deleteChat({ sessionId: id, label })).id
}

describe('delorun trash list', () => {
  it('states an empty trash and its retention', async () => {
    expect((await trash(newHome(), ['list'])).out).toBe('The trash is empty. Deleted chats and workspaces stay here for 30 days.\n')
  })

  it('lists a damaged item with its directory and reason, as text and as JSON', async () => {
    const root = newHome()
    mkdirSync(join(root, 'trash', 'items', '1-a'), { recursive: true })
    writeFileSync(join(root, 'trash', 'items', '1-a', 'item.json'), '{"schemaVersion":1')

    const listed = await trash(root, ['list'])
    const json = JSON.parse((await trash(root, ['list', '--json'])).out) as { damaged: { id: string, directory: string, reason: string }[] }

    expect(listed.out).toContain('Damaged items: nothing restores, deletes or expires these; inspect each directory:\n')
    expect(listed.out).toContain(`  ${join(root, 'trash', 'items', '1-a')}: the trash record of "1-a" is not JSON\n`)
    expect(json.damaged).toEqual([{ id: '1-a', directory: join(root, 'trash', 'items', '1-a'), reason: 'the trash record of "1-a" is not JSON' }])
  })

  it('lists each item with what it is and the days left, and as JSON', async () => {
    const root = newHome()
    const now = Date.UTC(2026, 0, 31)
    const store = new TrashStore(join(root, 'trash'))
    await store.createItem('chat', 'Fix the footer', { chats: [{ id: 'chat-a' }], sessionIds: ['chat-a'] }, now - 29 * DAY_MS)
    await store.createItem('workspace', 'Project', { chats: [{ id: 'chat-b' }], sessionIds: ['chat-b'], workspaceIds: ['ws-1'] }, now - DAY_MS)
    await store.createItem('workspace', 'Two', { chats: [{ id: 'c' }, { id: 'd' }], sessionIds: ['c', 'd'], workspaceIds: ['ws-2'] }, now)

    const listed = await trash(root, ['list'], { now })
    const json = JSON.parse((await trash(root, ['list', '--json'], { now })).out) as { retentionDays: number, items: { label: string, workspaceIds: string[] }[] }

    expect(listed.out).toContain('chat  "Fix the footer"  deleted 2026-01-02T00:00:00.000Z, deleted forever in 1 day\n')
    expect(listed.out).toContain('workspace, 1 chat  "Project"')
    expect(listed.out).toContain('workspace, 2 chats  "Two"')
    expect(listed.out).toContain('deleted forever in 29 days')
    expect(json.retentionDays).toBe(30)
    expect(json.items.map(item => item.label)).toEqual(['Fix the footer', 'Project', 'Two'])
    expect(json.items[1]!.workspaceIds).toEqual(['ws-1'])
  })
})

describe('delorun trash restore', () => {
  it('returns the chat to the session root', async () => {
    const root = newHome()
    const directory = plantChat(root, 'chat-a')
    const id = await deleteChat(root, 'chat-a', 'Fix the footer')
    expect(existsSync(directory)).toBe(false)

    const run = await trash(root, ['restore', id])

    expect(run.code).toBe(0)
    expect(run.out).toContain('Restored chat "Fix the footer"')
    expect(existsSync(directory)).toBe(true)
  })

  it('refuses while the home process runs, and changes nothing', async () => {
    const root = newHome()
    plantChat(root, 'chat-a')
    const id = await deleteChat(root, 'chat-a', 'chat')

    const refused = await refusal(trash(root, ['restore', id], { running: true }))

    expect(refused.message).toContain('Delorun is running for the profile default')
    expect(refused.message).toContain('use the Trash section in the studio\'s Settings')
    expect((await trash(root, ['list'])).out).toContain(id)
  })

  it('leaves a workspace to the studio, which registers it again, and moves nothing', async () => {
    const root = newHome()
    const store = new TrashStore(join(root, 'trash'))
    const workspace = await store.createItem('workspace', 'Project', { chats: [], sessionIds: [], workspaceIds: ['ws-1'], registration: { title: 'Project', path: '/work' } }, Date.now())

    const refused = await refusal(trash(root, ['restore', workspace.id]))

    expect(refused.message).toContain('"Project" is a workspace')
    expect(refused.message).toContain('restore it from the Trash section in the studio\'s Settings')
    expect((await trash(root, ['list'])).out).toContain(workspace.id)
  })

  it('moves in a chat a crash left at its origin before it restores', async () => {
    const root = newHome()
    const directory = plantChat(root, 'chat-a')
    const store = new TrashStore(join(root, 'trash'))
    const origin = directory.slice(join(root, 'sessions').length + 1)
    const item = await store.createItem('chat', 'chat', { chats: [{ id: 'chat-a', origin, movedAs: origin }], sessionIds: ['chat-a'] }, Date.now())

    const run = await trash(root, ['restore', item.id])

    expect(run.out).toContain('Restored chat "chat"')
    expect(existsSync(join(directory, 'session.jsonl'))).toBe(true)
    expect(existsSync(store.itemPath(item.id))).toBe(false)
  })

  it('refuses an id the trash does not hold', async () => {
    const refused = await refusal(trash(newHome(), ['restore', 'missing']))

    expect(refused.exit).toBe(1)
    expect(refused.message).toContain('no trash item carries the id "missing"')
  })
})

describe('delorun trash purge', () => {
  it('deletes nothing when the person does not say yes', async () => {
    const root = newHome()
    plantChat(root, 'chat-a')
    const id = await deleteChat(root, 'chat-a', 'Fix the footer')

    const refused = await refusal(trash(root, ['purge', id], { answer: 'n' }))

    expect(refused.message).toContain('nothing was deleted')
    expect((await trash(root, ['list'])).out).toContain(id)
  })

  it('deletes the item forever after a yes, and states the log residue', async () => {
    const root = newHome()
    plantChat(root, 'chat-a')
    const id = await deleteChat(root, 'chat-a', 'Fix the footer')

    const run = await trash(root, ['purge', id], { answer: 'yes' })

    expect(run.asked[0]).toContain('Delete chat "Fix the footer" forever?')
    expect(run.out).toMatch(/Deleted chat "Fix the footer" forever, from: [a-z-, ]*trash-content\.\n/)
    expect(run.out).toContain('may remain in the operational logs for up to 14 days')
    expect(existsSync(join(root, 'trash', 'items', id))).toBe(false)
  })

  it('removes the attachments only this chat names and its spill files, and keeps the attachments another chat names', async () => {
    const root = newHome()
    const own = 'a'.repeat(64)
    const shared = 'b'.repeat(64)
    const alsoShared = 'c'.repeat(64)
    plantChat(root, 'chat-a', `{"a":"sha256:${own}","b":"sha256:${shared}","c":"sha256:${alsoShared}"}\n`)
    plantChat(root, 'chat-b', `{"b":"sha256:${shared}","c":"sha256:${alsoShared}"}\n`)
    for (const digest of [own, shared, alsoShared]) {
      const path = attachmentObjectPath(join(root, 'attachments', 'v1'), digest)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, digest)
    }
    const spill = spillSessionDirectoryPath(join(root, 'spill'), 'chat-a')
    mkdirSync(spill, { recursive: true })
    writeFileSync(join(spill, 'output.txt'), 'spilled output')
    const id = await deleteChat(root, 'chat-a', 'with attachments')

    const run = await trash(root, ['purge', id], { answer: 'y' })

    expect(run.out).toContain('attachments')
    expect(run.out).toContain('spill')
    expect(run.out).toContain('Kept 2 attachments another chat still uses.')
    expect(existsSync(attachmentObjectPath(join(root, 'attachments', 'v1'), own))).toBe(false)
    expect(existsSync(attachmentObjectPath(join(root, 'attachments', 'v1'), shared))).toBe(true)
    expect(existsSync(spill)).toBe(false)
  })

  it('clears every operational log at once with --clear-logs, and says so before it asks', async () => {
    const root = newHome()
    const id = await deleteChat(root, 'chat-a', 'chat')

    const run = await trash(root, ['purge', id, '--clear-logs'], { answer: 'y' })

    expect(run.asked[0]).toContain('Every operational log of this home is cleared too')
    expect(run.out).toContain('Every operational log of this home was cleared')
  })

  it.skipIf(process.getuid?.() === 0)('reports each log it could not clear, and never says the logs were cleared', async () => {
    const root = newHome()
    const id = await deleteChat(root, 'chat-a', 'chat')
    chmodSync(join(root, 'logs'), 0o755)

    const run = await trash(root, ['purge', id, '--clear-logs'], { answer: 'y' })

    expect(run.out).toContain('These operational logs could not be cleared:\n  ')
    expect(run.out).toContain('may remain in the operational logs for up to 14 days')
    expect(run.out).not.toContain('was cleared')
  })

  it('refuses an id the trash does not hold, and refuses while the home process runs', async () => {
    const root = newHome()
    const id = await deleteChat(root, 'chat-a', 'chat')

    expect((await refusal(trash(root, ['purge', 'missing'], { answer: 'y' }))).message).toContain('no trash item carries the id "missing"')
    expect((await refusal(trash(root, ['purge', id], { answer: 'y', running: true }))).message).toContain('Delorun is running for the profile default')
    expect((await trash(root, ['list'])).out).toContain(id)
  })
})

describe('delorun trash empty', () => {
  it('deletes every item after a yes, clearing the logs once', async () => {
    const root = newHome()
    await deleteChat(root, 'chat-a', 'one')
    await deleteChat(root, 'chat-b', 'two')

    const run = await trash(root, ['empty', '--clear-logs'], { answer: 'y' })

    expect(run.asked[0]).toContain('Delete every item in the trash (2) forever?')
    expect(run.out.match(/Deleted chat/g)).toHaveLength(2)
    expect((await trash(root, ['list'])).out).toContain('The trash is empty.')
  })

  it('deletes nothing when the person does not say yes', async () => {
    const root = newHome()
    const id = await deleteChat(root, 'chat-a', 'one')

    expect((await refusal(trash(root, ['empty'], { answer: 'n' }))).message).toBe('delorun trash empty: nothing was deleted')
    expect((await trash(root, ['list'])).out).toContain(id)
  })

  it('asks nothing when the trash is empty', async () => {
    const run = await trash(newHome(), ['empty'], { answer: 'y' })

    expect(run.out).toBe('The trash is empty.\n')
    expect(run.asked).toEqual([])
  })
})

describe('the command line', () => {
  it.each([
    [[]],
    [['shred']],
    [['list', 'extra']],
    [['restore']],
    [['purge', 'a', 'b']],
    [['empty', 'a']],
    [['list', '--bogus']],
  ])('refuses %j with the usage', async (args) => {
    const refused = await refusal(trash(newHome(), args))

    expect(refused.exit).toBe(2)
    expect(refused.message).toContain('Run delorun trash --help for usage.')
  })

  it('splits the profile flag out in both forms', () => {
    expect(takeProfile(['list', '--profile', 'work'])).toEqual({ profile: 'work', rest: ['list'] })
    expect(takeProfile(['--profile=play', 'list'])).toEqual({ profile: 'play', rest: ['list'] })
    expect(takeProfile(['list'])).toEqual({ profile: undefined, rest: ['list'] })
  })

  it('runs from the command table over the home the environment names', async () => {
    const root = newHome()
    let out = ''
    const code = await main(['trash', 'list', '--profile', 'default'], { env: { DELORUN_HOME: root }, stdout: (text) => { out += text }, stderr: () => undefined })

    expect(code).toBe(0)
    expect(out).toContain('The trash is empty.')
  })
})
