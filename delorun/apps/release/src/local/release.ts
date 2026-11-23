/**
 * One signed release built on this machine into a directory laid out as a release channel, for a launcher built with
 * that directory's origin as its channel (`delorun/apps/npm-launcher`). It composes the release tooling's own steps and
 * adds no cryptography: the runtime closure of `build-closure.ts`, the targets key signing the runtime file list and
 * the manifest as `sign/release.ts` does, the release-log bundle of `log/client.ts`, and the timestamp of
 * `sign/timestamp.ts` signed in the state file the signer keeps.
 *
 * The channel directory holds what GitHub Releases and `releases.delorun.com` hold for a published release:
 *
 * - `timestamp.json` and `root/<n>.root.json`, the metadata host's files;
 * - `releases/download/v<version>/`, the version's release files: the manifest, its log bundle and entry request, and
 *   each runtime archive with its signed file list.
 *
 * A local release is signed over the runtimes of the platforms it is given, which its manifest lists, and no other. The other files the
 * manifest schema requires (the desktop installers, the images, the SBOM, the install scripts, the rebuild record and the
 * advisory report) are zero-length placeholders that nothing in the channel serves, so the manifest says plainly that
 * those files do not exist. It does not replace the signing ceremony of `sign-release.ts`: nothing here is reproduced
 * by a second builder or checked against the advisory feed. So that a release built this way never carries production
 * trust, it refuses, before it writes anything, a root file, a root key, a targets key or a timestamp key that the
 * production-keys registry of `local/production-keys.ts` lists.
 *
 * @module @delorun/release/local/release
 */
import { createHash, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DESKTOP_PLATFORMS,
  RELEASE_REPOSITORY_URL,
  RELEASE_SCHEMAS,
  RELEASE_SUMMARY_MAX_LENGTH,
  type FileRef,
  type ReleaseManifest,
  type RootMetadata,
  type RuntimePlatform,
  type UtcTimestamp,
  RELEASE_FILE_SIZE_LIMITS,
  isValidNotes,
} from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { semanticVersion, sha256Hex } from '@delorun/release-formats/brands'
import { closureFileNames } from '../closure/tree.ts'
import { homePathProblems, refuseHomePaths, type BuilderIdentity } from '@delorun/release-formats/gate/home-paths'
import { logEntryName, packsEntryName, packsLogName, packsName } from '@delorun/release-formats/log/bundle'
import { logWithFallback, type LogEndpoints } from '../log/client.ts'
import { entrySigners, type LogEntrySigner } from '@delorun/release-formats/log/entry-keys'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { LOCAL_RELEASE_BUILDER, ManifestSchema, readEnvelope, ReleaseSummarySchema } from '@delorun/release-formats/sign/schemas'
import { signPacks } from '../sign/packs.ts'
import { initialState, nextTimestamp, readTimestampState, stateAfter } from '../sign/timestamp.ts'
import { rootKeyIds, type ProductionKeys } from './production-keys.ts'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'

/** The platform a local release builds when the command names none. */
export const LOCAL_PLATFORM: RuntimePlatform = 'linux-x64'

/** The name the manifest gives the builder, so a reader sees that no second builder rebuilt this release. */
export const LOCAL_BUILDER = LOCAL_RELEASE_BUILDER

/**
 * Where a version's release files sit below the channel directory, as GitHub Releases serves them.
 * @param channel - the channel directory.
 * @param version - the release version.
 * @returns the directory `releases/download/v<version>` below the channel.
 */
export function releaseDirectory(channel: string, version: string): string {
  return join(channel, 'releases', 'download', `v${version}`)
}

