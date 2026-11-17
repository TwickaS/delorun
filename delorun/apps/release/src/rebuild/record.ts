/**
 * The rebuild record of contract C2 (`delorun-<version>.rebuild.json`): what the targets-key holder rebuilt, with
 * which recipe and toolchain, the digest of every output file and the comparison with the release workflow's output.
 * Signing requires it; this module holds the facts both the recording and the signing command derive.
 *
 * @module @delorun/release/rebuild/record
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FileRef, RebuildRecord, RuntimePlatform, Sha256Hex } from '@delorun/contract-release-manifest'
import { compareEntryPaths } from '@delorun/release-formats/archive/entry'
import { fileDigest } from '@delorun/release-formats/archive/sink'
import { packsName } from '@delorun/release-formats/log/bundle'
import { sha256Hex } from '@delorun/release-formats/brands'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { ClosureRecipe, parseRecipeText, RebuildExceptions, releasePlatformProblems, Toolchain } from '../closure/config.ts'
import { closureFileNames } from '../closure/tree.ts'
import { ImagesRecipe, imagesName, seccompLicenceName, type ReleaseImages } from '../images/build.ts'
import { sbomName } from '../sbom/release-sbom.ts'

/** The source signing requires, named in every refusal of contract C2's rebuild rule. */
export const REQUIRED_SOURCE = 'a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe'

/** The recipe's directory in the repository. */
export const RECIPE_PATH = 'delorun/apps/release'

/**
 * The environment variables that mark a CI run and are set, by name.
 * @param env - the process environment.
 * @returns `CI` and `GITHUB_ACTIONS` when set to a non-empty value.
 */
export function ciMarkers(env: NodeJS.ProcessEnv): string[] {
  return ['CI', 'GITHUB_ACTIONS'].filter(name => (env[name] ?? '') !== '')
}

/**
 * The SHA-256 that names the recipe at a commit: the hash of one line `<sha256>  <path>` per file under
 * {@link RECIPE_PATH}, in byte-wise path order, as `sha256sum` prints them.
 * @param repository - the repository.
 * @param commit - the commit.
 * @returns the digest.
 */
export function recipeDigest(repository: string, commit: string): Sha256Hex {
  const paths = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', commit, '--', RECIPE_PATH], { cwd: repository, encoding: 'utf8' })
    .split('\0').filter(path => path !== '').sort(compareEntryPaths)
  const lines = paths.map((path) => {
    const blob = execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: repository, maxBuffer: 256 * 1024 * 1024 })
    return `${createHash('sha256').update(blob).digest('hex')}  ${path}\n`
  })
  return sha256Hex(createHash('sha256').update(lines.join('')).digest('hex'))
}

/** The recipe files that signing and recording read at the release's commit. */
export interface CommittedRecipe {
  /** The pinned toolchain. */
  readonly toolchain: Toolchain
  /** The rebuild exceptions. */
  readonly exceptions: RebuildExceptions
  /** The closure recipe, whose `platforms` are the platforms the release publishes. */
  readonly closure: ClosureRecipe
  /** The image recipe, whose base the SBOM names. */
  readonly images: ImagesRecipe
}

/**
 * Read the toolchain, rebuild exceptions, closure recipe and image recipe as committed at a commit, not as the running
 * checkout holds them.
 * @param repository - the repository.
 * @param commit - the commit.
 * @returns the parsed files.
 * @throws Error when a file is missing at the commit or does not validate, or the closure recipe lists a release
 * platform the toolchain cannot build.
 */
