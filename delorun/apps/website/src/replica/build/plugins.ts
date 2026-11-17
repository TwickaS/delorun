/**
 * The replica's build plugins. They make the replica's virtual modules from the product's own files and point the real
 * studio sections' package imports at the replica's single-file shims:
 *
 * - `virtual:replica-strings`: the drawn studio's text, picked from the product's dictionaries (`strings.ts`).
 * - `virtual:replica-icons`: the sprite symbols and sizes of the icons in `studio/icons.tsx`, from upstream's artwork.
 * - `virtual:replica-tokens.css`: the scoped token block (`tokens.ts`).
 * - `virtual:replica-studio`: the real components in `studio/components.ts`.
 * - `virtual:replica-island`: the live replica's first render as static markup on the server, its styles in the browser.
 *
 * The real sections' `@deepseek-ai/dsh-client-ui-primitives` and `@delorun/settings-controls` imports resolve to
 * `studio/primitives.ts` and `studio/settings-controls.ts`, and their `react-dom` portals render in place; inside upstream's primitives, `./icons/index.tsx`,
 * `./useModalLayer.ts` and `react-dom` resolve to `studio/icons.tsx`, `studio/modal-layer.ts` and
 * `studio/inline-portal.ts`. Upstream's primitive sources are reached only through the `#studio/` alias, so only the
 * replica's modules are affected. The dictionaries and the artwork are TypeScript, so they are loaded through Vite with
 * the site's aliases, once per build.
 * @module @delorun/website/replica/build/plugins
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Alias, type Plugin } from 'vite'
import { VOCABULARY } from '../../../../../packages/plugin-theme/src/client/vocabulary.ts'
import { REPLICA_ICONS } from '../studio/icon-list.ts'
import { STUDIO_COMPONENTS } from '../studio/components.ts'
import { SESSION_IDS, type ReplicaFixture } from '../model.ts'
import { pickStrings, STRING_SOURCES, type DictionaryModule, type StringSource } from '../strings.ts'
import { ALLOW_STANDINS, sessionRefusals, type SessionPolicy } from './release.ts'
import { buildTokens, tokenInputs } from './tokens.ts'

/** The plugins' options. */
export interface ReplicaBuildOptions {
  /** The site's aliases, `#studio/` among them. */
  readonly aliases: readonly Alias[]
  /**
   * The release the site markets. A production build needs it, and fails when a session was recorded on another
   * release or is a hand-made stand-in, unless `SITE_ALLOW_STANDINS=1` is set for a review build (`release.ts`).
   * A development server and tests need neither.
   */
  readonly release?: string | undefined
}

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/** The repository's root, with a trailing slash. */
const ROOT = here('../../../../../../')
const STUDIO = here('../studio/')

/** The ids of the virtual modules. */
const MODULES = ['virtual:replica-strings', 'virtual:replica-icons', 'virtual:replica-tokens.css', 'virtual:replica-studio', 'virtual:replica-island'] as const

/** The real sections whose package imports resolve to the replica's shims. */
const SECTIONS = /\/(?:delorun\/packages\/(?:plugin-changes|bundle-local)|packages\/client\/ui-approval)\/src\//
/** Upstream's primitive sources. */
const PRIMITIVES = /\/packages\/client\/ui-primitives\/src\//

const SECTION_SHIMS: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-client-ui-primitives': `${STUDIO}primitives.ts`,
  '@delorun/settings-controls': `${STUDIO}settings-controls.ts`,
  'react-dom': `${STUDIO}inline-portal.ts`,
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

/** The brand components the replica's still draws outside `packages/brand/src/replica/`. */
const BRAND_STILL_COMPONENTS = ['Frame', 'TabList', 'Button', 'Pill'] as const

/**
 * Every CSS module of a directory and its subdirectories, but a `preview/` one.
 * @param dir - the directory.
 * @returns absolute paths.
 */
function cssModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? entry.name === 'preview' ? [] : cssModules(join(dir, entry.name))
    : entry.name.endsWith('.module.css') ? [join(dir, entry.name)] : [])
}

/**
 * The `virtual:replica-island` module. On the server it renders `ReplicaLive` to static markup, led by a `<style>` with
 * every style the markup uses (the replica's CSS modules and the brand components' it draws, compiled with the same
 * class names), so the markup is styled before any script runs. In the browser it is empty: the live replica's chunk
 * brings its own styles before it replaces the markup.
 * @param server - whether the module is for the server's render.
 * @returns the module's source.
 */
function island(server: boolean): string {
  if (!server) return "export function island() { return '' }\n"
  const styles = [...cssModules(here('../')), ...cssModules(`${ROOT}delorun/packages/brand/src/replica`), ...BRAND_STILL_COMPONENTS.map(name => `${ROOT}delorun/packages/brand/src/components/${name}.module.css`)]
  return `import { createElement } from 'react'\nimport { renderToStaticMarkup } from 'react-dom/server'\nimport { ReplicaLive } from ${JSON.stringify(here('../ReplicaLive.tsx'))}\n`
    + styles.map((file, index) => `import style${String(index)} from ${JSON.stringify(`${file}?inline`)}\n`).join('')
    + `const STYLE = [${styles.map((_, index) => `style${String(index)}`).join(', ')}].join('')\n`
    + 'export function island(props) { return `<style>${STYLE}</style>` + renderToStaticMarkup(createElement(ReplicaLive, props)) }\n'
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
  let production = false
  let refusals: Promise<string[]> | undefined
  const checkSessions = (policy: SessionPolicy) => refusals ??= Promise.all(SESSION_IDS.map(id => load<{ FIXTURE: ReplicaFixture }>(here(`../sessions/${id}.session.ts`))))
    .then(modules => sessionRefusals(modules.map(module => module.FIXTURE), policy))
  return [{
    name: 'delorun-replica',
    enforce: 'pre',
    configResolved(config) {
      production = config.command === 'build' && config.isProduction
    },
    async buildStart() {
      if (!production) return
      if (options.release === undefined) this.error('replica: a production build needs `release` in `replicaPlugins`: the release the site markets.')
      const policy: SessionPolicy = { release: options.release, allowStandIns: process.env[ALLOW_STANDINS] === '1' }
      const refused = await checkSessions(policy)
      if (refused.length > 0) this.error(`replica: a production build carries only sessions recorded on ${policy.release}. ${refused.join(' ')} Set ${ALLOW_STANDINS}=1 only for a review build; a deploy never sets it.`)
    },
    resolveId(source, importer) {
      if ((MODULES as readonly string[]).includes(source)) return `\0${source}`
      if (importer === undefined) return undefined
      // A config that aliases React to one copy hands this hook `react-dom` as a path; the portal shim takes it too.
      const name = /(?:^|\/)react-dom(?:\/index\.js)?$/.test(source) ? 'react-dom' : source
      if (SECTIONS.test(importer)) return SECTION_SHIMS[name]
      if (PRIMITIVES.test(importer)) return PRIMITIVE_SHIMS[name]
      return undefined
    },
    async load(id, options) {
      switch (id) {
        case '\0virtual:replica-island': return island(options?.ssr === true || this.environment.config.consumer === 'server')
        case '\0virtual:replica-strings': return (await productModules()).strings
        case '\0virtual:replica-icons': return (await productModules()).icons
        case '\0virtual:replica-tokens.css': return buildTokens(tokenInputs(ROOT, here('../')))
        case '\0virtual:replica-studio': return STUDIO_COMPONENTS.map(component => `export { ${component.name} } from ${JSON.stringify(specifierOf(component.file))}\n`).join('')
        default: return undefined
      }
    },
  }]
}
