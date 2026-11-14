/**
 * The specs of an import's signature state, its declared-size check, the
 * workspace identifiers a manifest may not repeat, the staging root a refusal
 * leaves empty, and the export that re-imports. Each spec asserts the state or
 * the refusal a person sees, so removing the check it covers fails the spec:
 * a signed archive is shown as verified, an impostor key that reuses a
 * confirmed identifier is refused, an archive that breaks a limit on its
 * declarations is refused before an entry is read, a repeated workspace
 * identifier is refused before staging, and a staging write that fails after
 * chat content was staged leaves no chat content on disk.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, ARCHIVE_LIMITS } from '@delorun/contract-archive-and-trash'
import {
  ArchiveError,
  ArchiveImporter,
  ZipArchive,
  checkContainerDeclarations,
  exportArchive,
  keyFingerprint,
  signManifest,
  type ArchiveImportReport,
  type ArchiveImporterConfig,
} from '../src/index.ts'
import { HOME_KEY_ID, RecordingStore, buildArchive, makeKey, makeScratch, sha256, utf8, type Scratch } from './support.ts'

/** The chat text a staging spec plants, which must never survive a refusal on disk. */
const SECRET_CHAT = 'SECRET-CHAT-CONTENT'

let scratch: Scratch | undefined

beforeEach(() => {
  scratch = makeScratch()
})

afterEach(() => {
  forgetScratch()
})

/**
 * Drop the scratch tree of the iteration that just ran.
 */
function forgetScratch(): void {
  scratch?.remove()
  scratch = undefined
}

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
 * Import one archive into a fresh scratch tree with one configuration, and
 * report what the staging parent holds afterwards.
 * @param bytes - the archive.
 * @param config - the importer's facts, without the staging parent and the store, which the spec supplies.
 * @returns the refusal and the staging parent's entries after it.
 */
async function importRefusal(
  bytes: Uint8Array,
  config: Omit<ArchiveImporterConfig, 'stagingParent'> = { store: new RecordingStore(), acceptUnsigned: true },
): Promise<{ readonly refusal: ArchiveError, readonly staged: readonly string[] }> {
  forgetScratch()
  const tree = makeScratch()
  scratch = tree
  const importer = new ArchiveImporter({ stagingParent: tree.stagingParent, ...config })
  const refusal = await refusalOf(() => importer.import(bytes))
  return { refusal, staged: readdirSync(tree.stagingParent) }
}

/**
 * Import one archive into a fresh scratch tree with one configuration.
 * @param bytes - the archive.
 * @param config - the importer's facts, without the staging parent, which the spec supplies.
 * @returns the report the import returned.
 */
async function importInto(
  bytes: Uint8Array,
  config: Omit<ArchiveImporterConfig, 'stagingParent'>,
): Promise<ArchiveImportReport> {
  forgetScratch()
  const tree = makeScratch()
  scratch = tree
  return new ArchiveImporter({ stagingParent: tree.stagingParent, ...config }).import(bytes, { source: 'archive.zip' })
}

