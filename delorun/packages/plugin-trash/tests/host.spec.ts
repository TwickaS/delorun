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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { REACH_DEVICE } from '@delorun/home-auth'
import { journalPath, writeJournal, type JournalledUpdate } from '@delorun/home-process'
import { DAY_MS, TrashStore, sessionDirectoryPath } from '@delorun/trash'
import { faceWorld } from '../../plugin-changes/tests/face-world.ts'
import * as Trash from '../src/index.ts'
import { TRASH_PATHS, type EmptyOutcome, type SetAsideListing, type SetAsideRemoved, type PurgeOutcome, type TrashEntry, type TrashListing, type TrashRefusal } from '../src/index.ts'

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
  readonly admits: Map<string, (request: Request, peer: object) => boolean>
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
  base = mkdtempSync(join(tmpdir(), 'delorun-plugin-trash-'))
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
  attachmentsRoot: join(home, 'attachments', 'v1'),
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
    admits: new Map(),
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
  ctx.provide('connection', { fetch: { register: (route: { readonly path: string, readonly fetch: (request: Request) => Promise<Response>, readonly admitPeer?: (request: Request, peer: object) => boolean }) => { state.routes.set(route.path, route.fetch); if (route.admitPeer !== undefined) state.admits.set(route.path, route.admitPeer); return () => { state.routes.delete(route.path); state.admits.delete(route.path) } } } })
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
    expect(again.json).toEqual({ items: [], logsCleared: false, logFailures: [], residueMaxDays: 14 })
  })

  it('reports a log clear that failed, with each failure, and lists a damaged item without acting on it', async () => {
    await mount()
    mkdirSync(join(home, 'logs', 'home-default'), { recursive: true, mode: 0o700 })
    chmodSync(join(home, 'logs'), 0o755)
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })
    mkdirSync(join(home, 'trash', 'items', '1-a'), { recursive: true })
    writeFileSync(join(home, 'trash', 'items', '1-a', 'item.json'), 'torn')

    const purged = await post<PurgeOutcome>(TRASH_PATHS.purge, { itemId: deleted.json.id, clearLogs: true })
    const listed = await listing()

    expect(purged.json.logsCleared).toBe(false)
    expect(purged.json.logFailures.length).toBeGreaterThan(0)
    expect(listed.items).toEqual([])
    expect(listed.damaged).toEqual([{ id: '1-a', directory: join(home, 'trash', 'items', '1-a'), reason: 'the trash record of "1-a" is not JSON' }])
    chmodSync(join(home, 'logs'), 0o700)
  })

  it('deletes forever an attachment only the purged chat names, in every layout', async () => {
    await mount()
    const digest = 'f'.repeat(64)
    plantChat('chat-a')
    writeFileSync(join(sessionDirectoryPath(join(home, 'sessions'), '/work', 'chat-a'), 'session.jsonl'), `{"attachment":"sha256:${digest}"}\n`)
    const object = join(home, 'attachments', 'v1', 'file-objects', 'ff', digest)
    mkdirSync(join(object, '..'), { recursive: true })
    writeFileSync(object, 'bytes')
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })

    const purged = await post<PurgeOutcome>(TRASH_PATHS.purge, { itemId: deleted.json.id })

    expect(purged.json).toMatchObject({ attachmentsKept: 0, removedFrom: expect.arrayContaining(['attachments']) })
    expect(existsSync(object)).toBe(false)
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

  it('purges nothing and warns when an item was deleted later than the clock reads', async () => {
    const store = new TrashStore(config().trashRoot)
    const now = Date.now()
    await store.createItem('chat', 'old', { chats: [{ id: 'chat-old' }], sessionIds: ['chat-old'] }, now - 31 * DAY_MS)
    await store.createItem('chat', 'future', { chats: [{ id: 'chat-new' }], sessionIds: ['chat-new'] }, now + DAY_MS)

    await mount()

    expect((await listing()).items.map(item => item.label)).toEqual(['old', 'future'])
    expect(harness.warnings.join('\n')).toContain('clock is not trustworthy (clock-behind)')
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

  it('admit a reach device to every route and no other Peer, and answer a locked device ELEVATION_REQUIRED on deleting forever only', async () => {
    await mount()
    harness.ctx.provide('homeAuth', { faceGrants: () => undefined, deviceHasPasskey: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : undefined), pageUnlockOf: () => undefined } as never)
    const device = (deviceId: string) => ({ kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' })
    const asDevice = async (path: string, deviceId: string) => {
      const request = new Request(`http://localhost${path}`, { method: 'POST', body: '{}' })
      if (harness.admits.get(path)?.(request, { principal: device(deviceId) }) !== true) return new Response('forbidden', { status: 403 })
      return harness.routes.get(path)!(request)
    }
    for (const path of Object.values(TRASH_PATHS)) {
      expect(harness.admits.get(path)?.(new Request(`http://localhost${path}`), { principal: { kind: 'sdk' } }), path).toBe(false)
    }
    for (const path of [TRASH_PATHS.list, TRASH_PATHS.deleteChat, TRASH_PATHS.deleteWorkspace, TRASH_PATHS.restore]) {
      expect((await asDevice(path, 'locked-phone')).status, path).not.toBe(403)
    }
    // Pins the unlock check on the two routes that delete for good.
    for (const path of [TRASH_PATHS.purge, TRASH_PATHS.empty, TRASH_PATHS.removeSetAside]) {
      const locked = await asDevice(path, 'locked-phone')
      expect([locked.status, await locked.json()], path).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect((await asDevice(path, 'unlocked-phone')).status, path).not.toBe(403)
    }
  })

  it('are withdrawn when the plugin is disposed', async () => {
    await mount()

    await harness.ctx.fiber.dispose()

    expect(harness.routes.size).toBe(0)
  })
})

describe('the routes under Face ID', () => {
  const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
  const FACE_PATHS = [TRASH_PATHS.purge, TRASH_PATHS.empty, TRASH_PATHS.removeSetAside]
  const request = (path: string, text: string, grant?: string): Request => new Request(`http://localhost${path}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body: text })

  /** Provide a `homeAuth` whose Face ID flag is on for device `d1`, which holds a passkey and whatever unlock `home` holds when asked. */
  function underFace(home: { elevation?: { id: string, grace?: true }, page?: boolean } = {}) {
    const world = faceWorld('d1', 'reach')
    harness.ctx.provide('homeAuth', {
      ...world.fields, arrivalOf: () => ({ listener: 'reach' }), touchUnlock: () => {},
      elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
    } as never)
    return world
  }

  /** Run one request as the Connection does: admit the Peer, then answer it. */
  async function through(path: string, call: Request, peer: object = device()): Promise<number | 'refused'> {
    if (harness.admits.get(path)?.(call, peer) !== true) return 'refused'
    return (await harness.routes.get(path)!(call)).status
  }

  it('refuses a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant on every route that deletes forever, and deletes nothing', async () => {
    // Pins `gateByClass`: without the grant check the unlock of today would admit the first two.
    await mount()
    plantChat('chat-a')
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })
    const home: { elevation?: { id: string, grace?: true }, page?: boolean } = {}
    underFace(home)
    const bodies = new Map<string, object>([[TRASH_PATHS.purge, { itemId: deleted.json.id, clearLogs: false }], [TRASH_PATHS.empty, { clearLogs: false }], [TRASH_PATHS.removeSetAside, { path: 'data-copies/0.1.3' }]])
    for (const held of [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true as const } }, {}]) {
      Object.assign(home, { elevation: undefined, page: undefined }, held)
      for (const path of FACE_PATHS) {
        const call = request(path, JSON.stringify(bodies.get(path)))
        expect(harness.admits.get(path)!(call, device(held.page === true ? { unlockId: 'live' } : {})), path).toBe(true)
        const refusal = await harness.routes.get(path)!(call)
        expect([refusal.status, await refusal.json()], `${path} ${JSON.stringify(held)}`).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      }
    }
    expect((await listing()).items.map(item => item.id)).toEqual([deleted.json.id])
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one item would purge another.
    await mount()
    plantChat('chat-a')
    const deleted = await post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId: 'chat-a' })
    const world = underFace()
    const exact = JSON.stringify({ itemId: deleted.json.id, clearLogs: false })
    const grant = world.grantFor('plugin-trash/purge', { path: TRASH_PATHS.purge, body: exact })
    expect(await through(TRASH_PATHS.purge, request(TRASH_PATHS.purge, JSON.stringify({ itemId: deleted.json.id, clearLogs: true }), grant))).toBe(403)
    expect((await listing()).items).toHaveLength(1)
    expect(await through(TRASH_PATHS.purge, request(TRASH_PATHS.purge, exact, grant))).toBe(200)
    expect((await listing()).items).toEqual([])
    // Pins the single use: the item is gone, so a replay that got through would answer 404, not 403.
    expect(await through(TRASH_PATHS.purge, request(TRASH_PATHS.purge, exact, grant))).toBe(403)
  })

  it('answers list, deleteChat, deleteWorkspace, restore and setAside to a device with no unlock and no grant', async () => {
    // Pins the `free` class: gating them like purge would refuse a locked phone the trash's everyday calls.
    await mount({ workspaces: [{ id: 'ws-a', title: 'Project', path: '/work/project', sessionIds: [SessionId('chat-b')] }] })
    plantChat('chat-a')
    plantChat('chat-b')
    underFace()
    expect(await through(TRASH_PATHS.list, request(TRASH_PATHS.list, '{}'))).toBe(200)
    expect(await through(TRASH_PATHS.deleteChat, request(TRASH_PATHS.deleteChat, JSON.stringify({ sessionId: 'chat-a' })))).toBe(200)
    expect(await through(TRASH_PATHS.deleteWorkspace, request(TRASH_PATHS.deleteWorkspace, JSON.stringify({ workspaceId: 'ws-a' })))).toBe(200)
    const [first] = (await listing()).items
    expect(await through(TRASH_PATHS.restore, request(TRASH_PATHS.restore, JSON.stringify({ itemId: first!.id })))).toBe(200)
    // No profile runs here, so the handler's own 503 answers, which only a device the gate admitted reaches.
    expect(await through(TRASH_PATHS.setAside, request(TRASH_PATHS.setAside, '{}'))).toBe(503)
  })

  it('never asks the computer: a request that skips admitPeer reaches the handler', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    await mount()
    underFace()
    expect((await harness.routes.get(TRASH_PATHS.empty)!(request(TRASH_PATHS.empty, JSON.stringify({ clearLogs: false })))).status).toBe(200)
  })
})

describe('the data a rollback set aside and an update copied', () => {
  /** Plant one kept directory with a file in it. */
  const plantKept = (...segments: string[]): string => {
    const directory = join(home, ...segments)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'chat.jsonl'), 'x'.repeat(2048))
    return directory
  }
  const provideProfile = (): void => {
    harness.ctx.provide('profileContext', { name: 'work', home } as never)
  }

  it('lists the chats a rollback set aside and the copies an update took, and no program store', async () => {
    await mount()
    provideProfile()
    plantKept('data-set-aside', '0.1.2-20261101T101010Z')
    plantKept('data-copies', '0.1.3')
    plantKept('runtimes.set-aside-20261101T101010Z')

    const listed = await post<SetAsideListing>(TRASH_PATHS.setAside, {})

    expect(listed.json.entries).toEqual([
      { path: 'data-copies/0.1.3', kind: 'copy', bytes: 2048 },
      { path: 'data-set-aside/0.1.2-20261101T101010Z', kind: 'set-aside', bytes: 2048 },
    ])
  })

  it('removes a listed set-aside directory and refuses a path the list does not name', async () => {
    await mount()
    provideProfile()
    const directory = plantKept('data-set-aside', '0.1.2-20261101T101010Z')
    const other = plantKept('sessions-elsewhere')

    const removed = await post<SetAsideRemoved>(TRASH_PATHS.removeSetAside, { path: 'data-set-aside/0.1.2-20261101T101010Z' })
    const refused = await post<TrashRefusal>(TRASH_PATHS.removeSetAside, { path: 'sessions-elsewhere' })
    const escaped = await post<TrashRefusal>(TRASH_PATHS.removeSetAside, { path: '../../etc' })

    expect([removed.status, removed.json]).toEqual([200, { path: 'data-set-aside/0.1.2-20261101T101010Z' }])
    expect(existsSync(directory)).toBe(false)
    expect([refused.status, refused.json.code]).toEqual([404, 'NOT_KEPT_DATA'])
    expect([escaped.status, escaped.json.code]).toEqual([404, 'NOT_KEPT_DATA'])
    expect(existsSync(other)).toBe(true)
  })

  it('keeps the copy an update record still needs, and everything while a rollback runs', async () => {
    await mount()
    provideProfile()
    const copy = plantKept('data-copies', '0.1.3')
    const aside = plantKept('data-set-aside', '0.1.2-20261101T101010Z')
    const update = { from: '0.1.2', to: '0.1.3', previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: true, targetStarted: true } as JournalledUpdate
    mkdirSync(join(home, 'run', 'work'), { recursive: true, mode: 0o700 })
    await writeJournal(journalPath(home, 'work'), update, 'committed')

    const needed = await post<TrashRefusal>(TRASH_PATHS.removeSetAside, { path: 'data-copies/0.1.3' })
    await writeJournal(journalPath(home, 'work'), update, 'rolling-back')
    const rolling = await post<TrashRefusal>(TRASH_PATHS.removeSetAside, { path: 'data-set-aside/0.1.2-20261101T101010Z' })

    expect([needed.status, needed.json.code]).toEqual([409, 'DATA_IN_USE'])
    expect([rolling.status, rolling.json.code]).toEqual([409, 'DATA_IN_USE'])
    expect(existsSync(copy)).toBe(true)
    expect(existsSync(aside)).toBe(true)
  })

  it('keeps set-aside data while an update is under way', async () => {
    await mount()
    provideProfile()
    const aside = plantKept('data-set-aside', '0.1.2-20261101T101010Z')
    const update = { from: '0.1.2', to: '0.1.3', previous: undefined, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: false } as JournalledUpdate
    mkdirSync(join(home, 'run', 'work'), { recursive: true, mode: 0o700 })
    await writeJournal(journalPath(home, 'work'), update, 'switching')

    const refused = await post<TrashRefusal>(TRASH_PATHS.removeSetAside, { path: 'data-set-aside/0.1.2-20261101T101010Z' })

    expect([refused.status, refused.json.code]).toEqual([409, 'DATA_IN_USE'])
    expect(existsSync(aside)).toBe(true)
  })

  it('answers 503 on a harness that runs no profile', async () => {
    await mount()

    const listed = await post<TrashRefusal>(TRASH_PATHS.setAside, {})

    expect([listed.status, listed.json.code]).toEqual([503, 'KEPT_DATA_UNAVAILABLE'])
  })
})
