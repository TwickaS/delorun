/**
 * The recipe's build of upstream's native system addon (`native/system`, the Landlock launcher and the flock Node-API
 * addon) from the exported tree, for each closure platform whose route in `toolchain.json` is `source`. It builds the
 * builder image from the Dockerfile `toolchain.json` names, over the digest-pinned Debian base `images.json` names, with
 * the exact packages `toolchain.json` pins installed from its Debian snapshot; this is the step that uses the network.
 * The image's tag is a digest of those inputs, so a changed pin builds a new image and an existing one is reused. Before
 * compiling, the recipe checks that the image's installed versions are the pinned ones. It then runs upstream's own
 * `native/system/scripts/build.ts` with the pinned Node distribution of the platform, whose headers the addon compiles
 * against, in that image under the platform's OCI architecture (emulated on a host of the other one) with no network, a
 * read-only root, the builder's user (uid 0 on a rootless engine, whose container uid 0 is the caller's uid in the
 * rootless namespace and so owns the mounted source), UTC, the C locale and `SOURCE_DATE_EPOCH`. The binaries land in the platform
 * package's `bin/`, which the closure's deploy then carries, and `prebuilt-pins.json` pins their digests, so a build that
 * differs anywhere stops before archiving (contract C2, rebuild before signing).
 *
 * @module @delorun/release/closure/native-build
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import { x as extractTar } from 'tar'
import { RECIPE_DIR, type Toolchain } from './config.ts'
import { fetchPinned } from './sources.ts'

/** Upstream's native workspace, relative to the repository root. */
export const NATIVE_SOURCE = 'native/system'

/** The OCI platform of each closure platform whose addon the recipe can compile in a Linux container. */
const OCI_PLATFORMS: Readonly<Partial<Record<RuntimePlatform, string>>> = { 'linux-x64': 'linux/amd64', 'linux-arm64': 'linux/arm64' }

/** Where the native workspace and the Node distribution are mounted in the builder container. */
const CONTAINER_SOURCE = '/build/system'
const CONTAINER_NODE = '/opt/node'

/** The image repository of the builder images; the tag names their inputs. */
const IMAGE_REPOSITORY = 'delorun-release-native'

/** The result of one Docker command. */
export interface DockerResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run one Docker command.
 * @param args - the arguments after `docker`.
 * @param inherit - whether the command's output goes to this process's output instead of being captured.
 * @returns the exit status and the captured output.
 */
export type Docker = (args: readonly string[], inherit: boolean) => DockerResult

/** {@link Docker} through the `docker` command on `PATH`. */
export const runDocker: Docker = (args, inherit) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw new Error(`docker did not start: ${result.error.message}`)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * The user and group the builder container runs as: `0:0` on a rootless engine, whose container uid 0 is the caller's
 * uid in the rootless namespace and so owns the mounted source, and the caller's own uid and gid on a rootful one.
 * @param rootless - whether the engine is rootless.
 * @returns the user and group, as `docker run --user` takes them.
 */
export function builderUser(rootless: boolean): string {
  if (rootless) return '0:0'
  return `${String(process.getuid?.())}:${String(process.getgid?.())}`
}

/**
 * Whether the engine is rootless: it lists `name=rootless` among its `SecurityOptions`, the test the supervisor's
 * capability inspection applies.
 * @param docker - the Docker command.
 * @returns true when the engine is rootless.
 * @throws Error when the engine does not answer.
 */
export function engineIsRootless(docker: Docker): boolean {
  const info = docker(['info', '--format', '{{json .SecurityOptions}}'], false)
  if (info.status !== 0) throw new Error(`docker info failed with ${String(info.status)}${info.stderr.trim() === '' ? '' : `: ${info.stderr.trim()}`}`)
  const options = JSON.parse(info.stdout) as readonly string[] | null
  return (options ?? []).some(option => option.includes('name=rootless'))
}

/**
 * Why the recipe cannot build a native addon for some of the requested platforms, or nothing when it can.
 * @param toolchain - the pinned toolchain.
 * @param platforms - the requested closure platforms.
 * @returns one message per platform whose route is `unbuilt`.
 */
