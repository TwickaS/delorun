/**
 * Reading an npm tarball: the registry serves what `npm publish` wrote, whose tar headers are not Delorun's canonical
 * ones (uid and gid are empty, numbers are space-padded). Every case here extracts through `extractExternal`, which
 * applies nothing from uid, gid or mtime and keeps `size`, `mode`, the checksum, the entry type and the path strict.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { type PackExternal, type Sha512Base64 } from '@delorun/contract-release-manifest'
import { semanticVersion } from '@delorun/release-formats/brands'
import { readTar } from '@delorun/release-formats/archive/tar'
import { extractExternal } from '@delorun/release-formats/packs/archive'
import { brandString } from '@deepseek-ai/dsh-brand'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'delorun-npm-tar-')); roots.push(root); return root }

/** The second header of `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.263` (`package/package.json`, 282 bytes: the size field reads `0000000432` in octal), exactly as the registry serves it. */
const REAL_HEADER = Buffer.from([
  '7061636b6167652f7061636b6167652e6a736f6e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000000000000030303036343420000000000000000000000000000000000030303030',
  '30303034333220003335363031313636303420003031313534352000300000000000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '00757374617200303000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000030303030303020003030303030302000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
].join(''), 'hex')

const BLOCK = 512
const END = Buffer.alloc(BLOCK * 2)

interface HeaderFields {
  readonly path: string
  readonly size: number | Buffer
  readonly mode?: string | Buffer
  readonly uid?: Buffer
  readonly gid?: Buffer
  readonly mtime?: string | Buffer
  readonly type?: string
  readonly checksum?: 'good' | 'bad'
}

const ascii = (text: string, width: number): Buffer => { const field = Buffer.alloc(width); field.write(text, 'ascii'); return field }
/** The way `npm pack` pads a number: zeros, a space and a NUL. */
const padded = (value: number, width: number): Buffer => ascii(`${value.toString(8).padStart(width - 2, '0')} `, width)

/** A header as the npm writer produces it: uid and gid empty, numbers space-padded, the checksum `NNNNNN\0 `. */
function npmHeader(fields: HeaderFields): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(fields.path, 0, 'utf8')
  const mode = typeof fields.mode === 'string' ? ascii(fields.mode, 8) : fields.mode ?? padded(0o644, 8)
  const size = typeof fields.size === 'number' ? padded(fields.size, 12) : fields.size
  const mtime = typeof fields.mtime === 'string' ? ascii(fields.mtime, 12) : fields.mtime ?? padded(0o32_000_000_000, 12)
  mode.copy(block, 100)
  ;(fields.uid ?? Buffer.alloc(8)).copy(block, 108)
  ;(fields.gid ?? Buffer.alloc(8)).copy(block, 116)
  size.copy(block, 124)
  mtime.copy(block, 136)
  block.write('        ', 148, 'ascii')
  block.write(fields.type ?? '0', 156, 'ascii')
  block.write('ustar\u000000', 257, 'ascii')
  padded(0, 8).copy(block, 329)
  padded(0, 8).copy(block, 337)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${(fields.checksum === 'bad' ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK)

/** One file entry: its header and padded data. */
const file = (fields: Omit<HeaderFields, 'size'>, text: string): Buffer => Buffer.concat([npmHeader({ ...fields, size: Buffer.byteLength(text) }), Buffer.from(text), padding(Buffer.byteLength(text))])

const tarball = (...parts: Buffer[]): Buffer => gzipSync(Buffer.concat([...parts, END]))

function pin(bytes: Buffer): PackExternal {
  return {
    name: '@anthropic-ai/claude-agent-sdk-linux-x64',
    version: semanticVersion('0.3.263'),
    url: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.263.tgz',
    sha512: brandString<Sha512Base64>(createHash('sha512').update(bytes).digest('base64')),
    length: bytes.byteLength,
  }
}

async function extract(bytes: Buffer): Promise<string> {
  const out = temp()
  await extractExternal(bytes, pin(bytes), out)
  return out
}

describe('an npm tarball as the registry serves it', () => {
  it('extracts the real header of claude-agent-sdk-linux-x64@0.3.263: empty uid and gid, space-padded numbers', async () => {
    expect(REAL_HEADER.byteLength).toBe(BLOCK)
    expect(REAL_HEADER.subarray(108, 124).every(byte => byte === 0)).toBe(true)
    const body = `{"name":"x"}${' '.repeat(270)}`
    expect(body.length).toBe(0o432)
    const out = await extract(tarball(REAL_HEADER, Buffer.from(body), padding(body.length)))
    expect(readFileSync(join(out, 'package.json'), 'utf8')).toBe(body)
  })

  it('extracts files written the npm way, keeps the executable bit and applies no other mode bit', async () => {
    const out = await extract(tarball(
      file({ path: 'package/claude', mode: '000755 ' }, 'binary'),
      file({ path: 'package/dir/notes.md', mode: '000644 ' }, 'notes'),
      file({ path: 'package/setuid', mode: '004755 ' }, 'x'),
    ))
    expect(readFileSync(join(out, 'claude'), 'utf8')).toBe('binary')
    expect(statSync(join(out, 'claude')).mode & 0o777).toBe(0o755)
    expect(statSync(join(out, 'dir/notes.md')).mode & 0o777).toBe(0o644)
    expect(statSync(join(out, 'setuid')).mode & 0o7777).toBe(0o755)
  })

  it.each<readonly [string, Buffer]>([
    ['an empty field', Buffer.alloc(8)],
    ['octal padded with a space', ascii('0000000 ', 8)],
    ['octal padded with NULs', ascii('0000000', 8)],
    ['GNU base-256', Buffer.from([0x80, 0, 0, 0, 0, 0, 0x03, 0xe8])],
    ['a form no reader knows', ascii('zzzzzzz', 8)],
  ])('applies nothing from uid or gid, and reads %s', async (_name, value) => {
    const out = await extract(tarball(file({ path: 'package/a.txt', uid: value, gid: value }, 'a')))
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('a')
  })

  it.each<readonly [string, Buffer | string]>([
    ['an empty mtime', Buffer.alloc(12)],
    ['a base-256 mtime', Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0xd4, 0x3a, 0x5c, 0x7c])],
    ['an mtime that is not a number', 'xxxxxxxxxxx'],
  ])('applies nothing from mtime, and reads %s', async (_name, mtime) => {
    const out = await extract(tarball(file({ path: 'package/a.txt', mtime }, 'a')))
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('a')
  })

  it('reads a size written as GNU base-256, within the signed length', async () => {
    const text = 'hello'
    const size = Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, text.length])
    const out = await extract(tarball(npmHeader({ path: 'package/a.txt', size }), Buffer.from(text), padding(text.length)))
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe(text)
  })
})

