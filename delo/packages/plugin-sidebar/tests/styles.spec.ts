import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** One CSS declaration with the at-rules it sits in, from a stylesheet read as text. */
interface Declaration {
  readonly file: string
  readonly selector: string
  readonly atRules: readonly string[]
  readonly property: string
  readonly value: string
}

const DIRECTORY = fileURLToPath(new URL('../src/client/', import.meta.url))
const FILES = readdirSync(DIRECTORY).filter(name => name.endsWith('.css'))
const PALETTE_DATA = ['art-palettes.css', 'badge-colors.css']

/**
 * Read a stylesheet's declarations: comments dropped, rules nested in at-rules flattened with their preludes.
 * @param file - the stylesheet's name.
 * @returns the declarations in source order.
 */
function declarationsOf(file: string): Declaration[] {
  const text = readFileSync(`${DIRECTORY}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Declaration[] = []
  const stack: Array<{ prelude: string; body: string }> = []
  let prelude = ''
  let body = ''
  const closeBody = (owner: { prelude: string; body: string } | undefined, atRules: readonly string[]): void => {
    if (owner === undefined || owner.prelude.startsWith('@')) return
    for (const piece of owner.body.split(/;(?![^(]*\))/)) {
      const separator = piece.indexOf(':')
      if (separator < 0) continue
      found.push({ file, selector: owner.prelude, atRules, property: piece.slice(0, separator).trim(), value: piece.slice(separator + 1).trim() })
    }
  }
  for (const character of text) {
    if (character === '{') {
      stack.push({ prelude: prelude.trim().replace(/\s+/g, ' '), body: '' })
      prelude = ''
      body = ''
    } else if (character === '}') {
      const owner = stack.pop()
      if (owner !== undefined) closeBody({ prelude: owner.prelude, body: owner.body + body }, stack.map(open => open.prelude).filter(each => each.startsWith('@')))
      prelude = ''
      body = ''
    } else if (stack.at(-1)?.prelude.startsWith('@') === false) {
      body += character
    } else {
      prelude += character
    }
  }
  return found
}

const ALL = FILES.flatMap(declarationsOf)
const BY_FILE = (file: string): Declaration[] => ALL.filter(declaration => declaration.file === file)
const STYLED = ALL.filter(declaration => !PALETTE_DATA.includes(declaration.file))
const describeAt = (declaration: Declaration): string => `${declaration.file} ${declaration.atRules.join(' ')} ${declaration.selector} { ${declaration.property}: ${declaration.value} }`

describe('the stylesheets of the sidebar', () => {
  it('read as declarations, so the checks below see every rule', () => {
    expect(FILES).toEqual(expect.arrayContaining(['ChatRow.module.css', 'Sidebar.module.css', 'StageArt.module.css', 'art-palettes.css', 'badge-colors.css']))
    expect(ALL.length).toBeGreaterThan(500)
    expect(BY_FILE('ChatRow.module.css').some(declaration => declaration.atRules.includes('@media (pointer: coarse)'))).toBe(true)
  })

  it('hold literal colours only as named palette data, in the art palettes file and the badge colours file', () => {
    const literal = /oklch\(|#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(/
    expect(STYLED.filter(declaration => literal.test(declaration.value)).map(describeAt)).toEqual([])
    const names = BY_FILE('art-palettes.css').map(declaration => declaration.property)
    expect(names.length).toBeGreaterThan(70)
    expect(names.filter(name => !/^--delo-art-(blueprint|rose|grove|ocean|ember|iris|accent|night)-[a-z-]+$/.test(name))).toEqual([])
    expect(BY_FILE('badge-colors.css').map(declaration => declaration.property).filter(name => !/^--delo-badge-[a-z]+$/.test(name))).toEqual([])
    expect(new Set(names).size).toBe(names.length)
  })

  it('keep every font weight at 500 or below', () => {
    const weights = STYLED.filter(declaration => declaration.property === 'font-weight')
    expect(weights.length).toBeGreaterThan(10)
    expect(weights.filter(declaration => /^(bold|bolder|[6-9]\d\d)$/.test(declaration.value)).map(describeAt)).toEqual([])
  })

  it('give spacing, type and sizes as tokens or named geometry, not as literal lengths', () => {
    const measured = /^(font-size|line-height|padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|border-radius|scroll-padding|(padding|margin|inset)-[a-z-]+)$/
    const hairline = /^(0|0\.5|1|1\.5)$/
    const literal = STYLED.filter(declaration => !declaration.property.startsWith('--') && measured.test(declaration.property)).filter((declaration) => {
      return [...declaration.value.matchAll(/(-?\d*\.?\d+)px/g)].some(match => !hairline.test(match[1]?.replace('-', '') ?? ''))
    })
    expect(literal.map(describeAt)).toEqual([])
  })

  it('use only the studio\'s nine spacing steps', () => {
    const steps = new Set(STYLED.flatMap(declaration => [...declaration.value.matchAll(/--delo-space-(\d+)/g)].map(match => Number(match[1]))))
    expect([...steps].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].filter(step => steps.has(step)))
    expect([...steps].filter(step => step < 1 || step > 9)).toEqual([])
    expect(steps.size).toBeGreaterThan(5)
  })

  it('declare each named length once per stylesheet', () => {
    for (const file of FILES) {
      const names = BY_FILE(file).filter(declaration => declaration.property.startsWith('--') && /\d(px|ch)$/.test(declaration.value)).map(declaration => declaration.property)
      expect(names.filter((name, index) => names.indexOf(name) !== index), file).toEqual([])
    }
  })

  it('style hover only on screens that hover', () => {
    const hovering = STYLED.filter(declaration => declaration.selector.includes(':hover'))
    expect(hovering.length).toBeGreaterThan(10)
    expect(hovering.filter(declaration => !declaration.atRules.includes('@media (hover: hover)')).map(describeAt)).toEqual([])
  })

  it('run no transition or animation unless the person allows motion', () => {
    const moving = STYLED.filter(declaration => /^(transition|animation)(-[a-z-]+)?$/.test(declaration.property))
    expect(moving.length).toBeGreaterThan(5)
    expect(moving.filter(declaration => !declaration.atRules.includes('@media (prefers-reduced-motion: no-preference)')).map(describeAt)).toEqual([])
  })

  it('set text in the primary or secondary label, never the quieter roles that miss 4.5:1', () => {
    const quiet = /--dsw-alias-label-(tertiary|caption|dimmed)/
    expect(STYLED.filter(declaration => declaration.property === 'color' && quiet.test(declaration.value)).map(describeAt)).toEqual([])
    const small = (file: string, selector: string): string | undefined => BY_FILE(file).find(declaration => declaration.selector === selector && declaration.property === 'color')?.value
    expect(small('ChatRow.module.css', '.action')).toBe('var(--dsw-alias-label-secondary)')
    expect(small('ChatRow.module.css', '.status')).toBe('var(--dsw-alias-label-secondary)')
  })
})

describe('a row on a coarse pointer', () => {
  const coarse = BY_FILE('ChatRow.module.css').filter(declaration => declaration.atRules.includes('@media (pointer: coarse)'))
  const value = (selector: string, property: string): string | undefined => coarse.find(declaration => declaration.selector === selector && declaration.property === property)?.value

  it('gives the "..." button, the pin and the status button a 32px hit area', () => {
    expect(BY_FILE('ChatRow.module.css').find(declaration => declaration.property === '--row-hit')?.value).toBe('32px')
    for (const selector of ['.action', '.pin', 'button.status']) {
      expect([selector, value(selector, 'min-width'), value(selector, 'min-height')]).toEqual([selector, 'var(--row-hit)', 'var(--row-hit)'])
    }
    expect(value('.trail, .slim .trail', 'height')).toBe('var(--row-hit)')
  })

  it('extends the pin\'s hit area over the gaps, so the row keeps its height', () => {
    expect(value('.pin', 'margin-inline')).toBe('calc((var(--row-icon-small) - var(--row-hit)) / 2)')
  })
})

describe('the search field', () => {
  const header = BY_FILE('Sidebar.module.css')
  const hidden = (atRule: string): boolean => header.some(declaration => declaration.selector === '.searchHint' && declaration.property === 'display'
    && declaration.value === 'none' && declaration.atRules.includes(atRule))

  it('drops the shortcut hint at narrow widths and on coarse pointers, before anything else gives way', () => {
    expect(hidden('@container (max-width: 20rem)')).toBe(true)
    expect(hidden('@media (pointer: coarse)')).toBe(true)
    expect(header.find(declaration => declaration.selector === '.header' && declaration.property === 'container-type')?.value).toBe('inline-size')
  })

  it('tightens the field\'s gaps next and keeps a label width that fits "Search" and its Chinese word', () => {
    const tighter = header.filter(declaration => declaration.selector === '.search' && declaration.atRules.includes('@container (max-width: 15rem)'))
    expect(tighter.map(declaration => declaration.property)).toEqual(['gap', 'padding-inline'])
    expect(header.find(declaration => declaration.property === '--list-label-min')?.value).toBe('7ch')
    expect(header.find(declaration => declaration.selector === '.searchInput' && declaration.property === 'min-width')?.value).toBe('var(--list-label-min)')
    expect(header.find(declaration => declaration.selector === '.search' && declaration.property === 'min-width')?.value).toContain('var(--list-label-min)')
  })
})

describe('the icon picker', () => {
  it('rings the letters field in the studio\'s focus ring while it holds focus', () => {
    const ring = BY_FILE('IconPicker.module.css').filter(declaration => declaration.selector === '.letters:focus-within')
    expect(ring.find(declaration => declaration.property === 'outline')?.value).toContain('var(--dsw-focus-ring-width)')
    expect(ring.find(declaration => declaration.property === 'outline')?.value).toContain('--dsw-focus-ring-color')
  })
})