export function unbuiltPlatformProblems(toolchain: Toolchain, platforms: readonly RuntimePlatform[]): string[] {
  return platforms.filter(platform => toolchain.native.platforms[platform] === 'unbuilt').map(platform =>
    `${platform}: toolchain.json builds no native system addon for this platform, because the recipe has no pinned toolchain that compiles it; its closure cannot be built from the tagged source`)
}

/**
 * The builder image's tag for one OCI platform: a digest of the Dockerfile, the base, the snapshot, the packages and the
 * platform, so the same inputs reuse one image and any changed input builds another.
 * @param dockerfile - the Dockerfile's bytes.
 * @param base - the base image by digest.
 * @param builder - the pinned builder.
 * @param oci - the OCI platform.
 * @returns `delorun-release-native:<24 hex>`.
 */
export function builderTag(dockerfile: Buffer, base: string, builder: Toolchain['native']['builder'], oci: string): string {
  const hash = createHash('sha256').update(dockerfile).update(`\0${base}\0${builder.snapshot}\0${builder.packages.join(' ')}\0${oci}`).digest('hex')
  return `${IMAGE_REPOSITORY}:${hash.slice(0, 24)}`
}

/**
 * How the installed packages differ from the pinned ones.
 * @param installed - `dpkg-query -W -f '${Package}=${Version}\n'` output for the pinned names.
 * @param pinned - the pinned `name=version` list.
 * @returns one message per package whose installed version differs or that is missing.
 */
export function installedPackageProblems(installed: string, pinned: readonly string[]): string[] {
  const versions = new Map(installed.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.trim()]))
  return pinned.filter(item => versions.get(item.slice(0, item.indexOf('='))) !== item)
    .map(item => `${item} is pinned, but the builder image has ${versions.get(item.slice(0, item.indexOf('='))) ?? 'no such package'}`)
}

function check(result: DockerResult, what: string): DockerResult {
  if (result.status !== 0) throw new Error(`${what} failed with ${String(result.status)}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`)
  return result
}

/** One build of the native addons. */
export interface NativeBuildRequest {
  /** The pinned toolchain. */
  readonly toolchain: Toolchain
  /** `images.json`'s Debian base by digest. */
  readonly base: string
  /** The exported tree's root, whose `native/system` is compiled in place. */
  readonly source: string
  /** The closure platforms to build for; one whose route is `none` is skipped. */
  readonly platforms: readonly RuntimePlatform[]
  /** The download cache of the pinned Node distributions. */
  readonly cache: string
  /** The commit's committer time. */
  readonly epoch: number
  /** The user and group the compiler runs as, so the binaries belong to the builder: {@link builderUser}'s value. */
  readonly user: string
  /** The Docker command; {@link runDocker} by default. */
  readonly docker?: Docker
}

/**
 * Build the builder image for one OCI platform unless an image with its tag exists, then check its packages.
 * @param request - the build.
 * @param oci - the OCI platform.
 * @param docker - the Docker command.
 * @returns the image's tag.
 * @throws Error when the image build fails or its installed packages are not the pinned ones.
 */
async function builderImage(request: NativeBuildRequest, oci: string, docker: Docker): Promise<string> {
  const { builder } = request.toolchain.native
  const dockerfile = join(RECIPE_DIR, builder.dockerfile)
  const tag = builderTag(await readFile(dockerfile), request.base, builder, oci)
  if (docker(['image', 'inspect', '--format', '{{.Id}}', tag], false).status !== 0) {
    console.log(`build-closure: building the native builder image ${tag} for ${oci}`)
    check(docker(['build', '--platform', oci, '--build-arg', `BASE=${request.base}`, '--build-arg', `SNAPSHOT=${builder.snapshot}`,
      '--build-arg', `PACKAGES=${builder.packages.join(' ')}`, '--tag', tag, '--file', dockerfile, dirname(dockerfile)], true), `building the native builder image for ${oci}`)
  }
  const names = builder.packages.map(item => item.slice(0, item.indexOf('=')))
  const installed = check(docker(['run', '--rm', '--network', 'none', '--platform', oci, tag, 'dpkg-query', '-W', '-f', '${Package}=${Version}\\n', ...names], false), `listing the packages of ${tag}`)
  const problems = installedPackageProblems(installed.stdout, builder.packages)
  if (problems.length > 0) throw new Error(`the native builder image ${tag} is not the pinned toolchain:\n${problems.join('\n')}`)
  return tag
}

