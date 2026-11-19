import { describe, expect, it } from 'vitest'
import { LOD_ATLASES } from '../src/home/lod-atlases.ts'
import { LOD_TILES } from '../src/home/lod-tiles.ts'
import { atlasUrl, LEVEL_WIDTHS, levelFor, lodUrl } from '../src/home/pictures.ts'
import { FILM, SHOTS } from '../src/home/shots.ts'

describe('the level of detail a picture is given', () => {
  it('is the smallest level that is at least as wide as the picture on screen, by device pixels', () => {
    for (const device of ['computer', 'phone'] as const) {
      const [one, two] = LEVEL_WIDTHS[device]
      expect(levelFor(1, device)).toBe(1)
      expect(levelFor(one, device)).toBe(1)
      expect(levelFor(one + 1, device)).toBe(2)
      expect(levelFor(two, device)).toBe(2)
      expect(levelFor(two + 1, device)).toBe(3)
      expect(levelFor(10_000, device)).toBe(3)
    }
  })

  it('uses narrower levels for a phone capture, which is narrower itself', () => {
    expect(LEVEL_WIDTHS.phone[1]).toBeLessThan(LEVEL_WIDTHS.computer[1])
    expect(levelFor(400, 'computer')).toBe(1 + 1)
    expect(levelFor(400, 'phone')).toBe(3)
  })
})

describe('the addresses of the pyramid', () => {
  it('name each level of each picture by a hash, as AVIF and WebP, under /lod/', () => {
    const shot = SHOTS[0]!
    for (const level of [1, 2, 3] as const) {
      expect(lodUrl(shot.id, level, 'avif')).toMatch(new RegExp(`^/lod/${shot.id}\\.${String(level)}\\.[0-9a-f]{10}\\.avif$`))
      expect(lodUrl(shot.id, level, 'webp')).toMatch(/\.webp$/)
    }
  })

  it('cover every picture of the wall and the film', () => {
    const ids = [...SHOTS.map(shot => shot.id), ...FILM.flatMap(chapter => [chapter.id, chapter.phone.file, ...(chapter.phone.dark === undefined ? [] : [chapter.phone.dark]), ...(chapter.dark === undefined ? [] : [chapter.dark.id])])]
    for (const id of ids) expect(LOD_TILES[id], id).toBeDefined()
  })

  it('refuse a picture the pyramid does not have, naming the script that builds it', () => {
    expect(() => lodUrl('no-such-picture', 2, 'webp')).toThrow(/scripts\/lod\.ts/)
  })

  it('give every layout an atlas for every look in both colour schemes', () => {
    for (const layout of ['wide', 'narrow'] as const) {
      for (const [look, modes] of Object.entries(LOD_ATLASES[layout].looks)) {
        for (const mode of ['light', 'dark'] as const) {
          expect(modes[mode], `${layout} ${look} ${mode}`).toMatch(/^[0-9a-f]{10}$/)
          expect(atlasUrl(layout, look as keyof typeof LOD_ATLASES.wide.looks, mode, 'avif')).toContain(`atlas-${layout}-${look}-${mode}.`)
        }
      }
    }
  })
})
