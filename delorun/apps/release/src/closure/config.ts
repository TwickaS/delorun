/**
 * The committed recipe files of the runtime closure build, read and validated before any build step runs:
 * `toolchain.json` (the pinned Node distributions, pnpm, and the builder image and route of upstream's native addon),
 * `prebuilt-pins.json` (the SHA-256 of every native file each closure holds),
 * `closure.json` (the release platforms, the fixed build root and the deployed package) and `rebuild-exceptions.json` (the differences the
 * rebuild comparison accepts, each with its reason). Unknown fields fail the read.
 *
 * @module @delorun/release/closure/config
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { z } from 'zod'

/** The directory that holds the recipe files, `delorun/apps/release`. */
export const RECIPE_DIR = join(import.meta.dirname, '..', '..')

/** The recipe files, relative to {@link RECIPE_DIR}. */
export const RECIPE_FILES = ['toolchain.json', 'prebuilt-pins.json', 'closure.json', 'rebuild-exceptions.json', 'images.json'] as const

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u, 'a lowercase hex SHA-256')
const integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u, 'an npm sha512 integrity string')
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+$/u, 'an exact version')
/** Rejects a path with a `.` or `..` segment, so a rule cannot name a location outside its package. */
const noDotSegment = (path: string): boolean => path.split('/').every(segment => segment !== '.' && segment !== '..')
/**
 * How a closure obtains upstream's native system addon: `source` compiles it in the pinned builder image, `none` is a
 * platform `native/system` publishes no package for, and `unbuilt` is a platform whose package the recipe cannot
 * compile, so the recipe refuses to build that platform's closure.
 */
export const NATIVE_ROUTES = ['source', 'none', 'unbuilt'] as const

const perPlatform = <T extends z.ZodType>(schema: T) => z.strictObject(Object.fromEntries(RUNTIME_PLATFORMS.map(platform => [platform, schema])) as Record<RuntimePlatform, T>)

/** `toolchain.json`. */
export const Toolchain = z.strictObject({
  schema: z.literal('delorun.release-toolchain/1'),
  node: z.strictObject({
    version: exactVersion,
    origin: z.url({ protocol: /^https$/u }),
    distributions: perPlatform(z.strictObject({ file: z.string().regex(/^node-v[\d.]+-[a-z0-9-]+\.(tar\.gz|zip)$/u), sha256 })),
  }),
  pnpm: z.strictObject({ version: exactVersion, tarball: z.url({ protocol: /^https$/u }), integrity }),
  /** Upstream's native system addon under `native/system`, which the recipe compiles in the pinned builder image. */
  native: z.strictObject({
    builder: z.strictObject({
      /** The Dockerfile of the builder image, relative to the recipe directory; its base is `images.json`'s. */
      dockerfile: z.string().regex(/^[A-Za-z0-9._/-]+$/u, 'a path relative to the recipe directory'),
      /** The Debian snapshot (`snapshot.debian.org`) apt installs from, which fixes every package version it can resolve. */
      snapshot: z.string().regex(/^\d{8}T\d{6}Z$/u, 'a snapshot.debian.org timestamp such as 20261104T212339Z'),
      /** The compiler, linker, C library and kernel header packages, each at its exact Debian version. */
      packages: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*=[A-Za-z0-9.+~:-]+$/u, 'a Debian package as name=version')).min(1),
    }),
    platforms: perPlatform(z.enum(NATIVE_ROUTES)),
    compiler: z.string().min(1),
    linker: z.string().min(1),
  }),
  /** The Docker Engine and BuildKit versions that build the S2 and S3 images. */
  images: z.strictObject({ docker: exactVersion, buildkit: z.string().regex(/^v\d+\.\d+\.\d+$/u, 'a BuildKit version such as v0.34.0') }),
})

/** {@link Toolchain}'s parsed value. */
export type Toolchain = z.output<typeof Toolchain>

/** `prebuilt-pins.json`: the SHA-256 of every native file each closure holds, whether compiled by the recipe or prebuilt. */
export const PrebuiltPins = z.strictObject({
  schema: z.literal('delorun.prebuilt-pins/2'),
  files: perPlatform(z.record(z.string(), sha256)),
})

/** {@link PrebuiltPins}' parsed value. */
export type PrebuiltPins = z.output<typeof PrebuiltPins>

