/**
 * The specs of what an import asks before it writes: a signature that does not
 * verify and a member whose bytes were changed are refused outright, a key the
 * home does not vouch for and an unsigned archive are refused until the person
 * accepts them, the preview describes the archive and writes nothing, and a
 * publication that fails partway withdraws every workspace the import already
 * published. Each spec fails when the check it covers is removed.
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION } from '@delo/contract-archive-and-trash'
import {
  ArchiveError,
  ArchiveImporter,
  DirectoryWorkspaceStore,
  ZipArchive,
  ZipWriter,
  exportArchive,
  keyFingerprint,
  signManifest,
  type ArchiveImporterConfig,
} from '../src/index.ts'
import { HOME_KEY_ID, RecordingStore, buildArchive, makeKey, makeScratch, sha256, utf8, type FixtureKey, type Scratch } from './support.ts'

let scratch: Scratch

beforeEach(() => {
  scratch = makeScratch()
})

afterEach(() => {
  scratch.remove()
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
 * One signed archive holding one workspace with one chat.
 * @param key - the key that signs it.
 * @param chat - the chat's text.
 * @returns the archive's bytes.
 */
function signedArchive(key: FixtureKey, chat = 'a chat the person wrote'): Uint8Array {
  const exported = exportArchive({
    createdBy: 'delo-archive-fixture',
    origin: { homeKeyId: keyFingerprint(key.publicKey), publicKey: key.publicKey },
    workspaces: [{ id: 'ws-chat', name: 'Project', entity: utf8('{"name":"project"}'), chats: [{ id: 'chat-1', text: chat }], attachments: [utf8('attachment')] }],
    customisation: { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [{ kind: 'theme', target: 'dusk', values: { accent: 'blue' } }] },
    sign: manifestBytes => signManifest(manifestBytes, keyFingerprint(key.publicKey), key.privateKey),
  })
  return exported.bytes!
}

/**
 * An importer over the scratch tree.
 * @param config - the importer's facts, without the staging parent.
 * @returns the importer.
 */
function importer(config: Omit<ArchiveImporterConfig, 'stagingParent'>): ArchiveImporter {
  return new ArchiveImporter({ stagingParent: scratch.stagingParent, ...config })
}

/**
 * Rewrite one archive with one entry's bytes replaced, keeping every other entry as it was.
 * @param bytes - the archive.
 * @param replace - the replacement for each entry, by name, or `undefined` to keep it.
 * @returns the rewritten archive.
 */
function rewrite(bytes: Uint8Array, replace: (name: string, data: Uint8Array) => Uint8Array | undefined): Uint8Array {
  const archive = ZipArchive.open(bytes)
  const writer = new ZipWriter()
  for (const name of archive.names()) {
    const data = archive.read(name)
    writer.add({ name, bytes: replace(name, data) ?? data })
  }
  return writer.finish()
}

describe('a signature that does not verify', () => {
  it('is refused by the preview and the import alike, and nothing is staged or published', async () => {
    const key = makeKey()
    const other = makeKey()
    const bytes = rewrite(signedArchive(key), (name, data) => {
      if (name !== 'signature.json') return undefined
      const signature = JSON.parse(new TextDecoder().decode(data)) as { signature: string }
      return utf8(JSON.stringify({ ...signature, signature: signManifest(utf8('another manifest'), 'x', other.privateKey).signature }))
    })
    const store = new RecordingStore()

    const inspected = await refusalOf(() => importer({ store, trustedPublicKeys: [key.publicKey] }).inspect(bytes))
    const imported = await refusalOf(() => importer({ store, trustedPublicKeys: [key.publicKey], acceptUnsigned: true }).import(bytes))

    expect(inspected.code).toBe('ARCHIVE_SIGNATURE_INVALID')
    expect(imported.code).toBe('ARCHIVE_SIGNATURE_INVALID')
    expect(store.published).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('is refused when the manifest changed after it was signed', async () => {
    const key = makeKey()
    const bytes = rewrite(signedArchive(key), (name, data) => name === 'manifest.json'
      ? utf8(new TextDecoder().decode(data).replace('"Project"', '"Renamed"'))
      : undefined)
    const store = new RecordingStore()

    const refusal = await refusalOf(() => importer({ store, trustedPublicKeys: [key.publicKey] }).import(bytes))

    expect(refusal.code).toBe('ARCHIVE_SIGNATURE_INVALID')
    expect(store.published).toEqual([])
  })
})

describe('a member whose bytes were changed', () => {
  it('is refused with the checksum mismatch, before anything is staged', async () => {
    const key = makeKey()
    const original = signedArchive(key, 'the original chat')
    const bytes = rewrite(original, (_name, data) => new TextDecoder().decode(data) === 'the original chat'
      ? utf8('the altered chat!')
      : undefined)
    const store = new RecordingStore()

    const refusal = await refusalOf(() => importer({ store, trustedPublicKeys: [key.publicKey] }).import(bytes))

    expect(refusal.code).toBe('ARCHIVE_CHECKSUM_MISMATCH')
    expect(store.published).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })
})

describe('the signer an import accepts', () => {
  it('refuses a key the home does not vouch for until the person confirms that key', async () => {
    const key = makeKey()
    const bytes = signedArchive(key)
    const store = new RecordingStore()

    const refusal = await refusalOf(() => importer({ store }).import(bytes))
    expect(refusal.code).toBe('ARCHIVE_SIGNER_UNTRUSTED')
    expect(store.published).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])

    const report = await importer({ store, confirmedPublicKey: key.publicKey }).import(bytes)
    expect(report.state).toBe('verified')
    expect(store.published.map(workspace => workspace.id)).toEqual(['ws-chat'])
  })

  it('refuses an unsigned archive until the person accepts it unverified', async () => {
    const store = new RecordingStore()
    const bytes = buildArchive({ workspaces: [{ id: 'ws-plain', name: 'Plain', chats: [], attachments: [], objects: [] }] })

    const refusal = await refusalOf(() => importer({ store }).import(bytes))

    expect(refusal.code).toBe('ARCHIVE_SIGNER_UNTRUSTED')
    expect(refusal.message).toContain('no signature')
    expect(store.published).toEqual([])
  })
})

