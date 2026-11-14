/**
 * Proves an import refuses an archive whose manifest and entries disagree, and
 * a publication it cannot finish, without leaving anything behind: a manifest
 * size or digest that is not the entry's, an entry the manifest does not list, a
 * listed entry the archive does not hold, a manifest without the customisation
 * document, a workspace identifier the store holds twice over, and a store that
 * fails partway through several workspaces. Every refusal asserts the exact
 * code, that no workspace was published and that the staging parent is empty.
 * It also proves the directory workspace store reports existence, publishes
 * without overwriting and withdraws.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION } from '@delorun/contract-archive-and-trash'
import {
  ArchiveImporter,
  DirectoryWorkspaceStore,
  ZipWriter,
  type ArchiveImporterConfig,
  type ArchiveWorkspaceStore,
  type ZipEntryInput,
} from '../src/index.ts'
import { refusalAsync } from './refusals.ts'
import { HOME_KEY_ID, HOME_PUBLIC_KEY, RecordingStore, buildArchive, makeScratch, sha256, utf8, type Scratch } from './support.ts'

let scratch: Scratch

beforeEach(() => {
  scratch = makeScratch()
})

afterEach(() => {
  scratch.remove()
})

/** The customisation document every archive of this spec carries. */
const CUSTOMISATION = utf8(JSON.stringify({ schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] }))

/**
 * An importer over the scratch tree that accepts an unsigned archive.
 * @param store - the workspace store to publish into.
 * @param extra - further importer configuration.
 * @returns the importer.
 */
function importer(store: ArchiveWorkspaceStore, extra: Partial<ArchiveImporterConfig> = {}): ArchiveImporter {
  return new ArchiveImporter({ stagingParent: scratch.stagingParent, store, acceptUnsigned: true, ...extra })
}

/**
 * Write an archive from a manifest and entries a spec chooses, without the
 * agreement between them that `buildArchive` keeps.
 * @param manifestEntries - the entries the manifest lists.
 * @param files - the entries the archive holds beside the manifest.
 * @returns the archive's bytes.
 */
function disagreeing(manifestEntries: readonly Record<string, unknown>[], files: readonly ZipEntryInput[]): Uint8Array {
  const writer = new ZipWriter()
  for (const file of files) writer.add(file)
  writer.add({
    name: 'manifest.json',
    bytes: utf8(JSON.stringify({
      formatVersion: 1,
      createdBy: 'delorun-archive-spec',
      exportedAt: '2026-01-01T00:00:00Z',
      origin: { homeKeyId: HOME_KEY_ID, publicKey: HOME_PUBLIC_KEY },
      workspaces: [],
      entries: manifestEntries,
    })),
  })
  return writer.finish()
}

/** The manifest entry of the customisation document. */
const CUSTOMISATION_ENTRY = { path: 'customisation.json', sha256: sha256(CUSTOMISATION), size: CUSTOMISATION.length, kind: 'customisation' }

/** The archive entry of the customisation document. */
const CUSTOMISATION_FILE: ZipEntryInput = { name: 'customisation.json', bytes: CUSTOMISATION }

/**
 * Import an archive that must refuse, and check that nothing was left behind.
 * @param bytes - the archive.
 * @param store - the store to publish into.
 * @returns the refusal.
 */
async function refused(bytes: Uint8Array, store: RecordingStore = new RecordingStore()): Promise<{ readonly code: string, readonly message: string }> {
  const error = await refusalAsync(() => importer(store).import(bytes))
  expect(store.published).toEqual([])
  expect(readdirSync(scratch.stagingParent)).toEqual([])
  return error
}

