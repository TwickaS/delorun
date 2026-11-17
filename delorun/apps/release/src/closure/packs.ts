/**
 * Building a release's packs (contract C2's packs file): one archive per plugin package that a person turns on and the
 * default install does not carry, for each platform whose files differ. A pack holds the package and its production
 * dependencies, except (1) packages the closure already carries at the same version, which the install links
 * into the pack as peers, and (2) packages whose licence forbids redistribution (`closure.json`'s `packExternals`),
 * which the packs file pins by npm tarball URL and SHA-512 and the client fetches from the registry.
 *
 * @module @delorun/release/closure/packs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackEntry, PackExternal, PackVariant, ReleasePacks, RuntimePlatform, SemanticVersion, Sha512Base64 } from '@delorun/contract-release-manifest'
import { RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ArchiveEntry } from '@delorun/release-formats/archive/entry'
import { sha256Hex } from '@delorun/release-formats/brands'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { parse as parseYaml } from 'yaml'
import { closureName } from '../rebuild/compare.ts'
import { listStagedTree, unsignedEnvelopeText } from './tree.ts'
import { packCandidates, readWorkspacePackages, selectClosurePackages } from './plugin-set.ts'

/** What a pack build reads from the package manager and the registry; tests supply fakes. */
export interface PackSources {
  /** Deploy one package with its production dependencies for a platform into an empty directory (hoisted, copied). */
  deploy(name: string, platform: RuntimePlatform, directory: string): Promise<void>
  /** The staged closure's `app/node_modules` for a platform. */
  closureNodeModules(platform: RuntimePlatform): string
  /** The lockfile's exact version and `sha512-` integrity of a package for a platform. */
  locked(name: string, platform: RuntimePlatform): { readonly version: string, readonly integrity: string } | undefined
  /** Download a registry tarball. */
  download(url: string): Promise<Buffer>
}

/** What a pack build produces for one package. */
export interface BuiltPack {
  /** The packs file entry. */
  readonly entry: PackEntry
  /** Archive file name to bytes, to write beside the release. */
  readonly archives: ReadonlyMap<string, Buffer>
}

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

async function pinOf(name: string, platform: RuntimePlatform, sources: PackSources): Promise<PackExternal> {
  const locked = sources.locked(name, platform)
  if (locked === undefined) throw new Error(`the lockfile does not pin ${name} for ${platform}`)
  const url = tarballUrl(name, locked.version)
  const bytes = await sources.download(url)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  if (`sha512-${sha512}` !== locked.integrity) throw new Error(`${url} does not match the lockfile's integrity; the registry served other bytes than the lockfile pins`)
  return { name, version: brandString<SemanticVersion>(locked.version), url, sha512: brandString<Sha512Base64>(sha512), length: bytes.byteLength }
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
 * @returns the entry and the archives; platforms whose files and pins are identical share the `any` variant.
 */
export async function buildPack(name: string, version: string, experimental: boolean, releaseVersion: string, platforms: readonly RuntimePlatform[], epoch: number, externals: readonly string[], sources: PackSources, scratch: string): Promise<BuiltPack> {
  const archives = new Map<string, Buffer>()
  const built = new Map<RuntimePlatform, { bytes: Buffer, variant: Omit<PackVariant, 'external' | 'peers'>, external: PackExternal[], peers: string[] }>()
  for (const platform of platforms) {
    const directory = join(scratch, `${name.replaceAll('/', '__')}-${platform}`)
    await sources.deploy(name, platform, directory)
    const external: PackExternal[] = []
    const dropped = new Set<string>()
    const peers = new Set<string>()
    const entries: ArchiveEntry[] = []
    for (const file of await listStagedTree(directory, platform)) {
      const nested = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(file.path)?.[1]
      if (nested !== undefined && !dropped.has(nested)) {
        if (isExternal(nested, externals)) {
          dropped.add(nested)
          external.push(await pinOf(nested, platform, sources))
        } else {
          const inClosure = await versionIn(join(sources.closureNodeModules(platform), nested))
          const bundled = await versionIn(join(directory, 'node_modules', nested))
          if (inClosure !== undefined && inClosure !== bundled) throw new Error(`${name} bundles ${nested}@${bundled ?? 'unknown'} for ${platform}, but the closure carries ${nested}@${inClosure}; a pack never carries a second copy of a core package`)
          if (inClosure !== undefined) {
            dropped.add(nested)
            peers.add(nested)
          }
        }
      }
      if (nested !== undefined && dropped.has(nested)) continue
      entries.push({ path: file.path, mode: file.mode, data: await readFile(file.absolute) })
    }
    const result = await buildPackArchive(packArchiveName(releaseVersion, name, platform), entries, epoch)
    built.set(platform, { ...result, external: external.sort((a, b) => (a.name < b.name ? -1 : 1)), peers: [...peers].sort() })
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
export function lockedFrom(lockfile: string, name: string): { readonly version: string, readonly integrity: string } | undefined {
  const packages = (parseYaml(lockfile) as { packages?: Record<string, { resolution?: { integrity?: string } }> }).packages ?? {}
  const found = Object.entries(packages).filter(([key]) => key.startsWith(`${name}@`) && /^\d/u.test(key.slice(name.length + 1)))
  if (found.length === 0) return undefined
  if (found.length > 1) throw new Error(`the lockfile pins ${name} at ${found.length} versions; a pack external needs exactly one`)
  const [key, value] = found[0]!
  const integrity = value.resolution?.integrity
  return integrity === undefined ? undefined : { version: key.slice(name.length + 1), integrity }
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
  const sources: PackSources = {
    closureNodeModules: platform => join(request.stage(platform), 'app', 'node_modules'),
    locked: name => lockedFrom(lockfile, name),
    download: async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
      return Buffer.from(await response.arrayBuffer())
    },
    deploy: (name, platform, directory) => {
      execFileSync('pnpm', ['--filter', name, 'deploy', '--prod', '--ignore-scripts', ...request.targets[platform], '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.package-import-method=copy', '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', directory], { cwd: request.source, env: request.env, stdio: 'inherit' })
      // A pack carries no command links: the archive refuses symbolic links and a pack is never run through .bin.
      return rm(join(directory, 'node_modules', '.bin'), { recursive: true, force: true })
    },
  }
  const entries: PackEntry[] = []
  for (const candidate of packCandidates(packages, selection, carried)) {
    const manifest = JSON.parse(await readFile(join(request.source, candidate.dir, 'package.json'), 'utf8')) as { version: string }
    const built = await buildPack(candidate.name, manifest.version, candidate.dir.startsWith('packages/experimental/'), request.version, request.platforms, request.epoch, request.externals, sources, request.scratch)
    for (const [name, bytes] of built.archives) await writeFile(join(request.out, name), bytes, { flag: 'wx', mode: 0o644 })
    entries.push(built.entry)
  }
  if (entries.length > 0) await writeFile(join(request.out, `delorun-${request.version}.packs.json`), unsignedEnvelopeText(packsDocument(request.version, entries)), { flag: 'wx', mode: 0o644 })
  return entries.length
}
