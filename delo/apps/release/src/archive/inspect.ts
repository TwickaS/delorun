/**
 * Inspects a runtime archive in one streaming pass: it reads every entry, records each entry's mode, length and
 * SHA-256 (and, for a PE file, the SHA-256 without its Authenticode signature), and re-encodes the entries with the
 * deterministic writer. The archive is canonical when the re-encoding reproduces its bytes exactly, so every header
 * field, the entry order, the compression and the gzip framing are those the writer produces.
 *
 * @module @delo/release/archive/inspect
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import type { RuntimeFileMode } from '@delo/contract-release-manifest'
import { stripAuthenticode } from '../rebuild/pe.ts'
import { drain, gzip } from './bytes.ts'
import { MAX_ARCHIVE_BYTES, type ArchiveEntry, type ArchiveFormat } from './entry.ts'
import { fileDigest, HashSink } from './sink.ts'
import { readTar, runtimeMode, tarStream } from './tar.ts'
import { readZip, zipStream } from './zip.ts'

/** One entry of an inspected archive. */
export interface EntrySummary {
  /** The entry path. */
  readonly path: string
  /** The entry's mode. */
  readonly mode: RuntimeFileMode
  /** Length in bytes. */
  readonly length: number
  /** SHA-256 of the bytes. */
  readonly sha256: string
  /** For a PE file, SHA-256 of the bytes without the Authenticode signature and checksum. */
  readonly peSha256?: string
}

/** What one inspection found. */
export interface ArchiveSummary {
  /** The archive's length in bytes. */
  readonly length: number
  /** SHA-256 of the archive's bytes. */
  readonly sha256: string
  /** The entries in archive order. */
  readonly entries: readonly EntrySummary[]
  /** The entries' common mtime in seconds; absent for an archive without entries or with a refusal. */
  readonly mtime?: number
  /** Why the archive is not canonical, or nothing when it is. */
  readonly problem?: string
}

/** One entry as an archive holds it. */
export interface RawEntry {
  readonly path: string
  readonly mode: number
  readonly mtime: number
  readonly owner: boolean
  readonly data: Buffer
}

/**
 * Read an archive's entries with their bytes, in archive order, refusing anything but regular files.
 * @param path - the archive file.
 * @param format - its format.
 * @returns each entry's path, mode bits, mtime, whether its owner fields are empty and 0, and its bytes.
 */
export async function* archiveEntries(path: string, format: ArchiveFormat): AsyncGenerator<RawEntry> {
  if (format === 'zip') {
    for await (const entry of readZip(path, MAX_ARCHIVE_BYTES)) yield { ...entry, owner: true }
    return
  }
  const gunzip = createGunzip()
  const input = createReadStream(path)
  input.once('error', error => gunzip.destroy(error))
  input.pipe(gunzip)
  try {
    for await (const entry of readTar(gunzip as AsyncIterable<Buffer>, MAX_ARCHIVE_BYTES)) {
      yield { ...entry, owner: entry.uid === 0 && entry.gid === 0 && entry.uname === '' && entry.gname === '' }
    }
  } finally {
    input.destroy()
    gunzip.destroy()
  }
}

/**
 * Inspect one runtime archive.
 * @param path - the archive file.
 * @param format - its format.
 * @returns the entries and whether the archive is canonical; a malformed archive yields a `problem` and the entries
 * read before it.
 */
export async function inspectArchive(path: string, format: ArchiveFormat): Promise<ArchiveSummary> {
  const { size } = await stat(path)
  if (size > MAX_ARCHIVE_BYTES) return { ...(await fileDigest(path)), entries: [], problem: `the archive exceeds ${String(MAX_ARCHIVE_BYTES)} bytes` }
  const file = await fileDigest(path)
  const entries: EntrySummary[] = []
  let mtime: number | undefined
  let problem: string | undefined
  const source = archiveEntries(path, format)
  async function* checked(first: RawEntry): AsyncGenerator<ArchiveEntry> {
    for (let entry: RawEntry | undefined = first; entry !== undefined;) {
      const mode = runtimeMode(entry.mode)
      if (mode === undefined) throw new Error(`entry ${entry.path} has mode ${entry.mode.toString(8)}, not 0644 or 0755`)
      if (!entry.owner) throw new Error(`entry ${entry.path} has an owner or group other than 0 with an empty name`)
      if (entry.mtime !== mtime) throw new Error(`entry ${entry.path} has mtime ${String(entry.mtime)}, not ${String(mtime)}`)
      const pe = stripAuthenticode(entry.data)
      entries.push({
        path: entry.path,
        mode,
        length: entry.data.byteLength,
        sha256: createHash('sha256').update(entry.data).digest('hex'),
        ...(pe === undefined ? {} : { peSha256: createHash('sha256').update(pe).digest('hex') }),
      })
      yield { path: entry.path, mode, data: entry.data }
      const next = await source.next()
      entry = next.done === true ? undefined : next.value
    }
  }
  const sink = new HashSink()
  try {
    const first = await source.next()
    mtime = first.done === true ? 0 : first.value.mtime
    const encoded = first.done === true ? [] : checked(first.value)
    await drain(format === 'zip' ? zipStream(encoded, mtime) : gzip(tarStream(encoded, mtime)), sink)
    if (sink.digest() !== file.sha256 || sink.length !== file.length) problem = 'the archive is not in the deterministic form: re-encoding its entries does not reproduce its bytes'
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
  } finally {
    await source.return(undefined)
  }
  return { ...file, entries, ...(mtime === undefined || problem !== undefined ? {} : { mtime }), ...(problem === undefined ? {} : { problem }) }
}
