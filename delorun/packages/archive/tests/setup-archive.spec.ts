/**
 * The setup archive of contract C8: the round trip with the signer states, the refusal of the other content kind in
 * both directions, and the denial tests of the setup document, which a crafted archive cannot use to name a path
 * outside the plugin's folder, to smuggle an expression, or to carry a file the manifest does not list.
 */
import { describe, expect, it } from 'vitest'
import {
  ArchiveError,
  ArchiveImporter,
  exportSetupArchive,
  parseSetupDocument,
  signManifest,
  type SetupDocument,
  type SetupPluginFile,
} from '../src/index.ts'
import { buildArchive, HOME_KEY_ID, HOME_PUBLIC_KEY, makeKey, makeScratch, RecordingStore, sha256, utf8 } from './support.ts'

const PACKAGE_JSON = utf8('{"name":"my-plugin","version":"1.0.0"}')
const INDEX = utf8('export default {}\n')

/**
 * @param bytes - a file's bytes.
 * @param path - its path in the plugin.
 * @returns the file record the document holds.
 */
function fileOf(bytes: Uint8Array, path: string): SetupPluginFile {
  return { path, sha256: sha256(bytes), size: bytes.length, executable: false }
}

const document: SetupDocument = {
  schemaVersion: 1,
  profile: 'default',
  plugins: [
    { name: 'some-registry-plugin', source: 'registry', version: '2.3.4', integrity: 'sha512-AAAA' },
    { name: 'my-plugin', source: 'local', version: '1.0.0', files: [fileOf(PACKAGE_JSON, 'package.json'), fileOf(INDEX, 'dist/index.js')] },
  ],
  includesSettings: true,
  models: [{ id: 'llm-deepseek', config: { model: 'deepseek-chat' } }],
  settings: [{ id: 'delorun-theme', config: { palette: 'dark' } }],
}

const files = new Map([[sha256(PACKAGE_JSON), PACKAGE_JSON], [sha256(INDEX), INDEX]])

/**
 * @param trusted - the public keys the importing home vouches for.
 * @returns an importer over a scratch tree.
 */
function importerOf(trusted: readonly string[] = []): ArchiveImporter {
  const tree = makeScratch()
  return new ArchiveImporter({ stagingParent: tree.stagingParent, store: new RecordingStore(), trustedPublicKeys: trusted })
}

/**
 * @param edit - changes the document before it is serialised.
 * @returns the bytes of a document edited as the spec needs.
 */
function documentBytes(edit: (copy: Record<string, unknown>) => void): Uint8Array {
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>
  edit(copy)
  return utf8(JSON.stringify(copy))
}

