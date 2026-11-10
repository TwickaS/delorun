/**
 * Reading a chat's generations for the attachments it names: a Zstandard
 * generation is decompressed, the newest version comes first, a directory
 * that is missing or is a file holds nothing, and any other failure to read
 * is reported rather than read as no attachments, because a purge would then
 * remove an attachment a chat still names.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { directoryDigests, generationFiles, readGeneration, removeAttachments, treeDigests } from '../src/index.ts'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-trash-text-'))
})

afterEach(() => {
  chmodSync(base, 0o700)
  rmSync(base, { recursive: true, force: true })
})

describe('the generations of a chat', () => {
  it('lists the newest version first and reads a Zstandard generation', async () => {
    const digest = 'd'.repeat(64)
    writeFileSync(join(base, 'session.jsonl'), 'old')
    writeFileSync(join(base, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(`sha256:${digest}`)))
    writeFileSync(join(base, 'other.txt'), '')

    expect(await generationFiles(base)).toEqual(['session.v3.jsonl.zstd', 'session.jsonl'])
    expect(await readGeneration(join(base, 'session.v3.jsonl.zstd'))).toBe(`sha256:${digest}`)
    expect([...await directoryDigests(base)]).toEqual([digest])
  })

  it('holds nothing where the directory is missing or a file stands, and reports any other failure', async () => {
    writeFileSync(join(base, 'file'), '')

    expect(await generationFiles(join(base, 'missing'))).toEqual([])
    expect(await generationFiles(join(base, 'file'))).toEqual([])
    expect([...await treeDigests(join(base, 'missing'))]).toEqual([])
    expect([...await treeDigests(join(base, 'file'))]).toEqual([])
    mkdirSync(join(base, 'locked'))
    chmodSync(join(base, 'locked'), 0)
    try {
      await expect(generationFiles(join(base, 'locked'))).rejects.toMatchObject({ code: 'EACCES' })
      await expect(treeDigests(join(base, 'locked'))).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(join(base, 'locked'), 0o700)
    }
  })
})

describe('removeAttachments', () => {
  it('reports a layout it cannot inspect rather than skip it', async () => {
    const root = join(base, 'attachments', 'v1')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'objects'), 'a file where the objects directory belongs')

    await expect(removeAttachments(root, ['e'.repeat(64)])).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
