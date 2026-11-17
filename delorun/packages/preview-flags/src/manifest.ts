/**
 * The static index of preview flags: which package declares which flag id. A package that declares flags lists their
 * ids in its own `package.json`, beside the other fields Delorun reads there:
 *
 * ```json
 * "delorun": { "previewFlags": ["onboarding.previewSteps"] }
 * ```
 *
 * The index names ids only. The plugin's own declaration (`ctx.previewFlags.declare`) carries the title, the
 * description and the kind; the Host refuses a declaration the index does not list, and {@link assertFlagsIndexed}
 * and the `gates:preview-flags` gate hold the two equal. The index exists because two readers cannot run plugins:
 * `delorun preview`, which also runs while Delorun is stopped, and the Host for a plugin whose row is off. Both find
 * the packages from the profile's rows ({@link rowPackages}).
 * @module @delorun/preview-flags/manifest
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { z } from 'zod'
import { PREVIEW_FLAG_ID, type PreviewFlagId } from './flags.ts'

/** The most flags one package lists. */
const MAX_FLAGS_PER_PACKAGE = 32

const Declared = z.object({
  delorun: z.object({
    previewFlags: z.array(z.string().regex(PREVIEW_FLAG_ID, 'a preview flag id is dot-separated camel-case words, such as onboarding.previewSteps')).max(MAX_FLAGS_PER_PACKAGE).optional(),
  }).optional(),
})

/** A package whose list could not be read, or lists a flag another package already lists. */
export interface FlagIndexProblem {
  readonly package: string
  readonly message: string
}

/** Every flag the profile's packages list. */
export interface FlagIndex {
  /** Each listed flag's owner: the name of the package that lists it. */
  readonly owners: ReadonlyMap<PreviewFlagId, string>
  /** The packages whose lists are broken; their flags are absent from {@link owners}. */
  readonly problems: readonly FlagIndexProblem[]
}

/** A package to read: its name and directory. */
export interface FlagPackage {
  readonly name: string
  readonly dir: string
}

/**
 * The flags a package's manifest lists.
 * @param manifest - a parsed `package.json`.
 * @returns the flag ids; empty for a manifest that lists none.
 * @throws {z.ZodError} when `delorun.previewFlags` is not a list of flag ids.
 */
export function listedFlags(manifest: unknown): readonly PreviewFlagId[] {
  // The schema's pattern is where a manifest's string becomes a flag id.
  return (Declared.parse(manifest).delorun?.previewFlags ?? []) as PreviewFlagId[]
}

/**
 * Read the index from packages. One package's problem never hides another package's flags.
 * @param packages - the packages, in the profile's order.
 * @returns the owners and the problems.
 */
export function readFlagIndex(packages: readonly FlagPackage[]): FlagIndex {
  const owners = new Map<PreviewFlagId, string>()
  const problems: FlagIndexProblem[] = []
  for (const pkg of packages) {
    try {
      for (const id of listedFlags(JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')))) {
        const first = owners.get(id)
        if (first !== undefined && first !== pkg.name) throw new Error(`"previewFlags" lists ${id}, which ${first} already lists`)
        owners.set(id, pkg.name)
      }
    } catch (error) {
      for (const [id, owner] of owners) if (owner === pkg.name) owners.delete(id)
      problems.push({ package: pkg.name, message: error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message })
    }
  }
  return { owners, problems }
}

/**
 * The package a row's module belongs to.
 * @param name - the row's `name`: a package, or a module inside one, such as `@delorun/bundle-local/trust`.
 * @returns the package name; undefined for a path or anything else that names no package.
 */
export function packageOf(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?=\/|$)/.exec(name)?.[0]
}

/**
 * Find a package's directory the way Node resolves it from a file, without needing the package to export its manifest.
 * @param name - the package name.
 * @param anchors - files to resolve from, in order, such as each bundle's `package.json`.
 * @returns the first directory that holds the package's `package.json`; undefined when no anchor reaches it.
 */
export function resolvePackageDir(name: string, anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    // A linked package's own dependencies sit beside its real location.
    const from = existsSync(anchor) ? realpathSync(anchor) : anchor
    // resolve.paths returns null only for builtins, which no row names.
    for (const searchPath of createRequire(from).resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return undefined
}

/**
 * The packages a profile's rows load from, each once, for {@link readFlagIndex}. A row whose package no anchor
 * reaches is left out: the Loader reports that row's own failure.
 * @param rowNames - every row's `name`, enabled or not.
 * @param anchors - files to resolve from, in order.
 * @returns each resolvable package's name and directory, in row order.
 */
export function rowPackages(rowNames: Iterable<unknown>, anchors: readonly string[]): FlagPackage[] {
  const found = new Map<string, FlagPackage>()
  for (const rowName of rowNames) {
    const name = packageOf(rowName)
    if (name === undefined || found.has(name)) continue
    const dir = resolvePackageDir(name, anchors)
    if (dir !== undefined) found.set(name, { name, dir })
  }
  return [...found.values()]
}

/**
 * Hold a plugin's declarations equal to its package's list, for the plugin's spec.
 * @param manifest - the package's parsed `package.json`.
 * @param declared - the ids the plugin declares.
 * @throws {Error} naming the ids only one side has.
 */
export function assertFlagsIndexed(manifest: unknown, declared: readonly PreviewFlagId[]): void {
  const listed = listedFlags(manifest)
  const unlisted = declared.filter(id => !listed.includes(id))
  const undeclared = listed.filter(id => !declared.includes(id))
  if (unlisted.length === 0 && undeclared.length === 0) return
  throw new Error('the declared preview flags and the package\'s delorun.previewFlags differ: '
    + [...unlisted.map(id => `${id} is declared and not listed`), ...undeclared.map(id => `${id} is listed and not declared`)].join('; '))
}
