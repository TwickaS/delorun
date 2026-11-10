/**
 * Proves the manifest parser accepts a well-formed `manifest.json` and refuses
 * every document the closed format does not define, each with its exact code:
 * text that is not UTF-8 JSON or not an object, an unknown or missing field,
 * another format version, a malformed creator, export time, origin, entry or
 * workspace, a path that does not match the entry's kind, a reference to an
 * unlisted entry, and a workspace identifier that repeats or differs only in
 * letter case.
 */
import { describe, expect, it } from 'vitest'
import { ARCHIVE_FORMAT_VERSION } from '@delo/contract-archive-and-trash'
import { keyFingerprint, parseManifest } from '../src/index.ts'
import { refusal } from './refusals.ts'
import { utf8 } from './support.ts'

/** The digest of the one object entry the base manifest lists. */
const OBJECT_DIGEST = 'ab'.repeat(32)

/** The digest of the customisation entry the base manifest lists. */
const CUSTOMISATION_DIGEST = 'cd'.repeat(32)

/** The path of the base manifest's object entry. */
const OBJECT_PATH = `objects/${OBJECT_DIGEST}`

/**
 * One manifest entry, with fields a spec overrides.
 * @param overrides - the fields to replace.
 * @returns the entry.
 */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: OBJECT_PATH, sha256: OBJECT_DIGEST, size: 3, kind: 'chat-generation', ...overrides }
}

/**
 * One manifest workspace, with fields a spec overrides.
 * @param overrides - the fields to replace.
 * @returns the workspace.
 */
function workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'ws-1', name: 'Project', chats: [OBJECT_PATH], attachments: [], objects: [], ...overrides }
}

/**
 * One manifest origin, with fields a spec overrides.
 * @param overrides - the fields to replace.
 * @returns the origin.
 */
function origin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { homeKeyId: keyFingerprint(Buffer.alloc(32, 7).toString('base64url')), publicKey: Buffer.alloc(32, 7).toString('base64url'), ...overrides }
}

/**
 * The bytes of a manifest, with top-level fields a spec overrides.
 * @param overrides - the fields to replace; a field set to `undefined` is left out.
 * @returns the document's bytes.
 */
function manifest(overrides: Record<string, unknown> = {}): Uint8Array {
  const document: Record<string, unknown> = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdBy: 'delo-archive-spec',
    exportedAt: '2026-01-01T00:00:00Z',
    origin: origin(),
    workspaces: [workspace()],
    entries: [
      { path: 'customisation.json', sha256: CUSTOMISATION_DIGEST, size: 2, kind: 'customisation' },
      entry(),
    ],
    ...overrides,
  }
  return utf8(JSON.stringify(document))
}

describe('a well-formed manifest', () => {
  it('parses into its origin, entries and workspaces', () => {
    const parsed = parseManifest(manifest())

    expect(parsed.origin.homeKeyId).toBe(keyFingerprint(Buffer.alloc(32, 7).toString('base64url')))
    expect(parsed.entries.map(item => item.path)).toEqual(['customisation.json', OBJECT_PATH])
    expect(parsed.workspaces).toEqual([{ id: 'ws-1', name: 'Project', chats: [OBJECT_PATH], attachments: [], objects: [] }])
  })

  it('accepts a fractional-second export time and a +00:00 offset', () => {
    expect(parseManifest(manifest({ exportedAt: '2026-01-01T00:00:00.250+00:00' })).exportedAt).toBe('2026-01-01T00:00:00.250+00:00')
  })
})

