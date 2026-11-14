/**
 * The parts of a profile's pnpm lockfile (version 9) the install check reads: the profile's own dependencies
 * (`importers['.']`), each locked package's resolution (`packages`), and each installed instance's dependencies
 * (`snapshots`), with the line each package entry starts on. The file is the person's and any package operation's to
 * write, so every field is validated here and an entry the reader cannot read is reported, never skipped.
 *
 * @module @delorun/plugin-install-check/lockfile
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { z } from 'zod'

/** The lockfile's name in a profile. */
export const LOCKFILE = 'pnpm-lock.yaml'

/** How a locked package was fetched, as its `resolution` records it. */
export interface LockedResolution {
  /** The Subresource Integrity of its tarball, when the lockfile records one. */
  readonly integrity?: string
  /** The tarball URL, for a package fetched from a URL rather than the registry's own path. */
  readonly tarball?: string
  /** `git` for a git checkout, `directory` for a `file:` directory. */
  readonly type?: string
  /** The commit of a git checkout. */
  readonly commit?: string
  /** The repository of a git checkout. */
  readonly repo?: string
  /** The directory of a `file:` directory, relative to the profile. */
  readonly directory?: string
}

/** One locked package: an entry of `packages`. */
export interface LockedEntry {
  /** The entry's key: `<name>@<version or source>`. */
  readonly key: string
  /** The package's name. */
  readonly name: string
  /** The version or source after the name. */
  readonly version: string
  /** The package's own version, which the lockfile records beside a tarball, git or directory source. */
  readonly packageVersion?: string
  /** Its resolution. */
  readonly resolution: LockedResolution
  /** The 1-based line of the lockfile the entry starts on. */
  readonly line: number
}

