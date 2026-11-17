/**
 * Building a release's packs (contract C2's packs file): one archive per plugin package that a person turns on and the
 * default install does not carry, for each platform whose files differ. A pack holds the package and its production
 * dependencies, except (1) packages the closure already carries at the same version, which the install links
 * into the pack as peers (a third-party package at another version stays in the pack; see `keepsOneCopy`), and (2) packages whose licence forbids redistribution (`closure.json`'s `packExternals`),
 * which the packs file pins by npm tarball URL and SHA-512 and the client fetches from the registry. A Delorun package
 * in a pack has its TypeScript sources transpiled to JavaScript, as the closure's are. A package the pack's packages need
 * (`./pack-imports.ts`) that the pack does not carry is linked as a peer when the closure carries it; a build whose pack
 * would still miss one is refused.
 *
 * A pack's package.json files name every package it links: `pnpm deploy` empties the pack package's own
 * `peerDependencies`, so the build restores the source's, and a package that imports a linked package without declaring
 * it gets it in its `peerDependencies`, both at `peerRange`. Changes follows only declared dependencies when it copies
 * a pack for review, so an undeclared link would be missing from the copy. Each built variant is installed against the
 * staged closure and checked with Changes' own scan (`./review-copy.ts`); a build whose review copy would miss a need is
 * refused.
 *
 * A pack that carries native programs names them in its `package.json` under `delorun.packNatives`: for each release
 * platform, the registry packages its variant must carry, such as `@opencode/browse-linux-x64`. The deploy for that
 * platform also selects the operating system, processor and C library each listed package declares in the lockfile, so
 * a variant can carry a program for another system (the linux-x64 variant of Use my browser carries the Windows copy
 * that WSL runs on the Windows side). Each listed package must be in the deployment at the lockfile's version, and its
 * files must equal, byte for byte and in their executable bit, the registry tarball whose SHA-512 the lockfile pins; a
 * variant that lacks one, or carries other bytes, is refused. A pack that declares `packNatives` must list every release
 * platform.
 *
 * @module @delorun/release/closure/packs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackEntry, PackExternal, PackVariant, ReleasePacks, RuntimePlatform, SemanticVersion, Sha512Base64 } from '@delorun/contract-release-manifest'
import { RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MAX_ARCHIVE_BYTES, type ArchiveEntry } from '@delorun/release-formats/archive/entry'
import { readTar } from '@delorun/release-formats/archive/tar'
import { sha256Hex } from '@delorun/release-formats/brands'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { closureName } from '../rebuild/compare.ts'
import { transpileDelorunPackage, transpileDelorunPackages } from './delorun.ts'
import { linkCarriedNeeds, nestedSingleCopies, undeclaredPeerNeeds, type PackLayout } from './pack-imports.ts'
import { installedReviewCopyProblems } from './review-copy.ts'
import { listStagedTree, unsignedEnvelopeText } from './tree.ts'
import { packCandidates, readWorkspacePackages, selectClosurePackages } from './plugin-set.ts'

/** What a pack build reads from the package manager and the registry; tests supply fakes. */
export interface PackSources {
  /**
   * Deploy one package with its production dependencies for a platform into an empty directory (hoisted, copied).
   * @param name - the package.
   * @param platform - the platform whose optional dependencies are installed.
   * @param directory - the empty directory.
   * @param also - further systems whose optional dependencies are installed too, for a pack's native packages built
   * for another system than the platform's; empty for most packs.
   */
  deploy(name: string, platform: RuntimePlatform, directory: string, also: readonly NativeSystem[]): Promise<void>
  /** The staged closure's `app/node_modules` for a platform. */
  closureNodeModules(platform: RuntimePlatform): string
  /** The lockfile's exact version and `sha512-` integrity of a package for a platform. */
  locked(name: string, platform: RuntimePlatform): LockedPackage | undefined
  /** Download a registry tarball. */
  download(url: string): Promise<Buffer>
  /** The `peerDependencies` and `peerDependenciesMeta` the workspace package's own `package.json` declares, before deploy. */
  declaredPeers(name: string): Promise<DeclaredPeers>
}

/** A package's declared peers, as its source `package.json` lists them. */
export interface DeclaredPeers {
  /** Peer name to the range the source declares, such as `workspace:*`. */
  readonly peerDependencies?: Readonly<Record<string, string>>
  /** Peer name to its metadata; an `optional` peer is not a need. */
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}

/** What a pack build produces for one package. */
export interface BuiltPack {
  /** The packs file entry. */
  readonly entry: PackEntry
  /** Archive file name to bytes, to write beside the release. */
  readonly archives: ReadonlyMap<string, Buffer>
}

