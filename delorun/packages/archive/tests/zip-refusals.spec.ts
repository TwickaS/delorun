/**
 * Proves the ZIP reader refuses every container that is not an archive format
 * v1 container, with the exact code and without returning a byte: a file that is
 * too short or has no end record, a multi-disk or ZIP64 declaration, a central
 * directory that overlaps the end record or ends early, an encrypted entry, a
 * compression method the format does not use, a name that is not UTF-8, a local
 * header that disagrees with the central directory, an entry that inflates past
 * or short of its declared size, a checksum that does not match, and the special
 * file types and shared bodies of the entry-type check.
 */
import { describe, expect, it } from 'vitest'
import { ZipArchive } from '../src/index.ts'
import { refusal } from './refusals.ts'
import { utf8 } from './support.ts'
import { CENTRAL_RECORD_SIZE, LOCAL_HEADER_SIZE, container, field, layoutOf, patched } from './zip-bytes.ts'

describe('opening a container', () => {
  it('refuses a file shorter than an end record', () => {
    expect(refusal(() => ZipArchive.open(new Uint8Array(21))).code).toBe('ARCHIVE_TRUNCATED')
  })

  it('refuses a file with no end-of-central-directory record', () => {
    const error = refusal(() => ZipArchive.open(new Uint8Array(200)))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('no end-of-central-directory record')
  })

  it('refuses an end record that declares a comment the file does not hold', () => {
    const bytes = container()
    const { end } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: end + 20, width: 2, value: 5 })))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('comment')
  })

  it.each([
    ['this disk is not disk zero', 4],
    ['the directory starts on another disk', 6],
    ['the entries on this disk differ from the total', 8],
  ])('refuses a multi-disk archive where %s', (_name, at) => {
    const bytes = container()
    const { end } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: end + at, width: 2, value: 1 })))

    expect(error.code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
    expect(error.message).toContain('several disks')
  })

  it.each([
    ['an entry count of 0xffff', [{ at: 8, width: 2, value: 0xffff }, { at: 10, width: 2, value: 0xffff }] as const],
    ['a directory size of 0xffffffff', [{ at: 12, width: 4, value: 0xffff_ffff }] as const],
    ['a directory offset of 0xffffffff', [{ at: 16, width: 4, value: 0xffff_ffff }] as const],
  ])('refuses a ZIP64 declaration of %s', (_name, patches) => {
    const bytes = container()
    const { end } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, ...patches.map(patch => ({ ...patch, at: end + patch.at })))))

    expect(error.code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
    expect(error.message).toContain('ZIP64')
  })

  it('refuses a central directory that overlaps the end record', () => {
    const bytes = container()
    const { end } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: end + 12, width: 4, value: field(bytes, end + 12, 4) + 10 })))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('overlaps')
  })

  it('refuses a directory that declares more entries than the limit', () => {
    const error = refusal(() => ZipArchive.open(container(), { maxEntries: 1 }))

    expect(error.code).toBe('ARCHIVE_TOO_MANY_ENTRIES')
  })

  it('refuses a directory that holds fewer records than the end record declares', () => {
    const bytes = container()
    const { end } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: end + 8, width: 2, value: 3 }, { at: end + 10, width: 2, value: 3 })))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('ends after 2 of the 3 records')
  })

  it('refuses a record that is not a central-directory record', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[1]!, width: 4, value: 0 })))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('record 2')
  })

  it('refuses a record whose name runs past the end of the file', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[1]! + 28, width: 2, value: 0xffff })))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('ends early')
  })

  it('refuses an encrypted entry', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[0]! + 8, width: 2, value: field(bytes, central[0]! + 8, 2) | 1 })))

    expect(error.code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
    expect(error.message).toContain('encrypted')
  })

  it('refuses a compression method the format does not use', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[0]! + 10, width: 2, value: 12 })))

    expect(error.code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
    expect(error.message).toContain('compression method 12')
  })

  it('refuses an entry name that is not UTF-8', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[0]! + CENTRAL_RECORD_SIZE, width: 1, value: 0xff })))

    expect(error.code).toBe('ARCHIVE_PATH_REJECTED')
  })
})

