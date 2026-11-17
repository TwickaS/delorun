/**
 * The replica's scoped token block: the studio's `--dsw-*` and `--delorun-*` values that the replica's stylesheets read (and every token
 * those values refer to), for every look the site offers in light and dark, scoped to the replica's wrapper. It is made
 * at build time from the Theme plugin's own data (`STOCK_TOKENS`, the layers `themeLayers` gives a look, and upstream's
 * base sheets), for the looks and selectors `site-design`'s looks stylesheet uses, so the replica follows the visitor's
 * look as the studio would draw it. The block is a virtual module of the build, never a file in the repository.
 *
 * The page's root carries the look (`data-look`, and `data-accent` for the custom look; no attribute reads as Soft) and
 * the `dark` class. The wrapper's own rule holds Soft light in full; `.dark` holds what Soft dark changes; each other
 * look holds only what it changes from Soft in the same scheme. The brand's `--dl-*` roles that read a studio token are
 * declared again on the wrapper, so brand pieces inside it follow the scoped values. The contrast stops of the custom
 * look are not carried: the replica draws every look at its default contrast.
 * @module @delorun/website/replica/build/tokens
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type ThemeSettings } from '../../../../../packages/plugin-theme/src/config.ts'
import { applyLayers, type SchemeValues } from '../../../../../packages/plugin-theme/src/palette/generate.ts'
import { themeLayers } from '../../../../../packages/plugin-theme/src/palette/layers.ts'
import { STOCK_TOKENS } from '../../../../../packages/plugin-theme/src/palette/stock.ts'
import { LOOKS, selector, type Look } from '../../../../../packages/site-design/scripts/looks.ts'
import { WRAPPER_SELECTOR } from '../wrapper.ts'

type Values = Record<string, string>

/**
 * A stylesheet's read of a studio token: upstream's `--dsw-*` values, and the `--delorun-*` steps (spacing, density) the
 * Delorun look adds, which Delorun's own sections read for their padding.
 */
const STUDIO_TOKEN = /var\((--(?:dsw|delorun)-[\w-]+)/g

/** Where the block's inputs are, as absolute paths. */
export interface TokenInputs {
  /** Directories, or single `.css` files, the replica loads; every `var(--dsw-*)` and `var(--delorun-*)` they read is kept. */
  readonly stylesheets: readonly string[]
  /** Upstream's `ui-theme/src/styles/` directory, whose base sheets set tokens outside the token data. */
  readonly upstreamStyles: string
  /** The brand's `tokens.css`. */
  readonly brandTokens: string
}

/**
 * The block's inputs in this repository.
 * @param root - the repository's root, ending in `/`.
 * @param replica - the replica's own directory, `apps/website/src/replica/`.
 * @returns the inputs.
 */
export function tokenInputs(root: string, replica: string): TokenInputs {
  return {
    stylesheets: [`${root}packages/client/ui-primitives/src`, `${root}packages/client/ui-approval/src`, `${root}delorun/packages/plugin-changes/src`, `${root}delorun/packages/bundle-local/src/client`, `${root}delorun/packages/brand/src`, replica],
    upstreamStyles: `${root}packages/client/ui-theme/src/styles`,
    brandTokens: `${root}delorun/packages/brand/src/tokens.css`,
  }
}

/**
 * The custom properties each rule of a stylesheet declares.
 * @param css - the stylesheet.
 * @returns the rules, by selector.
 */
function rules(css: string): { readonly selector: string, readonly values: Values }[] {
  const found: { selector: string, values: Values }[] = []
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const values: Values = {}
    for (const declaration of match[2]!.split(';')) {
      const colon = declaration.indexOf(':')
      const name = declaration.slice(0, colon).trim()
      if (colon >= 0 && name.startsWith('--')) values[name] = declaration.slice(colon + 1).trim().replace(/\s+/g, ' ')
    }
    found.push({ selector: match[1]!.trim(), values })
  }
  return found
}

/**
 * Every `.css` file under a directory.
 * @param dir - the directory, or one `.css` file.
 * @returns the files' absolute paths.
 */
function stylesheets(dir: string): string[] {
  if (dir.endsWith('.css')) return [dir]
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : stylesheets(path)
    return name.endsWith('.css') ? [path] : []
  })
}

/**
 * Every token a set of names refers to, followed through `var()` references.
 * @param names - the names read.
 * @param schemes - each scheme's values.
 * @returns the names with every name their values refer to.
 */
