import { describe, expect, it } from 'vitest'
import { findUsSpellings, findUsSpellingsInSource, isBritishEnglishFile, isBritishEnglishSourceFile, US_SPELLING_MARKER, US_TO_GB } from './verify-british-english.ts'

describe('British English policy', () => {
  it('names the file, line, word and suggestion of a US spelling in prose', () => {
    const source = ['# Setup', '', 'The studio organizes each color of the catalog.'].join('\n')

    expect(findUsSpellings(source, { file: 'delo/docs/guide/setup.md' })).toEqual([
      { file: 'delo/docs/guide/setup.md', line: 3, word: 'organizes', suggestion: 'organises' },
      { file: 'delo/docs/guide/setup.md', line: 3, word: 'color', suggestion: 'colour' },
      { file: 'delo/docs/guide/setup.md', line: 3, word: 'catalog', suggestion: 'catalogue' },
    ])
  })

  it('matches capitalised and upper-case forms and keeps their case in the suggestion', () => {
    const found = findUsSpellings('Behavior first. CANCELED runs. Authorization works.')

    expect(found.map(({ word, suggestion }) => [word, suggestion])).toEqual([
      ['Behavior', 'Behaviour'],
      ['CANCELED', 'CANCELLED'],
      ['Authorization', 'Authorisation'],
    ])
  })

  it('passes British text and words the list leaves out as ambiguous', () => {
    const source = 'The colour and behaviour of the catalogue are organised. A licence, a program, a dialog and an artifact stay.'

    expect(findUsSpellings(source)).toEqual([])
  })

  it('skips inline code, fenced blocks, link targets, HTML and URLs', () => {
    const source = [
      'Set `color` and ``catalog`` in the file.',
      '```yaml',
      'color: gray',
      '```',
      '~~~',
      'behavior',
      '~~~',
      'See [the page](../reference/color-catalog.md#behavior) and https://example.com/color/catalog.',
      '<span class="color" title="behavior">text</span>',
      '[ref]: https://example.com/gray',
      'The src/color.ts file, the my_color name and the catalog.json file are paths.',
    ].join('\n')

    expect(findUsSpellings(source)).toEqual([])
  })

  it('skips a line that carries the allow marker and checks the next line', () => {
    const source = [`The browser shows "unauthorized". ${US_SPELLING_MARKER}`, 'The next line says unauthorized again.'].join('\n')

    expect(findUsSpellings(source).map(({ line, word }) => [line, word])).toEqual([[2, 'unauthorized']])
  })

  it('scans every line of non-Markdown text for a later TypeScript string pass', () => {
    expect(findUsSpellings('`color`', { markdown: false }).map(({ word }) => word)).toEqual(['color'])
  })

  it('builds the inflections of each stem', () => {
    expect(US_TO_GB.get('organization')).toBe('organisation')
    expect(US_TO_GB.get('deserialized')).toBe('deserialised')
    expect(US_TO_GB.get('analyzing')).toBe('analysing')
    expect(US_TO_GB.get('behavioral')).toBe('behavioural')
    expect(US_TO_GB.get('favorite')).toBe('favourite')
    expect(US_TO_GB.get('neighborhood')).toBe('neighbourhood')
    expect(US_TO_GB.get('canceling')).toBe('cancelling')
    expect(US_TO_GB.get('fulfillment')).toBe('fulfilment')
  })

  it.each([
    'delo/docs/plans/v5-rc-final-plan.md',
    'delo/docs/guide/install.zh.md',
    'delo/apps/cli/tests/import-home/fixtures/terminal-home/.dsh/AGENTS.md',
    'docs/guide/install.md',
    'packages/core/README.md',
    'delo/docs/guide/meta.json',
  ])('does not select %s', (file) => {
    expect(isBritishEnglishFile(file)).toBe(false)
  })

  it('selects English Markdown under delo, including changelog fragments', () => {
    expect(isBritishEnglishFile('delo/docs/contracts/c02-release-manifest.md')).toBe(true)
    expect(isBritishEnglishFile('delo/packages/bundle-local/README.md')).toBe(true)
    expect(isBritishEnglishFile('delo/changelog/pending/relay.md')).toBe(true)
  })

  it('rejects a planted color and initialize in a string, template and JSX literal', () => {
    const source = [
      "export const a = 'Pick a color'",
      'export const b = `Could not initialize ${name}`',
      'export const c = <p>Organize this</p>',
    ].join('\n')

    expect(findUsSpellingsInSource(source, 'delo/packages/x/src/a.tsx').map(({ line, word }) => [line, word]))
      .toEqual([[1, 'color'], [2, 'initialize'], [3, 'Organize']])
  })

  it('skips code positions, wire values, markers and comments in source', () => {
    const source = [
      "import { color } from './color'",
      "const style = { 'color': 'red', color: 'red' }",
      "if (kind === 'catalog') return 'catalog'",
      "const key = 'authorization'",
      "const re = 'authorization header' // us-spelling: quoted output",
      '// Initialize the colour',
      "type T = 'gray' | 'center'",
    ].join('\n')

    expect(findUsSpellingsInSource(source, 'delo/packages/x/src/a.ts')).toEqual([])
  })

  it('selects non-test source files of the Delorun apps and packages', () => {
    expect(isBritishEnglishSourceFile('delo/apps/cli/src/help.ts')).toBe(true)
    expect(isBritishEnglishSourceFile('delo/packages/plugin-onboarding/src/client/locales.ts')).toBe(true)
    expect(isBritishEnglishSourceFile('delo/apps/cli/tests/help.spec.ts')).toBe(false)
    expect(isBritishEnglishSourceFile('delo/apps/relay/src/index.ts')).toBe(false)
    expect(isBritishEnglishSourceFile('packages/core/src/index.ts')).toBe(false)
    expect(isBritishEnglishSourceFile('delo/packages/x/src/types.d.ts')).toBe(false)
  })
})
