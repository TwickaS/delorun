/**
 * Pack archives (the `delorun.release-packs/1` document's files): the deterministic builder the release recipe runs
 * and the verifying extractor the runtime store runs. Both sides use the runtime archive's tar writer and reader, so a
 * pack has the same entry rules as a runtime closure: regular files only, byte-wise path order, mode `0644` or
 * `0755`, a fixed mtime.
 *
 * @module @delorun/release-formats/packs/archive
 */
import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, sep } from 'node:path'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import type { PackExternal, PackFile, PackVariant, Sha256Hex, Sha512Base64 } from '@delorun/contract-release-manifest'
import { sha256Hex } from '../brands.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { gzip } from '../archive/bytes.ts'
import { compareEntryPaths, type ArchiveEntry } from '../archive/entry.ts'
import { readTar, runtimeMode, tarStream } from '../archive/tar.ts'

/** The most one pack file may hold, 512 MiB. */
const MAX_PACK_ENTRY_BYTES = 512 * 1024 * 1024

/** Why a pack or an external package was refused. */
export type PackRefusalCode =
  | 'SIZE_MISMATCH' | 'DIGEST_MISMATCH' | 'UNLISTED_FILE' | 'MODE_MISMATCH' | 'CONTENT_MISMATCH' | 'MISSING_FILE'
  | 'UNSAFE_PATH' | 'BAD_ARCHIVE' | 'NOT_PUBLISHED' | 'PEER_MISSING' | 'NO_SUCH_PACK' | 'NOT_ON_CHANNEL'
  | 'PACKS_FILE_REFUSED' | 'FETCH_REFUSED' | 'INSTALLED_PACK_CHANGED' | 'FILE_ERROR'

/** A pack or an external package that is refused; `code` says why, `cause` carries a wrapped file error. */
export class PackRefusal extends Error {
  /** Why the refusal happened. */
  readonly code: PackRefusalCode

  /**
   * @param message - what was refused and what the signed file lists.
   * @param code - the reason.
   * @param options - the wrapped error, when a file operation failed.
   */
  constructor(message: string, code: PackRefusalCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PackRefusal'
    this.code = code
  }
}