function closure(names: Iterable<string>, schemes: readonly SchemeValues[]): Set<string> {
  const all = new Set<string>()
  const queue = [...names]
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (all.has(name)) continue
    all.add(name)
    for (const scheme of schemes) for (const match of (scheme[name] ?? '').matchAll(/var\((--[\w-]+)/g)) queue.push(match[1]!)
  }
  return all
}

/**
 * One rule with the given declarations.
 * @param select - the selector.
 * @param values - the declarations.
 * @param extra - declarations that are not tokens.
 * @returns the rule's text, or nothing when it has no declarations.
 */
function block(select: string, values: Values, extra = ''): string {
  const body = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}:${value}`).join(';')
  return body === '' && extra === '' ? '' : `${select}{${extra}${body}}\n`
}

/**
 * The values of a look in one scheme: upstream's stock values, the base sheets' tokens and the look's layers.
 * @param look - the look.
 * @param scheme - the scheme.
 * @param extras - the base sheets' tokens of the scheme.
 * @returns every token's value.
 */
function lookValues(look: Look, scheme: 'light' | 'dark', extras: Values): Values {
  const settings: ThemeSettings = { ...DEFAULT_SETTINGS, studioAdditions: true, palette: look.palette, ...look.accent === undefined ? {} : { accent: look.accent } }
  const layers = Object.values(themeLayers(settings)).filter(layer => layer !== undefined)
  return { ...extras, ...applyLayers(STOCK_TOKENS, layers, scheme) }
}

/**
 * The values that differ from a base.
 * @param values - the values.
 * @param base - the base.
 * @param names - the names to keep.
 * @returns the kept names whose value differs.
 */
function delta(values: Values, base: Values, names: ReadonlySet<string>): Values {
  return Object.fromEntries(Object.entries(values).filter(([name, value]) => names.has(name) && base[name] !== value))
}

/**
 * Build the token block.
 * @param inputs - where the inputs are.
 * @param looks - `all` for the live studio's block; `soft` for the still the server inlines in the page, which holds
 *   Soft in both schemes and no brand roles, for the stylesheets `inputs` names alone. With scripts off the page is
 *   always Soft, and the brand pieces of the still keep the page's own look until the live studio replaces them.
 * @returns the stylesheet's text.
 */
export function buildTokens(inputs: TokenInputs, looks: 'all' | 'soft' = 'all'): string {
  const read = new Set<string>()
  for (const dir of inputs.stylesheets) for (const file of stylesheets(dir)) for (const match of readFileSync(file, 'utf8').matchAll(STUDIO_TOKEN)) read.add(match[1]!)
  const brandRoles = rules(readFileSync(inputs.brandTokens, 'utf8')).filter(rule => rule.selector === ':where(:root)').flatMap(rule => Object.entries(rule.values))
  const brand = Object.fromEntries(brandRoles.filter(([, value]) => value.includes('var(--dsw-')))
  if (looks === 'all') for (const value of Object.values(brand)) for (const match of value.matchAll(STUDIO_TOKEN)) read.add(match[1]!)

  const extras = { light: {} as Values, dark: {} as Values }
  for (const file of ['base.css', 'focus.css', 'gradient-shadow-text.css']) {
    for (const rule of rules(readFileSync(join(inputs.upstreamStyles, file), 'utf8'))) {
      if (rule.selector === ':root' || rule.selector === 'body') Object.assign(extras.light, rule.values)
      else if (rule.selector === 'body[data-ds-dark-theme]') Object.assign(extras.dark, rule.values)
    }
  }
  extras.dark = { ...extras.light, ...extras.dark }

  const soft = LOOKS.find(look => look.palette === 'soft')
  if (soft === undefined) throw new Error('replica tokens: the looks list has no Soft look')
  const softLight = lookValues(soft, 'light', extras.light)
  const softDark = lookValues(soft, 'dark', extras.dark)
  const names = closure(read, [softLight, softDark, ...LOOKS.flatMap(look => [lookValues(look, 'light', extras.light), lookValues(look, 'dark', extras.dark)])])
  const at = WRAPPER_SELECTOR
  const softBlocks = block(at, delta(softLight, {}, names), 'color-scheme:light;') + block(`.dark ${at}`, delta(softDark, softLight, names), 'color-scheme:dark;')
  if (looks === 'soft') return softBlocks
  let css = softBlocks + block(at, brand)
  for (const look of LOOKS) {
    if (look === soft) continue
    css += block(`${selector(look)}:not(.dark) ${at}`, delta(lookValues(look, 'light', extras.light), softLight, names))
      + block(`${selector(look)}.dark ${at}`, delta(lookValues(look, 'dark', extras.dark), softDark, names))
  }
  return css
}
