/**
 * The seams a home wires into the trash: the browser drafts of a purged chat
 * under the bare and the host-qualified key forms, the live projection cache
 * a purge forgets each chat in, the archive and registration facts a restore
 * needs, and the settle pass that skips what it cannot move. Each spec fails
 * when the seam it covers is removed.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrashService, TrashStore, removeDraftEntries, sessionDirectoryPath, takeSessionLock } from '../src/index.ts'
import { removeDraftEntries as browserRemoveDraftEntries } from '../src/drafts.ts'
import { DraftStorageFixture } from './support.ts'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delorun-trash-seams-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('the browser drafts of a purged chat', () => {
  it('go under the bare key form a page without a host id writes, and under the host-qualified form', () => {
    const host = randomUUID()
    const storage = new DraftStorageFixture()
    for (const key of ['dsh.conversation.chat-a', `dsh.conversation.${host}.chat-a`, 'dsh.conversation.chat-b', 'dsh.conversation.contentWidth', 'dsh.workspace.view.v5.ws-1']) {
      storage.plant(key, '"draft"')
    }

    const removed = removeDraftEntries(storage, ['chat-a'], ['ws-1'])

    expect(removed.sort()).toEqual(['dsh.conversation.chat-a', `dsh.conversation.${host}.chat-a`, 'dsh.workspace.view.v5.ws-1'].sort())
    expect(storage.keys().sort()).toEqual(['dsh.conversation.chat-b', 'dsh.conversation.contentWidth'])
    expect(browserRemoveDraftEntries).toBe(removeDraftEntries)
  })
})

describe('the live projection cache', () => {
  it('forgets each purged chat, so a pending write-behind flush cannot restore it', async () => {
    const forgotten: string[] = []
    const service = new TrashService({
      root: join(base, 'trash'),
      stores: { sessionsRoot: join(base, 'sessions'), projectionCache: { forget: async id => { forgotten.push(id) } } },
    })
    const item = await service.deleteWorkspace({ workspaceId: 'ws-1', chats: [{ sessionId: 'chat-a' }, { sessionId: 'chat-b' }] })

    const report = await service.purge(item.id)

    expect(forgotten).toEqual(['chat-a', 'chat-b'])
    expect(report.removedFrom).toContain('projection-cache')
  })
})

describe('the facts a restore needs', () => {
  it('records the chats the delete archived and the workspace registration it removed', async () => {
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot: join(base, 'sessions') } })

    const chat = await service.deleteChat({ sessionId: 'chat-a', archived: ['chat-a'] })
    const workspace = await service.deleteWorkspace({
      workspaceId: 'ws-1',
      chats: [{ sessionId: 'chat-b' }],
      archived: ['chat-b'],
      registration: { title: 'Project', path: '/work/project' },
    })
    const bare = await service.deleteChat({ sessionId: 'chat-c', archived: [] })

    expect(chat.archived).toEqual(['chat-a'])
    expect(workspace.archived).toEqual(['chat-b'])
    expect(workspace.registration).toEqual({ title: 'Project', path: '/work/project' })
    expect(bare.archived).toBeUndefined()
  })
})

describe('the settle pass', () => {
  it('does nothing without a sessions root, and skips a chat without an origin, one whose origin is gone and one whose content is in the trash', async () => {
    const root = join(base, 'trash')
    const sessionsRoot = join(base, 'sessions')
    const store = new TrashStore(root)
    await store.createItem('chat', 'pending', { chats: [{ id: 'a', origin: 'p/a', pending: true }], sessionIds: ['a'] }, 1)
    await store.createItem('chat', 'no origin', { chats: [{ id: 'b' }], sessionIds: ['b'] }, 2)
    await store.createItem('chat', 'gone', { chats: [{ id: 'c', origin: 'p/c', pending: true }], sessionIds: ['c'] }, 3)
    const moved = await store.createItem('chat', 'moved', { chats: [{ id: 'd', origin: 'p/d', movedAs: 'p/d' }], sessionIds: ['d'] }, 4)
    mkdirSync(join(store.itemPath(moved.id), 'chats', 'p', 'd'), { recursive: true })
    mkdirSync(join(sessionsRoot, 'p', 'd'), { recursive: true })

    expect(await new TrashService({ root }).settle()).toBe(0)
    expect(await new TrashService({ root, stores: { sessionsRoot } }).settle()).toBe(0)
  })

  it('moves a chat whose writer never left a lock file', async () => {
    const sessionsRoot = join(base, 'sessions')
    const directory = sessionDirectoryPath(sessionsRoot, '/work', 'chat-a')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'session.jsonl'), '{}\n')
    const root = join(base, 'trash')
    const store = new TrashStore(root)
    const origin = join('--work--', 'chat-a')
    expect(join(sessionsRoot, origin)).toBe(directory)
    await store.createItem('chat', 'pending', { chats: [{ id: 'chat-a', origin, pending: true }], sessionIds: ['chat-a'] }, 1)

    expect(await new TrashService({ root, stores: { sessionsRoot } }).settle()).toBe(1)
    expect((await store.listItems())[0]!.chats[0]!.movedAs).toBeDefined()
  })
})

describe('the session lock', () => {
  it.skipIf(process.platform === 'win32')('refuses a lock file that is a symbolic link rather than follow it', async () => {
    const directory = sessionDirectoryPath(join(base, 'sessions'), '/work', 'chat-a')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(base, 'elsewhere'), '')
    symlinkSync(join(base, 'elsewhere'), join(directory, 'session.lock'))

    await expect(takeSessionLock(directory)).rejects.toMatchObject({ code: 'ELOOP' })
  })
})
