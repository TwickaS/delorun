/**
 * Reads T3 Code's theme palettes from the text of its
 * `packages/shared/src/themePalettes.ts` without running it: each colour
 * constant and built-in theme definition, as plain role-to-colour records.
 * `scripts/sync-t3-themes.ts` writes the result to `t3-themes.ts`.
 * @module @delo/plugin-theme/palette/t3-source
 */

/** One theme's colours by T3 Code's role names, as CSS colours. */
export type T3Colors = Readonly<Record<string, string>>

/** One T3 Code theme in both schemes. */
export interface T3Theme {
  readonly label: string
  readonly light: T3Colors
  readonly dark: T3Colors
}

/** A `key: "value",` line inside an object literal. */
const ENTRY = /^\s*([A-Za-z][A-Za-z0-9]*): "([^"]*)",?$/
/** A `key: CONSTANT,` line that names a colour constant. */
const REFERENCE = /^\s*([A-Za-z][A-Za-z0-9]*): ([A-Z][A-Z0-9_]*),?$/
/** A `key: {` line that opens a nested object. */
const OPEN = /^\s*([A-Za-z][A-Za-z0-9]*): \{$/
/** An `export const NAME: Type = {` line that opens a top-level constant. */
const CONSTANT = /^export const ([A-Z][A-Z0-9_]*): (ThemeColors|ThemeDefinition) = \{$/

type Node = { [key: string]: string | Node }

/**
 * The first two capture groups of a pattern that matches a whole line.
 * @param pattern - the line pattern.
 * @param line - one line of the file.
 * @returns the groups, or `undefined` when the line does not match; a pattern with one group leaves the second meaningless.
 */
function groups(pattern: RegExp, line: string): readonly [string, string] | undefined {
  let found: readonly [string, string] | undefined
  line.replace(pattern, (_whole, first: string, second: string) => {
    found = [first, second]
    return ''
  })
  return found
}

/**
 * Parse every colour constant and theme definition in the file's text.
 * @param text - the text of T3 Code's `themePalettes.ts`.
 * @returns each constant by its name, as nested records of strings; a theme's `variants.dark` names a constant or holds its colours.
 */
export function parseT3Constants(text: string): ReadonlyMap<string, Node> {
  const constants = new Map<string, Node>()
  let stack: Node[] = []
  for (const line of text.split('\n')) {
    const opened = groups(CONSTANT, line)
    if (opened !== undefined) {
      const root: Node = {}
      constants.set(opened[0], root)
      stack = [root]
      continue
    }
    const top = stack.at(-1)
    if (top === undefined) continue
    if (/^\s*\},?;?$/.test(line)) {
      stack.pop()
      continue
    }
    const open = groups(OPEN, line)
    if (open !== undefined) {
      const child: Node = {}
      top[open[0]] = child
      stack.push(child)
      continue
    }
    const entry = groups(ENTRY, line)
    if (entry !== undefined) {
      top[entry[0]] = entry[1]
      continue
    }
    const reference = groups(REFERENCE, line)
    if (reference !== undefined) top[reference[0]] = `@${reference[1]}`
  }
  return constants
}

function colorsOf(node: Node | string | undefined, constants: ReadonlyMap<string, Node>, name: string): T3Colors {
  const resolved = typeof node === 'string' && node.startsWith('@') ? constants.get(node.slice(1)) : node
  if (resolved === undefined || typeof resolved === 'string') throw new Error(`T3 Code themes: ${name} has no colours`)
  const colors: Record<string, string> = {}
  for (const [role, value] of Object.entries(resolved)) {
    if (typeof value !== 'string') throw new Error(`T3 Code themes: ${name}.${role} is not a colour`)
    colors[role] = value
  }
  return colors
}

/**
 * T3 Code's default theme and its built-in themes, each in both schemes.
 * @param text - the text of T3 Code's `themePalettes.ts`.
 * @returns the themes by T3 Code's ids, the default as `t3-code`.
 */
export function parseT3Themes(text: string): Readonly<Record<string, T3Theme>> {
  const constants = parseT3Constants(text)
  const themes: Record<string, T3Theme> = {
    't3-code': {
      label: 'T3 Code',
      light: colorsOf(constants.get('T3_CODE_LIGHT_THEME_COLORS'), constants, 'T3_CODE_LIGHT_THEME_COLORS'),
      dark: colorsOf(constants.get('T3_CODE_DARK_THEME_COLORS'), constants, 'T3_CODE_DARK_THEME_COLORS'),
    },
  }
  for (const [name, node] of constants) {
    if (!name.endsWith('_THEME')) continue
    const { id, label, appearance } = node
    if (typeof id !== 'string' || typeof label !== 'string' || (appearance !== 'light' && appearance !== 'dark')) {
      throw new Error(`T3 Code themes: ${name} lacks an id, label or appearance`)
    }
    const variants = node.variants
    const other = appearance === 'light' ? 'dark' : 'light'
    const own = colorsOf(node.colors, constants, `${name}.colors`) // us-spelling: quoted output (the theme source's property name)
    const variant = colorsOf(typeof variants === 'object' ? variants[other] : undefined, constants, `${name}.variants.${other}`)
    themes[id] = { label, light: appearance === 'light' ? own : variant, dark: appearance === 'dark' ? own : variant }
  }
  return themes
}