/** One package version the lockfile pins: `source` is the registry name when it differs from the dependency name. */
export interface LockedPackage {
  readonly version: string
  readonly integrity: string
  readonly source?: string
  /** The systems the package declares it installs on, as the lockfile lists them; absent for a package for any system. */
  readonly system?: NativeSystem
}

/** The operating systems, processors and C libraries a package installs on, as npm's `os`, `cpu` and `libc` fields name them. */
export interface NativeSystem {
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
}

const RUNTIME_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'] as const satisfies readonly RuntimePlatform[]

/** `delorun.packNatives` of a pack's `package.json`: per release platform, the native registry packages its variant carries. */
export const PackNatives = z.partialRecord(z.enum(RUNTIME_PLATFORMS), z.array(z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u, 'a package name')).min(1))
/** Per release platform, the native registry packages a pack's variant carries. */
export type PackNatives = z.infer<typeof PackNatives>

/**
 * Whether a package name is covered by the recipe's external list.
 * @param name - the package name.
 * @param patterns - `packExternals`.
 * @returns true for an exact name or a prefix pattern ending in `*`.
 */
export function isExternal(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
}

/**
 * The external package a staged path lies inside when that package is nested below the top level of the pack's `node_modules`.
 * @param path - a staged file's path relative to the pack root.
 * @param externals - the recipe's `packExternals`.
 * @returns the nested external package's name, or undefined when the path holds none.
 */
export function externalNestedIn(path: string, externals: readonly string[]): string | undefined {
  const segments = path.split('/')
  for (let index = 1; index < segments.length - 1; index++) {
    if (segments[index] !== 'node_modules') continue
    const first = segments[index + 1]!
    const name = first.startsWith('@') && index + 2 < segments.length - 1 ? `${first}/${segments[index + 2]!}` : first
    if (isExternal(name, externals)) return name
  }
  return undefined
}

/**
 * The npm tarball URL of a package version.
 * @param name - the package name.
 * @param version - its exact version.
 * @returns the registry URL.
 */
export function tarballUrl(name: string, version: string): string {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`
}

/**
 * A pack archive's file name: `delorun-<release>-pack-<name>.<platform or any>.tar.gz`. The platform follows a dot, not a
 * hyphen, so no pack archive reads as a runtime archive (`delorun-<release>-<platform>.tar.gz`) to the rebuild
 * comparison, whatever the pack is called.
 * @param release - the release version.
 * @param name - the package name.
 * @param platform - the platform, or `undefined` for the platform-independent archive.
 * @returns the file name.
 * @throws Error when the name would still parse as a runtime archive or file list.
 */
export function packArchiveName(release: string, name: string, platform: RuntimePlatform | undefined): string {
  const archive = `delorun-${release}-pack-${name.replaceAll('/', '__').replaceAll('@', '')}.${platform ?? 'any'}.tar.gz`
  if (closureName(archive) !== undefined) throw new Error(`the pack archive name ${archive} reads as a runtime archive; rename the pack`)
  return archive
}

/** A registry tarball whose SHA-512 matched the lockfile's integrity. */
interface PinnedTarball {
  readonly locked: LockedPackage
  readonly url: string
  readonly bytes: Buffer
  readonly sha512: string
}

/**
 * Download the tarball of a package the lockfile pins and check it against the lockfile's integrity.
 * @param name - the package.
 * @param platform - the platform the pin is read for.
 * @param sources - the lockfile and the registry.
 * @returns the pin and the bytes.
 * @throws Error when the lockfile does not pin the package or the registry serves other bytes.
 */
async function pinnedTarball(name: string, platform: RuntimePlatform, sources: PackSources): Promise<PinnedTarball> {
  const locked = sources.locked(name, platform)
  if (locked === undefined) throw new Error(`the lockfile does not pin ${name} for ${platform}`)
  const url = tarballUrl(locked.source ?? name, locked.version)
  const bytes = await sources.download(url)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  if (`sha512-${sha512}` !== locked.integrity) throw new Error(`${url} does not match the lockfile's integrity; the registry served other bytes than the lockfile pins`)
  return { locked, url, bytes, sha512 }
}

async function pinOf(name: string, platform: RuntimePlatform, sources: PackSources, downloaded: Map<string, Buffer>): Promise<PackExternal> {
  const { locked, url, bytes, sha512 } = await pinnedTarball(name, platform, sources)
  downloaded.set(url, bytes)
  return { name, version: brandString<SemanticVersion>(locked.version), url, sha512: brandString<Sha512Base64>(sha512), length: bytes.byteLength }
}