describe('the preview of an archive', () => {
  it('names the signer by the fingerprint of its key and lists what the archive holds, writing nothing', async () => {
    const key = makeKey()
    const store = new RecordingStore()

    const preview = await importer({ store }).inspect(signedArchive(key), { source: 'project.delo' })

    expect(preview).toMatchObject({
      state: 'unverified',
      reason: 'key-not-trusted',
      source: 'project.delo',
      signed: true,
      createdBy: 'delo-archive-fixture',
      signer: { publicKey: key.publicKey, fingerprint: keyFingerprint(key.publicKey) },
      workspaces: [{ id: 'ws-chat', name: 'Project', chats: 1, attachments: 1 }],
      customisation: [{ kind: 'theme', target: 'dusk' }],
    })
    expect(preview.label).toContain('not one this home trusts')
    expect(preview.totalBytes).toBeGreaterThan(0)
    expect(store.published).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('names an unsigned archive by its origin key identifier when no file name is given', async () => {
    const preview = await importer({ store: new RecordingStore() }).inspect(buildArchive())

    expect(preview.signed).toBe(false)
    expect(preview.reason).toBe('absent')
    expect(preview.source).toBe(HOME_KEY_ID)
  })
})

describe('an import that fails partway', () => {
  it('withdraws every workspace it already published, so no partial workspace or chat remains', async () => {
    const chat = utf8('the first workspace chat')
    const bytes = buildArchive({
      objects: [{ kind: 'chat-generation', bytes: chat }],
      workspaces: [
        { id: 'ws-a', name: 'First', chats: [`objects/${sha256(chat)}`], attachments: [], objects: [] },
        { id: 'ws-b', name: 'Second', chats: [], attachments: [], objects: [] },
      ],
    })
    /** A directory store whose second publication fails. */
    class FailingSecond extends DirectoryWorkspaceStore {
      override async publish(id: string, stagedDirectory: string): Promise<void> {
        if (id === 'ws-b') throw Object.assign(new Error('the disk is full'), { code: 'ENOSPC' })
        await super.publish(id, stagedDirectory)
      }
    }
    const store = new FailingSecond(scratch.workspacesRoot)

    const refusal = await refusalOf(() => importer({ store, acceptUnsigned: true }).import(bytes))

    expect(refusal.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(refusal.message).toContain('ENOSPC')
    expect(readdirSync(scratch.workspacesRoot)).toEqual([])
    expect(readdirSync(scratch.stagingParent)).toEqual([])
  })

  it('publishes every workspace of an archive into the directory store when nothing fails', async () => {
    const bytes = buildArchive({ workspaces: [{ id: 'ws-a', name: 'First', chats: [], attachments: [], objects: [] }] })
    const root = join(scratch.root, 'store')
    mkdirSync(root)

    await importer({ store: new DirectoryWorkspaceStore(root), acceptUnsigned: true }).import(bytes)

    expect(readdirSync(root)).toEqual(['ws-a'])
    expect(readdirSync(join(root, 'ws-a'))).toEqual(['workspace.json'])
  })
})
