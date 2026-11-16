/**
 * Packs (`delorun.release-packs/1`): a signed packs file verifies against its release's manifest, a pack archive
 * extracts only when it matches the signed file list, and an external npm package extracts only when its bytes match
 * the signed SHA-512. Each refusal leaves the destination empty.
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_SCHEMAS, type PackExternal, type Sha512Base64 } from '@delorun/contract-release-manifest'
import { semanticVersion, sha256Hex } from '@delorun/release-formats/brands'
import { gzip } from '@delorun/release-formats/archive/bytes'
import { tarStream } from '@delorun/release-formats/archive/tar'
import { buildPackArchive, extractExternal, extractPack, PackRefusal } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { verifyPacks, trustRootChain, verifySignedManifest } from '@delorun/release-formats/sign/verify'
import { brandString } from '@deepseek-ai/dsh-brand'
import { manifestContent, rootFile, throwawayKeys } from '../sign/fixture.ts'
import { signPacks } from '../../src/sign/packs.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'delorun-packs-')); roots.push(root); return root }
const EPOCH = 1_800_000_000

const entry = (path: string, text: string, mode: '0644' | '0755' = '0644') => ({ path, mode, data: Buffer.from(text) })
const envelope = (signed: object, keys: Parameters<typeof signEnvelope>[1]): Buffer => Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, keys), undefined, 2)}\n`)

async function npmTarball(files: Readonly<Record<string, string>>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, text]) => entry(`package/${path}`, text))
  for await (const chunk of gzip(tarStream(entries, EPOCH))) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function pin(bytes: Buffer, overrides: Partial<PackExternal> = {}): PackExternal {
  return {
    name: '@openai/codex-linux-x64',
    version: semanticVersion('0.153.4'),
    url: 'https://registry.npmjs.org/@openai/codex-linux-x64/-/codex-linux-x64-0.153.4.tgz',
    sha512: brandString<Sha512Base64>(createHash('sha512').update(bytes).digest('base64')),
    length: bytes.byteLength,
    ...overrides,
  }
}

describe('a pack archive', () => {
  it('extracts to exactly the signed files, with the signed modes', async () => {
    const built = await buildPackArchive('delorun-0.1.0-pack-demo.tar.gz', [entry('package.json', '{"name":"demo"}'), entry('lib/index.js', 'export {}\n'), entry('bin/run', '#!/bin/sh\n', '0755')], EPOCH)
    const out = temp()
    await extractPack(built.bytes, built.variant, out)
    expect(readFileSync(join(out, 'lib/index.js'), 'utf8')).toBe('export {}\n')
    expect(readdirSync(join(out, 'bin'))).toEqual(['run'])
  })

  it('is refused, with nothing trusted, when one byte of the archive changes', async () => {
    const built = await buildPackArchive('p.tar.gz', [entry('package.json', '{}')], EPOCH)
    const tampered = Buffer.from(built.bytes)
    tampered[tampered.length - 9] = tampered[tampered.length - 9]! ^ 1
    const out = temp()
    await expect(extractPack(tampered, built.variant, out)).rejects.toBeInstanceOf(PackRefusal)
    expect(readdirSync(out)).toEqual([])
  })

  it('is refused when it holds a file the signed list does not, or lacks a listed one', async () => {
    const built = await buildPackArchive('p.tar.gz', [entry('package.json', '{}'), entry('extra.js', 'x')], EPOCH)
    const listed = { ...built.variant, files: built.variant.files.filter(file => file.path !== 'extra.js') }
    await expect(extractPack(built.bytes, listed, temp())).rejects.toThrow(/does not/u)
    const missing = { ...built.variant, files: [...built.variant.files, { path: 'gone.js', length: 1, sha256: sha256Hex('0'.repeat(64)), mode: '0644' as const }] }
    await expect(extractPack(built.bytes, missing, temp())).rejects.toThrow(/lacks gone\.js/u)
  })
})

describe('an external npm package', () => {
  it('extracts without its package/ prefix when its bytes match the signed SHA-512', async () => {
    const tarball = await npmTarball({ 'package.json': '{"name":"x"}', 'bin/codex': 'binary' })
    const out = temp()
    await extractExternal(tarball, pin(tarball), out)
    expect(readFileSync(join(out, 'bin/codex'), 'utf8')).toBe('binary')
  })

  it('is refused when the registry serves other bytes than the signed ones', async () => {
    const real = await npmTarball({ 'package.json': '{}' })
    const forged = await npmTarball({ 'package.json': '{"evil":true}' })
    const out = temp()
    await expect(extractExternal(forged, pin(real), out)).rejects.toThrow(/bytes|SHA-512/u)
    await expect(extractExternal(forged, pin(forged, { sha512: pin(real).sha512 }), out)).rejects.toThrow(/SHA-512/u)
    expect(existsSync(join(out, 'package.json'))).toBe(false)
  })
})

describe('the packs file', () => {
  it('verifies under the release root against its own manifest, and not against another', () => {
    const keys = throwawayKeys()
    const root = trustRootChain([rootFile(keys).bytes], Date.parse('2026-11-06T12:00:00Z') / 1000).at(-1)!
    const manifestBytes = envelope(manifestContent('0.1.0', Buffer.from('a')), [keys.targets])
    const manifest = verifySignedManifest(root.metadata, manifestBytes)
    const signed = { schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: createHash('sha256').update(manifestBytes).digest('hex'), packs: [] }
    const bytes = envelope(signed, [keys.targets])
    expect(verifyPacks(root.metadata, manifest, manifestBytes, bytes).packs).toEqual([])
    const other = envelope(manifestContent('0.1.0', Buffer.from('b')), [keys.targets])
    expect(() => verifyPacks(root.metadata, manifest, other, bytes)).toThrow(/belongs to the manifest/u)
    const unsigned = envelope(signed, [generateKeyPairSync('ed25519').privateKey])
    expect(() => verifyPacks(root.metadata, manifest, manifestBytes, unsigned)).toThrow()
  })
})

describe('signing the packs file', () => {
  async function release() {
    const keys = throwawayKeys()
    const dir = temp()
    const built = await buildPackArchive('delorun-0.1.0-pack-demo.tar.gz', [entry('package.json', '{}')], EPOCH)
    writeFileSync(join(dir, built.variant.archive.name), built.bytes)
    const draft = { schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: '0'.repeat(64), packs: [{ name: 'demo', version: '1.0.0', experimental: true, peers: [], variants: { any: { ...built.variant, external: [] } } }] }
    writeFileSync(join(dir, 'delorun-0.1.0.packs.json'), envelope(draft, []))
    return { keys, dir, built }
  }

  it('binds the file to the manifest, signs it with the targets key and writes a log entry request', async () => {
    const { keys, dir } = await release()
    const manifestBytes = envelope(manifestContent('0.1.0', Buffer.from('a')), [keys.targets])
    const outputs = await signPacks(dir, '0.1.0', manifestBytes, keys.targets)
    expect(outputs.map(([name]) => name)).toEqual(['delorun-0.1.0.packs.json', 'delorun-0.1.0.packs.entry.json'])
    const root = trustRootChain([rootFile(keys).bytes], Date.parse('2026-11-06T12:00:00Z') / 1000).at(-1)!
    const manifest = verifySignedManifest(root.metadata, manifestBytes)
    expect(verifyPacks(root.metadata, manifest, manifestBytes, outputs[0]![1] as Buffer).packs.map(pack => pack.name)).toEqual(['demo'])
  })

  it('writes nothing for a release with no packs file, and refuses an archive that differs from the file', async () => {
    const { keys, dir, built } = await release()
    expect(await signPacks(temp(), '0.1.0', Buffer.from('m'), keys.targets)).toEqual([])
    writeFileSync(join(dir, built.variant.archive.name), Buffer.concat([built.bytes, Buffer.from('x')]))
    await expect(signPacks(dir, '0.1.0', Buffer.from('m'), keys.targets)).rejects.toThrow(/does not match the packs file/u)
  })
})
