/**
 * Contract C8's archive denial tests for text, resources and publication. An
 * archive's text may carry no control character that could rewrite what an
 * import prints; an archive is validated and staged without scanning its
 * directory once per entry or holding every entry at once; a caller can set
 * lower limits than the format's; an interrupted import is finished by a
 * recovery that withdraws what it published and removes what it staged; a
 * publication never lands on an existing directory, and no linked directory is
 * written through. Each spec fails when the check it covers is removed.
 */
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, ARCHIVE_LIMITS, type ArchiveWorkspace } from '@delo/contract-archive-and-trash'
import {
  ArchiveImporter,
  DirectoryWorkspaceStore,
  PUBLISHING_JOURNAL_SUFFIX,
  ZipArchive,
  hasControlCharacter,
  type ArchiveWorkspaceStore,
} from '../src/index.ts'
import { refusalAsync } from './refusals.ts'
import { RecordingStore, buildArchive, makeScratch, sha256, utf8, type Scratch } from './support.ts'

let scratch: Scratch

beforeEach(() => {
  scratch = makeScratch()
})

afterEach(() => {
  vi.restoreAllMocks()
  scratch.remove()
})

/**
 * One empty workspace of a fixture archive.
 * @param id - its identifier.
 * @param name - its name.
 * @returns the workspace.
 */
function workspace(id: string, name = 'Project'): ArchiveWorkspace {
  return { id, name, chats: [], attachments: [], objects: [] }
}

/**
 * An importer over the scratch staging parent that accepts unsigned archives.
 * @param store - the store it publishes into.
 * @returns the importer.
 */
function importer(store: ArchiveWorkspaceStore = new RecordingStore()): ArchiveImporter {
  return new ArchiveImporter({ stagingParent: scratch.stagingParent, store, acceptUnsigned: true })
}