/** A profile lockfile, read. */
export interface Lockfile {
  /** The profile's direct dependencies, by name: the version reference the importer records. */
  readonly dependencies: ReadonlyMap<string, string>
  /** The locked packages, by key. */
  readonly packages: ReadonlyMap<string, LockedEntry>
  /** Each installed instance's dependencies, by snapshot key, each a name and a version reference. */
  readonly snapshots: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/** Why a lockfile cannot be read. */
export class LockfileError extends Error {
  override readonly name = 'LockfileError'
}

const Resolution = z.looseObject({
  integrity: z.string().optional(),
  tarball: z.string().optional(),
  type: z.string().optional(),
  commit: z.string().optional(),
  repo: z.string().optional(),
  directory: z.string().optional(),
})
const Dependencies = z.record(z.string(), z.string())
const ImporterDependencies = z.record(z.string(), z.looseObject({ version: z.string() }))
const Importer = z.looseObject({ dependencies: ImporterDependencies.nullish(), optionalDependencies: ImporterDependencies.nullish() })
const LockfileSchema = z.looseObject({
  lockfileVersion: z.literal('9.0'),
  importers: z.record(z.string(), Importer).nullish(),
  packages: z.record(z.string(), z.looseObject({ resolution: Resolution, version: z.string().optional() })).nullish(),
  snapshots: z.record(z.string(), z.looseObject({ dependencies: Dependencies.optional(), optionalDependencies: Dependencies.optional() }).nullable()).nullish(),
})

/**
 * Split an entry key into its name and its version or source.
 * @param key - the key, such as `@scope/name@1.0.0` or `name@https://host/x.tgz`.
 * @returns the name and the rest.
 * @throws LockfileError when the key names no version.
 */
export function splitKey(key: string): { readonly name: string, readonly version: string } {
  const at = key.indexOf('@', 1)
  if (at < 0) throw new LockfileError(`the lockfile entry ${JSON.stringify(key)} names no version`)
  return { name: key.slice(0, at), version: key.slice(at + 1) }
}

/**
 * Read a lockfile's text.
 * @param text - the lockfile's text.
 * @returns the lockfile.
 * @throws LockfileError when the text is not a version 9 pnpm lockfile, or an entry cannot be read.
 */
export function parseLockfile(text: string): Lockfile {
  const document = parseDocument(text, { uniqueKeys: true })
  if (document.errors.length > 0) throw new LockfileError(`the lockfile is not YAML: ${document.errors[0]?.message ?? ''}`)
  const parsed = LockfileSchema.safeParse(document.toJS())
  if (!parsed.success) throw new LockfileError(`the lockfile is not a pnpm lockfile of version 9: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  const lines = entryLines(text, document.get('packages', true))
  const importer = parsed.data.importers?.['.']
  const dependencies = new Map<string, string>()
  for (const [name, entry] of [...Object.entries(importer?.dependencies ?? {}), ...Object.entries(importer?.optionalDependencies ?? {})]) dependencies.set(name, entry.version)
  const packages = new Map<string, LockedEntry>()
  for (const [key, entry] of Object.entries(parsed.data.packages ?? {})) {
    const { name, version } = splitKey(key)
    const { integrity, tarball, type, commit, repo, directory } = entry.resolution
    packages.set(key, {
      key, name, version, line: lines.get(key) ?? 0, ...entry.version === undefined ? {} : { packageVersion: entry.version },
      resolution: { ...integrity === undefined ? {} : { integrity }, ...tarball === undefined ? {} : { tarball }, ...type === undefined ? {} : { type }, ...commit === undefined ? {} : { commit }, ...repo === undefined ? {} : { repo }, ...directory === undefined ? {} : { directory } },
    })
  }
  const snapshots = new Map<string, ReadonlyMap<string, string>>()
  for (const [key, entry] of Object.entries(parsed.data.snapshots ?? {})) {
    snapshots.set(key, new Map([...Object.entries(entry?.dependencies ?? {}), ...Object.entries(entry?.optionalDependencies ?? {})]))
  }
  return { dependencies, packages, snapshots }
}

/**
 * The line each entry of `packages` starts on.
 * @param text - the lockfile's text.
 * @param node - the `packages` mapping node.
 * @returns the 1-based line per key.
 */
function entryLines(text: string, node: unknown): Map<string, number> {
  const lines = new Map<string, number>()
  if (!isMap(node)) return lines
  for (const pair of node.items) {
    if (!isScalar(pair.key) || pair.key.range === undefined || pair.key.range === null) continue
    lines.set(String(pair.key.value), text.slice(0, pair.key.range[0]).split('\n').length)
  }
  return lines
}

/**
 * The `packages` key a dependency reference names.
 * @param name - the dependency's name.
 * @param reference - the version reference the importer or a snapshot records, with any peer suffix.
 * @returns the key, or `undefined` for a `link:` reference, which `packages` does not list.
 */
export function packageKey(name: string, reference: string): string | undefined {
  if (reference.startsWith('link:')) return undefined
  const plain = reference.replace(/\(.*$/u, '')
  // A URL or a file source keeps the dependency's name; an alias reference names the package it installs.
  if (/^[a-z][a-z+.-]*:/u.test(plain) || !plain.includes('@')) return `${name}@${plain}`
  return plain
}

/**
 * The `snapshots` key a dependency reference names: the `packages` key with the reference's peer suffix.
 * @param name - the dependency's name.
 * @param reference - the version reference.
 * @returns the key.
 */
export function snapshotKey(name: string, reference: string): string {
  return /^[a-z][a-z+.-]*:/u.test(reference) || !reference.replace(/\(.*$/u, '').includes('@') ? `${name}@${reference}` : reference
}

/** One package of a plugin's closure, as the lockfile locks it. */
export interface ClosurePackage {
  /** The name the package is installed under. */
  readonly name: string
  /** The version reference that installs it. */
  readonly reference: string
  /** Its `packages` entry; absent for a `link:` dependency, and for an entry the lockfile lacks. */
  readonly entry?: LockedEntry
}

/** One installed package of a plugin's closure. */
export interface InstalledPackage extends ClosurePackage {
  /** Its directory, real path. */
  readonly dir: string
}

/**
 * The packages one profile dependency and everything it depends on lock, read from the lockfile alone, so it answers
 * before any of them is installed.
 * @param lockfile - the profile's lockfile.
 * @param name - the profile dependency.
 * @returns each package once by snapshot key, the dependency first; a `link:` dependency's own dependencies are not
 *   followed, since the profile's lockfile does not lock them.
 */
export function lockfileClosure(lockfile: Lockfile, name: string): ClosurePackage[] {
  const reference = lockfile.dependencies.get(name)
  if (reference === undefined) return []
  const found: ClosurePackage[] = []
  const seen = new Set<string>()
  const visit = (dependency: string, ref: string): void => {
    const snapshot = snapshotKey(dependency, ref)
    if (seen.has(snapshot)) return
    seen.add(snapshot)
    const key = packageKey(dependency, ref)
    const entry = key === undefined ? undefined : lockfile.packages.get(key)
    found.push({ name: dependency, reference: ref, ...entry === undefined ? {} : { entry } })
    if (ref.startsWith('link:')) return
    for (const [child, childRef] of lockfile.snapshots.get(snapshot) ?? new Map<string, string>()) visit(child, childRef)
  }
  visit(name, reference)
  return found
}

/**
 * The installed packages of one profile dependency and everything it depends on, as the profile's hoisted
 * `node_modules` holds them: each dependency resolves as Node resolves it, from the nearest `node_modules` of the
 * package that depends on it up to the profile's.
 * @param profileDir - the profile directory.
 * @param lockfile - the profile's lockfile.
 * @param name - the profile dependency.
 * @returns the packages, the dependency first; a `link:` dependency's own dependencies are not followed, since the
 *   profile's lockfile does not lock them; a dependency that is not installed is left out.
 */
export function closureOf(profileDir: string, lockfile: Lockfile, name: string): InstalledPackage[] {
  const reference = lockfile.dependencies.get(name)
  if (reference === undefined) return []
  const root = join(profileDir, 'node_modules')
  const found: InstalledPackage[] = []
  const seen = new Set<string>()
  const visit = (dependency: string, ref: string, from: string): void => {
    const dir = resolveFrom(from, dependency, root)
    if (dir === undefined || seen.has(dir)) return
    seen.add(dir)
    const key = packageKey(dependency, ref)
    const entry = key === undefined ? undefined : lockfile.packages.get(key)
    found.push({ name: dependency, reference: ref, dir, ...entry === undefined ? {} : { entry } })
    if (ref.startsWith('link:')) return
    for (const [child, childRef] of lockfile.snapshots.get(snapshotKey(dependency, ref)) ?? new Map<string, string>()) visit(child, childRef, dir)
  }
  visit(name, reference, profileDir)
  return found
}

/**
 * Resolve a package from a directory as Node resolves it, without leaving the profile's `node_modules`.
 * @param from - the depending package's directory, or the profile directory.
 * @param name - the package's name.
 * @param root - the profile's `node_modules`.
 * @returns the package's real directory, or `undefined` when no `node_modules` on the way holds it.
 */
function resolveFrom(from: string, name: string, root: string): string | undefined {
  const profile = dirname(root)
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(candidate) && (lstatSync(candidate).isDirectory() || lstatSync(candidate).isSymbolicLink())) return realpathSync(candidate)
    const rel = relative(profile, dir)
    if (rel === '' || rel.startsWith('..') || dirname(dir) === dir || rel.split(sep).length > 64) return undefined
  }
}
