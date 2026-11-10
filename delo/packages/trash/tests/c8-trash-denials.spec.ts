/**
 * Contract C8's trash denial tests that guard against data loss and false
 * reports. A restore checks every target before it moves anything and records
 * each chat it returns, so a restore that stops partway never lets a later
 * purge delete a restored chat. A delete records a chat's place before it
 * moves it, so a crash between the two never makes a restore delete the only
 * copy. A tampered record cannot steer settle or restore outside the stores.
 * Retention pauses on a clock it cannot trust. Attachments go only when no
 * other chat names them, and a log clear that failed is never reported as
 * done. Each spec fails when the check it covers is removed.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAY_MS, TrashService, TrashStore, attachmentPaths, sessionDirectoryPath } from '../src/index.ts'
import { CANARY, plantSurfaceLog } from './support.ts'

let base: string
let sessionsRoot: string
let trashRoot: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-trash-c8-'))
  sessionsRoot = join(base, 'sessions')
  trashRoot = join(base, 'trash')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
})

/**
 * Plant one chat's session directory with one generation.
 * @param id - the chat.
 * @param text - the generation's text.
 * @returns the directory.
 */
function plantChat(id: string, text = `{"id":"${id}"}`): string {
  const directory = sessionDirectoryPath(sessionsRoot, '/work', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.jsonl'), `${text}\n`)
  return directory
}

/**
 * A trash service over the scratch stores.
 * @param extra - further stores.
 * @returns the service.
 */
function trash(extra: Record<string, unknown> = {}): TrashService {
  return new TrashService({ root: trashRoot, stores: { sessionsRoot, ...extra } })
}

describe('restore that stops partway', () => {
  it('a restore that would overwrite a chat moves nothing back', async () => {
    const first = plantChat('chat-a')
    const second = plantChat('chat-b')
    const item = await trash().deleteWorkspace({ workspaceId: 'ws-1', chats: [{ sessionId: 'chat-a', cwd: '/work' }, { sessionId: 'chat-b', cwd: '/work' }] })
    plantChat('chat-b', 'a new chat at the same place')

    await expect(trash().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_RESTORE_CONFLICT' })

    expect(existsSync(first)).toBe(false)
    expect(readFileSync(join(second, 'session.jsonl'), 'utf8')).toBe('a new chat at the same place\n')
    expect((await trash().list())[0]!.sessionIds).toEqual(['chat-a', 'chat-b'])
  })

  it('a restored chat is never purged after a restore that failed on a later chat', async () => {
    const first = plantChat('chat-a')
    plantChat('chat-b')
    const item = await trash().deleteWorkspace({ workspaceId: 'ws-1', chats: [{ sessionId: 'chat-a', cwd: '/work' }, { sessionId: 'chat-b', cwd: '/work' }] })
    const moveBack = TrashStore.prototype.moveChatBack
    let calls = 0
    vi.spyOn(TrashStore.prototype, 'moveChatBack').mockImplementation(async function (this: TrashStore, ...args) {
      if (++calls === 2) throw Object.assign(new Error('the disk is full'), { code: 'ENOSPC' })
      await moveBack.apply(this, args)
    })

    await expect(trash().restore(item.id)).rejects.toMatchObject({ code: 'ENOSPC' })
    vi.restoreAllMocks()

    expect(existsSync(first)).toBe(true)
    expect((await trash().list())[0]!.sessionIds).toEqual(['chat-b'])
    const outcome = await trash().enforceRetention(item.deletedAt + 31 * DAY_MS)
    expect(outcome.purged).toHaveLength(1)
    expect(existsSync(join(first, 'session.jsonl'))).toBe(true)
  })
})

describe('the record is written before the move', () => {
  it('a crash before the move leaves the chat at its origin, and a restore deletes nothing', async () => {
    const origin = plantChat('chat-a')
    vi.spyOn(TrashStore.prototype, 'moveChatIn').mockRejectedValueOnce(Object.assign(new Error('the process died'), { code: 'EINTR' }))

    await expect(trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })).rejects.toMatchObject({ code: 'EINTR' })
    const [item] = await trash().list()
    expect(item!.chats[0]!.movedAs).toBe('--work--/chat-a')

    await trash().restore(item!.id)

    expect(readFileSync(join(origin, 'session.jsonl'), 'utf8')).toBe('{"id":"chat-a"}\n')
    expect(await trash().list()).toEqual([])
  })

  it('a crash after the move leaves a record a restore follows back', async () => {
    const origin = plantChat('chat-a')
    const moveIn = TrashStore.prototype.moveChatIn
    vi.spyOn(TrashStore.prototype, 'moveChatIn').mockImplementationOnce(async function (this: TrashStore, ...args) {
      await moveIn.apply(this, args)
      throw Object.assign(new Error('the process died'), { code: 'EINTR' })
    })

    await expect(trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })).rejects.toMatchObject({ code: 'EINTR' })
    expect(existsSync(origin)).toBe(false)
    const [item] = await trash().list()

    await trash().restore(item!.id)

    expect(readFileSync(join(origin, 'session.jsonl'), 'utf8')).toBe('{"id":"chat-a"}\n')
  })

  it('a settle moves in a chat a crash left at its origin', async () => {
    plantChat('chat-a')
    vi.spyOn(TrashStore.prototype, 'moveChatIn').mockRejectedValueOnce(new Error('the process died'))
    await expect(trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })).rejects.toThrow('the process died')

    expect(await trash().settle()).toBe(1)
    expect(existsSync(sessionDirectoryPath(sessionsRoot, '/work', 'chat-a'))).toBe(false)
  })

  it('a restore never deletes an item directory that still holds chat content', async () => {
    plantChat('chat-a')
    const item = await trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })
    const store = new TrashStore(trashRoot)
    await store.writeItem({ ...item, chats: [], sessionIds: [] })

    await expect(trash().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_RESTORE_CONFLICT' })

    expect(existsSync(join(store.itemPath(item.id), 'chats', '--work--', 'chat-a', 'session.jsonl'))).toBe(true)
  })

  it('a restore refuses a record that holds a chat without an origin', async () => {
    const store = new TrashStore(trashRoot)
    const item = await store.createItem('chat', 'x', { chats: [{ id: 'a', movedAs: 'p/a' }], sessionIds: ['a'] }, 1)
    mkdirSync(join(store.itemPath(item.id), 'chats', 'p', 'a'), { recursive: true })

    await expect(trash().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_RECORD_INVALID' })
    expect(existsSync(join(store.itemPath(item.id), 'chats', 'p', 'a'))).toBe(true)
  })

  it('a damaged record is reported with its directory and never expires', async () => {
    plantChat('chat-a')
    const item = await trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })
    const directory = new TrashStore(trashRoot).itemPath(item.id)
    writeFileSync(join(directory, 'item.json'), '{"schemaVersion":1,"id":')

    expect(await trash().list()).toEqual([])
    expect((await trash().damaged()).map(entry => entry.directory)).toEqual([directory])
    expect((await trash().enforceRetention(item.deletedAt + 365 * DAY_MS)).purged).toEqual([])
    expect(existsSync(join(directory, 'chats', '--work--', 'chat-a', 'session.jsonl'))).toBe(true)
  })
})

