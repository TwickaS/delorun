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
import { en as versionsCopy } from '../../../packages/bundle-local/src/client/versions-locales.ts'
import { STRIP_COPY } from '../src/strip/copy.ts'
import { applyWrites, arrive, BUNDLE_CONFIG, earlierLook, editedName, entryYaml, FRESH_STUDIO, pressesTo, record, START, STOP_CONTRAST, THEME_PLUGIN, versionRows, type StripState } from '../src/strip/model.ts'
import { differenceName, themeName } from '../src/strip/names.ts'
import SetupStrip, { fill } from '../src/strip/setup-strip.tsx'
import { SetupStripStill, STILL_ENTRY, STILL_LOOK_ID } from '../src/strip/still.tsx'
import { coverRadius, spread, SPREAD_CLASS } from '../src/strip/spread.ts'

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
      { kind: 'palette', palette: 'custom' },
      { kind: 'custom', values: { accent: 'moss' } },
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
    // The settings service puts the keys it holds in the schema's order before the next write.
    expect(after(OCEAN, MOSS).entry).toEqual([['accent', 'moss'], ['customAccent', settings.PRESET_ACCENT_HEX.ocean], ['studioAdditions', true], ['palette', 'custom'], ['contrast', 100]])
    expect(after(OCEAN, MOSS, OCEAN).entry).toEqual([['accent', 'moss'], ['customAccent', settings.PRESET_ACCENT_HEX.ocean], ['studioAdditions', true], ['palette', 'ocean'], ['contrast', 100]])
  })

  it('removes the entry when its config equals the bundle\'s row', () => {
    expect(applyWrites(undefined, [])).toBeUndefined()
  })

  it('makes no change for light or dark', () => {
    expect(pressesTo(START, look({ scheme: 'dark' }))).toEqual([])
    const dark = after(OCEAN, look({ look: 'ocean', scheme: 'dark' }))
    expect(dark.versions).toHaveLength(1)
  })
})

