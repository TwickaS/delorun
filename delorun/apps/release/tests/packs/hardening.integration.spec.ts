/**
 * Pack names, lengths and archive entries are checked where the signed packs file and the archive are read: an npm-style
 * name, capped lengths, and entries that are regular files at listed, normal, unique paths.
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { PACK_DOWNLOAD_MAX_BYTES, RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { buildPackArchive, extractPack, joinInside, PackRefusal } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain, VerificationError, verifyPacks } from '@delorun/release-formats/sign/verify'
import { manifestContent, rootFile, throwawayKeys } from '../sign/fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'delorun-packs-hard-')); roots.push(root); return root }
const EPOCH = 1_800_000_000
const file = (path: string, text: string, mode: '0644' | '0755' = '0644') => ({ path, mode, data: Buffer.from(text) })
const envelope = (signed: object, keys: Parameters<typeof signEnvelope>[1]): Buffer => Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, keys), undefined, 2)}\n`)

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const variant = (over: { peers?: string[], length?: number, externalLength?: number, externalName?: string } = {}) => ({
  archive: { name: 'a.tar.gz', length: over.length ?? 10, sha256: '0'.repeat(64), sha512: 'x'.repeat(86) + '==' },
  files: [],
  peers: over.peers ?? [],
  external: over.externalName === undefined ? [] : [{ name: over.externalName, version: '1.0.0', url: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', sha512: 'x'.repeat(86) + '==', length: over.externalLength ?? 10 }],
})
const packsBytes = (name: string, v: object): Buffer => envelope({ schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: '0'.repeat(64), packs: [{ name, version: '1.0.0', experimental: false, variants: { any: v } }] }, [])

describe('names and lengths in the signed packs file', () => {
  it('accepts an ordinary and a scoped npm name', () => {
    expect(readEnvelope('packs', packsBytes('@delorun/demo', variant({ peers: ['zod', '@deepseek-ai/dsh-core'] }))).signed.packs[0]!.name).toBe('@delorun/demo')
  })

  it.each(['../evil', '/etc/passwd', '@a/../b', 'Up', 'a b', '', '.', '@scope', 'a/b', '..'])('refuses the pack name %j', (name) => {
    expect(() => readEnvelope('packs', packsBytes(name, variant()))).toThrow(/packs file/u)
  })

  it.each(['..', '/abs', '../x', '@a/../b', 'x\\y'])('refuses the peer or external name %j', (name) => {
    expect(() => readEnvelope('packs', packsBytes('demo', variant({ peers: [name] })))).toThrow(/packs file/u)
    expect(() => readEnvelope('packs', packsBytes('demo', variant({ externalName: name })))).toThrow(/packs file/u)
  })

  it('refuses an archive or an external longer than the cap', () => {
    expect(() => readEnvelope('packs', packsBytes('demo', variant({ length: PACK_DOWNLOAD_MAX_BYTES + 1 })))).toThrow(/packs file/u)
    expect(() => readEnvelope('packs', packsBytes('demo', variant({ externalName: 'native', externalLength: PACK_DOWNLOAD_MAX_BYTES + 1 })))).toThrow(/packs file/u)
    expect(readEnvelope('packs', packsBytes('demo', variant({ length: PACK_DOWNLOAD_MAX_BYTES }))).signed.packs).toHaveLength(1)
  })

  it('joins only plain segments', () => {
    expect(joinInside('/base', '@a', 'b')).toBe('/base/@a/b')
    for (const bad of ['..', '.', '', '/abs', 'a/b']) expect(() => joinInside('/base', bad)).toThrow(PackRefusal)
  })
})

describe('verifying a packs file', () => {
  it('refuses a file signed for an older release and one that is not signed, with a typed error', () => {
    const keys = throwawayKeys()
    const root = trustRootChain([rootFile(keys).bytes], Date.parse('2026-11-06T12:00:00Z') / 1000).at(-1)!
    const manifestBytes = envelope(manifestContent('0.1.0', Buffer.from('a')), [keys.targets])
    const digest = createHash('sha256').update(manifestBytes).digest('hex')
    const older = envelope({ schema: RELEASE_SCHEMAS.packs, version: '0.0.9', manifest: digest, packs: [] }, [keys.targets])
    expect(() => verifyPacks(root.metadata, manifestBytes, older)).toThrow(/is for 0\.0\.9, not 0\.1\.0/u)
    const unsigned = envelope({ schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: digest, packs: [] }, [generateKeyPairSync('ed25519').privateKey])
    expect(() => verifyPacks(root.metadata, manifestBytes, unsigned)).toThrow(VerificationError)
  })
})

/** A tar entry written by hand, so an entry the deterministic writer would never produce can be tested. */
function rawTar(entries: readonly { name: string, type?: string, body?: string, mode?: number }[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const block = Buffer.alloc(512)
    block.write(entry.name, 0, 'ascii')
    block.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 'ascii')
    block.write('0000000\0', 108, 'ascii')
    block.write('0000000\0', 116, 'ascii')
    block.write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    block.write(`${EPOCH.toString(8).padStart(11, '0')}\0`, 136, 'ascii')
    block.write('        ', 148, 'ascii')
    block.write(entry.type ?? '0', 156, 'ascii')
    block.write('ustar\u000000', 257, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(block, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function variantFor(bytes: Buffer, files: { path: string, text: string, mode?: '0644' | '0755' }[]) {
  return {
    archive: { name: 'a.tar.gz', length: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') as never, sha512: createHash('sha512').update(bytes).digest('base64') as never },
    files: files.map(each => ({ path: each.path, length: each.text.length, sha256: sha(each.text) as never, mode: each.mode ?? '0644' })),
  }
}

describe('extracting a pack archive', () => {
  async function refused(bytes: Buffer, files: Parameters<typeof variantFor>[1], code: string): Promise<void> {
    const root = temp()
    await expect(extractPack(bytes, variantFor(bytes, files), root)).rejects.toMatchObject({ name: 'PackRefusal', code })
  }

  it('refuses a path that leaves the directory, an absolute path and a backslash path', async () => {
    for (const name of ['../evil', '/abs/evil', 'a\\b', 'a/../../b']) await refused(rawTar([{ name, body: 'x' }]), [{ path: name, text: 'x' }], 'UNSAFE_PATH')
  })

  it('refuses a symbolic link or hard link entry even when the file list names it', async () => {
    for (const type of ['2', '1']) await refused(rawTar([{ name: 'link', type }]), [{ path: 'link', text: '' }], 'BAD_ARCHIVE')
  })

  it('refuses a path that appears twice', async () => {
    await refused(rawTar([{ name: 'a', body: 'x' }, { name: 'a', body: 'x' }]), [{ path: 'a', text: 'x' }], 'UNLISTED_FILE')
  })

  it('refuses a mode other than the signed one, and a file the list does not name', async () => {
    await refused(rawTar([{ name: 'a', body: 'x', mode: 0o755 }]), [{ path: 'a', text: 'x', mode: '0644' }], 'MODE_MISMATCH')
    await refused(rawTar([{ name: 'a', body: 'x' }, { name: 'b', body: 'x' }]), [{ path: 'a', text: 'x' }], 'UNLISTED_FILE')
  })

  it('refuses bytes that are not an archive, with a typed code', async () => {
    await refused(Buffer.from('not gzip at all'), [], 'BAD_ARCHIVE')
  })

  it('writes an honest archive and refuses a listed file the archive lacks', async () => {
    const built = await buildPackArchive('a.tar.gz', [file('a', 'x'), file('b', 'y')], EPOCH)
    const root = temp()
    await extractPack(built.bytes, built.variant, root)
    expect(readdirSync(root).sort()).toEqual(['a', 'b'])
    const missing = await buildPackArchive('a.tar.gz', [file('a', 'x')], EPOCH)
    await expect(extractPack(missing.bytes, { archive: missing.variant.archive, files: built.variant.files }, temp())).rejects.toMatchObject({ code: 'MISSING_FILE' })
  })
})

describe('log-release --kind', () => {
  it('accepts manifest and packs and refuses anything else', async () => {
    const { logKind } = await import('../../src/log-release.ts')
    expect(logKind(undefined)).toBe('manifest')
    expect(logKind('packs')).toBe('packs')
    expect(() => logKind('pack')).toThrow(/use manifest or packs/u)
  })
})
