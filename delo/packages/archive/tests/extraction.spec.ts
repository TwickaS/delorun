/**
 * The guards of an extraction, one spec per refusal contract C8 names: a
 * traversal, an absolute path, a reserved device name, a symbolic link, a
 * device or another special file, a case collision, and the size bounds of the
 * entry count, one entry, the total and the compression ratio. Each spec
 * asserts the refusal's code and that the import staged nothing, so removing
 * the guard it covers fails the spec rather than letting an archive write
 * outside its destination.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHIVE_LIMITS } from '@delo/contract-archive-and-trash'
import {
  ArchiveError,
  ArchiveImporter,
  ZipArchive,
  checkArchivePath,
  checkEntrySizes,
  checkPathCollisions,
  resolveInside,
  writeStaging,
} from '../src/index.ts'
import { RecordingStore, buildArchive, makeScratch, sha256, utf8, type Scratch } from './support.ts'

let scratch: Scratch | undefined

beforeEach(() => {
  scratch = makeScratch()
})

afterEach(() => {
  forgetScratch()
})

/**
 * Run one call that must refuse.
 * @param run - the call.
 * @returns the refusal.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<ArchiveError> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return error
    throw error
  }
  throw new Error('the call was expected to refuse, and it returned')
}

/**
 * Run one synchronous call that must refuse.
 * @param run - the call.
 * @returns the refusal.
 */
function syncRefusalOf(run: () => unknown): ArchiveError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return error
    throw error
  }
  throw new Error('the call was expected to refuse, and it returned')
}

/**
 * Import one archive into a fresh scratch tree, and report what the staging parent holds afterwards.
 * @param bytes - the archive.
 * @returns the refusal and the staging parent's entries after it.
 */
async function importRefusal(bytes: Uint8Array): Promise<{ readonly refusal: ArchiveError, readonly staged: readonly string[] }> {
  forgetScratch()
  const tree = makeScratch()
  scratch = tree
  const importer = new ArchiveImporter({ stagingParent: tree.stagingParent, store: new RecordingStore() })
  const refusal = await refusalOf(() => importer.import(bytes))
  return { refusal, staged: readdirSync(tree.stagingParent) }
}

/**
 * Drop the scratch tree of the iteration that just ran, so a loop over several
 * hostile archives leaves nothing behind.
 */
function forgetScratch(): void {
  scratch?.remove()
  scratch = undefined
}