/**
 * The systems beyond the platform's own whose optional dependencies a variant's deploy installs: the lockfile's system
 * of each native package listed for the platform.
 * @param natives - the packages listed for the platform.
 * @param platform - the platform.
 * @param sources - the lockfile.
 * @returns one system per listed package that declares one.
 * @throws Error when the lockfile does not pin a listed package.
 */
function nativeSystems(natives: readonly string[], platform: RuntimePlatform, sources: PackSources): NativeSystem[] {
  return natives.flatMap((native) => {
    const locked = sources.locked(native, platform)
    if (locked === undefined) throw new Error(`the lockfile does not pin ${native}, which packNatives lists for ${platform}`)
    return locked.system === undefined ? [] : [locked.system]
  })
}

async function* once(bytes: Buffer): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(bytes)
}

/**
 * Check a variant's native packages against the lockfile: each is in the deployment at the lockfile's version, and its
 * files are the pinned registry tarball's, byte for byte, with the same executable bit.
 * @param name - the pack's package name.
 * @param platform - the platform.
 * @param natives - the packages listed for the platform.
 * @param entries - the variant's files.
 * @param sources - the lockfile and the registry.
 * @throws Error naming the package that is missing, at another version, or carries other files than the lockfile pins.
 */
async function verifyNatives(name: string, platform: RuntimePlatform, natives: readonly string[], entries: readonly ArchiveEntry[], sources: PackSources): Promise<void> {
  for (const native of natives) {
    const prefix = `node_modules/${native}/`
    const carried = new Map(entries.filter(entry => entry.path.startsWith(prefix)).map(entry => [entry.path.slice(prefix.length), entry]))
    const manifest = carried.get('package.json')
    if (manifest === undefined) throw new Error(`${name} for ${platform} does not carry ${native}, which packNatives lists; the deploy did not install it`)
    const { locked, url, bytes } = await pinnedTarball(native, platform, sources)
    const version = (JSON.parse(manifest.data.toString('utf8')) as { version?: string }).version
    if (version !== locked.version) throw new Error(`${name} for ${platform} carries ${native}@${version ?? 'unknown'}, but the lockfile pins ${locked.version}`)
    const expected = new Map<string, { readonly data: Buffer, readonly executable: boolean }>()
    for await (const file of readTar(once(gunzipSync(bytes)), MAX_ARCHIVE_BYTES, { foreign: true })) {
      if (!file.path.startsWith('package/')) throw new Error(`${url} holds ${file.path}, outside its package folder`)
      expected.set(file.path.slice('package/'.length), { data: file.data, executable: (file.mode & 0o111) !== 0 })
    }
    const differing = [...new Set([...expected.keys(), ...carried.keys()])].sort().filter((path) => {
      const want = expected.get(path)
      const have = carried.get(path)
      return want === undefined || have === undefined || !want.data.equals(have.data) || (platform !== 'win32-x64' && want.executable !== (have.mode === '0755'))
    })
    if (differing.length > 0) throw new Error(`${name} for ${platform} carries ${native} files that differ from the registry tarball the lockfile pins (${url}): ${differing.slice(0, 5).join(', ')}`)
  }
}

/** Third-party libraries that must exist once in a running Delorun: they hold module-level state or classes that plugins compare or pass across the plugin boundary. */
export const SINGLETON_LIBRARIES: readonly string[] = ['react', 'react-dom', 'zod', '@modelcontextprotocol/sdk']

/** Scopes of the workspace, Delorun and rescoped vendor packages (`vendor/*` are all `@deepseek-ai/*`). */
const CORE_SCOPES: readonly string[] = ['@deepseek-ai/', '@delorun/']

/**
 * Whether a bundled package at another version than the closure's would be a second copy that breaks module identity.
 * Workspace, Delorun and vendor packages, the singleton libraries, the recipe's externals and anything the pack lists in
 * `peerDependencies` must exist once; any other third-party package may ship inside the pack at its own version, which
 * Node resolves first from the pack's directory.
 * @param name - the package name.
 * @param packPeers - the pack package's `peerDependencies` names.
 * @param externals - the recipe's `packExternals`.
 * @returns true when a differing version is refused.
 */
export function keepsOneCopy(name: string, packPeers: ReadonlySet<string>, externals: readonly string[]): boolean {
  return CORE_SCOPES.some(scope => name.startsWith(scope)) || SINGLETON_LIBRARIES.includes(name) || packPeers.has(name) || isExternal(name, externals)
}

/** Delete every `.bin` directory under a deployed package, including those nested in its dependencies. */
async function removeCommandLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (entry.name === '.bin') await rm(path, { recursive: true, force: true })
    else await removeCommandLinks(path)
  }
}

