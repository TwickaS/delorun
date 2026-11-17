/**
 * Whether every package in a pack can load once installed. An installed pack resolves a bare import the way Node does
 * from the file's real path: through the `node_modules` folders inside the pack, up to the pack's own `node_modules`,
 * where the install adds one link per signed peer into the runtime's `app/node_modules` and extracts each external
 * package. Nothing above the pack is searched. A package the pack neither carries, links nor fetches fails at load with
 * "Cannot find package".
 *
 * What a package needs: its `dependencies` and required `peerDependencies`, and, for a workspace or Delorun package, each
 * bare specifier its JavaScript imports, re-exports or requires with a string literal. Third-party code is held to its
 * `package.json` only, because it often guards an optional import in code.
 *
 * @module @delorun/release/closure/pack-imports
 */
import { builtinModules } from 'node:module'
import ts from 'typescript'

/** Scopes of the workspace, Delorun and rescoped vendor packages, whose imports the check reads. */
const OWN_SCOPES: readonly string[] = ['@deepseek-ai/', '@delorun/']

/** The pack's files and what the install adds beside them. */
export interface PackLayout {
  /** Every file path the archive holds, relative to the pack's package directory, with `/` separators. */
  readonly paths: ReadonlySet<string>
  /** Read one of `paths` as UTF-8. */
  read(path: string): Promise<string>
  /** Package names the install links from the pack's `node_modules` into the runtime. */
  readonly peers: ReadonlySet<string>
  /** Package names the install extracts into the pack's `node_modules` from the registry. */
  readonly external: ReadonlySet<string>
}

/** A package name one package of the pack needs and nothing in the installed pack provides. */
export interface UnresolvedImport {
  /** The needing package's name. */
  readonly importer: string
  /** Its directory in the pack: `''` for the pack's own package. */
  readonly directory: string
  /** The package name that does not resolve. */
  readonly name: string
  /** Where the need comes from: a `package.json` field, or the file that imports it. */
  readonly via: 'dependencies' | 'peerDependencies' | { readonly file: string }
}

interface Manifest {
  readonly name?: string
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules)

/**
 * The package name a bare specifier names.
 * @param specifier - an import specifier.
 * @returns the name, or `undefined` for a relative, absolute, URL, subpath-import or built-in specifier.
 */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(specifier)) return undefined
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!
  return BUILTINS.has(name) ? undefined : name
}

/**
 * The bare specifiers a JavaScript file imports, re-exports, imports dynamically or requires with a string literal.
 * @param text - the file's source.
 * @returns the specifiers, in source order.
 */
export function importedSpecifiers(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map(file => file.fileName)
}

/**
 * The directories of the packages a pack holds: `''` for its own package and each `node_modules/<name>` folder, at any
 * depth, that holds a `package.json`.
 */
function packageDirectories(paths: ReadonlySet<string>): string[] {
  const directories: string[] = []
  for (const path of paths) {
    if (path === 'package.json') directories.push('')
    else if (/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/@][^/]*\/package\.json$/u.test(path)) directories.push(path.slice(0, -'/package.json'.length))
  }
  return directories.sort()
}

/** Each directory Node searches a `node_modules` in, from `directory` up to the pack's package directory. */
function searchedDirectories(directory: string): string[] {
  const searched: string[] = []
  const segments = directory === '' ? [] : directory.split('/')
  for (let end = segments.length; end >= 0; end--) {
    if (end > 0 && segments[end - 1] === 'node_modules') continue
    searched.push(segments.slice(0, end).join('/'))
  }
  return searched
}

/**
 * Whether a need resolves in the installed pack.
 * @param need - the need.
 * @param layout - the pack.
 * @returns true when a `node_modules` folder from the needing package up to the pack's package directory holds the
 * name, or the pack's own `node_modules` links or fetches it.
 */
export function resolvesInPack(need: Pick<UnresolvedImport, 'name' | 'directory'>, layout: PackLayout): boolean {
  for (const searched of searchedDirectories(need.directory)) {
    if (layout.paths.has(`${searched === '' ? '' : `${searched}/`}node_modules/${need.name}/package.json`)) return true
  }
  return layout.peers.has(need.name) || layout.external.has(need.name)
}

/**
 * The package names each package of a pack needs, with where each need comes from.
 * @param layout - the pack; only its files are read.
 * @returns the needs, one per package and name, in a stable order.
 */
export async function packNeeds(layout: PackLayout): Promise<UnresolvedImport[]> {
  const needs: UnresolvedImport[] = []
  const directories = packageDirectories(layout.paths)
  for (const directory of directories) {
    const prefix = directory === '' ? '' : `${directory}/`
    const manifest = JSON.parse(await layout.read(`${prefix}package.json`)) as Manifest
    const importer = manifest.name ?? directory
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}))
    const seen = new Set<string>()
    const need = (name: string, via: UnresolvedImport['via']): void => {
      if (seen.has(name) || name === importer) return
      seen.add(name)
      needs.push({ importer, directory, name, via })
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) if (!optional.has(name)) need(name, 'dependencies')
    for (const name of Object.keys(manifest.peerDependencies ?? {})) if (manifest.peerDependenciesMeta?.[name]?.optional !== true) need(name, 'peerDependencies')
    if (!OWN_SCOPES.some(scope => importer.startsWith(scope))) continue
    // The package's own files: those below its directory that are not inside a package nested in it.
    const own = [...layout.paths].filter(path => path.startsWith(prefix) && /\.[cm]?js$/u.test(path) && !path.slice(prefix.length).split('/').includes('node_modules')).sort()
    for (const file of own) {
      for (const specifier of importedSpecifiers(await layout.read(file))) {
        const name = packageNameOf(specifier)
        if (name !== undefined) need(name, { file })
      }
    }
  }
  return needs
}

/**
 * The needs no installed copy of the pack can meet.
 * @param layout - the pack's files, peers and externals.
 * @returns every unresolved need, empty for a pack whose packages all load.
 */
export async function unresolvedPackImports(layout: PackLayout): Promise<UnresolvedImport[]> {
  return (await packNeeds(layout)).filter(need => !resolvesInPack(need, layout))
}

/**
 * A one-line description of an unresolved need, for an error or a report.
 * @param need - the need.
 * @returns e.g. `@a/b (node_modules/@a/b) imports x in lib/index.js`.
 */
export function describeUnresolved(need: UnresolvedImport): string {
  const where = need.directory === '' ? need.importer : `${need.importer} (${need.directory})`
  return typeof need.via === 'string' ? `${where} lists ${need.name} in ${need.via}` : `${where} imports ${need.name} in ${need.via.file}`
}
