/**
 * Whether every package in a pack can load once installed. An installed pack resolves a bare import the way Node does
 * from the file's real path: through the `node_modules` folders inside the pack, up to the pack's own `node_modules`,
 * where the install adds one link per signed peer into the runtime's `app/node_modules` and extracts each external
 * package. Node goes on to the folders above the pack, but the check counts nothing found there: what lies above an
 * installed pack is not part of the release, so a package there cannot meet a need the build accepts. A package the
 * pack neither carries, links nor fetches fails at load with "Cannot find package".
 *
 * A pack also has to load from the review copy Changes makes of it (`@delorun/changes/tree`), which follows only the
 * packages each included package's `package.json` names in `dependencies`, `optionalDependencies` or
 * `peerDependencies`. So a need counts as met only when the needing package declares it in one of those fields and it
 * resolves in the installed pack ({@link resolvesInReviewCopy}); an import the package does not declare loads from the
 * installed pack but fails from the copy.
 *
 * What a package needs: its `dependencies` and required `peerDependencies`, and, for a workspace or Delorun package, each
 * bare specifier its JavaScript imports, re-exports or requires with a string literal. Third-party code is held to its
 * `package.json` only, because it often guards an optional import in code.
 *
 * @module @delorun/release/closure/pack-imports
 */
import { builtinModules } from 'node:module'
import semver from 'semver'
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
  /** The version specifier the field declares; none for an import. */
  readonly range?: string
  /** Whether the needing package's `package.json` names it in `dependencies`, `optionalDependencies` or `peerDependencies`. */
  readonly declared: boolean
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
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...optional, ...Object.keys(manifest.peerDependencies ?? {})])
    const seen = new Set<string>()
    const need = (name: string, via: UnresolvedImport['via'], range?: string): void => {
      if (seen.has(name) || name === importer) return
      seen.add(name)
      needs.push({ importer, directory, name, via, ...range === undefined ? {} : { range }, declared: declared.has(name) })
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) if (!optional.has(name)) need(name, 'dependencies', range)
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) if (manifest.peerDependenciesMeta?.[name]?.optional !== true) need(name, 'peerDependencies', range)
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
 * Whether a need resolves both in the installed pack and in the review copy Changes makes of it.
 * @param need - the need.
 * @param layout - the pack.
 * @returns true when the needing package declares the need and it resolves in the installed pack ({@link resolvesInPack}).
 */
export function resolvesInReviewCopy(need: Pick<UnresolvedImport, 'name' | 'directory' | 'declared'>, layout: PackLayout): boolean {
  return need.declared && resolvesInPack(need, layout)
}

/**
 * The needs the installed pack or its review copy cannot meet.
 * @param layout - the pack's files, peers and externals.
 * @returns every unresolved need, empty for a pack whose packages all load from both.
 */
export async function unresolvedPackImports(layout: PackLayout): Promise<UnresolvedImport[]> {
  return (await packNeeds(layout)).filter(need => !resolvesInReviewCopy(need, layout))
}

/**
 * The needs a package imports without declaring them that resolve only through a link the pack adds into the runtime,
 * by the needing package's directory: the names the cut declares as that package's peers.
 * @param layout - the pack, with its peers linked.
 * @returns the names per package directory (`''` for the pack's own package), each list sorted; empty when there are none.
 */
export async function undeclaredPeerNeeds(layout: PackLayout): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  const carried: PackLayout = { ...layout, peers: new Set(), external: new Set() }
  for (const need of await packNeeds(layout)) {
    if (need.declared || !layout.peers.has(need.name) || resolvesInPack(need, carried)) continue
    found.set(need.directory, [...found.get(need.directory) ?? [], need.name].sort())
  }
  return found
}

/**
 * A one-line description of an unresolved need, for an error or a report.
 * @param need - the need.
 * @returns e.g. `@a/b (node_modules/@a/b) imports x in lib/index.js`.
 */