export function recipeAt(repository: string, commit: string): CommittedRecipe {
  const read = (file: string): string => execFileSync('git', ['show', `${commit}:${RECIPE_PATH}/${file}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const recipe = {
    toolchain: parseRecipeText(Toolchain, read('toolchain.json'), `${RECIPE_PATH}/toolchain.json at ${commit}`),
    exceptions: parseRecipeText(RebuildExceptions, read('rebuild-exceptions.json'), `${RECIPE_PATH}/rebuild-exceptions.json at ${commit}`),
    closure: parseRecipeText(ClosureRecipe, read('closure.json'), `${RECIPE_PATH}/closure.json at ${commit}`),
    images: parseRecipeText(ImagesRecipe, read('images.json'), `${RECIPE_PATH}/images.json at ${commit}`),
  }
  const problems = releasePlatformProblems(recipe.toolchain, recipe.closure)
  if (problems.length > 0) throw new Error(`the recipe at ${commit}: ${problems.join('; ')}`)
  return recipe
}

/**
 * The toolchain fields of a rebuild record for a pinned toolchain.
 * @param toolchain - the pinned toolchain.
 * @returns the Node.js and pnpm versions and the native compiler and linker.
 */
export function recordToolchain(toolchain: Toolchain): RebuildRecord['toolchain'] {
  return { node: toolchain.node.version, pnpm: toolchain.pnpm.version, compiler: toolchain.native.compiler, linker: toolchain.native.linker }
}

/**
 * The files every rebuild and every comparison must cover: each release platform's runtime archive and file list, the
 * release SBOM, the images file, and each seccomp profile the images list with the licence published beside it.
 * @param version - the release.
 * @param platforms - the release platforms, `closure.json`'s `platforms` at the release's commit.
 * @param images - the image references, when known; their seccomp profiles and licences are required then.
 * @returns their names.
 */
export function requiredOutputs(version: string, platforms: readonly RuntimePlatform[], images?: ReleaseImages): string[] {
  const profiles = images === undefined ? [] : (['s2', 's3'] as const).flatMap(image => {
    const profile = images[image].seccomp
    return profile === undefined ? [] : [profile.name, seccompLicenceName(version, image)]
  })
  return [...platforms.flatMap(platform => Object.values(closureFileNames(version, platform))), sbomName(version), imagesName(version), ...new Set(profiles)]
}

/**
 * The files of a directory's packs file: the file and every archive it names, which the rebuild must reproduce byte
 * for byte exactly as it does the runtime archives.
 * @param directory - a release or rebuild output directory.
 * @param version - the release.
 * @returns their names; none when the directory holds no packs file.
 * @throws Error when the packs file does not read.
 */
export async function packOutputs(directory: string, version: string): Promise<string[]> {
  let bytes: Buffer
  try {
    bytes = await readFile(join(directory, packsName(version)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const archives = readEnvelope('packs', bytes).signed.packs.flatMap(pack => Object.values(pack.variants).map(variant => variant.archive.name))
  return [packsName(version), ...new Set(archives)]
}

/**
 * Whether one path is another or lies inside it, for real paths.
 * @param path - the path to test.
 * @param directory - the directory.
 * @returns true when `path` is `directory` or inside it.
 */
export function isWithin(path: string, directory: string): boolean {
  const relation = relative(directory, path)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

/**
 * The file references of every regular file in a build output directory, in byte-wise name order.
 * @param directory - the output directory.
 * @returns one reference per file.
 * @throws Error when the directory holds anything but regular files.
 */
export async function outputRefs(directory: string): Promise<FileRef[]> {
  const refs: FileRef[] = []
  for (const name of (await readdir(directory)).sort(compareEntryPaths)) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error(`${join(directory, name)} is not a regular file`)
    const { length, sha256 } = await fileDigest(join(directory, name))
    refs.push({ name, length, sha256: sha256Hex(sha256) })
  }
  return refs
}

/**
 * The commit a revision names.
 * @param repository - the repository.
 * @param revision - a tag, branch or commit.
 * @returns the 40-hex commit id.
 * @throws Error when the revision names no commit.
 */
export function commitOf(repository: string, revision: string): string {
  return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
}

/**
 * The name of a release's rebuild record.
 * @param version - the release.
 * @returns `delorun-<version>.rebuild.json`.
 */
export function rebuildRecordName(version: string): string {
  return `delorun-${version}.rebuild.json`
}