/** `closure.json`. */
export const ClosureRecipe = z.strictObject({
  schema: z.literal('delorun.release-closure/1'),
  /**
   * The platforms this release publishes a runtime for, in build order. The build, the rebuild record, the SBOM and
   * signing cover exactly these; a platform whose native addon `toolchain.json` marks `unbuilt` cannot be listed.
   */
  platforms: z.array(z.enum(RUNTIME_PLATFORMS)).min(1).refine(list => new Set(list).size === list.length, 'each platform once'),
  buildRoot: z.string().regex(/^\/[A-Za-z0-9._/-]+$/u, 'an absolute POSIX path'),
  deployRoot: z.string().min(1),
  /** The product name the client artifacts are built with, as `DSH_CLIENT_TITLE`. */
  clientTitle: z.string().min(1).max(64),
  /**
   * Packages that carry other platforms' prebuilds in their main package, with the platform directories to drop from a
   * closure before its native files are checked against the pins; a directory not listed here is never removed. Each
   * `directory` is a relative path with no `.` or `..` segment. Parsing fails on any other value.
   */
  foreignPrebuilds: z.array(z.strictObject({
    package: z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/u, 'an npm package name').refine(noDotSegment, 'no . or .. segment'),
    directory: z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/u, 'a relative path inside the package').refine(noDotSegment, 'no . or .. segment'),
    platforms: z.array(z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/u, 'a platform such as darwin-arm64')).min(1),
  })),
  /** The install anchor upstream's runtime resolution reads, and the Delorun bundles it must declare as dependencies. */
  anchor: z.strictObject({
    package: z.string().min(1),
    bundles: z.array(z.string().regex(/^@delorun\/[a-z0-9-]+$/u, 'a package in the @delorun scope')).min(1),
  }),
})

/** {@link ClosureRecipe}'s parsed value. */
export type ClosureRecipe = z.output<typeof ClosureRecipe>

/** The comparisons a rebuild exception can name; `pe` compares PE files without their Authenticode signature. */
export const EXCEPTION_KINDS = ['pe'] as const

/** `rebuild-exceptions.json`. */
export const RebuildExceptions = z.strictObject({
  schema: z.literal('delorun.rebuild-exceptions/1'),
  exceptions: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    applies: z.enum(EXCEPTION_KINDS),
    reason: z.string().trim().min(20, 'a reason of at least 20 characters'),
  })).refine(list => new Set(list.map(entry => entry.id)).size === list.length, 'exception ids are unique'),
})

/** {@link RebuildExceptions}' parsed value. */
export type RebuildExceptions = z.output<typeof RebuildExceptions>

/**
 * Why the release platforms cannot be built: each listed platform whose native addon the recipe does not build.
 * @param toolchain - the pinned toolchain.
 * @param closure - the closure recipe.
 * @returns one message per such platform; empty when every listed platform can be built.
 */
export function releasePlatformProblems(toolchain: Toolchain, closure: ClosureRecipe): string[] {
  return closure.platforms.filter(platform => toolchain.native.platforms[platform] === 'unbuilt')
    .map(platform => `closure.json lists ${platform} as a release platform, but toolchain.json builds no native system addon for it`)
}

/**
 * Validate one recipe file's text.
 * @param schema - the file's schema.
 * @param text - the file's text.
 * @param where - the file's path or revision, named in errors.
 * @returns the parsed value.
 * @throws Error naming `where` and every problem when the text does not parse or validate.
 */
export function parseRecipeText<T extends z.ZodType>(schema: T, text: string, where: string): z.output<T> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${where}: ${(error as SyntaxError).message}`, { cause: error })
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`${where}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/**
 * Read and validate one recipe file.
 * @param schema - the file's schema.
 * @param path - the file.
 * @returns the parsed value.
 * @throws Error naming the file and every problem when it does not read, parse or validate.
 */
export function readRecipeFile<T extends z.ZodType>(schema: T, path: string): z.output<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${path}: ${(error as NodeJS.ErrnoException).message}`, { cause: error })
  }
  return parseRecipeText(schema, text, path)
}

/** Every recipe file, parsed. */
export interface Recipe {
  readonly toolchain: Toolchain
  readonly pins: PrebuiltPins
  readonly closure: ClosureRecipe
  readonly exceptions: RebuildExceptions
}

/**
 * Read every recipe file from a directory.
 * @param directory - the directory that holds them, {@link RECIPE_DIR} by default.
 * @returns the parsed recipe.
 * @throws Error when any file does not parse or validate, or `closure.json` lists a platform the recipe cannot build.
 */
export function readRecipe(directory: string = RECIPE_DIR): Recipe {
  const recipe = {
    toolchain: readRecipeFile(Toolchain, join(directory, 'toolchain.json')),
    pins: readRecipeFile(PrebuiltPins, join(directory, 'prebuilt-pins.json')),
    closure: readRecipeFile(ClosureRecipe, join(directory, 'closure.json')),
    exceptions: readRecipeFile(RebuildExceptions, join(directory, 'rebuild-exceptions.json')),
  }
  const problems = releasePlatformProblems(recipe.toolchain, recipe.closure)
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return recipe
}