describe('reading an entry', () => {
  it('reads the first of two entries that share a name, and lists both for the path rules to refuse', () => {
    const bytes = Buffer.from(container([{ name: 'objects/a', bytes: utf8('first') }, { name: 'objects/b', bytes: utf8('second') }]))
    for (let at = bytes.indexOf('objects/b'); at !== -1; at = bytes.indexOf('objects/b', at)) bytes.write('objects/a', at)
    const archive = ZipArchive.open(bytes)

    expect(new TextDecoder().decode(archive.read('objects/a'))).toBe('first')
    expect(archive.names()).toEqual(['objects/a', 'objects/a'])
  })

  it('returns the bytes of a stored entry and of a deflated entry', () => {
    const archive = ZipArchive.open(container([
      { name: 'stored.txt', bytes: utf8('hello'), method: 'store' },
      { name: 'deflated.txt', bytes: utf8('a'.repeat(100)), method: 'deflate' },
    ]))

    expect(archive.names()).toEqual(['stored.txt', 'deflated.txt'])
    expect(Buffer.from(archive.read('stored.txt'))).toEqual(Buffer.from(utf8('hello')))
    expect(Buffer.from(archive.read('deflated.txt'))).toEqual(Buffer.from(utf8('a'.repeat(100))))
  })

  it('refuses a name the archive does not hold', () => {
    const error = refusal(() => ZipArchive.open(container()).read('missing.txt'))

    expect(error.code).toBe('ARCHIVE_PATH_REJECTED')
  })

  it('refuses an entry whose local header lies outside the entry area', () => {
    const bytes = container()
    const { central, directory } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[1]! + 42, width: 4, value: directory - 10 })).read('b.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('outside the entry area')
  })

  it('refuses an entry with no local file header', () => {
    const bytes = container()
    const { local } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: local[0]!, width: 4, value: 0 })).read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('no local file header')
  })

  it.each([
    ['a local extra field longer than the entry area', (local: number, central: number) => ({ at: local + 28, width: 2 as const, value: 0xffff, central })],
    ['a stored size that runs past the central directory', (_local: number, central: number) => ({ at: central + 20, width: 4 as const, value: 0xffff, central })],
  ])('refuses an entry with %s', (_name, patch) => {
    const bytes = container()
    const { local, central } = layoutOf(bytes)
    const { at, width, value } = patch(local[0]!, central[0]!)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at, width, value })).read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('runs past the central directory')
  })

  it('refuses a local header that names another entry than the central directory', () => {
    const bytes = container()
    const { local } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: local[0]! + LOCAL_HEADER_SIZE, width: 1, value: 'z'.charCodeAt(0) })).read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('"z.txt"')
  })

  it('refuses a local header whose name is not UTF-8', () => {
    const bytes = container()
    const { local } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: local[0]! + LOCAL_HEADER_SIZE, width: 1, value: 0xff })).read('a.txt'))

    expect(error.code).toBe('ARCHIVE_PATH_REJECTED')
  })

  it.each([
    ['stored', 18],
    ['uncompressed', 22],
  ])('refuses a local header whose %s size differs from the central directory', (_name, at) => {
    const bytes = container()
    const { local } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: local[0]! + at, width: 4, value: 6 })).read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('local header')
  })

  it('does not compare the local sizes of an entry that defers its sizes to a data descriptor', () => {
    const bytes = container()
    const { local, central } = layoutOf(bytes)
    const archive = ZipArchive.open(patched(
      bytes,
      { at: central[0]! + 8, width: 2, value: field(bytes, central[0]! + 8, 2) | 8 },
      { at: local[0]! + 18, width: 4, value: 0 },
      { at: local[0]! + 22, width: 4, value: 0 },
    ))

    expect(archive.read('a.txt')).toEqual(utf8('hello'))
  })

  it('refuses a stored entry whose two declared sizes differ', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)
    const archive = ZipArchive.open(patched(
      bytes,
      { at: central[0]! + 8, width: 2, value: field(bytes, central[0]! + 8, 2) | 8 },
      { at: central[0]! + 24, width: 4, value: 6 },
    ))

    const error = refusal(() => archive.read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('stored bytes for 6 bytes')
  })

  it('refuses a deflate stream that expands past the size it declares', () => {
    const archive = ZipArchive.open(container([
      { name: 'bomb.txt', bytes: utf8('a'.repeat(1000)), method: 'deflate', declaredUncompressedSize: 10 },
    ]))

    const error = refusal(() => archive.read('bomb.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('expands past the 10 bytes')
  })

  it('refuses a deflate entry whose bytes are not a deflate stream', () => {
    const bytes = container([{ name: 'a.txt', bytes: new Uint8Array(5).fill(0xff), method: 'store' }])
    const { central } = layoutOf(bytes)
    const archive = ZipArchive.open(patched(bytes, { at: central[0]! + 10, width: 2, value: 8 }))

    const error = refusal(() => archive.read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('not a deflate stream')
  })

  it('refuses a deflate entry that inflates to fewer bytes than it declares', () => {
    const archive = ZipArchive.open(container([
      { name: 'short.txt', bytes: utf8('a'.repeat(100)), method: 'deflate', declaredUncompressedSize: 200 },
    ]))

    const error = refusal(() => archive.read('short.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('ends after 100 bytes where it declares 200')
  })

  it('refuses an entry whose stored checksum does not match its bytes', () => {
    const bytes = container()
    const { central } = layoutOf(bytes)

    const error = refusal(() => ZipArchive.open(patched(bytes, { at: central[0]! + 16, width: 4, value: 1 })).read('a.txt'))

    expect(error.code).toBe('ARCHIVE_TRUNCATED')
    expect(error.message).toContain('checksum')
  })
})

describe('checking entry types', () => {
  it.each([
    ['a symbolic link', 0o120777, 'symbolic link'],
    ['a block device', 0o060644, 'device'],
    ['a character device', 0o020644, 'device'],
    ['a FIFO', 0o010644, 'device'],
    ['a socket', 0o140644, 'device'],
    ['a file of an unknown type', 0o030644, 'not a plain file'],
  ])('refuses %s', (_name, unixMode, wording) => {
    const archive = ZipArchive.open(container([{ name: 'a.txt', bytes: utf8('x'), method: 'store', unixMode }]))

    const error = refusal(() => archive.checkEntryTypes())

    expect(error.code).toBe('ARCHIVE_LINK_REJECTED')
    expect(error.message).toContain(wording)
  })

  it('refuses a directory entry as a rejected path', () => {
    const archive = ZipArchive.open(container([{ name: 'a.txt', bytes: utf8('x'), method: 'store', unixMode: 0o040755 }]))

    expect(refusal(() => archive.checkEntryTypes()).code).toBe('ARCHIVE_PATH_REJECTED')
  })

  it('refuses two records that share one stored body as a hard link', () => {
    const bytes = container()
    const { central, local } = layoutOf(bytes)
    const archive = ZipArchive.open(patched(bytes, { at: central[1]! + 42, width: 4, value: local[0]! }))

    const error = refusal(() => archive.checkEntryTypes())

    expect(error.code).toBe('ARCHIVE_LINK_REJECTED')
    expect(error.message).toContain('hard link')
  })

  it('accepts plain files, including an entry with no file-type bits', () => {
    const archive = ZipArchive.open(container([
      { name: 'regular.txt', bytes: utf8('x'), method: 'store' },
      { name: 'untyped.txt', bytes: utf8('y'), method: 'store', unixMode: 0o644 },
    ]))

    expect(() => archive.checkEntryTypes()).not.toThrow()
  })

  it('treats an entry from a writer that is not a Unix system as a plain file whatever its attributes say', () => {
    const bytes = container([{ name: 'a.txt', bytes: utf8('x'), method: 'store', unixMode: 0o120777 }])
    const { central } = layoutOf(bytes)
    const archive = ZipArchive.open(patched(bytes, { at: central[0]! + 4, width: 2, value: 20 }))

    expect(() => archive.checkEntryTypes()).not.toThrow()
    expect(archive.read('a.txt')).toEqual(utf8('x'))
  })
})
