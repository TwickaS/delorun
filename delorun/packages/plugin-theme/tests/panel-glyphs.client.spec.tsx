// @vitest-environment jsdom
/** The panel toggles' glyphs: which upstream icons the rules reach, how they paint, and that the stock look drops them. */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { PLUGIN_ID, ThemeController } from '../src/client/controller.ts'
import { PANEL_ICON_SELECTOR, panelGlyphsCss, SIDE_PANEL_GLYPH, SIDE_PANEL_TOGGLES, SIDEBAR_GLYPH, SIDEBAR_TOGGLES } from '../src/client/panel-glyphs.ts'
import { STUDIO_ON } from './theme-form.client.ts'

afterEach(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
})

/** Upstream's markup for the four toggles and two unrelated uses of the same icon. */
function upstreamMarkup(): void {
  const icon = (weight: string) => `<svg data-icon="dsw-icon-panel-left-outline-${weight}"><use href="#dsw-icon-panel-left-outline-${weight}"></use></svg>`
  document.body.innerHTML = [
    `<div><button data-sidebar-opener>${icon('regular')}</button></div>`,
    `<button data-sidebar-toggle><span></span>${icon('regular')}</button>`,
    `<button data-sidebar-right-expand><span>${icon('regular')}</span></button>`,
    `<button data-sidebar-right-toggle>${icon('regular')}</button>`,
    `<nav data-settings-nav>${icon('medium')}</nav>`,
    `<button data-dock-float>${icon('regular')}</button>`,
  ].join('')
}

describe('the panel toggles\' glyphs', () => {
  it('reach the icon in each of the four upstream toggles and no other use of that icon', () => {
    upstreamMarkup()
    const reached = [...SIDEBAR_TOGGLES, ...SIDE_PANEL_TOGGLES].flatMap(toggle => [...document.querySelectorAll(`${toggle} ${PANEL_ICON_SELECTOR}`)])
    expect(reached).toHaveLength(4)
    expect(document.querySelectorAll(PANEL_ICON_SELECTOR)).toHaveLength(6)
    expect(reached.every(icon => icon.closest('[data-settings-nav], [data-dock-float]') === null)).toBe(true)
  })

  it('paint each toggle\'s own artwork in currentColor, unmirrored, and hide the sprite under it, outside forced colours', () => {
    const css = panelGlyphsCss()
    expect(css.startsWith('@media not (forced-colors:active){')).toBe(true)
    expect(css).toContain('background-color:currentColor')
    expect(css).toContain('transform:none')
    expect(css).toContain(encodeURIComponent(SIDEBAR_GLYPH))
    expect(css).toContain(encodeURIComponent(SIDE_PANEL_GLYPH))
    expect(SIDEBAR_GLYPH).not.toBe(SIDE_PANEL_GLYPH)
    for (const toggle of [...SIDEBAR_TOGGLES, ...SIDE_PANEL_TOGGLES]) expect(css).toContain(`${toggle} ${PANEL_ICON_SELECTOR}>use`)
    expect(css).toContain('{visibility:hidden}')
  })

  it('apply only with the Delorun look: the stock look keeps upstream\'s icons', () => {
    const theme = { overrideTokens: () => () => {} }
    const controller = new ThemeController(theme, panelGlyphsCss(), document)
    controller.update(STUDIO_ON)
    expect(document.head.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)?.textContent).toContain('data-sidebar-opener')
    controller.update(DEFAULT_SETTINGS)
    expect(document.head.querySelector('style')).toBeNull()
    controller.dispose()
  })
})
