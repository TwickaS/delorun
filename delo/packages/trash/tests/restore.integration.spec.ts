/**
 * Restore: an item restored before its retention ends returns every moved chat
 * to its origin session directory byte for byte and leaves the trash; a
 * restore never overwrites a session directory that appeared at the origin
 * after the delete; and an item that the retention already purged is gone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TrashService, sessionDirectoryPath } from '../src/index.ts'
import { CANARY, makeTree, plantSession, type TrashTree } from './support.ts'

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

describe('restore', () => {
  it('returns every moved generation to its origin byte for byte and leaves the trash', async () => {
    tree = makeTree()
    const cwd = '/home/user/proj-c'
    plantSession(tree, 'ses-restore-1', cwd, [4])
    const origin = sessionDirectoryPath(tree.sessionsRoot, cwd, 'ses-restore-1')
    const item = await service().deleteChat({ sessionId: 'ses-restore-1', cwd })
    expect(existsSync(origin)).toBe(false)

    const restored = await service().restore(item.id)

    expect(restored.id).toBe(item.id)
    expect(existsSync(origin)).toBe(true)
    expect(readFileSync(join(origin, 'session.v4.jsonl'), 'utf8')).toContain(CANARY)
    expect(existsSync(join(tree.trashRoot, 'items', item.id))).toBe(false)
  })

  it('refuses to overwrite a session directory that appeared at the origin after the delete', async () => {
    tree = makeTree()
    const cwd = '/home/user/proj-d'
    plantSession(tree, 'ses-restore-2', cwd, [4])
    const origin = sessionDirectoryPath(tree.sessionsRoot, cwd, 'ses-restore-2')
    const item = await service().deleteChat({ sessionId: 'ses-restore-2', cwd })
    // A new process materialized the same session id again while it was in the trash.
    mkdirSync(origin, { recursive: true, mode: 0o700 })
    writeFileSync(join(origin, 'session.v4.jsonl'), '{"type":"session","fresh":true}\n', { mode: 0o600 })

    await expect(service().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_RESTORE_CONFLICT' })

    // The refusal destroys nothing: the fresh origin and the trash copy both stand.
    expect(readFileSync(join(origin, 'session.v4.jsonl'), 'utf8')).toContain('"fresh":true')
    expect(existsSync(join(tree.trashRoot, 'items', item.id))).toBe(true)
  })

  it('removes a contentless item on restore', async () => {
    tree = makeTree()
    const item = await service().deleteChat({ sessionId: 'ses-restore-3' })
    const restored = await service().restore(item.id)
    expect(restored.chats).toEqual([{ id: 'ses-restore-3' }])
    expect(await service().list()).toEqual([])
  })

  it('fails once the item is gone, as it is after the retention purged it', async () => {
    tree = makeTree()
    const cwd = '/home/user/proj-e'
    plantSession(tree, 'ses-restore-4', cwd, [4])
    const item = await service().deleteChat({ sessionId: 'ses-restore-4', cwd })
    await service().purge(item.id)
    await expect(service().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_ITEM_NOT_FOUND' })
  })
})