describe('the path rules of an extraction', () => {
  it('refuses an entry name that climbs out of the destination, and stages nothing', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({ extra: [{ name: '../escape.txt', bytes: utf8('escape') }] }))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(refusal.message).toContain('".."')
    expect(staged).toEqual([])
    expect(existsSync(join(scratch!.root, 'escape.txt'))).toBe(false)
  })

  it('refuses an entry name that runs through a nested directory to leave the destination', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({ extra: [{ name: 'objects/../../escape.txt', bytes: utf8('escape') }] }))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(staged).toEqual([])
  })

  it('refuses an absolute entry name at import, before it stages anything', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({ extra: [{ name: '/etc/passwd', bytes: utf8('root:x:0:0') }] }))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(refusal.message).toContain('is absolute')
    expect(staged).toEqual([])
  })

  it('refuses an absolute name, a drive-letter name, a backslash, a control character and an empty segment', () => {
    expect(syncRefusalOf(() => checkArchivePath('/etc/passwd')).message).toContain('is absolute')
    expect(syncRefusalOf(() => checkArchivePath('C:/Windows/win.ini')).message).toContain('drive letter')
    expect(syncRefusalOf(() => checkArchivePath('objects\\..\\escape')).message).toContain('backslash')
    expect(syncRefusalOf(() => checkArchivePath('objects/\u0000x')).message).toContain('control character')
    expect(syncRefusalOf(() => checkArchivePath('')).message).toContain('empty path')
    expect(syncRefusalOf(() => checkArchivePath('objects//x')).message).toContain('empty segment')
    expect(syncRefusalOf(() => checkArchivePath('objects/./x')).message).toContain('segment')
  })

  it('refuses a workspace identifier that is not one safe path segment', async () => {
    const { refusal } = await importRefusal(buildArchive({
      workspaces: [{ id: '..', name: 'Escape', chats: [], attachments: [], objects: [] }],
    }))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
  })

  it('refuses a path that passes the lexical rules but resolves outside the destination', () => {
    const destination = join(scratch!.root, 'destination')

    expect(syncRefusalOf(() => resolveInside(destination, 'objects/../../escape.txt')).message).toContain('resolves outside')
    expect(syncRefusalOf(() => resolveInside(destination, '.')).message).toContain('resolves outside')
    expect(resolveInside(destination, 'objects/deadbeef')).toBe(join(destination, 'objects/deadbeef'))
  })

  it('resolves a name that only begins with two dots inside the destination, because it is one file name', () => {
    const destination = join(scratch!.root, 'destination')

    expect(resolveInside(destination, '..foo')).toBe(join(destination, '..foo'))
    expect(resolveInside(destination, 'objects/..foo')).toBe(join(destination, 'objects/..foo'))
    expect(syncRefusalOf(() => resolveInside(destination, '../..foo')).message).toContain('resolves outside')
  })

  it('refuses to stage an entry that resolves outside the staging root, and writes nothing there', async () => {
    const root = join(scratch!.stagingParent, 'staging-root')
    const outside = join(scratch!.stagingParent, 'outside.txt')

    const refusal = await refusalOf(() => writeStaging(root, [{ path: '../outside.txt', bytes: utf8('escape') }]))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(existsSync(outside)).toBe(false)
  })

  it('refuses two entries that differ only in letter case, which overwrite each other on a case-insensitive file system', async () => {
    const object = { kind: 'attachment' as const, bytes: utf8('case') }
    const { refusal, staged } = await importRefusal(buildArchive({
      objects: [object],
      extra: [{ name: `Objects/${sha256(object.bytes)}`, bytes: utf8('case') }],
    }))

    expect(refusal.code).toBe('ARCHIVE_CASE_COLLISION')
    expect(staged).toEqual([])
  })

  it('refuses the same path listed twice', () => {
    expect(syncRefusalOf(() => checkPathCollisions(['objects/a', 'objects/a'])).message).toContain('twice')
  })

  it('refuses the device names that a path resolves to a device rather than a file', async () => {
    expect(syncRefusalOf(() => checkArchivePath('nul')).message).toContain('reserved device')
    expect(syncRefusalOf(() => checkArchivePath('con.txt')).message).toContain('reserved device')

    const { refusal } = await importRefusal(buildArchive({ extra: [{ name: 'objects/NUL', bytes: utf8('device') }] }))
    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
  })
})

describe('the entry-type rules of an extraction', () => {
  it('refuses a symbolic link, which an extraction never follows', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({
      extra: [{ name: 'notes.txt', bytes: utf8('../../.ssh/id_ed25519'), unixMode: 0o120777 }],
    }))

    expect(refusal.code).toBe('ARCHIVE_LINK_REJECTED')
    expect(refusal.message).toContain('symbolic link')
    expect(staged).toEqual([])
  })

  it('refuses a symbolic link the manifest lists as an object, not only one the manifest omits', async () => {
    const target = utf8('../../.ssh/id_ed25519')
    const { refusal, staged } = await importRefusal(buildArchive({
      objects: [{ kind: 'attachment', bytes: target, unixMode: 0o120777 }],
    }))

    expect(refusal.code).toBe('ARCHIVE_LINK_REJECTED')
    expect(refusal.message).toContain('symbolic link')
    expect(staged).toEqual([])
  })

  it('refuses a character device, a block device, a FIFO and a socket', async () => {
    const specials = [
      ['character device', 0o020644],
      ['block device', 0o060644],
      ['FIFO', 0o010644],
      ['socket', 0o140644],
    ] as const
    for (const [label, unixMode] of specials) {
      const { refusal, staged } = await importRefusal(buildArchive({
        extra: [{ name: 'objects/special', bytes: utf8(''), unixMode }],
      }))

      expect(refusal.code, label).toBe('ARCHIVE_LINK_REJECTED')
      expect(refusal.message, label).toContain('device or another special file')
      expect(staged, label).toEqual([])
    }
  })

  it('refuses a directory entry, because an archive holds files only', async () => {
    const { refusal } = await importRefusal(buildArchive({
      extra: [{ name: 'objects/directory', bytes: utf8(''), unixMode: 0o040755 }],
    }))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(refusal.message).toContain('is a directory')
  })

  it('accepts a plain file', () => {
    const bytes = buildArchive({ objects: [{ kind: 'attachment', bytes: utf8('plain') }] })

    expect(ZipArchive.open(bytes).names()).toContain('manifest.json')
    expect(() => { ZipArchive.open(bytes).checkEntryTypes() }).not.toThrow()
  })
})