describe('the signature state of an import', () => {
  it('shows a signed archive whose key this home already holds as verified', async () => {
    const key = makeKey()
    const bytes = buildArchive({
      origin: { homeKeyId: keyFingerprint(key.publicKey), publicKey: key.publicKey },
      sign: { ...key, homeKeyId: keyFingerprint(key.publicKey) },
    })

    const tree = makeScratch()
    scratch = tree
    const report = await new ArchiveImporter({
      stagingParent: tree.stagingParent,
      store: new RecordingStore(),
      trustedPublicKeys: [key.publicKey],
    }).import(bytes)

    expect(report.state).toBe('verified')
    expect(report.reason).toBeUndefined()
    expect(report.label).toContain('the signature is verified')
  })

  it('shows a signed archive as verified when the person confirmed the key itself', async () => {
    const key = makeKey()
    const bytes = buildArchive({
      origin: { homeKeyId: keyFingerprint(key.publicKey), publicKey: key.publicKey },
      sign: { ...key, homeKeyId: keyFingerprint(key.publicKey) },
    })

    const report = await importInto(bytes, {
      store: new RecordingStore(),
      confirmedHomeKeyId: keyFingerprint(key.publicKey),
      confirmedPublicKey: key.publicKey,
    })

    expect(report.state).toBe('verified')
  })

  it('refuses an impostor key that reuses the confirmed identifier', async () => {
    const home = makeKey()
    const impostor = makeKey()
    expect(impostor.publicKey).not.toBe(home.publicKey)
    const homeKeyId = keyFingerprint(home.publicKey)
    const bytes = buildArchive({
      origin: { homeKeyId, publicKey: impostor.publicKey },
      sign: { homeKeyId, privateKey: impostor.privateKey },
    })

    const store = new RecordingStore()
    const { refusal, staged } = await importRefusal(bytes, { store, confirmedHomeKeyId: homeKeyId })

    expect(refusal.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(refusal.message).toContain('not the fingerprint')
    expect(staged).toEqual([])
    expect(store.published).toEqual([])
  })

  it('shows an unsigned archive the person accepted as unverified with the reason the report names', async () => {
    const report = await importInto(buildArchive(), { store: new RecordingStore(), acceptUnsigned: true })

    expect(report.state).toBe('unverified')
    expect(report.reason).toBe('absent')
    expect(report.label).toContain('carries no signature')
  })
})

describe('the declared sizes of an import', () => {
  it('refuses an archive whose declared sizes pass the ratio limit but exceed the total before it reads an entry', async () => {
    // Each entry declares 900 MiB compressed into 9 MiB, which is exactly the ratio limit, and five of them pass 4 GiB in total. Reading one would allocate its 900 MiB, so the refusal has to come from the declarations.
    const objects = Array.from({ length: 5 }, (_, index) => ({
      kind: 'attachment' as const,
      bytes: utf8(`an object the central directory overstates, number ${String(index)}`),
      declaredUncompressedSize: 900 * 1024 * 1024,
      declaredCompressedSize: 9 * 1024 * 1024,
    }))
    const bytes = buildArchive({ objects })

    expect(bytes.length).toBeLessThan(64 * 1024)
    expect(900 * 5).toBeGreaterThan((ARCHIVE_LIMITS.maxTotalBytes / (1024 * 1024)))

    const { refusal, staged } = await importRefusal(bytes)

    expect(refusal.code).toBe('ARCHIVE_TOTAL_TOO_LARGE')
    expect(staged).toEqual([])
  })

  it('refuses one entry whose declared size passes the ratio limit but not the entry limit', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({
      objects: [{
        kind: 'attachment',
        bytes: utf8('an object the central directory overstates'),
        declaredUncompressedSize: ARCHIVE_LIMITS.maxEntryBytes + 1024,
        declaredCompressedSize: 20 * 1024 * 1024,
      }],
    }))

    expect(refusal.code).toBe('ARCHIVE_ENTRY_TOO_LARGE')
    expect(staged).toEqual([])
  })
})

