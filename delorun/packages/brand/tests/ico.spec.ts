/** The ICO writer, and the committed `favicon.ico` as the render of the mark that `scripts/render-icon.ts` writes. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildIco } from '../src/ico.ts'
import { webIcon } from '../src/icons.ts'
import { BRAND_COLOURS } from '../src/tokens.ts'

const root = new URL('../../../../', import.meta.url)
const sharp = createRequire(new URL('apps/desktop/package.json', root))('sharp') as typeof import('sharp')

/** The directory entries of an ICO file: edge, byte length and offset. */
function entries(ico: Buffer): { size: number, length: number, offset: number }[] {
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1])
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const at = 6 + 16 * index
    return { size: ico.readUInt8(at) || 256, length: ico.readUInt32LE(at + 8), offset: ico.readUInt32LE(at + 12) }
  })
}

describe('buildIco', () => {
  it('lays out a directory entry per image, pointing at its bytes', () => {
    const first = Buffer.from('first')
    const second = Buffer.from('second!')
    const ico = Buffer.from(buildIco([{ size: 16, png: first }, { size: 256, png: second }]))
    const [a, b] = entries(ico)
    expect([a?.size, b?.size]).toEqual([16, 256])
    expect(ico.subarray(a?.offset, (a?.offset ?? 0) + (a?.length ?? 0))).toEqual(first)
    expect(ico.subarray(b?.offset, (b?.offset ?? 0) + (b?.length ?? 0))).toEqual(second)
    expect(ico.length).toBe(6 + 32 + first.length + second.length)
  })

  it('refuses an empty file and an edge outside 1 to 256', () => {
    expect(() => buildIco([])).toThrow(RangeError)
    expect(() => buildIco([{ size: 0, png: Buffer.alloc(1) }])).toThrow(RangeError)
    expect(() => buildIco([{ size: 257, png: Buffer.alloc(1) }])).toThrow(RangeError)
  })
})

describe('apps/web/public/favicon.ico', () => {
  const ico = readFileSync(new URL('apps/web/public/favicon.ico', root))

  it('holds the mark tile at 16, 32 and 48 pixels, each the render of the web icon', async () => {
    const found = entries(ico)
    expect(found.map(entry => entry.size)).toEqual([16, 32, 48])
    for (const { size, length, offset } of found) {
      const png = ico.subarray(offset, offset + length)
      const meta = await sharp(png).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['png', size, size])
      // The tile is full-bleed ink, so a corner pixel is the ink and the centre of the mark is not.
      const raw = await sharp(png).ensureAlpha().raw().toBuffer()
      const pixel = (x: number, y: number): string => [...raw.subarray((y * size + x) * 4, (y * size + x) * 4 + 3)].map(value => value.toString(16).padStart(2, '0')).join('')
      expect(pixel(0, 0)).toBe(BRAND_COLOURS.ink.slice(1).toLowerCase())
      const expected = await sharp(Buffer.from(webIcon(0, 0.62).replace('<svg ', `<svg width="${String(size)}" height="${String(size)}" `))).ensureAlpha().raw().toBuffer()
      expect(Buffer.compare(raw, expected)).toBe(0)
    }
  })
})
