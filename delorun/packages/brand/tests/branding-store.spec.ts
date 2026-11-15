import { describe, expect, it } from 'vitest'
import { checkImageBytes, checkStoredBranding, IMAGE_HASH, resolveBranding, writeIcon } from '../src/branding.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const HASH = 'a'.repeat(64)

describe('image bytes', () => {
  it('accepts PNG, JPEG and WebP by their first bytes', () => {
    expect(checkImageBytes(PNG)).toEqual({ ok: true, type: 'image/png' })
    expect(checkImageBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, type: 'image/jpeg' })
    expect(checkImageBytes(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toEqual({ ok: true, type: 'image/webp' })
  })

  it('refuses SVG, however it is declared', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect(checkImageBytes(svg, 'image/svg+xml').ok).toBe(false)
    expect(checkImageBytes(svg, 'image/png').ok).toBe(false)
  })

  it('refuses an oversize file and bytes that do not match the declared type', () => {
    const big = new Uint8Array(256 * 1024 + 1)
    big.set(PNG)
    expect(checkImageBytes(big).ok).toBe(false)
    expect(checkImageBytes(PNG, 'image/jpeg').ok).toBe(false)
    expect(checkImageBytes(new Uint8Array()).ok).toBe(false)
  })
})

describe('a stored hash', () => {
  const stored = { showMark: true, name: '', greeting: '', icon: 'upload', pickedIcon: '', uploadHash: HASH, upload: '' }

  it('serves the file only when the host read bytes for exactly that hash', () => {
    const read = resolveBranding(stored, { readImage: hash => hash === HASH ? PNG : undefined })
    expect(read.icon).toBe('upload')
    expect(read.image?.version).toBe('aaaaaaaaaaaa')
  })

  it('shows the default when no file matches the hash', () => {
    const read = resolveBranding(stored, { readImage: () => undefined })
    expect(read.icon).toBe('mark')
    expect(read.image).toBeUndefined()
    expect(read.notice).toContain('could not be found')
    const answered = { statusCode: 0, end: () => undefined, setHeader: () => undefined }
    writeIcon(read, 'GET', answered)
    expect(answered.statusCode).toBe(404)
  })

  it('shows the default for a file whose bytes are not an image, and for a malformed hash', () => {
    expect(resolveBranding(stored, { readImage: () => new TextEncoder().encode('<svg/>') }).icon).toBe('mark')
    expect(resolveBranding({ ...stored, uploadHash: '../etc/passwd' }, { readImage: () => PNG }).icon).toBe('mark')
    expect(IMAGE_HASH.test('../etc/passwd')).toBe(false)
  })

  it('keeps the upload icon in the page copy, which has no bytes', () => {
    expect(resolveBranding(stored, { uploadElided: true }).icon).toBe('upload')
  })

  it('still reads a record that stores the image as base64', () => {
    const base64 = btoa(String.fromCharCode(...PNG))
    expect(resolveBranding({ ...stored, uploadHash: '', upload: base64 }).icon).toBe('upload')
  })
})

describe('the write check', () => {
  it('accepts a valid record and refuses each bad field', () => {
    expect(checkStoredBranding({ showMark: true, name: 'Acme', greeting: 'Hello', icon: 'upload', uploadHash: HASH, upload: '' })).toBeUndefined()
    expect(checkStoredBranding({ name: 'x'.repeat(41) })).toBeDefined()
    expect(checkStoredBranding({ name: 'a\u0007b' })).toBeDefined()
    expect(checkStoredBranding({ greeting: 'x'.repeat(81) })).toBeDefined()
    expect(checkStoredBranding({ icon: 'svg' })).toBeDefined()
    expect(checkStoredBranding({ uploadHash: 'nope' })).toBeDefined()
    expect(checkStoredBranding({ upload: btoa('<svg/>') })).toBeDefined()
    expect(checkStoredBranding({ unknown: 1 })).toBeDefined()
    expect(checkStoredBranding('text')).toBeDefined()
  })
})
