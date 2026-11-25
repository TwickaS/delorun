/**
 * The published recipe of the runtime closures (contract C2, rebuild before signing). The release workflow and the
 * targets-key holder run the same command from a checkout of the release's commit:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/build-closure.ts --version <version> --out <dir> [--commit <rev>]
 * [--platform <platform>]... [--cache <dir>] [--write-pins] [--artifacts build|existing]
 * [--attestation-key <file> --attestation <file>]`
 *
 * It builds the release platforms `closure.json` lists, or the named ones, and refuses a platform the list does not
 * name before any step runs; the list cannot name a platform whose native addon the recipe does not build. It exports the
 * commit's tree to the fixed build root `closure.json` names, so absolute paths that bundlers embed
 * are the same on every builder, holding the root's lock so a second build on the computer refuses
 * ([build root](./closure/build-root.ts)); installs the locked dependencies and builds the artifacts, with the client title
 * `closure.json` names, and Delorun's packages there under `SOURCE_DATE_EPOCH` (the commit's committer time) and
 * `-ffile-prefix-map=<build root>=.`; compiles upstream's native system addon from `native/system` for each platform
 * whose route is `source`, in the pinned builder image with no network (`closure/native-build.ts`); and for each
 * platform deploys the closure's root package with production
 * dependencies for that platform, transpiles Delorun's packages to JavaScript, stamps the release version into the
 * `delorun` package, has the install anchor declare Delorun's bundles, adds the pinned Node and pnpm, writes
 * `data-formats.json` (contract C3) at the closure's root, checks every native file against `prebuilt-pins.json`, and
 * writes the deterministic archive and its unsigned runtime file list to `--out`; when it built every release platform, it also
 * writes the release's SPDX SBOM derived from the archives. It refuses to run under a Node or pnpm
 * other than `toolchain.json` pins. `--artifacts existing` skips the artifact build and copies the worktree's built
 * artifacts into the exported tree instead, after checking that the worktree
 * is at the commit, that tracked files are clean and that each package's `lib/` exists and is newer than its sources;
 * the native step then replaces any copied native addon binaries, and the closure embeds the worktree's paths, so the
 * build takes a fresh directory beside the fixed root and removes it when it ends, and is for a local release only.
 * When every file is written, a build from source refuses any output file that holds the building user's home
 * directory, user name as a folder or the unique build root, naming each file (`@delorun/release-formats/gate/home-paths`); a build from
 * existing artifacts prints the same findings as warnings. `--write-pins` records the native files found instead of checking them, for a
 * reviewed change of `prebuilt-pins.json`. On the targets-key holder's machine, `--attestation-key` and
 * `--attestation` write an HMAC over the version, commit and every file in `--out`, keyed with the holder's secret,
 * which signing checks; the attestation file lies outside `--out`.
 *
 * @module @delorun/release/build-closure
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from '../../../../scripts/build-exe-for-python-sdk-staging.ts'
import { verifyStagedDependencies } from '../../../../scripts/executable-packaging.ts'
import { semanticVersion } from '@delorun/release-formats/brands'
import { pruneForeignPrebuilds } from './closure/prune.ts'
import { archiveClosure, type ClosureFiles } from './closure/archive-closure.ts'
import { buildReleasePacks } from './closure/packs.ts'
import { DEPLOY_METADATA } from './closure/pack-specifiers.ts'
import { gateBuildOutput } from '@delorun/release-formats/gate/home-paths'
import { artifactDirectories, artifactProblems, isArtifactSource, type ArtifactSource } from './closure/artifacts.ts'
import { claimBuildRoot } from './closure/build-root.ts'
import { writeDataFormats } from './closure/data-formats.ts'
import { RECIPE_DIR, readRecipe, type Recipe } from './closure/config.ts'
import { declareAnchorBundles, stampDelorunVersion, transpileDelorunPackages } from './closure/delorun.ts'
import { builderUser, buildNativeAddons, engineIsRootless, runDocker } from './closure/native-build.ts'
import { stageNode, stagePnpm } from './closure/sources.ts'
import { attestationText, readAttestationKey } from './rebuild/attestation.ts'
import { isWithin, outputRefs } from './rebuild/record.ts'
import { readImagesRecipe } from './images/build.ts'
import { writeReleaseSbom } from './sbom/release-sbom.ts'

/** What the closure keeps of the deployed root package: its dependency manifest, lockfile and dependencies. */
const ROOT_PACKAGE_KEPT = ['package.json', 'pnpm-lock.yaml', 'node_modules']