describe('archive text carries no control character', () => {
  it.each([
    ['an escape sequence', 'Delo \u001b[2K\rSigned by a key this home trusts.'],
    ['a carriage return', 'Project\rSigned'],
    ['a C1 control', 'Project\u009b2K'],
    ['DEL', 'Project\u007f'],
    ['a bidirectional override', 'Project\u202etsurt'],
    ['a bidirectional isolate', 'Project\u2066x\u2069'],
    ['an Arabic letter mark', 'Project\u061c'],
  ])('a workspace name holding %s is refused before anything is written', async (_name, text) => {
    const refusal = await refusalAsync(() => importer().inspect(buildArchive({ workspaces: [workspace('ws-1', text)] })))

    expect(refusal.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(refusal.message).toContain('control character')
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('a writer name holding a control character is refused', async () => {
    const refusal = await refusalAsync(() => importer().inspect(buildArchive({ createdBy: 'Delo 1.0\u001b]0;trusted\u0007' })))

    expect(refusal.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(refusal.message).toContain('createdBy')
  })

  it('a customisation target holding a control character is refused', async () => {
    const customisation = JSON.stringify({ schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [{ kind: 'theme', target: 'dusk\u202e', values: {} }] })

    const refusal = await refusalAsync(() => importer().inspect(buildArchive({ customisation })))

    expect(refusal.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(refusal.message).toContain('control character')
  })

  it('ordinary text with accents, CJK and emoji is admitted', async () => {
    expect(hasControlCharacter('Projet été 项目 🚀')).toBe(false)
    expect((await importer().inspect(buildArchive({ workspaces: [workspace('ws-1', 'Projet été 项目 🚀')] }))).workspaces[0]!.name).toBe('Projet été 项目 🚀')
  })
})

describe('an archive with many entries', () => {
  it('is validated without scanning its directory once per entry', async () => {
    const objects = Array.from({ length: 400 }, (_, index) => ({ kind: 'attachment' as const, bytes: utf8(`object ${String(index)}`) }))
    const bytes = buildArchive({
      objects,
      workspaces: [{ ...workspace('ws-1'), attachments: objects.map(object => `objects/${sha256(object.bytes)}`) }],
    })
    const names = vi.spyOn(ZipArchive.prototype, 'names')
    const store = new RecordingStore()

    await importer(store).import(bytes)

    expect(names.mock.calls.length).toBeLessThanOrEqual(4)
    expect(store.published[0]!.files).toHaveLength(401)
  })

  it('is read again entry by entry as it is staged, not held whole before the staging root exists', async () => {
    const chat = utf8('a chat')
    const path = `objects/${sha256(chat)}`
    const bytes = buildArchive({ objects: [{ kind: 'chat-generation', bytes: chat }], workspaces: [{ ...workspace('ws-1'), chats: [path] }] })
    const stagedAtRead: number[] = []
    const read = ZipArchive.prototype.read
    vi.spyOn(ZipArchive.prototype, 'read').mockImplementation(function (this: ZipArchive, name: string) {
      if (name === path) stagedAtRead.push(readdirSync(scratch.stagingParent).length)
      return read.call(this, name)
    })

    await importer().import(bytes)

    expect(stagedAtRead).toEqual([0, 1])
  })

  it('is refused at a lower ceiling a caller sets, on its declarations', async () => {
    const bytes = buildArchive({ objects: [{ kind: 'attachment', bytes: utf8('x'.repeat(4096)) }] })
    const lower = new ArchiveImporter({ stagingParent: scratch.stagingParent, store: new RecordingStore(), acceptUnsigned: true, limits: { ...ARCHIVE_LIMITS, maxEntryBytes: 1024 } })

    expect((await refusalAsync(() => lower.inspect(bytes))).code).toBe('ARCHIVE_ENTRY_TOO_LARGE')
    expect((await importer().inspect(bytes)).totalBytes).toBeGreaterThan(4096)
  })
})

describe('an interrupted import', () => {
  it('is finished by a recovery that withdraws what its journal names and removes what it staged', async () => {
    mkdirSync(join(scratch.workspacesRoot, 'ws-orphan'))
    mkdirSync(join(scratch.workspacesRoot, 'ws-kept'))
    mkdirSync(join(scratch.stagingParent, 'abc', 'workspaces', 'ws-orphan', 'objects'), { recursive: true })
    writeFileSync(join(scratch.stagingParent, 'abc', 'workspaces', 'ws-orphan', 'objects', 'chat'), 'decoded chat content')
    writeFileSync(join(scratch.stagingParent, `abc${PUBLISHING_JOURNAL_SUFFIX}`), JSON.stringify({ workspaces: ['ws-orphan'] }))
    const recovering = new ArchiveImporter({ stagingParent: scratch.stagingParent, store: new DirectoryWorkspaceStore(scratch.workspacesRoot) })

    expect(await recovering.recover()).toEqual({ withdrawn: ['ws-orphan'], removed: 2 })
    expect(readdirSync(scratch.workspacesRoot)).toEqual(['ws-kept'])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('trusts nothing from a journal a crash cut short, and refuses one that names a path', async () => {
    const store = new RecordingStore()
    const recovering = new ArchiveImporter({ stagingParent: scratch.stagingParent, store })
    writeFileSync(join(scratch.stagingParent, `a${PUBLISHING_JOURNAL_SUFFIX}`), '{"workspaces":[')

    expect(await recovering.recover()).toEqual({ withdrawn: [], removed: 1 })
    for (const named of [['../elsewhere'], ['..'], [7], 'ws-1']) {
      writeFileSync(join(scratch.stagingParent, `b${PUBLISHING_JOURNAL_SUFFIX}`), JSON.stringify({ workspaces: named }))
      expect((await refusalAsync(() => recovering.recover())).code).toBe('ARCHIVE_SCHEMA_INVALID')
    }
    expect(store.withdrawn).toEqual([])
  })

  it('has nothing to recover before the first import, and reports a staging parent it cannot list', async () => {
    expect(await new ArchiveImporter({ stagingParent: join(scratch.root, 'missing'), store: new RecordingStore() }).recover()).toEqual({ withdrawn: [], removed: 0 })
    writeFileSync(join(scratch.root, 'file'), '')

    await expect(new ArchiveImporter({ stagingParent: join(scratch.root, 'file'), store: new RecordingStore() }).recover()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('leaves its journal when a withdrawal fails, so the next recovery finishes it', async () => {
    const store: ArchiveWorkspaceStore = {
      exists: async () => false,
      publish: async id => { if (id === 'ws-b') throw Object.assign(new Error('full'), { code: 'ENOSPC' }) },
      withdraw: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
    }

    await expect(importer(store).import(buildArchive({ workspaces: [workspace('ws-a'), workspace('ws-b')] }))).rejects.toMatchObject({ code: 'EBUSY' })

    const left = readdirSync(scratch.stagingParent)
    expect(left).toHaveLength(1)
    expect(left[0]!.endsWith(PUBLISHING_JOURNAL_SUFFIX)).toBe(true)
    const recorder = new RecordingStore()
    expect(await new ArchiveImporter({ stagingParent: scratch.stagingParent, store: recorder }).recover()).toEqual({ withdrawn: ['ws-a', 'ws-b'], removed: 1 })
  })

  it('refuses to publish when its journal cannot be written, and publishes nothing', async () => {
    const recorder = new RecordingStore()
    const store: ArchiveWorkspaceStore = {
      exists: async () => {
        const root = readdirSync(scratch.stagingParent)[0]!
        mkdirSync(join(scratch.stagingParent, `${root}${PUBLISHING_JOURNAL_SUFFIX}`))
        return false
      },
      publish: async (id, staged) => recorder.publish(id, staged),
      withdraw: async id => recorder.withdraw(id),
    }

    const refusal = await refusalAsync(() => importer(store).import(buildArchive({ workspaces: [workspace('ws-a')] })))

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(refusal.message).toContain('journal')
    expect(recorder.published).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })
})

describe('a publication', () => {
  it('never lands on an existing directory, even an empty one a rename would replace', async () => {
    mkdirSync(join(scratch.workspacesRoot, 'ws-1'))
    mkdirSync(join(scratch.root, 'staged'))
    writeFileSync(join(scratch.root, 'staged', 'workspace.json'), '{}')

    await expect(new DirectoryWorkspaceStore(scratch.workspacesRoot).publish('ws-1', join(scratch.root, 'staged'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readdirSync(join(scratch.workspacesRoot, 'ws-1'))).toEqual([])
    expect(readdirSync(join(scratch.root, 'staged'))).toEqual(['workspace.json'])
  })

  it('refuses a workspace store root that is a symbolic link, or sits in one', async () => {
    const elsewhere = join(scratch.root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(scratch.root, 'linked'))
    mkdirSync(join(scratch.root, 'staged'))

    const linkedRoot = await refusalAsync(() => new DirectoryWorkspaceStore(join(scratch.root, 'linked')).publish('ws-1', join(scratch.root, 'staged')))
    const linkedParent = await refusalAsync(() => new DirectoryWorkspaceStore(join(scratch.root, 'linked', 'workspaces')).publish('ws-1', join(scratch.root, 'staged')))

    expect([linkedRoot.code, linkedParent.code]).toEqual(['ARCHIVE_STAGING_FAILED', 'ARCHIVE_STAGING_FAILED'])
    expect(linkedRoot.message).toContain('symbolic link')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('refuses a staging parent that is a symbolic link, or sits in one, before it writes anything', async () => {
    const elsewhere = join(scratch.root, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(scratch.stagingParent, { recursive: true })
    symlinkSync(elsewhere, scratch.stagingParent)
    const bytes = buildArchive({ workspaces: [workspace('ws-1')] })
    const inner = new ArchiveImporter({ stagingParent: join(scratch.stagingParent, 'inner'), store: new RecordingStore(), acceptUnsigned: true })

    const refusals = [
      await refusalAsync(() => importer().import(bytes)),
      await refusalAsync(() => inner.import(bytes)),
      await refusalAsync(() => importer().recover()),
    ]

    expect(refusals.map(refusal => refusal.code)).toEqual(['ARCHIVE_STAGING_FAILED', 'ARCHIVE_STAGING_FAILED', 'ARCHIVE_STAGING_FAILED'])
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('reports a failure to inspect a directory it would write into', async () => {
    writeFileSync(join(scratch.root, 'file'), '')
    const blocked = new ArchiveImporter({ stagingParent: join(scratch.root, 'file', 'a', 'b'), store: new RecordingStore(), acceptUnsigned: true })

    await expect(blocked.import(buildArchive())).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