describe('a manifest document', () => {
  it.each([
    ['text that is not UTF-8', new Uint8Array([0xff, 0xfe])],
    ['text that is not JSON', utf8('not json')],
    ['a JSON array', utf8('[]')],
    ['JSON null', utf8('null')],
  ])('is refused as %s', (_name, bytes) => {
    expect(refusal(() => parseManifest(bytes)).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it('is refused when it carries a field the format does not define', () => {
    const error = refusal(() => parseManifest(manifest({ extra: true })))

    expect(error.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(error.message).toContain('"extra"')
  })

  it('is refused when a defined field is missing', () => {
    const error = refusal(() => parseManifest(manifest({ entries: undefined })))

    expect(error.code).toBe('ARCHIVE_SCHEMA_INVALID')
    expect(error.message).toContain('"entries"')
  })

  it('is refused when it declares another format version', () => {
    expect(refusal(() => parseManifest(manifest({ formatVersion: 2 }))).code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
  })

  it.each([
    ['an empty creator', { createdBy: '' }],
    ['a creator that is not text', { createdBy: 7 }],
    ['an export time that is not RFC 3339', { exportedAt: '2026-01-01' }],
    ['an export time in another zone', { exportedAt: '2026-01-01T00:00:00+02:00' }],
    ['an export time that names no real date', { exportedAt: '2026-13-45T00:00:00Z' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(refusal(() => parseManifest(manifest(overrides))).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })
})

describe('a manifest origin', () => {
  it.each([
    ['is not an object', 'home-key'],
    ['carries a field the format does not define', origin({ extra: 1 })],
    ['has an empty key identifier', origin({ homeKeyId: '' })],
    ['has a key identifier that is not base64url', origin({ homeKeyId: 'home key' })],
    ['has a public key that is not base64url', origin({ publicKey: 'not base64url!' })],
    ['has a public key that is not 32 bytes', origin({ publicKey: Buffer.alloc(31, 7).toString('base64url') })],
    ['has a key identifier that is not its key\'s fingerprint', origin({ homeKeyId: 'home-key' })],
  ])('is refused when it %s', (_name, value) => {
    expect(refusal(() => parseManifest(manifest({ origin: value }))).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })
})

describe('a manifest entry', () => {
  it.each([
    ['is not an object', 7],
    ['carries a field the format does not define', entry({ extra: 1 })],
    ['has a digest that is not lowercase SHA-256', entry({ sha256: 'AB'.repeat(32) })],
    ['has a negative size', entry({ size: -1 })],
    ['has a fractional size', entry({ size: 1.5 })],
    ['has a size that is not a number', entry({ size: '3' })],
    ['has an unknown kind', entry({ kind: 'script' })],
    ['has a kind that is not text', entry({ kind: 3 })],
    ['is a customisation entry at another path', entry({ kind: 'customisation', path: OBJECT_PATH })],
    ['is an object entry not named by its own digest', entry({ path: `objects/${'ef'.repeat(32)}` })],
  ])('is refused when it %s', (_name, value) => {
    const error = refusal(() => parseManifest(manifest({ entries: [value] })))

    expect(error.code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it('is refused when the entry list is not an array', () => {
    expect(refusal(() => parseManifest(manifest({ entries: {} }))).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })
})

describe('a manifest workspace', () => {
  it.each([
    ['is not an object', 'ws-1'],
    ['carries a field the format does not define', workspace({ extra: 1 })],
    ['has an empty name', workspace({ name: '' })],
    ['lists chats as something other than an array', workspace({ chats: OBJECT_PATH })],
    ['refers to a chat the manifest does not list', workspace({ chats: [`objects/${'ef'.repeat(32)}`] })],
    ['refers to an attachment the manifest does not list', workspace({ attachments: ['objects/missing'] })],
    ['refers to an object that is not text', workspace({ objects: [7] })],
  ])('is refused when it %s', (_name, value) => {
    expect(refusal(() => parseManifest(manifest({ workspaces: [value] }))).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it('is refused when the workspace list is not an array', () => {
    expect(refusal(() => parseManifest(manifest({ workspaces: {} }))).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it.each([
    ['a parent segment', '..'],
    ['an absolute path', '/etc'],
    ['a backslash', 'a\\b'],
  ])('is refused when its identifier is %s', (_name, id) => {
    expect(refusal(() => parseManifest(manifest({ workspaces: [workspace({ id })] }))).code).toBe('ARCHIVE_PATH_REJECTED')
  })

  it('is refused when its identifier is more than one path segment', () => {
    const error = refusal(() => parseManifest(manifest({ workspaces: [workspace({ id: 'a/b' })] })))

    expect(error.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(error.message).toContain('not one path segment')
  })

  it('is refused when two workspaces repeat one identifier', () => {
    const error = refusal(() => parseManifest(manifest({ workspaces: [workspace(), workspace()] })))

    expect(error.code).toBe('ARCHIVE_PATH_REJECTED')
    expect(error.message).toContain('twice')
  })

  it('is refused when two workspace identifiers differ only in letter case', () => {
    const error = refusal(() => parseManifest(manifest({ workspaces: [workspace({ id: 'Alpha' }), workspace({ id: 'alpha' })] })))

    expect(error.code).toBe('ARCHIVE_CASE_COLLISION')
  })
})