/**
 * Unpack the executable and headers of a pinned Node distribution into a new directory under the cache.
 * @param toolchain - the pinned toolchain.
 * @param platform - the closure platform.
 * @param cache - the download cache.
 * @returns the new directory, which the caller removes, and the distribution's root in it, with `bin/node` and
 * `include/node/`.
 */
async function nodeForBuild(toolchain: Toolchain, platform: RuntimePlatform, cache: string): Promise<{ readonly directory: string, readonly root: string }> {
  const distribution = toolchain.node.distributions[platform]
  const archive = await fetchPinned(`${toolchain.node.origin}/${distribution.file}`, { algorithm: 'sha256', hex: distribution.sha256 }, cache)
  const top = distribution.file.replace(/\.tar\.gz$/u, '')
  const directory = await mkdtemp(join(cache, '.native-node-'))
  await extractTar({ file: archive, cwd: directory, filter: path => path === `${top}/bin/node` || path.startsWith(`${top}/include/node/`) })
  return { directory, root: join(directory, top) }
}

/**
 * Compile the native system addon of every requested platform whose route is `source` into its package's `bin/`,
 * replacing whatever `bin/` held.
 * @param request - the build.
 * @throws Error when a requested platform is `unbuilt`, a `none` platform has a package, a `source` platform has none,
 * or the image build, the package check or the compile fails.
 */
export async function buildNativeAddons(request: NativeBuildRequest): Promise<void> {
  const docker = request.docker ?? runDocker
  const unbuilt = unbuiltPlatformProblems(request.toolchain, request.platforms)
  if (unbuilt.length > 0) throw new Error(unbuilt.join('\n'))
  const workspace = join(request.source, NATIVE_SOURCE)
  for (const platform of request.platforms) {
    const route = request.toolchain.native.platforms[platform]
    const packageDir = join(workspace, 'packages', platform)
    if (route === 'none') {
      if (existsSync(packageDir)) throw new Error(`${NATIVE_SOURCE}/packages/${platform} exists, but toolchain.json says ${platform} has no native system addon`)
      continue
    }
    const oci = OCI_PLATFORMS[platform]
    if (oci === undefined) throw new Error(`toolchain.json builds the native system addon for ${platform} from source, but the recipe compiles only Linux platforms`)
    if (!existsSync(packageDir)) throw new Error(`toolchain.json builds the native system addon for ${platform}, but ${NATIVE_SOURCE}/packages/${platform} does not exist`)
    const tag = await builderImage(request, oci, docker)
    await rm(join(packageDir, 'bin'), { recursive: true, force: true })
    const node = await nodeForBuild(request.toolchain, platform, request.cache)
    try {
      console.log(`build-closure: compiling ${NATIVE_SOURCE} for ${platform} in ${tag}`)
      check(docker([
        'run', '--rm', '--network', 'none', '--platform', oci, '--read-only', '--tmpfs', '/tmp', '--user', request.user,
        '--env', 'HOME=/tmp', '--env', 'TZ=UTC', '--env', 'LC_ALL=C', '--env', `SOURCE_DATE_EPOCH=${String(request.epoch)}`,
        '--volume', `${node.root}:${CONTAINER_NODE}:ro`, '--volume', `${workspace}:${CONTAINER_SOURCE}`, '--workdir', CONTAINER_SOURCE,
        tag, `${CONTAINER_NODE}/bin/node`, 'scripts/build.ts',
      ], true), `compiling ${NATIVE_SOURCE} for ${platform}`)
    } finally {
      await rm(node.directory, { recursive: true, force: true })
    }
  }
}
