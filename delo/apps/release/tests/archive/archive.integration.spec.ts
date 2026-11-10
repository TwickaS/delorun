/**
 * The deterministic archive writers: the same entries give the same bytes whatever the staging directory, file
 * modes and times; the bytes carry the C2 metadata, which standard tools read back; and the inspection refuses an
 * archive that is not in the deterministic form.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { drain, gzip, GZIP_HEADER } from '../../src/archive/bytes.ts'
import type { ArchiveEntry, ArchiveFormat } from '../../src/archive/entry.ts'
import { inspectArchive } from '../../src/archive/inspect.ts'
import { FileSink } from '../../src/archive/sink.ts'
import { tarStream } from '../../src/archive/tar.ts'
import { zipStream } from '../../src/archive/zip.ts'
import { scratch } from '../support.ts'

const EPOCH = 1_793_981_656
const LONG = `app/node_modules/${'a'.repeat(90)}/${'b'.repeat(90)}/${'c'.repeat(90)}/index.js`

const ENTRIES: readonly ArchiveEntry[] = [
  { path: 'app/lib/bin.js', mode: '0755', data: Buffer.from('#!/usr/bin/env node\n') },
  { path: LONG, mode: '0644', data: Buffer.from('export {}\n') },
  { path: 'app/package.json', mode: '0644', data: Buffer.from('{"name":"fixture"}\n') },
  { path: 'node/bin/node', mode: '0755', data: Buffer.alloc(70_000, 7) },
]

async function write(directory: string, name: string, format: ArchiveFormat, entries: readonly ArchiveEntry[]): Promise<string> {
  const path = join(directory, name)
  const sink = await FileSink.create(path, 1 << 30)
  try {
    await drain(format === 'zip' ? zipStream(entries, EPOCH) : gzip(tarStream(entries, EPOCH)), sink)
  } finally {
    await sink.close()
  }
  return path
}

describe('deterministic archives', () => {
  for (const format of ['tar.gz', 'zip'] as const) {
    it(`writes identical ${format} bytes for the same entries and inspects them as canonical`, async (test) => {
      const directory = scratch(test)
      const first = await write(directory, `first.${format}`, format, ENTRIES)
      const second = await write(directory, `second.${format}`, format, ENTRIES)
      expect(readFileSync(first).equals(readFileSync(second))).toBe(true)
      const summary = await inspectArchive(first, format)
      expect(summary.problem).toBeUndefined()
      expect(summary.mtime).toBe(format === 'zip' ? EPOCH - (EPOCH % 2) : EPOCH)
      expect(summary.entries.map(entry => [entry.path, entry.mode, entry.length])).toEqual(ENTRIES.map(entry => [entry.path, entry.mode, entry.data.byteLength]))
    })

    it(`refuses ${format} entries out of byte-wise order or with an unsafe path`, async (test) => {
      const directory = scratch(test)
      await expect(write(directory, 'reversed', format, [...ENTRIES].reverse())).rejects.toThrow(/byte-wise path order/u)
      await expect(write(directory, 'parent', format, [{ path: 'app/../etc/passwd', mode: '0644', data: Buffer.alloc(1) }])).rejects.toThrow(/"\.\." segment/u)
      await expect(write(directory, 'absolute', format, [{ path: '/etc/passwd', mode: '0644', data: Buffer.alloc(1) }])).rejects.toThrow(/absolute/u)
    })
  }

  it('writes the gzip header with mtime 0, no name and a fixed operating system byte', async (test) => {
    const path = await write(scratch(test), 'closure.tar.gz', 'tar.gz', ENTRIES)
    expect(readFileSync(path).subarray(0, 10).equals(GZIP_HEADER)).toBe(true)
  })

  it('writes tar entries that GNU tar lists with owner 0, empty names, C2 modes and the epoch, long paths included', async (test) => {
    const path = await write(scratch(test), 'closure.tar.gz', 'tar.gz', ENTRIES)
    const listing = execFileSync('tar', ['--numeric-owner', '--full-time', '-tvzf', path], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }, timeout: 30_000 }).trim().split('\n')
    expect(listing).toHaveLength(ENTRIES.length)
    const stamp = new Date(EPOCH * 1000).toISOString().replace('T', ' ').slice(0, 19)
    for (const [index, line] of listing.entries()) {
      const entry = ENTRIES[index]!
      expect(line).toMatch(new RegExp(`^${entry.mode === '0755' ? '-rwxr-xr-x' : '-rw-r--r--'} 0/0 +${String(entry.data.byteLength)} ${stamp} `, 'u'))
      expect(line.endsWith(` ${entry.path}`)).toBe(true)
    }
    const out = scratch(test)
    execFileSync('tar', ['-xzf', path, '-C', out], { timeout: 30_000 })
    expect(readFileSync(join(out, LONG), 'utf8')).toBe('export {}\n')
  })

  it('writes ZIP entries that unzip reads with their modes and contents', async (test) => {
    const directory = scratch(test)
    const path = await write(directory, 'closure.zip', 'zip', ENTRIES)
    const info = execFileSync('zipinfo', [path], { encoding: 'utf8', timeout: 30_000 })
    expect(info).toContain('-rwxr-xr-x  2.0 unx')
    expect(info).toContain('-rw-r--r--  2.0 unx')
    execFileSync('unzip', ['-q', path, '-d', join(directory, 'out')], { timeout: 30_000 })
    expect(readFileSync(join(directory, 'out', LONG), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(directory, 'out', 'node/bin/node')).equals(ENTRIES.at(-1)!.data)).toBe(true)
  })

  it('reports a tar.gz whose gzip framing differs from the deterministic form', async (test) => {
    const directory = scratch(test)
    const path = await write(directory, 'closure.tar.gz', 'tar.gz', ENTRIES)
    const regzipped = join(directory, 'regzipped.tar.gz')
    writeFileSync(regzipped, gzipSync(gunzipSync(readFileSync(path)), { level: 6 }))
    expect((await inspectArchive(regzipped, 'tar.gz')).problem).toMatch(/not in the deterministic form/u)
  })

  it('reports a tar.gz built by GNU tar from the same files', async (test) => {
    const directory = scratch(test)
    const tree = join(directory, 'tree')
    execFileSync('mkdir', ['-p', join(tree, 'app')], { timeout: 30_000 })
    writeFileSync(join(tree, 'app', 'package.json'), '{"name":"fixture"}\n')
    utimesSync(join(tree, 'app', 'package.json'), EPOCH, EPOCH)
    const path = join(directory, 'gnu.tar.gz')
    execFileSync('tar', ['-czf', path, '-C', tree, 'app'], { timeout: 30_000 })
    expect((await inspectArchive(path, 'tar.gz')).problem).toMatch(/regular file|owner|not in the deterministic form/u)
  })

  it('reports an archive whose entry was changed after writing', async (test) => {
    const directory = scratch(test)
    const path = await write(directory, 'closure.zip', 'zip', ENTRIES)
    const bytes = readFileSync(path)
    bytes[bytes.indexOf(Buffer.from('{"name":"fixture"}')) + 3] = 0x4e
    writeFileSync(path, bytes)
    expect((await inspectArchive(path, 'zip')).problem).toMatch(/size or CRC-32/u)
  })
})