/** pnpm's `--os`, `--cpu` and `--libc` selection of each platform's optional dependencies; the pack probe uses it too. */
export const TARGETS: Readonly<Record<RuntimePlatform, readonly string[]>> = {
  'linux-x64': ['--os=linux', '--cpu=x64', '--libc=glibc'],
  'linux-arm64': ['--os=linux', '--cpu=arm64', '--libc=glibc'],
  'darwin-x64': ['--os=darwin', '--cpu=x64'],
  'darwin-arm64': ['--os=darwin', '--cpu=arm64'],
  'win32-x64': ['--os=win32', '--cpu=x64'],
}

/**
 * Whether a string names a runtime platform.
 * @param value - the candidate.
 * @returns true for one of contract C2's platforms.
 */
export function isRuntimePlatform(value: string): value is RuntimePlatform {
  return RUNTIME_PLATFORMS.some(platform => platform === value)
}

/** One build's settings. */
export interface BuildRequest {
  readonly version: string
  readonly commit: string
  readonly out: string
  readonly platforms: readonly RuntimePlatform[]
  readonly cache: string
  readonly writePins: boolean
  /** `build` runs the artifact build in the exported tree; `existing` reuses the worktree's built artifacts (a local, non-reproducible build). */
  readonly artifacts?: ArtifactSource
}

/**
 * Why the running toolchain differs from the pinned one, or nothing when it matches.
 * @param recipe - the recipe.
 * @param nodeVersion - `process.version`.
 * @param pnpmVersion - `pnpm --version`'s output, trimmed.
 * @returns one message per mismatch.
 */
export function toolchainProblems(recipe: Recipe, nodeVersion: string, pnpmVersion: string): string[] {
  const problems: string[] = []
  if (nodeVersion !== `v${recipe.toolchain.node.version}`) problems.push(`Node ${nodeVersion} runs the build, but toolchain.json pins v${recipe.toolchain.node.version}`)
  if (pnpmVersion !== recipe.toolchain.pnpm.version) problems.push(`pnpm ${pnpmVersion} runs the build, but toolchain.json pins ${recipe.toolchain.pnpm.version}`)
  return problems
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  console.log(`build-closure: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`)
}

