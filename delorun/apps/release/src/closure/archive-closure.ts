/**
 * Turns one staged closure tree into its release files: the deterministic archive and its runtime file list (contract
 * C2). The archive is written under a temporary name and renamed only after the native-code check passes, so a
 * refused closure leaves no release file behind.
 *
 * @module @delorun/release/closure/archive-closure
 */
import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileRef, RuntimePlatform } from '@delorun/contract-release-manifest'
import { drain, gzip } from '@delorun/release-formats/archive/bytes'
import { archiveFormat, MAX_ARCHIVE_BYTES, type ArchiveEntry } from '@delorun/release-formats/archive/entry'
import { FileSink, fileDigest } from '@delorun/release-formats/archive/sink'
import { tarStream } from '@delorun/release-formats/archive/tar'
import { zipStream } from '@delorun/release-formats/archive/zip'
import { sha256Hex } from '@delorun/release-formats/brands'
import { missingLaunchFiles } from './launch.ts'
import { isNativeCode, nativePinProblems, NODE_DIRECTORY } from './native.ts'
import { closureFileNames, listStagedTree, runtimeFileList, unsignedEnvelopeText, type ListedEntry } from './tree.ts'

/** What archiving a closure needs. */
export interface ClosureArchiveRequest {
  /** The staged tree's root. */
  readonly stage: string
  /** The directory the release files go to; existing files are never replaced. */
  readonly outDir: string
  /** The release version. */
  readonly version: string
  /** The closure's platform. */
  readonly platform: RuntimePlatform
  /** The release's `SOURCE_DATE_EPOCH`, every entry's mtime. */
  readonly epoch: number
  /** The platform's native-file pins; `undefined` records the native files without checking them. */
  readonly pins: Readonly<Record<string, string>> | undefined
  /** Whether to refuse a tree without launch protocol 1's files; a release build sets it. */
  readonly requireLaunchFiles?: boolean
}

/** The release files of one closure. */
export interface ClosureFiles {
  /** The archive. */
  readonly archive: FileRef
  /** The unsigned runtime file list. */
  readonly files: FileRef
  /** Path to SHA-256 of every native file outside the Node distribution. */
  readonly native: ReadonlyMap<string, string>
  /** How many files the archive holds. */
  readonly entries: number
}

function digest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Archive a staged closure and write its file list.
 * @param request - the tree, the destination and the release facts.
 * @returns the two release files and the native files found.
 * @throws Error when the tree holds anything an archive cannot, lacks launch protocol 1's files when they are required,
 * the native files disagree with the pins, the archive exceeds 1 GiB, or a release file already exists.
 */
export async function archiveClosure(request: ClosureArchiveRequest): Promise<ClosureFiles> {
  const names = closureFileNames(request.version, request.platform)
  const staged = await listStagedTree(request.stage, request.platform)
  if (request.requireLaunchFiles === true) {
    const missing = missingLaunchFiles(staged.map(file => file.path), request.platform)
    if (missing.length > 0) throw new Error(`the ${request.platform} closure lacks ${missing.join(' and ')}, which the launcher starts the runtime with (contract C1, launch protocol 1)`)
  }
  const listed: ListedEntry[] = []
  const native = new Map<string, string>()
  async function* entries(): AsyncGenerator<ArchiveEntry> {
    for (const file of staged) {
      const data = await readFile(file.absolute)
      const sha256 = digest(data)
      listed.push({ path: file.path, mode: file.mode, length: data.byteLength, sha256 })
      if (!file.path.startsWith(`${NODE_DIRECTORY}/`) && isNativeCode(data)) native.set(file.path, sha256)
      yield { path: file.path, mode: file.mode, data }
    }
  }
  const partial = join(request.outDir, `${names.archive}.partial`)
  const sink = await FileSink.create(partial, MAX_ARCHIVE_BYTES)
  try {
    try {
      const encoded = entries()
      await drain(archiveFormat(request.platform) === 'zip' ? zipStream(encoded, request.epoch) : gzip(tarStream(encoded, request.epoch)), sink)
    } finally {
      await sink.close()
    }
    if (request.pins !== undefined) {
      const problems = nativePinProblems(native, request.pins)
      if (problems.length > 0) throw new Error(`the ${request.platform} closure's native files disagree with prebuilt-pins.json:\n${problems.join('\n')}`)
    }
    const archive = await fileDigest(partial)
    const listText = unsignedEnvelopeText(runtimeFileList(request.version, request.platform, listed))
    await writeFile(join(request.outDir, names.files), listText, { flag: 'wx', mode: 0o644 })
    await rename(partial, join(request.outDir, names.archive))
    return {
      archive: { name: names.archive, length: archive.length, sha256: sha256Hex(archive.sha256) },
      files: { name: names.files, length: Buffer.byteLength(listText), sha256: sha256Hex(digest(listText)) },
      native,
      entries: listed.length,
    }
  } finally {
    await rm(partial, { force: true })
  }
}
