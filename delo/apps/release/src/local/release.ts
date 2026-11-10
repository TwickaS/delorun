/**
 * One signed release built on this machine into a directory laid out as a release channel, for a launcher built with
 * that directory's origin as its channel (`delo/apps/npm-launcher`). It composes the release tooling's own steps and
 * adds no cryptography: the runtime closure of `build-closure.ts`, the targets key signing the runtime file list and
 * the manifest as `sign/release.ts` does, the release-log bundle of `log/client.ts`, and the timestamp of
 * `sign/timestamp.ts` signed in the state file the signer keeps.
 *
 * The channel directory holds what GitHub Releases and `releases.delorun.com` hold for a published release:
 *
 * - `timestamp.json` and `root/<n>.root.json`, the metadata host's files;
 * - `releases/download/v<version>/`, the version's release files: the manifest, its log bundle and entry request, and
 *   the Linux x64 runtime archive with its signed file list.
 *
 * A local release is signed over the Linux x64 runtime only. The other files the manifest schema requires (the other
 * platforms' runtimes, the desktop installers, the images, the SBOM, the install scripts, the rebuild record and the
 * advisory report) are zero-length placeholders that nothing in the channel serves, so the manifest says plainly that
 * those files do not exist. It does not replace the signing ceremony of `sign-release.ts`: nothing here is reproduced
 * by a second builder or checked against the advisory feed.
 *
 * @module @delo/release/local/release
 */
import { createHash, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DESKTOP_PLATFORMS,
  RELEASE_REPOSITORY_URL,
  RELEASE_SCHEMAS,
  RUNTIME_PLATFORMS,
  type FileRef,
  type ReleaseManifest,
  type RuntimePlatform,
  type UtcTimestamp,
} from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { semanticVersion, sha256Hex } from '../brands.ts'
import { closureFileNames } from '../closure/tree.ts'
import { logEntryName } from '../log/bundle.ts'
import { logRelease, type LogEndpoints } from '../log/client.ts'
import { entryRequest } from '../log/entry.ts'
import { publicKeyEntry, signEnvelope } from '../sign/envelope.ts'
import { toJsonValue } from '../sign/json.ts'
import { ManifestSchema, readEnvelope } from '../sign/schemas.ts'
import { initialState, nextTimestamp, readTimestampState, stateAfter } from '../sign/timestamp.ts'
import { trustRootChain, verifyTimestamp } from '../sign/verify.ts'

/** The only platform a local release builds. */
export const LOCAL_PLATFORM: RuntimePlatform = 'linux-x64'

/** The name the manifest gives the builder, so a reader sees that no second builder rebuilt this release. */
export const LOCAL_BUILDER = 'local release (no independent rebuild)'

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
  /** The channel directory; a version already in it is refused, and the timestamp is replaced. */
  readonly channel: string
  /** The root files, oldest first: the root the launcher ships, then each later root. */
  readonly roots: readonly Uint8Array[]
  /** The targets private key, which the newest root lists as its one active targets key. */
  readonly targetsKey: KeyObject
  /** The timestamp private key. */
  readonly timestampKey: KeyObject
  /** The signer's state file; created when absent, and replaced after each signing. */
  readonly state: string
  /** The log that the manifest's entry is submitted to. */
  readonly log: LogEndpoints
  /** How many times to ask the log for a witnessed checkpoint that covers the entry. */
  readonly logAttempts: number
  /** Waits between those attempts. */
  readonly logWait: () => Promise<void>
  /**
   * Writes the Linux x64 runtime archive and its unsigned file list, named as `build-closure.ts` names them, into a
   * new directory.
   */
  readonly closures: (directory: string) => Promise<void>
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