/** The inherited variables the build keeps: what finds the tools, the home and the network proxy. */
const INHERITED = ['PATH', 'HOME', 'USER', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']

/**
 * The environment every build step runs in. Only {@link INHERITED} passes through, so a variable a builder happens to
 * set cannot reach the artifacts; the rest is the recipe's: `SOURCE_DATE_EPOCH`, the prefix map for compiled code,
 * UTC and the C locale, the commit the exported tree has no `.git` to name (`DSH_BUILD_SOURCE_COMMIT` for the build stamp,
 * `DSH_CLIENT_COMMIT_HASH` for the client artifacts), `DSH_BUILD_SOURCE_TREE=clean` because `git archive` exports exactly the
 * commit's tracked files, and the product name the client artifacts present.
 * @param inherited - the builder's environment.
 * @param buildRoot - the fixed build root.
 * @param epoch - the commit's committer time.
 * @param commit - the commit's full id.
 * @param clientTitle - `closure.json`'s `clientTitle`, passed to the client build as `DSH_CLIENT_TITLE`.
 * @returns the build environment.
 */
export function buildEnvironment(inherited: NodeJS.ProcessEnv, buildRoot: string, epoch: number, commit: string, clientTitle: string): NodeJS.ProcessEnv {
  const flags = `-ffile-prefix-map=${buildRoot}=.`
  return {
    ...Object.fromEntries(INHERITED.flatMap(name => (inherited[name] === undefined ? [] : [[name, inherited[name]]]))),
    SOURCE_DATE_EPOCH: String(epoch),
    CFLAGS: flags,
    CXXFLAGS: flags,
    TZ: 'UTC',
    LC_ALL: 'C',
    DSH_BUILD_SOURCE_COMMIT: commit,
    DSH_BUILD_SOURCE_TREE: 'clean',
    DSH_CLIENT_COMMIT_HASH: commit,
    DSH_CLIENT_TITLE: clientTitle,
  }
}

/**
 * Run the recipe.
 * @param repository - the repository whose commit is built.
 * @param recipe - the recipe files.
 * @param request - the release, commit, output and platforms.
 * @returns each platform's release files.
 */
export async function buildClosures(repository: string, recipe: Recipe, request: BuildRequest): Promise<Map<RuntimePlatform, ClosureFiles>> {
  const unlisted = request.platforms.filter(platform => !recipe.closure.platforms.includes(platform))
  if (unlisted.length > 0) throw new Error(`${unlisted.join(', ')} is not in this release; closure.json lists ${recipe.closure.platforms.join(', ')}`)
  const epoch = Number(execFileSync('git', ['log', '-1', '--format=%ct', request.commit], { cwd: repository, encoding: 'utf8' }).trim())
  if (process.env.SOURCE_DATE_EPOCH !== undefined && process.env.SOURCE_DATE_EPOCH !== String(epoch)) {
    throw new Error(`SOURCE_DATE_EPOCH is ${process.env.SOURCE_DATE_EPOCH}, but the commit's committer time is ${String(epoch)}`)
  }
  const existing = request.artifacts === 'existing'
  if (existing) {
    const problems = artifactProblems(repository, request.commit)
    if (problems.length > 0) throw new Error(`the worktree's artifacts cannot be used:\n${problems.join('\n')}`)
  }
  const claimed = await claimBuildRoot(recipe.closure.buildRoot, existing ? 'unique' : 'fixed')
  try {
    return await buildIn(claimed.path, repository, recipe, request, epoch)
  } finally {
    await claimed.release()
  }
}

async function buildIn(buildRoot: string, repository: string, recipe: Recipe, request: BuildRequest, epoch: number): Promise<Map<RuntimePlatform, ClosureFiles>> {
  const existing = request.artifacts === 'existing'
  const source = join(buildRoot, 'source')
  await mkdir(source)
  const archive = spawnSync('git', ['archive', '--format=tar', request.commit], { cwd: repository, maxBuffer: 4 * 1024 ** 3 })
  if (archive.status !== 0) throw new Error(`git archive ${request.commit} failed: ${archive.stderr.toString('utf8')}`)
  const unpack = spawnSync('tar', ['-x', '-f', '-', '-C', source], { input: archive.stdout })
  if (unpack.status !== 0) throw new Error(`unpacking the commit's tree failed: ${unpack.stderr.toString('utf8')}`)
  const env = buildEnvironment(process.env, buildRoot, epoch, request.commit, recipe.closure.clientTitle)
  run('pnpm', ['install', '--frozen-lockfile'], source, env)
  if (existing) {
    for (const directory of artifactDirectories(repository)) await cp(join(repository, directory), join(source, directory), { recursive: true, force: true, verbatimSymlinks: true })
  } else {
    run('pnpm', ['run', 'build:artifacts'], source, env)
  }
  run('pnpm', ['--filter', './delorun/packages/*', 'run', 'build'], source, env)
  await buildNativeAddons({ toolchain: recipe.toolchain, base: readImagesRecipe().base, source, platforms: request.platforms, cache: request.cache, epoch, user: builderUser(engineIsRootless(runDocker)) })
  const results = new Map<RuntimePlatform, ClosureFiles>()
  for (const platform of request.platforms) {
    const stage = join(buildRoot, 'stage', platform)
    const app = join(stage, 'app')
    run('pnpm', [
      '--filter', recipe.closure.deployRoot, 'deploy', '--prod', '--ignore-scripts', ...TARGETS[platform],
      '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.package-import-method=copy',
      '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', app,
    ], source, env)
    await materializeStagedLinks(app)
    await deduplicateStagedWorkspacePackages(app, app)
    await verifyStagedDependencies(app)
    for (const path of DEPLOY_METADATA) await rm(join(app, path), { recursive: true, force: true })
    for (const name of await readdir(app)) {
      if (!ROOT_PACKAGE_KEPT.includes(name)) await rm(join(app, name), { recursive: true, force: true })
    }
    await transpileDelorunPackages(join(app, 'node_modules'))
    await stampDelorunVersion(join(app, 'node_modules'), request.version)
    await declareAnchorBundles(join(app, 'node_modules'), recipe.closure.anchor.package, recipe.closure.anchor.bundles)
    await stageNode(recipe.toolchain, platform, stage, request.cache)
    await stagePnpm(recipe.toolchain, stage, request.cache)
    await writeDataFormats(stage, source)
    await pruneForeignPrebuilds(stage, platform, recipe.closure.foreignPrebuilds, console.log)
    const files = await archiveClosure({ stage, outDir: request.out, version: request.version, platform, epoch, pins: request.writePins ? undefined : recipe.pins.files[platform], requireLaunchFiles: true })
    console.log(`build-closure: ${platform}: ${files.archive.name} (${String(files.entries)} files, ${String(files.archive.length)} bytes, sha256 ${files.archive.sha256})`)
    results.set(platform, files)
  }
  const packCount = await buildReleasePacks({
    source, env, version: request.version, platforms: request.platforms, epoch, externals: recipe.closure.packExternals,
    stage: platform => join(buildRoot, 'stage', platform), targets: TARGETS, out: request.out, scratch: await mkdtemp(join(buildRoot, 'packs-')),
  })
  console.log(`build-closure: built ${String(packCount)} plugin packs`)
  await gateBuildOutput(request.out, existing ? 'existing' : 'build', line => console.warn(`build-closure: warning: ${line}`))
  if (recipe.closure.platforms.every(platform => results.has(platform))) console.log(`build-closure: wrote ${await writeReleaseSbom(request.out, request.version, recipe.closure.platforms, recipe.toolchain, readImagesRecipe().base)}`)
  return results
}

/**
 * Run the recipe after the toolchain check the command line makes, for a caller that is not the command line.
 * @param repository - the repository whose commit is built.
 * @param request - the release, commit, output and platforms.
 * @returns each platform's release files.
 * @throws Error when the running Node or pnpm is not the toolchain `toolchain.json` pins, or the build fails.
 */
export async function buildClosuresChecked(repository: string, request: BuildRequest): Promise<Map<RuntimePlatform, ClosureFiles>> {
  const recipe = readRecipe()
  const problems = toolchainProblems(recipe, process.version, execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim())
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return buildClosures(repository, recipe, request)
}

async function writePins(results: ReadonlyMap<RuntimePlatform, ClosureFiles>): Promise<void> {
  const path = join(RECIPE_DIR, 'prebuilt-pins.json')
  const pins = JSON.parse(await readFile(path, 'utf8')) as { files: Record<string, Record<string, string>> }
  for (const [platform, files] of results) pins.files[platform] = Object.fromEntries([...files.native].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  await writeFile(path, `${JSON.stringify(pins, undefined, 2)}\n`)
  console.log(`build-closure: wrote the native files of ${[...results.keys()].join(', ')} to ${path}; review the change before committing it`)
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      version: { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'string', default: 'HEAD' },
      platform: { type: 'string', multiple: true },
      cache: { type: 'string', default: join(homedir(), '.cache', 'delorun-release') },
      'write-pins': { type: 'boolean', default: false },
      'artifacts': { type: 'string', default: 'build' },
      'attestation-key': { type: 'string' },
      'attestation': { type: 'string' },
    },
  })
  try {
    if (values.version === undefined || values.out === undefined) throw new Error('pass --version <version> and --out <dir>')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('the recipe runs on Linux or macOS')
    const recipe = readRecipe()
    const platforms = (values.platform ?? recipe.closure.platforms).map((platform) => {
      if (!isRuntimePlatform(platform)) throw new Error(`unknown platform ${platform}; use ${RUNTIME_PLATFORMS.join(', ')}`)
      return platform
    })
    if (!isArtifactSource(values.artifacts)) throw new Error(`--artifacts is build or existing, not ${values.artifacts}`)
    const problems = toolchainProblems(recipe, process.version, execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim())
    if (problems.length > 0) throw new Error(problems.join('\n'))
    const repository = repositoryRoot(process.cwd())
    const commit = execFileSync('git', ['rev-parse', '--verify', `${values.commit}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
    const out = resolve(values.out)
    if ((values['attestation-key'] === undefined) !== (values.attestation === undefined)) throw new Error('pass --attestation-key and --attestation together')
    const attestationKey = values['attestation-key'] === undefined ? undefined : readAttestationKey(resolve(values['attestation-key']))
    await mkdir(out, { recursive: true })
    const results = await buildClosures(repository, recipe, { version: semanticVersion(values.version), commit, out, platforms, cache: resolve(values.cache), writePins: values['write-pins'], artifacts: values.artifacts })
    if (values['write-pins']) await writePins(results)
    if (attestationKey !== undefined && values.attestation !== undefined) {
      const path = resolve(values.attestation)
      if (isWithin(path, out)) throw new Error(`write the attestation outside ${out}`)
      await writeFile(path, attestationText(attestationKey, { version: values.version, commit, outputs: await outputRefs(out) }), { mode: 0o644 })
      console.log(`build-closure: attested ${out} in ${path}`)
    }
    return 0
  } catch (error) {
    console.error(`build-closure: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
