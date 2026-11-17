// @vitest-environment jsdom
/**
 * The setup strip shows what the studio would do: the same themes, ids and settings, the keys the Theme plugin's
 * `writesFor` returns written into the entry as the settings service writes them and printed as the editor's YAML
 * library prints them, and the version list the Setup versions section draws.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOOK, KNOWN_ACCENTS, KNOWN_DENSITIES, KNOWN_LOOKS, type Look } from '@design/looks.ts'
import { resetLook, setLook } from '@design/look-store.ts'
import { CONTRAST_STOPS } from '../../../packages/site-design/scripts/looks.ts'
import { ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, DENSITIES, PALETTES, THEME_ROW_ID } from '../../../packages/plugin-theme/src/config.ts'
import { en as studio } from '../../../packages/plugin-theme/src/client/locales.ts'
import * as settings from '../../../packages/plugin-theme/src/settings.ts'
import { originOf } from '../../../packages/profile-safety/src/versions.ts'
import { applyWrites, BUNDLE_CONFIG, changesBetween, earlierLook, entryYaml, FRESH_STUDIO, record, START, STOP_CONTRAST, THEME_PLUGIN, versionRows, type StripState } from '../src/strip/model.ts'
import { differenceName, themeName } from '../src/strip/names.ts'
import { fill, SetupStrip, STILL } from '../src/strip/setup-strip.tsx'
import { coverRadius } from '../src/strip/spread.ts'

vi.mock('../../../packages/plugin-theme/src/settings.ts', async (original) => {
  const actual = await original<typeof settings>()
  return { ...actual, writesFor: vi.fn(actual.writesFor) }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** The repository's `delorun/` directory; a path, since the jsdom environment rewrites `new URL(…, import.meta.url)`. */
const DELORUN = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The parts of the `yaml` package the config editor uses to write a profile patch. */
interface YamlLibrary {
  parseDocument(text: string): { contents: { flow: boolean }; add(node: object): void; createNode(value: object): object; toString(): string }
  parse(text: string): unknown
}

/** The `yaml` package as the config editor resolves it. */
const yaml: YamlLibrary = createRequire(resolve(DELORUN, '../packages/boot/config-editor/package.json'))('yaml')

/**
 * The entry as the config editor writes it into an empty profile patch.
 * @param config - the entry's config.
 * @returns the file's text.
 */
function editorYaml(config: Record<string, unknown>): string {
  const document = yaml.parseDocument('[]\n')
  document.contents.flow = false
  document.add(document.createNode({ id: THEME_ROW_ID, name: THEME_PLUGIN, config }))
  return document.toString()
}

const look = (patch: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...patch })
const OCEAN = look({ look: 'ocean' })
const MOSS = look({ look: 'custom', accent: 'moss' })

/**
 * The strip after the page showed each look in turn.
 * @param looks - the looks.
 * @returns the strip.
 */
function after(...looks: Look[]): StripState {
  return looks.reduce((state, next, index) => record(state, next, Date.UTC(2026, 10, 17, 9, index)), START)
}

describe('the strip and the studio agree', () => {
  it('offers the studio\'s themes, accents and densities, with the studio\'s names', () => {
    expect(KNOWN_LOOKS).toEqual(PALETTES)
    expect(KNOWN_ACCENTS).toEqual(ACCENT_CHOICES.filter(choice => choice !== 'custom'))
    expect(KNOWN_DENSITIES).toEqual(DENSITIES)
    expect(themeName(look({ look: 't3-code' }))).toBe('Slate')
    expect(themeName(look({ look: 't3-chat' }))).toBe('Berry')
    expect(themeName(MOSS)).toBe('Custom moss')
  })

  it('writes the studio\'s contrast value for each of the site\'s contrast stops', () => {
    expect(STOP_CONTRAST.default).toBe(CONTRAST.default)
    for (const [stop, share] of Object.entries(CONTRAST_STOPS)) {
      const value = STOP_CONTRAST[stop as keyof typeof CONTRAST_STOPS]
      expect((value - CONTRAST.default) / (CONTRAST.max - CONTRAST.default), stop).toBeCloseTo(share)
      expect(value % CONTRAST.step, stop).toBe(0)
    }
  })

  it('starts from a fresh studio and the studio bundle\'s own row', () => {
    expect(FRESH_STUDIO).toEqual({ palette: DEFAULT_SETTINGS.palette, accent: DEFAULT_SETTINGS.accent, customAccent: DEFAULT_SETTINGS.customAccent, contrast: DEFAULT_SETTINGS.contrast, density: DEFAULT_SETTINGS.density })
    const bundle = yaml.parse(readFileSync(resolve(DELORUN, 'packages/bundle-studio/cordis.patch.yml'), 'utf8')) as Array<{ insert?: Array<{ id: string; name: string; config?: unknown }> }>
    const row = bundle.flatMap(each => each.insert ?? []).find(each => each.id === THEME_ROW_ID)
    expect(row).toEqual({ id: THEME_ROW_ID, name: THEME_PLUGIN, config: BUNDLE_CONFIG })
  })

  it('takes its keys from the Theme plugin\'s writesFor', () => {
    vi.mocked(settings.writesFor).mockClear()
    after(OCEAN, MOSS)
    expect(vi.mocked(settings.writesFor).mock.calls.map(([change]) => change)).toEqual([
      { kind: 'palette', palette: 'ocean' },
      { kind: 'custom', values: { accent: 'moss', contrast: 100 } },
    ])
  })

  it('prints the entry as the editor\'s YAML library does', () => {
    for (const state of [after(OCEAN), after(OCEAN, MOSS), after(OCEAN, MOSS, OCEAN), after(look({ density: 'spacious' }), look({ look: 'custom', contrast: 'highest' }))]) {
      const entry = state.entry ?? []
      expect(entryYaml(entry)).toBe(editorYaml(Object.fromEntries(entry)))
    }
  })
})