function sha512Base64(bytes: Uint8Array): Sha512Base64 {
  return brandString<Sha512Base64>(createHash('sha512').update(bytes).digest('base64'))
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * Archive pack files deterministically.
 * @param name - the archive file name to record.
 * @param entries - the package files, relative to the package root, `/`-separated.
 * @param epoch - the release's `SOURCE_DATE_EPOCH`, every entry's mtime.
 * @returns the archive's bytes and the variant fields describing it (without external packages).
 */
export async function buildPackArchive(name: string, entries: readonly ArchiveEntry[], epoch: number): Promise<{ bytes: Buffer, variant: Omit<PackVariant, 'external' | 'peers'> }> {
  const ordered = [...entries].sort((a, b) => compareEntryPaths(a.path, b.path))
  const bytes = await collect(gzip(tarStream(ordered, epoch)))
  const files: PackFile[] = ordered.map(entry => ({ path: entry.path, length: entry.data.byteLength, sha256: sha256Hex(createHash('sha256').update(entry.data).digest('hex')), mode: entry.mode }))
  return { bytes, variant: { archive: { name, length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')), sha512: sha512Base64(bytes) }, files } }
}

function safeRelative(path: string): string {
  const normal = posix.normalize(path)
  if (path.startsWith('/') || path.includes('\\') || normal !== path || normal.split('/').includes('..') || normal === '.') throw new PackRefusal(`pack entry ${JSON.stringify(path)} is not a normal relative path`, 'UNSAFE_PATH')
  return normal
}

/**
 * Join path segments below a base, refusing any segment that could leave it.
 * @param base - the directory.
 * @param segments - the segments to append, such as a package name's parts.
 * @returns the joined path.
 * @throws PackRefusal `UNSAFE_PATH` when a segment is empty, `.`, `..`, absolute or holds a separator.
 */
export function joinInside(base: string, ...segments: readonly string[]): string {
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || isAbsolute(segment) || segment.includes('\\') || segment.includes('/')) throw new PackRefusal(`${JSON.stringify(segment)} is not a path segment inside the pack`, 'UNSAFE_PATH')
  }
  return join(base, ...segments)
}

async function write(root: string, path: string, data: Buffer, mode: number): Promise<void> {
  const target = join(root, ...path.split('/'))
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const real = await realpath(dirname(target))
    const base = await realpath(root)
    if (real !== base && !real.startsWith(base + sep)) throw new PackRefusal(`${path} resolves outside the pack`, 'UNSAFE_PATH')
    await writeFile(target, data, { flag: 'wx', mode })
  } catch (error) {
    if (error instanceof PackRefusal) throw error
    throw new PackRefusal(`${path} could not be written: ${(error as Error).message}`, 'FILE_ERROR', { cause: error })
  }
}

/** Read a tar stream, turning a malformed archive into a refusal. */
async function* entriesOf(bytes: Uint8Array, name: string): AsyncGenerator<Awaited<ReturnType<typeof readTar>> extends AsyncIterable<infer E> ? E : never> {
  try {
    yield* readTar(Readable.from(Buffer.from(bytes)).pipe(createGunzip()) as AsyncIterable<Buffer>, MAX_PACK_ENTRY_BYTES)
  } catch (error) {
    if (error instanceof PackRefusal) throw error
    throw new PackRefusal(`${name} is not a valid archive: ${(error as Error).message}`, 'BAD_ARCHIVE', { cause: error })
  }
}

/**
 * Check a pack archive against its signed variant and write its files below `root`.
 * @param bytes - the downloaded archive.
 * @param variant - the signed variant that names it.
 * @param root - an empty directory.
 * @throws PackRefusal when the length or a digest differs, an entry is not in the signed file list or differs from
 * it, a listed file is missing, or an entry path escapes `root`; nothing is trusted before the digests match.
 */
export async function extractPack(bytes: Uint8Array, variant: Pick<PackVariant, 'archive' | 'files'>, root: string): Promise<void> {
  if (bytes.byteLength !== variant.archive.length) throw new PackRefusal(`${variant.archive.name} has ${String(bytes.byteLength)} bytes; the signed packs file lists ${String(variant.archive.length)}`, 'SIZE_MISMATCH')
  if (createHash('sha256').update(bytes).digest('hex') !== variant.archive.sha256) throw new PackRefusal(`${variant.archive.name} does not match its signed SHA-256`, 'DIGEST_MISMATCH')
  if (sha512Base64(bytes) !== variant.archive.sha512) throw new PackRefusal(`${variant.archive.name} does not match its signed SHA-512`, 'DIGEST_MISMATCH')
  const listed = new Map(variant.files.map(file => [file.path, file]))
  const seen = new Set<string>()
  for await (const entry of entriesOf(bytes, variant.archive.name)) {
    const path = safeRelative(entry.path)
    const expected = listed.get(path)
    if (expected === undefined || seen.has(path)) throw new PackRefusal(`${variant.archive.name} holds ${path}, which the signed file list does not (or lists once)`, 'UNLISTED_FILE')
    if (runtimeMode(entry.mode) !== expected.mode) throw new PackRefusal(`${path} has another mode than the signed file list`, 'MODE_MISMATCH')
    if (entry.data.byteLength !== expected.length || createHash('sha256').update(entry.data).digest('hex') !== expected.sha256) throw new PackRefusal(`${path} differs from the signed file list`, 'CONTENT_MISMATCH')
    seen.add(path)
    await write(root, path, entry.data, expected.mode === '0755' ? 0o755 : 0o644)
  }
  const missing = [...listed.keys()].filter(path => !seen.has(path))
  if (missing.length > 0) throw new PackRefusal(`${variant.archive.name} lacks ${missing.slice(0, 3).join(', ')}`, 'MISSING_FILE')
}

/**
 * Check an npm tarball against its signed pin and write its files below `root`, dropping the tarball's `package/`
 * prefix.
 * @param bytes - the tarball fetched from the registry.
 * @param pin - the signed external dependency.
 * @param root - the directory to extract into, such as `node_modules/<name>`.
 * @throws PackRefusal when the length or SHA-512 differs from the signed pin, or an entry escapes `root`.
 */
export async function extractExternal(bytes: Uint8Array, pin: PackExternal, root: string): Promise<void> {
  if (bytes.byteLength !== pin.length) throw new PackRefusal(`${pin.name}@${pin.version} has ${String(bytes.byteLength)} bytes; the signed packs file lists ${String(pin.length)}`, 'SIZE_MISMATCH')
  if (sha512Base64(bytes) !== pin.sha512) throw new PackRefusal(`${pin.name}@${pin.version} does not match its signed SHA-512`, 'DIGEST_MISMATCH')
  for await (const entry of entriesOf(bytes, `${pin.name}@${pin.version}`)) {
    const relativePath = safeRelative(entry.path)
    if (!relativePath.startsWith('package/')) throw new PackRefusal(`${pin.name}@${pin.version} holds ${relativePath}, outside package/`, 'UNSAFE_PATH')
    await write(root, relativePath.slice('package/'.length), entry.data, entry.mode & 0o111 ? 0o755 : 0o644)
  }
}

/** The SHA-256 type, re-exported so callers digest with one brand. */
export type { Sha256Hex }
