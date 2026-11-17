/**
 * The replica's build plugins. They make the replica's virtual modules from the product's own files and point the real
 * studio sections' package imports at the replica's single-file shims:
 *
 * - `virtual:replica-strings`: the drawn studio's text, picked from the product's dictionaries (`strings.ts`).
 * - `virtual:replica-icons`: the sprite symbols and sizes of the icons in `studio/icons.tsx`, from upstream's artwork.
 * - `virtual:replica-tokens.css`: the scoped token block (`tokens.ts`).
 * - `virtual:replica-studio`: the real components in `studio/components.ts`.
 *
 * The real sections' `@deepseek-ai/dsh-client-ui-primitives` and `@delorun/settings-controls` imports resolve to
 * `studio/primitives.ts` and `studio/settings-controls.ts`; inside upstream's primitives, `./icons/index.tsx`,
 * `./useModalLayer.ts` and `react-dom` resolve to `studio/icons.tsx`, `studio/modal-layer.ts` and
 * `studio/inline-portal.ts`. Upstream's primitive sources are reached only through the `#studio/` alias, so only the
 * replica's modules are affected. The dictionaries and the artwork are TypeScript, so they are loaded through Vite with
 * the site's aliases, once per build.
 * @module @delorun/website/replica/build/plugins
 */
import { fileURLToPath } from 'node:url'
import { runnerImport, type Alias, type Plugin } from 'vite'
import { VOCABULARY } from '../../../../../packages/plugin-theme/src/client/vocabulary.ts'
import { REPLICA_ICONS } from '../studio/icon-list.ts'
import { STUDIO_COMPONENTS } from '../studio/components.ts'
import { pickStrings, STRING_SOURCES, type DictionaryModule, type StringSource } from '../strings.ts'
import { buildTokens, tokenInputs } from './tokens.ts'

/** The plugins' options. */
export interface ReplicaBuildOptions {
  /** The site's aliases, `#studio/` among them. */
  readonly aliases: readonly Alias[]
}

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/** The repository's root, with a trailing slash. */
const ROOT = here('../../../../../../')
const STUDIO = here('../studio/')

/** The ids of the virtual modules. */
const MODULES = ['virtual:replica-strings', 'virtual:replica-icons', 'virtual:replica-tokens.css', 'virtual:replica-studio'] as const

/** The real sections whose package imports resolve to the replica's shims. */
const SECTIONS = /\/(?:delorun\/packages\/(?:plugin-changes|bundle-local)|packages\/client\/ui-approval)\/src\//
/** Upstream's primitive sources. */
const PRIMITIVES = /\/packages\/client\/ui-primitives\/src\//

const SECTION_SHIMS: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-client-ui-primitives': `${STUDIO}primitives.ts`,
  '@delorun/settings-controls': `${STUDIO}settings-controls.ts`,
}
const PRIMITIVE_SHIMS: Readonly<Record<string, string>> = {
  './icons/index.tsx': `${STUDIO}icons.tsx`,
  './useModalLayer.ts': `${STUDIO}modal-layer.ts`,
  'react-dom': `${STUDIO}inline-portal.ts`,
}

/** The attributes of an icon's SVG document that its sprite symbol leaves out. */
const DROPPED = new Set(['width', 'height', 'xmlns', 'class', 'aria-hidden'])

/**
 * One sprite symbol from an icon's SVG document, as the studio's sprite makes it.
 * @param id - the symbol id.
 * @param markup - the SVG document.
 * @returns the `<symbol>` markup.
 */
function symbolOf(id: string, markup: string): string {
  const match = /^<svg\b([^>]*)>([\s\S]*)<\/svg>$/.exec(markup.trim())
  if (match === null) throw new Error(`replica icons: ${id} is not one SVG document`)
  const attributes = [...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].filter(([, name]) => !DROPPED.has(name!)).map(([whole]) => whole).join(' ')
  return `<symbol id="${id}" ${attributes}>${match[2]!}</symbol>`
}

/**
 * A file named by the site's `#studio/` alias, or by a path relative to the repository's root.
 * @param file - the alias specifier or the repository-relative path.
 * @returns what an import names: the specifier as it is, or the absolute path.
 */
function specifierOf(file: string): string {
  return file.startsWith('#') ? file : `${ROOT}${file}`
}

/**
 * The plugins.
 * @param options - the site's aliases.
 * @returns the plugins, to be listed before the React plugin.
 */
export function replicaPlugins(options: ReplicaBuildOptions): Plugin[] {
  let loaded: Promise<{ readonly strings: string, readonly icons: string }> | undefined
  const load = async <T>(id: string): Promise<T> => (await runnerImport<T>(id, { configFile: false, logLevel: 'error', resolve: { alias: [...options.aliases] } })).module
  const productModules = () => loaded ??= (async () => {
    const names = Object.keys(STRING_SOURCES) as StringSource[]
    const dictionaries = await Promise.all(names.map((name) => {
      const module = STRING_SOURCES[name].module
      return load<DictionaryModule>(module.startsWith('#') ? module : here(`../${module}`))
    }))
    const strings = pickStrings(Object.fromEntries(names.map((name, index) => [name, dictionaries[index]!])) as Record<StringSource, DictionaryModule>, VOCABULARY)
    const artwork = await load<{ ICON_SYMBOLS: Readonly<Record<string, string>>, ICON_ARTWORK: Readonly<Record<string, { readonly size: number }>> }>('#studio/ui-primitives/src/icons/artwork.ts')
    const symbols = REPLICA_ICONS.map((glyph) => {
      const id = `dsw-icon-${glyph}-regular`
      const markup = artwork.ICON_SYMBOLS[id]
      if (markup === undefined) throw new Error(`replica icons: upstream has no symbol ${id}`)
      return symbolOf(id, markup)
    }).join('')
    const sizes = Object.fromEntries(REPLICA_ICONS.map(glyph => [glyph, artwork.ICON_ARTWORK[glyph]?.size]))
    return {
      strings: `export default ${JSON.stringify(strings)}\n`,
      icons: `export const SYMBOLS = ${JSON.stringify(symbols)}\nexport const SIZES = ${JSON.stringify(sizes)}\n`,
    }
  })()
  return [{
    name: 'delorun-replica',
    enforce: 'pre',
    resolveId(source, importer) {
      if ((MODULES as readonly string[]).includes(source)) return `\0${source}`
      if (importer === undefined) return undefined
      if (SECTIONS.test(importer)) return SECTION_SHIMS[source]
      // A config that aliases React to one copy hands this hook `react-dom` as a path; the portal shim takes it too.
      if (PRIMITIVES.test(importer)) return PRIMITIVE_SHIMS[/(?:^|\/)react-dom(?:\/index\.js)?$/.test(source) ? 'react-dom' : source]
      return undefined
    },
    async load(id) {
      switch (id) {
        case '\0virtual:replica-strings': return (await productModules()).strings
        case '\0virtual:replica-icons': return (await productModules()).icons
        case '\0virtual:replica-tokens.css': return buildTokens(tokenInputs(ROOT, here('../')))
        case '\0virtual:replica-studio': return STUDIO_COMPONENTS.map(component => `export { ${component.name} } from ${JSON.stringify(specifierOf(component.file))}\n`).join('')
        default: return undefined
      }
    },
  }]
}