describe('the size bounds of an extraction', () => {
  it('refuses an archive over the entry count', () => {
    const many = Array.from({ length: ARCHIVE_LIMITS.maxEntries + 1 }, (_, index) => ({ path: `objects/${String(index)}`, uncompressedSize: 1 }))

    expect(syncRefusalOf(() => checkEntrySizes(many)).code).toBe('ARCHIVE_TOO_MANY_ENTRIES')
  })

  it('refuses one entry over its own size', () => {
    const refusal = syncRefusalOf(() => checkEntrySizes([{ path: 'objects/big', uncompressedSize: ARCHIVE_LIMITS.maxEntryBytes + 1 }]))

    expect(refusal.code).toBe('ARCHIVE_ENTRY_TOO_LARGE')
    expect(refusal.message).toContain('objects/big')
  })

  it('refuses an archive whose entries add up past the total', () => {
    const atTheEntryLimit = Array.from({ length: 5 }, (_, index) => ({ path: `objects/${String(index)}`, uncompressedSize: ARCHIVE_LIMITS.maxEntryBytes }))

    expect(syncRefusalOf(() => checkEntrySizes(atTheEntryLimit)).code).toBe('ARCHIVE_TOTAL_TOO_LARGE')
  })

  it('refuses one entry whose compression ratio passes the limit', () => {
    const refusal = syncRefusalOf(() => checkEntrySizes([{ path: 'objects/bomb', uncompressedSize: 2000, compressedSize: 19 }]))

    expect(refusal.code).toBe('ARCHIVE_RATIO_EXCEEDED')
    expect(refusal.message).toContain('objects/bomb')
  })

  it('refuses an entry that stores no bytes for a size it declares', () => {
    expect(syncRefusalOf(() => checkEntrySizes([{ path: 'objects/empty', uncompressedSize: 10, compressedSize: 0 }])).code).toBe('ARCHIVE_RATIO_EXCEEDED')
  })

  it('refuses an entry that declares no whole byte size', () => {
    expect(syncRefusalOf(() => checkEntrySizes([{ path: 'objects/half', uncompressedSize: 1.5 }])).code).toBe('ARCHIVE_ENTRY_TOO_LARGE')
  })

  it('refuses a directory over the entry limit before it parses the directory into memory', () => {
    const bytes = buildArchive({
      objects: [
        { kind: 'attachment', bytes: utf8('a') },
        { kind: 'attachment', bytes: utf8('b') },
      ],
    })

    expect(ZipArchive.open(bytes).names()).toHaveLength(4)
    expect(syncRefusalOf(() => ZipArchive.open(bytes, { maxEntries: 3 })).code).toBe('ARCHIVE_TOO_MANY_ENTRIES')
  })

  it('refuses an entry whose declared size is smaller than the bytes it inflates to', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({ customisationDeclaredSize: 4 }))

    expect(refusal.code).toBe('ARCHIVE_TRUNCATED')
    expect(staged).toEqual([])
  })

  it('refuses an entry whose declared size is larger than its bytes', async () => {
    // 200 bytes is a declaration the ratio limit allows, so the check reaches the bytes and finds them shorter than the declaration.
    const { refusal } = await importRefusal(buildArchive({ customisationDeclaredSize: 200 }))

    expect(refusal.code).toBe('ARCHIVE_TRUNCATED')
  })

  it('refuses an entry whose declared size breaks the ratio limit before it reads the bytes', async () => {
    const { refusal } = await importRefusal(buildArchive({ customisationDeclaredSize: 4096 }))

    expect(refusal.code).toBe('ARCHIVE_RATIO_EXCEEDED')
  })

  it('refuses an object whose compression ratio passes the ratio of the format', async () => {
    const bomb = utf8('a'.repeat(20_000))
    const { refusal, staged } = await importRefusal(buildArchive({ objects: [{ kind: 'chat-generation', bytes: bomb, method: 'deflate' }] }))

    expect(ARCHIVE_LIMITS.maxCompressionRatio).toBe(100)
    expect(refusal.code).toBe('ARCHIVE_RATIO_EXCEEDED')
    expect(staged).toEqual([])
  })

  it('refuses a container that ends before its end-of-central-directory record', () => {
    const bytes = buildArchive()

    expect(syncRefusalOf(() => ZipArchive.open(bytes.subarray(0, 8))).code).toBe('ARCHIVE_TRUNCATED')
  })
})