describe('the workspace identifiers of a manifest', () => {
  it('refuses two workspaces that carry one identifier, before it stages either', async () => {
    const workspace = { id: 'ws-twin', name: 'Project', chats: [], attachments: [], objects: [] }
    const { refusal, staged } = await importRefusal(buildArchive({ workspaces: [workspace, { ...workspace, name: 'Other' }] }))

    expect(refusal.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(refusal.message).toContain('twice')
    expect(staged).toEqual([])
  })

  it('refuses two workspaces whose identifiers differ only in letter case', async () => {
    const { refusal, staged } = await importRefusal(buildArchive({
      workspaces: [
        { id: 'ws-project', name: 'Project', chats: [], attachments: [], objects: [] },
        { id: 'WS-PROJECT', name: 'Other', chats: [], attachments: [], objects: [] },
      ],
    }))

    expect(refusal.code).toBe('ARCHIVE_CASE_COLLISION')
    expect(staged).toEqual([])
  })
})

describe('the staging root of a refusal', () => {
  it('removes the staging root when a write fails after chat content was staged', async () => {
    const chat = utf8(SECRET_CHAT)
    // The identifier is one path segment the file system cannot name, so the workspace document fails after the chat object has been written.
    const { refusal, staged } = await importRefusal(buildArchive({
      objects: [{ kind: 'chat-generation', bytes: chat }],
      workspaces: [{ id: 'w'.repeat(300), name: 'Project', chats: [`objects/${sha256(chat)}`], attachments: [], objects: [] }],
    }))

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(refusal.message).toContain('workspace.json')
    expect(refusal.message).not.toContain(scratch!.root)
    expect(staged).toEqual([])
    expect(existsSync(join(scratch!.stagingParent, 'objects'))).toBe(false)
  })

  it('leaves no chat content under the staging parent when the workspace store refuses a publication', async () => {
    const chat = utf8(SECRET_CHAT)
    const bytes = buildArchive({
      objects: [{ kind: 'chat-generation', bytes: chat }],
      workspaces: [{ id: 'ws-secret', name: 'Project', chats: [`objects/${sha256(chat)}`], attachments: [], objects: [] }],
    })

    const { refusal, staged } = await importRefusal(bytes, {
      store: {
        exists: async () => false,
        publish: async () => { throw Object.assign(new Error('the store refused'), { code: 'EACCES' }) },
        withdraw: async () => { throw new Error('nothing was published, so nothing is withdrawn') },
      },
      acceptUnsigned: true,
    })

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(refusal.message).toContain('EACCES')
    expect(staged).toEqual([])
  })
})

describe('the export of an archive an import accepts', () => {
  it('round-trips a repetitive chat that compressing alone would drive over the ratio limit', async () => {
    const key = makeKey()
    const chat = 'the same sentence, over and over. '.repeat(600)
    expect(new TextEncoder().encode(chat).length).toBeGreaterThan(20_000)

    const exported = exportArchive({
      createdBy: 'delorun-archive-fixture',
      origin: { homeKeyId: keyFingerprint(key.publicKey), publicKey: key.publicKey },
      workspaces: [{
        id: 'ws-chat',
        name: 'Project',
        entity: utf8('{"name":"project"}'),
        chats: [{ id: 'chat-1', text: chat }],
        attachments: [],
      }],
      customisation: { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] },
      sign: manifestBytes => signManifest(manifestBytes, keyFingerprint(key.publicKey), key.privateKey),
    })

    expect(exported.cancelled).toBe(false)
    const bytes = exported.bytes!
    // The finished archive is importable by the same limits an import applies before it reads an entry.
    expect(() => { checkContainerDeclarations(ZipArchive.open(bytes)) }).not.toThrow()

    const report = await importInto(bytes, { store: new RecordingStore(), trustedPublicKeys: [key.publicKey] })

    expect(report.state).toBe('verified')
    expect(report.workspaces).toEqual([{ archiveId: 'ws-chat', id: 'ws-chat', name: 'Project' }])
  })

  it('stores an object whose deflated form would pass the ratio limit rather than compressing it', () => {
    const exported = exportArchive({
      createdBy: 'delorun-archive-fixture',
      origin: { homeKeyId: HOME_KEY_ID, publicKey: makeKey().publicKey },
      workspaces: [{
        id: 'ws-chat',
        name: 'Project',
        entity: utf8('{"name":"project"}'),
        chats: [{ id: 'chat-1', text: 'a'.repeat(20_000) }],
        attachments: [],
      }],
      customisation: { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] },
    })

    const records = ZipArchive.open(exported.bytes!).entries
    const chat = records.find(record => record.uncompressedSize === 20_000)

    expect(chat?.compressedSize).toBe(20_000)
  })
})