describe('a tarball that is still refused', () => {
  const refused = async (bytes: Buffer, message: RegExp): Promise<void> => {
    const out = temp()
    await expect(extractExternal(bytes, pin(bytes), out)).rejects.toThrow(message)
    expect(readdirSync(out)).toEqual([])
  }

  it('refuses a path that leaves the package or the directory', async () => {
    await refused(tarball(file({ path: 'package/../../evil' }, 'x')), /./u)
    await refused(tarball(file({ path: 'other/file' }, 'x')), /outside package\//u)
    await refused(tarball(file({ path: '/etc/passwd' }, 'x')), /./u)
  })

  it('refuses a link, a directory and a device, so no symlink can leave the directory', async () => {
    for (const type of ['1', '2', '3', '4', '5', '6', 'g']) {
      await refused(tarball(file({ path: 'package/x', type }, '')), /not a regular file|pax|valid archive/u)
    }
  })

  it('refuses a size above the reader\'s limit and a size the data does not fill', async () => {
    await refused(tarball(npmHeader({ path: 'package/big', size: Buffer.from([0x80, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) })), /exceeds the limit|out of range|valid archive/u)
    await refused(tarball(npmHeader({ path: 'package/short', size: 4096 }), Buffer.from('abc')), /ends inside/u)
  })

  it('refuses an empty size, a mode that is not octal, a negative base-256 size and a bad checksum', async () => {
    await refused(tarball(npmHeader({ path: 'package/a', size: Buffer.alloc(12) })), /size is empty/u)
    await refused(tarball(file({ path: 'package/a', mode: 'zzzzzzz' }, 'x')), /mode is not an octal number/u)
    await refused(tarball(npmHeader({ path: 'package/a', size: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]) })), /negative/u)
    await refused(tarball(file({ path: 'package/a', checksum: 'bad' }, 'x')), /checksum does not match/u)
  })

  it('refuses a tarball longer than the length the packs file signs', async () => {
    const bytes = tarball(file({ path: 'package/a' }, 'x'))
    const out = temp()
    await expect(extractExternal(bytes, { ...pin(bytes), length: bytes.byteLength - 1 }, out)).rejects.toThrow(/bytes; the signed packs file lists/u)
    expect(existsSync(join(out, 'a'))).toBe(false)
  })
})

describe('the canonical reader', () => {
  it('still refuses an empty uid, so a Delorun archive keeps its fixed header', async () => {
    const bytes = Buffer.concat([file({ path: 'a' }, 'x'), END])
    const read = async (foreign: boolean): Promise<number> => {
      let count = 0
      for await (const _entry of readTar((async function* () { yield bytes })(), 1024, { foreign })) count += 1
      return count
    }
    await expect(read(false)).rejects.toThrow(/uid is not an octal number/u)
    await expect(read(true)).resolves.toBe(1)
  })
})

/** The tarballs a packs file names, when a directory of them is given; the check the release walk runs on the real ones. */
describe.skipIf(process.env.DELORUN_REAL_NPM_TARBALLS === undefined)('the real tarballs of a release', () => {
  it('reads every .tgz in DELORUN_REAL_NPM_TARBALLS to its end', async () => {
    const directory = process.env.DELORUN_REAL_NPM_TARBALLS!
    for (const name of readdirSync(directory).filter(each => each.endsWith('.tgz'))) {
      let count = 0
      for await (const _entry of readTar(createReadStream(join(directory, name)).pipe(createGunzip()) as AsyncIterable<Buffer>, 512 * 1024 * 1024, { foreign: true })) count += 1
      expect(count, name).toBeGreaterThan(0)
    }
  }, 300_000)

  it('extracts every .tgz there through extractExternal, as the release installs it', async () => {
    const directory = process.env.DELORUN_REAL_NPM_TARBALLS!
    for (const name of readdirSync(directory).filter(each => each.endsWith('.tgz'))) {
      const bytes = readFileSync(join(directory, name))
      const out = temp()
      await extractExternal(bytes, pin(bytes), out)
      expect(existsSync(join(out, 'package.json')) || readdirSync(out).length > 0, name).toBe(true)
    }
  }, 300_000)
})