/** The `package.json` fields the build reads or writes; any others are kept as they are. */
interface PackageManifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

function manifestText(manifest: PackageManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Upstream's DSH packages: their peer ranges are what its compatibility check compares with the running DSH. */
function isDshPackage(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * The range a pack's `package.json` declares a linked peer at. A DSH package keeps the source's range, `workspace:*`
 * when it has none: upstream's compatibility check reads a `workspace:` range as the running DSH, so a reviewed copy,
 * which Changes keeps across updates, stays compatible when the DSH version changes. Any other package is declared at
 * the closure's exact version, the one the pack links.
 * @param name - the peer's name.
 * @param sourceRange - the range the source declares, if any.
 * @param closureVersion - the closure's version of the peer, if it carries it.
 * @returns the range; the source's when the closure does not carry a package other than DSH's.
 */
function peerRange(name: string, sourceRange: string | undefined, closureVersion: string | undefined): string {
  if (isDshPackage(name)) return sourceRange ?? 'workspace:*'
  return closureVersion ?? sourceRange ?? '*'
}

/**
 * Put back the peers `pnpm deploy` dropped from the pack package's `package.json`: each peer the source declares and the
 * deployed manifest does not, at {@link peerRange}, and its `peerDependenciesMeta` entry.
 * @param directory - the deployment.
 * @param declared - the source's peers.
 * @param closureNodeModules - the closure's `app/node_modules` for the platform.
 */
async function restoreDeclaredPeers(directory: string, declared: DeclaredPeers, closureNodeModules: string): Promise<void> {
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
  const missing = Object.entries(declared.peerDependencies ?? {}).filter(([peer]) => manifest.peerDependencies?.[peer] === undefined)
  if (missing.length === 0) return
  const restored: Record<string, string> = {}
  for (const [peer, range] of missing) restored[peer] = peerRange(peer, range, await versionIn(join(closureNodeModules, peer)))
  manifest.peerDependencies = { ...manifest.peerDependencies, ...restored }
  const meta = missing.flatMap(([peer]) => (declared.peerDependenciesMeta?.[peer] === undefined || manifest.peerDependenciesMeta?.[peer] !== undefined ? [] : [[peer, declared.peerDependenciesMeta[peer]] as const]))
  if (meta.length > 0) manifest.peerDependenciesMeta = { ...manifest.peerDependenciesMeta, ...Object.fromEntries(meta) }
  await writeFile(path, manifestText(manifest))
}

async function peerDependencyNames(directory: string): Promise<Set<string>> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { peerDependencies?: Record<string, string> }
  return new Set(Object.keys(manifest.peerDependencies ?? {}))
}

async function versionIn(directory: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version?: string }).version
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Transpile the Delorun packages of a deployed pack in place, as the closure's are: the package itself when it is one,
 * and each `@delorun/` package it carries in its own `node_modules`.
 * @param name - the pack's package name.
 * @param directory - the deployment.
 */
async function transpilePackPackages(name: string, directory: string): Promise<void> {
  if (name.startsWith('@delorun/')) await transpileDelorunPackage(directory)
  if (existsSync(join(directory, 'node_modules', '@delorun'))) await transpileDelorunPackages(join(directory, 'node_modules'))
}

/**
 * Whether a pack file is a TypeScript source, not a declaration, of a Delorun package: the pack's own package when it is
 * one, or one in `node_modules/@delorun/` at any depth. Other packages may ship their sources beside their JavaScript.
 * @param name - the pack's package name.
 * @param path - the file's path in the pack.
 * @returns true for a file the transpile step should have replaced.
 */
function isDelorunSource(name: string, path: string): boolean {
  if (!/\.[cm]?tsx?$/u.test(path) || /\.d\.[cm]?ts$/u.test(path)) return false
  const segments = path.split('/')
  const nested = segments.lastIndexOf('node_modules')
  return nested === -1 ? name.startsWith('@delorun/') : segments[nested + 1] === '@delorun'
}

/**
 * Build one pack's archives from a deployed package.
 * @param name - the package name.
 * @param version - the package version.
 * @param experimental - whether Plugins labels it experimental.
 * @param releaseVersion - the release.
 * @param platforms - the release platforms.
 * @param epoch - the release's `SOURCE_DATE_EPOCH`.
 * @param externals - the recipe's `packExternals`.
 * @param sources - the package manager, closure and registry.
 * @param scratch - an empty directory for the deployments.
 * @param natives - the pack's `delorun.packNatives`; empty for a pack that carries no native program.
 * @returns the entry and the archives; platforms whose files and pins are identical share the `any` variant.
 * @throws Error when `natives` is not empty and lists nothing for a release platform, and as each check above names.
 */
