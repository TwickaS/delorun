/**
 * Purge: the canary matrix of C8. A secret canary planted in a purged chat is
 * absent from the full-text index, every session generation, the attachments,
 * the spill files and the browser drafts; the purge states that fragments may
 * remain in the process logs until C20's retention, and without the
 * log-clearing offer the canary stays there; with the offer chosen, the canary
 * is absent from every process log, current and rotated; a symbolic link planted at a store is refused
 * rather than followed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PURGE_RESIDUE_MAX_DAYS } from '@delorun/contract-archive-and-trash'
import { TrashService, attachmentObjectPath, spillSessionDirectoryPath } from '../src/index.ts'
import type { TrashItem } from '../src/index.ts'
import {
  CANARY,
  DraftStorageFixture,
  IndexFixture,
  grepTree,
  makeTree,
  plantProjectionCache,
  plantSession,
  plantSurfaceLog,
  type TrashTree,
} from './support.ts'

let tree: TrashTree | undefined
let index: IndexFixture | undefined
let drafts: DraftStorageFixture | undefined

afterEach(() => {
  tree?.remove()
  tree = undefined
  index = undefined
  drafts = undefined
})

/** A 36-character host id, as C10's UUID form. */
const HOST_A = randomUUID()
const HOST_B = randomUUID()

function service(): TrashService {
  return new TrashService({
    root: tree!.trashRoot,
    stores: {
      sessionsRoot: tree!.sessionsRoot,
      storagesRoot: tree!.storagesRoot,
      spillRoots: [tree!.spillRoot],
      attachmentsRoot: tree!.attachmentsRoot,
      logsHome: tree!.logsHome,
      sessionIndex: index!,
      draftStorage: drafts!,
    },
  })
}

/**
 * Plant the canary in every store the purge must reach for one chat.
 * @param sessionId - the chat to poison.
 * @param cwd - the chat's project directory.
 * @returns the chat's delete input with its attachment digest.
 */