describe('a tampered record', () => {
  it('cannot make settle move a directory outside the sessions root', async () => {
    const victim = join(base, 'victim', 'p', 'a')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'keep'), 'keep me')
    const store = new TrashStore(trashRoot)
    const item = await store.createItem('chat', 'x', { chats: [{ id: 'a' }], sessionIds: ['a'] }, 1)
    writeFileSync(join(store.itemPath(item.id), 'item.json'), JSON.stringify({ ...item, chats: [{ id: 'a', origin: '../victim/p/a', pending: true }] }))

    expect(await trash().settle()).toBe(0)
    expect(readFileSync(join(victim, 'keep'), 'utf8')).toBe('keep me')
    expect((await trash().damaged()).map(entry => entry.id)).toEqual([item.id])
  })

  it('cannot point settle at another sessions root through a field the record carries', async () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(join(elsewhere, 'p', 'a'), { recursive: true })
    writeFileSync(join(elsewhere, 'p', 'a', 'keep'), 'keep me')
    const store = new TrashStore(trashRoot)
    const item = await store.createItem('chat', 'x', { chats: [{ id: 'a' }], sessionIds: ['a'] }, 1)
    writeFileSync(join(store.itemPath(item.id), 'item.json'), JSON.stringify({ ...item, sessionsRoot: elsewhere, chats: [{ id: 'a', origin: 'p/a', pending: true }] }))

    expect(await trash().settle()).toBe(0)
    expect(readFileSync(join(elsewhere, 'p', 'a', 'keep'), 'utf8')).toBe('keep me')
  })

  it('cannot make a restore read content from another item', async () => {
    plantChat('chat-a')
    const other = await trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })
    const store = new TrashStore(trashRoot)
    const item = await store.createItem('chat', 'x', { chats: [{ id: 'b' }], sessionIds: ['b'] }, 2)
    writeFileSync(join(store.itemPath(item.id), 'item.json'), JSON.stringify({ ...item, chats: [{ id: 'b', origin: 'p/b', movedAs: `../${other.id}/chats/--work--/chat-a` }] }))

    await expect(trash().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_RECORD_INVALID' })
    expect(existsSync(join(store.itemPath(other.id), 'chats', '--work--', 'chat-a'))).toBe(true)
  })
})

