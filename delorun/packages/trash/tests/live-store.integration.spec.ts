/**
 * The trash against upstream's own JSONL session backend: a deleted chat
 * leaves the backend's session list and cannot be opened while it is in the
 * trash, and a restore brings it back with every event. A chat whose session
 * lock a live writer holds stays at its origin, marked pending, until the
 * writer lets the lock go and a start settles it; a purge removes a pending
 * chat where it is. Each spec fails when the move, the lock check or the
 * settle is removed.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { TrashService, sessionDirectoryPath, takeSessionLock } from '../src/index.ts'

const EVENTS = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const

let base: string
let sessionsRoot: string
let contexts: Context[]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delorun-trash-live-'))
  sessionsRoot = join(base, 'sessions')
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  rmSync(base, { recursive: true, force: true })
})

/**
 * Mount upstream's JSONL backend over the scratch sessions root.
 * @returns the backend.
 */
async function backend(): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
  return ctx.sessionPersistence
}

/**
 * The header of one chat.
 * @param id - the chat's session id.
 * @returns the header.
 */
function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, cwd: '/work', isSeeded: false }
}

/**
 * The ids the backend's session list holds.
 * @param persistence - the backend.
 * @returns the ids, sorted.
 */
async function listed(persistence: SessionPersistence): Promise<string[]> {
  return (await persistence.list()).map(entry => String(entry.header.id)).sort()
}

/**
 * The trash service over the scratch tree.
 * @returns the service.
 */
function trash(): TrashService {
  return new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot } })
}

describe('a deleted chat in upstream\'s session backend', () => {
  it('leaves the session list and cannot be opened while in the trash, and a restore returns every event', async () => {
    const persistence = await backend()
    const writer = await persistence.create(header('chat-a'))
    await writer.append([...EVENTS])
    await writer.close()
    expect(await listed(persistence)).toEqual(['chat-a'])

    const item = await trash().deleteChat({ sessionId: 'chat-a', cwd: '/work' })

    expect(item.chats[0]!.movedAs).toBeDefined()
    expect(await listed(persistence)).toEqual([])
    await expect(persistence.open(SessionId('chat-a'), 'read')).rejects.toThrow()

    await trash().restore(item.id)

    expect(await listed(persistence)).toEqual(['chat-a'])
    const reader = await persistence.open(SessionId('chat-a'), 'read')
    expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
    await reader.close()
  })
})

describe('a chat a live writer holds', () => {
  it.skipIf(process.platform === 'win32')('stays at its origin, pending, until the writer lets go and a start settles it', async () => {
    const persistence = await backend()
    const writer = await persistence.create(header('chat-live'))
    await writer.append([...EVENTS])

    const item = await trash().deleteChat({ sessionId: 'chat-live', cwd: '/work' })

    expect(item.chats[0]).toMatchObject({ id: 'chat-live', pending: true })
    expect(item.chats[0]!.movedAs).toBeUndefined()
    expect(existsSync(sessionDirectoryPath(sessionsRoot, '/work', 'chat-live'))).toBe(true)
    expect(await trash().settle()).toBe(0)

    await writer.close()
    expect(await trash().settle()).toBe(1)

    expect(await listed(persistence)).toEqual([])
    const [settled] = await trash().list()
    expect(settled!.chats[0]!.pending).toBeUndefined()
    expect(settled!.chats[0]!.movedAs).toBeDefined()
  })

  it.skipIf(process.platform === 'win32')('is removed at its origin by a purge, and restored where it is', async () => {
    const persistence = await backend()
    const kept = await persistence.create(header('chat-kept'))
    await kept.append([...EVENTS])
    const purged = await persistence.create(header('chat-purged'))
    await purged.append([...EVENTS])

    const keptItem = await trash().deleteChat({ sessionId: 'chat-kept', cwd: '/work' })
    const purgedItem = await trash().deleteChat({ sessionId: 'chat-purged', cwd: '/work' })
    await trash().restore(keptItem.id)
    const report = await trash().purge(purgedItem.id)

    expect(report.removedFrom).toContain('session-generations')
    expect(existsSync(sessionDirectoryPath(sessionsRoot, '/work', 'chat-purged'))).toBe(false)
    expect(existsSync(sessionDirectoryPath(sessionsRoot, '/work', 'chat-kept'))).toBe(true)
    expect(await trash().list()).toEqual([])
    await kept.close()
    await purged.close()
  })

  it('counts every session directory as held on Windows, where the lock is not a file', async () => {
    expect(await takeSessionLock(base, 'win32')).toBeUndefined()
  })

  it('takes nothing for a directory whose writer never materialized a lock', async () => {
    const lock = await takeSessionLock(base)

    expect(lock).toBeDefined()
    await lock!.release()
  })
})