export async function buildPack(name: string, version: string, experimental: boolean, releaseVersion: string, platforms: readonly RuntimePlatform[], epoch: number, externals: readonly string[], sources: PackSources, scratch: string, natives: PackNatives = {}): Promise<BuiltPack> {
  const declaresNatives = Object.keys(natives).length > 0
  const unlisted = platforms.filter(platform => declaresNatives && natives[platform] === undefined)
  if (unlisted.length > 0) throw new Error(`${name} lists packNatives but none for ${unlisted.join(', ')}; list each release platform's native packages`)
  const archives = new Map<string, Buffer>()
  // The externals' tarballs, by URL, for the review copy check's install.
  const downloaded = new Map<string, Buffer>()
  const built = new Map<RuntimePlatform, { bytes: Buffer, variant: Omit<PackVariant, 'external' | 'peers'>, external: PackExternal[], peers: string[] }>()
  for (const platform of platforms) {
    const directory = join(scratch, `${name.replaceAll('/', '__')}-${platform}`)
    await sources.deploy(name, platform, directory, nativeSystems(natives[platform] ?? [], platform, sources))
    await restoreDeclaredPeers(directory, await sources.declaredPeers(name), sources.closureNodeModules(platform))
    // A Delorun package exports TypeScript sources, which Node does not run from a pack; the closure's are transpiled too.
    await transpilePackPackages(name, directory)
    const external: PackExternal[] = []
    const dropped = new Set<string>()
    const peers = new Set<string>()
    const kept = new Set<string>()
    const packPeers = await peerDependencyNames(directory)
    const entries: ArchiveEntry[] = []
    for (const file of await listStagedTree(directory, platform)) {
      const nested = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(file.path)?.[1]
      // A top-level external's whole subtree is dropped from the pack, so what is nested inside it ships nothing.
      const deeper = nested !== undefined && isExternal(nested, externals) ? undefined : externalNestedIn(file.path, externals)
      if (deeper !== undefined) throw new Error(`${name} for ${platform} carries ${deeper} nested inside another package (${file.path}); an external package is fetched from its publisher only when it is at the top level of the pack's node_modules, so a nested copy would ship its files in the pack`)
      if (nested !== undefined && !dropped.has(nested) && !kept.has(nested)) {
        if (isExternal(nested, externals)) {
          dropped.add(nested)
          external.push(await pinOf(nested, platform, sources, downloaded))
        } else {
          const inClosure = await versionIn(join(sources.closureNodeModules(platform), nested))
          const bundled = await versionIn(join(directory, 'node_modules', nested))
          if (inClosure !== undefined && inClosure !== bundled && keepsOneCopy(nested, packPeers, externals)) throw new Error(`${name} bundles ${nested}@${bundled ?? 'unknown'} for ${platform}, but the closure carries ${nested}@${inClosure}; ${nested} must exist once in a running Delorun, so a pack never carries a second copy of it`)
          if (inClosure !== undefined && inClosure === bundled) {
            dropped.add(nested)
            peers.add(nested)
          } else kept.add(nested)
        }
      }
      if (nested !== undefined && dropped.has(nested)) continue
      entries.push({ path: file.path, mode: file.mode, data: await readFile(file.absolute) })
    }
    await verifyNatives(name, platform, natives[platform] ?? [], entries, sources)
    const untranspiled = entries.map(entry => entry.path).filter(path => isDelorunSource(name, path))
    if (untranspiled.length > 0) throw new Error(`${name} for ${platform} carries TypeScript sources of a Delorun package, which Node does not run from a pack: ${untranspiled.slice(0, 3).join(', ')}`)
    await linkClosureNeeds(name, platform, entries, peers, nestedName => keepsOneCopy(nestedName, packPeers, externals), external, sources)
    await declareLinkedNeeds(name, platform, directory, entries, peers, external, sources)
    const result = await buildPackArchive(packArchiveName(releaseVersion, name, platform), entries, epoch)
    const variant = { ...result.variant, external: external.sort((a, b) => (a.name < b.name ? -1 : 1)), peers: [...peers].sort() }
    const copyProblems = await installedReviewCopyProblems({
      entry: { name, version: brandString<SemanticVersion>(version), experimental, variants: { [platform]: variant } },
      platform,
      archive: result.bytes,
      release: releaseVersion,
      runtimeNodeModules: sources.closureNodeModules(platform),
      fetchExternal: pin => Promise.resolve(downloaded.get(pin.url)!),
      scratch,
    })
    if (copyProblems.length > 0) throw new Error(`${name} for ${platform} would not load from the review copy Changes makes of it: ${copyProblems.slice(0, 5).join('; ')}${copyProblems.length > 5 ? `; and ${String(copyProblems.length - 5)} more` : ''}. Declare each package a pack's package imports in that package's package.json`)
    built.set(platform, { ...result, external: variant.external, peers: variant.peers })
  }
  const variants: Partial<Record<RuntimePlatform | 'any', PackVariant>> = {}
  const same = platforms.every(platform => {
    const first = built.get(platforms[0]!)!
    const other = built.get(platform)!
    return other.external.length === 0 && first.external.length === 0 && JSON.stringify(other.variant.files) === JSON.stringify(first.variant.files) && JSON.stringify(other.peers) === JSON.stringify(first.peers)
  })
  if (same) {
    const first = built.get(platforms[0]!)!
    const anyName = packArchiveName(releaseVersion, name, undefined)
    const result = await buildPackArchive(anyName, first.variant.files.length === 0 ? [] : await entriesOf(scratch, name, platforms[0]!, first.variant.files.map(file => file.path)), epoch)
    variants.any = { ...result.variant, external: [], peers: first.peers }
    archives.set(anyName, result.bytes)
  } else {
    for (const [platform, result] of built) {
      variants[platform] = { ...result.variant, external: result.external, peers: result.peers }
      archives.set(result.variant.archive.name, result.bytes)
    }
  }
  return { entry: { name, version: brandString<SemanticVersion>(version), experimental, variants }, archives }
}