describe('an archive whose manifest disagrees with its entries', () => {
  it('is refused when an entry holds other bytes than the size the manifest declares', async () => {
    const bytes = utf8('four')
    const error = await refused(disagreeing(
      [CUSTOMISATION_ENTRY, { path: `objects/${sha256(bytes)}`, sha256: sha256(bytes), size: 9, kind: 'chat-generation' }],
      [CUSTOMISATION_FILE, { name: `objects/${sha256(bytes)}`, bytes }],
    ))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('where the manifest declares 9')
  })

  it('is refused when an entry is not the content its manifest digest names', async () => {
    const digest = sha256(utf8('declared'))
    const error = await refused(disagreeing(
      [CUSTOMISATION_ENTRY, { path: `objects/${digest}`, sha256: digest, size: 5, kind: 'chat-generation' }],
      [CUSTOMISATION_FILE, { name: `objects/${digest}`, bytes: utf8('other') }],
    ))

    expect(error.code).toBe('ARCHIVE_CHECKSUM_MISMATCH')
  })

  it('is refused when the archive holds an entry the manifest does not list', async () => {
    const error = await refused(buildArchive({ extra: [{ name: 'objects/unlisted', bytes: utf8('x') }] }))

    expect(error.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(error.message).toContain('does not list')
  })

  it('is refused when the manifest lists an entry the archive does not hold', async () => {
    const digest = sha256(utf8('absent'))
    const error = await refused(disagreeing(
      [CUSTOMISATION_ENTRY, { path: `objects/${digest}`, sha256: digest, size: 6, kind: 'chat-generation' }],
      [CUSTOMISATION_FILE],
    ))

    expect(error.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(error.message).toContain('does not hold')
  })

  it('is refused when the manifest lists no customisation document', async () => {
    const error = await refused(disagreeing([], []))

    expect(error.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(error.message).toContain('customisation.json')
  })
})

describe('a publication that cannot finish', () => {
  const first = utf8('first chat')
  const second = utf8('second chat')

  /** An archive of two workspaces, one chat each. */
  function twoWorkspaces(): Uint8Array {
    return buildArchive({
      objects: [{ kind: 'chat-generation', bytes: first }, { kind: 'chat-generation', bytes: second }],
      workspaces: [
        { id: 'ws-a', name: 'A', chats: [`objects/${sha256(first)}`], attachments: [], objects: [] },
        { id: 'ws-b', name: 'B', chats: [`objects/${sha256(second)}`], attachments: [], objects: [] },
      ],
    })
  }

  /**
   * A store that publishes normally until its second publication, which fails with a value a spec chooses.
   * @param failure - what the second publication throws.
   * @returns the store, recording its publications and withdrawals.
   */
  function failingSecond(failure: unknown): RecordingStore {
    return new class extends RecordingStore {
      private calls = 0
      override async publish(id: string, stagedDirectory: string): Promise<void> {
        this.calls++
        if (this.calls === 2) throw failure
        await super.publish(id, stagedDirectory)
      }
    }()
  }

  it('withdraws the workspaces already published and removes the staging root', async () => {
    const store = failingSecond(Object.assign(new Error('refused'), { code: 'EACCES' }))

    const error = await refusalAsync(() => importer(store).import(twoWorkspaces()))

    expect(error.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(error.message).toContain('"ws-b"')
    expect(error.message).toContain('EACCES')
    expect(store.published.map(workspace => workspace.id)).toEqual(['ws-a'])
    expect(store.withdrawn).toEqual(['ws-a'])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('names an unexpected error when the store throws something without a code', async () => {
    const error = await refusalAsync(() => importer(failingSecond('not an error')).import(twoWorkspaces()))

    expect(error.message).toContain('unexpected error')
  })

  it('is refused when the store holds the archive identifier and the fresh identifier too', async () => {
    const store = new RecordingStore(['ws-a', 'ws-fresh'])

    const error = await refusalAsync(() => importer(store, { newId: () => 'ws-fresh' }).import(twoWorkspaces()))

    expect(error.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(error.message).toContain('"ws-fresh"')
    expect(store.published).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('publishes a workspace whose archive identifier is taken under a generated identifier', async () => {
    const store = new RecordingStore(['ws-a'])

    const report = await importer(store).import(twoWorkspaces())

    const [renamed, kept] = report.workspaces
    expect(renamed!.archiveId).toBe('ws-a')
    expect(renamed!.id).not.toBe('ws-a')
    expect(renamed!.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(kept!.id).toBe('ws-b')
  })
})

describe('DirectoryWorkspaceStore', () => {
  it('reports whether a workspace directory exists', async () => {
    const store = new DirectoryWorkspaceStore(scratch.workspacesRoot)
    mkdirSync(join(scratch.workspacesRoot, 'ws-a'))

    expect(await store.exists('ws-a')).toBe(true)
    expect(await store.exists('ws-b')).toBe(false)
  })

  it('rethrows a failure to inspect the root that is not a missing directory', async () => {
    const root = join(scratch.root, 'a-file')
    writeFileSync(root, 'a file where the root belongs')

    await expect(new DirectoryWorkspaceStore(root).exists('ws-a')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('publishes a staged directory, refuses to replace one that exists, and withdraws it', async () => {
    const store = new DirectoryWorkspaceStore(join(scratch.workspacesRoot, 'nested'))
    const staged = join(scratch.root, 'staged')
    mkdirSync(staged)
    writeFileSync(join(staged, 'workspace.json'), '{}')
    const other = join(scratch.root, 'other')
    mkdirSync(other)

    await store.publish('ws-a', staged)

    expect(existsSync(join(scratch.workspacesRoot, 'nested', 'ws-a', 'workspace.json'))).toBe(true)
    await expect(store.publish('ws-a', other)).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTEMPTY)$/u) })
    expect(existsSync(other)).toBe(true)
    await store.withdraw('ws-a')
    expect(await store.exists('ws-a')).toBe(false)
  })
})