describe('the versions', () => {
  it('lists each change as the studio titles it, collapses repeats and keeps every version', () => {
    expect(originOf(after(OCEAN).versions[0]?.summary ?? '').origin).toBe('other')
    const state = after(OCEAN, MOSS, OCEAN)
    const rows = versionRows(state.versions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ count: 4, version: { current: true } })
    expect(fill('{count} identical changes in a row', { count: String(rows[0]?.count) })).toBe('4 identical changes in a row')
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

describe('the studio\'s presses', () => {
  const CUSTOM = look({ look: 'custom' })

  it('passes through Custom in the preset\'s colour on the way from a preset, one version a press', () => {
    expect(pressesTo(after(OCEAN), MOSS)).toEqual([{ kind: 'palette', palette: 'custom' }, { kind: 'custom', values: { accent: 'moss' } }])
    expect(pressesTo(after(OCEAN), CUSTOM)).toEqual([{ kind: 'palette', palette: 'custom' }, { kind: 'custom', values: { accent: 'peach' } }])
    expect(pressesTo(START, CUSTOM)).toEqual([{ kind: 'palette', palette: 'custom' }])
    const state = after(OCEAN, CUSTOM, MOSS)
    expect(state.versions).toHaveLength(4)
    expect(state.entry).toEqual([['accent', 'moss'], ['customAccent', settings.PRESET_ACCENT_HEX.ocean], ['studioAdditions', true], ['palette', 'custom'], ['contrast', 100]])
  })

  it('starts Custom afresh after a preset, as the studio does', () => {
    const state = after(look({ look: 'custom', accent: 'moss', contrast: 'high' }), OCEAN)
    expect(pressesTo(state, CUSTOM)).toEqual([{ kind: 'palette', palette: 'custom' }, { kind: 'custom', values: { accent: 'peach' } }])
  })

  it('brings Soft back after Custom moss, and a preset back after a higher contrast', () => {
    const soft = after(MOSS, DEFAULT_LOOK)
    expect(settings.lookOf(soft.stored)).toMatchObject({ palette: 'soft', accent: 'peach', contrast: 100 })
    const ocean = after(look({ look: 'custom', accent: 'moss', contrast: 'highest' }), OCEAN)
    expect(settings.lookOf(ocean.stored)).toMatchObject({ palette: 'ocean', contrast: 100 })
    expect(ocean.entry?.find(([key]) => key === 'contrast')).toEqual(['contrast', 100])
  })

  it('starts from a look carried in the link with its entry and no version', () => {
    const arrived = arrive(OCEAN)
    expect(entryYaml(arrived.entry ?? [])).toContain('palette: ocean')
    expect(arrived.versions).toEqual([])
    expect(earlierLook(arrived)).toBeUndefined()
    expect(earlierLook(record(arrived, MOSS, 0))).toEqual(OCEAN)
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
    expect(status()).toBe('Custom moss. The entry and 2 new versions are listed beside the controls.')
    const back = [...host.querySelectorAll('button')].find(each => each.textContent === 'Back to Ocean')
    expect(back).toBeDefined()
    act(() => { back?.focus(); back?.click() })
    expect(document.documentElement.dataset['look']).toBe('ocean')
    expect(document.activeElement?.textContent).toBe('Back to Custom moss')
    expect(host.querySelector('[data-current="true"]')?.textContent).toContain('4 identical changes in a row')
  })

  it('says light or dark adds no version', () => {
    press(radio(studio.mode, 'Dark'))
    expect(document.documentElement.dataset['scheme']).toBe('dark')
    expect(status()).toBe('Dark. Light or dark is not part of the entry, so no version is added.')
    expect(host.querySelector('[data-current]')).toBeNull()
  })

  it('keeps the focus on the pressed tile and announces each change once', () => {
    const ocean = radio(studio.palette, 'Ocean')
    press(ocean)
    expect(document.activeElement).toBe(ocean)
    expect(host.querySelectorAll('[data-strip-announce] span')).toHaveLength(1)
    press(radio(studio.density, 'Spacious'))
    expect(document.documentElement.dataset['density']).toBe('spacious')
    expect(status()).toBe('Spacious density. The entry and a new version are listed beside the controls.')
  })

  it('records a change made with the header\'s control too', () => {
    act(() => { setLook(look({ look: 'iris' })) })
    expect(host.querySelector('pre')?.textContent).toContain('palette: iris')
    expect(status()).toBe('')
  })
})

describe('the still', () => {
  it('draws the strip after choosing Ocean, with its caption, and loads none of the live strip', () => {
    const html = renderToStaticMarkup(createElement(SetupStripStill))
    expect(html).toContain('data-look="ocean"')
    expect(html).toContain('With scripts on')
    const ocean = { ...DEFAULT_LOOK, look: STILL_LOOK_ID }
    expect(STILL_ENTRY).toBe(entryYaml(after(ocean).entry ?? []))
    expect(themeName(ocean)).toBe('Ocean')
    const source = readFileSync(resolve(DELORUN, 'apps/website/src/strip/still.tsx'), 'utf8')
    expect([...source.matchAll(/^import .* from '([^']+)'$/gm)].map(match => match[1])).toEqual(['@design/looks.ts', './copy.ts', './strip.module.css'])
    expect(readFileSync(resolve(DELORUN, 'apps/website/src/strip/copy.ts'), 'utf8')).not.toMatch(/^import /m)
  })

  it('shows the studio\'s own words, chosen as a fresh studio chooses them', () => {
    const words = STRIP_COPY.en.still
    expect(words.themes).toBe(studio.palette)
    expect(words.theme).toEqual(Object.fromEntries(KNOWN_LOOKS.map(id => [id, studio[`palette.${id}`]])))
    expect(words.mode).toBe(studio.mode)
    expect(words.modes).toEqual([studio['mode.system'], studio['mode.light'], studio['mode.dark']])
    expect(DEFAULT_LOOK.scheme).toBeUndefined()
    expect(words.density).toBe(studio.density)
    expect(words.densities).toEqual(KNOWN_DENSITIES.map(density => studio[`density.${density}`]))
    expect(KNOWN_DENSITIES.indexOf(DEFAULT_LOOK.density)).toBe(1)
    expect(words.versions).toBe(versionsCopy.title)
    expect(words.version).toBe(fill(versionsCopy['version.settings'], { name: editedName() }))
    expect(words.current).toBe(versionsCopy.current)
    expect(words.line).toBe(`09:00 · ${versionsCopy['origin.other']}`)
  })
})

describe('the spread', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--dl-motion-explain')
    Reflect.deleteProperty(document, 'startViewTransition')
  })

  it('covers the window from any point', () => {
    expect(coverRadius({ x: 0, y: 0 }, 300, 400)).toBe(500)
    expect(coverRadius({ x: 150, y: 200 }, 300, 400)).toBe(250)
  })

  it('changes in place where the browser has no view transitions, or motion is reduced to 0ms', () => {
    const update = vi.fn()
    document.documentElement.style.setProperty('--dl-motion-explain', '360ms')
    spread({ x: 10, y: 10 }, update)
    expect(update).toHaveBeenCalledOnce()
    const start = vi.fn()
    Object.assign(document, { startViewTransition: start })
    document.documentElement.style.setProperty('--dl-motion-explain', '0ms')
    spread({ x: 10, y: 10 }, update)
    expect(start).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('spreads from the pressed point through a view transition and tidies up after it', async () => {
    let finish = (): void => undefined
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn((update: () => void) => { update(); return { ready: Promise.resolve(), finished } })
    const animate = vi.fn()
    Object.assign(document, { startViewTransition: start })
    Object.assign(document.documentElement, { animate })
    document.documentElement.style.setProperty('--dl-motion-explain', '360ms')
    const update = vi.fn()
    spread({ x: 0, y: 0 }, update)
    expect(update).toHaveBeenCalledOnce()
    expect(document.documentElement.classList.contains(SPREAD_CLASS)).toBe(true)
    await Promise.resolve()
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 360, pseudoElement: '::view-transition-new(root)' })
    finish()
    await finished
    await Promise.resolve()
    expect(document.documentElement.classList.contains(SPREAD_CLASS)).toBe(false)
  })
})