/** The manifest of a local release: the built runtime, and placeholders for everything the schema requires beyond it. */
function localManifest(request: LocalReleaseRequest, runtime: { readonly archive: FileRef, readonly files: FileRef }): ReleaseManifest {
  const version = semanticVersion(request.version)
  const placeholderRuntime = Object.fromEntries(RUNTIME_PLATFORMS.map((platform) => {
    if (platform === LOCAL_PLATFORM) return [platform, runtime]
    const names = closureFileNames(request.version, platform)
    return [platform, { archive: absent(names.archive), files: absent(names.files) }]
  }))
  const sha512 = `${'A'.repeat(86)}==`
  const desktop = Object.fromEntries(DESKTOP_PLATFORMS.map(platform => [platform, {
    installer: { ...absent(`Delo-${request.version}-${platform}.installer`), sha512 },
    update: { ...absent(`Delo-${request.version}-${platform}.update`), sha512 },
    blockmap: absent(`Delo-${request.version}-${platform}.blockmap`),
  }]))
  const digest = `sha256:${'0'.repeat(64)}`
  const image = { repository: 'ghcr.io/delo-run/local-release-has-no-image', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
  return ManifestSchema.parse({
    schema: RELEASE_SCHEMAS.manifest,
    version,
    dsh: request.dsh,
    channel: 'stable',
    source: { repository: RELEASE_REPOSITORY_URL, tag: `v${request.version}`, commit: request.commit },
    published: utc(request.now),
    runtime: placeholderRuntime,
    desktop,
    images: { s2: image, s3: image },
    sbom: { ...absent(`delorun-${request.version}.spdx.json`), format: 'SPDX-2.3+json' },
    npm: [],
    install: { sh: absent('install.sh'), ps1: absent('install.ps1') },
    rebuild: { record: absent(`delorun-${request.version}.rebuild.json`), builders: [{ name: LOCAL_BUILDER, ci: false }] },
    advisories: { report: absent(`delorun-${request.version}.advisories.json`), accepted: [] },
  })
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
 * @throws Error when the version is already in the channel, the closure build did not write its files, the targets key
 *   is not the newest root's active targets key, the log gives no witnessed checkpoint, or any signed file fails the
 *   verification the client will run. The channel's timestamp is replaced last, so a failed build leaves the channel
 *   serving the release it served before.
 */
export async function buildLocalRelease(request: LocalReleaseRequest): Promise<LocalRelease> {
  const release = releaseDirectory(request.channel, request.version)
  if (existsSync(release)) throw new Error(`${release} exists; a local release never replaces a version already in the channel`)
  const now = Math.floor(request.now.getTime() / 1000)
  const roots = trustRootChain(request.roots, now)
  const newest = roots.at(-1)!
  const targets = publicKeyEntry(request.targetsKey).keyid
  const active = newest.metadata.roles.targets.keys.filter(key => key.status === 'active')
  if (!active.some(key => key.keyid === targets)) {
    throw new Error(`the targets key ${targets} is not the active targets key of root ${String(newest.metadata.version)}, so no client would accept what it signs`)
  }
  // The work directory is renamed into place, so it lies on the channel's filesystem.
  await mkdir(join(request.channel, 'releases', 'download'), { recursive: true })
  await mkdir(join(request.channel, 'root'), { recursive: true })
  const work = await mkdtemp(join(request.channel, 'releases', 'download', '.building-'))
  try {
    await request.closures(work)
    const names = closureFileNames(request.version, LOCAL_PLATFORM)
    const unsigned = readEnvelope('files', await readFile(join(work, names.files)))
    if (unsigned.signed.version !== request.version || unsigned.signed.platform !== LOCAL_PLATFORM) {
      throw new Error(`${names.files} is the file list of ${unsigned.signed.version} ${unsigned.signed.platform}, not of ${request.version} ${LOCAL_PLATFORM}`)
    }
    const signedList = `${JSON.stringify(signEnvelope({ signed: unsigned.signedJson, signatures: [] }, [request.targetsKey]), undefined, 2)}\n`
    await writeFile(join(work, names.files), signedList)
    const manifest = localManifest(request, { archive: await refOf(work, names.archive), files: await refOf(work, names.files) })
    const manifestName = `delorun-${request.version}.manifest.json`
    const manifestBytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(manifest), signatures: [] }, [request.targetsKey]), undefined, 2)}\n`)
    const entry = entryRequest(manifestBytes, request.targetsKey)
    const bundle = await logRelease(request.log, newest.metadata, manifestName, manifestBytes, request.version, entry, request.logAttempts, request.logWait)
    await writeFile(join(work, manifestName), manifestBytes)
    await writeFile(join(work, logEntryName(request.version)), `${JSON.stringify(entry, undefined, 2)}\n`)
    await writeFile(join(work, `delorun-${request.version}.manifest.log.json`), `${JSON.stringify(bundle, undefined, 2)}\n`)
    const state = existsSync(request.state) ? readTimestampState(await readFile(request.state)) : initialState(roots[0]!)
    const manifestFile = { name: manifestName, bytes: manifestBytes }
    const content = nextTimestamp({ state, roots, first: state.timestamp === null, manifests: { stable: manifestFile, beta: manifestFile }, replaced: [], now })
    const timestamp = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [request.timestampKey]), undefined, 2)}\n`)
    verifyTimestamp(newest, timestamp, now)
    // The release files go in first and the timestamp last, so a client never reads a timestamp whose files are absent.
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
 * Copy a closure build's Linux x64 files, such as `build-closure.ts --platform linux-x64` wrote, into a directory.
 * @param source - the directory holding `delorun-<version>-linux-x64.tar.gz` and its `.files.json`.
 * @param version - the release version the files are named for.
 * @param directory - the directory to copy into.
 * @throws Error when either file is absent.
 */
export async function copyClosureFiles(source: string, version: string, directory: string): Promise<void> {
  const names = closureFileNames(version, LOCAL_PLATFORM)
  for (const name of [names.archive, names.files]) {
    if (!existsSync(join(source, name))) throw new Error(`${join(source, name)} does not exist; build it with build-closure.ts --version ${version} --platform ${LOCAL_PLATFORM}`)
    await copyFile(join(source, name), join(directory, name))
  }
}
