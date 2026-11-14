/**
 * Proves the trash service stops, and leaves the trash unchanged, when it
 * cannot read the session store reliably: a sessions root that is not a
 * directory, a session id whose directory cannot be inspected and a pending
 * chat whose origin cannot be inspected. It also proves the service's
 * attachments, fallback sessions root and workspace-only purge paths.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrashService, TrashStore, sessionDirectoryPath } from '../src/index.ts'
import { DraftStorageFixture } from './support.ts'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delorun-trash-service-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('the service root', () => {
  it('reports the trash root it owns', () => {
    expect(new TrashService({ root: join(base, 'trash') }).trashRoot).toBe(join(base, 'trash'))
  })
})

describe('delete', () => {
  it('keeps the attachment digests of a chat until the purge', async () => {
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot: join(base, 'sessions') } })
    const digest = 'cd'.repeat(32)

    const item = await service.deleteChat({ sessionId: 'chat-a', attachments: [digest] })

    expect(item.attachments).toEqual([digest])
  })

  it('keeps the attachment digests of a workspace until the purge', async () => {
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot: join(base, 'sessions') } })
    const digest = 'ef'.repeat(32)

    const item = await service.deleteWorkspace({ workspaceId: 'ws-1', chats: [], attachments: [digest] })

    expect(item.attachments).toEqual([digest])
  })

  it('refuses a sessions root that is not a directory and creates no item', async () => {
    const sessionsRoot = join(base, 'sessions')
    writeFileSync(sessionsRoot, 'a file where the sessions root belongs')
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot } })

    await expect(service.deleteChat({ sessionId: 'chat-a' })).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await service.list()).toEqual([])
  })

  it('refuses a session id whose directory cannot be inspected and creates no item', async () => {
    const sessionsRoot = join(base, 'sessions')
    mkdirSync(join(sessionsRoot, '_no-cwd'), { recursive: true })
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot } })

    await expect(service.deleteChat({ sessionId: 'x'.repeat(300) })).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(await service.list()).toEqual([])
  })

  it('treats a file where a session directory would be as no session on disk', async () => {
    const sessionsRoot = join(base, 'sessions')
    mkdirSync(join(sessionsRoot, '_no-cwd'), { recursive: true })
    writeFileSync(sessionDirectoryPath(sessionsRoot, undefined, 'chat-a'), 'not a directory')
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot } })

    const item = await service.deleteChat({ sessionId: 'chat-a' })

    expect(item.chats).toEqual([{ id: 'chat-a' }])
  })
})

describe('settle', () => {
  it('stops when a pending chat origin cannot be inspected and leaves the chat pending', async () => {
    const sessionsRoot = join(base, 'sessions')
    mkdirSync(sessionsRoot)
    writeFileSync(join(sessionsRoot, 'project'), 'a file where the project directory belongs')
    const root = join(base, 'trash')
    const store = new TrashStore(root)
    const item = await store.createItem('chat', 'pending', { chats: [{ id: 'chat-a', origin: 'project/chat-a', pending: true }], sessionIds: ['chat-a'] }, 1)

    await expect(new TrashService({ root, stores: { sessionsRoot } }).settle()).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect((await store.readItem(item.id))!.chats[0]).toMatchObject({ pending: true })
  })
})

describe('purge', () => {
  it('removes a generation that reappeared at the origin between the move and the purge', async () => {
    const sessionsRoot = join(base, 'sessions')
    const root = join(base, 'trash')
    const deleting = new TrashService({ root, stores: { sessionsRoot } })
    const item = await deleting.deleteChat({ sessionId: 'chat-a', cwd: '/work' })
    const origin = sessionDirectoryPath(sessionsRoot, '/work', 'chat-a')
    mkdirSync(origin, { recursive: true })
    writeFileSync(join(origin, 'session.jsonl'), 'written between the move and the purge\n')

    const report = await deleting.purge(item.id)

    expect(report.removedFrom).toContain('session-generations')
    expect(existsSync(origin)).toBe(false)
  })

  it('skips the session store when the service has no sessions root, whatever the item recorded', async () => {
    const root = join(base, 'trash')
    const item = await new TrashStore(root).createItem('chat', 'no root', { chats: [{ id: 'chat-a' }], sessionIds: ['chat-a'] }, 1)

    const report = await new TrashService({ root }).purge(item.id)

    expect(report.removedFrom).toEqual(['trash-content'])
  })

  it('clears the browser drafts of a workspace that held no chats', async () => {
    const draftStorage = new DraftStorageFixture()
    draftStorage.plant('dsh.workspace.view.v5.ws-1', '"draft"')
    const service = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot: join(base, 'sessions'), draftStorage } })
    const item = await service.deleteWorkspace({ workspaceId: 'ws-1', chats: [] })

    const report = await service.purge(item.id)

    expect(report.removedFrom).toContain('browser-drafts')
    expect(draftStorage.keys()).toEqual([])
  })
})
