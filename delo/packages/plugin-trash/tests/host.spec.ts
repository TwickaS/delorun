/**
 * The trash plugin's harness half over a scratch home: a chat or a workspace
 * the person moves to the trash is archived with its work stopped and leaves
 * the session root, a restore brings it back, registers a deleted workspace
 * again and unarchives what the delete archived, a purge reaches the
 * full-text index, the projection cache and the spill files the harness
 * mounts, and the start pass deletes what is older than 30 days. The routes
 * refuse a malformed body and name a refusal by its code.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { DAY_MS, TrashStore, sessionDirectoryPath } from '@delo/trash'
import * as Trash from '../src/index.ts'
import { TRASH_PATHS, type EmptyOutcome, type PurgeOutcome, type TrashEntry, type TrashListing, type TrashRefusal } from '../src/index.ts'

/** One fake workspace of the registry. */
interface FakeWorkspace {
  readonly id: string
  title: string
  path: string
  sessionIds: SessionId[]
}

/** What the fake harness services recorded. */
interface Harness {
  readonly ctx: Context
  readonly routes: Map<string, (request: Request) => Promise<Response>>
  readonly archived: Set<string>
  readonly archiveCalls: { id: string, stopActivity: boolean | undefined }[]
  readonly workspaces: FakeWorkspace[]
  readonly attached: string[]
  readonly forgotten: string[]
  readonly indexed: string[][]
  readonly warnings: string[]
  failures: Partial<Record<'archive' | 'unarchive' | 'delete' | 'create' | 'attach', unknown>>
}

let base: string
let home: string
let harness: Harness

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-plugin-trash-'))
  home = join(base, 'home')
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 })
})

afterEach(async () => {
  await harness?.ctx.fiber.dispose()
  rmSync(base, { recursive: true, force: true })
})

/** The plugin's configuration over the scratch home. */
const config = (): Trash.Config => ({
  trashRoot: join(home, 'trash'),
  sessionsRoot: join(home, 'sessions'),
  storagesRoot: join(home, 'storages'),
  logsHome: home,
})

/**
 * Mount the plugin with fake harness services.
 * @param options - which optional services to mount and how.
 * @returns the harness.
 */
async function mount(options: { forget?: boolean, spillRoot?: string | null, workspaces?: FakeWorkspace[] } = {}): Promise<Harness> {
  const ctx = new Context()
  const state: Harness = {
    ctx,
    routes: new Map(),
    archived: new Set(),
    archiveCalls: [],
    workspaces: options.workspaces ?? [],
    attached: [],
    forgotten: [],
    indexed: [],
    warnings: [],
    failures: {},
  }
  const fail = (key: keyof Harness['failures']): void => {
    if (key in state.failures) throw state.failures[key]
  }
  ctx.provide('connection', { fetch: { register: (route: { readonly path: string, readonly fetch: (request: Request) => Promise<Response> }) => { state.routes.set(route.path, route.fetch); return () => { state.routes.delete(route.path) } } } })
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...state.archived] },
    archiveSession: async (id: SessionId, archiveOptions: { stopActivity?: boolean }) => {
      fail('archive')
      if (id === 'unknown-chat') throw new WorkspaceUnknownSessionError(id, 'archive')
      state.archiveCalls.push({ id, stopActivity: archiveOptions.stopActivity })
      state.archived.add(id)
    },
    unarchiveSession: async (id: SessionId) => { fail('unarchive'); state.archived.delete(id) },
    list: () => state.workspaces,
    create: async (path: string, title: string) => {
      fail('create')
      const workspace: FakeWorkspace = { id: `ws-${String(state.workspaces.length + 1)}`, title, path, sessionIds: [] }
      state.workspaces.push(workspace)
      return { ...workspace, attachSession: async (id: SessionId) => { fail('attach'); state.attached.push(id) } }
    },
    delete: async (id: string) => {
      fail('delete')
      const at = state.workspaces.findIndex(workspace => workspace.id === id)
      state.workspaces.splice(at, 1)
      return true
    },
  })
  ctx.provide('sessionQuery', options.forget === false ? {} : { forgetSessions: async (ids: readonly SessionId[]) => { state.indexed.push([...ids]) } })
  ctx.provide('sessionProjectionCache', { forget: async (id: SessionId) => { state.forgotten.push(id); return true } })
  if (options.spillRoot !== undefined) ctx.provide('spillStore', options.spillRoot === null ? {} : { root: options.spillRoot })
  ctx.logger.warn = (...args: unknown[]) => { state.warnings.push(args.map(String).join(' ')) }
  await ctx.plugin(Trash, config())
  harness = state
  return state
}

/**
 * Plant one chat's session directory under the scratch sessions root.
 * @param id - the chat's session id.
 * @returns the directory.
 */
