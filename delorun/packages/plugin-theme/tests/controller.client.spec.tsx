// @vitest-environment jsdom
/** The controller lays the theme layers, the faces and the effort mark for settings that have the studio additions on, and removes them all otherwise. */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOAST_POSITION_ATTRIBUTE } from '../src/config.ts'
import { LAYERS, PLUGIN_ID, ThemeController } from '../src/client/controller.ts'
import { effortBarsCss, EFFORT_ATTRIBUTE } from '../src/client/effort.ts'
import type { TokenLayer } from '../src/palette/generate.ts'
import { STUDIO_ON } from './theme-form.client.ts'

afterEach(() => {
  document.head.replaceChildren()
  document.documentElement.removeAttribute(EFFORT_ATTRIBUTE)
  document.documentElement.removeAttribute(TOAST_POSITION_ATTRIBUTE)
})

function controller() {
  const layers = new Map<string, TokenLayer>()
  const theme = { overrideTokens: (source: string, tokens: TokenLayer) => { layers.set(source, tokens); return () => { layers.delete(source) } } }
  return { layers, controller: new ThemeController(theme, '/* faces */', document) }
}

describe('the theme controller', () => {
  it('lays the layers and the faces, replaces a layer whose settings changed, and skips an equal set', () => {
    const { layers, controller: theme } = controller()
    theme.update(STUDIO_ON)
    expect([...layers.keys()]).toEqual([LAYERS.palette, LAYERS.accent, LAYERS.type, LAYERS.density])
    const accent = layers.get(LAYERS.accent)
    theme.update({ ...STUDIO_ON })
    expect(layers.get(LAYERS.accent)).toBe(accent)
    theme.update({ ...STUDIO_ON, accent: 'moss' })
    expect(layers.get(LAYERS.accent)).not.toBe(accent)
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(1)
    expect(document.head.querySelector('style')?.textContent).toBe('/* faces */')
  })

  it('marks <html> for the effort bars only while the studio additions are on', () => {
    const { layers, controller: theme } = controller()
    theme.update({ ...STUDIO_ON, effort: 'bars' })
    expect(document.documentElement.getAttribute(EFFORT_ATTRIBUTE)).toBe('bars')
    theme.update({ ...DEFAULT_SETTINGS, effort: 'bars' })
    expect(document.documentElement.hasAttribute(EFFORT_ATTRIBUTE)).toBe(false)
    expect(layers.size).toBe(0)
    expect(document.head.querySelector('style')).toBeNull()
  })

  it('sets the toast position on <html> only while the studio additions are on', () => {
    const { controller: theme } = controller()
    theme.update({ ...STUDIO_ON, toastPosition: 'top-right' })
    expect(document.documentElement.getAttribute(TOAST_POSITION_ATTRIBUTE)).toBe('top-right')
    theme.update({ ...DEFAULT_SETTINGS, toastPosition: 'top-right' })
    expect(document.documentElement.hasAttribute(TOAST_POSITION_ATTRIBUTE)).toBe(false)
    theme.update({ ...STUDIO_ON, toastPosition: 'bottom-centre' })
    theme.dispose()
    expect(document.documentElement.hasAttribute(TOAST_POSITION_ATTRIBUTE)).toBe(false)
  })

  it('removes every layer, the faces and the mark on disposal', () => {
    const { layers, controller: theme } = controller()
    theme.update({ ...STUDIO_ON, effort: 'bars' })
    theme.dispose()
    expect(layers.size).toBe(0)
    expect(document.head.querySelector('style')).toBeNull()
    expect(document.documentElement.hasAttribute(EFFORT_ATTRIBUTE)).toBe(false)
    theme.update(STUDIO_ON)
    expect(layers.size).toBeGreaterThan(0)
  })
})

describe('the effort bars', () => {
  it('draw one bar per level for up to eight levels under the <html> mark, filled up to the chosen level', () => {
    const css = effortBarsCss()
    expect(css).toContain(`html[${EFFORT_ATTRIBUTE}='bars'] [data-effort-levels='8']{--delorun-effort-levels:8}`)
    expect(css).toContain(`[data-effort-level='1']{--delorun-effort-level:1}`)
    expect(css).not.toContain("data-effort-levels='9'")
    expect(css).toContain('width:calc(var(--delorun-effort-levels) * 5px - 2px)')
    expect(css).not.toMatch(/#[0-9a-f]{3,6}/i)
  })
})