/**
 * Make every package of a pack loadable once installed (`linkCarriedNeeds`): link each package name a bundled package
 * needs and the pack does not carry to the closure's copy, as a peer, when the closure carries it at a version the need
 * accepts. A deployment carries a package's `dependencies` but not its `peerDependencies`, which a workspace plugin uses
 * for the harness packages it shares with the runtime, so those reach the pack only this way. Refuse a copy that must
 * exist once (`keepsOneCopy`) nested inside another package, where it would shadow the shared copy for that package.
 * @param name - the pack's package name.
 * @param platform - the platform.
 * @param entries - the pack's files.
 * @param peers - the peers so far; the linked names are added.
 * @param once - whether a package name must exist once.
 * @param external - the pinned externals.
 * @param sources - the closure.
 * @throws Error naming each nested copy, each need neither the pack nor the closure carries, which would fail at load
 * with "Cannot find package", and each need whose declared range the closure's version does not meet.
 */
async function linkClosureNeeds(name: string, platform: RuntimePlatform, entries: readonly ArchiveEntry[], peers: Set<string>, once: (name: string) => boolean, external: readonly PackExternal[], sources: PackSources): Promise<void> {
  const files = new Map(entries.map(entry => [entry.path, entry.data]))
  const paths = new Set(files.keys())
  const nested = nestedSingleCopies(paths, once)
  if (nested.length > 0) throw new Error(`${name} for ${platform} carries a second copy of a package that must exist once in a running Delorun, nested inside another package: ${nested.slice(0, 5).join(', ')}`)
  const problems = await linkCarriedNeeds({ paths, read: path => Promise.resolve(files.get(path)!.toString('utf8')), peers, external: new Set(external.map(pin => pin.name)) }, need => versionIn(join(sources.closureNodeModules(platform), need)))
  if (problems.length > 0) throw new Error(`${name} for ${platform} would not load: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${String(problems.length - 5)} more` : ''}. List a package the closure does not carry in ${name}'s dependencies so the pack carries it, and keep a declared range within the closure's version`)
}

/**
 * Declare in each package's `package.json` the linked peers it imports without declaring, so Changes' review copy keeps
 * those links (see the module comment). Each name goes into the importer's `peerDependencies` at {@link peerRange}, in
 * the deployment and in `entries`.
 * @param name - the pack's package name.
 * @param platform - the platform.
 * @param directory - the deployment.
 * @param entries - the pack's files; a rewritten `package.json` replaces its entry.
 * @param peers - the linked peers.
 * @param external - the pinned externals.
 * @param sources - the closure.
 * @throws Error when a linked name is not in the closure.
 */
async function declareLinkedNeeds(name: string, platform: RuntimePlatform, directory: string, entries: ArchiveEntry[], peers: ReadonlySet<string>, external: readonly PackExternal[], sources: PackSources): Promise<void> {
  const index = new Map(entries.map((entry, at) => [entry.path, at]))
  const layout: PackLayout = { paths: new Set(index.keys()), read: path => Promise.resolve(entries[index.get(path)!]!.data.toString('utf8')), peers, external: new Set(external.map(pin => pin.name)) }
  for (const [packageDirectory, needs] of await undeclaredPeerNeeds(layout)) {
    const path = packageDirectory === '' ? 'package.json' : `${packageDirectory}/package.json`
    const at = index.get(path)!
    const manifest = JSON.parse(entries[at]!.data.toString('utf8')) as PackageManifest
    const added: Record<string, string> = {}
    for (const need of needs) {
      const version = await versionIn(join(sources.closureNodeModules(platform), need))
      if (version === undefined) throw new Error(`${name} for ${platform} links ${need}, which the closure does not carry`)
      added[need] = peerRange(need, undefined, version)
    }
    manifest.peerDependencies = { ...manifest.peerDependencies, ...added }
    const data = Buffer.from(manifestText(manifest))
    await writeFile(join(directory, ...path.split('/')), data)
    entries[at] = { ...entries[at]!, data }
  }
}

async function entriesOf(scratch: string, name: string, platform: RuntimePlatform, paths: readonly string[]): Promise<ArchiveEntry[]> {
  const directory = join(scratch, `${name.replaceAll('/', '__')}-${platform}`)
  const staged = new Map((await listStagedTree(directory, platform)).map(file => [file.path, file]))
  return Promise.all(paths.map(async path => ({ path, mode: staged.get(path)!.mode, data: await readFile(staged.get(path)!.absolute) })))
}

/**
 * The unsigned packs document of a release; signing binds it to the manifest by digest.
 * @param version - the release.
 * @param packs - the built entries.
 * @returns the signed content, with a placeholder manifest digest that signing replaces.
 */
export function packsDocument(version: string, packs: readonly PackEntry[]): ReleasePacks {
  return { schema: RELEASE_SCHEMAS.packs, version: brandString<SemanticVersion>(version), manifest: sha256Hex('0'.repeat(64)), packs: [...packs].sort((a, b) => (a.name < b.name ? -1 : 1)) }
}

/** The lockfile's resolution of one package: `packages` keys are `<name>@<version>`. */
export function lockedFrom(lockfile: string, name: string): LockedPackage | undefined {
  const document = parseYaml(lockfile) as { packages?: Record<string, LockfilePackage>, snapshots?: Record<string, { optionalDependencies?: Record<string, string>, dependencies?: Record<string, string> }> }
  const packages = document.packages ?? {}
  const found = Object.entries(packages).filter(([key]) => key.startsWith(`${name}@`) && /^\d/u.test(key.slice(name.length + 1)))
  if (found.length === 0) return aliasedLock(packages, document.snapshots ?? {}, name)
  if (found.length > 1) throw new Error(`the lockfile pins ${name} at ${found.length} versions; a pack external needs exactly one`)
  const [key, value] = found[0]!
  const integrity = value.resolution?.integrity
  return integrity === undefined ? undefined : { version: key.slice(name.length + 1), integrity, ...systemOf(value) }
}

/** A `packages` entry of the lockfile, with the fields the build reads. */
interface LockfilePackage {
  readonly resolution?: { readonly integrity?: string }
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
}

function systemOf(value: LockfilePackage): { readonly system?: NativeSystem } {
  if (value.os === undefined && value.cpu === undefined && value.libc === undefined) return {}
  return { system: { ...value.os === undefined ? {} : { os: value.os }, ...value.cpu === undefined ? {} : { cpu: value.cpu }, ...value.libc === undefined ? {} : { libc: value.libc } } }
}

/** A package the lockfile pins under another registry name (`name: 'real@version'`), as `@openai/codex-<platform>` is. */
function aliasedLock(packages: Record<string, { resolution?: { integrity?: string } }>, snapshots: Record<string, { optionalDependencies?: Record<string, string>, dependencies?: Record<string, string> }>, name: string): LockedPackage | undefined {
  const targets = new Set<string>()
  for (const snapshot of Object.values(snapshots)) {
    const target = snapshot.optionalDependencies?.[name] ?? snapshot.dependencies?.[name]
    if (target !== undefined && /^@?[^@]+@\d/u.test(target)) targets.add(target)
  }
  if (targets.size > 1) throw new Error(`the lockfile pins ${name} at ${targets.size} versions; a pack external needs exactly one`)
  const target = [...targets][0]
  const integrity = target === undefined ? undefined : packages[target]?.resolution?.integrity
  if (target === undefined || integrity === undefined) return undefined
  const at = target.lastIndexOf('@')
  return { version: target.slice(at + 1), integrity, source: target.slice(0, at) }
}

/**
 * pnpm's platform selection for a variant: the platform's own, plus each further system's operating systems, processors
 * and C libraries, each flag once.
 * @param own - the platform's selection, such as `--os=linux --cpu=x64 --libc=glibc`.
 * @param also - the further systems.
 * @returns the flags.
 */
export function deployTargets(own: readonly string[], also: readonly NativeSystem[]): string[] {
  const flags = [...own]
  for (const system of also) {
    for (const [field, values] of [['os', system.os], ['cpu', system.cpu], ['libc', system.libc]] as const) {
      for (const value of values ?? []) if (!flags.includes(`--${field}=${value}`)) flags.push(`--${field}=${value}`)
    }
  }
  return flags
}

/** What a release's pack step needs from the build. */
export interface ReleasePackRequest {
  /** The release's exported source tree, dependencies installed and built. */
  readonly source: string
  /** The build environment `pnpm` runs in. */
  readonly env: NodeJS.ProcessEnv
  /** The release version. */
  readonly version: string
  /** The release platforms. */
  readonly platforms: readonly RuntimePlatform[]
  /** The release's `SOURCE_DATE_EPOCH`. */
  readonly epoch: number
  /** The recipe's `packExternals`. */
  readonly externals: readonly string[]
  /** Where each platform's staged closure lies: its `app/node_modules` is read to find the peers. */
  readonly stage: (platform: RuntimePlatform) => string
  /** pnpm's platform selection per platform. */
  readonly targets: Readonly<Record<RuntimePlatform, readonly string[]>>
  /** The directory the release files go to. */
  readonly out: string
  /** An empty scratch directory for deployments. */
  readonly scratch: string
}

/**
 * Build every pack of a release and write the archives and the unsigned packs file beside the closures.
 * @param request - the build facts.
 * @returns the number of packs built.
 */
export async function buildReleasePacks(request: ReleasePackRequest): Promise<number> {
  const packages = readWorkspacePackages(request.source)
  const selection = selectClosurePackages(packages)
  const carried = new Set<string>()
  for (const scope of await readdir(join(request.stage(request.platforms[0]!), 'app', 'node_modules'))) {
    if (scope.startsWith('@')) for (const name of await readdir(join(request.stage(request.platforms[0]!), 'app', 'node_modules', scope))) carried.add(`${scope}/${name}`)
    else carried.add(scope)
  }
  const lockfile = await readFile(join(request.source, 'pnpm-lock.yaml'), 'utf8')
  const directories = new Map(packages.map(each => [each.name, each.dir]))
  const sources: PackSources = {
    declaredPeers: async (name) => {
      const directory = directories.get(name)
      if (directory === undefined) throw new Error(`${name} is not a workspace package`)
      const manifest = JSON.parse(await readFile(join(request.source, directory, 'package.json'), 'utf8')) as DeclaredPeers
      return { ...manifest.peerDependencies === undefined ? {} : { peerDependencies: manifest.peerDependencies }, ...manifest.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: manifest.peerDependenciesMeta } }
    },
    closureNodeModules: platform => join(request.stage(platform), 'app', 'node_modules'),
    locked: name => lockedFrom(lockfile, name),
    download: async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
      return Buffer.from(await response.arrayBuffer())
    },
    deploy: (name, platform, directory, also) => {
      execFileSync('pnpm', ['--filter', name, 'deploy', '--prod', '--ignore-scripts', ...deployTargets(request.targets[platform], also), '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.package-import-method=copy', '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', directory], { cwd: request.source, env: request.env, stdio: 'inherit' })
      // A pack carries no command links: the archive refuses symbolic links and a pack is never run through .bin.
      return removeCommandLinks(directory)
    },
  }
  const entries: PackEntry[] = []
  for (const candidate of packCandidates(packages, selection, carried)) {
    const manifest = JSON.parse(await readFile(join(request.source, candidate.dir, 'package.json'), 'utf8')) as { version: string, delorun?: { packNatives?: unknown } }
    const natives = PackNatives.parse(manifest.delorun?.packNatives ?? {})
    const built = await buildPack(candidate.name, manifest.version, candidate.dir.startsWith('packages/experimental/'), request.version, request.platforms, request.epoch, request.externals, sources, request.scratch, natives)
    for (const [name, bytes] of built.archives) await writeFile(join(request.out, name), bytes, { flag: 'wx', mode: 0o644 })
    entries.push(built.entry)
  }
  if (entries.length > 0) await writeFile(join(request.out, `delorun-${request.version}.packs.json`), unsignedEnvelopeText(packsDocument(request.version, entries)), { flag: 'wx', mode: 0o644 })
  return entries.length
}
