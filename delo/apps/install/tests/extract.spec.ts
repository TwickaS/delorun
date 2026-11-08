/**
 * Extraction of a verified archive into the staging directory: every entry is checked against contract C1's path rules
 * and against the signed file list before it is written, so an entry the archive may not hold, an entry the list does
 * not name, a repeated path and a length or digest the list contradicts all stop the extraction, and nothing is
 * written outside the staging directory. The hostile archives are written by hand, because the release tooling refuses
 * to produce one.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RELEASE_SCHEMAS, type RuntimeFileList, type Sha256Hex, type SemanticVersion } from '@delo/contract-release-manifest'
import { gzip } from '@delo/release/archive/bytes'
import type { ArchiveEntry } from '@delo/release/archive/entry'
import { extractArchive, extractionPath } from '../src/extract.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { sha256, tarGz, VERSION } from './support.ts'

let directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  directories = []
})

/**
 * A new, empty directory a spec writes or extracts into.
 * @returns its path.
 */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-install-extract-'))
  directories.push(directory)
  return directory
}

/**
 * The signed file list of a set of entries, exactly as the release tooling writes it.
 * @param entries - the archive's entries.
 * @returns the list.
 */
function fileList(entries: readonly ArchiveEntry[]): RuntimeFileList {
  return {
    schema: RELEASE_SCHEMAS.files,
    version: brandString<SemanticVersion>(VERSION),
    platform: 'linux-x64',
    files: entries.map(entry => ({
      path: entry.path,
      length: entry.data.byteLength,
      sha256: brandString<Sha256Hex>(sha256(entry.data)),
      mode: entry.mode,
    })),
  }
}

/**
 * Write an archive to a file a spec extracts.
 * @param entries - the archive's entries.
 * @returns the archive's path.
 */
async function archiveOf(entries: readonly ArchiveEntry[]): Promise<string> {
  const path = join(await scratch(), 'runtime.tar.gz')
  await writeFile(path, await tarGz(entries))
  return path
}

/** One entry of a hand-written archive, which the release tooling would refuse to write. */
interface RawTarEntry {
  /** The header's `name` field, written as it is. */
  readonly path: string
  /** The header's `typeflag`. */
  readonly type: string
  /** The entry's bytes; the header's size is their length. */
  readonly data: Buffer
}

/**
 * A `.tar.gz` a spec writes by hand, with headers the release tooling never produces.
 * @param entries - the entries, in the order to write them.
 * @returns the archive's bytes.
 */
async function rawTarGz(entries: readonly RawTarEntry[]): Promise<Buffer> {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 100, 'utf8')
    header.write(`${entry.type === '5' ? '0755' : '0644'}\0`, 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${entry.data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.fill(' ', 148, 156)
    header.write(entry.type, 156, 'ascii')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(header, entry.data, Buffer.alloc((512 - (entry.data.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  const chunks: Buffer[] = []
  for await (const chunk of gzip(parts(blocks))) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/**
 * The hand-written blocks as one stream, which the compressor reads.
 * @param blocks - the blocks to stream.
 * @returns the stream.
 */
async function* parts(blocks: readonly Buffer[]): AsyncGenerator<Uint8Array> {
  for (const block of blocks) yield block
}

/**
 * Expect an extraction to refuse with a code.
 * @param extraction - the extraction.
 * @param code - the expected code.
 * @returns the refusal.
 */
async function refusal(extraction: Promise<unknown>, code: InstallError['code']): Promise<InstallError> {
  const error: unknown = await extraction.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return error as InstallError
}

/** The two files a good fixture archive holds. */
const ENTRIES: readonly ArchiveEntry[] = [
  { path: 'app/node_modules/@delo/cli/src/bin.js', mode: '0644', data: Buffer.from('// the runtime entry\n') },
  { path: 'node/bin/node', mode: '0755', data: Buffer.from('#!/bin/sh\nexit 0\n') },
]

describe('a verified archive', () => {
  it('writes exactly the files its signed list names, at the listed mode', async () => {
    const directory = await scratch()
    const extracted = await extractArchive({ archive: await archiveOf(ENTRIES), format: 'tar.gz', files: fileList(ENTRIES), directory })
    expect(extracted.written).toBe(ENTRIES.length)
    expect(await readFile(join(directory, 'node/bin/node'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(await readFile(join(directory, 'app/node_modules/@delo/cli/src/bin.js'), 'utf8')).toBe('// the runtime entry\n')
  })
})

describe('an archive the list does not describe', () => {
  it('refuses an entry its signed list does not name', async () => {
    const directory = await scratch()
    const error = await refusal(
      extractArchive({ archive: await archiveOf(ENTRIES), format: 'tar.gz', files: fileList(ENTRIES.slice(0, 1)), directory }),
      'ARCHIVE_REFUSED',
    )
    expect(error.detail).toContain('does not name')
    await expect(readFile(join(directory, 'node/bin/node'))).rejects.toThrow(/ENOENT/u)
  })

  it('refuses an entry whose bytes are not the length and SHA-256 the list signs', async () => {
    const directory = await scratch()
    const list = fileList(ENTRIES)
    const tampered: RuntimeFileList = {
      ...list,
      files: list.files.map(file => file.path === 'node/bin/node'
        ? { ...file, sha256: brandString<Sha256Hex>('0'.repeat(64)) }
        : file),
    }
    await refusal(extractArchive({ archive: await archiveOf(ENTRIES), format: 'tar.gz', files: tampered, directory }), 'INSTALL_VERIFY_FAILED')
  })

  it('refuses an archive that lacks a file its signed list names', async () => {
    const directory = await scratch()
    await refusal(
      extractArchive({ archive: await archiveOf(ENTRIES.slice(0, 1)), format: 'tar.gz', files: fileList(ENTRIES), directory }),
      'INSTALL_VERIFY_FAILED',
    )
  })
})

describe('an archive the format may not hold', () => {
  it('refuses an entry that is not a regular file', async () => {
    const directory = await scratch()
    const path = join(directory, 'runtime.tar.gz')
    await writeFile(path, await rawTarGz([{ path: 'node/bin/node', type: '2', data: Buffer.alloc(0) }]))
    const error = await refusal(
      extractArchive({ archive: path, format: 'tar.gz', files: fileList([{ path: 'node/bin/node', mode: '0755', data: Buffer.alloc(0) }]), directory }),
      'ARCHIVE_REFUSED',
    )
    expect(error.detail).toContain('cannot be read')
  })

  it('refuses an entry whose path leaves the staging directory', async () => {
    const directory = await scratch()
    const path = join(directory, 'runtime.tar.gz')
    const data = Buffer.from('x')
    await writeFile(path, await rawTarGz([{ path: '../outside', type: '0', data }]))
    const error = await refusal(
      extractArchive({ archive: path, format: 'tar.gz', files: fileList([{ path: '../outside', mode: '0644', data }]), directory }),
      'ARCHIVE_REFUSED',
    )
    expect(error.detail).toContain('..')
    await expect(readFile(join(directory, '..', 'outside'))).rejects.toThrow(/ENOENT/u)
  })
})

describe('a path outside the staging directory', () => {
  it('is refused before anything is written', () => {
    for (const path of ['../outside', '/etc/passwd', 'a/../../b', 'a//b', '..']) {
      expect(() => extractionPath('/tmp/staging/abc', path), path).toThrow(/ARCHIVE_REFUSED/u)
    }
  })

  it('is allowed when it stays inside', () => {
    expect(extractionPath('/tmp/staging/abc', 'node/bin/node')).toBe('/tmp/staging/abc/node/bin/node')
  })
})
