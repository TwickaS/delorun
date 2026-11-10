/**
 * Retention: the trash keeps each item for 30 days; the enforcement purges an
 * item at the end of its retention and keeps one that has not expired; a
 * retention purge is not a person's choice, so it leaves the process-log
 * residue in place; and an expired item no longer restores.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRASH_RETENTION_DAYS } from '@delo/contract-archive-and-trash'
import { TrashService, sessionDirectoryPath } from '../src/index.ts'
import {
  CANARY,
  DAY,
  IndexFixture,
  grepTree,
  makeTree,
  plantSession,
  plantSurfaceLog,
  type TrashTree,
} from './support.ts'

let tree: TrashTree | undefined
let index: IndexFixture | undefined

afterEach(() => {
  tree?.remove()
  tree = undefined
  index = undefined
})

function service(): TrashService {
  return new TrashService({
    root: tree!.trashRoot,
    stores: {
      sessionsRoot: tree!.sessionsRoot,
      sessionIndex: index!,
      logsHome: tree!.logsHome,
    },
  })
}

describe('retention', () => {
  it('purges an item whose retention has ended and keeps one that has not', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    const cwd = '/home/user/proj-r'
    plantSession(tree, 'ses-expired', cwd, [4])
    plantSession(tree, 'ses-kept', cwd, [4])
    index.plant('ses-expired', `${CANARY} expired document`)
    const now = 1_770_000_000_000
    const expired = await service().deleteChat({ sessionId: 'ses-expired', cwd }, now - TRASH_RETENTION_DAYS * DAY)
    const kept = await service().deleteChat({ sessionId: 'ses-kept', cwd }, now)

    const reports = (await service().enforceRetention(now)).purged

    expect(reports.map(report => report.itemId)).toEqual([expired.id])
    expect(existsSync(sessionDirectoryPath(tree.sessionsRoot, cwd, 'ses-expired'))).toBe(false)
    // The kept chat was deleted too, so its content waits in the trash, not at its origin.
    expect(existsSync(sessionDirectoryPath(tree.sessionsRoot, cwd, 'ses-kept'))).toBe(false)
    expect(index.fileContains(CANARY)).toBe(false)
    // The kept item keeps its secret generations in the trash; only the expired one was purged.
    expect(grepTree(tree.trashRoot, CANARY).length).toBeGreaterThan(0)
    expect((await service().list(now)).map(item => item.id)).toEqual([kept.id])
    expect((await service().list(now))[0]?.expired).toBe(false)
  })

  it('expires an item exactly after 30 days, and a day before it the item stays', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    const now = 1_770_000_000_000
    const item = await service().deleteChat({ sessionId: 'ses-boundary' }, now)
    expect(item.expiresAt - item.deletedAt).toBe(TRASH_RETENTION_DAYS * DAY)

    expect(await service().enforceRetention(now + TRASH_RETENTION_DAYS * DAY - 1)).toEqual({ purged: [] })
    expect((await service().list(now + TRASH_RETENTION_DAYS * DAY - 1))[0]?.expired).toBe(false)
    const reports = (await service().enforceRetention(now + TRASH_RETENTION_DAYS * DAY)).purged
    expect(reports.map(report => report.itemId)).toEqual([item.id])
  })

  it('leaves the process-log residue in place, because the retention purge is not a person\'s choice', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    plantSurfaceLog(tree.logsHome, 'home')
    const now = 1_770_000_000_000
    await service().deleteChat({ sessionId: 'ses-retention-logs' }, now - TRASH_RETENTION_DAYS * DAY)

    const reports = (await service().enforceRetention(now)).purged

    expect(reports).toHaveLength(1)
    expect(reports[0]?.logs.cleared).toBe(false)
    expect(reports[0]?.logs.residueMaxDays).toBe(14)
    expect(grepTree(join(tree.logsHome, 'logs'), CANARY).length).toBeGreaterThan(0)
  })

  it('cannot restore an expired item, because the enforcement already purged it', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    plantSession(tree, 'ses-expired-restore', '/home/user/proj-r2', [4])
    const now = 1_770_000_000_000
    const item = await service().deleteChat({ sessionId: 'ses-expired-restore' }, now - TRASH_RETENTION_DAYS * DAY)
    await service().enforceRetention(now)
    await expect(service().restore(item.id)).rejects.toMatchObject({ code: 'TRASH_ITEM_NOT_FOUND' })
  })
})
