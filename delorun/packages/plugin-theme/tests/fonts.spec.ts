/**
 * The brand faces reach the browser: the build copies @delorun/brand's stylesheet and woff2 files, every font url() names
 * a copied file, the copies are git-ignored, and the built bundle emits and references those files. The bundle check
 * needs `pnpm run build` first.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { copyBrandFonts } from '../scripts/copy-brand-fonts.ts'

const at = (path: string): URL => new URL(path, import.meta.url)
const readText = (path: string): string => readFileSync(at(path), 'utf8')
const readBytes = (path: string): Buffer => readFileSync(at(path))

/** The `url()` targets of a stylesheet, as written. */
function urlsIn(css: string): string[] {
  return [...css.matchAll(/url\('([^']+)'\)/gu)].map(match => match[1] ?? '')
}

describe('the brand faces in the studio', () => {
  beforeAll(() => {
    copyBrandFonts()
  })

  it('copies @delorun/brand fonts.css and its woff2 files into the build input, byte for byte', () => {
    expect(readText('../src/client/fonts.css')).toBe(readText('../../brand/src/fonts.css'))
    // The licence texts beside the font files stay in brand; the build copies the font files only.
    const brandFonts = readdirSync(at('../../brand/src/assets/fonts')).filter(name => name.endsWith('.woff2')).sort()
    expect(readdirSync(at('../src/client/assets/fonts')).sort()).toEqual(brandFonts)
    for (const name of brandFonts) {
      expect(readBytes(`../src/client/assets/fonts/${name}`).equals(readBytes(`../../brand/src/assets/fonts/${name}`))).toBe(true)
    }
  })

  it('keeps the copies out of git, so packages/brand/src holds the only committed files', () => {
    const ignored = readText('../.gitignore').split('\n')
    expect(ignored).toContain('/src/client/fonts.css')
    expect(ignored).toContain('/src/client/assets/fonts/')
  })

  it('names only files that exist beside the stylesheet, so the url() rewrite can publish them', () => {
    const targets = urlsIn(readText('../src/client/fonts.css'))
    expect(targets).toHaveLength(2)
    for (const target of targets) expect(existsSync(new URL(target, at('../src/client/fonts.css')))).toBe(true)
  })

  it('has the built bundle emit each face and reference the emitted file', () => {
    const bundle = at('../lib/client.js')
    if (!existsSync(bundle)) throw new Error('lib/client.js is missing: run `pnpm run build` in packages/plugin-theme first')
    const built = readFileSync(bundle, 'utf8')
    const emitted = readdirSync(at('../lib/assets/fonts'))
    for (const family of ['schibsted-grotesk-latin', 'jetbrains-mono-latin']) {
      const file = emitted.find(name => name.startsWith(`${family}-`) && name.endsWith('.woff2'))
      expect(file, `${family} is emitted under lib/assets/fonts`).toBeDefined()
      expect(built).toContain(`plugins/@delorun/plugin-theme/assets/fonts/${file ?? ''}`)
    }
  })
})