/** What building a local release needs. */
export interface LocalReleaseRequest {
  /** The git commit the release is built from; recorded in the manifest as its source. */
  readonly commit: string
  /** The release version. The same commit may be built under two versions. */
  readonly version: string
  /** The upstream release the commit is based on, such as `0.2.2-rc.1`. */
  readonly dsh: string
  /** Whether the release is marked as a security fix; the manifest's `security`. */
  readonly security: boolean
  /** The release's one-line summary, the manifest's `summary`; it must match `RELEASE_SUMMARY_PATTERN`. */
  readonly summary: string
  /**
   * The release notes' bytes, written to the release directory as `delorun-<version>.notes.txt` and named by the
   * manifest's `notes`; they must satisfy `isValidNotes`. Absent: the manifest carries no `notes`, which readers
   * that predate the field require.
   */
  readonly notes?: Uint8Array
  /** The channel directory; a version already in it is refused, and the timestamp is replaced. */
  readonly channel: string
  /** The root files, oldest first: the root the launcher ships, then each later root. */
  readonly roots: readonly Uint8Array[]
  /** The targets private key, which the newest root lists as its one active targets key. */
  readonly targetsKey: KeyObject
  /** The timestamp private key. */
  readonly timestampKey: KeyObject
  /**
   * Log-entry private keys besides the targets key, each with its entry key type, such as an ECDSA P-256 key the newest
   * root lists in `logEntryKeys`. The entry is signed with the root's listed `active` keys in the root's order, each that
   * the targets key or one of these belongs to, moving to the next only when the log refuses the entry's key type.
   */
  readonly logEntryKeys?: readonly LogEntrySigner[]
  /** The production trust material, which none of {@link roots}, {@link targetsKey} and {@link timestampKey} may be. */
  readonly productionKeys: ProductionKeys
  /** The runtime platforms the release carries and its manifest lists, at least one, each once. */
  readonly platforms: readonly RuntimePlatform[]
  /** The signer's state file; created when absent, and replaced after each signing. */
  readonly state: string
  /** The log that the manifest's entry is submitted to. */
  readonly log: LogEndpoints
  /** How many times to ask the log for a witnessed checkpoint that covers the entry. */
  readonly logAttempts: number
  /** Waits between those attempts. */
  readonly logWait: () => Promise<void>
  /**
   * Writes each platform's runtime archive and unsigned file list, named as `build-closure.ts` names them, into a new
   * directory.
   */
  readonly closures: (directory: string) => Promise<void>
  /**
   * Sign closure files that name the building user's own paths, warning for each file instead of refusing. A release
   * built from existing artifacts embeds the worktree's paths, so only a local candidate sets this; absent or false, the
   * signing is refused before anything is signed (`@delorun/release-formats/gate/home-paths`).
   */
  readonly allowBuilderPaths?: boolean
  /** Receives each warning of an allowed build and each log-entry key type the log refused; `console.warn` by default. */
  readonly warn?: (line: string) => void
  /** The user the scan looks for in the closure files; this computer's user by default. */
  readonly builder?: BuilderIdentity
  /** The signing time. */
  readonly now: Date
}

/** What a local release wrote. */
export interface LocalRelease {
  /** The signed manifest. */
  readonly manifest: ReleaseManifest
  /** The manifest file's name. */
  readonly manifestName: string
  /** The timestamp's version. */
  readonly timestampVersion: number
}

const EMPTY_SHA256 = sha256Hex(createHash('sha256').update('').digest('hex'))

/** A zero-length reference to a file this local release does not build. */
function absent(name: string): FileRef {
  return { name, length: 0, sha256: EMPTY_SHA256 }
}

function utc(date: Date): UtcTimestamp {
  return brandString<UtcTimestamp>(`${date.toISOString().slice(0, 19)}Z`)
}

async function refOf(directory: string, name: string): Promise<FileRef> {
  const bytes = await readFile(join(directory, name))
  return { name, length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }
}

