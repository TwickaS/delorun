/**
 * Regenerates `src/palette/stock.ts` from upstream's token sheet and the
 * built-in font stacks in `base.css`. Run it after
 * an upstream merge changes `design-platform.css`; `tests/palette.spec.ts`
 * fails until the copy matches.
 *
 * Usage: `node_modules/.bin/tsx delorun/packages/plugin-theme/scripts/sync-stock-palette.ts`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseRootTokens, parseStockTokens } from '../src/palette/stock-css.ts'

const STYLES = '../../../../packages/client/ui-theme/src/styles/'
const SHEET = fileURLToPath(new URL(`${STYLES}design-platform.css`, import.meta.url))
const BASE = fileURLToPath(new URL(`${STYLES}base.css`, import.meta.url))
const TARGET = fileURLToPath(new URL('../src/palette/stock.ts', import.meta.url))

const stock = parseStockTokens(readFileSync(SHEET, 'utf8'))
const root = parseRootTokens(readFileSync(BASE, 'utf8'))
const FONT_STACKS = ['--dsh-font-family-text-default', '--dsh-font-family-code-default'] as const
const lines = (values: Readonly<Record<string, string>>): string =>
  Object.entries(values).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`).join('\n')

writeFileSync(TARGET, `/**
 * Upstream's token values for both colour schemes, copied from
 * \`packages/client/ui-theme/src/styles/design-platform.css\` by
 * \`scripts/sync-stock-palette.ts\`. Do not edit by hand; the palette spec
 * fails when this copy and the sheet differ.
 * @module @delorun/plugin-theme/palette/stock
 */
import type { StockTokens } from './stock-css.ts'

/** Upstream's \`body\` and \`body[data-ds-dark-theme]\` token values. */
export const STOCK_TOKENS: StockTokens = {
  light: {
${lines(stock.light)}
  },
  dark: {
${lines(stock.dark)}
  },
}

/** Upstream's built-in text and code font stacks, from \`base.css\`'s \`:root\`. */
export const STOCK_FONT_STACKS: Readonly<Record<'text' | 'code', string>> = {
  text: ${JSON.stringify(root[FONT_STACKS[0]])},
  code: ${JSON.stringify(root[FONT_STACKS[1]])},
}
`)
