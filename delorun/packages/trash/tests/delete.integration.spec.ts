/**
 * Delete: a chat's session directory, with every generation in it, moves into
 * the trash as the content's one storage location; a workspace moves all its
 * chats as one item; the record carries C8's 30-day retention; and a chat with
 * nothing materialized still lands in the trash, so its purge can still clean
 * every store that names it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRASH_RETENTION_DAYS } from '@delorun/contract-archive-and-trash'
import { TrashService, sessionDirectoryPath } from '../src/index.ts'
import { CANARY, DAY, grepTree, makeTree, plantSession, type TrashTree } from './support.ts'

let tree: TrashTree | undefined

afterEach(() => {
  tree?.remove()
  tree = undefined
})

function service(): TrashService {
  return new TrashService({
    root: tree!.trashRoot,
    stores: { sessionsRoot: tree!.sessionsRoot },
  })
}

describe('delete', () => {
  it('moves the chat session directory with every generation into the trash and leaves no copy at the origin', async () => {
    tree = makeTree()
    const sessionId = 'ses-delete-1'
    const cwd = '/home/user/proj-a'
    plantSession(tree, sessionId, cwd, [0, 3, 4])
    const origin = sessionDirectoryPath(tree.sessionsRoot, cwd, sessionId)

    const item = await service().deleteChat({ sessionId, cwd, label: 'Investigate flake' })

    expect(item.kind).toBe('chat')
    expect(item.sessionIds).toEqual([sessionId])
    expect(existsSync(origin)).toBe(false)
    const chatsDir = join(tree.trashRoot, 'items', item.id, 'chats')
    const project = singleEntry(chatsDir)
    const sessionDir = join(chatsDir, project, singleEntry(join(chatsDir, project)))
    for (const name of ['session.jsonl', 'session.v3.jsonl', 'session.v4.jsonl']) {
      expect(readFileSync(join(sessionDir, name), 'utf8')).toContain(CANARY)
    }
    // One storage location: the canary lives only under the trash root now.
    expect(grepTree(tree.sessionsRoot, CANARY)).toEqual([])
    expect(grepTree(tree.trashRoot, CANARY).length).toBeGreaterThan(0)
  })

  it('records the 30-day retention on the item', async () => {
    tree = makeTree()
    const now = 1_770_000_000_000
    const item = await service().deleteChat({ sessionId: 'ses-delete-2' }, now)
    expect(item.deletedAt).toBe(now)
    expect(item.expiresAt).toBe(now + TRASH_RETENTION_DAYS * DAY)
  })

  it('moves every chat of a workspace into one item and records the workspace id', async () => {
    tree = makeTree()
    const cwd = '/home/user/proj-b'
    plantSession(tree, 'ses-ws-a', cwd, [4])
    plantSession(tree, 'ses-ws-b', cwd, [4])

    const item = await service().deleteWorkspace({
      workspaceId: 'ws-1',
      chats: [
        { sessionId: 'ses-ws-a', cwd },
        { sessionId: 'ses-ws-b', cwd },
      ],
      label: 'Batch 2',
    })

    expect(item.kind).toBe('workspace')
    expect(item.workspaceIds).toEqual(['ws-1'])
    expect(item.sessionIds).toEqual(['ses-ws-a', 'ses-ws-b'])
    expect(existsSync(sessionDirectoryPath(tree.sessionsRoot, cwd, 'ses-ws-a'))).toBe(false)
    expect(existsSync(sessionDirectoryPath(tree.sessionsRoot, cwd, 'ses-ws-b'))).toBe(false)
    expect(grepTree(tree.sessionsRoot, CANARY)).toEqual([])
    expect(grepTree(tree.trashRoot, CANARY)).toHaveLength(2)
  })

  it('records a chat without materialized content, so its purge still reaches every store that names it', async () => {
    tree = makeTree()
    const item = await service().deleteChat({ sessionId: 'ses-never-materialized' })
    expect(item.chats).toEqual([{ id: 'ses-never-materialized' }])
    const listed = await service().list()
    expect(listed.map(entry => entry.id)).toContain(item.id)
    expect(listed[0]?.retentionDays).toBe(TRASH_RETENTION_DAYS)
  })

  it('refuses to delete when the service has no sessions root', async () => {
    tree = makeTree()
    const bare = new TrashService({ root: tree.trashRoot })
    await expect(bare.deleteChat({ sessionId: 'ses-x' }))
      .rejects.toMatchObject({ code: 'TRASH_SESSION_ROOT_UNAVAILABLE' })
  })
})

/** The single entry of a directory that holds exactly one entry. */
function singleEntry(dir: string): string {
  const entries = readdirSync(dir)
  expect(entries).toHaveLength(1)
  return entries[0]!
}
