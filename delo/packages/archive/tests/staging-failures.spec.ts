/**
 * Proves how the staging writer reports a file system failure that carries no
 * system error code, and that a refusal raised while writing an entry reaches
 * the caller as it is rather than wrapped: the message names the entry and
 * `unexpected error` instead of a code, and never an absolute host path. A
 * staging parent that is a file keeps the import's own refusal, and a
 * cleanup that fails for another reason is reported rather than ignored.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveError, ArchiveImporter, removeStaging, writeStaging } from '../src/index.ts'
import { RecordingStore, buildArchive } from './support.ts'
import { refusalAsync } from './refusals.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir), rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) }
})

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-archive-staging-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('writeStaging', () => {
  it.each([
    ['an error without a code', new Error('boom')],
    ['a value that is not an error', 'boom'],
  ])('names an unexpected error when the staging root fails with %s', async (_name, failure) => {
    vi.mocked(mkdir).mockRejectedValueOnce(failure)

    const error = await refusalAsync(() => writeStaging(join(base, 'root'), []))

    expect(error.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(error.message).toBe('the staging root could not be created (unexpected error)')
  })

  it('names the entry and an unexpected error when writing an entry fails without a code', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('boom'))

    const error = await refusalAsync(() => writeStaging(join(base, 'root'), [{ path: 'objects/a', bytes: new Uint8Array(1) }]))

    expect(error.code).toBe('ARCHIVE_STAGING_FAILED')
    expect(error.message).toBe('the staging directory could not hold the entry "objects/a" (unexpected error)')
  })

  it('passes on a refusal raised while writing an entry without wrapping it', async () => {
    const original = new ArchiveError('ARCHIVE_PATH_REJECTED', 'refused while writing')
    vi.mocked(writeFile).mockRejectedValueOnce(original)

    const error = await refusalAsync(() => writeStaging(join(base, 'root'), [{ path: 'objects/a', bytes: new Uint8Array(1) }]))

    expect(error).toBe(original)
  })
})

describe('removeStaging', () => {
  it('keeps the import\'s refusal when a file stands where the staging parent would be', async () => {
    const parent = join(base, 'parent')
    writeFileSync(parent, 'a file')

    const error = await refusalAsync(() => new ArchiveImporter({ stagingParent: parent, store: new RecordingStore(), acceptUnsigned: true }).import(buildArchive()))

    expect(error.code).toBe('ARCHIVE_STAGING_FAILED')
  })

  it('reports a cleanup that fails for another reason, because the root may still hold chat content', async () => {
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))

    await expect(removeStaging(join(base, 'root'))).rejects.toMatchObject({ code: 'EACCES' })
  })
})