describe('the staging directory of an extraction', () => {
  it('refuses a staging root that already exists, which an import would otherwise share', async () => {
    const root = join(scratch!.stagingParent, 'existing')
    mkdirSync(root)

    const refusal = await refusalOf(() => writeStaging(root, []))

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(refusal.message).toContain('EEXIST')
    expect(refusal.message).not.toContain(scratch!.root)
  })

  it('never replaces a file the import did not write', async () => {
    const root = join(scratch!.stagingParent, 'staging-root')

    const refusal = await refusalOf(() => writeStaging(root, [
      { path: 'objects/a', bytes: utf8('first') },
      { path: 'objects/a/nested', bytes: utf8('second') },
    ]))

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(readFileSync(join(root, 'objects/a'), 'utf8')).toBe('first')
  })

  it('writes the staging root 0700 and every staged file 0600, and removes the root once published', async () => {
    const tree = scratch!
    const chat = utf8('a chat the person wrote')
    const entity = utf8('{"name":"project"}')
    const store = new RecordingStore()
    const bytes = buildArchive({
      objects: [{ kind: 'chat-generation', bytes: chat }, { kind: 'workspace-entity', bytes: entity }],
      workspaces: [{
        id: 'ws-fixture',
        name: 'Project',
        chats: [`objects/${sha256(chat)}`],
        attachments: [],
        objects: [`objects/${sha256(entity)}`],
      }],
    })

    const report = await new ArchiveImporter({ stagingParent: tree.stagingParent, store }).import(bytes, { source: 'archive.zip' })

    expect(report.workspaces).toEqual([{ archiveId: 'ws-fixture', id: 'ws-fixture', name: 'Project' }])
    expect(report.source).toBe('archive.zip')
    expect(store.published).toHaveLength(1)
    expect(store.published[0]!.directoryMode).toBe(0o700)
    expect(store.published[0]!.files.map(file => file.path).sort()).toEqual([
      `objects/${sha256(chat)}`,
      `objects/${sha256(entity)}`,
      'workspace.json',
    ].sort())
    expect(store.published[0]!.files.map(file => file.mode)).toEqual([0o600, 0o600, 0o600])
    expect(readdirSync(tree.stagingParent)).toEqual([])
  })

  it('publishes a workspace whose archive identifier is taken under a fresh one, never over the existing one', async () => {
    const tree = scratch!
    const bytes = buildArchive({ workspaces: [{ id: 'ws-taken', name: 'Project', chats: [], attachments: [], objects: [] }] })
    const store = new RecordingStore(['ws-taken'])

    const report = await new ArchiveImporter({ stagingParent: tree.stagingParent, store, newId: () => 'ws-fresh' }).import(bytes)

    expect(report.workspaces).toEqual([{ archiveId: 'ws-taken', id: 'ws-fresh', name: 'Project' }])
    expect(store.published.map(workspace => workspace.id)).toEqual(['ws-fresh'])
  })

  it('refuses a workspace whose fresh identifier is taken too, rather than overwrite it', async () => {
    const tree = scratch!
    const bytes = buildArchive({ workspaces: [{ id: 'ws-taken', name: 'Project', chats: [], attachments: [], objects: [] }] })
    const store = new RecordingStore(['ws-taken', 'ws-fresh'])

    const refusal = await refusalOf(() => new ArchiveImporter({ stagingParent: tree.stagingParent, store, newId: () => 'ws-fresh' }).import(bytes))

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(store.published).toEqual([])
  })
})