describe('retention on a clock it cannot trust', () => {
  it('purges nothing when an item was deleted later than the clock reads', async () => {
    plantChat('chat-a')
    const now = 1_770_000_000_000
    await trash().deleteChat({ sessionId: 'chat-a' }, now - 40 * DAY_MS)
    await trash().deleteChat({ sessionId: 'chat-b' }, now + DAY_MS)

    expect(await trash().enforceRetention(now)).toEqual({ purged: [], paused: 'clock-behind' })
    expect(await trash().list(now)).toHaveLength(2)
  })

  it('purges nothing when the clock reads earlier than the last pass', async () => {
    const now = 1_770_000_000_000
    await trash().deleteChat({ sessionId: 'chat-a' }, now - 40 * DAY_MS)
    await trash().enforceRetention(now - 35 * DAY_MS)

    expect(await trash().enforceRetention(now - 36 * DAY_MS)).toEqual({ purged: [], paused: 'clock-behind' })
  })

  it('pauses once when the clock jumps more than a year past the last pass, and resumes at the next start', async () => {
    const now = 1_770_000_000_000
    await trash().deleteChat({ sessionId: 'chat-a' }, now)
    await trash().enforceRetention(now + DAY_MS)
    const jumped = now + 2 * 365 * DAY_MS

    expect(await trash().enforceRetention(jumped)).toEqual({ purged: [], paused: 'clock-jump' })
    expect(await trash().list(jumped)).toHaveLength(1)
    expect((await trash().enforceRetention(jumped + 1)).purged).toHaveLength(1)
  })

  it('reads an unreadable pass record as none', async () => {
    mkdirSync(trashRoot, { recursive: true })
    writeFileSync(join(trashRoot, 'retention.json'), 'not json')

    expect(await trash().enforceRetention(1)).toEqual({ purged: [] })
    expect(JSON.parse(readFileSync(join(trashRoot, 'retention.json'), 'utf8'))).toEqual({ lastRunAt: 1 })
    writeFileSync(join(trashRoot, 'retention.json'), '{"lastRunAt":"yesterday"}')
    expect(await trash().enforceRetention(2)).toEqual({ purged: [] })
  })

  it('records nothing before the trash exists, and reports a record it cannot write or read', async () => {
    expect(await trash().enforceRetention(1)).toEqual({ purged: [] })
    expect(existsSync(trashRoot)).toBe(false)
    mkdirSync(join(trashRoot, 'retention.json'), { recursive: true })
    await expect(trash().enforceRetention(1)).rejects.toMatchObject({ code: 'EISDIR' })
    rmSync(join(trashRoot, 'retention.json'), { recursive: true })
    chmodSync(trashRoot, 0o500)
    try {
      await expect(trash().enforceRetention(1)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(trashRoot, 0o700)
    }
  })
})

describe('attachments', () => {
  const kept = 'a'.repeat(64)
  const shared = 'b'.repeat(64)
  const named = 'c'.repeat(64)
  const attachmentsRoot = (): string => join(base, 'attachments', 'v1')

  /** Plant one attachment in every layout the store writes. */
  function plantAttachment(digest: string): string[] {
    const paths = attachmentPaths(attachmentsRoot(), digest)
    for (const path of paths.slice(0, 2)) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, digest)
    }
    mkdirSync(paths[2]!, { recursive: true })
    writeFileSync(join(paths[2]!, 'photo.png'), digest)
    return paths
  }

  it('canary attachment is purged from every layout only when no other chat names it', async () => {
    const own = plantAttachment(kept)
    const sharedPaths = plantAttachment(shared)
    const namedPaths = plantAttachment(named)
    plantChat('chat-a', `{"a":"sha256:${kept}","b":"sha256:${shared}","c":"sha256:${named}"}`)
    plantChat('chat-live', `{"b":"sha256:${shared}"}`)
    plantChat('chat-other', `{"c":"sha256:${named}"}`)
    const stores = { attachmentsRoot: attachmentsRoot() }
    await trash(stores).deleteChat({ sessionId: 'chat-other', cwd: '/work' })
    const item = await trash(stores).deleteChat({ sessionId: 'chat-a', cwd: '/work' })
    expect(item.attachments).toEqual([kept, shared, named])

    const report = await trash(stores).purge(item.id)

    expect(report.removedFrom).toContain('attachments')
    expect(report.attachmentsKept).toBe(2)
    expect(own.map(path => existsSync(path))).toEqual([false, false, false])
    expect(sharedPaths.map(path => existsSync(path))).toEqual([true, true, true])
    expect(namedPaths.map(path => existsSync(path))).toEqual([true, true, true])
  })

  it('names nothing for a chat whose every attachment another chat still names', async () => {
    plantAttachment(shared)
    plantChat('chat-a', `sha256:${shared}`)
    plantChat('chat-b', `sha256:${shared}`)
    const stores = { attachmentsRoot: attachmentsRoot() }
    const item = await trash(stores).deleteChat({ sessionId: 'chat-a', cwd: '/work' })

    const report = await trash(stores).purge(item.id)

    expect(report.removedFrom).not.toContain('attachments')
    expect(report.attachmentsKept).toBe(1)
  })

  it('counts the digests another item records even when its content is gone', async () => {
    plantAttachment(shared)
    plantChat('chat-a', `sha256:${shared}`)
    const stores = { attachmentsRoot: attachmentsRoot() }
    const store = new TrashStore(trashRoot)
    await store.createItem('chat', 'other', { chats: [{ id: 'gone' }], sessionIds: ['gone'], attachments: [shared] }, 1)
    const item = await trash(stores).deleteChat({ sessionId: 'chat-a', cwd: '/work' })

    expect((await trash(stores).purge(item.id)).attachmentsKept).toBe(1)
  })

  it('records the digests it is given without reading generations when no attachment store is configured', async () => {
    plantChat('chat-a', `sha256:${kept}`)

    const item = await trash().deleteWorkspace({ workspaceId: 'ws-1', chats: [{ sessionId: 'chat-a', attachments: [named] }], attachments: [shared] })

    expect(item.attachments).toEqual([shared, named])
  })

  it('skips the purged item\'s own chats at their origin, and a chat it never located', async () => {
    plantAttachment(kept)
    const live = plantChat('chat-live', `sha256:${kept}`)
    const store = new TrashStore(trashRoot)
    const item = await store.createItem('chat', 'pending', {
      chats: [{ id: 'chat-live', origin: '--work--/chat-live', pending: true }, { id: 'never' }],
      sessionIds: ['chat-live', 'never'],
      attachments: [kept],
    }, 1)

    const report = await trash({ attachmentsRoot: attachmentsRoot() }).purge(item.id)

    expect(report.attachmentsKept).toBe(0)
    expect(existsSync(live)).toBe(false)
  })

  it('leaves a project directory whose name the session backend never writes', async () => {
    mkdirSync(join(sessionsRoot, 'not a project', 'chat-a'), { recursive: true })

    const item = await trash().deleteChat({ sessionId: 'chat-a' })

    expect(item.chats[0]!.origin).toBeUndefined()
    expect(existsSync(join(sessionsRoot, 'not a project', 'chat-a'))).toBe(true)
  })

  it('reads no other chat when the service has no sessions root', async () => {
    const store = new TrashStore(trashRoot)
    const item = await store.createItem('chat', 'x', { chats: [{ id: 'a' }], sessionIds: ['a'], attachments: [kept] }, 1)
    plantAttachment(kept)

    const report = await new TrashService({ root: trashRoot, stores: { attachmentsRoot: attachmentsRoot() } }).purge(item.id)

    expect(report.removedFrom).toEqual(['attachments', 'trash-content'])
  })
})

describe('the clear-logs offer', () => {
  it('purge with clear-logs chosen leaves no canary residue anywhere', async () => {
    const home = join(base, 'home')
    plantSurfaceLog(home, 'home')
    const item = await trash({ logsHome: home }).deleteChat({ sessionId: 'chat-a' })

    const report = await trash({ logsHome: home }).purge(item.id, { clearLogs: true })

    expect(report.logs).toMatchObject({ cleared: true, failures: [], residueMaxDays: 0 })
    expect(readFileSync(join(home, 'logs', 'home-default', 'home.log'), 'utf8')).not.toContain(CANARY)
  })

  it('reports a clear that failed as not cleared, with each failure', async () => {
    const home = join(base, 'home')
    plantSurfaceLog(home, 'home')
    chmodSync(join(home, 'logs'), 0o755)
    const item = await trash({ logsHome: home }).deleteChat({ sessionId: 'chat-a' })

    const report = await trash({ logsHome: home }).purge(item.id, { clearLogs: true })

    expect(report.logs.cleared).toBe(false)
    expect(report.logs.residueMaxDays).toBe(14)
    expect(report.logs.failures.length).toBeGreaterThan(0)
    expect(report.logs.notice).toContain('clears every operational log of the home')
  })
})