function plantChat(id: string): string {
  const directory = sessionDirectoryPath(join(home, 'sessions'), '/work', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.jsonl'), `{"id":"${id}"}\n`)
  return directory
}

/**
 * Post one JSON body to a route.
 * @param path - the route.
 * @param body - the body, or raw text.
 * @returns the status and the parsed answer.
 */
async function post<T>(path: string, body: unknown): Promise<{ status: number, json: T }> {
  const handler = harness.routes.get(path)!
  const response = await handler(new Request(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
  return { status: response.status, json: await response.json() as T }
}

/**
 * Wait until the start pass has finished, by queueing a listing behind it.
 * @returns the listing.
 */
async function listing(): Promise<TrashListing> {
  return (await post<TrashListing>(TRASH_PATHS.list, {})).json
}

describe('moving a chat to the trash', () => {
  it('archives it with its work stopped, moves it out of the session root, and a restore unarchives it where it was', async () => {
    await mount()
    const directory = plantChat('chat-a')

    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a', label: 'Fix the footer' })

    expect(deleted.status).toBe(200)
    expect(deleted.json).toMatchObject({ kind: 'chat', label: 'Fix the footer', sessionIds: ['chat-a'] })
    expect(harness.archiveCalls).toEqual([{ id: 'chat-a', stopActivity: true }])
    expect(existsSync(directory)).toBe(false)
    expect((await listing()).items.map(item => item.id)).toEqual([deleted.json.id])

    const restored = await post<TrashEntry>(TRASH_PATHS.restore, { itemId: deleted.json.id })

    expect(restored.status).toBe(200)
    expect(existsSync(directory)).toBe(true)
    expect(harness.archived.has('chat-a')).toBe(false)
    expect((await listing()).items).toEqual([])
  })

  it('leaves a chat the person had archived archived after a restore, and records a chat the registry does not know', async () => {
    await mount()
    plantChat('chat-a')
    harness.archived.add('chat-a')

    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })
    await post(TRASH_PATHS.restore, { itemId: deleted.json.id })
    const unknown = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'unknown-chat' })

    expect(harness.archiveCalls).toEqual([])
    expect(harness.archived.has('chat-a')).toBe(true)
    expect(deleted.json.label).toBe('chat-a')
    expect(unknown.json.sessionIds).toEqual(['unknown-chat'])
  })
})

describe('moving a workspace to the trash', () => {
  it('moves its chats into one item, removes the registration, and a restore registers it again with its chats', async () => {
    await mount({ workspaces: [{ id: 'ws-a', title: 'Project', path: '/work/project', sessionIds: [SessionId('chat-a'), SessionId('chat-b')] }] })
    plantChat('chat-a')
    plantChat('chat-b')

    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteWorkspace, { workspaceId: 'ws-a' })

    expect(deleted.json).toMatchObject({ kind: 'workspace', label: 'Project', sessionIds: ['chat-a', 'chat-b'], workspaceIds: ['ws-a'] })
    expect(harness.workspaces).toEqual([])
    expect(harness.archived).toEqual(new Set(['chat-a', 'chat-b']))

    await post(TRASH_PATHS.restore, { itemId: deleted.json.id })

    expect(harness.workspaces.map(workspace => [workspace.title, workspace.path])).toEqual([['Project', '/work/project']])
    expect(harness.attached).toEqual(['chat-b', 'chat-a'])
    expect(harness.archived.size).toBe(0)
  })

  it('refuses a workspace the registry does not hold', async () => {
    await mount()

    const refused = await post<TrashRefusal>(TRASH_PATHS.deleteWorkspace, { workspaceId: 'ws-missing' })

    expect(refused.status).toBe(404)
    expect(refused.json.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('completes a delete and a restore whose registry steps fail, and warns about each', async () => {
    await mount({ workspaces: [{ id: 'ws-a', title: 'Project', path: '/work/project', sessionIds: [SessionId('chat-a')] }] })
    harness.failures.delete = new Error('the registry is busy')
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteWorkspace, { workspaceId: 'ws-a' })
    harness.failures = { create: new Error('the folder is gone'), unarchive: new Error('no') }
    await post(TRASH_PATHS.restore, { itemId: deleted.json.id })

    const chat = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-b' })
    harness.failures = {}
    const workspace = { id: 'ws-b', title: 'Other', path: '/work/other', sessionIds: [SessionId('chat-c')] }
    harness.workspaces.push(workspace)
    const second = await post<TrashEntry>(TRASH_PATHS.deleteWorkspace, { workspaceId: 'ws-b' })
    harness.failures = { attach: new Error('the chat is elsewhere') }
    await post(TRASH_PATHS.restore, { itemId: second.json.id })

    expect(chat.status).toBe(200)
    expect(harness.warnings.join('\n')).toMatch(/stays registered[\s\S]*could not be registered again[\s\S]*stays archived[\s\S]*could not rejoin/)
  })
})

describe('deleting forever', () => {
  it('reaches the full-text index, the projection cache and the spill files, and states the log residue', async () => {
    const spillRoot = join(base, 'spill')
    const spillDirectory = join(spillRoot, `session-${createHash('sha256').update('chat-a').digest('hex').slice(0, 12)}`)
    mkdirSync(spillDirectory, { recursive: true })
    await mount({ spillRoot })
    plantChat('chat-a')
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })

    const purged = await post<PurgeOutcome>(TRASH_PATHS.purge, { itemId: deleted.json.id })

    expect(purged.status).toBe(200)
    expect(purged.json.item.id).toBe(deleted.json.id)
    expect(purged.json.removedFrom).toEqual(expect.arrayContaining(['full-text-index', 'projection-cache', 'spill', 'session-generations', 'trash-content']))
    expect(purged.json).toMatchObject({ logsCleared: false, residueMaxDays: 14 })
    expect(harness.indexed).toEqual([['chat-a']])
    expect(harness.forgotten).toEqual(['chat-a'])
    expect(existsSync(spillDirectory)).toBe(false)
  })

  it('reports no full-text index or spill store where the harness mounts neither', async () => {
    await mount({ forget: false, spillRoot: null })
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })

    const purged = await post<PurgeOutcome>(TRASH_PATHS.purge, { itemId: deleted.json.id, clearLogs: true })

    expect(purged.json.removedFrom).not.toContain('full-text-index')
    expect(purged.json.removedFrom).not.toContain('spill')
    expect(purged.json).toMatchObject({ logsCleared: true, residueMaxDays: 0 })
  })

  it('empties the trash, clearing the logs once when asked', async () => {
    await mount()
    await post(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })
    await post(TRASH_PATHS.deleteChat, { sessionId: 'chat-b' })

    const emptied = await post<EmptyOutcome>(TRASH_PATHS.empty, { clearLogs: true })
    const again = await post<EmptyOutcome>(TRASH_PATHS.empty, {})

    expect(emptied.json.items.map(item => item.sessionIds[0])).toEqual(['chat-a', 'chat-b'])
    expect(emptied.json).toMatchObject({ logsCleared: true, residueMaxDays: 0 })
    expect(again.json).toEqual({ items: [], logsCleared: false, residueMaxDays: 14 })
  })

  it('refuses an item the trash does not hold', async () => {
    await mount()

    const purged = await post<TrashRefusal>(TRASH_PATHS.purge, { itemId: 'missing' })
    const restored = await post<TrashRefusal>(TRASH_PATHS.restore, { itemId: 'missing' })

    expect([purged.status, purged.json.code]).toEqual([404, 'TRASH_ITEM_NOT_FOUND'])
    expect([restored.status, restored.json.code]).toEqual([404, 'TRASH_ITEM_NOT_FOUND'])
  })

  it('refuses a restore that would overwrite a chat that appeared at its origin', async () => {
    await mount()
    const directory = plantChat('chat-a')
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })
    plantChat('chat-a')

    const restored = await post<TrashRefusal>(TRASH_PATHS.restore, { itemId: deleted.json.id })

    expect([restored.status, restored.json.code]).toEqual([409, 'TRASH_RESTORE_CONFLICT'])
    expect(existsSync(directory)).toBe(true)
  })
})

