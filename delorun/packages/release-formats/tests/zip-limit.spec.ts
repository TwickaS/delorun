/**
 * The ZIP writer's entry limit and the reader's agree: the largest archive the writer accepts is one the reader reads,
 * because a count of 65,535 in the end record is the ZIP64 marker the reader refuses.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArchiveEntry } from '@delorun/release-formats/archive/entry'
import { readZip, zipStream } from '@delorun/release-formats/archive/zip'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** `count` empty files in byte-wise path order. */
function* emptyFiles(count: number): Generator<ArchiveEntry> {
  for (let index = 0; index < count; index++) yield { path: `f${String(index).padStart(6, '0')}`, mode: '0644', data: Buffer.alloc(0) }
}

async function write(count: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of zipStream(emptyFiles(count), 1_700_000_000)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('the ZIP entry limit', () => {
  it('reads back the largest archive the writer accepts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delorun-zip-limit-'))
    roots.push(root)
    const archive = join(root, 'a.zip')
    writeFileSync(archive, await write(0xfffe))
    let count = 0
    for await (const _entry of readZip(archive, 1024)) count += 1
    expect(count).toBe(0xfffe)
  }, 60_000)

  it('refuses 65,535 entries, which the reader would refuse as ZIP64', async () => {
    await expect(write(0xffff)).rejects.toThrow(/exceeds 65534 entries/u)
  })
})
