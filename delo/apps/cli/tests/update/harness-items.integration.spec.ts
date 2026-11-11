/**
 * The CLI's harness facts (`delo/apps/cli/src/update/harness-items.ts`): the target's signed files read by path and
 * checked again against the signed list, and each merge's name in the report.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { RELEASE_SCHEMAS, type RuntimeFile, type SemanticVersion, type Sha256Hex } from '@delo/contract-release-manifest'
import { RuntimeStoreError, type VerifiedRuntime } from '@delo/runtime-store'
import { harnessFacts, mergeOf, signedFileReader } from '../../src/update/harness-items.ts'

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A runtime directory holding files, and the verified runtime whose signed list names them.
 * @param files - each file's text and mode, by path.
 * @param listed - the bytes the signed list states for a path, when they differ from the file's.
 * @returns the directory and the runtime.
 */
function runtimeOf(files: Readonly<Record<string, { text: string, mode: RuntimeFile['mode'] }>>, listed: Readonly<Record<string, string>> = {}): { directory: string, runtime: Pick<VerifiedRuntime, 'version' | 'files'> } {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'delo-harness-')))
  created.push(directory)
  const entries = Object.entries(files).map(([path, file]): RuntimeFile => {
    mkdirSync(join(directory, path, '..'), { recursive: true })
    writeFileSync(join(directory, path), file.text)
    const signed = Buffer.from(listed[path] ?? file.text)
    return { path, length: signed.length, sha256: brandString<Sha256Hex>(createHash('sha256').update(signed).digest('hex')), mode: file.mode }
  })
  const version = brandString<RuntimeVersion>('1.1.0')
  return { directory, runtime: { version, files: { schema: RELEASE_SCHEMAS.files, version: brandString<SemanticVersion>(version), platform: 'linux-x64', files: entries } } }
}

describe('signedFileReader', () => {
  it('reads a signed file with the execute bit its mode gives, and no file for a path the list does not name', async () => {
    const { directory, runtime } = runtimeOf({ 'app/a.js': { text: 'a\n', mode: '0644' }, 'app/bin.sh': { text: '#!/bin/sh\n', mode: '0755' } })
    const read = signedFileReader(directory, runtime)

    expect(await read('app/a.js')).toEqual({ bytes: Buffer.from('a\n'), executable: false })
    expect(await read('app/bin.sh')).toEqual({ bytes: Buffer.from('#!/bin/sh\n'), executable: true })
    expect(await read('app/missing.js')).toBeUndefined()
  })

  it('refuses a file whose bytes differ from the signed list, whether in length or in digest', async () => {
    const { directory, runtime } = runtimeOf({ 'app/a.js': { text: 'changed\n', mode: '0644' }, 'app/b.js': { text: 'bbbb\n', mode: '0644' } }, { 'app/a.js': 'signed\n', 'app/b.js': 'BBBB\n' })
    const read = signedFileReader(directory, runtime)

    for (const path of ['app/a.js', 'app/b.js']) {
      const failure = await read(path).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(RuntimeStoreError)
      expect(failure).toMatchObject({ code: 'RUNTIME_CHANGED', path: join(directory, path) })
    }
  })
})

describe('mergeOf', () => {
  it('names a file the target already holds as in-release, and every other outcome by how it carried or conflicted', () => {
    expect(mergeOf({ outcome: 'same' })).toBe('in-release')
    expect(mergeOf({ outcome: 'carried', carry: 'merged', result: undefined })).toBe('merged')
    expect(mergeOf({ outcome: 'conflict', conflict: 'both-added' })).toBe('both-added')
    expect(harnessFacts({ from: '1.0.0', entries: [] })).toEqual([])
  })
})