describe('the start pass', () => {
  it('deletes every item whose 30 days in the trash ended and keeps the others', async () => {
    const store = new TrashStore(config().trashRoot)
    const now = Date.now()
    await store.createItem('chat', 'old', { chats: [{ id: 'chat-old' }], sessionIds: ['chat-old'] }, now - 31 * DAY_MS)
    await store.createItem('chat', 'new', { chats: [{ id: 'chat-new' }], sessionIds: ['chat-new'] }, now - DAY_MS)

    await mount()

    expect((await listing()).items.map(item => item.label)).toEqual(['new'])
  })

  it('warns when the trash cannot be read at start, and the harness keeps running', async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'trash'), 'not a directory')

    await mount()
    await post(TRASH_PATHS.list, {})

    expect(harness.warnings.join('\n')).toContain('start pass failed')
  })
})

describe('the routes', () => {
  it('refuse a body that is not a JSON object, an id that is not one, a name that is too long and a flag that is not a boolean', async () => {
    await mount()

    const answers = await Promise.all([
      post<TrashRefusal>(TRASH_PATHS.deleteChat, 'not json'),
      post<TrashRefusal>(TRASH_PATHS.deleteChat, []),
      post<TrashRefusal>(TRASH_PATHS.deleteChat, { sessionId: '' }),
      post<TrashRefusal>(TRASH_PATHS.deleteChat, { sessionId: 'x'.repeat(257) }),
      post<TrashRefusal>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a', label: 'x'.repeat(501) }),
      post<TrashRefusal>(TRASH_PATHS.purge, { itemId: 'item', clearLogs: 'yes' }),
    ])

    expect(answers.map(answer => [answer.status, answer.json.code])).toEqual(Array.from({ length: 6 }, () => [400, 'BAD_REQUEST']))
    expect((await listing()).items).toEqual([])
  })

  it('answer a failure they cannot name with a generic refusal and log the cause', async () => {
    await mount()
    harness.failures.archive = new Error('the registry crashed')

    const failed = await post<TrashRefusal>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })

    expect([failed.status, failed.json.code]).toEqual([500, 'TRASH_FAILED'])
    expect(harness.warnings.join('\n')).toContain('the registry crashed')
  })

  it('are withdrawn when the plugin is disposed', async () => {
    await mount()

    await harness.ctx.fiber.dispose()

    expect(harness.routes.size).toBe(0)
  })
})
