/**
 * Extraction of an archive of more files than the extraction writes at once: every file arrives whole at its installed
 * mode with the identity it has on disk, and a refusal of a late entry returns only after every write has ended, so the
 * caller's removal of the staging directory is not undone by a write still in flight.
 */
import { existsSync, lstatSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeFileList, Sha256Hex } from '@delorun/contract-release-manifest'
import type { ArchiveEntry } from '@delorun/release-formats/archive/entry'
import { identityOf } from '@delorun/runtime-store'
import { EXTRACT_WRITES, extractArchive } from '../src/extract.ts'
import { isInstallError } from '../src/errors.ts'
import { entryFileList as fileList, tarGz } from './support.ts'

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
  const directory = await mkdtemp(join(tmpdir(), 'delorun-install-extract-many-'))
  directories.push(directory)
  return directory
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

/**
 * Many entries, each in a directory of its own, more than the extraction writes at once.
 * @param count - how many.
 * @returns the entries in the byte-wise path order an archive holds them, each 64 KiB of its own bytes.
 */
function manyEntries(count: number): ArchiveEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `app/node_modules/pkg-${String(index)}/index.js`,
    mode: index % 7 === 0 ? '0755' as const : '0644' as const,
    data: Buffer.alloc(64 * 1024, index % 251),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
}

describe('an archive of many files', () => {
  it('tells how many files are written, each count once, ending on the whole list', async () => {
    const entries = manyEntries(EXTRACT_WRITES * 3)
    const counts: Array<readonly [number, number]> = []
    await extractArchive({ archive: await archiveOf(entries), format: 'tar.gz', files: fileList(entries), directory: await scratch(), onFile: (written, total) => { counts.push([written, total]) } })
    expect(counts).toHaveLength(entries.length)
    expect(counts.map(([written]) => written).sort((left, right) => left - right)).toEqual(entries.map((_, index) => index + 1))
    expect(new Set(counts.map(([, total]) => total))).toEqual(new Set([entries.length]))
  })

  it('writes every file whole, at its mode, with the identity it has on disk, when more files arrive than are written at once', async () => {
    const directory = await scratch()
    const entries = manyEntries(EXTRACT_WRITES * 20)
    const extracted = await extractArchive({ archive: await archiveOf(entries), format: 'tar.gz', files: fileList(entries), directory })
    expect(extracted.written).toBe(entries.length)
    for (const entry of entries) {
      const path = join(directory, ...entry.path.split('/'))
      expect((await readFile(path)).equals(entry.data), entry.path).toBe(true)
      expect(lstatSync(path).mode & 0o777).toBe(entry.mode === '0755' ? 0o555 : 0o444)
      expect(extracted.identities.get(entry.path)).toBe(identityOf(lstatSync(path, { bigint: true })))
    }
  })

  it('has ended every write when it refuses a later entry, so a removal of the staging directory stays removed', async () => {
    // Each directory is created 100 ms late, so writes are still waiting when the refused entry arrives.
    const builtin = createRequire(import.meta.url)('node:fs/promises') as { mkdir: (...args: unknown[]) => Promise<unknown> }
    const real = builtin.mkdir
    builtin.mkdir = async (...args: unknown[]) => {
      await sleep(100)
      return real(...args)
    }
    syncBuiltinESMExports()
    onTestFinished(() => {
      builtin.mkdir = real
      syncBuiltinESMExports()
    })
    const parent = await scratch()
    const directory = join(parent, 'staging')
    const good = manyEntries(EXTRACT_WRITES * 20)
    const late: ArchiveEntry = { path: 'node/bin/node', mode: '0755', data: Buffer.from('#!/bin/sh\nexit 0\n') }
    const list = fileList([...good, late])
    const tampered: RuntimeFileList = { ...list, files: list.files.map(file => file.path === late.path ? { ...file, sha256: brandString<Sha256Hex>('0'.repeat(64)) } : file) }
    const error: unknown = await extractArchive({ archive: await archiveOf([...good, late]), format: 'tar.gz', files: tampered, directory }).then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'INSTALL_VERIFY_FAILED')).toBe(true)
    await rm(directory, { recursive: true, force: true })
    await sleep(300)
    expect(existsSync(directory)).toBe(false)
  })
})
