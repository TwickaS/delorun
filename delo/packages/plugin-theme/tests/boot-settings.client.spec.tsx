// @vitest-environment jsdom
/** The settings the host half prints into the page: read back only when every field is one the configuration accepts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_SETTINGS_GLOBAL, parseBootSettings, readBootSettings } from '../src/boot-settings.ts'
import { CONTRAST, DEFAULT_SETTINGS, type ThemeSettings } from '../src/config.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const PRINTED: ThemeSettings = { ...DEFAULT_SETTINGS, studioAdditions: true, palette: 'grove', accent: 'custom', customAccent: '#123456', contrast: CONTRAST.max }

describe('the printed theme settings', () => {
  it('reads back every field of valid settings, and nothing else the value carries', () => {
    expect(parseBootSettings({ ...PRINTED, extra: 1 })).toEqual(PRINTED)
    expect(parseBootSettings({ ...PRINTED, contrast: CONTRAST.min })).toEqual({ ...PRINTED, contrast: CONTRAST.min })
  })

  it.each([
    ['not an object', 'studio'],
    ['null', null],
    ['an unknown accent', { ...PRINTED, accent: 'teal' }],
    ['a custom accent that is not text', { ...PRINTED, customAccent: 0x123456 }],
    ['an unknown typeface', { ...PRINTED, typeface: 'serif' }],
    ['an unknown density', { ...PRINTED, density: 'tight' }],
    ['a switch that is not a boolean', { ...PRINTED, studioAdditions: 'yes' }],
    ['an unknown palette', { ...PRINTED, palette: 'neon' }],
    ['an unknown effort display', { ...PRINTED, effort: 'dots' }],
    ['a contrast that is not a number', { ...PRINTED, contrast: '100' }],
    ['a contrast below the range', { ...PRINTED, contrast: CONTRAST.min - 1 }],
    ['a contrast above the range', { ...PRINTED, contrast: CONTRAST.max + 1 }],
    ['a contrast that is not a number at all', { ...PRINTED, contrast: Number.NaN }],
    ['a missing field', { ...PRINTED, effort: undefined }],
  ])('refuses %s', (_name, value) => {
    expect(parseBootSettings(value)).toBeUndefined()
  })

  it('reads the page global, which is absent from a page served with the stock look', () => {
    const page = {}
    expect(readBootSettings(page)).toBeUndefined()
    Reflect.set(page, BOOT_SETTINGS_GLOBAL, PRINTED)
    expect(readBootSettings(page)).toEqual(PRINTED)
    expect(readBootSettings()).toBeUndefined()
  })

  it('warns and reads nothing when the page global does not validate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readBootSettings({ [BOOT_SETTINGS_GLOBAL]: { ...PRINTED, density: 'tight' } })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(BOOT_SETTINGS_GLOBAL))
  })
})