function poisonChat(sessionId: string, cwd: string): { sessionId: string; cwd: string; attachments: string[] } {
  plantSession(tree!, sessionId, cwd, [0, 4])
  plantProjectionCache(tree!, sessionId)
  index!.plant(sessionId, `${CANARY} indexed document of ${sessionId}`)
  const attachmentBytes = Buffer.from(`${CANARY} attachment bytes of ${sessionId}`, 'utf8')
  const digest = createHash('sha256').update(attachmentBytes).digest('hex')
  const objectPath = attachmentObjectPath(tree!.attachmentsRoot, digest)
  mkdirSync(join(objectPath, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(objectPath, attachmentBytes, { mode: 0o600 })
  const spillDir = spillSessionDirectoryPath(tree!.spillRoot, sessionId)
  mkdirSync(spillDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(spillDir, 'tool-output.txt'), `${CANARY} spill bytes of ${sessionId}\n`, { mode: 0o600 })
  for (const host of [HOST_A, HOST_B]) {
    drafts!.plant(`dsh.conversation.${host}.${sessionId}`, JSON.stringify({ draft: `${CANARY} typed` }))
    drafts!.plant(`dsh.user-questions.drafts.v1.${host}.${sessionId}`, JSON.stringify({ answer: `${CANARY}` }))
  }
  return { sessionId, cwd, attachments: [digest] }
}

/** Expect every non-log store of the matrix to be clean for a purged chat. */
function expectStoresClean(item: TrashItem): void {
  const sessionId = item.sessionIds[0]!
  expect(index!.fileContains(CANARY)).toBe(false)
  expect(existsSync(spillSessionDirectoryPath(tree!.spillRoot, sessionId))).toBe(false)
  for (const digest of item.attachments) {
    expect(existsSync(attachmentObjectPath(tree!.attachmentsRoot, digest))).toBe(false)
  }
  expect(grepTree(tree!.sessionsRoot, CANARY)).toEqual([])
  expect(grepTree(tree!.spillRoot, CANARY)).toEqual([])
  expect(grepTree(tree!.attachmentsRoot, CANARY)).toEqual([])
  expect(grepTree(tree!.storagesRoot, CANARY)).toEqual([])
  expect(existsSync(join(tree!.trashRoot, 'items', item.id))).toBe(false)
}

describe('purge', () => {
  it('removes the canary from the index, every generation, the attachments, the spill files and the drafts, and keeps the process-log residue', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    drafts = new DraftStorageFixture()
    drafts.plant(`dsh.conversation.${HOST_A}`, '{"width":970}')
    drafts.plant(`dsh.conversation.${HOST_A}.ses-other-chat`, '{"draft":"keep me"}')
    plantSurfaceLog(tree.logsHome, 'home')
    const input = poisonChat('ses-purge-a', '/home/user/proj-purge')
    const item = await service().deleteChat(input)

    const report = await service().purge(item.id)

    expect(report.removedFrom).toContain('full-text-index')
    expect(report.removedFrom).toContain('session-generations')
    expect(report.removedFrom).toContain('projection-cache')
    expect(report.removedFrom).toContain('attachments')
    expect(report.removedFrom).toContain('spill')
    expect(report.removedFrom).toContain('browser-drafts')
    expect(report.removedFrom).toContain('trash-content')
    expectStoresClean(item)
    // The item's draft entries go under every host scope; every other entry stays.
    for (const host of [HOST_A, HOST_B]) {
      expect(drafts.get(`dsh.conversation.${host}.ses-purge-a`)).toBeUndefined()
      expect(drafts.get(`dsh.user-questions.drafts.v1.${host}.ses-purge-a`)).toBeUndefined()
    }
    expect(drafts.get(`dsh.conversation.${HOST_A}`)).toBe('{"width":970}')
    expect(drafts.get(`dsh.conversation.${HOST_A}.ses-other-chat`)).toBe('{"draft":"keep me"}')
    // Fragments may remain in the process logs until C20's retention.
    expect(report.logs.cleared).toBe(false)
    expect(report.logs.residueMaxDays).toBe(PURGE_RESIDUE_MAX_DAYS)
    expect(report.logs.notice).toContain(`${PURGE_RESIDUE_MAX_DAYS} days`)
    const logHits = grepTree(join(tree.logsHome, 'logs'), CANARY)
    expect(logHits.length).toBeGreaterThan(0)
  })

  it('removes the canary from every process log, current and rotated, when the clear-logs offer is chosen', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    drafts = new DraftStorageFixture()
    plantSurfaceLog(tree.logsHome, 'home')
    plantSurfaceLog(tree.logsHome, 'desktop-host')
    const input = poisonChat('ses-purge-b', '/home/user/proj-purge')
    const item = await service().deleteChat(input)

    const report = await service().purge(item.id, { clearLogs: true })

    expectStoresClean(item)
    expect(report.logs.cleared).toBe(true)
    expect(report.logs.residueMaxDays).toBe(0)
    const surface = join(tree.logsHome, 'logs')
    expect(grepTree(surface, CANARY)).toEqual([])
    // The clear empties the active file in place and deletes the rotated file.
    const active = join(surface, 'home-default', 'home.log')
    expect(existsSync(active)).toBe(true)
    expect(statSync(active).size).toBe(0)
    expect(existsSync(join(surface, 'home-default', 'home.log.1'))).toBe(false)
    expect(existsSync(join(surface, 'desktop-host', 'desktop-host.log.1'))).toBe(false)
  })

  it('removes the workspace-scoped draft entries of a purged workspace', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    drafts = new DraftStorageFixture()
    drafts.plant(`dsh.workspace.view.v5.${HOST_A}.ws-purge`, '{"tab":"files"}')
    drafts.plant(`dsh.workspace.view.v5.${HOST_B}.ws-purge`, '{"tab":"log"}')
    drafts.plant(`dsh.workspace.view.v5.${HOST_A}.ws-keep`, '{"tab":"tests"}')
    const item = await service().deleteWorkspace({
      workspaceId: 'ws-purge',
      chats: [{ sessionId: 'ses-ws-purge', cwd: '/home/user/proj-ws' }],
    })

    await service().purge(item.id)

    expect(drafts.get(`dsh.workspace.view.v5.${HOST_A}.ws-purge`)).toBeUndefined()
    expect(drafts.get(`dsh.workspace.view.v5.${HOST_B}.ws-purge`)).toBeUndefined()
    expect(drafts.get(`dsh.workspace.view.v5.${HOST_A}.ws-keep`)).toBe('{"tab":"tests"}')
  })

  it('leaves no cached title, first message, plan, goal or todo on disk after a purge', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    drafts = new DraftStorageFixture()
    const sessionId = 'ses-purge-cache'
    plantSession(tree, sessionId, '/home/person/proj-purge', [0])
    const document = plantProjectionCache(tree, sessionId)
    const other = plantProjectionCache(tree, 'ses-other-chat')
    const item = await service().deleteChat({ sessionId, cwd: '/home/person/proj-purge' })
    // The cache document outlives the delete: only the purge reaches it.
    expect(existsSync(document)).toBe(true)

    const report = await service().purge(item.id)

    expect(report.removedFrom).toContain('projection-cache')
    // The document and the invalid-record backup the domain moves aside both held the values.
    expect(existsSync(document)).toBe(false)
    expect(existsSync(`${document}.bak.20260101T000000000Z`)).toBe(false)
    expect(readdirSync(join(tree.storagesRoot, 'session_projcache', 'sessions'))).toEqual(['ses-other-chat.json', 'ses-other-chat.json.bak.20260101T000000000Z'])
    // Another chat's cached document is not the purged item's and stays.
    expect(existsSync(other)).toBe(true)
  })

  it('refuses a symbolic link planted at the attachment store and leaves what it points to alone', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    drafts = new DraftStorageFixture()
    const input = poisonChat('ses-link-store', '/home/user/proj-link')
    const item = await service().deleteChat(input)
    // A link in the place the home gives the attachment store, with an object of the item's behind it.
    const outside = join(tree.logsHome, '..', 'outside-attachments')
    const outsideObject = attachmentObjectPath(join(outside, 'v1'), input.attachments[0]!)
    mkdirSync(join(outsideObject, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(outsideObject, 'attachment bytes elsewhere', { mode: 0o600 })
    rmSync(dirname(tree.attachmentsRoot), { recursive: true, force: true })
    symlinkSync(outside, dirname(tree.attachmentsRoot))

    await expect(service().purge(item.id)).rejects.toMatchObject({ code: 'TRASH_STORE_REFUSED' })

    expect(existsSync(outsideObject)).toBe(true)
  })

  it('refuses to purge an id the trash does not hold', async () => {
    tree = makeTree()
    index = new IndexFixture(tree.indexPath)
    drafts = new DraftStorageFixture()
    await expect(service().purge('missing-item')).rejects.toMatchObject({ code: 'TRASH_ITEM_NOT_FOUND' })
  })
})
