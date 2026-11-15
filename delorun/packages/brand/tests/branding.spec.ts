/** The branding record's validation refuses what a page must never draw, and falls back to the defaults with a notice. */
import { describe, expect, it } from 'vitest'
import { checkGreeting, checkName, checkUpload, DEFAULT_BRAND_NAME, DEFAULT_GREETING, GREETING_MAX, ICON_MAX_BYTES, NAME_MAX, resolveBranding, sniffImage } from '../src/branding.ts'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]
const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64')

describe('names and greetings', () => {
  it('trims, and accepts 1 to the limit', () => {
    expect(checkName('  Orbit  ')).toEqual({ ok: true, value: 'Orbit' })
    expect(checkName('x'.repeat(NAME_MAX)).ok).toBe(true)
    expect(checkGreeting('Hello').ok).toBe(true)
  })
  it('refuses an empty, an over-long and a control-character name or greeting', () => {
    expect(checkName('   ').ok).toBe(false)
    expect(checkName('x'.repeat(NAME_MAX + 1)).ok).toBe(false)
    expect(checkName('a\u0007b').ok).toBe(false)
    expect(checkGreeting('x'.repeat(GREETING_MAX + 1)).ok).toBe(false)
    expect(checkGreeting('line\nbreak').ok).toBe(false)
  })
})

describe('uploaded icons', () => {
  it('accepts PNG, JPEG and WebP by their first bytes', () => {
    expect(sniffImage(Uint8Array.from(PNG))).toBe('image/png')
    expect(sniffImage(Uint8Array.from(JPEG))).toBe('image/jpeg')
    expect(sniffImage(Uint8Array.from(WEBP))).toBe('image/webp')
  })
  it('refuses SVG, even when it claims to be a PNG', () => {
    const svg = base64([...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')])
    expect(checkUpload(svg).ok).toBe(false)
    expect(checkUpload(svg, 'image/png').ok).toBe(false)
  })
  it('refuses a file larger than the limit', () => {
    const big = base64([...PNG, ...new Array<number>(ICON_MAX_BYTES).fill(1)])
    expect(checkUpload(big).ok).toBe(false)
  })
  it('refuses a file whose first bytes do not match its declared type', () => {
    expect(checkUpload(base64(PNG), 'image/jpeg').ok).toBe(false)
    expect(checkUpload(base64(PNG), 'image/png').ok).toBe(true)
  })
  it('refuses text that is not base64', () => {
    expect(checkUpload('not base64!').ok).toBe(false)
  })
})

describe('resolveBranding', () => {
  it('shows the defaults for nothing stored', () => {
    expect(resolveBranding(undefined)).toMatchObject({ showMark: true, name: DEFAULT_BRAND_NAME, greeting: DEFAULT_GREETING, icon: 'mark', custom: false, notice: undefined })
  })
  it('reads a valid record', () => {
    const branding = resolveBranding({ showMark: false, name: ' Orbit ', greeting: 'Hi', icon: 'upload', upload: base64(PNG) })
    expect(branding).toMatchObject({ showMark: false, name: 'Orbit', greeting: 'Hi', icon: 'upload', custom: true, notice: undefined })
    expect(branding.image?.type).toBe('image/png')
  })
  it('falls back to the defaults with a notice for a record that does not validate', () => {
    const branding = resolveBranding({ name: 'x'.repeat(100), greeting: 5, icon: 'upload', upload: base64([...Buffer.from('<svg/>')]) })
    expect(branding).toMatchObject({ name: DEFAULT_BRAND_NAME, greeting: DEFAULT_GREETING, icon: 'mark', image: undefined })
    expect(branding.notice).toContain('name')
    expect(branding.notice).toContain('icon')
    expect(resolveBranding('garbage').notice).toBeDefined()
  })
})
