/**
 * The committed recipe files of the runtime closure build, read and validated before any build step runs:
 * `toolchain.json` (the pinned Node distributions, pnpm and the native-addon route), `prebuilt-pins.json` (the
 * prebuilt native packages substituted for workspace builds and the SHA-256 of every native file each closure holds),
 * `closure.json` (the fixed build root and the deployed package) and `rebuild-exceptions.json` (the differences the
 * rebuild comparison accepts, each with its reason). Unknown fields fail the read.
 *
 * @module @delo/release/closure/config
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delo/contract-release-manifest'
import { z } from 'zod'

/** The directory that holds the recipe files, `delo/apps/release`. */
export const RECIPE_DIR = join(import.meta.dirname, '..', '..')

/** The recipe files, relative to {@link RECIPE_DIR}. */
export const RECIPE_FILES = ['toolchain.json', 'prebuilt-pins.json', 'closure.json', 'rebuild-exceptions.json', 'images.json'] as const

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u, 'a lowercase hex SHA-256')
const integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u, 'an npm sha512 integrity string')
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+$/u, 'an exact version')
const perPlatform = <T extends z.ZodType>(schema: T) => z.strictObject(Object.fromEntries(RUNTIME_PLATFORMS.map(platform => [platform, schema])) as Record<RuntimePlatform, T>)

/** `toolchain.json`. */
export const Toolchain = z.strictObject({
  schema: z.literal('delo.release-toolchain/1'),
  node: z.strictObject({
    version: exactVersion,
    origin: z.url({ protocol: /^https$/u }),
    distributions: perPlatform(z.strictObject({ file: z.string().regex(/^node-v[\d.]+-[a-z0-9-]+\.(tar\.gz|zip)$/u), sha256 })),
  }),
  pnpm: z.strictObject({ version: exactVersion, tarball: z.url({ protocol: /^https$/u }), integrity }),
  native: z.strictObject({ route: z.literal('prebuilt'), compiler: z.string().min(1), linker: z.string().min(1) }),
  /** The Docker Engine and BuildKit versions that build the S2 and S3 images. */
  images: z.strictObject({ docker: exactVersion, buildkit: z.string().regex(/^v\d+\.\d+\.\d+$/u, 'a BuildKit version such as v0.34.0') }),
})

/** {@link Toolchain}'s parsed value. */
export type Toolchain = z.output<typeof Toolchain>

/** A prebuilt npm package that replaces the workspace package of the same name in a closure. */
export const PrebuiltPackage = z.strictObject({ name: z.string().min(1), version: exactVersion, integrity })

/** {@link PrebuiltPackage}'s parsed value. */
export type PrebuiltPackage = z.output<typeof PrebuiltPackage>

/** `prebuilt-pins.json`. */
export const PrebuiltPins = z.strictObject({
  schema: z.literal('delo.prebuilt-pins/1'),
  substitutes: perPlatform(z.array(PrebuiltPackage)),
  files: perPlatform(z.record(z.string(), sha256)),
})

/** {@link PrebuiltPins}' parsed value. */
export type PrebuiltPins = z.output<typeof PrebuiltPins>

/** `closure.json`. */
export const ClosureRecipe = z.strictObject({
  schema: z.literal('delo.release-closure/1'),
  buildRoot: z.string().regex(/^\/[A-Za-z0-9._/-]+$/u, 'an absolute POSIX path'),
  deployRoot: z.string().min(1),
})

/** {@link ClosureRecipe}'s parsed value. */
export type ClosureRecipe = z.output<typeof ClosureRecipe>

/** The comparisons a rebuild exception can name; `pe` compares PE files without their Authenticode signature. */
export const EXCEPTION_KINDS = ['pe'] as const

/** `rebuild-exceptions.json`. */
export const RebuildExceptions = z.strictObject({
  schema: z.literal('delo.rebuild-exceptions/1'),
  exceptions: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    applies: z.enum(EXCEPTION_KINDS),
    reason: z.string().trim().min(20, 'a reason of at least 20 characters'),
  })).refine(list => new Set(list.map(entry => entry.id)).size === list.length, 'exception ids are unique'),
})

/** {@link RebuildExceptions}' parsed value. */
export type RebuildExceptions = z.output<typeof RebuildExceptions>

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
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
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
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
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
 * @throws Error when any file does not parse or validate.
 */
export function readRecipe(directory: string = RECIPE_DIR): Recipe {
  return {
    toolchain: readRecipeFile(Toolchain, join(directory, 'toolchain.json')),
    pins: readRecipeFile(PrebuiltPins, join(directory, 'prebuilt-pins.json')),
    closure: readRecipeFile(ClosureRecipe, join(directory, 'closure.json')),
    exceptions: readRecipeFile(RebuildExceptions, join(directory, 'rebuild-exceptions.json')),
  }
}