/** The manifest of a local release: the built runtimes, and placeholders for everything the schema requires beyond them. */
function localManifest(request: LocalReleaseRequest, runtime: ReadonlyMap<RuntimePlatform, { readonly archive: FileRef, readonly files: FileRef }>, notes: FileRef | undefined): ReleaseManifest {
  const version = semanticVersion(request.version)
  const sha512 = `${'A'.repeat(86)}==`
  const desktop = Object.fromEntries(DESKTOP_PLATFORMS.map(platform => [platform, {
    installer: { ...absent(`Delorun-${request.version}-${platform}.installer`), sha512 },
    update: { ...absent(`Delorun-${request.version}-${platform}.update`), sha512 },
    blockmap: absent(`Delorun-${request.version}-${platform}.blockmap`),
  }]))
  const digest = `sha256:${'0'.repeat(64)}`
  const image = { repository: 'ghcr.io/twickas/local-release-has-no-image', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
  return ManifestSchema.parse({
    schema: RELEASE_SCHEMAS.manifest,
    version,
    dsh: request.dsh,
    channel: 'stable',
    source: { repository: RELEASE_REPOSITORY_URL, tag: `v${request.version}`, commit: request.commit },
    published: utc(request.now),
    runtime: Object.fromEntries(runtime),
    desktop,
    images: { s2: image, s3: image },
    sbom: { ...absent(`delorun-${request.version}.spdx.json`), format: 'SPDX-2.3+json' },
    npm: [],
    install: { sh: absent('install.sh'), ps1: absent('install.ps1') },
    rebuild: { record: absent(`delorun-${request.version}.rebuild.json`), builders: [{ name: LOCAL_BUILDER, ci: false }] },
    advisories: { report: absent(`delorun-${request.version}.advisories.json`), accepted: [] },
    security: request.security,
    summary: request.summary,
    ...notes === undefined ? {} : { notes },
  })
}

/** The message stem of every refusal of production trust material. */
export const PRODUCTION_REFUSAL = 'a local release refuses production trust material'

/**
 * Refuse a root file that the production-keys registry lists by its SHA-256.
 * @param request - the roots and the registry.
 * @throws Error naming the first listed root file by its position.
 */
function refuseProductionRoots(request: LocalReleaseRequest): void {
  for (const [position, bytes] of request.roots.entries()) {
    const digest = sha256Hex(createHash('sha256').update(bytes).digest('hex'))
    if (request.productionKeys.rootDigests.has(digest)) throw new Error(`${PRODUCTION_REFUSAL}: root file ${String(position + 1)} is a production root (SHA-256 ${digest})`)
  }
}

/**
 * Refuse a root that lists a production key, and a targets or timestamp key that is one.
 * @param request - the keys and the registry.
 * @param roots - the request's roots, read.
 * @throws Error naming the first production key found and where.
 */
function refuseProductionKeys(request: LocalReleaseRequest, roots: readonly RootMetadata[]): void {
  for (const [role, key] of [['targets', request.targetsKey], ['timestamp', request.timestampKey]] as const) {
    const keyid = publicKeyEntry(key).keyid
    if (request.productionKeys.keyids.has(keyid)) throw new Error(`${PRODUCTION_REFUSAL}: the ${role} key ${keyid} is a production key`)
  }
  for (const root of roots) {
    for (const { keyid, where } of rootKeyIds(root)) {
      if (request.productionKeys.keyids.has(keyid)) throw new Error(`${PRODUCTION_REFUSAL}: root ${String(root.version)} lists the production key ${keyid} in ${where}`)
    }
  }
}

/**
 * Write a file through a temporary name, so a reader never sees half of it.
 * @param path - the file.
 * @param bytes - its content.
 */
async function replaceFile(path: string, bytes: Uint8Array | string): Promise<void> {
  await writeFile(`${path}.signing`, bytes, { mode: 0o644 })
  await rename(`${path}.signing`, path)
}

/**
 * Build, sign and log one release into a channel directory.
 * @param request - the commit, version, channel, keys, log and closure build.
 * @returns the signed manifest and the timestamp's version.
 * @throws Error when the summary is not a valid release summary, the platform list is empty or repeats a platform, a
 *   root file, a key a root lists, the targets key or the timestamp key is production trust material, the version is
 *   already in the channel, the closure build did not write its files, the targets key is not the newest root's
 *   active targets key, the log gives no
 *   witnessed checkpoint, the closure files name the building user's paths without `allowBuilderPaths`, or any signed file fails the verification the client will run. The channel's timestamp is replaced last, so a failed build leaves the channel
 *   serving the release it served before.
 */
export async function buildLocalRelease(request: LocalReleaseRequest): Promise<LocalRelease> {
  if (!ReleaseSummarySchema.safeParse(request.summary).success) {
    throw new Error(`the summary ${JSON.stringify(request.summary)} is not a release summary: 1 to ${String(RELEASE_SUMMARY_MAX_LENGTH)} characters on one line, with no control or format character and no whitespace at either end`)
  }
  if (request.notes !== undefined && !isValidNotes(request.notes)) {
    throw new Error(`the release notes are not valid: well-formed UTF-8 of 1 to ${String(RELEASE_FILE_SIZE_LIMITS.notes)} bytes with no control (except line feed and tab), format, line-separator or lone-surrogate character`)
  }
  refuseProductionRoots(request)
  if (request.platforms.length === 0 || new Set(request.platforms).size !== request.platforms.length) {
    throw new Error(`a local release names each of its platforms once, not ${JSON.stringify(request.platforms)}`)
  }
  const release = releaseDirectory(request.channel, request.version)
  if (existsSync(release)) throw new Error(`${release} exists; a local release never replaces a version already in the channel`)
  const now = Math.floor(request.now.getTime() / 1000)
  const roots = trustRootChain(request.roots, now)
  refuseProductionKeys(request, roots.map(root => root.metadata))
  const newest = roots.at(-1)!
  const targets = publicKeyEntry(request.targetsKey).keyid
  const active = newest.metadata.roles.targets.keys.filter(key => key.status === 'active')
  if (!active.some(key => key.keyid === targets)) {
    throw new Error(`the targets key ${targets} is not the active targets key of root ${String(newest.metadata.version)}, so no client would accept what it signs`)
  }
  const signers = entrySigners(newest.metadata, [...request.logEntryKeys ?? [], { keyDetails: 'PKIX_ED25519_PH', key: request.targetsKey }])
  if (signers.length === 0) {
    const what = newest.metadata.logEntryKeys === undefined ? 'lists no logEntryKeys' : 'lists neither a --log-entry-key nor the targets key as an active log-entry key'
    throw new Error(`root ${String(newest.metadata.version)} ${what}, so no log entry of this release could verify`)
  }
  // The work directory is renamed into place, so it lies on the channel's filesystem.
  await mkdir(join(request.channel, 'releases', 'download'), { recursive: true })
  await mkdir(join(request.channel, 'root'), { recursive: true })
  const work = await mkdtemp(join(request.channel, 'releases', 'download', '.building-'))
  try {
    await request.closures(work)
    // Every shipped closure and pack file is final here and nothing is signed yet.
    if (request.allowBuilderPaths === true) {
      for (const problem of await homePathProblems(work, request.builder)) (request.warn ?? console.warn)(`warning: the closure files name the building user's paths, which a public release never does: ${problem.file}: ${problem.found}`)
    } else {
      await refuseHomePaths(work, request.builder)
    }
    const runtime = new Map<RuntimePlatform, { readonly archive: FileRef, readonly files: FileRef }>()
    for (const platform of request.platforms) {
      const names = closureFileNames(request.version, platform)
      const unsigned = readEnvelope('files', await readFile(join(work, names.files)))
      if (unsigned.signed.version !== request.version || unsigned.signed.platform !== platform) {
        throw new Error(`${names.files} is the file list of ${unsigned.signed.version} ${unsigned.signed.platform}, not of ${request.version} ${platform}`)
      }
      const signedList = `${JSON.stringify(signEnvelope({ signed: unsigned.signedJson, signatures: [] }, [request.targetsKey]), undefined, 2)}\n`
      await writeFile(join(work, names.files), signedList)
      runtime.set(platform, { archive: await refOf(work, names.archive), files: await refOf(work, names.files) })
    }
    const notesName = `delorun-${request.version}.notes.txt`
    if (request.notes !== undefined) await writeFile(join(work, notesName), request.notes)
    const manifest = localManifest(request, runtime, request.notes === undefined ? undefined : await refOf(work, notesName))
    const manifestName = `delorun-${request.version}.manifest.json`
    const manifestBytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(manifest), signatures: [] }, [request.targetsKey]), undefined, 2)}\n`)
    const warn = request.warn ?? console.warn
    const logged = await logWithFallback(request.log, newest.metadata, manifestName, manifestBytes, request.version, signers, request.logAttempts, request.logWait, 'manifest', warn)
    await writeFile(join(work, manifestName), manifestBytes)
    await writeFile(join(work, logEntryName(request.version)), `${JSON.stringify(logged.entry, undefined, 2)}\n`)
    await writeFile(join(work, `delorun-${request.version}.manifest.log.json`), `${JSON.stringify(logged.bundle, undefined, 2)}\n`)
    // The packs file, when the closure build wrote one, is signed against this manifest and logged as a second record, as sign/release.ts and log-release.ts do for a published release.
    // Its entry starts from the signer the log accepted for the manifest; the entry file holds the request the log accepted.
    const packOutputs = await signPacks(work, request.version, manifestBytes, request.targetsKey)
    if (packOutputs.length > 0) {
      const packs = packOutputs.find(([name]) => name === packsName(request.version))![1]
      const packsLogged = await logWithFallback(request.log, newest.metadata, packsName(request.version), Buffer.from(packs), request.version, signers.slice(logged.signer), request.logAttempts, request.logWait, 'packs', warn)
      await writeFile(join(work, packsName(request.version)), packs)
      await writeFile(join(work, packsEntryName(request.version)), `${JSON.stringify(packsLogged.entry, undefined, 2)}\n`)
      await writeFile(join(work, packsLogName(request.version)), `${JSON.stringify(packsLogged.bundle, undefined, 2)}\n`)
    }
    const state = existsSync(request.state) ? readTimestampState(await readFile(request.state)) : initialState(roots[0]!)
    const manifestFile = { name: manifestName, bytes: manifestBytes }
    const content = nextTimestamp({ state, roots, first: state.timestamp === null, manifests: { stable: manifestFile, beta: manifestFile }, replaced: [], now })
    const timestamp = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [request.timestampKey]), undefined, 2)}\n`)
    verifyTimestamp(newest, timestamp, now)
    // The release files go in first and the timestamp last, so a client never reads a timestamp whose files are absent.
    // mkdtemp made the work directory 0700; a channel is served, so its version directory is readable like its files.
    await chmod(work, 0o755)
    await rename(work, release)
    for (const [position, root] of roots.entries()) await writeFile(join(request.channel, 'root', `${String(root.metadata.version)}.root.json`), request.roots[position]!)
    await replaceFile(request.state, `${JSON.stringify(stateAfter(newest, timestamp, content.version), undefined, 2)}\n`)
    await replaceFile(join(request.channel, 'timestamp.json'), timestamp)
    return { manifest, manifestName, timestampVersion: content.version }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Copy a closure build's files of the given platforms, such as `build-closure.ts --platform <platform>` wrote, into a
 * directory. When the build wrote the release's packs file `delorun-<version>.packs.json`, it is copied with every pack
 * archive it names, whatever the platform of each, so a release that publishes packs has all of them.
 * @param source - the directory holding each platform's `delorun-<version>-<platform>` archive and its `.files.json`, and the packs file and archives.
 * @param version - the release version the files are named for.
 * @param platforms - the platforms to copy.
 * @param directory - the directory to copy into.
 * @throws Error when any file, or a pack archive the packs file names, is absent.
 */
export async function copyClosureFiles(source: string, version: string, platforms: readonly RuntimePlatform[], directory: string): Promise<void> {
  for (const platform of platforms) {
    const names = closureFileNames(version, platform)
    for (const name of [names.archive, names.files]) {
      if (!existsSync(join(source, name))) throw new Error(`${join(source, name)} does not exist; build it with build-closure.ts --version ${version} --platform ${platform}`)
      await copyFile(join(source, name), join(directory, name))
    }
  }
  const packs = join(source, packsName(version))
  if (!existsSync(packs)) return
  const named = readEnvelope('packs', await readFile(packs)).signed.packs.flatMap(pack => Object.values(pack.variants).map(variant => variant.archive.name))
  for (const name of new Set(named)) {
    if (!existsSync(join(source, name))) throw new Error(`${packs} names ${join(source, name)}, which does not exist; build it with build-closure.ts --version ${version}`)
    await copyFile(join(source, name), join(directory, name))
  }
  await copyFile(packs, join(directory, packsName(version)))
}