export function describeUnresolved(need: UnresolvedImport): string {
  const where = need.directory === '' ? need.importer : `${need.importer} (${need.directory})`
  if (typeof need.via === 'string') return `${where} lists ${need.name} in ${need.via}`
  return `${where} imports ${need.name} in ${need.via.file}${need.declared ? '' : ' without declaring it in its package.json, so the review copy leaves it out'}`
}

/**
 * Whether the closure's version of a package meets the specifier a need declares.
 * @param need - the need, with the specifier its `package.json` field declares, if any.
 * @param version - the closure's version of the package.
 * @returns why it does not, or `undefined` when it does or the need is an import, which declares no version. A
 * `workspace:` specifier with no range, and a `file:` or `link:` one of a workspace or Delorun package, name the
 * workspace's own copy, which is the closure's. An `npm:` alias names another package, so the closure's never meets it.
 */
export function rangeProblem(need: UnresolvedImport, version: string): string | undefined {
  if (need.range === undefined) return undefined
  let range = need.range
  if (range.startsWith('workspace:')) range = range.slice('workspace:'.length)
  if (['', '*', '~', '^'].includes(range)) return undefined
  if (/(?:^|@)(?:file|link):/u.test(range) && OWN_SCOPES.some(scope => need.name.startsWith(scope))) return undefined
  // An alias installs another package under this name; the closure's package of this name is not it.
  if (range.startsWith('npm:')) return `${describeUnresolved(need)} at ${need.range}, an alias of another package, which the closure's ${need.name} cannot stand for`
  if (semver.validRange(range) === null) return `${describeUnresolved(need)} at ${need.range}, which is not a version range the build can compare with the closure's ${need.name}@${version}`
  return semver.satisfies(version, range, { includePrerelease: true }) ? undefined : `${describeUnresolved(need)} at ${need.range}, but the closure carries ${need.name}@${version}`
}

/**
 * Link each need the pack does not carry to the closure's copy, as the cut does: a need the closure carries becomes a
 * peer when the closure's version meets the specifier the need declares. Whether the needing package declares it is
 * not judged here; {@link unresolvedPackImports} judges it once the cut has declared the linked needs.
 * @param layout - the pack, with the peers to add to.
 * @param closureVersion - the closure's version of a package, or `undefined` when the closure does not carry it.
 * @returns one line per need that stays unmet: neither carried nor linked, or carried at a version outside its range.
 */
export async function linkCarriedNeeds(layout: PackLayout & { readonly peers: Set<string> }, closureVersion: (name: string) => Promise<string | undefined>): Promise<string[]> {
  const problems: string[] = []
  const open = (await packNeeds(layout)).filter(need => !resolvesInPack(need, layout))
  const versions = new Map<string, string | undefined>()
  for (const need of open) if (!versions.has(need.name)) versions.set(need.name, await closureVersion(need.name))
  // A name is linked only when every need of it accepts the closure's version, since all of them would share the link.
  const refused = new Set<string>()
  for (const need of open) {
    const version = versions.get(need.name)
    const problem = version === undefined ? undefined : rangeProblem(need, version)
    if (problem === undefined) continue
    problems.push(problem)
    refused.add(need.name)
  }
  for (const [name, version] of versions) if (version !== undefined && !refused.has(name)) layout.peers.add(name)
  for (const need of open) if (!refused.has(need.name) && !resolvesInPack(need, layout)) problems.push(describeUnresolved(need))
  return problems
}

/**
 * The copies of a package that must exist once, nested inside another package of the pack, where they would shadow
 * the copy every other package shares for the package that nests them.
 * @param paths - the pack's file paths.
 * @param once - whether a package name must exist once (`keepsOneCopy`).
 * @returns the nested copies' directories, such as `node_modules/a/node_modules/react`.
 */
export function nestedSingleCopies(paths: ReadonlySet<string>, once: (name: string) => boolean): string[] {
  return packageDirectories(paths).filter((directory) => {
    const segments = directory.split('/')
    if (segments.filter(segment => segment === 'node_modules').length < 2) return false
    const at = segments.lastIndexOf('node_modules')
    return once(segments.slice(at + 1).join('/'))
  })
}
