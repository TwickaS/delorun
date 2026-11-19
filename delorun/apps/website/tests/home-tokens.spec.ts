import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('../src/home/', import.meta.url)
const files = readdirSync(dir).filter(file => /\.(?:css|tsx?)$/.test(file) && !/^(?:lod-|mosaic-plans|shot-colours|wall-shots)/.test(file))
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the home page draws with the brand tokens', () => {
  it('has files to check', () => {
    expect(files).toContain('home.module.css')
    expect(files).toContain('motion.ts')
  })

  it('writes no colour, easing curve or duration of its own in its stylesheet', () => {
    const css = strip(readFileSync(new URL('home.module.css', dir), 'utf8'))
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(css.match(/\brgba?\(/g) ?? []).toEqual([])
    expect(css.match(/cubic-bezier\(/g) ?? []).toEqual([])
    // Only the zero duration of an instant switch is written out.
    expect((css.match(/\b\d+(?:\.\d+)?m?s\b/g) ?? []).filter(value => value !== '0s')).toEqual([])
  })

  it('takes the easing and durations of its scripts from motion.ts', () => {
    for (const file of files.filter(name => /\.tsx?$/.test(name) && name !== 'motion.ts')) {
      const code = strip(readFileSync(new URL(file, dir), 'utf8'))
      expect(code.match(/cubic-bezier\(/g) ?? [], file).toEqual([])
      expect(code.match(/duration: \d/g) ?? [], file).toEqual([])
    }
  })
})