describe('setup archive round trip', () => {
  it('returns the document and the files, as unverified for an unknown signer or none and as verified for a vouched key', () => {
    const key = makeKey()
    const origin = { homeKeyId: HOME_KEY_ID, publicKey: HOME_PUBLIC_KEY }
    const unsigned = exportSetupArchive({ createdBy: 'test', origin, document, files })
    const opened = importerOf().openSetup(unsigned, { source: 'setup.zip' })
    expect(opened.document).toEqual(document)
    expect(opened.state).toBe('unverified')
    expect(opened.reason).toBe('absent')
    expect(opened.signed).toBe(false)
    expect(Buffer.from(opened.readFile(sha256(INDEX))).toString()).toBe('export default {}\n')
    const unknown = buildSigned(key)
    expect(importerOf().openSetup(unknown).reason).toBe('key-not-trusted')
    expect(importerOf([key.publicKey]).openSetup(unknown).state).toBe('verified')
  })

  it('refuses a signature that does not verify', () => {
    const key = makeKey()
    const other = makeKey()
    const bytes = buildSigned(key, other)
    expect(() => importerOf().openSetup(bytes)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SIGNATURE_INVALID' }))
  })

  it('refuses a file whose bytes are not the ones the document names', () => {
    const origin = { homeKeyId: HOME_KEY_ID, publicKey: HOME_PUBLIC_KEY }
    expect(() => exportSetupArchive({ createdBy: 'test', origin, document, files: new Map([[sha256(INDEX), utf8('other')], [sha256(PACKAGE_JSON), PACKAGE_JSON]]) }))
      .toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
  })
})

/**
 * @param key - the key whose public half the origin declares.
 * @param signer - the key that signs; the origin's own by default.
 * @returns a setup archive signed by `signer`.
 */
function buildSigned(key: ReturnType<typeof makeKey>, signer = key): Uint8Array {
  const fingerprint = importerKeyId(key.publicKey)
  return exportSetupArchive({
    createdBy: 'test', origin: { homeKeyId: fingerprint, publicKey: key.publicKey }, document, files,
    sign: manifest => signManifest(manifest, fingerprint, signer.privateKey),
  })
}

/**
 * @param publicKey - a base64url public key.
 * @returns its fingerprint.
 */
function importerKeyId(publicKey: string): string {
  return sha256Base64Url(Buffer.from(publicKey, 'base64url'))
}

/**
 * @param bytes - the key's bytes.
 * @returns the SHA-256 in base64url, which is the key's identifier.
 */
function sha256Base64Url(bytes: Buffer): string {
  return Buffer.from(sha256(bytes), 'hex').toString('base64url')
}

describe('content kinds', () => {
  it('refuses a setup archive at delorun import, and a chats archive at delorun setup import', async () => {
    const origin = { homeKeyId: HOME_KEY_ID, publicKey: HOME_PUBLIC_KEY }
    const setup = exportSetupArchive({ createdBy: 'test', origin, document, files })
    await expect(importerOf().inspect(setup)).rejects.toMatchObject({ code: 'ARCHIVE_WRONG_KIND' })
    await expect(importerOf().import(setup)).rejects.toMatchObject({ code: 'ARCHIVE_WRONG_KIND' })
    expect(() => importerOf().openSetup(buildArchive())).toThrow(expect.objectContaining({ code: 'ARCHIVE_WRONG_KIND' }))
  })

  it('refuses a manifest that lists what its content kind does not hold', () => {
    const doc = utf8(JSON.stringify(document))
    const withChat = buildArchive({ content: 'setup', objects: [{ kind: 'setup-document', bytes: doc }, { kind: 'chat-generation', bytes: utf8('chat') }] })
    expect(() => importerOf().openSetup(withChat)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
    const withWorkspace = buildArchive({ content: 'setup', objects: [{ kind: 'setup-document', bytes: doc }], workspaces: [{ id: 'w', name: 'w', chats: [], attachments: [], objects: [] }] })
    expect(() => importerOf().openSetup(withWorkspace)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
    const noDocument = buildArchive({ content: 'setup', objects: [] })
    expect(() => importerOf().openSetup(noDocument)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
    const chatsWithPlugin = buildArchive({ objects: [{ kind: 'plugin-file', bytes: INDEX }] })
    expect(() => importerOf().openSetup(chatsWithPlugin)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
    const unknownContent = buildArchive({ content: 'everything', objects: [{ kind: 'setup-document', bytes: doc }] })
    expect(() => importerOf().openSetup(unknownContent)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
  })

  it('refuses a plugin-file entry no plugin names, and a named file the manifest lacks', () => {
    const doc = utf8(JSON.stringify(document))
    const stray = buildArchive({ content: 'setup', objects: [{ kind: 'setup-document', bytes: doc }, { kind: 'plugin-file', bytes: PACKAGE_JSON }, { kind: 'plugin-file', bytes: INDEX }, { kind: 'plugin-file', bytes: utf8('stray') }] })
    expect(() => importerOf().openSetup(stray)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
    const missing = buildArchive({ content: 'setup', objects: [{ kind: 'setup-document', bytes: doc }, { kind: 'plugin-file', bytes: PACKAGE_JSON }] })
    expect(() => importerOf().openSetup(missing)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
  })

  it('refuses customisation rows in a setup archive', () => {
    const doc = utf8(JSON.stringify({ ...document, plugins: [] }))
    const rows = buildArchive({ content: 'setup', objects: [{ kind: 'setup-document', bytes: doc }], customisation: JSON.stringify({ schemaVersion: 1, rows: [{ kind: 'bundle', target: 'x', values: {} }] }) })
    expect(() => importerOf().openSetup(rows)).toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
  })
})

describe('the setup document is data under a closed schema', () => {
  const refused = (code: string, edit: (copy: Record<string, unknown>) => void): void => {
    expect(() => parseSetupDocument(documentBytes(edit))).toThrow(expect.objectContaining({ code }))
  }
  const localPlugin = (copy: Record<string, unknown>): Record<string, unknown> => (copy['plugins'] as Record<string, unknown>[])[1]!
  const firstFile = (copy: Record<string, unknown>): Record<string, unknown> => (localPlugin(copy)['files'] as Record<string, unknown>[])[1]!

  it('accepts the document the export writes', () => {
    expect(parseSetupDocument(documentBytes(() => {}))).toEqual(document)
  })

  it('refuses a path that climbs, is absolute, has a backslash or collides by case', () => {
    for (const path of ['../evil.js', '/etc/passwd', 'a\\b.js', 'dist/../../x', 'C:/x']) {
      refused('ARCHIVE_PATH_REJECTED', (copy) => { firstFile(copy)['path'] = path })
    }
    refused('ARCHIVE_CASE_COLLISION', (copy) => {
      (localPlugin(copy)['files'] as unknown[]).push({ path: 'DIST/INDEX.JS', sha256: sha256(INDEX), size: INDEX.length, executable: false })
    })
  })

  it('refuses a plugin without a package.json, a name that is not a package name and an inexact version', () => {
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { localPlugin(copy)['files'] = [firstFile(copy)] })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { localPlugin(copy)['name'] = '../escape' })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { (copy['plugins'] as Record<string, unknown>[])[0]!['version'] = '^2.0.0' })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { (copy['plugins'] as Record<string, unknown>[])[0]!['version'] = 'file:../x' })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { (copy['plugins'] as Record<string, unknown>[])[0]!['integrity'] = 'md5-zzzz' })
  })

  it('refuses a plugin listed twice, a field the schema does not define and a source it does not know', () => {
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { (copy['plugins'] as unknown[]).push((copy['plugins'] as unknown[])[0]) })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { copy['extra'] = 1 })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { localPlugin(copy)['postinstall'] = 'rm -rf /' })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { localPlugin(copy)['source'] = 'git' })
    refused('ARCHIVE_UNSUPPORTED_VERSION', (copy) => { copy['schemaVersion'] = 2 })
  })

  it('refuses an expression, a control character and a prototype key in a patch value', () => {
    refused('ARCHIVE_EXPRESSION_REFUSED', (copy) => { copy['models'] = [{ id: 'x', config: { key: '!!js process.env.HOME' } }] })
    refused('ARCHIVE_EXPRESSION_REFUSED', (copy) => { copy['settings'] = [{ id: 'x', config: { key: ' !js 1' } }] })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { copy['models'] = [{ id: 'x', config: { key: 'a\u001b[2Jb' } }] })
    expect(() => parseSetupDocument(utf8('{"schemaVersion":1,"profile":"p","includesSettings":true,"plugins":[],"models":[],"settings":[{"id":"x","config":{"__proto__":{"a":1}}}]}')))
      .toThrow(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_INVALID' }))
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { copy['settings'] = ['not an object'] })
  })

  it('keeps the note short, and says no settings only when none are listed', () => {
    expect(parseSetupDocument(documentBytes((copy) => { copy['note'] = 'for the team' })).note).toBe('for the team')
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { copy['note'] = 'x'.repeat(501) })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { copy['includesSettings'] = false })
    refused('ARCHIVE_SCHEMA_INVALID', (copy) => { delete copy['includesSettings'] })
    expect(parseSetupDocument(documentBytes((copy) => { copy['includesSettings'] = false; copy['settings'] = [] })).includesSettings).toBe(false)
  })

  it('names a plugin of one\'s own without its files', () => {
    const named = parseSetupDocument(documentBytes((copy) => { localPlugin(copy)['files'] = [] }))
    expect(named.plugins[1]).toMatchObject({ source: 'local', files: [] })
  })

  it('is not UTF-8 JSON when the bytes are not', () => {
    expect(() => parseSetupDocument(new Uint8Array([0xff, 0xfe]))).toThrow(ArchiveError)
  })
})
