import { describe, expect, it } from 'vitest'
import { pickedIconSvg } from '../src/picked-icon.ts'
import { GLYPH_SVG } from '../src/workspace-glyphs.ts'
import { ICON_GLYPHS } from '../src/workspace-icon.ts'
import { generate } from '../scripts/generate-glyphs.ts'

const base = { kind: 'glyph', glyph: 'folder', color: 'blue', shape: 'rounded', style: 'soft' }

describe('a picked icon drawn as inline SVG', () => {
  it('draws a glyph from the shipped set by id', () => {
    const svg = pickedIconSvg(JSON.stringify(base), 20)
    expect(svg).toContain('<svg')
    expect(svg).toContain(GLYPH_SVG.folder.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, ''))
  })

  it('has a drawing for every glyph the picker offers', () => {
    for (const glyph of ICON_GLYPHS) expect(GLYPH_SVG[glyph]).toMatch(/^<svg/)
  })

  it('draws nothing for an unknown glyph id, markup or text that is not JSON', () => {
    expect(pickedIconSvg(JSON.stringify({ ...base, glyph: 'not-a-glyph' }), 20)).toBeUndefined()
    expect(pickedIconSvg(JSON.stringify({ ...base, color: '"><script>' }), 20)).toBeUndefined()
    expect(pickedIconSvg('not json', 20)).toBeUndefined()
  })

  it('escapes letters instead of passing markup through', () => {
    const svg = pickedIconSvg(JSON.stringify({ kind: 'letters', letters: '<b', color: 'auto', shape: 'circle', style: 'solid' }), 20)
    expect(svg).toContain('&lt;B')
    expect(svg).not.toContain('<b')
  })
})

describe('the glyph file', () => {
  it('matches what the generator writes from the product icon artwork', async () => {
    const committed = (await import('node:fs')).readFileSync(new URL('../src/workspace-glyphs.ts', import.meta.url), 'utf8')
    expect(committed).toBe(generate())
  })
})