describe('the entry', () => {
  it('holds only the keys a change wrote, over the bundle\'s row', () => {
    expect(START.entry).toBeUndefined()
    expect(entryYaml(after(OCEAN).entry ?? [])).toBe('- id: delorun-theme\n  name: "@delorun/plugin-theme"\n  config:\n    studioAdditions: true\n    palette: ocean\n')
  })

  it('writes the custom theme whole and keeps its keys after going back', () => {
    const custom = after(OCEAN, MOSS)
    expect(custom.entry).toEqual([['studioAdditions', true], ['palette', 'custom'], ['accent', 'moss'], ['customAccent', settings.PRESET_ACCENT_HEX.ocean], ['contrast', 100]])
    // The settings service puts the keys it holds in the schema's order before the next write.
    expect(after(OCEAN, MOSS, OCEAN).entry).toEqual([['accent', 'moss'], ['customAccent', settings.PRESET_ACCENT_HEX.ocean], ['studioAdditions', true], ['palette', 'ocean'], ['contrast', 100]])
  })

  it('removes the entry when its config equals the bundle\'s row', () => {
    expect(applyWrites(undefined, [])).toBeUndefined()
  })

  it('makes no change for light or dark', () => {
    expect(changesBetween(DEFAULT_LOOK, look({ scheme: 'dark' }))).toEqual([])
    const dark = after(OCEAN, look({ look: 'ocean', scheme: 'dark' }))
    expect(dark.versions).toHaveLength(1)
  })
})

describe('the versions', () => {
  it('lists each change as the studio titles it, collapses repeats and keeps every version', () => {
    expect(originOf(STILL.state.versions[0]?.summary ?? '').origin).toBe('other')
    const state = after(OCEAN, MOSS, OCEAN)
    const rows = versionRows(state.versions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ count: 3, version: { current: true } })
    expect(fill('{count} identical changes in a row', { count: String(rows[0]?.count) })).toBe('3 identical changes in a row')
  })

  it('goes back to the look before the latest change, by its name', () => {
    expect(earlierLook(START)).toBeUndefined()
    expect(earlierLook(after(OCEAN))).toEqual(DEFAULT_LOOK)
    const state = after(OCEAN, MOSS)
    expect(earlierLook(state)).toEqual(OCEAN)
    expect(differenceName(OCEAN, MOSS)).toBe('Ocean')
    expect(differenceName(DEFAULT_LOOK, look({ density: 'spacious' }))).toBe('comfortable density')
    expect(differenceName(look({ look: 'custom' }), look({ look: 'custom', contrast: 'high' }))).toBe('contrast 100%')
  })
})

describe('the strip on the page', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => { root.render(createElement(SetupStrip)) })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    act(() => { resetLook() })
    vi.unstubAllGlobals()
  })

  const radio = (group: string, name: string): HTMLButtonElement => {
    const box = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(each => each.getAttribute('aria-label') === group || document.getElementById(each.getAttribute('aria-labelledby') ?? '')?.textContent === group)
    const found = [...box?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []].find(each => each.textContent?.includes(name))
    if (found === undefined) throw new Error(`no ${name} in ${group}`)
    return found
  }
  const press = (button: HTMLButtonElement): void => { act(() => { button.focus(); button.click() }) }
  const status = (): string => host.querySelector('[data-strip-announce]')?.textContent ?? ''

  it('changes the page, writes the entry, lists a version and goes back by name', () => {
    press(radio(studio.palette, 'Ocean'))
    expect(document.documentElement.dataset['look']).toBe('ocean')
    expect(host.querySelector('pre')?.textContent).toContain('palette: ocean')
    expect(status()).toBe('Ocean. The entry and a new version are listed beside the controls.')
    press(radio(studio.accent, 'Moss'))
    expect(document.documentElement.dataset['accent']).toBe('moss')
    const back = [...host.querySelectorAll('button')].find(each => each.textContent === 'Back to Ocean')
    expect(back).toBeDefined()
    act(() => { back?.focus(); back?.click() })
    expect(document.documentElement.dataset['look']).toBe('ocean')
    expect(document.activeElement?.textContent).toBe('Back to Custom moss')
    expect(host.querySelector('[data-current="true"]')?.textContent).toContain('3 identical changes in a row')
  })

  it('records a change made with the header\'s control too', () => {
    act(() => { setLook(look({ look: 'iris' })) })
    expect(host.querySelector('pre')?.textContent).toContain('palette: iris')
    expect(status()).toBe('')
  })
})

describe('the still for scripts off', () => {
  it('draws the strip after choosing Ocean, with its caption', () => {
    const html = renderToStaticMarkup(createElement(SetupStrip))
    const still = html.slice(html.indexOf('<noscript>'))
    expect(still).toContain('data-look="ocean"')
    expect(still).toContain('palette: ocean')
    expect(still).toContain('With scripts on')
    expect(STILL.name).toBe('Ocean')
  })
})

describe('the spread', () => {
  it('covers the window from any point', () => {
    expect(coverRadius({ x: 0, y: 0 }, 300, 400)).toBe(500)
    expect(coverRadius({ x: 150, y: 200 }, 300, 400)).toBe(250)
  })
})
