/**
 * Distinct glyphs for the two panel toggles under the Delorun look. Upstream draws the sidebar toggle and the side panel toggle
 * with one panel icon (the side panel's mirrored), which also read like Multiview's toggle; these rules paint each toggle's icon
 * with its own artwork through a CSS mask over upstream's stable attributes, so the buttons, their names, tooltips and
 * shortcuts stay upstream's. The sidebar's glyph has list lines in its column; the side panel's is a shaded right-hand
 * column. The artwork matches the product icons' 16 px grid and one-pixel stroke and paints with `currentColor`, so hover,
 * pressed and disabled states and both colour schemes colour it as before. Under forced colours the rules do not apply
 * and upstream's icon shows, since a forced background would hide a mask; the stock look drops the rules.
 * @module @delorun/plugin-theme/client/panel-glyphs
 */

/** The toggles that draw the sidebar's glyph: the header's opener and the sidebar's own toggle. */
export const SIDEBAR_TOGGLES = ['[data-sidebar-opener]', '[data-sidebar-toggle]'] as const

/** The toggles that draw the side panel's glyph: the header's expand button and the panel's collapse button. */
export const SIDE_PANEL_TOGGLES = ['[data-sidebar-right-expand]', '[data-sidebar-right-toggle]'] as const

/** The product icon both toggles use upstream, at any weight. */
const PANEL_ICON = 'svg[data-icon^="dsw-icon-panel-left-outline"]'

/** The frame both glyphs share: the product panel icon's rounded square. */
const FRAME = '<rect x="1.5" y="1.5" width="13" height="13" rx="1"/>'

/** The sidebar: a left column holding three list lines. */
export const SIDEBAR_GLYPH = `${FRAME}<path d="M6.5 1.5v13M3 4.5h1.5M3 6.5h1.5M3 8.5h1.5"/>`

/** The side panel: a shaded right-hand column. */
export const SIDE_PANEL_GLYPH = `${FRAME}<path d="M10 1.5v13"/><rect x="10" y="2" width="4" height="12" fill="#000" fill-opacity=".4" stroke="none"/>`

/**
 * A glyph as a CSS mask image: black strokes on a transparent 16 px square.
 * @param body - the SVG elements.
 * @returns the `url(…)` value.
 */
function maskOf(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round">${body}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/**
 * Paint a glyph on the matched icons and hide the sprite artwork under it.
 * @param selectors - the icons.
 * @param body - the glyph.
 * @returns the CSS text.
 */
function glyphRule(selectors: readonly string[], body: string): string {
  const mask = maskOf(body)
  return `${selectors.join(',')}{background-color:currentColor;-webkit-mask:${mask} center/100% 100% no-repeat;mask:${mask} center/100% 100% no-repeat;transform:none}`
    + `${selectors.map(selector => `${selector}>use`).join(',')}{visibility:hidden}`
}

/**
 * The toggles' glyph rules.
 * @returns the CSS text.
 */
export function panelGlyphsCss(): string {
  const icons = (toggles: readonly string[]): string[] => toggles.map(toggle => `${toggle} ${PANEL_ICON}`)
  return `@media not (forced-colors:active){${glyphRule(icons(SIDEBAR_TOGGLES), SIDEBAR_GLYPH)}${glyphRule(icons(SIDE_PANEL_TOGGLES), SIDE_PANEL_GLYPH)}}`
}

/** The selector of the upstream icon inside a toggle, for specs that check what the rules reach. */
export const PANEL_ICON_SELECTOR = PANEL_ICON
