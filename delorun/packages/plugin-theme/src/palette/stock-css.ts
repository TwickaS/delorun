/**
 * Reads upstream's token sheet (`@deepseek-ai/dsh-client-ui-theme`'s
 * `design-platform.css`) into the custom-property values each colour scheme
 * resolves on `body`: the light declarations, and the dark declarations laid
 * over them. Platform-specific blocks are left out. The sync script and the
 * palette specs use it; the studio never parses CSS.
 * @module @delorun/plugin-theme/palette/stock-css
 */

/** Custom-property values by name, for one colour scheme. */
export type TokenValues = Readonly<Record<string, string>>

/** The stock token values of both colour schemes. */
export interface StockTokens {
  /** Values while the light palette is active. */
  readonly light: TokenValues
  /** Values while the dark palette is active (`body[data-ds-dark-theme]`). */
  readonly dark: TokenValues
}

const LIGHT_SELECTOR = 'body'
const DARK_SELECTOR = 'body[data-ds-dark-theme]'

/** One rule of a sheet: its selector and the custom properties it declares. */
interface Rule {
  readonly selector: string
  readonly declarations: TokenValues
}

/**
 * Split a sheet into its flat rules, without comments. A declaration that is not a custom property is dropped.
 * @param css - the sheet's text.
 * @returns the rules in source order.
 */
function rulesOf(css: string): readonly Rule[] {
  const rules: Rule[] = []
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{([^{}]*)\}/g, (_whole, selector: string, body: string) => {
    const declarations: Record<string, string> = {}
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')
      const name = declaration.slice(0, colon).trim()
      if (colon >= 0 && name.startsWith('--')) declarations[name] = declaration.slice(colon + 1).trim().replace(/\s+/g, ' ')
    }
    rules.push({ selector: selector.trim(), declarations })
    return ''
  })
  return rules
}

/**
 * Read the custom properties a sheet declares on `:root`, such as the
 * built-in font stacks in upstream's `base.css`.
 * @param css - the sheet's text.
 * @returns the `:root` values by name.
 */
export function parseRootTokens(css: string): TokenValues {
  return Object.freeze(Object.assign({}, ...rulesOf(css).filter(rule => rule.selector === ':root').map(rule => rule.declarations)))
}

/**
 * Parse upstream's token sheet.
 * @param css - the text of `design-platform.css`.
 * @returns each scheme's custom-property values; a selector other than plain `body` and its dark variant is ignored.
 * @throws Error when the sheet has no light or no dark block, which means upstream changed the sheet's structure.
 */
export function parseStockTokens(css: string): StockTokens {
  const rules = rulesOf(css)
  const lightRules = rules.filter(rule => rule.selector === LIGHT_SELECTOR)
  const darkRules = rules.filter(rule => rule.selector === DARK_SELECTOR)
  if (lightRules.length === 0 || darkRules.length === 0) throw new Error('design-platform.css has no body or no body[data-ds-dark-theme] block')
  const light: TokenValues = Object.assign({}, ...lightRules.map(rule => rule.declarations))
  const dark: TokenValues = Object.assign({}, ...darkRules.map(rule => rule.declarations))
  return { light: Object.freeze(light), dark: Object.freeze({ ...light, ...dark }) }
}
